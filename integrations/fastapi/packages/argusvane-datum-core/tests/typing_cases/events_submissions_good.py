from typing import assert_never

from datum_core.events import DatumEvent, listener
from datum_core.hooks import HookFindings
from datum_core.submissions import (
    Accepted,
    AcceptedSubmission,
    Allow,
    Checked,
    DryRun,
    IncomingSubmission,
    KeyConflict,
    Malformed,
    NotFound,
    Outdated,
    PreCheckDecision,
    Redelivered,
    Refused,
    Reject,
    Rejected,
    SubmissionContext,
    SubmissionHandler,
    SubmissionOutcome,
    SubmissionPreCheck,
    SubmissionReceipt,
    SubmissionRedeliveredEvent,
    SubmissionRejectedEvent,
    SubmissionThrottledEvent,
    SubmissionValidatedEvent,
    SubmissionValidator,
    Throttled,
    TooLarge,
    Unavailable,
    ValidatedSubmission,
)


def on_validated(event: SubmissionValidatedEvent) -> None: ...


async def on_throttled(event: SubmissionThrottledEvent) -> None: ...


def on_rejected(event: SubmissionRejectedEvent) -> None: ...


def on_redelivered(event: SubmissionRedeliveredEvent) -> None: ...


def on_anything(event: DatumEvent) -> None: ...


listener(SubmissionValidatedEvent, on_validated)
listener(SubmissionThrottledEvent, on_throttled)
listener(SubmissionRejectedEvent, on_rejected)
listener(SubmissionRedeliveredEvent, on_redelivered)
listener(SubmissionValidatedEvent, on_anything)  # a listener typed for the base accepts a subclass event
listener(DatumEvent, on_anything)
listener(SubmissionValidatedEvent, lambda event: None)


def handler(accepted: AcceptedSubmission) -> SubmissionReceipt:
    return SubmissionReceipt(id="1", reference="R")


async def async_handler(accepted: AcceptedSubmission) -> SubmissionReceipt:
    return SubmissionReceipt(id="1", reference="R")


h1: SubmissionHandler = handler
h2: SubmissionHandler = async_handler


def pre_check(incoming: IncomingSubmission) -> PreCheckDecision:
    return Allow()


async def async_pre_check(incoming: IncomingSubmission) -> PreCheckDecision:
    return Reject("code", "message")


p1: SubmissionPreCheck = pre_check
p2: SubmissionPreCheck = async_pre_check


def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
    return None


async def async_validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
    return None


v1: SubmissionValidator = validator
v2: SubmissionValidator = async_validator


def decide(decision: PreCheckDecision) -> str:
    match decision:
        case Allow():
            return "allow"
        case Reject():
            return "reject"
        case _ as unreachable:
            assert_never(unreachable)


def label(outcome: SubmissionOutcome) -> str:
    match outcome:
        case Accepted() | Redelivered():
            return "receipt"
        case Rejected() | Checked() | DryRun():
            return "verdict"
        case Outdated() | NotFound() | Malformed() | TooLarge() | Refused() | Throttled() | Unavailable():
            return "refusal"
        case KeyConflict():
            return "conflict"
        case _ as unreachable:
            assert_never(unreachable)
