"""The timestamp server's memory stores bound to the shared contracts, and what only the memory stores promise.

`TsaSerialAllocatorContract`, `TsaLogContract` and `TsaClientStoreContract` live in `datum_core.testing` and are written
once (any store can bind them). The memory allocator is seeded from the clock and unique only within one
process (RFC 3161 section 2.4.2); the memory log keeps 1000 rows and no request bytes; the
client store over settings is not a memory store.
"""

import dataclasses
import sys
import threading
from collections.abc import Callable, Sequence
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta, timezone

import pytest
from tsa_support import CLIENT_KEY, key_hash

from datum_core.config.models import Tsa
from datum_core.stores.memory import MemoryTsaLog, MemoryTsaSerialAllocator
from datum_core.stores.tsa import SettingsTsaClientStore, TsaClientStore, TsaLog, TsaLogEntry, TsaSerialAllocator
from datum_core.testing import TsaClientStoreContract, TsaLogContract, TsaSerialAllocatorContract

T0 = datetime(2026, 10, 20, 12, 0, tzinfo=UTC)


class TestMemorySerialAllocator(TsaSerialAllocatorContract):
    @pytest.fixture
    def allocator(self) -> TsaSerialAllocator:
        return MemoryTsaSerialAllocator()


class TestMemoryLog(TsaLogContract):
    @pytest.fixture
    def log(self) -> TsaLog:
        return MemoryTsaLog()


class TestSettingsClientStore(TsaClientStoreContract):
    @pytest.fixture
    def store_factory(self) -> Callable[..., TsaClientStore]:
        def make(hashes: Sequence[str], revoked: Sequence[str] = ()) -> TsaClientStore:
            return SettingsTsaClientStore(hashes, revoked=revoked)

        return make


# -- the settings client store's use counters --------------------------------------------------------------------------
def test_uses_are_counted_with_the_latest_instant() -> None:
    hashed = key_hash("dtsa_use-counter")
    store = SettingsTsaClientStore([hashed])
    found = store.find(hashed)
    assert found is not None
    assert store.usage(found.id) == (0, None)
    store.record_use(found.id, T0 + timedelta(seconds=5))
    store.record_use(found.id, T0)
    assert store.usage(found.id) == (2, T0 + timedelta(seconds=5))
    store.record_use("c-unknown", T0)
    assert store.usage("c-unknown") == (0, None)


def test_uses_from_eight_threads_are_all_counted() -> None:
    hashed = key_hash("dtsa_use-threads")
    store = SettingsTsaClientStore([hashed])
    found = store.find(hashed)
    assert found is not None
    barrier = threading.Barrier(8)

    def work(number: int) -> None:
        barrier.wait(30)
        for step in range(200):
            store.record_use(found.id, T0 + timedelta(seconds=number * 1000 + step))

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(work, range(8)))
    assert store.usage(found.id) == (1600, T0 + timedelta(seconds=7199))


# -- the memory allocator ----------------------------------------------------------------------------------------------
class Clock:
    def __init__(self, at: datetime = T0) -> None:
        self.at = at

    def __call__(self) -> datetime:
        return self.at


def test_the_allocator_is_seeded_from_the_clock() -> None:
    early = MemoryTsaSerialAllocator(now=Clock(T0)).allocate()
    late = MemoryTsaSerialAllocator(now=Clock(T0 + timedelta(seconds=1))).allocate()
    assert late > early


def test_a_serial_survives_the_clock_being_set_back_within_the_process() -> None:
    clock = Clock(T0)
    allocator = MemoryTsaSerialAllocator(now=clock)
    before = [allocator.allocate() for _ in range(3)]
    clock.at = T0 - timedelta(days=1)
    after = [allocator.allocate() for _ in range(3)]
    assert after[0] > before[-1]
    assert len(set(before + after)) == 6


def test_more_than_a_thousand_tokens_in_one_millisecond_never_repeat_a_serial() -> None:
    allocator = MemoryTsaSerialAllocator(now=Clock(T0))
    serials = [allocator.allocate() for _ in range(5000)]
    assert serials == sorted(set(serials))


def test_the_allocator_with_no_clock_given_uses_the_real_one() -> None:
    first = MemoryTsaSerialAllocator().allocate()
    assert first > int(datetime(2026, 1, 1, tzinfo=UTC).timestamp())


def test_a_serial_seeded_from_the_year_2100_still_fits_160_bits() -> None:
    allocator = MemoryTsaSerialAllocator(now=Clock(datetime(2100, 1, 1, tzinfo=UTC)))
    assert allocator.allocate().bit_length() < 160


def test_the_seed_counts_milliseconds_in_integer_arithmetic() -> None:
    """At 999 microseconds into a millisecond in the year 2500 a float `timestamp() * 1000` rounds up a millisecond.

    Red against the pre-change seed `int(now.timestamp() * 1000)`, which gives 16734181326821 here.
    """
    at = datetime(2500, 4, 14, 15, 42, 6, 820999, tzinfo=UTC)
    assert MemoryTsaSerialAllocator(now=Clock(at)).allocate() == 16734181326820 << 32
    assert MemoryTsaSerialAllocator(now=Clock(T0)).allocate() == 1792497600000 << 32


def test_the_seed_ignores_the_clocks_offset_and_refuses_a_naive_instant() -> None:
    eastern = T0.astimezone(timezone(timedelta(hours=-4)))
    assert MemoryTsaSerialAllocator(now=Clock(eastern)).allocate() == MemoryTsaSerialAllocator(now=Clock(T0)).allocate()
    with pytest.raises(ValueError, match="timezone-aware"):
        MemoryTsaSerialAllocator(now=Clock(T0.replace(tzinfo=None))).allocate()


def test_a_restart_a_millisecond_later_starts_above_every_serial_the_process_before_it_gave() -> None:
    first = MemoryTsaSerialAllocator(now=Clock(T0))
    given = [first.allocate() for _ in range(5000)]
    second = MemoryTsaSerialAllocator(now=Clock(T0 + timedelta(milliseconds=1)))
    assert second.allocate() > max(given)


def test_eight_threads_racing_a_clock_that_stands_still_never_get_one_serial_twice() -> None:
    """The interpreter switches threads every microsecond here, so an allocator without its lock repeats a serial."""
    allocator = MemoryTsaSerialAllocator(now=Clock(T0))
    barrier = threading.Barrier(8)

    def take() -> list[int]:
        barrier.wait(30)
        return [allocator.allocate() for _ in range(2000)]

    interval = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        with ThreadPoolExecutor(max_workers=8) as pool:
            parts = [future.result(120) for future in [pool.submit(take) for _ in range(8)]]
    finally:
        sys.setswitchinterval(interval)
    everything = [serial for part in parts for serial in part]
    assert len(set(everything)) == 16000


# -- the memory log ----------------------------------------------------------------------------------------------------
def entry(serial: int) -> TsaLogEntry:
    return TsaLogEntry(serial, T0, "sha256", f"{serial:064x}", None)


def test_the_memory_log_keeps_1000_rows_and_drops_the_oldest() -> None:
    log = MemoryTsaLog()
    for serial in range(1, 1501):
        log.append(entry(serial))
    kept = log.recent(5000)
    assert len(kept) == 1000
    assert kept[0].serial == 1500
    assert kept[-1].serial == 501


def test_a_log_row_holds_scalars_only() -> None:
    fields = {field.name: field.type for field in dataclasses.fields(TsaLogEntry)}
    assert set(fields) == {"serial", "gen_time", "imprint_algorithm", "imprint", "client"}


def test_a_memory_log_of_another_size_is_taken_and_one_below_one_row_is_refused() -> None:
    log = MemoryTsaLog(max_entries=3)
    for serial in range(1, 6):
        log.append(entry(serial))
    assert [item.serial for item in log.recent(10)] == [5, 4, 3]
    with pytest.raises(ValueError, match=r"max_entries|row"):
        MemoryTsaLog(max_entries=0)


# -- the settings client store -----------------------------------------------------------------------------------------
def test_the_store_is_built_from_the_clients_setting() -> None:
    tsa = Tsa(clients=(key_hash(CLIENT_KEY),))
    store = SettingsTsaClientStore.from_settings(tsa)
    found = store.find(key_hash(CLIENT_KEY))
    assert found is not None
    assert store.find(key_hash("dtsa_other")) is None


def test_the_client_id_does_not_change_when_the_settings_are_read_again() -> None:
    hashes = [key_hash(f"dtsa_{n}") for n in range(3)]
    first = SettingsTsaClientStore(hashes).find(hashes[1])
    second = SettingsTsaClientStore(hashes).find(hashes[1])
    assert first is not None
    assert second is not None
    assert first.id == second.id
