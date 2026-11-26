"""`ObservedPdfService`: the PDF service with a `datum.pdf` span and the output-size histogram around each call.

It lives beside `datum_core.observe`, not in it: the service needs `argusvane-datum-core[pdf]` (cryptography), and
`observe` is imported by every deployment. `Datum` imports this module only while `datum.pdf.enabled`, in the same lazy
step that builds the service.

Built on: `opentelemetry` (through `datum_core.observe`'s tracer and meter) is the instrument; the standard
library's `functools.partial` binds each parent call. The one class exists because `PdfService` is a plain class with
no observation seam: the subclass opens the span around its five operations (`isinstance(..., PdfService)` still
holds) and a repository wrapper tells the open call the form it found, as the submission service does.

The span: `datum.pdf.op`, `datum.outcome`, `datum.pdf.seal` (`server`, `test` or `none`), `datum.pdf.timestamp` (`site`,
`custom`, `server` or `none`: where the embedded token came from, `none` for a file without one) and `datum.form` once
found. A refusal is a normal outcome (status unset); the error status and `error.type` mark a service that could not
run (`Unavailable` but busy) or an exception.
"""

import functools
from collections.abc import Callable

from datum_core.observe import pdf_observed
from datum_core.pdf.outcomes import (
    LayoutNotFound,
    LayoutNotTemplate,
    NotAPdf,
    PdfOutcome,
    Printed,
    ResultRejected,
    Unreadable,
    Verified,
    VerifyOutcome,
)
from datum_core.pdf.service import PdfService
from datum_core.submissions import (
    AcceptedSubmission,
    FormRef,
    Malformed,
    NotFound,
    Outdated,
    Refused,
    Rejected,
    SubmissionContext,
    Throttled,
    TooLarge,
    Unavailable,
)

__all__ = ["ObservedPdfService"]

_NAMES: dict[type, str] = {
    Printed: "printed",
    Verified: "verified",
    LayoutNotFound: "layout_not_found",
    LayoutNotTemplate: "layout_not_template",
    ResultRejected: "result_rejected",
    NotAPdf: "not_a_pdf",
    Unreadable: "unreadable",
    Malformed: "malformed",
    NotFound: "not_found",
    Outdated: "outdated",
    Rejected: "rejected",
    Refused: "refused",
    TooLarge: "too_large",
    Throttled: "throttled",
    Unavailable: "unavailable",
}
_BUSY = "server.busy"


class ObservedPdfService(PdfService):
    """`PdfService` with a `datum.pdf` span around each operation and the output-size histogram."""

    __slots__ = ()

    def render(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str | None = None
    ) -> PdfOutcome:
        """See `PdfService.render`."""
        return self._observed("render", functools.partial(super().render, form, document, context, layout_id=layout_id))

    def fill(self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str) -> PdfOutcome:
        """See `PdfService.fill`."""
        return self._observed("fill", functools.partial(super().fill, form, document, context, layout_id=layout_id))

    def sign(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str | None = None
    ) -> PdfOutcome:
        """See `PdfService.sign`."""
        return self._observed("sign", functools.partial(super().sign, form, document, context, layout_id=layout_id))

    def render_submission(self, accepted: AcceptedSubmission, *, layout_id: str | None = None) -> PdfOutcome:
        """See `PdfService.render_submission`."""
        return self._observed(
            "render_submission", functools.partial(super().render_submission, accepted, layout_id=layout_id)
        )

    def verify(self, data: bytes, context: SubmissionContext) -> VerifyOutcome:
        """See `PdfService.verify`."""
        return self._observed("verify", functools.partial(super().verify, data, context))

    def _observed[T: PdfOutcome | VerifyOutcome](self, op: str, call: Callable[[], T]) -> T:
        with pdf_observed(op) as observed:
            outcome = call()
            name = _NAMES.get(type(outcome), "unknown")
            if isinstance(outcome, Printed):
                stamped = self.timestamp_source if outcome.timestamped else "none"
                observed.finish(name, seal=outcome.seal, timestamp=stamped, size=len(outcome.data))
            else:
                observed.finish(name)
            if isinstance(outcome, Unavailable) and outcome.code != _BUSY:
                observed.unavailable(type(outcome.cause).__name__ if outcome.cause is not None else outcome.code)
            return outcome
