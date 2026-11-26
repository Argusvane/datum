"""`LimitsThrottle` on `limits`: kinds, per-kind limits, key parts, the window, `Retry-After`, storage keys."""

import re
import time
from collections.abc import Callable
from typing import Any

import pytest
import time_machine
from limits.storage import MemoryStorage, Storage
from throttle_support import START, SpyStorage, key, settings

from datum_core.checks import W004
from datum_core.config.models import ThrottleBy, ThrottleKind
from datum_core.throttle import (
    Allow,
    BoundedMemoryStorage,
    Deny,
    LimitsThrottle,
    ThrottleKey,
    limits_throttle,
    storage_key,
)

type Maker = Callable[..., LimitsThrottle]


@pytest.fixture(params=["default storage", "bounded storage given", "memory uri"])
def make(request: pytest.FixtureRequest) -> Maker:
    """Build the throttle three ways: the suite below must pass for each (the same suite either way)."""

    def build(**throttle: Any) -> LimitsThrottle:
        configured = settings(**throttle)
        if request.param == "bounded storage given":
            return LimitsThrottle(configured, storage=BoundedMemoryStorage(configured.max_keys))
        if request.param == "memory uri":
            return LimitsThrottle(settings(**throttle, storage="memory://"))
        return LimitsThrottle(configured)

    return build


def test_the_kinds_are_exactly_the_five_of_the_plan() -> None:
    assert [kind.value for kind in ThrottleKind] == ["submit", "validate", "test", "pdf", "register"]


def test_a_key_within_the_limit_is_allowed_and_the_next_is_denied(make: Maker) -> None:
    throttle = make(limit=3)
    with time_machine.travel(START, tick=False):
        answers = [throttle.check(key()) for _ in range(4)]
    assert answers[:3] == [Allow()] * 3
    assert isinstance(answers[3], Deny)


def test_retry_after_is_whole_seconds_from_the_windows_reset_and_at_least_one(make: Maker) -> None:
    throttle = make(limit=1, window=60)
    with time_machine.travel(START, tick=False) as clock:
        assert throttle.check(key()) == Allow()
        clock.shift(10.3)
        early = throttle.check(key())
        clock.shift(49.6)
        late = throttle.check(key())
    assert isinstance(early, Deny)
    assert type(early.retry_after) is int
    assert early.retry_after == 50
    assert isinstance(late, Deny)
    assert type(late.retry_after) is int
    assert late.retry_after == 1


def test_the_window_resets_and_the_key_is_allowed_again(make: Maker) -> None:
    throttle = make(limit=1, window=60)
    with time_machine.travel(START, tick=False) as clock:
        assert throttle.check(key()) == Allow()
        assert isinstance(throttle.check(key()), Deny)
        clock.shift(61)
        assert throttle.check(key()) == Allow()


def test_each_kind_counts_on_its_own(make: Maker) -> None:
    throttle = make(limit=2)
    with time_machine.travel(START, tick=False):
        for _ in range(2):
            assert throttle.check(key(ThrottleKind.SUBMIT)) == Allow()
        assert isinstance(throttle.check(key(ThrottleKind.SUBMIT)), Deny)
        for kind in (ThrottleKind.VALIDATE, ThrottleKind.TEST, ThrottleKind.PDF, ThrottleKind.REGISTER):
            assert throttle.check(key(kind)) == Allow(), kind


def test_a_limit_per_kind_overrides_the_general_limit_for_that_kind_only(make: Maker) -> None:
    throttle = make(limit=3, limits={"test": 1, "pdf": 2})
    with time_machine.travel(START, tick=False):
        assert throttle.check(key(ThrottleKind.TEST)) == Allow()
        assert isinstance(throttle.check(key(ThrottleKind.TEST)), Deny)
        assert [throttle.check(key(ThrottleKind.PDF)) for _ in range(2)] == [Allow(), Allow()]
        assert isinstance(throttle.check(key(ThrottleKind.PDF)), Deny)
        assert [throttle.check(key(ThrottleKind.SUBMIT)) for _ in range(3)] == [Allow()] * 3
        assert isinstance(throttle.check(key(ThrottleKind.SUBMIT)), Deny)


def test_by_ip_and_form_counts_an_address_per_form(make: Maker) -> None:
    throttle = make(limit=1, by=["ip", "form"])
    with time_machine.travel(START, tick=False):
        assert throttle.check(key(form_key="contact")) == Allow()
        assert throttle.check(key(form_key="claims")) == Allow()
        assert isinstance(throttle.check(key(form_key="contact")), Deny)
        assert throttle.check(key(form_key="contact", ip="198.51.100.9")) == Allow()


def test_by_ip_alone_shares_one_counter_across_forms(make: Maker) -> None:
    throttle = make(limit=1, by=["ip"])
    with time_machine.travel(START, tick=False):
        assert throttle.check(key(form_key="contact")) == Allow()
        assert isinstance(throttle.check(key(form_key="claims")), Deny)


def test_by_principal_counts_a_person_across_addresses(make: Maker) -> None:
    throttle = make(limit=1, by=["principal"])
    with time_machine.travel(START, tick=False):
        assert throttle.check(key(principal="alice", ip="203.0.113.1")) == Allow()
        assert isinstance(throttle.check(key(principal="alice", ip="203.0.113.2")), Deny)
        assert throttle.check(key(principal="bob", ip="203.0.113.1")) == Allow()


def test_the_principal_and_the_channel_are_not_part_of_the_default_key(make: Maker) -> None:
    throttle = make(limit=1)
    with time_machine.travel(START, tick=False):
        assert throttle.check(key(principal="alice", channel="http")) == Allow()
        assert isinstance(throttle.check(key(principal="bob", channel="bus")), Deny)


def test_a_disabled_throttle_allows_everything_and_touches_no_storage() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(enabled=False, limit=1), storage=storage)
    assert [throttle.check(key()) for _ in range(5)] == [Allow()] * 5
    assert storage.seen == []


def test_storage_gets_a_prefix_the_kind_and_a_sha256_never_the_raw_components() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(by=["ip", "form", "principal"]), storage=storage)
    throttle.check(key(ThrottleKind.VALIDATE, ip="2001:db8::1", form_key="contact", principal="alice@example.org"))
    (stored,) = set(storage.seen)
    # `limits` frames the identifier it is given (namespace, amount, granularity); the identifier is Datum's.
    assert re.search(r"datum:throttle:validate:[0-9a-f]{64}(?![0-9a-f])", stored)
    for raw in ("2001:db8", "contact", "alice", "example.org"):
        assert raw not in stored


def test_the_same_components_give_the_same_storage_key_and_another_form_another_one() -> None:
    storage = SpyStorage()
    throttle = LimitsThrottle(settings(), storage=storage)
    throttle.check(key(form_key="contact"))
    throttle.check(key(form_key="contact", channel="bus", principal="someone"))
    throttle.check(key(form_key="claims"))
    assert storage.seen[0] == storage.seen[1] != storage.seen[2]


def test_the_storage_key_ends_with_the_callers_digest_which_leaves_the_form_out() -> None:
    by = (ThrottleBy.IP, ThrottleBy.FORM, ThrottleBy.PRINCIPAL)
    salt = b"s" * 32

    def caller(stored: str) -> str:
        found = re.fullmatch(r"datum:throttle:[a-z]+:[0-9a-f]{64}:([0-9a-f]{64})", stored)
        assert found is not None, stored
        return found.group(1)

    contact = storage_key(by, key(form_key="contact", principal="alice"), salt)
    claims = storage_key(by, key(ThrottleKind.VALIDATE, form_key="claims", principal="alice"), salt)
    assert contact != claims
    assert caller(contact) == caller(claims)
    assert caller(storage_key(by, key(form_key="contact", principal="bob"), salt)) != caller(contact)
    assert caller(storage_key(by, key(ip="198.51.100.2", principal="alice"), salt)) != caller(contact)
    assert caller(storage_key(by, key(form_key="contact", principal="alice"), b"t" * 32)) != caller(contact)
    for raw in ("203.0.113", "contact", "claims", "alice"):
        assert raw not in contact
    only_form = (ThrottleBy.FORM,)
    assert caller(storage_key(only_form, key(ip="198.51.100.2"), salt)) == caller(storage_key(only_form, key(), salt))


def test_one_address_naming_many_forms_cannot_reset_its_own_full_window_or_another_addresses() -> None:
    throttle = LimitsThrottle(settings(limit=3, max_keys=64))
    sprayer, other = "203.0.113.7", "198.51.100.2"
    with time_machine.travel(START, tick=False):
        for n in range(5_000):  # an unknown form id still opens a window
            throttle.check(key(ip=sprayer, form_key=f"unknown-{n}"))
        assert [throttle.check(key(ip=sprayer)) for _ in range(3)] == [Allow()] * 3
        assert isinstance(throttle.check(key(ip=sprayer)), Deny)
        assert throttle.check(key(ip=other)) == Allow()  # the newest window of all
        for n in range(5_000, 10_000):
            throttle.check(key(ip=sprayer, form_key=f"unknown-{n}"))
        assert isinstance(throttle.check(key(ip=sprayer)), Deny)
        assert [throttle.check(key(ip=other)) for _ in range(2)] == [Allow()] * 2
        assert isinstance(throttle.check(key(ip=other)), Deny)
    storage = throttle.storage
    assert isinstance(storage, BoundedMemoryStorage)
    assert len(storage) <= 64
    assert storage.evictions > 0


def test_the_default_storage_is_the_bounded_one_sized_by_max_keys() -> None:
    throttle = LimitsThrottle(settings(max_keys=77))
    assert isinstance(throttle.storage, BoundedMemoryStorage)
    assert throttle.storage.max_keys == 77


def test_the_details_say_memory_and_per_process_and_show_the_cap_and_evictions() -> None:
    details = LimitsThrottle(settings(max_keys=77)).details()
    assert details["store"] == "memory"
    assert details["maxKeys"] == 77
    assert details["evictions"] == 0
    assert details["perProcess"] is True


@pytest.mark.parametrize("uri", ["memory://", "async+memory://"])
def test_a_memory_uri_is_always_the_bounded_storage(uri: str) -> None:
    throttle = LimitsThrottle(settings(storage=uri))
    assert isinstance(throttle.storage, BoundedMemoryStorage)


def test_another_uri_reaches_limits_with_the_async_prefix_dropped(monkeypatch: pytest.MonkeyPatch) -> None:
    seen: list[str] = []

    def fake(uri: str, **options: object) -> MemoryStorage:
        seen.append(uri)
        return MemoryStorage()

    monkeypatch.setattr(limits_throttle, "storage_from_string", fake)
    throttle = LimitsThrottle(settings(storage="async+redis://cache.internal:6379/0"))
    LimitsThrottle(settings(storage="redis://cache.internal:6379/1"))
    assert seen == ["redis://cache.internal:6379/0", "redis://cache.internal:6379/1"]
    assert not isinstance(throttle.storage, BoundedMemoryStorage)
    assert "cache.internal" not in repr(throttle.details())
    assert throttle.check_w004() is not None  # limits' own memory storage is still per process


def test_a_given_in_process_storage_is_reported_as_per_process() -> None:
    throttle = LimitsThrottle(settings(), storage=MemoryStorage())
    assert throttle.details() == {"store": "memory", "perProcess": True, "degraded": False}
    notice = throttle.check_w004()
    assert notice is not None
    assert notice.id == W004


def test_w004_is_stated_for_the_default_throttle_and_not_for_a_shared_storage(monkeypatch: pytest.MonkeyPatch) -> None:
    notice = LimitsThrottle(settings()).check_w004()
    assert notice is not None
    assert notice.id == W004

    class Shared(Storage):
        """A stand-in for a network storage: not in this process's memory by type."""

        STORAGE_SCHEME = ["redis"]  # noqa: RUF012 - mirrors limits' own class attribute

        def __init__(self) -> None:
            super().__init__()
            self.inner = MemoryStorage()

        @property
        def base_exceptions(self) -> type[Exception]:
            return Exception

        def incr(self, key: str, expiry: int, amount: int = 1) -> int:
            return self.inner.incr(key, expiry, amount)

        def get(self, key: str) -> int:
            return self.inner.get(key)

        def get_expiry(self, key: str) -> float:
            return self.inner.get_expiry(key)

        def check(self) -> bool:
            return True

        def reset(self) -> int | None:
            return self.inner.reset()

        def clear(self, key: str) -> None:
            self.inner.clear(key)

    monkeypatch.setattr(limits_throttle, "storage_from_string", lambda uri, **options: Shared())
    shared = LimitsThrottle(settings(storage="redis://cache.internal:6379/0"))
    assert shared.details() == {"store": "redis", "perProcess": False, "degraded": False}
    assert shared.check_w004() is None


def test_retry_after_is_at_least_one_when_the_window_is_gone_by_the_time_it_is_read() -> None:
    class Gone(SpyStorage):
        def get_expiry(self, key: str) -> float:
            return time.time() - 5

    throttle = LimitsThrottle(settings(limit=1), storage=Gone())
    with time_machine.travel(START, tick=False):
        throttle.check(key())
        denied = throttle.check(key())
    assert denied == Deny(1)


def test_the_window_setting_is_the_window() -> None:
    throttle = LimitsThrottle(settings(limit=1, window=10))
    with time_machine.travel(START, tick=False) as clock:
        throttle.check(key())
        denied = throttle.check(key())
        clock.shift(11)
        again = throttle.check(key())
    assert denied == Deny(10)
    assert again == Allow()


def test_the_address_and_the_principal_stay_out_of_the_keys_repr() -> None:
    text = repr(
        ThrottleKey(ip="203.0.113.7", form_key="contact", principal="alice@example.org", kind=ThrottleKind.SUBMIT)
    )
    assert "203.0.113.7" not in text
    assert "alice" not in text
