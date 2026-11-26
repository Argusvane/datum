"""The address limit: one count per client address, before the body is read, beside the per-form throttle.

`datum.web.throttle.address_limit` (default 600, `None` or the word `off` turns it off) counts every request a throttled
route takes under the counted address alone (an IPv6 client by its /64), in the throttle's window, storage, salt and
key cap, under its own key word (`address`) so it never shares a window with a per-form key. A request with no client
address is not counted; the whole throttle switched off switches it off too.
"""

import asyncio
import re
import threading
from typing import Any

import pytest
import time_machine
from limits.aio.storage import MemoryStorage as AsyncMemoryStorage
from pydantic import ValidationError
from submissions_support import started
from test_throttle_storage_failure import FailingStorage
from throttle_support import START, SpyStorage, key, settings

from datum_core import DatumConfig
from datum_core.aio import AsyncRunner, count_address
from datum_core.aio._services import AsyncSubmissionService
from datum_core.config.models import ThrottleBy, ThrottleKind
from datum_core.config.schema import settings_schema
from datum_core.submissions import SubmissionThrottledEvent, Throttled
from datum_core.throttle import (
    ADDRESS_KEY_SPACE,
    Allow,
    AsyncLimitsThrottle,
    Deny,
    LimitsThrottle,
    ThrottleKey,
    address_storage_key,
    storage_key,
)
from datum_core.throttle.storage import caller_of
from datum_sandbox.wasi import EngineBusyError

ADDRESS = "203.0.113.7"


def address_keys(storage: SpyStorage) -> list[str]:
    return [seen for seen in storage.seen if f"datum:throttle:{ADDRESS_KEY_SPACE}:" in seen]


# -- the setting -----------------------------------------------------------------------------------------------------
def test_the_default_is_600_ten_times_the_default_per_form_limit() -> None:
    throttle = DatumConfig().web.throttle
    assert throttle.address_limit == 600
    assert throttle.address_limit == 10 * throttle.limit


@pytest.mark.parametrize("off", [None, "off", "OFF", " off "])
def test_none_or_the_word_off_turns_it_off(off: Any) -> None:
    assert settings(address_limit=off).address_limit is None


@pytest.mark.parametrize("given", [0, -1, True, "many", 1.5])
def test_a_limit_below_one_a_bool_or_a_word_other_than_off_is_refused(given: Any) -> None:
    with pytest.raises(ValidationError, match="address_limit"):
        settings(address_limit=given)


def test_a_whole_number_from_the_environment_is_read_as_one() -> None:
    assert settings(address_limit="200").address_limit == 200


def test_the_schema_offers_a_whole_number_of_at_least_one_null_and_off_with_a_description() -> None:
    field = settings_schema()["$defs"]["Throttle"]["properties"]["address_limit"]
    assert field["default"] == 600
    assert "description" in field
    assert {"type": "integer", "minimum": 1} in field["anyOf"]
    assert {"type": "null"} in field["anyOf"]
    assert {"const": "off"} in field["anyOf"]


# -- counting ----------------------------------------------------------------------------------------------------------
def test_an_address_within_the_limit_is_allowed_and_the_next_request_is_denied_with_whole_seconds() -> None:
    throttle = LimitsThrottle(settings(address_limit=3, window=60))
    with time_machine.travel(START, tick=False) as clock:
        answers = [throttle.check_address(ADDRESS) for _ in range(3)]
        clock.shift(10.3)
        denied = throttle.check_address(ADDRESS)
    assert answers == [Allow()] * 3
    assert isinstance(denied, Deny)
    assert type(denied.retry_after) is int
    assert denied.retry_after == 50


def test_the_window_resets_the_address_count() -> None:
    throttle = LimitsThrottle(settings(address_limit=1, window=60))
    with time_machine.travel(START, tick=False) as clock:
        assert throttle.check_address(ADDRESS) == Allow()
        assert isinstance(throttle.check_address(ADDRESS), Deny)
        clock.shift(61)
        assert throttle.check_address(ADDRESS) == Allow()


def test_the_limit_switched_off_counts_nothing() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(address_limit=None), storage=storage)
    assert [throttle.check_address(ADDRESS) for _ in range(700)] == [Allow()] * 700
    assert storage.seen == []


def test_the_whole_throttle_switched_off_switches_the_address_limit_off() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(enabled=False, address_limit=1), storage=storage)
    assert [throttle.check_address(ADDRESS) for _ in range(5)] == [Allow()] * 5
    assert storage.seen == []


@pytest.mark.parametrize("missing", [None, ""])
def test_a_request_with_no_client_address_is_not_counted(missing: str | None) -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(address_limit=1), storage=storage)
    assert [throttle.check_address(missing) for _ in range(5)] == [Allow()] * 5
    assert storage.seen == []


def test_an_ipv6_client_is_counted_by_its_64_and_another_64_counts_apart() -> None:
    throttle = LimitsThrottle(settings(address_limit=2))
    with time_machine.travel(START, tick=False):
        assert throttle.check_address("2001:db8:1:2::1") == Allow()
        assert throttle.check_address("2001:db8:1:2:ffff::9") == Allow()
        assert isinstance(throttle.check_address("[2001:db8:1:2::77]:443"), Deny)
        assert throttle.check_address("2001:db8:1:3::1") == Allow()


def test_a_mapped_ipv4_address_is_counted_as_the_ipv4_address() -> None:
    throttle = LimitsThrottle(settings(address_limit=1))
    with time_machine.travel(START, tick=False):
        assert throttle.check_address(ADDRESS) == Allow()
        assert isinstance(throttle.check_address(f"::ffff:{ADDRESS}"), Deny)


# -- the key space -----------------------------------------------------------------------------------------------------
def test_the_address_key_names_its_own_word_and_no_raw_address() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(address_limit=5, key_salt="s" * 32), storage=storage)
    throttle.check_address(ADDRESS)
    (seen,) = storage.seen
    assert re.search(r"datum:throttle:address:[0-9a-f]{64}:[0-9a-f]{64}", seen)
    assert ADDRESS not in seen
    assert address_storage_key(ADDRESS, b"s" * 32) in seen


def test_the_address_word_is_no_kind_a_limits_table_can_name() -> None:
    assert ADDRESS_KEY_SPACE not in {kind.value for kind in ThrottleKind}
    with pytest.raises(ValidationError):
        settings(limits={ADDRESS_KEY_SPACE: 5})


@pytest.mark.parametrize("by", [(ThrottleBy.IP,), (ThrottleBy.IP, ThrottleBy.FORM)])
def test_the_address_window_and_a_per_form_window_never_share_a_key(by: tuple[ThrottleBy, ...]) -> None:
    salt = b"s" * 32
    address = address_storage_key(ADDRESS, salt)
    for kind in ThrottleKind:
        per_form = storage_key(by, ThrottleKey(ip=ADDRESS, form_key="contact", kind=kind), salt)
        assert per_form != address
        assert not per_form.startswith(f"datum:throttle:{ADDRESS_KEY_SPACE}:")


def test_spending_the_per_form_window_leaves_the_address_window_alone_and_the_reverse() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(limit=1, address_limit=2, by=["ip"]), storage=storage)
    with time_machine.travel(START, tick=False):
        assert throttle.check(key(ip=ADDRESS)) == Allow()
        assert isinstance(throttle.check(key(ip=ADDRESS)), Deny)
        assert throttle.check_address(ADDRESS) == Allow()
        assert throttle.check_address(ADDRESS) == Allow()
        assert isinstance(throttle.check_address(ADDRESS), Deny)
        assert isinstance(throttle.check(key(ip=ADDRESS)), Deny)  # still the per-form window's own count
    assert len(set(address_keys(storage))) == 1
    assert len(set(storage.seen) - set(address_keys(storage))) == 1


def test_the_address_window_belongs_to_the_same_caller_as_its_per_form_windows_for_eviction() -> None:
    salt = b"s" * 32
    per_form = storage_key((ThrottleBy.IP, ThrottleBy.FORM), ThrottleKey(ip=ADDRESS, form_key="contact"), salt)
    assert caller_of(address_storage_key(ADDRESS, salt)) == caller_of(per_form)


def test_the_address_window_counts_against_the_key_cap() -> None:
    throttle = LimitsThrottle(settings(address_limit=5, max_keys=2))
    for n in range(4):
        throttle.check_address(f"203.0.113.{n}")
    details = throttle.details()
    assert details["keys"] == 2
    assert details["evictions"] == 2


def test_a_storage_failure_fails_open_and_says_degraded() -> None:
    storage = FailingStorage()
    throttle = LimitsThrottle(settings(address_limit=1), storage=storage)
    assert [throttle.check_address(ADDRESS) for _ in range(3)] == [Allow()] * 3
    assert throttle.details()["degraded"] is True


# -- the async face ----------------------------------------------------------------------------------------------------
@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_the_async_face_counts_a_memory_uri_through_the_sync_face() -> None:
    throttle = AsyncLimitsThrottle(settings(address_limit=1))
    with time_machine.travel(START, tick=False):
        assert await throttle.check_address(ADDRESS) == Allow()
        assert isinstance(await throttle.check_address(ADDRESS), Deny)


@pytest.mark.anyio
async def test_the_async_face_counts_a_network_store_through_limits_aio() -> None:
    throttle = AsyncLimitsThrottle(
        settings(storage="async+redis://localhost:6379", key_salt="s" * 32, address_limit=2),
        storage=AsyncMemoryStorage(),
    )
    assert throttle.sync is None
    with time_machine.travel(START, tick=False):
        assert [await throttle.check_address("2001:db8::1"), await throttle.check_address("2001:db8::2")] == [
            Allow(),
            Allow(),
        ]
        denied = await throttle.check_address("2001:db8::3")
        assert isinstance(denied, Deny)
        assert denied.retry_after >= 1
        assert await throttle.check_address(None) == Allow()


@pytest.mark.anyio
async def test_count_address_answers_the_deny_of_datums_throttle_and_none_otherwise() -> None:
    from datum_core.aio import AsyncRunner  # noqa: PLC0415 - the runner only this test needs

    runner = AsyncRunner(worker_threads=1, wait=1.0, shutdown_grace=1.0)
    sync = LimitsThrottle(settings(address_limit=1))
    asynchronous = AsyncLimitsThrottle(settings(address_limit=1))
    with time_machine.travel(START, tick=False):
        for throttle in (sync, asynchronous):
            assert await count_address(throttle, ADDRESS, runner) is None
            denied = await count_address(throttle, ADDRESS, runner)
            assert isinstance(denied, Deny)

    class Custom:
        def check(self, key: ThrottleKey) -> Allow | Deny:
            return Deny(9)

    assert await count_address(Custom(), ADDRESS, runner) is None  # a custom throttle keeps no address limit


# -- the refusal through the service -----------------------------------------------------------------------------------
@pytest.mark.parametrize(("mode", "kind"), [("submit", ThrottleKind.SUBMIT), ("validate", ThrottleKind.VALIDATE)])
def test_a_refusal_on_submit_or_validate_is_throttled_with_the_event_the_per_form_refusal_publishes(
    mode: str, kind: ThrottleKind
) -> None:
    with started(throttle=None) as rig:
        refused = rig.service.address_refusal(mode, "2001:db8:1:2::1", "http", 17)
    assert isinstance(refused, Throttled)
    assert refused.retry_after == 17
    assert refused.key == ThrottleKey(ip="2001:db8:1:2::/64", kind=kind, channel="http")
    (event,) = rig.events
    assert event == SubmissionThrottledEvent(refused.key, kind, 17, "http")


@pytest.mark.parametrize("mode", ["test", "inspect"])
def test_a_refusal_of_a_dry_run_or_an_inspect_publishes_nothing_as_the_per_form_refusal_does(mode: str) -> None:
    with started(throttle=None) as rig:
        refused = rig.service.address_refusal(mode, ADDRESS, "http", 5)
    assert refused.key.kind is ThrottleKind.TEST
    assert rig.events == []


def test_a_refusal_for_another_mode_is_a_programming_error() -> None:
    with started(throttle=None) as rig, pytest.raises(ValueError, match="pdf"):
        rig.service.address_refusal("pdf", ADDRESS, "http", 5)


class _RefusalService:
    """Stands in for the sync service: the refusal is `Throttled` and the thread it ran on is kept."""

    def __init__(self) -> None:
        self.threads: list[int] = []

    def address_refusal(self, mode: str, address: str | None, channel: str, retry_after: int) -> Throttled:
        self.threads.append(threading.get_ident())
        return Throttled(retry_after, key(ip=address))


@pytest.mark.anyio
async def test_a_refusal_for_test_and_inspect_takes_no_runner_slot_and_submit_and_validate_do() -> None:
    runner = AsyncRunner(worker_threads=1, wait=0.0, shutdown_grace=1.0)
    service = _RefusalService()
    faced = AsyncSubmissionService(service, runner)  # type: ignore[arg-type]
    release = threading.Event()
    started_flag = threading.Event()

    def hold() -> None:
        started_flag.set()
        release.wait()

    held = asyncio.create_task(runner.run(hold))
    await asyncio.wait_for(asyncio.to_thread(started_flag.wait), 5)
    try:
        for mode in ("test", "inspect"):
            refused = await faced.address_refusal(mode, ADDRESS, "http", 7)
            assert refused.retry_after == 7
        assert service.threads == [threading.get_ident()] * 2  # on the loop
        for mode in ("submit", "validate"):
            with pytest.raises(EngineBusyError):
                await faced.address_refusal(mode, ADDRESS, "http", 7)
    finally:
        release.set()
        await held
        await runner.drain()
