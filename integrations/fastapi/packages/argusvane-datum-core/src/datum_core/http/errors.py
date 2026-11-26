"""The error and answer mapping: one table from (status, code) to an answer, held to the catalog.

The table is data: each `AnswerRow` names a status, the codes that status may carry, the headers its answers may carry
and its RFC 9457 title. `error_answer` builds the body in both modes. Outcomes carry no header or status; the binding
looks an outcome up here. 405, 406 and an unmatched path have no row because the framework answers them.

Libraries: `http.HTTPStatus` supplies phrases that differ between Python
versions ("Request Entity Too Large" before 3.13, "Content Too Large" after), which would change the published
`title` of an answer by interpreter, so the titles are held here; pydantic would add a model where a frozen record does.
"""

import json
import logging
from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass
from typing import Any, Final, assert_never

from datum_core.forms.outcomes import (
    DataSourceNotFound,
    DataSourceUnavailable,
    NotFound,
    TooDeep,
    Unavailable,
)
from datum_core.hooks import HookRefusedError, HookRefusedKind
from datum_core.http.answer import HttpAnswer
from datum_core.loggers import ROOT
from datum_sandbox.protocol._errors import DatumError
from datum_sandbox.wasi import EngineBusyError

DEFAULT_RESPONSE_DESCRIPTION: Final = "a Datum refusal; the codes are the catalog's"
"""The description of the `default` response every Datum operation documents."""

_LOG: Final = logging.getLogger(ROOT)

JSON: Final = "application/json"
PROBLEM_JSON: Final = "application/problem+json"
RETRY_AFTER: Final = "Retry-After"


@dataclass(frozen=True, slots=True)
class AnswerRow:
    """One status of the table: its codes, the headers an answer of it may carry, its title.

    A row with `open_codes` and no codes is the status a hook may refuse with (403, 409, 422), or a pre-check mapped
    to 503 (`PreCheckStatuses.by_suffix()`): any code is accepted.
    """

    status: int
    title: str
    codes: tuple[str, ...] = ()
    headers: tuple[str, ...] = ()
    open_codes: bool = False


ANSWER_ROWS: Final[tuple[AnswerRow, ...]] = (
    AnswerRow(304, "Not Modified", headers=("ETag", "Cache-Control")),
    AnswerRow(
        400, "Bad Request", ("bad_document", "bad_request", "layout.notTemplate", "pdf.notAPdf", "pdf.unreadable")
    ),
    AnswerRow(403, "Forbidden", ("access.denied",)),
    AnswerRow(403, "Forbidden", open_codes=True),
    AnswerRow(404, "Not Found", ("form.notFound", "data_source.notFound", "layout.notFound", "certificate.notFound")),
    AnswerRow(409, "Conflict", ("form.outdated",), headers=("ETag",)),
    AnswerRow(409, "Conflict", ("form.exists",)),
    AnswerRow(409, "Conflict", ("submission.keyConflict",)),
    AnswerRow(409, "Conflict", open_codes=True),
    AnswerRow(413, "Content Too Large", ("bad_document",)),
    AnswerRow(415, "Unsupported Media Type", ("unsupported_media_type",)),
    AnswerRow(
        422,
        "Unprocessable Content",
        ("catalog.invalid", "definition.tooDeep", "definition.tooCostly"),
    ),
    AnswerRow(422, "Unprocessable Content", open_codes=True),
    AnswerRow(429, "Too Many Requests", ("flood",), headers=(RETRY_AFTER,)),
    # `signature`: a seal not made (no server key for a seal that needs one, a handoff not over the file, another
    # algorithm, a signer that raised, a value of no shape, the PDF program's own signing refusal), the program's word
    # for a signing refusal. Like every 500 it carries no message.
    AnswerRow(500, "Internal Server Error", ("internal", "signature")),
    AnswerRow(501, "Not Implemented", ("forms.readOnly",)),
    # `server.busy` is the one answer that carries Retry-After: a retry can help. Every other 503 says nothing of when.
    AnswerRow(503, "Service Unavailable", ("server.busy",), headers=(RETRY_AFTER,)),
    AnswerRow(
        503,
        "Service Unavailable",
        (
            "server.unavailable",
            "validator_unavailable",
            "data_source.unavailable",
            "pdf_unavailable",
            "keys_unavailable",
            # The signing capability is not set up (a signed wrapper without it).
            "signing.not_set_up",
            # A run over a registered form that gave no verdict (submit, validate, test, the PDF routes, inspect): the
            # server's failure and no judgement of the answers, so never a 422. The same run fails the same way.
            "wasm.execution_error",
            "outcome_too_large",
            "definition.tooDeep",
        ),
    ),
    # A pre-check's own code under `PreCheckStatuses.by_suffix()` (`.unavailable`): any code, no Retry-After.
    AnswerRow(503, "Service Unavailable", open_codes=True),
)


def _row_for(status: int, code: str) -> AnswerRow:
    """Return the row naming `code` at `status`, else the status's open row (a hook's code); `KeyError` if neither."""
    rows = [row for row in ANSWER_ROWS if row.status == status]
    for row in rows:
        if code in row.codes:
            return row
    for row in rows:
        if row.open_codes:
            return row
    raise KeyError(f"no answer row for {status} {code!r}")


def _listed_row(status: int, code: str) -> AnswerRow:
    """Return the row that LISTS `code` at `status`; `KeyError` if none does (an open row is a hook's, not a code's)."""
    for row in ANSWER_ROWS:
        if row.status == status and code in row.codes:
            return row
    raise KeyError(f"no row lists {status} {code!r}")


def _item(code: str, field: str | None, message: str | None) -> dict[str, str]:
    item = {} if field is None else {"field": field}
    item["code"] = code
    if message is not None:
        item["message"] = message
    return item


def _dump(document: dict[str, Any]) -> bytes:
    return json.dumps(document, separators=(",", ":")).encode("ascii")


type ErrorItem = tuple[str | None, str, str | None]
"""One error of a body: (component id or None, code, host-worded message or None)."""


def errors_answer(
    status: int,
    items: Sequence[ErrorItem],
    *,
    retry_after: int | None = None,
    etag: str | None = None,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer the table gives `status` for `items`; `KeyError` when a (status, code) pair has no row.

    The default body is `{"errors":[{field?, code, message?}, ...]}`; with `problem_details` it is RFC 9457
    `application/problem+json` (`type`, `title`, `status`, `detail`, `code`, `correlationId`, `errors`), where `code`
    and `detail` are the first item's. A row that lists `Retry-After` needs `retry_after` in whole seconds and a row
    that does not refuses one; `etag` is accepted where the row lists `ETag`. A 500 never carries `field` or `message`
    (nothing a caller passes can reach the client), and the correlation id reaches the client only as `correlationId`
    in problem mode. An empty `items` is a `ValueError`.
    """
    if not items:
        raise ValueError("an error answer carries at least one item")
    rows = [_row_for(status, code) for _, code, _ in items]
    row = rows[0]
    headers = {"Content-Type": PROBLEM_JSON if problem_details else JSON}
    if RETRY_AFTER in row.headers:
        if retry_after is None or type(retry_after) is not int or retry_after < 0:
            raise ValueError(f"{status} {items[0][1]} needs Retry-After in whole seconds")
        headers[RETRY_AFTER] = str(retry_after)
    elif retry_after is not None:
        raise ValueError(f"{status} {items[0][1]} does not carry Retry-After")
    if etag is not None:
        if "ETag" not in row.headers:
            raise ValueError(f"{status} {items[0][1]} does not carry an ETag")
        headers["ETag"] = etag
    if status == 500:  # noqa: PLR2004 -- the one status whose text never reaches the client
        items = [(None, code, None) for _, code, _ in items]
    bodies = [_item(code, field, message) for field, code, message in items]
    if not problem_details:
        return HttpAnswer(status, headers, _dump({"errors": bodies}))
    document: dict[str, Any] = {"type": "about:blank", "title": row.title, "status": status}
    if items[0][2] is not None:
        document["detail"] = items[0][2]
    document["code"] = items[0][1]
    if correlation_id is not None:
        document["correlationId"] = correlation_id
    document["errors"] = bodies
    return HttpAnswer(status, headers, _dump(document))


def error_answer(
    status: int,
    code: str,
    *,
    field: str | None = None,
    message: str | None = None,
    retry_after: int | None = None,
    etag: str | None = None,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer the table gives (`status`, `code`): `errors_answer` with one item."""
    return errors_answer(
        status,
        [(field, code, message)],
        retry_after=retry_after,
        etag=etag,
        problem_details=problem_details,
        correlation_id=correlation_id,
    )


def internal_answer(*, problem_details: bool = False, correlation_id: str | None = None) -> HttpAnswer:
    """Return the 500 `internal` answer: no field, no message."""
    return error_answer(500, "internal", problem_details=problem_details, correlation_id=correlation_id)


def bad_request_answer(field: str, *, problem_details: bool = False, correlation_id: str | None = None) -> HttpAnswer:
    """Return the 400 `bad_request` answer for a path or query parameter named `field`.

    It takes only the parameter name, never a validation error's `input`, `ctx` or `msg`, so the binding never touches
    the values of a pydantic `ValidationError`; any log of one uses `errors(include_input=False)`.
    """
    return error_answer(
        400,
        "bad_request",
        field=field,
        message=f"{field} is not valid",
        problem_details=problem_details,
        correlation_id=correlation_id,
    )


def outcome_answer(
    outcome: NotFound | Unavailable | TooDeep | DataSourceNotFound | DataSourceUnavailable,
    *,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer for a refusing outcome of the forms services (served outcomes stay the route's)."""
    match outcome:
        case NotFound():
            return error_answer(404, "form.notFound", problem_details=problem_details, correlation_id=correlation_id)
        case Unavailable():
            return error_answer(
                503,
                "server.unavailable",
                problem_details=problem_details,
                correlation_id=correlation_id,
            )
        case TooDeep():
            return error_answer(
                422, "definition.tooDeep", problem_details=problem_details, correlation_id=correlation_id
            )
        case DataSourceNotFound():
            return error_answer(
                404, "data_source.notFound", problem_details=problem_details, correlation_id=correlation_id
            )
        case DataSourceUnavailable():
            return error_answer(
                503,
                "data_source.unavailable",
                problem_details=problem_details,
                correlation_id=correlation_id,
            )
        case _:
            assert_never(outcome)


_HOOK_STATUS: Final = {
    HookRefusedKind.FORBIDDEN: 403,
    HookRefusedKind.CONFLICT: 409,
    HookRefusedKind.INVALID: 422,
}


def hook_refusal_answer(
    error: HookRefusedError, *, problem_details: bool = False, correlation_id: str | None = None
) -> HttpAnswer:
    """Return the 403, 409 or 422 a hook's refusal answers, every problem as one `errors` item in order."""
    items = [(problem.field, problem.code, problem.message or None) for problem in error.problems]
    return errors_answer(
        _HOOK_STATUS[error.kind], items, problem_details=problem_details, correlation_id=correlation_id
    )


def datum_error_answer(
    error: DatumError | EngineBusyError,
    *,
    retry_after: int,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer for a `DatumError` (its own code and status) or a busy engine (503 `server.busy`).

    Only a pair a row LISTS is answered: the open 403/409/422/503 rows belong to a hook's own codes, never to a
    `DatumError`'s. Any other pair (an unknown code) answers `internal_answer` and logs the code, never a
    `KeyError`.
    """
    if isinstance(error, EngineBusyError):
        return error_answer(
            503, "server.busy", retry_after=retry_after, problem_details=problem_details, correlation_id=correlation_id
        )
    try:
        row = _listed_row(error.status, error.code)
    except KeyError:
        _LOG.error(
            "a %s carried %d %r, which no answer row lists; answered 500 internal",
            type(error).__name__,
            error.status,
            error.code,
            extra={"datum_correlation_id": correlation_id},
        )
        return internal_answer(problem_details=problem_details, correlation_id=correlation_id)
    return error_answer(
        error.status,
        error.code,
        message=error.message,
        retry_after=retry_after if RETRY_AFTER in row.headers else None,
        problem_details=problem_details,
        correlation_id=correlation_id,
    )


# -- the schema of the `default` response ------------------------------------------------------------------------------

_ERROR_ITEM: Final[dict[str, Any]] = {
    "type": "object",
    "description": "One error: the component id it belongs to (null when none), a stable code, and host-worded text.",
    "properties": {
        "field": {"type": ["string", "null"], "description": "The component id, or null."},
        "code": {"type": "string", "description": "Stable machine code, for example form.outdated."},
        "message": {
            "type": "string",
            "description": "Optional text for a person: a hook's own, or the form's wording. Absent when none.",
        },
    },
    "required": ["code"],
}
_ERRORS_BODY: Final[dict[str, Any]] = {
    "type": "object",
    "description": "An error answer: {errors:[{field, code, message?}]}.",
    "properties": {"errors": {"type": "array", "items": _ERROR_ITEM}},
    "required": ["errors"],
}
_PROBLEM_DETAIL: Final[dict[str, Any]] = {
    "type": "object",
    "description": "RFC 9457 problem details with the same codes (datum.web.api.problem_details=true).",
    "properties": {
        "type": {"type": "string", "example": "about:blank"},
        "title": {"type": "string"},
        "status": {"type": "integer"},
        "detail": {"type": "string"},
        "code": {"type": "string"},
        "correlationId": {"type": "string", "description": "Names the log entry of a 500."},
        "errors": {"type": "array", "items": _ERROR_ITEM},
    },
}


def error_envelope_schema(*, problem_details: bool = False) -> dict[str, Any]:
    """Return the JSON schema of the error body in the mode the setting selects, with no `$ref` (a fresh copy).

    The binding puts it under `responses["default"]` of every Datum operation; one shape per document.
    """
    return deepcopy(_PROBLEM_DETAIL if problem_details else _ERRORS_BODY)
