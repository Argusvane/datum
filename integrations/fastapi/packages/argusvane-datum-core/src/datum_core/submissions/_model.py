"""The values a submission travels as: the form it names, who sent it, what the hooks and the handler are handed.

Every record is a frozen, slotted dataclass. None of them names a transport: a queue consumer, a batch import and a
route build the same `SubmissionContext`, and only its `channel` word tells them apart.
"""

import enum
import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Final, Literal

from datum_core.config.models import LogLevel, UnknownFields
from datum_core.hooks import HookProblem
from datum_core.throttle import ThrottleKey
from datum_sandbox.json import JsonValue

__all__ = [
    "AcceptedSubmission",
    "FormRef",
    "IncomingSubmission",
    "JourneyCheck",
    "RunSettings",
    "SubmissionContext",
    "SubmissionError",
    "SubmissionMode",
    "SubmissionNote",
    "SubmissionReceipt",
    "ValidatedSubmission",
]

_CHANNEL: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:/\-]{0,63}")
SUBMISSION_KEY: Final = re.compile(r"[A-Za-z0-9][A-Za-z0-9._:\-]{0,127}")
"""What a submission key may be (`fullmatch`): 1 to 128 letters, digits and `. _ : -`, led by a letter or a digit."""

type SubmissionError = tuple[str | None, str, str | None]
"""One error of a verdict: (component id or None, code, message or None).

The message is the text the sandbox or a hook gave the item (None when it gave none or an empty one); the sandbox's
words are the form's own, never its stderr."""

type SubmissionNote = tuple[str | None, str, str, str | None]
"""One non-blocking item of a verdict: (component id or None, code, severity `warning` or `info`, message or None).

The message is the one the sandbox or a validator gave (text for a person; None when it gave none or gave an empty
one). Carried on the authoring surfaces (`Checked`, the dry-run report), never on an accepted submission."""


class SubmissionMode(enum.StrEnum):
    """What a call asks of the pipeline: a delivery, a check that keeps nothing, a dry run, or the PDF routes' check."""

    SUBMIT = "submit"
    VALIDATE = "validate"
    TEST = "test"
    PDF = "pdf"


@dataclass(frozen=True, slots=True)
class FormRef:
    """Which form a call judges.

    `from_document()` judges the one the document names; `of(key)` also refuses a document naming another form
    (`Malformed`, before anything is asked).
    """

    key: str | None = None

    @classmethod
    def from_document(cls) -> "FormRef":
        """Judge the form the document names (`versionContext.form.id`)."""
        return cls(None)

    @classmethod
    def of(cls, key: str) -> "FormRef":
        """Judge the form `key`; a document naming another form is malformed."""
        return cls(key)


@dataclass(frozen=True, slots=True)
class SubmissionContext:
    """Who sent a document and how. Every hook and every submission event sees `channel`.

    `channel` is `http`, `bus`, `sync`, `other`, or any word of 1 to 64 letters, digits and `. _ : / -` that starts
    with a letter or a digit (a `ValueError` otherwise). The rest is optional and `None` when the caller has none:
    `principal` (the application's), `remote_address`, `user_agent`, `headers` (read-only), `throttle_key` (a
    caller with none is not counted; the service completes the form and the kind), `body_digest` (the SHA-256
    of the raw bytes a route read) and `submission_key`: the key of the submit attempt a delivery belongs to, which
    the browser mints once per attempt and sends again on a retry (a queue message's id on a bus). A delivery
    without one is refused; a check or a dry run ignores it. A key outside `SUBMISSION_KEY` is a `ValueError`.
    """

    channel: str
    principal: object | None = None
    remote_address: str | None = None
    user_agent: str | None = None
    headers: Mapping[str, str] | None = None
    throttle_key: ThrottleKey | None = None
    body_digest: str | None = None
    submission_key: str | None = None

    def __post_init__(self) -> None:
        """Hold the channel to its word rule and the submission key to its own, and freeze the headers."""
        if _CHANNEL.fullmatch(self.channel) is None:
            raise ValueError(
                "a submission channel is 1 to 64 letters, digits and . _ : / -, starting with a letter or a digit"
            )
        if self.submission_key is not None and (
            not isinstance(self.submission_key, str)  # type: ignore[redundant-expr]  # pyright: ignore[reportUnnecessaryIsInstance]
            or SUBMISSION_KEY.fullmatch(self.submission_key) is None
        ):
            raise ValueError(
                "a submission key is 1 to 128 letters, digits and . _ : -, starting with a letter or a digit"
            )
        if self.headers is not None and not isinstance(self.headers, MappingProxyType):
            object.__setattr__(self, "headers", MappingProxyType(dict(self.headers)))


@dataclass(frozen=True, slots=True)
class JourneyCheck:
    """What a `validate` call checks: the whole journey (`journey`) or one page of it (`page`, `page_id`).

    A page check needs the page's id; a page id goes with a page check only (`ValueError` otherwise).
    """

    scope: Literal["journey", "page"] = "journey"
    page_id: str | None = None

    def __post_init__(self) -> None:
        """Hold the scope and the page id together."""
        if self.scope not in {"journey", "page"}:
            raise ValueError('a check\'s scope is "journey" or "page"')
        if self.scope == "page" and not self.page_id:
            raise ValueError("a page check names the page it checks")
        if self.scope == "journey" and self.page_id is not None:
            raise ValueError("a page id goes with a page check only")


@dataclass(frozen=True, slots=True)
class IncomingSubmission:
    """What a pre-check is handed: the form key, the mode and the caller's context (before the definition is read)."""

    form_key: str
    mode: SubmissionMode
    context: SubmissionContext
    version: str | None = None
    locale: str | None = None


@dataclass(frozen=True, slots=True)
class ValidatedSubmission:
    """What a validator is handed: the answers the sandbox kept, after a verdict with nothing blocking.

    `digest` is the canonical SHA-256 of the delivered document (the idempotency key's last part).
    """

    form_key: str
    values: Mapping[str, JsonValue]
    digest: str
    version: str | None = None
    locale: str | None = None


@dataclass(frozen=True, slots=True)
class AcceptedSubmission:
    """What the handler is handed: the answers the sandbox kept, the validators' warnings and who sent them.

    `submission_key` is the submit attempt's key: two deliveries of one attempt may both reach the handler (no lock
    holds across instances), so a handler is idempotent on (`form_key`, `version`, `submission_key`), never on
    `digest`, which two people who give the same answers share. `remote_address` and `user_agent` are `None` for a
    caller that gave none. `host_context` is the copy of what `Datum(host_context=...)` answered for this call (the
    values the form's `host.` paths were judged with), `None` when it supplied none; `PdfService.render_submission`
    draws the record's PDF with it.
    """

    form_key: str
    digest: str
    values: Mapping[str, JsonValue]
    warnings: tuple[HookProblem, ...]
    channel: str
    remote_address: str | None
    user_agent: str | None
    version: str | None = None
    locale: str | None = None
    principal: object | None = None
    submission_key: str | None = None
    host_context: Mapping[str, JsonValue] | None = None


@dataclass(frozen=True, slots=True)
class SubmissionReceipt:
    """What the handler answers and the idempotency store keeps: an id, a reference for a person, optional data.

    `receipt` (the handler's own JSON) takes no part in the hash, so receipts can be kept in a set.
    """

    id: str
    reference: str
    receipt: Mapping[str, JsonValue] | None = field(default=None, hash=False)


@dataclass(frozen=True, slots=True)
class RememberedReceipt:
    """What the idempotency store keeps for an accepted submit attempt: the digest it was accepted with and its receipt.

    A retry of the attempt (the same key and digest) is answered with `receipt`; the same key with another digest is
    refused, never answered with it.
    """

    digest: str
    receipt: SubmissionReceipt


@dataclass(slots=True)
class RunSettings:
    """The typed draft a host-options customizer may change: the run's words, nothing that names the run.

    The ABI, the op, the program, the form and its id are not on it. A word the program does not read is refused
    after the customizers ran, as a raise is (`Unavailable`, `validator_unavailable`).
    """

    unknown_fields: UnknownFields = UnknownFields.STRIP
    log_level: LogLevel = LogLevel.WARN
