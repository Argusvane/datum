"""A `SubmissionOutcome` (and an inspect outcome) to the answer a route writes, held to the catalog.

Refusals go through the answer table (`ANSWER_ROWS`), so a status and code the catalog does not give a submission route
cannot be answered. The one answer built outside the table is a pre-check refusal an application's
`pre_check_statuses` maps to a status with no open row (a 429 above all): no window is known, so it carries no
`Retry-After` (Datum's own 429 `flood` always does). A mapping that raises or answers outside 400 to 599 is the 500
`internal` answer. No answer carries a reason, a hash, the form key or a cause's words.

Libraries: the table's `errors_answer` builds every refusal; `json` writes the success bodies as it writes the
error bodies; `http.HTTPStatus` only names the problem-details title of an outside-the-table status (the table holds
its own titles for every status it has).
"""

import json
import logging
from collections.abc import Callable, Mapping, Sequence
from http import HTTPStatus
from typing import Any, Final, assert_never

from datum_core.hooks import HookProblem
from datum_core.http.answer import HttpAnswer
from datum_core.http.errors import (
    ANSWER_ROWS,
    JSON,
    PROBLEM_JSON,
    RETRY_AFTER,
    ErrorItem,
    _row_for,  # pyright: ignore[reportPrivateUsage] - the table's own lookup, one package
    error_answer,
    errors_answer,
    internal_answer,
)
from datum_core.loggers import ROOT
from datum_core.submissions import (
    Accepted,
    Checked,
    DryRun,
    Inspected,
    InspectOutcome,
    KeyConflict,
    Malformed,
    NotFound,
    Outdated,
    PreCheckStatuses,
    Redelivered,
    Refused,
    Reject,
    Rejected,
    SubmissionNote,
    SubmissionOutcome,
    SubmissionReceipt,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_sandbox.json import JsonValue

__all__ = ["RUN_CODES", "inspect_answer", "submission_answer"]

RUN_CODES: Final = frozenset({"wasm.execution_error", "outcome_too_large", "definition.tooDeep"})
"""A run that gave no verdict: an `Unavailable` with one of these codes answers 503 with the code and NO `Retry-After`
(no verdict is never a 422 that reads as one, never a 500, and retrying a deterministic failure helps nobody). It is
the same on the submit, validate, test and PDF routes (the registered form's own `definition.tooDeep` included) and
on inspect, except that an inspected definition's own `definition.tooDeep` is the caller's: 422, before any run."""
_UNAVAILABLE: Final = 503
_UNPROCESSABLE: Final = 422
_BUSY: Final = "server.busy"
_TOO_DEEP: Final = "definition.tooDeep"
_UNAVAILABLE_CODES: Final = frozenset(code for row in ANSWER_ROWS if row.status == _UNAVAILABLE for code in row.codes)
"""The codes a 503 `Unavailable` may carry: the answer table's listed 503 codes; any other code is the 500 `internal`
answer."""
_LOG: Final = logging.getLogger(ROOT)
"""The 500 answers made here are logged on the root Datum logger (the binding's web logger replaces it)."""

_LOWEST: Final = 400
_HIGHEST: Final = 599
_FLOOD: Final = 429


def submission_answer(  # noqa: PLR0911, PLR0912 - one arm per outcome variant
    outcome: SubmissionOutcome,
    *,
    retry_after: int,
    pre_check_statuses: Callable[[Reject], int] | None = None,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer the table gives `outcome`, the same on the submit, validate and test routes.

    `retry_after` is `datum.web.api.busy_retry_after`, the `Retry-After` of `server.busy`, the one 503 that carries it;
    `pre_check_statuses` maps a pre-check's `Reject` to its status (`PreCheckStatuses.standard()` when `None`). A run
    that gave no verdict (`RUN_CODES`) is a 503 with its code and no `Retry-After`.
    """
    modes: dict[str, Any] = {"problem_details": problem_details, "correlation_id": correlation_id}
    match outcome:
        case Accepted(receipt, submission, warnings):
            return _ok(_receipt_body(receipt, submission.digest, handled=False, warnings=warnings))
        case Redelivered(receipt, digest):
            return _ok(_receipt_body(receipt, digest, handled=True, warnings=()))
        case Checked(accepted, errors, notes=notes):
            body: dict[str, JsonValue] = {"accepted": accepted, "errors": _items(errors)}
            if notes:
                body["notes"] = _notes(notes)
            return _ok(body)
        case DryRun(report=report):
            return _ok(dict(report))
        case Rejected(errors):
            return errors_answer(422, list(errors), **modes)
        case Outdated():
            return error_answer(409, "form.outdated", **modes)
        case KeyConflict():
            return error_answer(409, "submission.keyConflict", **modes)
        case NotFound():
            return error_answer(404, "form.notFound", **modes)
        case Malformed():
            return error_answer(400, "bad_document", **modes)
        case TooLarge():
            return error_answer(413, "bad_document", **modes)
        case Refused(decision):
            return _refused(decision, pre_check_statuses or PreCheckStatuses.standard(), retry_after, modes)
        case Throttled(seconds):
            return error_answer(_FLOOD, "flood", retry_after=seconds, **modes)
        case Unavailable(code):
            return _unavailable(code, retry_after, modes)
        case _:
            assert_never(outcome)


def inspect_answer(
    outcome: InspectOutcome,
    *,
    retry_after: int,
    problem_details: bool = False,
    correlation_id: str | None = None,
) -> HttpAnswer:
    """Return the answer for `SubmissionService.inspect`: the program's answer as it gave it, or the refusal's row.

    The definition an inspect runs is the caller's, never the registered form. A run that gave no answer (the
    sandbox failed or its outcome was too large) is the server's failure: 503 with the run's code, as on the judging
    routes. A definition nested past the depth guard is refused before any run and is the caller's to fix: 422.
    """
    if isinstance(outcome, Inspected):
        return _ok(dict(outcome.answer))
    if isinstance(outcome, Unavailable) and outcome.code == _TOO_DEEP:
        return error_answer(
            _UNPROCESSABLE, outcome.code, problem_details=problem_details, correlation_id=correlation_id
        )
    return submission_answer(
        outcome, retry_after=retry_after, problem_details=problem_details, correlation_id=correlation_id
    )


# -- bodies --------------------------------------------------------------------------------------------------------
def _ok(document: Mapping[str, JsonValue]) -> HttpAnswer:
    text = json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
    return HttpAnswer(200, {"Content-Type": JSON}, text.encode("utf-8"))


def _receipt_body(
    receipt: SubmissionReceipt, digest: str, *, handled: bool, warnings: Sequence[HookProblem]
) -> dict[str, JsonValue]:
    body: dict[str, JsonValue] = {
        "id": receipt.id,
        "reference": receipt.reference,
        "status": "accepted",
        "digest": digest,
        "handled": handled,
    }
    if receipt.receipt is not None:
        body["receipt"] = dict(receipt.receipt)
    if warnings:
        body["warnings"] = [_problem(warning) for warning in warnings]
    return body


def _problem(problem: HookProblem) -> JsonValue:
    item: dict[str, JsonValue] = {"field": problem.field, "code": problem.code}
    if problem.message:
        item["message"] = problem.message
    return item


def _notes(notes: Sequence[SubmissionNote]) -> list[JsonValue]:
    items: list[JsonValue] = []
    for field, code, severity, message in notes:
        item: dict[str, JsonValue] = {} if field is None else {"field": field}
        item["code"] = code
        item["severity"] = severity
        if message:
            item["message"] = message
        items.append(item)
    return items


def _items(errors: Sequence[ErrorItem]) -> list[JsonValue]:
    items: list[JsonValue] = []
    for field, code, message in errors:
        item: dict[str, JsonValue] = {} if field is None else {"field": field}
        item["code"] = code
        if message is not None:
            item["message"] = message
        items.append(item)
    return items


# -- refusals ------------------------------------------------------------------------------------------------------
def _unavailable(code: str, retry_after: int, modes: dict[str, Any]) -> HttpAnswer:
    if code == _BUSY:
        return error_answer(_UNAVAILABLE, code, retry_after=retry_after, **modes)
    if code not in _UNAVAILABLE_CODES:
        _LOG.error(
            "an unavailable outcome carried the code %r, which no answer row lists; answered 500 internal",
            code,
            extra={"datum_correlation_id": modes["correlation_id"]},
        )
        return internal_answer(**modes)
    return error_answer(_UNAVAILABLE, code, **modes)  # no Retry-After: only a busy server says when to come back


def _refused(decision: Reject, mapping: Callable[[Reject], int], retry_after: int, modes: dict[str, Any]) -> HttpAnswer:
    try:
        chosen: object = mapping(decision)
    except Exception as error:
        _LOG.error(
            "the pre_check_statuses mapping raised %s; answered 500 internal",
            type(error).__name__,
            exc_info=True,
            extra={"datum_correlation_id": modes["correlation_id"]},
        )
        return internal_answer(**modes)
    if type(chosen) is not int or not _LOWEST <= chosen <= _HIGHEST:
        _LOG.error(
            "the pre_check_statuses mapping answered %r, outside 400 to 599",
            type(chosen).__name__,
            extra={"datum_correlation_id": modes["correlation_id"]},
        )
        return internal_answer(**modes)
    item: ErrorItem = (None, decision.code, decision.message or None)
    if chosen != _FLOOD:
        try:
            row = _row_for(chosen, decision.code)
        except KeyError:
            pass
        else:
            seconds = retry_after if RETRY_AFTER in row.headers else None
            return errors_answer(chosen, [item], retry_after=seconds, **modes)
    return _outside_the_table(chosen, item, **modes)


def _outside_the_table(
    chosen: int, item: ErrorItem, *, problem_details: bool, correlation_id: str | None
) -> HttpAnswer:
    """Build an application-chosen status the table has no open row for: the same body, no `Retry-After`."""
    field, code, message = item
    entry: dict[str, JsonValue] = {} if field is None else {"field": field}
    entry["code"] = code
    if message is not None:
        entry["message"] = message
    if not problem_details:
        return HttpAnswer(chosen, {"Content-Type": JSON}, _dump({"errors": [entry]}))
    titles = [row.title for row in ANSWER_ROWS if row.status == chosen]
    try:
        title = titles[0] if titles else HTTPStatus(chosen).phrase
    except ValueError:
        title = "Error"
    document: dict[str, JsonValue] = {"type": "about:blank", "title": title, "status": chosen}
    if message is not None:
        document["detail"] = message
    document["code"] = code
    if correlation_id is not None:
        document["correlationId"] = correlation_id
    document["errors"] = [entry]
    return HttpAnswer(chosen, {"Content-Type": PROBLEM_JSON}, _dump(document))


def _dump(document: Mapping[str, JsonValue]) -> bytes:
    return json.dumps(document, separators=(",", ":")).encode("ascii")
