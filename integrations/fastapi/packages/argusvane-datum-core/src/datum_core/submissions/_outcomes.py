"""The sealed `SubmissionOutcome` and the inspect call's own outcome.

Each variant is a frozen, slotted dataclass that holds no header and no status: `datum_core.http` maps them, and a
service caller closes them with `match` and `typing.assert_never`. What a hook raises is not an outcome: it reaches
the caller as raised.
"""

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Final

from datum_core.hooks import HookProblem
from datum_core.submissions._hooks import Reject
from datum_core.submissions._model import AcceptedSubmission, SubmissionError, SubmissionNote, SubmissionReceipt
from datum_core.throttle import ThrottleKey
from datum_sandbox.json import JsonValue

__all__ = [
    "Accepted",
    "Checked",
    "DryRun",
    "InspectOutcome",
    "Inspected",
    "KeyConflict",
    "Malformed",
    "NotFound",
    "Outdated",
    "PdfCheckOutcome",
    "PdfChecked",
    "Redelivered",
    "Refused",
    "Rejected",
    "SubmissionOutcome",
    "Throttled",
    "TooLarge",
    "Unavailable",
]


@dataclass(frozen=True, slots=True)
class Accepted:
    """The handler took the submission; `receipt` is the one the idempotency store kept (the first writer's)."""

    receipt: SubmissionReceipt
    submission: AcceptedSubmission
    warnings: tuple[HookProblem, ...]


@dataclass(frozen=True, slots=True)
class Redelivered:
    """The same submit attempt (form, version, submission key) was accepted before with the same digest.

    Its first receipt, and no handler call.
    """

    receipt: SubmissionReceipt
    digest: str


@dataclass(frozen=True, slots=True)
class KeyConflict:
    """The submission key was accepted before with another document: refused, never answered with the first receipt.

    `digest` is the digest of the document this delivery carried. A new submit attempt carries a new key.
    """

    digest: str


@dataclass(frozen=True, slots=True)
class Rejected:
    """The answers were refused at `stage` (`journey`, `sandbox` or `validators`): the errors, in order."""

    errors: tuple[SubmissionError, ...]
    stage: str


@dataclass(frozen=True, slots=True)
class Checked:
    """A `validate` verdict: nothing was kept. `page_id` names the page of a page check.

    `notes` are the kernel's warning and info items and the validators' warnings, for the person authoring or testing
    the form.
    """

    accepted: bool
    errors: tuple[SubmissionError, ...]
    journey_id: str | None
    page_id: str | None
    notes: tuple[SubmissionNote, ...] = ()


REPORT_ID_LISTS: Final = ("clientDerived", "clockDependent", "serverRules", "visibilitySkipped")
"""The outcome's component-id lists a dry run reports (what the run judged and skipped), in the report's order."""


@dataclass(frozen=True, slots=True)
class DryRun:
    """A `test` verdict: every check ran, no handler, nothing kept, no event.

    `errors` are the findings that block (empty when `accepted`) and `values` the values the run kept, or `None` when
    it kept none. `report` is the dry-run route's whole answer, one flat object: `outcome`, `stage`, `errors` (every
    finding with its severity, so warnings and info sit beside the blocking ones), `sent`, `values`, the four lists in
    `REPORT_ID_LISTS`, `document`, `digest`, `logs`, `sandbox` and `signature`, in that order.
    """

    accepted: bool
    stage: str | None
    errors: tuple[SubmissionError, ...]
    values: Mapping[str, JsonValue] | None
    report: Mapping[str, JsonValue]


@dataclass(frozen=True, slots=True)
class PdfChecked:
    """A `pdf_check` verdict with nothing blocking: the checked values for the print, and nothing was kept.

    `digest` is the submission's canonical digest, `definition` the stored form the answers were judged against,
    `warnings` the validators' non-blocking findings and `host_context` the host context the answers were judged with
    (`None` when none was supplied): the PDF is drawn with the same one.
    """

    values: Mapping[str, JsonValue]
    form_key: str
    version: str
    locale: str
    digest: str
    definition: Mapping[str, JsonValue]
    warnings: tuple[HookProblem, ...] = ()
    host_context: Mapping[str, JsonValue] | None = None


@dataclass(frozen=True, slots=True)
class Outdated:
    """The document names a version that is not the current one; the hash never reaches the wire."""

    current_version: str
    current_sha256: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class NotFound:
    """No form has this key (or it is no form key); the key never reaches the wire."""

    form_key: str = field(repr=False)


@dataclass(frozen=True, slots=True)
class Malformed:
    """The document breaks a document rule; `reason` is for the log, never the wire."""

    reason: str


@dataclass(frozen=True, slots=True)
class TooLarge:
    """The document's JSON is longer than `max_bytes` (`datum.web.api.max_body_size`), measured on the tree."""

    max_bytes: int


@dataclass(frozen=True, slots=True)
class Refused:
    """A pre-check refused: its decision, code and words as given."""

    decision: Reject


@dataclass(frozen=True, slots=True)
class Throttled:
    """Over the limit: whole seconds to wait, and the completed key it was counted under."""

    retry_after: int
    key: ThrottleKey


@dataclass(frozen=True, slots=True)
class Unavailable:
    """No verdict could be reached: the wire `code`, host words in `reason`, and the `cause` for the log only.

    The codes are `server.unavailable`, `server.busy`, `validator_unavailable`, the run's own
    `wasm.execution_error`, `outcome_too_large` and `definition.tooDeep`, and `signing.not_set_up` (a signed wrapper
    before the signature check exists). A queue consumer leaves the message for a
    retry on this outcome only.
    """

    code: str
    reason: str
    cause: BaseException | None = field(default=None, compare=False, repr=False)


type SubmissionOutcome = (
    Accepted
    | Redelivered
    | KeyConflict
    | Rejected
    | Checked
    | DryRun
    | Outdated
    | NotFound
    | Malformed
    | TooLarge
    | Refused
    | Throttled
    | Unavailable
)
"""Every answer of `SubmissionService.submit`, `validate` and `test`."""


@dataclass(frozen=True, slots=True)
class Inspected:
    """The program's answer to an inspect op, as it gave it."""

    answer: Mapping[str, JsonValue]


type InspectOutcome = Inspected | Malformed | TooLarge | Throttled | Unavailable
"""Every answer of `SubmissionService.inspect`."""


type PdfCheckOutcome = PdfChecked | Rejected | Refused | NotFound | Outdated | Malformed | TooLarge | Unavailable
"""Every answer of `SubmissionService.pdf_check`: the checked values, or the refusals of `submit` (no throttle step)."""
