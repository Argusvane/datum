"""The forms store contracts, written once.

`FormRepositoryContract`, `SnapshotStoreContract` and `TranslationStoreContract`.

No lock holds across instances, so a store owes the builder compare-and-set: `replace` succeeds only when the stored
hash is the one the caller read, `create` is atomic (one winner of any number of racers), and a translation catalog is
written against the ETag the caller read (the ETag of `{}` for a form with no catalog yet). The loser of a race is told
by a refusal (`None`) and reads the winner's hash with the read the store already has. A store copies what it is given
and what it hands out: a caller holds a value, never the store's own state.

A store's test module subclasses a contract and overrides the `store` fixture (and, when the store is bounded, sets
`bound` and overrides `bounded_store`):

    class TestMemoryRepository(FormRepositoryContract):
        bound = 5

        @pytest.fixture
        def store(self) -> Iterator[WritableFormDefinitionRepository]:
            yield MemoryFormDefinitionRepository()

        @pytest.fixture
        def bounded_store(self) -> Iterator[WritableFormDefinitionRepository]:
            yield MemoryFormDefinitionRepository(max_entries=5)

Any store, SQL included, can bind the same classes. The cases use only the protocols' methods; they never look inside a
store, so the contracts are store-neutral. `datum_core.stores.StoreFullError` is what a bounded store raises
when a new form does not fit.
"""

# ruff: noqa: S101 - a contract is assertions

import sys
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import TYPE_CHECKING, Any, ClassVar, cast

import pytest

from datum_core.canonical import canonical_digest
from datum_core.stores import StoredCatalog, StoreFullError, catalog_etag

if TYPE_CHECKING:
    from datum_core.forms import (  # noqa: TC004 - 3.14 defers hints
        DefinitionSnapshotStore,
        StoredDefinition,
        TranslationCatalogStore,
        WritableFormDefinitionRepository,
    )

__all__ = ["FormRepositoryContract", "SnapshotStoreContract", "TranslationStoreContract"]

HASH = "a" * 64
OTHER_HASH = "b" * 64
NEAR_HASH = "a" * 63 + "b"


def form(form_id: str = "contact", version: str = "1", *, label: str = "Name") -> dict[str, Any]:
    """Build a small definition whose label names its writer, so a test can tell whose a read returned."""
    return {
        "id": form_id,
        "version": version,
        "root": {
            "id": "form",
            "type": "form",
            "children": {"content": [{"id": "name", "type": "text", "configuration": {"label": label}}]},
        },
    }


class _Threaded:
    """The race harness shared by the three contracts."""

    threads: ClassVar[int] = 8
    """Writers in a race case (the contract fixes 8)."""
    rounds: ClassVar[int] = 100
    """Races run one after another, each on a fresh key, so a check-then-write between two statements is hit."""
    bound: ClassVar[int | None] = None
    """Set by a bounded store's test class; the bounded cases skip without it."""

    @pytest.fixture(autouse=True)
    def _frequent_thread_switches(self) -> Iterator[None]:
        """Switch threads every microsecond, so a check-then-write between two statements is hit, not hoped for."""
        previous = sys.getswitchinterval()
        sys.setswitchinterval(1e-6)
        try:
            yield
        finally:
            sys.setswitchinterval(previous)

    def _need_bound(self) -> int:
        if self.bound is None:
            pytest.skip("the store is not bounded: the class sets no `bound`")
        return self.bound


_BAD_KEYS = ("not a key", "contact@2", "k" * 129)


class FormRepositoryContract(_Threaded):
    """The write protocol of a `WritableFormDefinitionRepository`: `create` and compare-and-set `replace`."""

    @pytest.fixture
    def store(self) -> Iterator[WritableFormDefinitionRepository]:
        """Yield a fresh, empty repository (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `store` fixture")

    @pytest.fixture
    def bounded_store(self) -> Iterator[WritableFormDefinitionRepository]:
        """Yield a fresh, empty repository holding at most `bound` forms (override when the store is bounded)."""
        raise NotImplementedError("a bounded store overrides the `bounded_store` fixture")

    # -- one writer ------------------------------------------------------------------------------------------------
    def test_a_key_nobody_created_is_not_found(self, store: WritableFormDefinitionRepository) -> None:
        """`current` answers `None` for a form never created."""
        assert store.current("contact") is None

    @pytest.mark.parametrize("bad", _BAD_KEYS)
    def test_a_key_outside_the_form_key_grammar_is_refused_by_create_and_replace(
        self, store: WritableFormDefinitionRepository, bad: str
    ) -> None:
        """A key outside the form-key grammar (an `@`, over 128 characters) is a `ValueError`; nothing is stored."""
        with pytest.raises(ValueError, match="form key"):
            store.create(bad, form(label="one"))
        with pytest.raises(ValueError, match="form key"):
            store.replace(bad, form(label="one"), None)
        assert store.current(bad) is None

    @pytest.mark.parametrize("bad", _BAD_KEYS)
    def test_a_bad_key_is_refused_before_a_full_store_is_consulted(
        self, bounded_store: WritableFormDefinitionRepository, bad: str
    ) -> None:
        """On a full bounded store a bad key is a `ValueError`, not a `StoreFullError`."""
        for n in range(self._need_bound()):
            bounded_store.create(f"f{n}", form(f"f{n}"))
        with pytest.raises(ValueError, match="form key"):
            bounded_store.create(bad, form(label="one"))

    def test_create_stores_the_form_under_the_canonical_hash_of_what_was_given(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """`create` returns the stored version; its hash is the canonical digest and `current` agrees."""
        given = form(label="one")
        stored = store.create("contact", given)
        assert stored is not None
        assert (stored.key, stored.sha256) == ("contact", canonical_digest(given))
        assert dict(stored.definition) == given
        again = store.current("contact")
        assert again is not None
        assert (again.sha256, dict(again.definition)) == (stored.sha256, given)

    def test_creating_a_key_that_exists_is_refused_and_leaves_the_stored_form(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """A second `create` answers `None` and the first form stands untouched."""
        first = store.create("contact", form(label="first"))
        assert first is not None
        assert store.create("contact", form(label="second")) is None
        kept = store.current("contact")
        assert kept is not None
        assert (kept.sha256, dict(kept.definition)) == (first.sha256, form(label="first"))

    def test_replace_with_the_stored_hash_swaps_the_definition_and_answers_the_new_hash(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """The expected hash held: the new version is stored and returned, under its own canonical hash."""
        first = store.create("contact", form(label="first"))
        assert first is not None
        second = store.replace("contact", form("contact", "2", label="second"), first.sha256)
        assert second is not None
        assert second.sha256 == canonical_digest(form("contact", "2", label="second"))
        assert second.sha256 != first.sha256
        now = store.current("contact")
        assert now is not None
        assert now.sha256 == second.sha256

    def test_replace_with_a_stale_hash_is_refused_and_the_winner_stands(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """A hash that is no longer the stored one answers `None`; the caller reads the current hash with `current`."""
        first = store.create("contact", form(label="first"))
        assert first is not None
        winner = store.replace("contact", form("contact", "2", label="winner"), first.sha256)
        assert winner is not None
        assert store.replace("contact", form("contact", "3", label="late"), first.sha256) is None
        now = store.current("contact")
        assert now is not None
        assert (now.sha256, dict(now.definition)) == (winner.sha256, form("contact", "2", label="winner"))

    @pytest.mark.parametrize("expected", [OTHER_HASH, NEAR_HASH, "", "A" * 64], ids=["other", "near", "empty", "case"])
    def test_a_hash_that_is_not_exactly_the_stored_one_never_passes(
        self, store: WritableFormDefinitionRepository, expected: str
    ) -> None:
        """Not a prefix, not another case: the comparison is the whole hash."""
        first = store.create("contact", form(label="first"))
        assert first is not None
        assert store.replace("contact", form(label="other"), expected) is None
        kept = store.current("contact")
        assert kept is not None
        assert kept.sha256 == first.sha256

    def test_replace_without_an_expected_hash_swaps_an_existing_form_as_sent(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """`expected_sha256=None` is an unconditional replace of a form that exists."""
        assert store.create("contact", form(label="first")) is not None
        swapped = store.replace("contact", form("contact", "2", label="second"), None)
        assert swapped is not None
        now = store.current("contact")
        assert now is not None
        assert now.sha256 == swapped.sha256

    @pytest.mark.parametrize("expected", [None, HASH], ids=["unconditional", "with a hash"])
    def test_replace_never_creates_a_form(self, store: WritableFormDefinitionRepository, expected: str | None) -> None:
        """A key nobody created is refused whatever hash is expected, and still does not exist."""
        assert store.replace("contact", form(), expected) is None
        assert store.current("contact") is None

    def test_forms_are_told_apart_by_key(self, store: WritableFormDefinitionRepository) -> None:
        """Replacing one form leaves another alone; ("contact", "11") and ("contact1", "1") are not mixed up."""
        a = store.create("contact", form("contact", "11", label="a"))
        b = store.create("contact1", form("contact1", "1", label="b"))
        assert a is not None
        assert b is not None
        assert store.replace("contact", form("contact", "12", label="a2"), a.sha256) is not None
        kept = store.current("contact1")
        assert kept is not None
        assert kept.sha256 == b.sha256

    def test_a_definition_is_copied_in_so_a_caller_cannot_change_the_stored_form_afterwards(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """Changing the dictionary after `create` or `replace` returned does not change what is stored."""
        given = form(label="first")
        stored = store.create("contact", given)
        assert stored is not None
        given["root"]["children"]["content"][0]["configuration"]["label"] = "changed behind the store's back"
        now = store.current("contact")
        assert now is not None
        assert dict(now.definition) == form(label="first")
        assert canonical_digest(dict(now.definition)) == now.sha256
        replaced = form("contact", "2", label="second")
        assert store.replace("contact", replaced, stored.sha256) is not None
        replaced["version"] = "tampered"
        after = store.current("contact")
        assert after is not None
        assert dict(after.definition) == form("contact", "2", label="second")

    def test_a_definition_is_copied_out_so_a_reader_cannot_change_the_stored_form(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """Changing what `create`, `replace` or `current` returned does not change what is stored."""
        stored = store.create("contact", form(label="first"))
        assert stored is not None
        cast("dict[str, Any]", stored.definition)["version"] = "tampered by the writer's copy"
        read = store.current("contact")
        assert read is not None
        cast("dict[str, Any]", read.definition)["root"]["children"]["content"].clear()
        again = store.current("contact")
        assert again is not None
        assert dict(again.definition) == form(label="first")
        assert canonical_digest(dict(again.definition)) == again.sha256

    # -- the races -------------------------------------------------------------------------------------------------
    def test_of_eight_racing_replaces_on_one_hash_exactly_one_wins_and_the_losers_read_its_hash(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """8 writers released together on one expected hash, 100 times: one wins, seven are refused, none is lost."""
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for round_ in range(self.rounds):
                key = f"race-{round_}"
                first = store.create(key, form(key, "0"))
                assert first is not None
                gate = threading.Barrier(self.threads)

                def replace(
                    index: int, key: str = key, expected: str = first.sha256, gate: threading.Barrier = gate
                ) -> StoredDefinition | None:
                    gate.wait(timeout=30)
                    return store.replace(key, form(key, f"v{index}"), expected)

                answers = [f.result(timeout=60) for f in [pool.submit(replace, i) for i in range(self.threads)]]
                won = [answer for answer in answers if answer is not None]
                assert len(won) == 1, f"round {round_}: {len(won)} replaces passed on one expected hash"
                standing = store.current(key)
                assert standing is not None
                assert standing.sha256 == won[0].sha256, "the losers read the winner's hash"
                assert str(dict(standing.definition)["version"]).startswith("v")

    def test_of_eight_racing_creates_of_one_key_exactly_one_stores_and_seven_are_refused(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """8 creators released together on one key, 100 times: one stored form, seven `None`, the winner stands."""
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for round_ in range(self.rounds):
                key = f"made-{round_}"
                gate = threading.Barrier(self.threads)

                def create(index: int, key: str = key, gate: threading.Barrier = gate) -> StoredDefinition | None:
                    gate.wait(timeout=30)
                    return store.create(key, form(key, f"v{index}"))

                answers = [f.result(timeout=60) for f in [pool.submit(create, i) for i in range(self.threads)]]
                won = [answer for answer in answers if answer is not None]
                assert len(won) == 1, f"round {round_}: {len(won)} creates of one key passed"
                standing = store.current(key)
                assert standing is not None
                assert standing.sha256 == won[0].sha256

    def test_eight_threads_on_distinct_keys_lose_no_form(self, store: WritableFormDefinitionRepository) -> None:
        """Writers on different keys never collide: each creates and replaces its own forms."""
        gate = threading.Barrier(self.threads)

        def work(index: int) -> None:
            gate.wait(timeout=30)
            for round_ in range(10):
                key = f"k{index}-{round_}"
                created = store.create(key, form(key, "1"))
                assert created is not None
                assert store.replace(key, form(key, "2"), created.sha256) is not None

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for future in [pool.submit(work, i) for i in range(self.threads)]:
                future.result(timeout=60)
        for index in range(self.threads):
            for round_ in range(10):
                key = f"k{index}-{round_}"
                found = store.current(key)
                assert found is not None
                assert dict(found.definition)["version"] == "2"

    def test_a_reader_never_sees_a_torn_form_while_a_writer_replaces_it(
        self, store: WritableFormDefinitionRepository
    ) -> None:
        """While one thread replaces, readers see a whole version whose hash is its canonical digest."""
        first = store.create("contact", form("contact", "0"))
        assert first is not None
        stop = threading.Event()
        torn: list[str] = []

        def read() -> None:
            while not stop.is_set():
                found = store.current("contact")
                if found is None or canonical_digest(dict(found.definition)) != found.sha256:
                    torn.append("torn" if found is not None else "missing")

        reader = threading.Thread(target=read)
        reader.start()
        try:
            expected = first.sha256
            for number in range(1, 40):
                stored = store.replace("contact", form("contact", str(number)), expected)
                assert stored is not None
                expected = stored.sha256
        finally:
            stop.set()
            reader.join(timeout=30)
        assert torn == []

    # -- a bounded store -------------------------------------------------------------------------------------------
    def test_a_full_store_refuses_a_new_form_and_keeps_every_form_it_holds(
        self, bounded_store: WritableFormDefinitionRepository
    ) -> None:
        """Nothing is evicted: past the bound a `create` raises `StoreFullError` and every held form is still there."""
        bound = self._need_bound()
        held = {f"f{n}": bounded_store.create(f"f{n}", form(f"f{n}")) for n in range(bound)}
        assert all(stored is not None for stored in held.values())
        for extra in range(bound):
            with pytest.raises(StoreFullError):
                bounded_store.create(f"overflow{extra}", form(f"overflow{extra}"))
        for key, stored in held.items():
            found = bounded_store.current(key)
            assert found is not None
            assert stored is not None
            assert found.sha256 == stored.sha256
        assert bounded_store.current("overflow0") is None

    def test_a_full_store_still_replaces_the_forms_it_holds(
        self, bounded_store: WritableFormDefinitionRepository
    ) -> None:
        """Full means no new form, not no change: a held form is replaced with its hash."""
        bound = self._need_bound()
        created = [bounded_store.create(f"f{n}", form(f"f{n}", "1")) for n in range(bound)]
        first = created[0]
        assert first is not None
        swapped = bounded_store.replace("f0", form("f0", "2"), first.sha256)
        assert swapped is not None

    def test_a_refused_create_of_a_key_that_exists_is_not_a_full_store_error(
        self, bounded_store: WritableFormDefinitionRepository
    ) -> None:
        """A full store answers `None` for a key it holds (a conflict) and raises only for a key it would add."""
        bound = self._need_bound()
        for n in range(bound):
            assert bounded_store.create(f"f{n}", form(f"f{n}")) is not None
        assert bounded_store.create("f0", form("f0", label="again")) is None

    @pytest.mark.parametrize("round_", range(100))
    def test_of_eight_racing_creates_for_the_last_slot_exactly_one_stores_and_seven_find_the_store_full(
        self, bounded_store: WritableFormDefinitionRepository, round_: int
    ) -> None:
        """A fresh store with one slot left, 8 creators of distinct new keys released together, 100 rounds: one wins."""
        bound = self._need_bound()
        held = {f"h{n}": bounded_store.create(f"h{n}", form(f"h{n}")) for n in range(bound - 1)}
        gate = threading.Barrier(self.threads)

        def add(index: int) -> bool:
            gate.wait(timeout=30)
            key = f"new{index}"
            try:
                return bounded_store.create(key, form(key)) is not None
            except StoreFullError:
                return False

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            answers = [f.result(timeout=60) for f in [pool.submit(add, i) for i in range(self.threads)]]
        assert answers.count(True) == 1, f"round {round_}: {answers.count(True)} creates took the last slot"
        assert sum(bounded_store.current(f"new{i}") is not None for i in range(self.threads)) == 1
        for key, stored in held.items():
            found = bounded_store.current(key)
            assert found is not None
            assert stored is not None
            assert found.sha256 == stored.sha256


class SnapshotStoreContract(_Threaded):
    """The protocol of a `DefinitionSnapshotStore`: older versions by (form key, hash)."""

    @pytest.fixture
    def store(self) -> Iterator[DefinitionSnapshotStore]:
        """Yield a fresh, empty store (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `store` fixture")

    @pytest.fixture
    def bounded_store(self) -> Iterator[DefinitionSnapshotStore]:
        """Yield a fresh, empty store keeping at most `bound` snapshots (override when the store is bounded)."""
        raise NotImplementedError("a bounded store overrides the `bounded_store` fixture")

    def test_a_snapshot_nobody_recorded_is_not_found(self, store: DefinitionSnapshotStore) -> None:
        """`find` answers `None` for a (form, hash) never recorded."""
        assert store.find("contact", HASH) is None

    def test_a_recorded_snapshot_is_found_by_its_form_and_hash(self, store: DefinitionSnapshotStore) -> None:
        """`record` keeps the definition; `find` answers an equal one."""
        store.record("contact", HASH, form(label="one"))
        assert store.find("contact", HASH) == form(label="one")

    def test_recording_a_held_snapshot_again_changes_nothing(self, store: DefinitionSnapshotStore) -> None:
        """A second `record` of the same (form, hash) is not an error and keeps one snapshot."""
        store.record("contact", HASH, form(label="one"))
        store.record("contact", HASH, form(label="one"))
        assert store.find("contact", HASH) == form(label="one")

    @pytest.mark.parametrize(
        ("other_form", "other_hash"),
        [("claims", HASH), ("contact", OTHER_HASH), ("contact", NEAR_HASH), ("contact", "b" + "a" * 63)],
        ids=["another form", "another hash", "a hash one character apart", "a hash differing first"],
    )
    def test_the_key_is_the_form_and_the_whole_hash(
        self, store: DefinitionSnapshotStore, other_form: str, other_hash: str
    ) -> None:
        """A snapshot never answers another form or another hash."""
        store.record("contact", HASH, form(label="one"))
        assert store.find(other_form, other_hash) is None

    def test_a_definition_is_copied_in_and_out(self, store: DefinitionSnapshotStore) -> None:
        """Changing the dictionary given to `record`, or the one `find` returned, changes no snapshot."""
        given = form(label="one")
        store.record("contact", HASH, given)
        given["root"]["children"]["content"].clear()
        found = store.find("contact", HASH)
        assert found == form(label="one")
        assert found is not None
        cast("dict[str, Any]", found)["id"] = "tampered"
        assert store.find("contact", HASH) == form(label="one")

    def test_eight_threads_recording_one_snapshot_leave_one_whole_snapshot(
        self, store: DefinitionSnapshotStore
    ) -> None:
        """8 writers released together on one (form, hash), 100 times: the snapshot is found whole every time."""
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for round_ in range(self.rounds):
                digest = f"{round_:064x}"
                gate = threading.Barrier(self.threads)

                def record(_: int, digest: str = digest, gate: threading.Barrier = gate) -> None:
                    gate.wait(timeout=30)
                    store.record("contact", digest, form(label="same"))

                for future in [pool.submit(record, i) for i in range(self.threads)]:
                    future.result(timeout=60)
                assert store.find("contact", digest) == form(label="same")

    def test_eight_threads_on_distinct_snapshots_lose_none(self, store: DefinitionSnapshotStore) -> None:
        """Writers on different keys keep every snapshot they record."""
        gate = threading.Barrier(self.threads)

        def work(index: int) -> None:
            gate.wait(timeout=30)
            for number in range(10):
                store.record(f"f{index}", f"{number:064x}", form(f"f{index}", str(number)))

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for future in [pool.submit(work, i) for i in range(self.threads)]:
                future.result(timeout=60)
        for index in range(self.threads):
            for number in range(10):
                assert store.find(f"f{index}", f"{number:064x}") == form(f"f{index}", str(number))

    def test_a_bounded_store_holds_at_most_its_bound_and_keeps_the_newest(
        self, bounded_store: DefinitionSnapshotStore
    ) -> None:
        """Past the bound the oldest snapshots go (a miss falls back to the current version) and the newest stay."""
        bound = self._need_bound()
        total = bound * 3
        for number in range(total):
            bounded_store.record("contact", f"{number:064x}", form("contact", str(number)))
        held = [number for number in range(total) if bounded_store.find("contact", f"{number:064x}") is not None]
        assert len(held) <= bound
        assert (total - 1) in held


class TranslationStoreContract(_Threaded):
    """The protocol of a `TranslationCatalogStore`: read, and a write against the ETag the caller read."""

    @pytest.fixture
    def store(self) -> Iterator[TranslationCatalogStore]:
        """Yield a fresh, empty store (override in the binding)."""
        raise NotImplementedError("bind the contract: override the `store` fixture")

    @pytest.fixture
    def bounded_store(self) -> Iterator[TranslationCatalogStore]:
        """Yield a fresh, empty store holding catalogs for at most `bound` forms (override when it is bounded)."""
        raise NotImplementedError("a bounded store overrides the `bounded_store` fixture")

    @staticmethod
    def catalog(text: str = "Name") -> dict[str, Any]:
        """Build a one-text catalog whose French text names its writer."""
        return {"fr": {"components": {"name": {"label": text}}}, "en": {"components": {"name": {"label": "Name"}}}}

    def test_a_form_with_no_catalog_reads_none(self, store: TranslationCatalogStore) -> None:
        """`read` answers `None` for a form nobody wrote a catalog for."""
        assert store.read("contact") is None

    @pytest.mark.parametrize("bad", _BAD_KEYS)
    def test_a_key_outside_the_form_key_grammar_is_refused_by_write(
        self, store: TranslationCatalogStore, bad: str
    ) -> None:
        """A key outside the form-key grammar (an `@`, over 128 characters) is a `ValueError`; nothing is stored."""
        with pytest.raises(ValueError, match="form key"):
            store.write(bad, self.catalog("un"), expected_etag=catalog_etag({}))
        assert store.read(bad) is None

    @pytest.mark.parametrize("bad", _BAD_KEYS)
    def test_a_bad_key_is_refused_before_the_etag_is_compared(self, store: TranslationCatalogStore, bad: str) -> None:
        """A stale expected ETag does not turn a bad key into a lost race (`None`): it is a `ValueError`."""
        with pytest.raises(ValueError, match="form key"):
            store.write(bad, self.catalog("un"), expected_etag='"stale"')

    @pytest.mark.parametrize("bad", _BAD_KEYS)
    def test_a_bad_key_is_refused_before_a_full_store_is_consulted(
        self, bounded_store: TranslationCatalogStore, bad: str
    ) -> None:
        """On a full bounded store a bad key is a `ValueError`, not a `StoreFullError`."""
        for n in range(self._need_bound()):
            bounded_store.write(f"f{n}", self.catalog(str(n)), expected_etag=catalog_etag({}))
        with pytest.raises(ValueError, match="form key"):
            bounded_store.write(bad, self.catalog("un"), expected_etag=catalog_etag({}))

    def test_the_first_write_is_judged_against_the_etag_of_the_empty_catalog(
        self, store: TranslationCatalogStore
    ) -> None:
        """A form with no catalog reads as `{}`: the first write names the ETag of `{}` and is stored under its own."""
        written = store.write("contact", self.catalog("un"), expected_etag=catalog_etag({}))
        assert written is not None
        assert written.catalog == self.catalog("un")
        assert written.etag == catalog_etag(self.catalog("un"))
        read = store.read("contact")
        assert read is not None
        assert (read.catalog, read.etag) == (written.catalog, written.etag)

    def test_a_first_write_against_any_other_etag_is_refused_and_stores_nothing(
        self, store: TranslationCatalogStore
    ) -> None:
        """Only the ETag of `{}` passes for a form with no catalog."""
        assert store.write("contact", self.catalog(), expected_etag=catalog_etag(self.catalog("else"))) is None
        assert store.write("contact", self.catalog(), expected_etag='"' + "0" * 64 + '"') is None
        assert store.read("contact") is None

    def test_a_write_against_the_stored_etag_replaces_the_catalog(self, store: TranslationCatalogStore) -> None:
        """The expected ETag held: the new catalog is stored and answered with its own ETag."""
        first = store.write("contact", self.catalog("un"), expected_etag=catalog_etag({}))
        assert first is not None
        second = store.write("contact", self.catalog("deux"), expected_etag=first.etag)
        assert second is not None
        assert second.etag == catalog_etag(self.catalog("deux"))
        read = store.read("contact")
        assert read is not None
        assert read.catalog == self.catalog("deux")

    def test_a_write_against_a_stale_etag_is_refused_and_the_winner_stands(
        self, store: TranslationCatalogStore
    ) -> None:
        """A stale ETag answers `None`; the caller reads the winner's ETag with `read`."""
        first = store.write("contact", self.catalog("un"), expected_etag=catalog_etag({}))
        assert first is not None
        winner = store.write("contact", self.catalog("deux"), expected_etag=first.etag)
        assert winner is not None
        assert store.write("contact", self.catalog("trois"), expected_etag=first.etag) is None
        read = store.read("contact")
        assert read is not None
        assert (read.catalog, read.etag) == (self.catalog("deux"), winner.etag)

    def test_catalogs_are_kept_per_form(self, store: TranslationCatalogStore) -> None:
        """Writing one form's catalog leaves another's alone."""
        assert store.write("a", self.catalog("un"), expected_etag=catalog_etag({})) is not None
        assert store.write("b", self.catalog("deux"), expected_etag=catalog_etag({})) is not None
        a, b = store.read("a"), store.read("b")
        assert a is not None
        assert b is not None
        assert (a.catalog, b.catalog) == (self.catalog("un"), self.catalog("deux"))

    def test_a_catalog_is_copied_in_and_out(self, store: TranslationCatalogStore) -> None:
        """Changing the dictionary given to `write`, or the ones `write` and `read` returned, changes nothing stored."""
        given = self.catalog("un")
        written = store.write("contact", given, expected_etag=catalog_etag({}))
        assert written is not None
        given["fr"]["components"]["name"]["label"] = "tampered"
        cast("dict[str, Any]", written.catalog)["fr"]["components"]["name"]["label"] = "tampered too"
        read = store.read("contact")
        assert read is not None
        cast("dict[str, Any]", read.catalog)["fr"]["components"]["name"].clear()
        again = store.read("contact")
        assert again is not None
        assert again.catalog == self.catalog("un")
        assert again.etag == catalog_etag(self.catalog("un"))

    def test_of_eight_racing_writes_on_one_etag_exactly_one_wins_and_the_losers_read_its_etag(
        self, store: TranslationCatalogStore
    ) -> None:
        """8 writers released together on one expected ETag, 100 times: one wins, seven are refused, none is lost."""
        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            for round_ in range(self.rounds):
                key = f"race-{round_}"
                gate = threading.Barrier(self.threads)

                def write(index: int, key: str = key, gate: threading.Barrier = gate) -> StoredCatalog | None:
                    gate.wait(timeout=30)
                    return store.write(key, self.catalog(f"w{index}"), expected_etag=catalog_etag({}))

                answers = [f.result(timeout=60) for f in [pool.submit(write, i) for i in range(self.threads)]]
                won = [answer for answer in answers if answer is not None]
                assert len(won) == 1, f"round {round_}: {len(won)} writes passed on one expected ETag"
                read = store.read(key)
                assert read is not None
                assert read.etag == won[0].etag, "the losers read the winner's ETag"

    def test_a_full_store_refuses_a_catalog_for_a_new_form_and_keeps_every_catalog_it_holds(
        self, bounded_store: TranslationCatalogStore
    ) -> None:
        """Nothing is dropped: past the bound a write for a new form raises `StoreFullError`, held catalogs stay."""
        bound = self._need_bound()
        held = {
            f"f{n}": bounded_store.write(f"f{n}", self.catalog(str(n)), expected_etag=catalog_etag({}))
            for n in range(bound)
        }
        for extra in range(bound):
            with pytest.raises(StoreFullError):
                bounded_store.write(f"overflow{extra}", self.catalog(), expected_etag=catalog_etag({}))
        for key, written in held.items():
            read = bounded_store.read(key)
            assert read is not None
            assert written is not None
            assert read.etag == written.etag
        assert bounded_store.read("overflow0") is None

    def test_a_full_store_still_rewrites_the_catalogs_it_holds(self, bounded_store: TranslationCatalogStore) -> None:
        """Full means no new form, not no change: a held form's catalog is written against its ETag."""
        bound = self._need_bound()
        first = bounded_store.write("f0", self.catalog("un"), expected_etag=catalog_etag({}))
        assert first is not None
        for n in range(1, bound):
            assert bounded_store.write(f"f{n}", self.catalog(), expected_etag=catalog_etag({})) is not None
        assert bounded_store.write("f0", self.catalog("deux"), expected_etag=first.etag) is not None

    @pytest.mark.parametrize("round_", range(100))
    def test_of_eight_racing_writes_for_the_last_slot_exactly_one_stores_and_seven_find_the_store_full(
        self, bounded_store: TranslationCatalogStore, round_: int
    ) -> None:
        """A fresh store with one slot left, 8 writers of distinct new forms released together, 100 rounds: one wins."""
        bound = self._need_bound()
        held = {
            f"h{n}": bounded_store.write(f"h{n}", self.catalog(str(n)), expected_etag=catalog_etag({}))
            for n in range(bound - 1)
        }
        gate = threading.Barrier(self.threads)

        def add(index: int) -> bool:
            gate.wait(timeout=30)
            try:
                written = bounded_store.write(f"new{index}", self.catalog(), expected_etag=catalog_etag({}))
            except StoreFullError:
                return False
            return written is not None

        with ThreadPoolExecutor(max_workers=self.threads) as pool:
            answers = [f.result(timeout=60) for f in [pool.submit(add, i) for i in range(self.threads)]]
        assert answers.count(True) == 1, f"round {round_}: {answers.count(True)} writes took the last slot"
        assert sum(bounded_store.read(f"new{i}") is not None for i in range(self.threads)) == 1
        for key, written in held.items():
            read = bounded_store.read(key)
            assert read is not None
            assert written is not None
            assert read.etag == written.etag
