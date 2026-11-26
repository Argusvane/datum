"""The wire layer: the admission of the five PDF operations and their answers, held to the shared catalog.

Admission comes before any service, in a fixed order. 415 from `Content-Type` before a byte is read
(`application/json` for `renderPdf`, `fillPdf` and `signPdf`; `application/pdf` ONLY for `verifyPdf`), then 429 from the
address limit (the route's, before a byte is read), then the framing
of `Content-Length` (one that is not a whole number is the malformed-framing 400 `bad_request`), then 413 `bad_document`
from a declared length over the cap and from a counted read that stops at the first chunk over it (a chunked or lying
body cannot pass), then 400 `bad_document` for a JSON body that is not `{document, layoutId?}`. The JSON routes read
under `datum.web.api.max_body_size`, verify under `datum.runtime.verify_max_bytes`; whether the uploaded bytes are a PDF
is the service's call (`NotAPdf`), so admission hands back whatever was sent. The per-form throttle's 429 and the
availability 503 come after, from the service.

The answers: a printed PDF is 200 `application/pdf` with `X-Page-Count` (the catalog's header) and the three headers the
kit reads: `X-Signed-By` (the sealing certificate's name) and `X-Signature-Field` when the file is signed,
`X-Datum-Layout` when a layout was printed, `X-Datum-Pdf-Theme` when the form's binding suggests a PDF theme. Each
value is percent-encoded UTF-8 (`%20` for a space and `%2B` for a plus,
since the kit decodes them as form data), so no CR, LF or non-ASCII byte can reach a header. A verify report is 200 JSON
with the catalog's `PdfVerifyReport` members and nothing else (`trustReason` stays off the wire, as do the timestamp
facts the catalog does not list). `/server/certificate` is the PEM chain or 404 `certificate.notFound`. Every refusal
uses a code the catalog lists for its operation, else it is the 500 `internal` answer: a version mismatch is 422
`form.outdated` (the pdf operations list no 409), an engine that cannot run the PDF program is 503 `server.unavailable`
(the catalog's 503 codes are `server.unavailable` and `server.busy` only), the program's own refusals are mapped by
`PDF_PROGRAM_ROWS` (`signature` is the 500 `signature`, as the seal's own refusals are; every word not listed there
is the 500 `internal`, the cause on `datum.pdf`). A
signed wrapper is 503 `signing.not_set_up` while signing is not set up. No answer carries a key, a
certificate, a digest of the request, a form key or the program's own words.

The PDF records are imported when an answer is built, not with this module: `datum_core.pdf.outcomes` needs
`argusvane-datum-core[pdf]`, and `import datum_core.http` must work without it.

Libraries: the answer table (`datum_core.http.errors`), the admission pieces (`count_body`, `parse_json_body`,
`check_request_headers`) and `submission_answer` build every refusal; `urllib.parse.quote` percent-encodes the header
values; `json` writes the report as the other answers are written. The one record here, `PdfRequestBody`, is a frozen
dataclass over what the bounded JSON reader parsed: pydantic's parser is not used for submission documents, and nothing
standard names "a document and an optional layout id".
"""

import json
import logging
import urllib.parse
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any, Final, assert_never

from datum_core.http._headers import header
from datum_core.http.admission import Refused, check_request_headers, parse_json_body, refuse_too_large
from datum_core.http.admission import count_body as count_body  # noqa: PLC0414  (explicit re-export for mypy)
from datum_core.http.answer import HttpAnswer
from datum_core.http.errors import (
    ANSWER_ROWS,
    JSON,
    RETRY_AFTER,
    error_answer,
    errors_answer,
    internal_answer,
)
from datum_core.http.submissions import RUN_CODES, submission_answer
from datum_core.http.timestamp import PEM_MEDIA_TYPE
from datum_core.loggers import PDF
from datum_core.submissions import Outdated, Reject, Throttled, TooLarge, Unavailable
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import PdfKernelError

if TYPE_CHECKING:
    from datum_core.pdf.outcomes import PdfOutcome, Printed, VerifyOutcome
    from datum_core.pdf.verify import PdfVerifyReport, SignatureVerdict

__all__ = [
    "FILL_OPERATION",
    "PDF_MEDIA_TYPE",
    "PDF_PROGRAM_ROWS",
    "PEM_MEDIA_TYPE",
    "PdfRequestBody",
    "certificate_answer",
    "check_pdf_request_headers",
    "check_pdf_upload_headers",
    "parse_pdf_request",
    "pdf_answer",
    "read_pdf_request",
    "read_pdf_upload",
    "verify_answer",
]

FILL_OPERATION: Final = "fillPdf"
"""The one operation whose catalog row lists `layout.notTemplate`."""
PDF_MEDIA_TYPE: Final = "application/pdf"
"""What a printed PDF is answered as, and the only media type the verify route takes."""

PDF_PROGRAM_ROWS: Final[Mapping[str, tuple[int, str]]] = {
    "layout": (404, "layout.notFound"),
    "template": (422, "template"),
    "render_limit": (422, "render_limit"),
    "unknown_component": (422, "unknown_component"),
    "conformance": (422, "conformance"),
    "attachment_budget": (422, "attachment_budget"),
    "signature": (500, "signature"),
}
"""The PDF program's refusal codes the wire answers, by the program's word: a layout the program cannot find is the
catalog's 404, and what the program refuses in the definition or the answers (a template it cannot fill, the render
caps, a component it cannot draw, a PDF/A breach, the attachment budget) is the open 422 with the program's word.
A seal the program would not make (`signature`) is the 500 `signature`, the code the seal's own refusals answer, with
no message. Every other word (`font`, `invalid_request`, `abi_mismatch`, `internal`, `unknown`, ...) is the 500
`internal`, the cause logged on `datum.pdf`."""

_SERVER_ERROR: Final = 500
"""A program row at or over this status is the server's failure: logged as a warning, not as information."""
_JSON_TYPES: Final = (JSON,)
_PDF_TYPES: Final = (PDF_MEDIA_TYPE,)
_CONTENT_TYPE: Final = "Content-Type"
_CONTENT_LENGTH: Final = "Content-Length"
_LENGTH_DIGITS: Final = 18
"""A declared length with more digits than this is over any cap (and too long to convert safely)."""
_DOCUMENT: Final = "document"
_LAYOUT_ID: Final = "layoutId"
_NO_STORE: Final = "no-store"
_NO_CACHE: Final = "no-cache"
_SIGNING_NOT_SET_UP: Final = "signing.not_set_up"
_BUSY: Final = "server.busy"
_UNAVAILABLE: Final = "server.unavailable"
_UNAVAILABLE_STATUS: Final = 503
_TYPED_503: Final = frozenset(
    code
    for row in ANSWER_ROWS
    if row.status == _UNAVAILABLE_STATUS and RETRY_AFTER not in row.headers
    for code in row.codes
)
"""The typed 503 codes of the answer table that carry no `Retry-After`: on a pdf operation each is answered as
`server.unavailable` (a run's own code, `RUN_CODES`, and `signing.not_set_up` are answered as they are)."""

logger = logging.getLogger(PDF)


@dataclass(frozen=True, slots=True)
class PdfRequestBody:
    """The body of `renderPdf`, `fillPdf` and `signPdf`: the submission document and the layout asked, if any."""

    document: JsonValue
    layout_id: str | None = None


# -- admission ---------------------------------------------------------------------------------------------------------
def _refuse(status: int, code: str, message: str, *, problem_details: bool) -> Refused:
    return Refused(error_answer(status, code, message=message, problem_details=problem_details))


def _check_headers(
    headers: Mapping[str, str], *, media_types: tuple[str, ...], max_bytes: int, problem_details: bool
) -> Refused | None:
    content_type = header(headers, _CONTENT_TYPE)
    refused = check_request_headers(
        {} if content_type is None else {_CONTENT_TYPE: content_type},
        max_bytes=max_bytes,
        media_types=media_types,
        problem_details=problem_details,
    )
    if refused is not None:
        return refused
    length = header(headers, _CONTENT_LENGTH)
    if length is None:
        return None
    if not (length.isascii() and length.isdigit()):
        return _refuse(400, "bad_request", "The Content-Length is not a whole number.", problem_details=problem_details)
    if len(length) > _LENGTH_DIGITS or int(length) > max_bytes:
        return refuse_too_large(problem_details=problem_details)
    return None


def check_pdf_request_headers(
    headers: Mapping[str, str], *, max_bytes: int, problem_details: bool = False
) -> Refused | None:
    """Refuse a JSON route's request before a byte is read, or return `None`.

    415 `unsupported_media_type` for a `Content-Type` other than `application/json` (case and parameters ignored), 400
    `bad_request` for a `Content-Length` that is not a whole number, 413 `bad_document` for one over `max_bytes`.
    """
    return _check_headers(headers, media_types=_JSON_TYPES, max_bytes=max_bytes, problem_details=problem_details)


def check_pdf_upload_headers(
    headers: Mapping[str, str], *, max_bytes: int, problem_details: bool = False
) -> Refused | None:
    """Refuse a verify request before a byte is read, or return `None`: as above, `application/pdf` the only type."""
    return _check_headers(headers, media_types=_PDF_TYPES, max_bytes=max_bytes, problem_details=problem_details)


def parse_pdf_request(
    body: bytes, *, layout_required: bool = False, problem_details: bool = False
) -> PdfRequestBody | Refused:
    """Read `{document, layoutId?}` with the bounded JSON reader.

    Anything else is 400 `bad_document` and echoes nothing.

    `document` is any JSON value (the service judges it); `layoutId` is absent, null or a non-empty string, and must
    be there when `layout_required` (a fill names the template layout it fills). Other members are ignored.
    """
    parsed = parse_json_body(body, problem_details=problem_details)
    if isinstance(parsed, Refused):
        return parsed
    if not isinstance(parsed, dict) or _DOCUMENT not in parsed:
        return _refuse(
            400, "bad_document", 'The body is not {"document": ..., "layoutId"?}.', problem_details=problem_details
        )
    layout_id = parsed.get(_LAYOUT_ID)
    if layout_id is not None and (not isinstance(layout_id, str) or not layout_id):
        return _refuse(400, "bad_document", "The layoutId is not a non-empty string.", problem_details=problem_details)
    if layout_id is None and layout_required:
        return _refuse(400, "bad_document", "A fill names its layoutId.", problem_details=problem_details)
    return PdfRequestBody(parsed[_DOCUMENT], layout_id)


def read_pdf_request(
    headers: Mapping[str, str],
    chunks: Iterable[bytes],
    *,
    max_bytes: int,
    layout_required: bool = False,
    problem_details: bool = False,
) -> PdfRequestBody | Refused:
    """Admit a JSON route's body: the header checks (no chunk is pulled), the counted read, the strict parse."""
    refused = check_pdf_request_headers(headers, max_bytes=max_bytes, problem_details=problem_details)
    if refused is not None:
        return refused
    body = count_body(chunks, max_bytes=max_bytes, problem_details=problem_details)
    if isinstance(body, Refused):
        return body
    return parse_pdf_request(body, layout_required=layout_required, problem_details=problem_details)


def read_pdf_upload(
    headers: Mapping[str, str], chunks: Iterable[bytes], *, max_bytes: int, problem_details: bool = False
) -> bytes | Refused:
    """Admit a verify body: the header checks (no chunk is pulled), then the counted read; the bytes come back whole."""
    refused = check_pdf_upload_headers(headers, max_bytes=max_bytes, problem_details=problem_details)
    if refused is not None:
        return refused
    return count_body(chunks, max_bytes=max_bytes, problem_details=problem_details)


# -- the answers -------------------------------------------------------------------------------------------------------
def _quoted(value: str) -> str:
    """Percent-encode `value` as UTF-8 with nothing kept but letters, digits and `-._~`: a header-safe ASCII token."""
    return urllib.parse.quote(value, safe="")


def _printed(printed: "Printed") -> HttpAnswer:
    headers = {
        "Content-Type": PDF_MEDIA_TYPE,
        "Cache-Control": _NO_STORE,
        "X-Page-Count": str(printed.page_count),
    }
    if printed.layout_id:
        headers["X-Datum-Layout"] = _quoted(printed.layout_id)
    if printed.pdf_theme:
        headers["X-Datum-Pdf-Theme"] = _quoted(printed.pdf_theme)
    if printed.signed_by is not None and printed.signed_by.strip():
        headers["X-Signed-By"] = _quoted(printed.signed_by)
    if printed.signature_field is not None and printed.signature_field.strip():
        headers["X-Signature-Field"] = _quoted(printed.signature_field)
    return HttpAnswer(200, headers, printed.data)


def _unavailable(code: str, retry_after: int, modes: dict[str, Any]) -> HttpAnswer:
    if code in RUN_CODES or code == _SIGNING_NOT_SET_UP:
        return error_answer(_UNAVAILABLE_STATUS, code, **modes)  # a run that gave no verdict: the server's failure
    if code == _BUSY:
        return error_answer(_UNAVAILABLE_STATUS, _BUSY, retry_after=retry_after, **modes)
    if code in _TYPED_503:
        return error_answer(_UNAVAILABLE_STATUS, _UNAVAILABLE, **modes)
    logger.error(
        "an unavailable PDF outcome carried the code %r, which no answer row lists; answered 500 internal",
        code,
        extra={"datum_correlation_id": modes["correlation_id"]},
    )
    return internal_answer(**modes)


def _program_refusal(error: PdfKernelError, modes: dict[str, Any]) -> HttpAnswer:
    row = PDF_PROGRAM_ROWS.get(error.code)
    if row is None:
        logger.warning(
            "the PDF program refused the request with its code %r; answered 500 internal",
            error.code,
            extra={"datum_correlation_id": modes["correlation_id"]},
        )
        logger.debug("the PDF program's words for %r: %s", error.code, error.message)
        return internal_answer(**modes)
    status, code = row
    logger.log(
        logging.WARNING if status >= _SERVER_ERROR else logging.INFO,
        "the PDF program refused the request with its code %r; answered %d %s",
        error.code,
        status,
        code,
        extra={"datum_correlation_id": modes["correlation_id"]},
    )
    logger.debug("the PDF program's words for %r: %s", error.code, error.message)
    return error_answer(status, code, **modes)


def pdf_answer(  # noqa: PLR0911 - one arm per outcome variant
    outcome: "PdfOutcome | PdfKernelError",
    *,
    retry_after: int,
    operation: str | None = None,
    pre_check_statuses: Callable[[Reject], int] | None = None,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer of `renderPdf`, `fillPdf` or `signPdf` for what the service answered or the program raised.

    `retry_after` is `datum.web.api.busy_retry_after` (a 429 carries the throttle's own seconds); `pre_check_statuses`
    maps a pre-check's `Reject` to its status (`PreCheckStatuses.standard()` when `None`), as on a submission.
    `operation` is the catalog's operation id the answer is for: the catalog lists `layout.notTemplate` on `fillPdf`
    only, so on another named operation that refusal is logged and answered 500 `internal`.
    """
    from datum_core.pdf import outcomes as pdf  # noqa: PLC0415 - argusvane-datum-core[pdf] is needed only once a PDF answers

    modes: dict[str, Any] = {"problem_details": problem_details, "correlation_id": correlation_id}
    match outcome:
        case pdf.Printed():
            return _printed(outcome)
        case pdf.LayoutNotFound():
            return error_answer(404, "layout.notFound", **modes)
        case pdf.LayoutNotTemplate():
            if operation not in {None, FILL_OPERATION}:
                logger.error(
                    "%s answered layout.notTemplate, which the catalog lists on %s only; answered 500 internal",
                    operation,
                    FILL_OPERATION,
                    extra={"datum_correlation_id": correlation_id},
                )
                return internal_answer(**modes)
            return error_answer(400, "layout.notTemplate", **modes)
        case pdf.ResultRejected(errors):
            return errors_answer(422, [(item.field, item.code, item.message or None) for item in errors], **modes)
        case PdfKernelError():
            return _program_refusal(outcome, modes)
        case Outdated():
            return error_answer(422, "form.outdated", **modes)
        case Unavailable(code):
            return _unavailable(code, retry_after, modes)
        case _:
            return submission_answer(outcome, retry_after=retry_after, pre_check_statuses=pre_check_statuses, **modes)


def _instant(moment: datetime) -> str:
    """Write `moment` as an ISO 8601 instant in UTC with `Z`."""
    aware = moment if moment.tzinfo is not None else moment.replace(tzinfo=UTC)
    return aware.astimezone(UTC).isoformat().replace("+00:00", "Z")


def _verdict(verdict: "SignatureVerdict") -> dict[str, JsonValue]:
    item: dict[str, JsonValue] = {
        "field": verdict.field,
        "value": verdict.value,
        "digestMatches": verdict.digest_matches,
        "certificateMatches": verdict.certificate_matches,
        "coversDocument": verdict.covers_document,
        "intact": verdict.intact,
        "trust": verdict.trust,
        "signingTime": verdict.signing_time,
    }
    if verdict.trusted_at is not None:
        item["trustedAt"] = _instant(verdict.trusted_at)
    return item


def _report(report: "PdfVerifyReport") -> HttpAnswer:
    summary = report.trust_policy
    document: dict[str, JsonValue] = {
        "sha256": report.sha256,
        "bytes": report.size,
        "signatures": [_verdict(verdict) for verdict in report.signatures],
        "documentId": report.document_id,
        "documentIdSource": report.document_id_source,
        "warnings": list(report.warnings),
        "trustPolicy": {
            "name": summary.name,
            "revocationChecking": summary.revocation_checking,
            "validationTime": summary.validation_time,
        },
    }
    text = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return HttpAnswer(200, {"Content-Type": JSON, "Cache-Control": _NO_STORE}, text.encode("utf-8"))


def verify_answer(  # noqa: PLR0911 - one arm per outcome variant
    outcome: "VerifyOutcome",
    *,
    retry_after: int,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer of `verifyPdf`: the report, or 400 `pdf.notAPdf` / `pdf.unreadable`, 413, 429 or 503.

    A file the program could not read is answered without the program's words (they are on `datum.pdf`).
    """
    from datum_core.pdf import outcomes as pdf  # noqa: PLC0415 - argusvane-datum-core[pdf] is needed only once a PDF answers

    modes: dict[str, Any] = {"problem_details": problem_details, "correlation_id": correlation_id}
    match outcome:
        case pdf.Verified(report):
            return _report(report)
        case pdf.NotAPdf():
            return error_answer(400, "pdf.notAPdf", **modes)
        case pdf.Unreadable():
            return error_answer(400, "pdf.unreadable", **modes)
        case TooLarge():
            return error_answer(413, "bad_document", **modes)
        case Throttled(seconds):
            return error_answer(429, "flood", retry_after=seconds, **modes)
        case Unavailable(code):
            if code in RUN_CODES:
                return error_answer(503, code, **modes)  # the run gave no answer: its own code, no Retry-After
            if code == _BUSY:
                return error_answer(503, _BUSY, retry_after=retry_after, **modes)
            if code in _TYPED_503:
                return error_answer(503, _UNAVAILABLE, **modes)
            logger.error(
                "an unavailable verify outcome carried the code %r, which no answer row lists; answered 500 internal",
                code,
                extra={"datum_correlation_id": correlation_id},
            )
            return internal_answer(**modes)
        case _:
            assert_never(outcome)


def certificate_answer(
    chain_pem: str | None, *, problem_details: bool = False, correlation_id: str | None = None
) -> HttpAnswer:
    """Return the server's certificate chain (PEM, leaf first), or 404 `certificate.notFound` when it has no key."""
    if chain_pem is None:
        return error_answer(404, "certificate.notFound", problem_details=problem_details, correlation_id=correlation_id)
    return HttpAnswer(200, {"Content-Type": PEM_MEDIA_TYPE, "Cache-Control": _NO_CACHE}, chain_pem.encode("ascii"))
