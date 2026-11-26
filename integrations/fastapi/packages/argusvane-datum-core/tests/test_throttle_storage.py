"""The key cap. Datum's own bounded memory storage implements `limits`' storage interface; at the cap a new key first
drops the expired windows, and when none has expired a sixteenth of the live ones goes, one at a time from the caller
holding the most, its window of the fewest attempts first and the newest among equals. Each eviction is counted and
warned once per window; it fails OPEN."""

import logging
import sys
import threading
import tracemalloc
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor

import pytest
import time_machine
from limits import parse
from limits.storage import Storage
from limits.strategies import FixedWindowRateLimiter
from throttle_support import START

from datum_core.config.models import ThrottleBy
from datum_core.loggers import SUBMISSIONS
from datum_core.throttle import BoundedMemoryStorage, ThrottleKey, storage_key

BY = (ThrottleBy.IP, ThrottleBy.FORM)


def counted(ip: str, form: str) -> str:
    """The storage key the throttle gives a request of `ip` for `form` (the caller's digest included)."""
    return storage_key(BY, ThrottleKey(ip=ip, form_key=form), b"s" * 32)


@pytest.fixture
def tight_switching() -> Iterator[None]:
    """Switch threads every microsecond, so a check-then-write race is hit, not hoped for."""
    before = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        yield
    finally:
        sys.setswitchinterval(before)


def test_the_storage_is_a_limits_storage_and_a_fixed_window_limiter_runs_on_it() -> None:
    storage = BoundedMemoryStorage(100)
    assert isinstance(storage, Storage)
    limiter = FixedWindowRateLimiter(storage)
    item = parse("2/minute")
    with time_machine.travel(START, tick=False):
        assert [limiter.hit(item, "k") for _ in range(3)] == [True, True, False]


def test_incr_counts_and_get_and_get_expiry_agree() -> None:
    storage = BoundedMemoryStorage(100)
    with time_machine.travel(START, tick=False):
        assert storage.incr("a", 60) == 1
        assert storage.incr("a", 60, amount=2) == 3
        assert storage.get("a") == 3
        assert storage.get_expiry("a") == pytest.approx(START.timestamp() + 60, abs=1)
        assert storage.get("missing") == 0


def test_clear_and_reset_empty_the_storage() -> None:
    storage = BoundedMemoryStorage(100)
    storage.incr("a", 60)
    storage.incr("b", 60)
    storage.clear("a")
    assert storage.get("a") == 0
    assert storage.get("b") == 1
    storage.reset()
    assert storage.get("b") == 0
    assert storage.check() is True


def test_an_expired_key_starts_a_new_window() -> None:
    storage = BoundedMemoryStorage(100)
    with time_machine.travel(START, tick=False) as clock:
        storage.incr("a", 10)
        clock.shift(11)
        assert storage.get("a") == 0
        assert storage.incr("a", 10) == 1


def test_equal_cost_windows_of_equal_callers_drop_the_newest_first() -> None:
    storage = BoundedMemoryStorage(3)
    with time_machine.travel(START, tick=False):
        storage.incr("oldest", 600)
        storage.incr("middle", 5)
        storage.incr("newest", 60)
        storage.incr("new", 60)
        # read inside the frozen window: outside it the real clock may already have passed START + 600 s
        assert len(storage) == 3
        assert storage.get("newest") == 0
        assert storage.get("oldest") == 1
        assert storage.get("middle") == 1
        assert storage.get("new") == 1
        assert storage.evictions == 1


def test_at_the_cap_the_caller_holding_the_most_windows_gives_up_its_newest_first() -> None:
    storage = BoundedMemoryStorage(4)
    with time_machine.travel(START, tick=False):
        storage.incr(counted("203.0.113.7", "first"), 60)
        storage.incr(counted("198.51.100.2", "contact"), 60)
        storage.incr(counted("203.0.113.7", "second"), 60)
        storage.incr(counted("203.0.113.7", "third"), 60)
        storage.incr(counted("192.0.2.9", "contact"), 60)
        assert storage.get(counted("203.0.113.7", "third")) == 0
        assert storage.get(counted("203.0.113.7", "first")) == 1
        assert storage.get(counted("203.0.113.7", "second")) == 1
        assert storage.get(counted("198.51.100.2", "contact")) == 1
        assert storage.get(counted("192.0.2.9", "contact")) == 1
        assert storage.evictions == 1


def test_a_caller_gives_up_its_window_of_the_fewest_attempts_first() -> None:
    storage = BoundedMemoryStorage(3)
    full = counted("203.0.113.7", "contact")
    with time_machine.travel(START, tick=False):
        storage.incr(counted("203.0.113.7", "one"), 60)
        storage.incr(counted("203.0.113.7", "two"), 60, amount=2)
        storage.incr(full, 60, amount=5)  # the newest: the attempts, not the age, keep it
        for n in range(20):
            storage.incr(counted("203.0.113.7", f"spray-{n}"), 60)
        assert storage.get(full) == 5
        assert storage.get(counted("203.0.113.7", "two")) == 2


def test_one_address_naming_many_forms_cannot_evict_its_own_full_window_or_another_addresses() -> None:
    storage = BoundedMemoryStorage(64)
    full = counted("203.0.113.7", "contact")
    other = counted("198.51.100.2", "contact")
    with time_machine.travel(START, tick=False):
        for n in range(5_000):
            storage.incr(counted("203.0.113.7", f"unknown-{n}"), 60)
        storage.incr(full, 60, amount=3)  # opened at the cap, so it is the newest window
        storage.incr(other, 60)  # and then this one
        for n in range(5_000, 10_000):
            storage.incr(counted("203.0.113.7", f"unknown-{n}"), 60)
        assert len(storage) <= 64
        assert storage.get(full) == 3
        assert storage.get(other) == 1
        assert storage.evictions > 0


def test_when_nothing_has_expired_a_sixteenth_of_the_windows_goes_at_once() -> None:
    storage = BoundedMemoryStorage(32)
    with time_machine.travel(START, tick=False):
        for n in range(32):
            storage.incr(counted("203.0.113.7", f"form-{n}"), 60)
        storage.incr(counted("198.51.100.2", "contact"), 60)
        assert len(storage) == 31
        assert storage.evictions == 2
        assert storage.get(counted("198.51.100.2", "contact")) == 1


def test_a_key_of_another_shape_is_a_caller_of_its_own() -> None:
    storage = BoundedMemoryStorage(3)
    with time_machine.travel(START, tick=False):
        storage.incr(counted("203.0.113.7", "a"), 60)
        storage.incr(counted("203.0.113.7", "b"), 60)
        storage.incr("plain", 60)
        storage.incr("another", 60)
        assert storage.get("plain") == 1
        assert storage.get("another") == 1
        assert storage.get(counted("203.0.113.7", "a")) == 1
        assert storage.get(counted("203.0.113.7", "b")) == 0


def test_an_expired_entry_is_evicted_before_a_live_one() -> None:
    storage = BoundedMemoryStorage(2)
    with time_machine.travel(START, tick=False) as clock:
        storage.incr("expiring", 5)
        storage.incr("long", 600)
        clock.shift(10)
        storage.incr("new", 60)
        assert storage.get("long") == 1
        assert storage.get("expiring") == 0


def test_a_new_key_at_the_cap_is_always_counted_never_refused_the_policy_fails_open() -> None:
    storage = BoundedMemoryStorage(2)
    with time_machine.travel(START, tick=False):
        assert storage.incr("a", 60) == 1
        assert storage.incr("b", 60) == 1
        assert [storage.incr(f"flood-{n}", 60) for n in range(50)] == [1] * 50


def test_an_evicted_victim_is_never_locked_out_its_counter_just_restarts() -> None:
    limiter = FixedWindowRateLimiter(BoundedMemoryStorage(2))
    item = parse("1/minute")
    with time_machine.travel(START, tick=False):
        assert limiter.hit(item, "flooder-1") is True
        assert limiter.hit(item, "victim") is True
        assert limiter.hit(item, "flooder-2") is True  # evicts the newest of the equal windows: the victim's
        assert limiter.hit(item, "victim") is True


def test_the_cap_holds_under_eight_threads_and_ten_times_max_keys_distinct_keys(tight_switching: None) -> None:
    max_keys = 200
    storage = BoundedMemoryStorage(max_keys)
    distinct = max_keys * 10
    gate = threading.Barrier(8)
    sizes: list[int] = []

    def flood(thread: int) -> None:
        gate.wait(timeout=30)
        for n in range(distinct // 8):
            storage.incr(f"datum:throttle:submit:{thread}-{n}", 60)
            if n % 25 == 0:
                sizes.append(len(storage))

    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in [pool.submit(flood, t) for t in range(8)]:
            future.result(timeout=120)
    assert len(storage) <= max_keys
    assert max(sizes) <= max_keys
    assert storage.evictions >= distinct - max_keys


def test_one_hot_key_hit_by_eight_threads_counts_every_hit(tight_switching: None) -> None:
    storage = BoundedMemoryStorage(100)
    gate = threading.Barrier(8)

    def hit() -> None:
        gate.wait(timeout=30)
        for _ in range(250):
            storage.incr("hot", 600)

    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in [pool.submit(hit) for _ in range(8)]:
            future.result(timeout=60)
    assert storage.get("hot") == 2000


def test_memory_stays_flat_while_a_few_keys_restart_their_windows_many_times() -> None:
    storage = BoundedMemoryStorage(10)
    with time_machine.travel(START, tick=False) as clock:
        for _ in range(200):
            for n in range(10):
                storage.incr(f"k{n}", 1)
            clock.shift(2)
        tracemalloc.start()
        before = tracemalloc.take_snapshot()
        for _ in range(5000):
            for n in range(10):
                storage.incr(f"k{n}", 1)
            clock.shift(2)
        grown = sum(s.size_diff for s in tracemalloc.take_snapshot().compare_to(before, "filename"))
        tracemalloc.stop()
    assert len(storage) == 10
    assert grown < 64 * 1024, grown


def test_each_eviction_is_counted_and_the_details_show_the_cap_the_keys_and_the_count() -> None:
    storage = BoundedMemoryStorage(2)
    for n in range(5):
        storage.incr(f"k{n}", 60)
    assert storage.evictions == 3
    assert storage.details() == {"store": "memory", "keys": 2, "maxKeys": 2, "evictions": 3, "perProcess": True}


def test_evictions_are_warned_once_per_window_on_the_submissions_logger(caplog: pytest.LogCaptureFixture) -> None:
    storage = BoundedMemoryStorage(2)
    with caplog.at_level(logging.WARNING, logger=SUBMISSIONS), time_machine.travel(START, tick=False) as clock:
        for n in range(20):
            storage.incr(f"k{n}", 60)
        first = [r for r in caplog.records if r.name == SUBMISSIONS and r.levelno == logging.WARNING]
        clock.shift(61)
        for n in range(20, 40):
            storage.incr(f"k{n}", 60)
        second = [r for r in caplog.records if r.name == SUBMISSIONS and r.levelno == logging.WARNING]
    assert len(first) == 1
    assert len(second) == 2
    text = first[0].getMessage()
    assert "max_keys" in text or "datum.web.throttle.max_keys" in text
    assert "k0" not in text  # the warning names the setting, never a key


def test_nothing_is_warned_while_the_cap_is_not_reached(caplog: pytest.LogCaptureFixture) -> None:
    storage = BoundedMemoryStorage(100)
    with caplog.at_level(logging.WARNING, logger=SUBMISSIONS):
        for n in range(100):
            storage.incr(f"k{n}", 60)
    assert caplog.records == []
    assert storage.evictions == 0


def test_a_cap_of_no_keys_is_refused() -> None:
    with pytest.raises(ValueError, match="at least"):
        BoundedMemoryStorage(0)
