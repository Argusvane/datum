"""The builder under concurrent writers: safety is the repository's compare-and-set, the per-form lock only
serialises one process and is not held across the kernel's check.

One winner of N racing saves on one hash, one `Saved(created)` and N-1 `Exists` of a create race, the hash checked again
under the lock after the kernel ran outside it, a write that loses to another instance's answering `Outdated` with the
winner's hash, and a lock table that attacker-chosen keys cannot grow.
"""

import sys
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from typing import Any

import pytest
from builder_support import FORM, definition, started_builder

from datum_core.builder import (
    BuilderOutcome,
    CatalogOutdated,
    CatalogSaved,
    Exists,
    NotFound,
    Outdated,
    Saved,
    Unavailable,
)
from datum_core.events import FormDefinitionSavedEvent
from datum_core.stores import catalog_etag
from datum_core.stores.memory import MemoryFormDefinitionRepository, StoreFullError

THREADS = 8


@pytest.fixture(autouse=True)
def _frequent_thread_switches() -> Iterator[None]:
    previous = sys.getswitchinterval()
    sys.setswitchinterval(1e-6)
    try:
        yield
    finally:
        sys.setswitchinterval(previous)


def race(count: int, work: Any) -> list[BuilderOutcome]:
    """Run `work(index)` on `count` threads released together; return the outcomes in thread order."""
    gate = threading.Barrier(count)

    def run(index: int) -> BuilderOutcome:
        gate.wait(timeout=30)
        outcome: BuilderOutcome = work(index)
        return outcome

    with ThreadPoolExecutor(max_workers=count) as pool:
        return [future.result(timeout=60) for future in [pool.submit(run, i) for i in range(count)]]


# -- one winner --------------------------------------------------------------------------------------------------------
def test_two_saves_on_one_expected_hash_give_one_saved_and_one_outdated_naming_the_winner() -> None:
    with started_builder() as rig:
        first = rig.current_hash()
        outcomes = race(2, lambda i: rig.save(definition(version=f"v{i}"), expected=first))
        saved = [o for o in outcomes if isinstance(o, Saved)]
        outdated = [o for o in outcomes if isinstance(o, Outdated)]
        assert (len(saved), len(outdated)) == (1, 1)
        assert outdated[0].current_sha256 == saved[0].sha256 == rig.current_hash()


def test_of_eight_racing_saves_on_one_hash_exactly_one_is_saved_and_seven_read_the_winners_hash() -> None:
    with started_builder() as rig:
        for round_ in range(15):
            first = rig.current_hash()
            outcomes = race(
                THREADS,
                lambda i, first=first, round_=round_: rig.save(definition(version=f"{round_}-{i}"), expected=first),
            )
            saved = [o for o in outcomes if isinstance(o, Saved)]
            outdated = [o for o in outcomes if isinstance(o, Outdated)]
            assert (len(saved), len(outdated)) == (1, THREADS - 1), f"round {round_}"
            assert {o.current_sha256 for o in outdated} == {saved[0].sha256}
            assert rig.current_hash() == saved[0].sha256
        assert len(rig.events) == 15  # one event per winner, none for the losers


def test_of_eight_racing_creates_of_one_id_exactly_one_is_saved_created_and_seven_exist() -> None:
    with started_builder() as rig:
        for round_ in range(15):
            key = f"fresh{round_}"
            outcomes = race(THREADS, lambda i, key=key: rig.create(definition(key, f"v{i}")))
            saved = [o for o in outcomes if isinstance(o, Saved)]
            exists = [o for o in outcomes if isinstance(o, Exists)]
            assert (len(saved), len(exists)) == (1, THREADS - 1), f"round {round_}"
            assert saved[0].created is True
            assert {(o.key, o.current_sha256) for o in exists} == {(key, saved[0].sha256)}
            assert rig.current_hash(key) == saved[0].sha256
            mine = [e for e in rig.events if getattr(e, "key", None) == key]
            assert mine == [FormDefinitionSavedEvent(key, saved[0].sha256, None)], f"round {round_}"


def test_saves_as_sent_all_succeed_and_the_last_to_the_store_stands() -> None:
    with started_builder() as rig:
        outcomes = race(THREADS, lambda i: rig.save(definition(version=f"v{i}"), expected=None))
        assert all(isinstance(o, Saved) for o in outcomes)
        stored = rig.current_hash()
        assert stored in {o.sha256 for o in outcomes if isinstance(o, Saved)}


def test_saves_of_different_forms_never_block_or_lose_one_another() -> None:
    forms = [definition(f"f{n}") for n in range(THREADS)]
    with started_builder(seed=forms) as rig:
        outcomes = race(THREADS, lambda i: rig.save(definition(f"f{i}", "2"), key=f"f{i}"))
        assert all(isinstance(o, Saved) for o in outcomes)
        for n in range(THREADS):
            assert rig.stored(f"f{n}").definition["version"] == "2"


def test_of_eight_racing_catalog_writes_on_one_etag_exactly_one_is_saved_and_seven_read_the_winners_etag() -> None:
    with started_builder() as rig:
        outcomes = race(
            THREADS,
            lambda i: rig.service.save_translations(
                FORM, {"fr": {"form": {"title": f"w{i}"}}}, expected_etag=catalog_etag({}), principal=None
            ),
        )
        saved = [o for o in outcomes if isinstance(o, CatalogSaved)]
        outdated = [o for o in outcomes if isinstance(o, CatalogOutdated)]
        assert (len(saved), len(outdated)) == (1, THREADS - 1)
        assert {o.current_etag for o in outdated} == {saved[0].etag}
        assert rig.events == []


# -- the kernel is outside the lock, the hash is checked inside it -----------------------------------------------------
def test_the_kernel_runs_outside_the_lock_and_the_hash_is_checked_again_under_it() -> None:
    with started_builder() as rig:
        first = rig.current_hash()
        rig.sandbox.hold_first = threading.Event()
        slow: list[BuilderOutcome] = []
        thread = threading.Thread(target=lambda: slow.append(rig.save(definition(version="slow"), expected=first)))
        thread.start()
        try:
            assert rig.sandbox.entered.wait(10), "the first save never reached the kernel"
            quick: list[BuilderOutcome] = []
            other = threading.Thread(target=lambda: quick.append(rig.save(definition(version="quick"), expected=first)))
            other.start()
            other.join(10)
            assert not other.is_alive(), "a second save of the same form waited for the first one's kernel check"
            assert isinstance(quick[0], Saved)
        finally:
            rig.sandbox.hold_first.set()
            thread.join(30)
        assert isinstance(slow[0], Outdated)
        assert slow[0].current_sha256 == quick[0].sha256 == rig.current_hash()
        assert rig.stored().definition["version"] == "quick"


def test_a_save_of_another_form_is_not_held_up_by_a_kernel_check_in_flight() -> None:
    with started_builder(seed=[definition(), definition("claims", "1")]) as rig:
        rig.sandbox.hold_first = threading.Event()
        thread = threading.Thread(target=lambda: rig.save(definition(version="slow")))
        thread.start()
        try:
            assert rig.sandbox.entered.wait(10)
            other: list[BuilderOutcome] = []
            worker = threading.Thread(target=lambda: other.append(rig.save(definition("claims", "2"), key="claims")))
            worker.start()
            worker.join(10)
            assert isinstance(other[0], Saved)
        finally:
            rig.sandbox.hold_first.set()
            thread.join(30)


# -- another instance's write ------------------------------------------------------------------------------------------
def test_a_write_that_loses_to_another_instance_between_the_check_and_the_store_is_outdated_with_the_winners_hash() -> (
    None
):
    with started_builder() as rig:
        first = rig.current_hash()
        winner: dict[str, str] = {}

        def another_instance_saves() -> None:
            stored = rig.repository.inner.replace(FORM, definition(version="theirs"), first)
            assert stored is not None
            winner["sha"] = stored.sha256

        rig.repository.interfere = another_instance_saves
        outcome = rig.save(definition(version="mine"), expected=first)
        assert isinstance(outcome, Outdated)
        assert outcome.current_sha256 == winner["sha"] == rig.current_hash()
        assert rig.stored().definition["version"] == "theirs"
        assert rig.events == []
        assert "snapshots.record" not in rig.trail


def test_a_create_that_loses_to_another_instance_is_exists_with_the_winners_hash() -> None:
    with started_builder() as rig:
        winner: dict[str, str] = {}

        def another_instance_creates() -> None:
            stored = rig.repository.inner.create("fresh", definition("fresh", "theirs"))
            assert stored is not None
            winner["sha"] = stored.sha256

        rig.repository.interfere = another_instance_creates
        outcome = rig.create(definition("fresh", "mine"))
        assert outcome == Exists("fresh", winner["sha"])
        assert rig.events == []


def test_a_save_as_sent_never_overwrites_a_write_it_did_not_see() -> None:
    """No `If-Match` means the caller names no version, not that another instance's write may be lost."""
    with started_builder() as rig:
        first = rig.current_hash()
        winner: dict[str, str] = {}

        def another_instance_saves() -> None:
            stored = rig.repository.inner.replace(FORM, definition(version="theirs"), first)
            assert stored is not None
            winner["sha"] = stored.sha256

        rig.repository.interfere = another_instance_saves
        outcome = rig.save(definition(version="mine"), expected=None)
        assert isinstance(outcome, Outdated)
        assert outcome.current_sha256 == winner["sha"]
        assert rig.stored().definition["version"] == "theirs"


# -- the lock table ----------------------------------------------------------------------------------------------------
def test_the_lock_table_is_sixty_four_stripes_and_attacker_chosen_keys_cannot_grow_it() -> None:
    with started_builder() as rig:
        assert rig.service.lock_count == 64
        for n in range(300):
            assert isinstance(rig.create(definition(f"attacker-{n}")), Saved)
        for n in range(300):
            missing = rig.service.save(f"missing-{n}", definition(f"missing-{n}"), expected_sha256=None, principal=None)
            assert missing == NotFound(f"missing-{n}")
        assert rig.service.lock_count == 64


def test_the_lock_table_is_a_fixed_tuple_of_sixty_four_distinct_locks() -> None:
    with started_builder() as rig:
        table = vars(rig.service)["_locks"]
        assert isinstance(table, tuple)
        assert len(table) == 64
        assert len({id(lock) for lock in table}) == 64


def test_a_key_always_takes_the_same_stripe_so_two_saves_of_one_form_do_serialise() -> None:
    with started_builder() as rig:
        assert rig.service.stripe_of(FORM) == rig.service.stripe_of(FORM)
        stripes = {rig.service.stripe_of(f"form-{n}") for n in range(2000)}
        assert stripes <= set(range(64))
        assert len(stripes) > 32  # a spread, not one lock for every form


# -- the stores fail ---------------------------------------------------------------------------------------------------
def test_a_full_form_repository_makes_a_create_unavailable_and_publishes_nothing() -> None:
    repository = MemoryFormDefinitionRepository(seed=[definition()], max_entries=1)
    with started_builder(form_repository=repository) as rig:
        outcome = rig.service.create(definition("fresh"), principal=None, changes=None)
        assert isinstance(outcome, Unavailable)
        assert outcome.code == "server.unavailable"
        assert isinstance(outcome.cause, StoreFullError)
        assert rig.events == []
        assert repository.current("fresh") is None


def test_a_repository_that_raises_reaches_the_caller_as_raised_and_nothing_follows_the_failed_store() -> None:
    with started_builder() as rig:
        rig.repository.fail = OSError("the disk is full")
        with pytest.raises(OSError, match="disk"):
            rig.save(definition(version="2"))
        assert rig.stored().definition["version"] == "1"
        assert "snapshots.record" not in rig.trail
        assert rig.events == []
