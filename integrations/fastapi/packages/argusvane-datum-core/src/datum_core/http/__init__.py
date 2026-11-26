"""The HTTP-neutral layer: answers, conditional requests, error mapping, admission, correlation and wire models.

Nothing here imports a web framework; a binding turns a request into bytes and a header mapping and writes the
`HttpAnswer` it gets back. The asset catalog (`AssetCatalog`, `AssetFile`, `AssetSource`, `WithheldAssets`,
`NO_CACHE`, `agree_build_ids`) is exported here too; its media table and helpers stay in `datum_core.http.assets`.
The submission answers are `submission_answer` and `inspect_answer` (`datum_core.http.submissions`);
the builder answers are `builder_answer` (`datum_core.http.builder`), with the write-side `If-Match` judgement and
the `X-Datum-Locale-Changes` reader. The timestamp server's admission gate and answers are
`TimestampGate` and its helpers (`datum_core.http.timestamp`); they import the timestamp package's Protocols only.
The PDF operations' admission and answers are `read_pdf_request`, `read_pdf_upload`, `pdf_answer`,
`verify_answer` and `server_certificate_answer` (`datum_core.http.pdf`, where it is `certificate_answer`); they
import the PDF records only when an answer is built, so this package needs no `argusvane-datum-core[pdf]`.
"""

from datum_core.http.admission import (
    JSON_MEDIA_TYPES,
    MAX_BODY_DEPTH,
    BodyBudget,
    BodyTooLargeError,
    Refused,
    admit_body,
    admit_json,
    check_request_headers,
    parse_json_body,
    refuse_too_large,
    refuses_media_type,
)
from datum_core.http.answer import HttpAnswer
from datum_core.http.assets import (
    ASSET_NOT_FOUND,
    NO_CACHE,
    AssetCatalog,
    AssetFile,
    AssetSource,
    WithheldAssets,
    agree_build_ids,
)
from datum_core.http.builder import BUILDER_ROWS, BuilderRow, builder_answer, read_locale_changes
from datum_core.http.conditional import (
    Conditional,
    conditional_answer,
    evaluate_conditional,
    if_match_answer,
    if_match_expected,
    if_range_matches,
)
from datum_core.http.correlation import resolve_correlation_id
from datum_core.http.errors import (
    ANSWER_ROWS,
    DEFAULT_RESPONSE_DESCRIPTION,
    AnswerRow,
    ErrorItem,
    bad_request_answer,
    datum_error_answer,
    error_answer,
    error_envelope_schema,
    errors_answer,
    hook_refusal_answer,
    internal_answer,
    outcome_answer,
)
from datum_core.http.language import preferred_language
from datum_core.http.pdf import (
    FILL_OPERATION,
    PDF_MEDIA_TYPE,
    PDF_PROGRAM_ROWS,
    PdfRequestBody,
    check_pdf_request_headers,
    check_pdf_upload_headers,
    parse_pdf_request,
    pdf_answer,
    read_pdf_request,
    read_pdf_upload,
    verify_answer,
)
from datum_core.http.pdf import certificate_answer as server_certificate_answer
from datum_core.http.submissions import RUN_CODES, inspect_answer, submission_answer
from datum_core.http.timestamp import (
    REPLY_MEDIA_TYPE,
    Admitted,
    TimestampGate,
    answer_for,
    certificate_answer,
    certificates_answer,
    granted_answer,
    refusal_answer,
)
from datum_core.http.wire import DatumWireModel, HostBindingEntry, HostBindingsTable, HostCsrf, HostJson, openapi_extra

__all__ = [
    "ANSWER_ROWS",
    "ASSET_NOT_FOUND",
    "BUILDER_ROWS",
    "DEFAULT_RESPONSE_DESCRIPTION",
    "FILL_OPERATION",
    "JSON_MEDIA_TYPES",
    "MAX_BODY_DEPTH",
    "NO_CACHE",
    "PDF_MEDIA_TYPE",
    "PDF_PROGRAM_ROWS",
    "REPLY_MEDIA_TYPE",
    "RUN_CODES",
    "Admitted",
    "AnswerRow",
    "AssetCatalog",
    "AssetFile",
    "AssetSource",
    "BodyBudget",
    "BodyTooLargeError",
    "BuilderRow",
    "Conditional",
    "DatumWireModel",
    "ErrorItem",
    "HostBindingEntry",
    "HostBindingsTable",
    "HostCsrf",
    "HostJson",
    "HttpAnswer",
    "PdfRequestBody",
    "Refused",
    "TimestampGate",
    "WithheldAssets",
    "admit_body",
    "admit_json",
    "agree_build_ids",
    "answer_for",
    "bad_request_answer",
    "builder_answer",
    "certificate_answer",
    "certificates_answer",
    "check_pdf_request_headers",
    "check_pdf_upload_headers",
    "check_request_headers",
    "conditional_answer",
    "datum_error_answer",
    "error_answer",
    "error_envelope_schema",
    "errors_answer",
    "evaluate_conditional",
    "granted_answer",
    "hook_refusal_answer",
    "if_match_answer",
    "if_match_expected",
    "if_range_matches",
    "inspect_answer",
    "internal_answer",
    "openapi_extra",
    "outcome_answer",
    "parse_json_body",
    "parse_pdf_request",
    "pdf_answer",
    "preferred_language",
    "read_locale_changes",
    "read_pdf_request",
    "read_pdf_upload",
    "refusal_answer",
    "refuse_too_large",
    "refuses_media_type",
    "resolve_correlation_id",
    "server_certificate_answer",
    "submission_answer",
    "verify_answer",
]
