"""`AsyncLimitsThrottle`: memory URIs count sync, network stores through `limits.aio`."""

import logging
from typing import Any

import pytest
import time_machine
from limits.aio.storage import MemoryStorage as AsyncMemoryStorage
from limits.storage import MemoryStorage
from throttle_support import START, key, settings

from datum_core.checks import W004
from datum_core.config.models import ThrottleKind
from datum_core.throttle import Allow, AsyncLimitsThrottle, BoundedMemoryStorage, Deny, LimitsThrottle

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def network(**throttle: Any) -> AsyncLimitsThrottle:
    """The network path with limits' own async memory store standing in for a redis one."""
    return AsyncLimitsThrottle(
        settings(storage="async+redis://localhost:6379", key_salt="s" * 32, **throttle), storage=AsyncMemoryStorage()
    )


async def test_a_memory_uri_is_counted_through_the_sync_throttle_directly() -> None:
    throttle = AsyncLimitsThrottle(settings(limit=2))
    with time_machine.travel(START, tick=False):
        answers = [await throttle.check(key()) for _ in range(3)]
    assert answers[:2] == [Allow(), Allow()]
    assert isinstance(answers[2], Deny)
    assert throttle.sync is not None
    assert isinstance(throttle.sync, LimitsThrottle)
    assert isinstance(throttle.sync.storage, BoundedMemoryStorage)  # the capped storage, no async twin


async def test_a_network_store_counts_through_limits_aio_and_denies_with_whole_seconds() -> None:
    throttle = network(limit=2, window=60)
    assert throttle.sync is None
    with time_machine.travel(START, tick=False) as clock:
        first = [await throttle.check(key()) for _ in range(3)]
        assert first[:2] == [Allow(), Allow()]
        denied = first[2]
        assert isinstance(denied, Deny)
        assert denied.retry_after >= 1
        clock.shift(61)
        assert await throttle.check(key()) == Allow()


async def test_the_kinds_are_counted_apart_and_a_kind_has_its_own_limit() -> None:
    throttle = network(limit=1, limits={"test": 3})
    with time_machine.travel(START, tick=False):
        assert await throttle.check(key(ThrottleKind.SUBMIT)) == Allow()
        assert isinstance(await throttle.check(key(ThrottleKind.SUBMIT)), Deny)
        assert [await throttle.check(key(ThrottleKind.TEST)) for _ in range(3)] == [Allow()] * 3
        assert isinstance(await throttle.check(key(ThrottleKind.TEST)), Deny)


async def test_the_storage_sees_a_hash_of_the_components_and_never_a_raw_address() -> None:
    seen: list[str] = []

    class Spy(AsyncMemoryStorage):
        async def incr(self, key: str, expiry: float, amount: int = 1) -> int:
            seen.append(key)
            return await super().incr(key, expiry, amount)

    throttle = AsyncLimitsThrottle(settings(storage="async+redis://localhost:6379", key_salt="s" * 32), storage=Spy())
    await throttle.check(key(ip="198.51.100.9", principal="alice"))
    assert len(seen) == 1
    assert "datum:throttle:submit:" in seen[0]
    assert "198.51.100.9" not in seen[0]
    assert "alice" not in seen[0]


async def test_a_failing_network_store_fails_open_logs_once_and_reports_degraded(
    caplog: pytest.LogCaptureFixture,
) -> None:
    class Broken(AsyncMemoryStorage):
        async def incr(self, key: str, expiry: float, amount: int = 1) -> int:
            raise ConnectionError("redis://:hunter2@cache.internal is down")

    throttle = AsyncLimitsThrottle(
        settings(storage="async+redis://localhost:6379", key_salt="s" * 32), storage=Broken()
    )
    with caplog.at_level(logging.ERROR, logger="datum.submissions"):
        answers = [await throttle.check(key()) for _ in range(3)]
    assert answers == [Allow()] * 3
    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert len(errors) == 1
    assert "ConnectionError" in errors[0].getMessage()
    assert "hunter2" not in caplog.text
    assert throttle.details()["degraded"] is True


async def test_a_store_that_cannot_be_built_fails_open_instead_of_breaking_the_request() -> None:
    throttle = AsyncLimitsThrottle(settings(storage="async+redis://localhost:6379", key_salt="s" * 32))
    assert await throttle.check(key()) == Allow()  # the client library is absent: the failure is logged, not raised
    assert throttle.details()["degraded"] is True


async def test_the_throttle_switched_off_allows_everything() -> None:
    throttle = network(enabled=False, limit=1)
    assert [await throttle.check(key()) for _ in range(3)] == [Allow()] * 3


async def test_the_checks_and_details_match_the_sync_throttle_for_each_path() -> None:
    memory = AsyncLimitsThrottle(settings())
    warned = memory.check_w004()
    assert warned is not None
    assert warned.id == W004
    assert memory.check_key_salt() is None
    assert memory.details()["store"] == "memory"
    shared = AsyncLimitsThrottle(settings(storage="async+redis://localhost:6379"))
    assert shared.check_key_salt() is not None  # a shared store without a key_salt
    assert shared.check_w004() is None
    assert shared.details()["perProcess"] is False
    salted = AsyncLimitsThrottle(settings(storage="async+redis://localhost:6379", key_salt="s" * 32))
    assert salted.check_key_salt() is None


def test_an_in_process_async_memory_store_counts_as_a_memory_store() -> None:
    throttle = AsyncLimitsThrottle(settings(storage="async+redis://x"), storage=AsyncMemoryStorage())
    assert throttle.check_w004() is not None
    assert isinstance(MemoryStorage(), MemoryStorage)


async def test_a_sync_style_uri_is_counted_through_the_async_form_and_never_raises_at_construction() -> None:
    throttle = AsyncLimitsThrottle(settings(storage="redis://:hunter2@cache.internal:6379/0", key_salt="s" * 32))
    assert throttle.sync is None
    assert await throttle.check(key()) == Allow()  # the client library is absent here: fail open, logged, no raise
    assert throttle.details()["degraded"] is True
