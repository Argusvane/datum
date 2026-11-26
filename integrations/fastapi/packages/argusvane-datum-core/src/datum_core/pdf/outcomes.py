"""What `PdfService` answers: sealed unions of frozen records, and the service's two errors.

Built on: the standard library (`dataclasses`, `typing`) and the submission outcomes (`datum_core.submissions`:
`Malformed`, `NotFound`, `Outdated`, `Rejected`, `Refused`, `TooLarge`, `Throttled`, `Unavailable`, reused as they are,
so the dry run's refusals reach the caller unchanged) cover every shape here. No library speaks a printed PDF, a layout
the definition does not hold, a validator's refusal of produced bytes or a file that is not a PDF; `pydantic` would add
validation records the service builds itself do not need. So the PDF records below are written once, beside the
datum errors they share a code table with (`datum_sandbox.protocol.DatumError`).

A record never carries a key, a password or a certificate. `Printed.data` is the answered file, hidden from `repr`. The
verify report and its verdicts live in `datum_core.pdf.verify` (`PdfVerifyReport`, `SignatureVerdict`).
"""

from dataclasses import dataclass, field
from typing import Literal

from datum_core.hooks import HookProblem
from datum_core.pdf.verify import PdfVerifyReport
from datum_core.submissions import (
    Malformed,
    NotFound,
    Outdated,
    Refused,
    Rejected,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_sandbox.protocol import DatumError

__all__ = [
    "LayoutNotFound",
    "LayoutNotTemplate",
    "NotAPdf",
    "PdfError",
    "PdfOutcome",
    "PdfSignatureError",
    "PdfUnavailableError",
    "Printed",
    "ResultRejected",
    "SealWord",
    "Unreadable",
    "Verified",
    "VerifyOutcome",
]

type SealWord = Literal["server", "test", "none"]
"""Which key sealed a printed PDF: the server's, the throwaway test seal, or none."""


@dataclass(frozen=True, slots=True)
class Printed:
    """A PDF made: its bytes, its page count, the layout printed, and who sealed it.

    `signed_by` is the sealing certificate's common name (else its subject) and `signature_field` the field the
    signature went into, both None for an unsealed file; `timestamped` says the program embedded a token. `warnings`
    are, in order, the dry run's non-blocking findings, the program's warnings (component id as the field), the result
    validators' warnings and the seal's (`sealing.timestamp`). `seal` names the key: `server`, `test` or `none`.
    `pdf_theme` is the id of the PDF theme the form's binding suggests (`datum.bindings`), None when it suggests none.
    """

    data: bytes = field(repr=False)
    page_count: int
    layout_id: str | None
    signed_by: str | None = None
    signature_field: str | None = None
    timestamped: bool = False
    warnings: tuple[HookProblem, ...] = ()
    seal: SealWord = "none"
    pdf_theme: str | None = None


@dataclass(frozen=True, slots=True)
class LayoutNotFound:
    """The definition holds no layout of this id, or one whose template is not inline base64."""

    layout_id: str


@dataclass(frozen=True, slots=True)
class LayoutNotTemplate:
    """A fill named a layout that is not a template layout."""

    layout_id: str


@dataclass(frozen=True, slots=True)
class ResultRejected:
    """The result validators refused the produced PDF: every error, in validator order (the first one's code leads)."""

    errors: tuple[HookProblem, ...]

    @property
    def code(self) -> str:
        """The first error's code, the answer's."""
        return self.errors[0].code


@dataclass(frozen=True, slots=True)
class NotAPdf:
    """The bytes handed to verify do not start like a PDF (no `%PDF-` in the first 1024 bytes); nothing ran."""


@dataclass(frozen=True, slots=True)
class Unreadable:
    """The program refused to read the file; `code` is its word, for the log only."""

    code: str | None = field(default=None, compare=False)


@dataclass(frozen=True, slots=True)
class Verified:
    """The verify report of a file the program read."""

    report: PdfVerifyReport


type PdfOutcome = (
    Printed
    | LayoutNotFound
    | LayoutNotTemplate
    | ResultRejected
    | Malformed
    | NotFound
    | Outdated
    | Rejected
    | Refused
    | TooLarge
    | Throttled
    | Unavailable
)
"""What `render`, `fill`, `sign` and `render_submission` answer; a hook's `HookRefusedError` and a program's
`PdfKernelError` are raised, as are a `PdfError` and any other exception."""

type VerifyOutcome = Verified | NotAPdf | Unreadable | TooLarge | Throttled | Unavailable
"""What `verify` answers."""


class PdfError(DatumError):
    """The PDF service could not finish a call it accepted: 500 `internal`, the cause on `datum.pdf` only.

    Raised for a program that prepared no signature; a seal the server cannot make (`render_submission` of a sealed
    layout with no key of the server's) and a signing refusal are `PdfSignatureError`.
    The message is Datum's words and names no key, value or file.
    """

    code = "internal"
    status = 500


class PdfSignatureError(PdfError):
    """The seal refused to sign or to embed: 500 `signature`, the cause on `datum.pdf` only.

    Raised for a seal that needs the server's key when the server has none; before the key signs, for a handoff that
    is not over the prepared file or names another algorithm than the signer's, and for a signer that names no
    certificate; for a signer that raises while it signs; after it signs, for a value of no shape the program takes.
    The code is the PDF program's own word for a signing refusal, so a client reads one code for a signature the
    server would not make; a 500 carries no message, so the words stay in the log.
    """

    code = "signature"


class PdfUnavailableError(PdfError):
    """PDFs cannot be made now (no engine that runs the PDF program, a program that failed its ABI proof, a stop).

    The kernel accessor a `PdfService` is built with raises it; the service answers `Unavailable` with the code
    `server.unavailable` (503).
    """

    code = "server.unavailable"
    status = 503
