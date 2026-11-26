"""`InMemoryTsaFlood`: the fixed-window counter behind `datum.tsa.flood.*`.

One count per key per window; the window starts at the key's first hit; `retry_after` is the remaining whole seconds,
at least 1 and at most the window (3600 at the default). The table holds 50,000 keys: at the cap the entry that expires
soonest is evicted and counted, the newcomer is counted (it fails open: a full table never denies), and the size never
passes the cap, also under 8 threads. The gate decides what a count means (`test_http_timestamp`).
"""

import math
import sys
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

from datum_core.stores.memory import InMemoryTsaFlood

WINDOW = 3600.0


def test_the_first_hit_of_a_key_counts_one_and_each_next_hit_one_more() -> None:
    flood = InMemoryTsaFlood()
    counts = [flood.hit("a", window=WINDOW, now=100.0).count for _ in range(4)]
    assert counts == [1, 2, 3, 4]


def test_peek_reads_the_count_without_counting() -> None:
    flood = InMemoryTsaFlood()
    assert flood.peek("a", window=WINDOW, now=0.0).count == 0
    flood.hit("a", window=WINDOW, now=0.0)
    assert flood.peek("a", window=WINDOW, now=1.0).count == 1
    assert flood.peek("a", window=WINDOW, now=2.0).count == 1


def test_keys_are_counted_apart() -> None:
    flood = InMemoryTsaFlood()
    flood.hit("a", window=WINDOW, now=0.0)
    flood.hit("a", window=WINDOW, now=0.0)
    assert flood.hit("b", window=WINDOW, now=0.0).count == 1


def test_the_window_starts_at_the_first_hit_and_the_count_restarts_after_it() -> None:
    flood = InMemoryTsaFlood()
    flood.hit("a", window=60.0, now=1000.0)
    flood.hit("a", window=60.0, now=1059.0)
    assert flood.hit("a", window=60.0, now=1059.9).count == 3
    assert flood.hit("a", window=60.0, now=1060.0).count == 1
    assert flood.hit("a", window=60.0, now=1061.0).count == 2


@pytest.mark.parametrize(
    ("elapsed", "expected"), [(0.0, 3600), (0.4, 3600), (1.0, 3599), (3599.0, 1), (3599.5, 1), (3599.99, 1)]
)
def test_retry_after_is_the_remaining_whole_seconds_rounded_up_and_never_below_one(
    elapsed: float, expected: int
) -> None:
    flood = InMemoryTsaFlood()
    flood.hit("a", window=WINDOW, now=500.0)
    assert flood.hit("a", window=WINDOW, now=500.0 + elapsed).retry_after == expected


def test_retry_after_never_passes_the_window() -> None:
    flood = InMemoryTsaFlood()
    for window in (1.0, 60.0, 3600.0):
        state = flood.hit(f"k{window}", window=window, now=10.0)
        assert 1 <= state.retry_after <= math.ceil(window)


# -- the cap -----------------------------------------------------------------------------------------------------------
def test_at_the_cap_the_entry_that_expires_soonest_is_evicted_and_counted() -> None:
    flood = InMemoryTsaFlood(max_keys=3)
    flood.hit("oldest", window=WINDOW, now=10.0)
    flood.hit("middle", window=WINDOW, now=20.0)
    flood.hit("newest", window=WINDOW, now=30.0)
    state = flood.hit("incoming", window=WINDOW, now=40.0)
    assert state.count == 1
    assert flood.size == 3
    assert flood.evictions == 1
    assert flood.peek("oldest", window=WINDOW, now=41.0).count == 0
    assert flood.peek("middle", window=WINDOW, now=41.0).count == 1


def test_a_key_with_a_shorter_window_expires_sooner_and_goes_first() -> None:
    flood = InMemoryTsaFlood(max_keys=2)
    flood.hit("long", window=3600.0, now=0.0)
    flood.hit("short", window=10.0, now=5.0)
    flood.hit("incoming", window=3600.0, now=6.0)
    assert flood.peek("short", window=10.0, now=6.0).count == 0
    assert flood.peek("long", window=3600.0, now=6.0).count == 1


def test_expired_entries_make_room_before_a_live_one_is_evicted() -> None:
    flood = InMemoryTsaFlood(max_keys=2)
    flood.hit("gone", window=10.0, now=0.0)
    flood.hit("live", window=3600.0, now=1.0)
    flood.hit("incoming", window=3600.0, now=50.0)
    assert flood.peek("live", window=3600.0, now=51.0).count == 1
    assert flood.evictions == 0  # an entry that had already expired is room, not an eviction


def test_a_full_table_never_denies_the_newcomer_and_a_hit_on_a_known_key_evicts_nothing() -> None:
    flood = InMemoryTsaFlood(max_keys=2)
    flood.hit("a", window=WINDOW, now=0.0)
    flood.hit("b", window=WINDOW, now=0.0)
    flood.hit("a", window=WINDOW, now=1.0)
    assert flood.evictions == 0
    assert flood.hit("c", window=WINDOW, now=2.0).count == 1


def test_a_stale_heap_row_of_a_renewed_key_never_evicts_its_live_window() -> None:
    """A renewed key leaves its old window's heap row behind; eviction tells it by the serial and skips it.

    Red against the mutant that drops the serial comparison in `_evict_one`: the stale row (expires 10) then evicts
    "renewed", whose live window runs to 1011, instead of "short", which expires soonest (111).
    """
    flood = InMemoryTsaFlood(max_keys=2)
    flood.hit("renewed", window=10.0, now=0.0)
    flood.hit("renewed", window=1000.0, now=11.0)  # the first window is over: a new one, a new heap row
    flood.hit("short", window=100.0, now=11.0)
    flood.hit("incoming", window=100.0, now=12.0)
    assert flood.peek("renewed", window=1000.0, now=12.0).count == 1
    assert flood.peek("short", window=100.0, now=12.0).count == 0
    assert flood.evictions == 1


def test_the_heap_is_rebuilt_from_the_live_windows_and_stays_bounded() -> None:
    """Keys renewed again and again push a row per window; the heap is compacted, never left to grow.

    Red against the mutant that never compacts (the heap reaches 4,000 rows) and against one that compacts to an
    empty heap (the next eviction finds nothing and the table passes its cap).
    """
    flood = InMemoryTsaFlood(max_keys=4)
    bound = 4 * flood.max_keys + 16
    now = 0.0
    for _ in range(1000):
        for key in ("a", "b", "c", "d"):
            flood.hit(key, window=1.0, now=now)
        now += 2.0
        assert len(flood._order) <= bound + 1  # pyright: ignore[reportPrivateUsage]
    assert flood.size == 4
    flood.hit("e", window=1.0, now=now)  # every held window has expired: one makes room
    assert flood.size == 4
    assert flood.evictions == 0


def test_an_eviction_right_after_the_heap_is_rebuilt_still_finds_the_soonest_live_window() -> None:
    """The rebuilt heap holds every live window, so the very next eviction finds one and the cap holds.

    Red against the mutant that rebuilds an empty heap: nothing is evicted and the table passes its cap.
    """
    flood = InMemoryTsaFlood(max_keys=4)
    for key in ("b", "c", "d"):
        flood.hit(key, window=1e6, now=0.0)
    now = 0.0
    for _ in range(100):
        before = len(flood._order)  # pyright: ignore[reportPrivateUsage]
        flood.hit("a", window=1.0, now=now)
        if len(flood._order) < before:  # pyright: ignore[reportPrivateUsage]
            break
        now += 2.0
    else:
        pytest.fail("the heap was never rebuilt")
    flood.hit("e", window=1e6, now=now + 0.5)
    assert flood.size == 4
    assert flood.evictions == 1
    assert flood.peek("a", window=1.0, now=now + 0.5).count == 0


def test_the_default_table_holds_50000_keys() -> None:
    flood = InMemoryTsaFlood()
    assert flood.max_keys == 50_000


def test_a_table_of_no_keys_is_refused() -> None:
    with pytest.raises(ValueError, match=r"max_keys|key"):
        InMemoryTsaFlood(max_keys=0)


def test_eight_threads_counting_keys_together_lose_no_hit() -> None:
    """Threads switch every microsecond here, so a `hit` without its lock loses counts (also at a key's first hit)."""
    flood = InMemoryTsaFlood()
    barrier = threading.Barrier(8)
    keys = [f"key-{number}" for number in range(1500)]
    shared_hits = 2000

    def hammer() -> None:
        barrier.wait(30)
        for key in keys:
            flood.hit(key, window=WINDOW, now=0.0)
        for _ in range(shared_hits):
            flood.hit("shared", window=WINDOW, now=0.0)

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            for future in [pool.submit(hammer) for _ in range(8)]:
                future.result(120)
    finally:
        sys.setswitchinterval(interval)
    counts = {flood.peek(key, window=WINDOW, now=1.0).count for key in keys}
    assert counts == {8}
    assert flood.peek("shared", window=WINDOW, now=1.0).count == 8 * shared_hits


def test_eight_threads_filling_a_small_table_never_pass_the_cap_or_raise() -> None:
    flood = InMemoryTsaFlood(max_keys=50)
    barrier = threading.Barrier(8)

    def fill(worker: int) -> None:
        barrier.wait(30)
        for number in range(200):
            assert flood.hit(f"{worker}-{number}", window=WINDOW, now=float(number)).count >= 1

    with ThreadPoolExecutor(max_workers=8) as pool:
        for future in [pool.submit(fill, worker) for worker in range(8)]:
            future.result(60)
    assert flood.size <= 50
    assert flood.evictions >= 8 * 200 - 50
