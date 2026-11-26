"""The five submission events. Every one carries `channel`; none crosses the wire.

Each is published by `SubmissionService` on the thread that runs the call, inside the call (so a binding's drain waits
for it), after the step it reports. Datum opens no transaction: inside an application's, an event precedes its
commit. A listener cannot veto anything: whatever it does, the answer and the effect stand (guarded delivery). A dry
run publishes none.
"""

from dataclasses import dataclass

from datum_core.config.models import ThrottleKind
from datum_core.events import DatumEvent
from datum_core.submissions._model import AcceptedSubmission, SubmissionError, SubmissionReceipt
from datum_core.throttle import ThrottleKey

__all__ = [
    "JourneyCheckedEvent",
    "SubmissionRedeliveredEvent",
    "SubmissionRejectedEvent",
    "SubmissionThrottledEvent",
    "SubmissionValidatedEvent",
]


@dataclass(frozen=True, slots=True)
class SubmissionValidatedEvent(DatumEvent):
    """Published after the handler answered and the idempotency store was told (the last step of a delivery).

    A handler that raised publishes none. `receipt` is the one the store kept.
    """

    submission: AcceptedSubmission
    receipt: SubmissionReceipt
    channel: str


@dataclass(frozen=True, slots=True)
class SubmissionRejectedEvent(DatumEvent):
    """Published when a delivery is refused at `stage` (`journey`, `sandbox`, `validators`): the 422 refusals."""

    form_key: str
    errors: tuple[SubmissionError, ...]
    stage: str
    remote_address: str | None
    channel: str


@dataclass(frozen=True, slots=True)
class JourneyCheckedEvent(DatumEvent):
    """Published after every `validate` check that reached a verdict.

    `journey.unknown` and `journey.required` are verdicts too; a refusal before the verdict publishes none.
    """

    form_key: str
    journey_id: str | None
    page_id: str | None
    accepted: bool
    channel: str


@dataclass(frozen=True, slots=True)
class SubmissionThrottledEvent(DatumEvent):
    """Published when the throttle refuses a call (the 429); `key` is the completed key it was counted under."""

    key: ThrottleKey
    kind: ThrottleKind
    retry_after: int
    channel: str


@dataclass(frozen=True, slots=True)
class SubmissionRedeliveredEvent(DatumEvent):
    """Published when a delivery is answered with the first receipt of the same (form, version, digest)."""

    form_key: str
    digest: str
    receipt: SubmissionReceipt
    channel: str
