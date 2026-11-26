"""A `BuilderOutcome` to the answer a route writes, held to the shared catalog.

`BUILDER_ROWS` is the one table: for each outcome variant, the (status, code, headers) rows its answers may be. A test
holds it to the three builder operations of the endpoint catalog and its default responses, and `builder_answer` takes
the status and code of every plain refusal from it, so the two cannot drift apart.

Every answer is `Cache-Control: no-store`. `ETag` rides the 200, the 201 and the 409 `form.outdated` (the current
tag, never a hash in the body) and not `form.exists`; `Location` the 201; `X-Datum-Removed-Locales` the save 200 only.
No answer is a 412 or a 304. A code no row lists (a `Refused` or an `Unavailable` carrying one) is the 500 `internal`
answer, logged by code alone, the same gate as the submissions answers. No answer carries a reason, a cause's words,
a hash outside the `ETag`, a key, or a definition's text; a 500 carries no field or message.

The write-side evaluation of `If-Match` (`if_match_answer`, `if_match_expected`) lives in `datum_core.http.conditional`
and is re-exported here; `read_locale_changes` reads the bounded `X-Datum-Locale-Changes` header.

Libraries: the standard library `dataclasses` holds a frozen record, `json` writes the
bodies, `datum_sandbox.json.read` is the bounded reader the header goes through (depth, non-finite numbers, lone
surrogates), and the error table (`errors_answer`, `hook_refusal_answer`) builds every refusal; no library covers a
row of a catalog-held table.
"""

import copy
import json
import logging
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Any, Final, assert_never, cast

from datum_core.builder import (
    BuilderOutcome,
    CatalogOutdated,
    CatalogSaved,
    Declined,
    Exists,
    LocaleChanges,
    Malformed,
    NotFound,
    Outdated,
    ReadOnly,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.hooks import HookProblem, HookRefusedKind
from datum_core.http.answer import HttpAnswer
from datum_core.http.conditional import if_match_answer, if_match_expected
from datum_core.http.errors import (
    JSON,
    ErrorItem,
    error_answer,
    errors_answer,
    hook_refusal_answer,
    internal_answer,
)
from datum_core.loggers import ROOT
from datum_core.stores import CatalogView
from datum_sandbox.json import BadDocumentError, JsonValue, read

__all__ = [
    "BUILDER_ROWS",
    "LOCALE_CHANGES_HEADER",
    "MAX_LOCALE_CHANGES_BYTES",
    "BuilderRow",
    "builder_answer",
    "if_match_answer",
    "if_match_expected",
    "read_locale_changes",
]

_LOG: Final = logging.getLogger(ROOT)
NO_STORE: Final = "no-store"
_ETAG: Final = "ETag"
_LOCATION: Final = "Location"
_REMOVED: Final = "X-Datum-Removed-Locales"
_KERNEL_FINDING_WHERE: Final = "definition"
"""Where a finding that names no component is placed."""


@dataclass(frozen=True, slots=True)
class BuilderRow:
    """One answer an outcome variant may be.

    Its status, the code it carries (`None`: any a hook or finding names) and the catalog-visible headers it may carry.
    """

    status: int
    code: str | None = None
    headers: tuple[str, ...] = ()


BUILDER_ROWS: Final[Mapping[type, tuple[BuilderRow, ...]]] = {
    Saved: (BuilderRow(200, None, (_ETAG, _REMOVED)), BuilderRow(201, None, (_ETAG, _LOCATION))),
    CatalogSaved: (BuilderRow(200, None, (_ETAG,)),),
    Outdated: (BuilderRow(409, "form.outdated", (_ETAG,)),),
    CatalogOutdated: (BuilderRow(409, "form.outdated", (_ETAG,)),),
    Refused: (BuilderRow(422),),
    ReadOnly: (BuilderRow(501, "forms.readOnly"),),
    Exists: (BuilderRow(409, "form.exists"),),
    NotFound: (BuilderRow(404, "form.notFound"),),
    Malformed: (BuilderRow(400, "bad_document"),),
    TooLarge: (BuilderRow(413, "bad_document"),),
    Unavailable: (BuilderRow(503, "server.unavailable"),),
    Declined: (BuilderRow(403), BuilderRow(409), BuilderRow(422)),
}
"""The builder answer table. Held to `integrations/shared/endpoint-catalog.json` by `test_http_builder.py`."""

_REFUSED_CODES: Final = frozenset(
    {"definition.refused", "definition.tooDeep", "definition.tooCostly", "catalog.invalid"}
)
"""The four codes a `Refused` may carry (the first code of its body is a finding's, so its row names none)."""
_ONE_ERROR_CODES: Final = frozenset({"definition.tooDeep", "definition.tooCostly"})
_UNAVAILABLE_CODES: Final = {row.code for row in BUILDER_ROWS[Unavailable] if row.code is not None}


def _row(variant: type, status: int | None = None) -> BuilderRow:
    return next(row for row in BUILDER_ROWS[variant] if status is None or row.status == status)


def builder_answer(  # noqa: PLR0911, PLR0912 - one arm per outcome variant
    outcome: BuilderOutcome,
    *,
    problem_details: bool = False,
    correlation_id: str | None = None,
    api_base: str = "/api",
) -> HttpAnswer:
    """Return the answer the table gives `outcome`.

    `api_base` is the prefix of the router that served the write, the base of the `Location` of a create. No builder
    answer carries `Retry-After`: the check is deterministic and a save is retried by its author.
    """
    modes: dict[str, Any] = {"problem_details": problem_details, "correlation_id": correlation_id}
    match outcome:
        case Saved():
            return _saved(outcome, api_base)
        case CatalogSaved(_, etag, catalog, saved_at):
            body: dict[str, JsonValue] = {"catalog": _catalog(catalog), "savedAt": saved_at.isoformat()}
            return HttpAnswer(200, {"Content-Type": JSON, _ETAG: etag, "Cache-Control": NO_STORE}, _dump(body))
        case Outdated(current_sha256, _):
            return _refusal(_row(Outdated), modes, etag=f'"{current_sha256}"')
        case CatalogOutdated(current_etag):
            return _refusal(_row(CatalogOutdated), modes, etag=current_etag)
        case Refused():
            return _refused(outcome, modes)
        case ReadOnly():
            return _plain(ReadOnly, modes)
        case Exists():
            return _plain(Exists, modes)
        case NotFound():
            return _plain(NotFound, modes)
        case Malformed():
            return _plain(Malformed, modes)
        case TooLarge():
            return _plain(TooLarge, modes)
        case Unavailable(code):
            if code not in _UNAVAILABLE_CODES:
                _LOG.error(
                    "an unavailable builder outcome carried the code %r, which no row lists; answered 500 internal",
                    code,
                    extra={"datum_correlation_id": correlation_id},
                )
                return _no_store(internal_answer(**modes))
            return _refusal(_row(Unavailable), modes)
        case Declined(refusal):
            reply = hook_refusal_answer(refusal, **modes)
            if refusal.kind is HookRefusedKind.INVALID:
                reply = _with(reply, {"kernel": _kernel(refusal.problems)})
            return _no_store(reply)
        case _:
            assert_never(outcome)


# -- bodies -----------------------------------------------------------------------------------------------------------
def _dump(document: Mapping[str, JsonValue]) -> bytes:
    return json.dumps(document, ensure_ascii=False, allow_nan=False, separators=(",", ":")).encode("utf-8")


def _catalog(catalog: CatalogView) -> dict[str, JsonValue]:
    return cast("dict[str, JsonValue]", copy.deepcopy(catalog))


def _saved(outcome: Saved, api_base: str) -> HttpAnswer:
    document: dict[str, JsonValue] = {
        "key": outcome.key,
        "version": outcome.version,
        "sha256": outcome.sha256,
        "savedAt": outcome.saved_at.isoformat(),
        "catalog": _catalog(outcome.catalog),
        "warnings": list(outcome.warnings),
        "kernelWarnings": _kernel(outcome.kernel_warnings),
        "removedLocales": list(outcome.removed_locales),
    }
    headers = {"Content-Type": JSON, _ETAG: f'"{outcome.sha256}"', "Cache-Control": NO_STORE}
    if outcome.created:
        headers[_LOCATION] = f"{api_base}/forms/{outcome.key}/definition?public=false"
    elif outcome.removed_locales:
        headers[_REMOVED] = ", ".join(outcome.removed_locales)
    return HttpAnswer(201 if outcome.created else 200, headers, _dump(document))


def _kernel(problems: Sequence[HookProblem]) -> list[JsonValue]:
    return [{"code": problem.code, "where": problem.field or _KERNEL_FINDING_WHERE} for problem in problems]


def _items(problems: Sequence[HookProblem]) -> list[ErrorItem]:
    return [(None, problem.code, problem.message or None) for problem in problems]


# -- refusals ---------------------------------------------------------------------------------------------------------
def _no_store(reply: HttpAnswer) -> HttpAnswer:
    return HttpAnswer(reply.status, {**reply.headers, "Cache-Control": NO_STORE}, reply.body)


def _with(reply: HttpAnswer, extra: Mapping[str, JsonValue]) -> HttpAnswer:
    """Return `reply` with `extra` members added to its JSON body (the body is the table's own, so it is small)."""
    document: dict[str, JsonValue] = json.loads(reply.body)
    document.update(extra)
    return HttpAnswer(reply.status, reply.headers, json.dumps(document, separators=(",", ":")).encode("ascii"))


def _refusal(row: BuilderRow, modes: dict[str, Any], *, etag: str | None = None) -> HttpAnswer:
    """Answer a plain row: its status and named code, the `etag` it carries, no-store."""
    if row.code is None:
        raise ValueError(f"the {row.status} row names no code")
    return _no_store(error_answer(row.status, row.code, etag=etag, **modes))


def _plain(variant: type, modes: dict[str, Any]) -> HttpAnswer:
    return _refusal(_row(variant), modes)


def _refused(outcome: Refused, modes: dict[str, Any]) -> HttpAnswer:
    if outcome.code not in _REFUSED_CODES:
        _LOG.error(
            "a refused builder outcome carried the code %r, which no row lists; answered 500 internal",
            outcome.code,
            extra={"datum_correlation_id": modes["correlation_id"]},
        )
        return _no_store(internal_answer(**modes))
    status = _row(Refused).status
    if outcome.code in _ONE_ERROR_CODES:
        return _no_store(errors_answer(status, [(None, outcome.code, None)], **modes))
    items: list[ErrorItem]
    if outcome.code == "catalog.invalid":
        # The catalog's 422 is closed: every item carries the listed code, the messages stay.
        items = [(p.field, "catalog.invalid", p.message or None) for p in outcome.errors] or [
            (None, "catalog.invalid", None)
        ]
    else:
        items = _items(outcome.errors) or [(None, outcome.code, None)]
    reply = errors_answer(status, items, **modes)
    if outcome.code == "definition.refused":
        reply = _with(reply, {"kernel": _kernel(outcome.errors)})
    return _no_store(reply)


# -- X-Datum-Locale-Changes -------------------------------------------------------------------------------------------
LOCALE_CHANGES_HEADER: Final = "X-Datum-Locale-Changes"
"""The request header a save carries its language changes in."""
MAX_LOCALE_CHANGES_BYTES: Final = 8192
"""A longer `X-Datum-Locale-Changes` value is `Malformed` without being parsed."""
_MAX_NESTING: Final = 16
_BAD_HEADER: Final = "The language changes are not in the documented shape."


def read_locale_changes(header: str | None) -> LocaleChanges | Malformed:
    """Read the `X-Datum-Locale-Changes` value: `{"removed": [code, ...], "renamed": [{"from", "to"}, ...]}`.

    An absent or blank header is no change. Anything else is bounded (8 KiB, nesting 16, at most 64 locales named),
    read through the bounded JSON reader, and must be exactly that shape; unknown members are ignored. The `Malformed`
    reason is fixed words, never the header.
    """
    if header is None or not header.strip():
        return LocaleChanges()
    try:
        return _changes(read(_bounded(header), max_depth=_MAX_NESTING))
    except (BadDocumentError, UnicodeEncodeError, TypeError, ValueError):
        return Malformed(_BAD_HEADER)


def _bounded(header: str) -> bytes:
    raw = header.encode("utf-8")
    if len(raw) > MAX_LOCALE_CHANGES_BYTES:
        raise ValueError("over the bound")
    return raw


def _strings(value: object) -> tuple[str, ...]:
    if not isinstance(value, list) or not all(isinstance(item, str) for item in cast("list[object]", value)):
        raise TypeError("not a list of codes")
    return tuple(cast("list[str]", value))


def _pair(value: object) -> tuple[str, str]:
    if not isinstance(value, dict):
        raise TypeError("not a rename")
    old, new = cast("dict[str, object]", value).get("from"), cast("dict[str, object]", value).get("to")
    if not isinstance(old, str) or not isinstance(new, str):
        raise TypeError("not a rename")
    return old, new


def _changes(document: JsonValue) -> LocaleChanges:
    """Build the changes from the decoded header; any departure from the shape is a `TypeError` or `ValueError`."""
    if not isinstance(document, dict):
        raise TypeError("not an object")
    renamed = document.get("renamed", [])
    if not isinstance(renamed, list):
        raise TypeError("not a list of renames")
    return LocaleChanges(removed=_strings(document.get("removed", [])), renamed=tuple(_pair(item) for item in renamed))
