"""The builder's event: `FormDefinitionSavedEvent(key, sha256, previous_sha256)`.

Published after the store (and the snapshot and the catalog move) and before the call returns, never after a refusal,
never for a catalog write, never carrying a definition. A listener that raises changes no answer.
"""

import contextlib
import dataclasses
import logging
import threading
from typing import Any

import pytest
from builder_support import FORM, MARKER, Rig, definition, finding, started_builder, validator, verdict, with_awaiter

from datum_core.builder import Saved
from datum_core.events import DatumEvent, FormDefinitionSavedEvent, listener
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.loggers import EVENTS
from datum_core.stores import catalog_etag
from datum_sandbox.protocol import ProgramUnavailableError


# -- the record --------------------------------------------------------------------------------------------------------
def test_the_event_is_a_frozen_slotted_datum_event_of_three_scalars() -> None:
    assert issubclass(FormDefinitionSavedEvent, DatumEvent)
    assert tuple(f.name for f in dataclasses.fields(FormDefinitionSavedEvent)) == ("key", "sha256", "previous_sha256")
    assert "__slots__" in vars(FormDefinitionSavedEvent)
    event = FormDefinitionSavedEvent("contact", "a" * 64, None)
    with pytest.raises(dataclasses.FrozenInstanceError):
        setattr(event, "key", "other")  # noqa: B010 - the assignment is the point


def test_the_event_is_published_after_the_lock_is_released_so_a_listener_may_save() -> None:
    holder: list[Rig] = []
    inner: list[object] = []
    fired: list[object] = []

    def on_saved(event: FormDefinitionSavedEvent) -> None:
        if fired:
            return
        fired.append(event)
        inner.append(holder[0].service.save(FORM, definition(version="3"), expected_sha256=None, principal=None))

    outer: list[object] = []
    with started_builder(listeners=[listener(FormDefinitionSavedEvent, on_saved)]) as rig:
        holder.append(rig)
        worker = threading.Thread(target=lambda: outer.append(rig.save(definition(version="2"))), daemon=True)
        worker.start()
        worker.join(10)
        assert not worker.is_alive()
    assert len(outer) == 1
    assert isinstance(outer[0], Saved)
    assert len(inner) == 1
    assert isinstance(inner[0], Saved)


# -- publication -------------------------------------------------------------------------------------------------------
def test_a_save_publishes_one_event_naming_the_new_hash_and_the_one_it_replaced() -> None:
    with started_builder() as rig:
        before = rig.current_hash()
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert rig.events == [FormDefinitionSavedEvent(FORM, outcome.sha256, before)]


def test_a_create_publishes_one_event_with_no_previous_hash() -> None:
    with started_builder() as rig:
        outcome = rig.create(definition("fresh"))
        assert isinstance(outcome, Saved)
        assert rig.events == [FormDefinitionSavedEvent("fresh", outcome.sha256, None)]


def test_the_event_is_published_after_the_store_and_the_snapshot_so_a_listener_reads_the_saved_state() -> None:
    read: list[tuple[str, str | None, bool]] = []
    holder: list[Rig] = []

    def on_saved(event: FormDefinitionSavedEvent) -> None:
        rig = holder[0]
        current = rig.repository.inner.current(event.key)
        assert current is not None
        snapshot = rig.snapshots.find(event.key, event.sha256)
        read.append((current.sha256, event.previous_sha256, snapshot is not None))

    with started_builder(listeners=[listener(FormDefinitionSavedEvent, on_saved)]) as rig:
        holder.append(rig)
        before = rig.current_hash()
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
    assert read == [(outcome.sha256, before, True)]


def test_the_previous_version_is_recorded_so_a_browser_holding_it_can_still_ask_by_hash() -> None:
    with started_builder() as rig:
        first = rig.stored()
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert rig.snapshots.find(FORM, first.sha256) == dict(first.definition)
        assert rig.snapshots.find(FORM, outcome.sha256) == dict(rig.stored().definition)


def test_the_call_returns_only_after_the_listeners_finished() -> None:
    finished: list[str] = []

    def slow(event: FormDefinitionSavedEvent) -> None:
        finished.append(event.key)

    with started_builder(listeners=[listener(FormDefinitionSavedEvent, slow)]) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        assert finished == [FORM]


def test_listeners_are_called_in_list_order_and_a_base_class_listener_sees_the_event() -> None:
    order: list[str] = []
    listeners = [
        listener(FormDefinitionSavedEvent, lambda event: order.append("first")),
        listener(DatumEvent, lambda event: order.append(f"base:{type(event).__name__}")),
        listener(FormDefinitionSavedEvent, lambda event: order.append("last")),
    ]
    with started_builder(listeners=listeners) as rig:
        order.clear()  # the start published its own ready event
        assert isinstance(rig.save(definition(version="2")), Saved)
    assert order == ["first", "base:FormDefinitionSavedEvent", "last"]


def test_an_async_listener_runs_through_the_awaiter() -> None:
    seen: list[str] = []
    awaiter = with_awaiter()

    async def on_saved(event: FormDefinitionSavedEvent) -> None:
        seen.append(event.key)

    try:
        with started_builder(awaiter=awaiter, listeners=[listener(FormDefinitionSavedEvent, on_saved)]) as rig:
            assert isinstance(rig.save(definition(version="2")), Saved)
    finally:
        awaiter.close()
    assert seen == [FORM]


# -- no event without a store ------------------------------------------------------------------------------------------
def _outdated(rig: Any) -> Any:
    return rig.save(definition(version="2"), expected="0" * 64)


def _not_found(rig: Any) -> Any:
    return rig.service.save("nope", definition("nope"), expected_sha256=None, principal=None)


def _exists(rig: Any) -> Any:
    return rig.create(definition(FORM))


def _malformed(rig: Any) -> Any:
    return rig.save(definition(label="\ud800"))


def _shape(rig: Any) -> Any:
    return rig.save(definition("other"))


def _kernel(rig: Any) -> Any:
    rig.sandbox.answer = verdict(problems=[finding("pattern.risky")])
    return rig.save(definition(version="2"))


def _unavailable(rig: Any) -> Any:
    rig.sandbox.error = ProgramUnavailableError("down")
    return rig.save(definition(version="2"))


@pytest.mark.parametrize(
    "refuse",
    [_outdated, _not_found, _exists, _malformed, _shape, _kernel, _unavailable],
    ids=lambda f: f.__name__.strip("_"),
)
def test_a_refused_write_publishes_no_event(refuse: Any) -> None:
    with started_builder() as rig:
        refuse(rig)
        assert rig.events == []
        assert not any(step.startswith("event:") for step in rig.trail)


def test_a_hook_that_refuses_or_raises_publishes_no_event() -> None:
    refusal = HookRefusedError.invalid("bad", "Bad.")
    errors = HookFindings(errors=(HookProblem(None, "bad", "Bad."),))
    cases: list[dict[str, Any]] = [
        {"builder_save_validators": [validator("a", [], refuse=refusal)]},
        {"builder_save_validators": [validator("a", [], findings=errors)]},
        {"builder_save_validators": [validator("a", [], fail=RuntimeError("boom"))]},
    ]
    for hooks in cases:
        with started_builder(**hooks) as rig:
            with contextlib.suppress(RuntimeError):
                rig.save(definition(version="2"))
            assert rig.events == []


def test_a_catalog_write_publishes_no_event() -> None:
    with started_builder() as rig:
        rig.service.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=None
        )
        assert rig.events == []


def test_the_builder_publishes_no_submission_event_and_runs_no_submission_handler() -> None:
    handled: list[object] = []
    with started_builder(handler=handled.append) as rig:
        rig.save(definition(version="2"))
        rig.create(definition("fresh"))
        assert {type(event).__name__ for event in rig.events} == {"FormDefinitionSavedEvent"}
    assert handled == []


# -- a listener cannot change the answer -------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "error", [Exception("x"), AssertionError("x"), RecursionError("x")], ids=lambda e: type(e).__name__
)
def test_a_raising_listener_between_two_recorders_changes_no_answer_and_is_logged_at_error(
    error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[str] = []

    def boom(event: FormDefinitionSavedEvent) -> None:
        raise error

    listeners = [
        listener(FormDefinitionSavedEvent, lambda event: seen.append("before")),
        listener(FormDefinitionSavedEvent, boom),
        listener(FormDefinitionSavedEvent, lambda event: seen.append("after")),
    ]
    with started_builder(listeners=listeners) as rig, caplog.at_level(logging.ERROR, logger=EVENTS):
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert rig.current_hash() == outcome.sha256
    assert seen == ["before", "after"]
    assert [r for r in caplog.records if r.name == EVENTS and r.levelno == logging.ERROR]


def test_a_memory_error_in_a_listener_propagates_and_the_store_stands() -> None:
    def boom(event: FormDefinitionSavedEvent) -> None:
        raise MemoryError

    with started_builder(listeners=[listener(FormDefinitionSavedEvent, boom)]) as rig:
        with pytest.raises(MemoryError):
            rig.save(definition(version="2"))
        assert rig.stored().definition["version"] == "2"


# -- an event is data, not a definition --------------------------------------------------------------------------------
def test_the_event_carries_no_definition_text_and_no_server_secret() -> None:
    with started_builder(seed=[definition(secret=True)]) as rig:
        outcome = rig.save(definition(secret=True, version="2", label="A private title"))
        assert isinstance(outcome, Saved)
        (event,) = rig.events
        assert MARKER not in repr(event)
        assert "A private title" not in repr(event)
        assert {type(getattr(event, f.name)) for f in dataclasses.fields(event)} <= {str, type(None)}


def test_a_snapshot_failure_of_the_stores_own_does_not_stop_the_event() -> None:
    from datum_core.forms import SnapshotNotRecordedError  # noqa: PLC0415

    with started_builder() as rig:
        rig.snapshots.fail = SnapshotNotRecordedError("the table is gone")
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert outcome.warnings
        assert [type(event).__name__ for event in rig.events] == ["FormDefinitionSavedEvent"]


def test_a_failure_on_the_previous_version_does_not_skip_recording_the_new_one() -> None:
    class FailsFirst:
        def __init__(self) -> None:
            self.recorded: list[str] = []
            self.calls = 0

        def record(self, key: str, sha256: str, definition: object) -> None:
            self.calls += 1
            if self.calls == 1:
                raise RuntimeError(MARKER)
            self.recorded.append(sha256)

    with started_builder() as rig:
        spy = FailsFirst()
        rig.snapshots.inner = spy  # type: ignore[assignment]
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert len(outcome.warnings) == 1
        assert spy.calls == 2
        assert spy.recorded == [outcome.sha256]
        assert len(rig.events) == 1


class _SpyLock:
    """A lock that says whether it is held right now."""

    def __init__(self) -> None:
        self.inner = threading.Lock()
        self.held = False

    def __enter__(self) -> bool:
        self.inner.acquire()
        self.held = True
        return True

    def __exit__(self, *exc: object) -> None:
        self.held = False
        self.inner.release()


def test_the_catalog_move_and_the_snapshots_run_under_the_stripe_lock_and_the_event_after_its_release() -> None:
    from datum_core.builder import LocaleChanges  # noqa: PLC0415

    spy = _SpyLock()
    seen: dict[str, bool] = {}

    def on_saved(event: FormDefinitionSavedEvent) -> None:
        seen["event"] = spy.held

    with started_builder(listeners=[listener(FormDefinitionSavedEvent, on_saved)]) as rig:
        rig.service.save_translations(
            FORM,
            {"fr": {"form": {"title": "un"}}, "en": {"form": {"title": "one"}}},
            expected_etag=catalog_etag({}),
            principal=None,
        )
        stripe = rig.service.stripe_of(FORM)
        locks = list(vars(rig.service)["_locks"])
        locks[stripe] = spy
        vars(rig.service)["_locks"] = tuple(locks)
        write, record = rig.translations.write, rig.snapshots.record

        def spied_write(*args: Any, **kwargs: Any) -> Any:
            seen["move"] = spy.held
            return write(*args, **kwargs)

        def spied_record(*args: Any, **kwargs: Any) -> None:
            seen["snapshots"] = spy.held
            record(*args, **kwargs)

        rig.translations.write = spied_write  # type: ignore[method-assign]
        rig.snapshots.record = spied_record  # type: ignore[method-assign]
        outcome = rig.save(definition(version="2"), changes=LocaleChanges(removed=("fr",)))
        assert isinstance(outcome, Saved)
        assert seen["move"] is True
        assert seen["snapshots"] is True
        assert seen == {"move": True, "snapshots": True, "event": False}
        assert spy.held is False


def test_saved_at_is_read_right_after_the_store_not_after_the_listeners_ran() -> None:
    from datetime import UTC, datetime, timedelta  # noqa: PLC0415

    clock = [datetime(2026, 10, 21, 9, 30, 0, tzinfo=UTC)]
    began = clock[0]

    def slow(event: FormDefinitionSavedEvent) -> None:
        clock[0] += timedelta(hours=1)

    spy = _SpyLock()
    held: list[bool] = []

    def now() -> datetime:
        held.append(spy.held)
        return clock[0]

    with started_builder(listeners=[listener(FormDefinitionSavedEvent, slow)], now=now) as rig:
        stripe = rig.service.stripe_of(FORM)
        locks = list(vars(rig.service)["_locks"])
        locks[stripe] = spy
        vars(rig.service)["_locks"] = tuple(locks)
        held.clear()
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert outcome.saved_at == began
        assert held[-1] is True
