"""The timestamp server's store contracts, written once: serials, the issue log and the clients.

Each contract is a pytest class a store's test module subclasses, overriding one fixture:

    class TestMemorySerials(TsaSerialAllocatorContract):
        @pytest.fixture
        def allocator(self) -> Iterator[TsaSerialAllocator]:
            yield MemoryTsaSerialAllocator()

    class TestMemoryLog(TsaLogContract):
        @pytest.fixture
        def log(self) -> Iterator[TsaLog]:
            yield MemoryTsaLog()

    class TestSettingsClients(TsaClientStoreContract):
        @pytest.fixture
        def store_factory(self) -> Iterator[Callable[..., TsaClientStore]]:
            yield lambda hashes, revoked=(): SettingsTsaClientStore(hashes, revoked=revoked)

Any store, SQL included, can bind the same classes. The cases use only the
protocol (`allocate`; `append` and `recent`; `find` and `record_use`) and never look inside a store, so the contract is
store-neutral. The races run 8 threads at once; the contract fixes 8.

Libraries: `threading` and `concurrent.futures` (standard library) run the race;
`datum_core.testing.idempotency_contract` is the pattern for a store contract; nothing else has a TSA store vocabulary.
"""

# ruff: noqa: S101, D102 - a contract is assertions, and each test name is its sentence

from __future__ import annotations

import hashlib
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime, timedelta
from typing import TYPE_CHECKING, ClassVar

import pytest

if TYPE_CHECKING:
    from collections.abc import Callable, Iterator, Sequence

    from datum_core.stores.tsa import TsaClientStore, TsaLog, TsaLogEntry, TsaSerialAllocator

__all__ = ["TsaClientStoreContract", "TsaLogContract", "TsaSerialAllocatorContract"]

SERIAL_LIMIT = 2**159
"""RFC 3161 serials are at most 160 bits (RFC 5280 section 4.1.2.2 bounds a certificate serial at 20 octets)."""
THREADS = 8
PER_THREAD = 10


def key_hash(text: str) -> str:
    """Return the lower-case hex SHA-256 of a client key's whole text (what a client store is asked for)."""
    return hashlib.sha256(text.encode()).hexdigest()


def key_text(number: int) -> str:
    """Return a client key as a person is handed it: ``dtsa_`` and 43 URL-safe characters."""
    return "dtsa_" + hashlib.sha256(f"client-{number}".encode()).hexdigest()[:43]


class TsaSerialAllocatorContract:
    """The serial protocol: positive, within 160 bits, never reused, strictly increasing within the process."""

    threads: ClassVar[int] = THREADS

    @pytest.fixture
    def allocator(self) -> Iterator[TsaSerialAllocator]:
        """Yield a fresh allocator (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `allocator` fixture")

    def test_a_serial_is_a_positive_integer_within_160_bits(self, allocator: TsaSerialAllocator) -> None:
        serial = allocator.allocate()
        assert isinstance(serial, int)
        assert 0 < serial < SERIAL_LIMIT

    def test_serials_increase_strictly_in_one_thread(self, allocator: TsaSerialAllocator) -> None:
        serials = [allocator.allocate() for _ in range(100)]
        assert serials == sorted(set(serials))

    def test_a_serial_is_never_reused_by_threads_racing_for_them(self, allocator: TsaSerialAllocator) -> None:
        barrier = threading.Barrier(self.threads)

        def take() -> list[int]:
            barrier.wait(30)
            return [allocator.allocate() for _ in range(PER_THREAD)]

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            futures = [pool.submit(take) for _ in range(self.threads)]
            taken = [future.result(60) for future in futures]
        everything = [serial for part in taken for serial in part]
        assert len(everything) == self.threads * PER_THREAD
        assert len(set(everything)) == len(everything), "two threads were given one serial"
        assert all(0 < serial < SERIAL_LIMIT for serial in everything)

    def test_each_thread_sees_its_own_serials_increase(self, allocator: TsaSerialAllocator) -> None:
        barrier = threading.Barrier(self.threads)

        def take() -> list[int]:
            barrier.wait(30)
            return [allocator.allocate() for _ in range(PER_THREAD)]

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            taken = [future.result(60) for future in [pool.submit(take) for _ in range(self.threads)]]
        for part in taken:
            assert part == sorted(set(part))


def _entry(serial: int, *, at: datetime | None = None, client: str | None = None) -> TsaLogEntry:
    from datum_core.stores.tsa import TsaLogEntry  # noqa: PLC0415 - imported where it is used

    when = at or datetime(2026, 10, 20, 12, 0, tzinfo=UTC) + timedelta(seconds=serial)
    return TsaLogEntry(
        serial=serial, gen_time=when, imprint_algorithm="sha256", imprint=f"{serial:064x}", client=client
    )


class TsaLogContract:
    """The issue-log protocol: append, and read the newest first; nothing about keys or request bytes."""

    threads: ClassVar[int] = THREADS

    @pytest.fixture
    def log(self) -> Iterator[TsaLog]:
        """Yield a fresh, empty log (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `log` fixture")

    def test_an_empty_log_has_no_entries(self, log: TsaLog) -> None:
        assert log.recent(10) == ()

    def test_an_appended_entry_is_read_back_equal(self, log: TsaLog) -> None:
        entry = _entry(7, client="client-1")
        log.append(entry)
        assert log.recent(10) == (entry,)

    def test_entries_come_back_newest_first_and_the_limit_cuts_the_oldest(self, log: TsaLog) -> None:
        for serial in range(1, 6):
            log.append(_entry(serial))
        assert [item.serial for item in log.recent(10)] == [5, 4, 3, 2, 1]
        assert [item.serial for item in log.recent(2)] == [5, 4]

    def test_a_zero_limit_reads_nothing(self, log: TsaLog) -> None:
        log.append(_entry(1))
        assert log.recent(0) == ()

    def test_an_entry_without_a_client_keeps_none(self, log: TsaLog) -> None:
        log.append(_entry(3))
        assert log.recent(1)[0].client is None

    def test_the_log_holds_scalars_and_no_key_or_request_bytes(self, log: TsaLog) -> None:
        log.append(_entry(9, client="client-9"))
        (stored,) = log.recent(1)
        assert isinstance(stored.serial, int)
        assert isinstance(stored.imprint, str)
        assert stored.client == "client-9"
        assert "dtsa_" not in repr(stored)

    def test_threads_appending_together_lose_nothing(self, log: TsaLog) -> None:
        barrier = threading.Barrier(self.threads)

        def write(worker: int) -> None:
            barrier.wait(30)
            for number in range(PER_THREAD):
                log.append(_entry(worker * 1000 + number + 1))

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for future in [pool.submit(write, worker) for worker in range(self.threads)]:
                future.result(60)
        serials = {item.serial for item in log.recent(self.threads * PER_THREAD + 5)}
        assert len(serials) == self.threads * PER_THREAD


class TsaClientStoreContract:
    """The client protocol: a client is found by the SHA-256 of its key and answers a store id, never the key or hash.

    A binding supplies `store_factory(hashes, revoked=())`, a callable that returns a store knowing exactly the clients
    whose key hashes are given (those in `revoked` are revoked).
    """

    threads: ClassVar[int] = THREADS

    @pytest.fixture
    def store_factory(self) -> Iterator[Callable[..., TsaClientStore]]:
        """Yield the factory (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `store_factory` fixture")

    def test_a_known_key_hash_finds_its_client(self, store_factory: Callable[..., TsaClientStore]) -> None:
        store = store_factory([key_hash(key_text(1)), key_hash(key_text(2))])
        found = store.find(key_hash(key_text(1)))
        assert found is not None
        assert found.id
        assert found.revoked is False

    def test_an_unknown_key_hash_finds_nobody(self, store_factory: Callable[..., TsaClientStore]) -> None:
        store = store_factory([key_hash(key_text(1))])
        assert store.find(key_hash(key_text(99))) is None

    def test_an_empty_store_finds_nobody(self, store_factory: Callable[..., TsaClientStore]) -> None:
        assert store_factory([]).find(key_hash(key_text(1))) is None

    def test_the_client_id_is_stable_and_differs_between_clients(
        self, store_factory: Callable[..., TsaClientStore]
    ) -> None:
        first, second = key_hash(key_text(1)), key_hash(key_text(2))
        store = store_factory([first, second])
        a, b, again = store.find(first), store.find(second), store.find(first)
        assert a is not None
        assert b is not None
        assert again is not None
        assert a.id == again.id
        assert a.id != b.id

    def test_the_client_id_is_neither_the_key_nor_its_hash(self, store_factory: Callable[..., TsaClientStore]) -> None:
        text = key_text(1)
        hashed = key_hash(text)
        found = store_factory([hashed]).find(hashed)
        assert found is not None
        assert text not in found.id
        assert hashed not in found.id
        assert text not in repr(found)
        assert hashed not in repr(found)

    def test_a_revoked_client_is_found_and_says_so(self, store_factory: Callable[..., TsaClientStore]) -> None:
        live, dead = key_hash(key_text(1)), key_hash(key_text(2))
        store = store_factory([live, dead], revoked=[dead])
        found_dead, found_live = store.find(dead), store.find(live)
        assert found_dead is not None
        assert found_dead.revoked is True
        assert found_live is not None
        assert found_live.revoked is False

    def test_a_hash_that_is_not_hex_finds_nobody_and_does_not_raise(
        self, store_factory: Callable[..., TsaClientStore]
    ) -> None:
        store = store_factory([key_hash(key_text(1))])
        for odd in ("", "zz", "g" * 64, "0" * 63, "0" * 65):
            assert store.find(odd) is None

    def test_only_the_whole_presented_text_finds_a_client(self, store_factory: Callable[..., TsaClientStore]) -> None:
        text = key_text(1)
        store = store_factory([key_hash(text)])
        for other in (text[:-1], text + " ", " " + text, text.upper()):
            assert store.find(key_hash(other)) is None
        assert store.find(key_hash(text)) is not None
        assert store.find(key_hash(text).upper()) is not None

    def test_a_use_is_noted_without_changing_who_is_found(self, store_factory: Callable[..., TsaClientStore]) -> None:
        hashed = key_hash(key_text(1))
        store = store_factory([hashed])
        found = store.find(hashed)
        assert found is not None
        store.record_use(found.id, datetime(2026, 10, 20, 12, 0, tzinfo=UTC))
        again = store.find(hashed)
        assert again is not None
        assert again.id == found.id

    def test_threads_finding_and_noting_uses_together_all_succeed(
        self, store_factory: Callable[..., TsaClientStore]
    ) -> None:
        hashes: Sequence[str] = [key_hash(key_text(n)) for n in range(self.threads)]
        store = store_factory(hashes)
        barrier = threading.Barrier(self.threads)

        def work(number: int) -> str:
            barrier.wait(30)
            found = None
            for _ in range(PER_THREAD):
                found = store.find(hashes[number])
                assert found is not None
                store.record_use(found.id, datetime(2026, 10, 20, 12, 0, number, tzinfo=UTC))
            assert found is not None
            return found.id

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            ids = [future.result(60) for future in [pool.submit(work, n) for n in range(self.threads)]]
        assert len(set(ids)) == self.threads
