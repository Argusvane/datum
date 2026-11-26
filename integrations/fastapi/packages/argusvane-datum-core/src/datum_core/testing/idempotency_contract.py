"""`IdempotencyStoreContract`: the protocol every `SubmissionIdempotencyStore` keeps, written once.

The store is asked before the handler and told after it, with no lock between (none holds across instances), so two
deliveries in flight may both reach the handler. What the store owes is the idempotent insert: the
FIRST writer of a (form, version, submission key) wins and every later writer reads the winner's receipt, under any
number of threads. The key is exactly (form key, version, submission key): nothing narrower, so one form's receipt
never answers another.

A store's test module subclasses the contract and overrides the `store` fixture:

    class TestMemoryStore(IdempotencyStoreContract):
        @pytest.fixture
        def store(self) -> Iterator[SubmissionIdempotencyStore]:
            yield MemorySubmissionIdempotencyStore(1000)

Any store, SQL included, can bind the same class. The cases use only
`find` and `record`; they never look inside a store, so the contract is store-neutral.
"""

# ruff: noqa: S101 - a contract is assertions

import hashlib
import sys
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, ClassVar

import pytest

if TYPE_CHECKING:
    from datum_core.submissions import RememberedReceipt, SubmissionIdempotencyStore  # noqa: TC004 - 3.14 defers hints
    from datum_sandbox.json import JsonValue

__all__ = ["IdempotencyStoreContract"]

KEY = "a" * 64
OTHER_KEY = "b" * 64
NEAR_KEY = "a" * 63 + "b"


def receipt(name: str) -> RememberedReceipt:
    """Build an entry (a digest and a receipt) that names its writer, so a test can tell whose entry a read returned."""
    # Imported here so that `datum_core.testing` (which exports this module) loads without the submissions package.
    from datum_core import submissions  # noqa: PLC0415

    payload: dict[str, JsonValue] = {"writer": name, "items": [name, 1, 2.5, True, None], "nested": {"k": "é"}}
    kept = submissions.SubmissionReceipt(id=f"id-{name}", reference=f"REF-{name}", receipt=payload)
    return submissions.RememberedReceipt(digest=hashlib.sha256(name.encode()).hexdigest(), receipt=kept)


class IdempotencyStoreContract:
    """The cases of the idempotency protocol; a store's test class subclasses it and supplies the `store` fixture."""

    threads: ClassVar[int] = 8
    """Writers in the race case (the contract fixes 8)."""

    @pytest.fixture
    def store(self) -> Iterator[SubmissionIdempotencyStore]:
        """Yield a fresh, empty store (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `store` fixture")

    # -- the protocol, one writer ------------------------------------------------------------------------------------
    def test_a_key_nobody_recorded_is_not_found(self, store: SubmissionIdempotencyStore) -> None:
        """`find` answers `None` for a (form, version, submission key) never recorded."""
        assert store.find("contact", "1", KEY) is None

    def test_a_recorded_receipt_is_found_by_its_key(self, store: SubmissionIdempotencyStore) -> None:
        """`record` stores the receipt and returns it; `find` answers an equal receipt afterwards."""
        stored = store.record("contact", "1", KEY, receipt("one"))
        assert stored == receipt("one")
        assert store.find("contact", "1", KEY) == receipt("one")

    def test_the_first_writer_wins_and_the_second_reads_the_winners_receipt(
        self, store: SubmissionIdempotencyStore
    ) -> None:
        """A duplicate `record` keeps the first receipt and returns it, never its own (no overwrite, no error)."""
        first = store.record("contact", "1", KEY, receipt("first"))
        second = store.record("contact", "1", KEY, receipt("second"))
        assert first == receipt("first")
        assert second == receipt("first")
        assert store.find("contact", "1", KEY) == receipt("first")

    @pytest.mark.parametrize(
        ("other_form", "other_version", "other_key"),
        [
            ("claims", "1", KEY),
            ("contact", "2", KEY),
            ("contact", "1", OTHER_KEY),
            ("contact", "1", NEAR_KEY),
            ("contact", "1", "b" + "a" * 63),
        ],
        ids=[
            "another form",
            "another version",
            "another submission key",
            "a key one character apart",
            "a key differing first",
        ],
    )
    def test_the_key_is_form_version_and_digest_and_nothing_narrower(
        self, store: SubmissionIdempotencyStore, other_form: str, other_version: str, other_key: str
    ) -> None:
        """A receipt never answers a different form, a different version or a different key."""
        store.record("contact", "1", KEY, receipt("original"))
        assert store.find(other_form, other_version, other_key) is None
        written = store.record(other_form, other_version, other_key, receipt("other"))
        assert written == receipt("other")
        assert store.find("contact", "1", KEY) == receipt("original")

    def test_form_and_version_are_separate_parts_of_the_key(self, store: SubmissionIdempotencyStore) -> None:
        """("contact", "11") and ("contact1", "1") are different keys, whatever the store's key encoding."""
        store.record("contact", "11", KEY, receipt("a"))
        assert store.find("contact1", "1", KEY) is None
        assert store.record("contact1", "1", KEY, receipt("b")) == receipt("b")
        assert store.find("contact", "11", KEY) == receipt("a")

    def test_a_find_without_a_record_leaves_nothing_behind(self, store: SubmissionIdempotencyStore) -> None:
        """Asking never claims a key: a handler that fails after `find` leaves no receipt."""
        assert store.find("contact", "1", KEY) is None
        assert store.find("contact", "1", KEY) is None
        assert store.record("contact", "1", KEY, receipt("later")) == receipt("later")

    @pytest.fixture(autouse=True)
    def _frequent_thread_switches(self) -> Iterator[None]:
        """Switch threads every microsecond, so a check-then-write between two statements is hit, not hoped for."""
        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        try:
            yield
        finally:
            sys.setswitchinterval(previous)

    # -- the race ----------------------------------------------------------------------------------------------------
    rounds: ClassVar[int] = 25
    """Races run one after another, each on a fresh key, so a store that checks and then writes is caught by chance."""

    def test_eight_threads_recording_one_key_all_read_the_one_winners_receipt(
        self, store: SubmissionIdempotencyStore
    ) -> None:
        """8 writers released together on one key, 25 times: one receipt stands, every `record` returns it."""
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for round_ in range(self.rounds):
                gate = threading.Barrier(self.threads)
                key = f"{round_:064x}"

                def write(index: int, gate: threading.Barrier = gate, key: str = key) -> RememberedReceipt:
                    gate.wait(timeout=30)
                    return store.record("contact", "1", key, receipt(str(index)))

                answers = [future.result(timeout=60) for future in [pool.submit(write, i) for i in range(self.threads)]]
                winner = store.find("contact", "1", key)
                assert winner is not None
                assert winner in [receipt(str(i)) for i in range(self.threads)]
                assert answers == [winner] * self.threads, f"round {round_}: the writers did not agree on one winner"

    def test_eight_threads_on_distinct_keys_lose_no_receipt(self, store: SubmissionIdempotencyStore) -> None:
        """8 writers on 8 different digests each keep their own receipt (no collision, no lost update)."""
        gate = threading.Barrier(self.threads)

        def write(index: int) -> None:
            gate.wait(timeout=30)
            for round_ in range(10):
                key = f"{index:02x}{round_:02x}".ljust(64, "0")
                assert store.record("contact", "1", key, receipt(f"{index}-{round_}")) == receipt(f"{index}-{round_}")

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for future in [pool.submit(write, i) for i in range(self.threads)]:
                future.result(timeout=60)
        for index in range(self.threads):
            for round_ in range(10):
                key = f"{index:02x}{round_:02x}".ljust(64, "0")
                assert store.find("contact", "1", key) == receipt(f"{index}-{round_}")

    def test_readers_and_a_writer_never_see_a_torn_receipt(self, store: SubmissionIdempotencyStore) -> None:
        """While one thread records, readers see `None` or the whole receipt, never a part of one."""
        stop = threading.Event()
        seen: list[RememberedReceipt | None] = []

        def read() -> None:
            while not stop.is_set():
                seen.append(store.find("contact", "1", KEY))

        reader = threading.Thread(target=read)
        reader.start()
        try:
            store.record("contact", "1", KEY, receipt("whole"))
        finally:
            stop.set()
            reader.join(timeout=30)
        assert all(item in (None, receipt("whole")) for item in seen)
