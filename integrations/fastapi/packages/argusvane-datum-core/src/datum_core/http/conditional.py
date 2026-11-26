"""The conditional-request helper.

RFC 9110 section 13 for definitions, translations, assets and builder writes. No framework import; `FileResponse`
never answers 304, this does.

The entity-tag list parser is hand written to the RFC 9110 grammar on purpose. No library reproduces the contract's
cases (empty list elements ignored, an unparseable `If-None-Match` is no hit while an unparseable `If-Match` is a
failure, a comma inside a tag is one tag), and `email.utils`, `werkzeug` or `starlette` each split on commas first.
Dates use `email.utils.parsedate_to_datetime` (the standard library) and are compared at whole seconds.

Repeated field lines of `If-Match` and `If-None-Match` combine into one list (RFC 9110 5.3) when the mapping offers
`getlist`. The method token is case-sensitive: only exactly `GET` and `HEAD` are safe.

Order (RFC 9110 13.2.2): `If-Match`; else `If-Unmodified-Since`; then `If-None-Match`; else `If-Modified-Since`
(GET and HEAD only); `Range` last, through `if_range_matches`. A failed `If-Match` is the contract's 409
`form.outdated`, not 412 (a stated deviation).

Writes (`if_match_answer`, `if_match_expected`) judge `If-Match` alone: an absent header and `*` (over an existing form)
are the same unconditional save, a present value that is empty, weak, unparseable or stale is the 409 with the current
`ETag`.
`If-None-Match` and the date headers are never read on a write, so a write is never answered 412.
"""

import enum
import re
from collections.abc import Mapping
from datetime import UTC, datetime
from email.utils import parsedate_to_datetime
from typing import Final

from datum_core.http._headers import header, header_list
from datum_core.http.answer import HttpAnswer
from datum_core.http.errors import error_answer

__all__ = [
    "Conditional",
    "conditional_answer",
    "evaluate_conditional",
    "if_match_answer",
    "if_match_expected",
    "if_range_matches",
]


class Conditional(enum.Enum):
    """What the preconditions decided."""

    PROCEED = "proceed"
    NOT_MODIFIED = "not_modified"
    PRECONDITION_FAILED = "precondition_failed"
    IF_MATCH_FAILED = "if_match_failed"


type _Tag = tuple[bool, str]  # (weak, opaque tag including its quotes)

# entity-tag = [ weak ] opaque-tag; opaque-tag = DQUOTE *etagc DQUOTE; etagc = %x21 / %x23-7E / obs-text
_TAG: Final = re.compile(r'(W/)?("[\x21\x23-\x7e\x80-\xff]*")')
_OWS: Final = " \t"
_SAFE_METHODS: Final = frozenset({"GET", "HEAD"})


def _parse_tag(text: str) -> _Tag | None:
    match = _TAG.fullmatch(text)
    return None if match is None else (match.group(1) is not None, match.group(2))


def _parse_list(value: str) -> list[_Tag] | None:
    """Parse `#entity-tag`: the tags, or `None` when the value is not that grammar. Empty elements are ignored."""
    tags: list[_Tag] = []
    position, end = 0, len(value)
    while True:
        while position < end and value[position] in _OWS + ",":
            position += 1
        if position == end:
            return tags
        match = _TAG.match(value, position)
        if match is None:
            return None
        tags.append((match.group(1) is not None, match.group(2)))
        position = match.end()
        while position < end and value[position] in _OWS:
            position += 1
        if position < end and value[position] != ",":
            return None


def _matches(listed: list[_Tag], current: _Tag, *, strong: bool) -> bool:
    if current[0] and strong:
        return False
    return any(tag[1] == current[1] and not (strong and tag[0]) for tag in listed)


def _date(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    return (parsed if parsed.tzinfo else parsed.replace(tzinfo=UTC)).replace(microsecond=0)


def _seconds(moment: datetime | None) -> datetime | None:
    if moment is None:
        return None
    return (moment if moment.tzinfo else moment.replace(tzinfo=UTC)).replace(microsecond=0)


def _current_tag(etag: str | None) -> _Tag | None:
    if etag is None:
        return None
    current = _parse_tag(etag)
    if current is None:
        raise ValueError(f"the current ETag is not an entity-tag: {etag!r}")
    return current


def evaluate_conditional(
    method: str, headers: Mapping[str, str], etag: str | None, *, last_modified: datetime | None = None
) -> Conditional:
    """Judge the request's preconditions against the current representation.

    `etag` is the current entity-tag with its quotes (`None`: no representation exists); `last_modified` is optional
    and a date header is ignored without it. HEAD is judged like GET.
    """
    current = _current_tag(etag)
    modified = _seconds(last_modified)
    read = method in _SAFE_METHODS  # the token is case-sensitive (RFC 9110 9.1): only exact GET and HEAD

    if_match = header_list(headers, "If-Match")
    if if_match is not None:
        if not _if_match_holds(if_match, current):
            return Conditional.IF_MATCH_FAILED
    elif modified is not None:
        since = _date(header(headers, "If-Unmodified-Since"))
        if since is not None and modified > since:
            return Conditional.IF_MATCH_FAILED

    if_none_match = header_list(headers, "If-None-Match")
    if if_none_match is not None:
        if _if_none_match_hits(if_none_match, current):
            return Conditional.NOT_MODIFIED if read else Conditional.PRECONDITION_FAILED
    elif read and modified is not None:
        since = _date(header(headers, "If-Modified-Since"))
        if since is not None and modified <= since:
            return Conditional.NOT_MODIFIED
    return Conditional.PROCEED


def _if_match_holds(value: str, current: _Tag | None) -> bool:
    if current is None:
        return False
    if value.strip(_OWS) == "*":
        return True
    listed = _parse_list(value)
    return listed is not None and _matches(listed, current, strong=True)


def _if_none_match_hits(value: str, current: _Tag | None) -> bool:
    if current is None:
        return False
    if value.strip(_OWS) == "*":
        return True
    listed = _parse_list(value)
    return listed is not None and _matches(listed, current, strong=False)


def if_range_matches(headers: Mapping[str, str], etag: str | None, *, last_modified: datetime | None = None) -> bool:
    """Say whether a `Range` request may be honoured: no `If-Range`, a strong match, or the exact `Last-Modified` date.

    A weak tag, an unreadable value, or a date with no `last_modified` never matches (the file is sent whole).
    """
    value = header(headers, "If-Range")
    if value is None:
        return True
    value = value.strip(_OWS)
    asked = _parse_tag(value)
    if asked is not None:
        current = _current_tag(etag)
        return current is not None and not asked[0] and not current[0] and asked[1] == current[1]
    since, modified = _date(value), _seconds(last_modified)
    return since is not None and modified is not None and since == modified


def conditional_answer(
    verdict: Conditional, *, etag: str | None, cache_control: str, problem_details: bool = False
) -> HttpAnswer | None:
    """Return the answer a verdict calls for, or `None` for PROCEED.

    NOT_MODIFIED is a 304 with `ETag` and `Cache-Control` and no body; PRECONDITION_FAILED a bodiless 412 with the
    `ETag`; IF_MATCH_FAILED the contract's 409 `form.outdated` carrying the current `ETag`.
    """
    match verdict:
        case Conditional.PROCEED:
            return None
        case Conditional.NOT_MODIFIED:
            headers = {"Cache-Control": cache_control}
            return HttpAnswer(304, headers if etag is None else {"ETag": etag, **headers})
        case Conditional.PRECONDITION_FAILED:
            return HttpAnswer(412, {} if etag is None else {"ETag": etag})
        case Conditional.IF_MATCH_FAILED:
            return error_answer(409, "form.outdated", etag=etag, problem_details=problem_details)


_NO_STORE: Final = "no-store"


def if_match_answer(
    headers: Mapping[str, str], etag: str | None, *, problem_details: bool = False, correlation_id: str | None = None
) -> HttpAnswer | None:
    """Judge the `If-Match` of a write against the current `etag`: `None` to proceed, else the 409 `form.outdated`.

    Only `If-Match` is read. An absent header proceeds (the write is as sent); a present one proceeds when it holds
    the current strong tag or `*` over an existing representation. The 409 carries the current `ETag` (and none when
    no representation exists), never a hash in its body, and `Cache-Control: no-store`; it is never a 412.
    """
    value = header_list(headers, "If-Match")
    if value is None or _if_match_holds(value, _current_tag(etag)):
        return None
    refusal = error_answer(
        409, "form.outdated", etag=etag, problem_details=problem_details, correlation_id=correlation_id
    )
    return HttpAnswer(refusal.status, {**refusal.headers, "Cache-Control": _NO_STORE}, refusal.body)


def if_match_expected(headers: Mapping[str, str], etag: str | None) -> str | None:
    """Return the hash a write that `if_match_answer` let through is judged against, or `None` for a write as sent.

    An absent `If-Match` and `*` are the same unconditional save (`None`: the service serialises it under its lock and
    every racer wins in turn). A present list is a compare-and-set against the current tag without its quotes: the
    definition's bare sha256, the `expected_sha256` of `BuilderService.save`. It is not the catalog's value: the
    translation route passes the ETag it served, quoted, to `save_translations(expected_etag=)` for a present hash
    (absent or `*`: `None`, the unconditional save).
    """
    value = header_list(headers, "If-Match")
    if etag is None or value is None or value.strip(_OWS) == "*":
        return None
    return etag.strip('"')
