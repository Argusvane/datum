"""The submission events: their fields, when they are published, guarded delivery, order, sync and async."""

import asyncio
import dataclasses
import logging
import threading
import time
from typing import Any, cast

import pytest
from submissions_support import (
    FORM,
    Rig,
    ThreadLoopAwaiter,
    attr_of,
    bus,
    envelope,
    http_context,
    journey_check,
    refused_by_kernel,
    started,
    wrapped,
)

from datum_core.events import DatumEvent, listener
from datum_core.hooks import HookFindings, HookProblem
from datum_core.loggers import EVENTS
from datum_core.submissions import (
    Accepted,
    FormRef,
    JourneyCheckedEvent,
    Reject,
    SubmissionRedeliveredEvent,
    SubmissionRejectedEvent,
    SubmissionThrottledEvent,
    SubmissionValidatedEvent,
)
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import ProgramUnavailableError

FIELDS: dict[type[DatumEvent], list[str]] = {
    SubmissionValidatedEvent: ["submission", "receipt", "channel"],
    SubmissionRejectedEvent: ["form_key", "errors", "stage", "remote_address", "channel"],
    JourneyCheckedEvent: ["form_key", "journey_id", "page_id", "accepted", "channel"],
    SubmissionThrottledEvent: ["key", "kind", "retry_after", "channel"],
    SubmissionRedeliveredEvent: ["form_key", "digest", "receipt", "channel"],
}


@pytest.mark.parametrize("event", FIELDS, ids=[e.__name__ for e in FIELDS])
def test_each_event_is_a_frozen_slotted_datum_event_with_the_documented_fields(event: type[DatumEvent]) -> None:
    assert issubclass(event, DatumEvent)
    assert event.__dataclass_params__.frozen  # type: ignore[attr-defined]
    assert hasattr(event, "__slots__")
    assert [f.name for f in dataclasses.fields(cast("Any", event))] == FIELDS[event]
    assert "channel" in FIELDS[event]


def kinds(rig: Rig) -> list[str]:
    return [type(event).__name__ for event in rig.events]


def test_an_accepted_submission_publishes_one_validated_event_with_the_receipt_and_the_channel() -> None:
    with started() as rig:
        outcome = rig.submit(envelope(), http_context())
    assert isinstance(outcome, Accepted)
    (event,) = rig.events
    assert isinstance(event, SubmissionValidatedEvent)
    assert event.receipt == outcome.receipt
    assert event.submission == outcome.submission
    assert event.channel == "http"


def test_a_redelivery_publishes_the_redelivered_event_with_the_first_receipt() -> None:
    with started() as rig:
        first = rig.submit(envelope(), http_context(submission_key="attempt-1"))
        rig.events.clear()
        rig.submit(envelope(), bus(submission_key="attempt-1"))
    (event,) = rig.events
    assert isinstance(event, SubmissionRedeliveredEvent)
    assert isinstance(first, Accepted)
    assert (event.form_key, event.digest, event.receipt, event.channel) == (
        FORM,
        first.submission.digest,
        first.receipt,
        "bus",
    )


def test_a_kernel_refusal_publishes_the_rejected_event_with_stage_and_address() -> None:
    with started() as rig:
        rig.sandbox.verdict = refused_by_kernel("required", "name")
        rig.submit(envelope(values={"name": ""}), http_context(ip="198.51.100.4"))
    (event,) = rig.events
    assert isinstance(event, SubmissionRejectedEvent)
    assert (event.form_key, event.stage, event.remote_address, event.channel) == (
        FORM,
        "sandbox",
        "198.51.100.4",
        "http",
    )
    assert {(field, code) for field, code, _ in event.errors} == {("name", "required")}


def test_a_throttled_request_publishes_the_throttled_event() -> None:
    with started() as rig:
        rig.throttle.deny = 12
        rig.submit(envelope(), http_context())
    (event,) = rig.events
    assert isinstance(event, SubmissionThrottledEvent)
    assert (event.retry_after, event.channel) == (12, "http")
    assert str(event.kind) == "submit"


def test_a_journey_check_publishes_the_checked_event() -> None:
    with started() as rig:
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
    (event,) = rig.events
    assert isinstance(event, JourneyCheckedEvent)
    assert (event.form_key, event.accepted, event.channel) == (FORM, True, "bus")


@pytest.mark.parametrize(
    "arrange",
    [
        pytest.param(lambda rig: rig.submit(["not", "an", "object"]), id="malformed"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        pytest.param(lambda rig: rig.submit(envelope(form="missing")), id="not found"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        pytest.param(lambda rig: rig.submit(envelope(version="0")), id="outdated"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        pytest.param(lambda rig: rig.service.test(FormRef.from_document(), wrapped(envelope()), bus()), id="dry run"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
    ],
)
def test_a_refusal_before_the_verdict_and_a_dry_run_publish_no_submission_event(arrange: Any) -> None:
    with started() as rig:
        arrange(rig)
    assert rig.events == []


def test_a_dry_run_refused_by_the_kernel_publishes_no_submission_event() -> None:
    with started() as rig:
        rig.sandbox.verdict = refused_by_kernel()
        outcome = rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
    assert attr_of(outcome, "accepted") is False
    assert rig.events == []


def test_a_dry_run_refused_by_a_validator_publishes_no_submission_event() -> None:
    def refuse(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem(None, "validator.no", "No"),))

    with started(validators=[refuse]) as rig:
        outcome = rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
    assert attr_of(outcome, "accepted") is False
    assert rig.events == []


def test_a_throttled_validate_publishes_the_throttled_event_with_kind_validate() -> None:
    with started() as rig:
        rig.throttle.deny = 5
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), http_context())
    (event,) = rig.events
    assert isinstance(event, SubmissionThrottledEvent)
    assert str(event.kind) == "validate"


def test_a_pre_check_refusal_and_an_unavailable_runtime_publish_no_submission_event() -> None:
    with started(pre_checks=[lambda incoming: Reject("closed", "Closed")]) as rig:  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        rig.submit()
    assert rig.events == []
    with started() as rig:
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit()
    assert rig.events == []


# -- guarded delivery --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("error", [RuntimeError("x"), AssertionError("a"), RecursionError("r"), ValueError("v")])
def test_a_raising_listener_between_two_recorders_is_logged_and_changes_neither_answer_nor_effect(
    error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[str] = []

    def explode(event: SubmissionValidatedEvent) -> None:
        raise error

    listeners = [
        listener(SubmissionValidatedEvent, lambda event: seen.append("before")),
        listener(SubmissionValidatedEvent, explode),
        listener(SubmissionValidatedEvent, lambda event: seen.append("after")),
    ]
    with caplog.at_level(logging.ERROR, logger=EVENTS), started(listeners=listeners) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Accepted)
    assert seen == ["before", "after"]
    assert len(rig.handler.calls) == 1
    assert [r.name for r in caplog.records if r.levelno == logging.ERROR] == [EVENTS]
    assert caplog.records[-1].exc_info is not None


@pytest.mark.parametrize("error", [MemoryError(), KeyboardInterrupt(), SystemExit(3), asyncio.CancelledError()])
def test_memory_errors_cancellation_and_exits_in_a_listener_propagate_to_the_caller(error: BaseException) -> None:
    def explode(event: SubmissionValidatedEvent) -> None:
        raise error

    with started(listeners=[listener(SubmissionValidatedEvent, explode)]) as rig, pytest.raises(type(error)):
        rig.submit()


def test_a_raising_listener_on_a_redelivery_or_a_rejection_changes_no_answer() -> None:
    def explode(event: DatumEvent) -> None:
        raise RuntimeError("listener broke")

    with started(listeners=[(DatumEvent, explode)]) as rig:
        rig.sandbox.verdict = refused_by_kernel()
        rejected = rig.submit(envelope(values={"name": ""}))
        rig.sandbox.verdict = None
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        again = rig.submit(envelope(), bus(submission_key="attempt-1"))
    assert type(rejected).__name__ == "Rejected"
    assert type(first).__name__ == "Accepted"
    assert type(again).__name__ == "Redelivered"


# -- order and subclasses ----------------------------------------------------------------------------------------------
def test_delivery_is_in_list_order_and_finished_before_the_service_returns() -> None:
    order: list[str] = []

    def slow(event: SubmissionValidatedEvent) -> None:
        time.sleep(0.05)
        order.append("slow")

    listeners = [
        listener(SubmissionValidatedEvent, slow),
        listener(DatumEvent, lambda event: order.append("base")),
        listener(SubmissionValidatedEvent, lambda event: order.append("last")),
    ]
    with started(listeners=listeners) as rig:
        order.clear()  # the start's own ready event reached the base listener
        rig.submit()
        assert order == ["slow", "base", "last"]


def test_a_listener_on_the_base_class_sees_every_submission_event_of_a_mixed_run() -> None:
    with started() as rig:
        rig.throttle.deny = 5
        rig.submit(envelope(), http_context(submission_key="attempt-1"))
        rig.throttle.deny = None
        rig.submit(envelope(), bus(submission_key="attempt-1"))
        rig.submit(envelope(), bus(submission_key="attempt-1"))
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": ""}))
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
    assert kinds(rig) == [
        "SubmissionThrottledEvent",
        "SubmissionValidatedEvent",
        "SubmissionRedeliveredEvent",
        "SubmissionRejectedEvent",
        "JourneyCheckedEvent",
    ]


# -- sync and async listeners ------------------------------------------------------------------------------------------
def test_a_sync_listener_runs_inline_on_the_calling_thread() -> None:
    threads: list[int] = []
    with started(
        listeners=[listener(SubmissionValidatedEvent, lambda event: threads.append(threading.get_ident()))]
    ) as rig:
        rig.submit()
    assert threads == [threading.get_ident()]


def test_an_async_listener_runs_through_the_awaiter_and_has_finished_when_the_service_returns() -> None:
    ran: list[tuple[str, int]] = []

    async def audit(event: SubmissionValidatedEvent) -> None:
        await asyncio.sleep(0.01)
        ran.append((event.channel, threading.get_ident()))

    awaiter = ThreadLoopAwaiter()
    try:
        with started(listeners=[listener(SubmissionValidatedEvent, audit)], awaiter=awaiter) as rig:
            rig.submit()
            assert len(ran) == 1
    finally:
        awaiter.close()
    assert ran[0][0] == "bus"
    assert ran[0][1] != threading.get_ident()


def test_an_async_listener_with_no_awaiter_stops_the_start() -> None:
    async def audit(event: SubmissionValidatedEvent) -> None: ...

    with pytest.raises(DatumConfigurationError), started(listeners=[listener(SubmissionValidatedEvent, audit)]):
        pass


def test_a_call_the_stop_abandons_in_the_handler_publishes_no_validated_event() -> None:
    release = threading.Event()
    entered = threading.Event()
    answers: list[Any] = []

    def hold() -> None:
        entered.set()
        release.wait(10)

    with started() as rig:
        rig.handler.hold = hold
        caller = threading.Thread(target=lambda: answers.append(rig.submit()))
        caller.start()
        assert entered.wait(10)
        rig.datum.stop()
        release.set()
        caller.join(10)
    assert not caller.is_alive()
    assert len(rig.handler.calls) == 1
    assert not [e for e in rig.events if isinstance(e, SubmissionValidatedEvent)]
