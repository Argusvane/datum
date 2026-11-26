"""`routers.builder`: `createForm`, `saveForm`, `saveFormTranslations` (catalog tag `datum-ui`) and the author's copy.

Privileged: `dependencies` is a required keyword (`dependencies=[]` is the explicit opt-out) and the application's
dependencies run before the started guard, so a caller the application refuses gets its 401 or 403 before any existence
check, body read or kernel run. Every route is registered only with `datum.builder.enabled` (and `datum.enabled`); a
router built with the switch off holds no route and Datum's start names it (`datum.W001`).

`PUT {api}/forms/{key}` answers in this order: 404 for a form nobody has, 415 and 413 from the capped body read
(`datum.builder.max_definition_size`), 409 `form.outdated` with the current `ETag` from `If-Match` (only `If-Match`
is read: an absent one and `*` are the unconditional save), 400 for a body that is not strict JSON, then the
service's answer.
`POST {api}/forms` has no existence step and no precondition (a stray `If-Match` is not read). `PUT
{api}/forms/{key}/translations` follows the save's order against the catalog's `ETag` (the ETag of `{}` for a form with
no catalog) and takes the catalog bare or as `{"catalog": catalog}`. The author's copy, `GET
{api}/forms/{key}/definition?public=false` (the contract's path), is served by an `AuthorCopyRoute`, which takes only
a `public=false` query, while the public route yields it (`PublicCopyRoute`): the include order never matters, and
the route is hidden from every OpenAPI document. Every answer, refusals included, is `Cache-Control: no-store`; the 503s
`DatumRoute` maps from the runner (busy, unavailable) are the shared mapping's.

The service decides nothing about who builds: the principal (`datum.principal`) reaches the hooks only. A write is ONE
tracked call of the runner (the hooks, the kernel's check, the store, the saved event), so a client that leaves after
the body was read cancels nothing. This module holds no status code, no wire code and no JSON call.
"""

from typing import TYPE_CHECKING, Annotated, Any, Final

from fastapi import APIRouter, Depends, Request, Response

from datum_core.builder import BuilderOutcome, LocaleChanges, Malformed
from datum_core.builder import NotFound as FormNotFound
from datum_core.builder.catalog import CATALOG_KINDS
from datum_core.forms import Served, TranslationsServed, parse_form_key
from datum_core.http import (
    HttpAnswer,
    Refused,
    builder_answer,
    conditional_answer,
    evaluate_conditional,
    if_match_answer,
    if_match_expected,
    parse_json_body,
    read_locale_changes,
    resolve_correlation_id,
)
from datum_core.http.builder import LOCALE_CHANGES_HEADER
from datum_fastapi.body import read_bounded_body
from datum_fastapi.openapi import add_group_document, operation_options
from datum_fastapi.routers._factory import Dependencies, capability_router, privileged
from datum_fastapi.routers._intake import off_loop
from datum_fastapi.routing import AnswerError, AuthorCopyRoute, route_class_for, write
from datum_sandbox.json import JsonValue

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["builder"]

_JSON: Final = "application/json"
_NO_STORE: Final = "no-store"
_CACHE_CONTROL: Final = "Cache-Control"
_ETAG: Final = "ETag"
_CATALOG: Final = "catalog"
_AUTHOR_COPY: Final = "getFormAuthorCopy"
"""The hidden author-copy route's operation id (in no document; the catalog's ids are the other three)."""


def _no_store(answer: HttpAnswer) -> HttpAnswer:
    """Return `answer` with `Cache-Control: no-store` (a route-level refusal of a builder route)."""
    return HttpAnswer(answer.status, {**answer.headers, _CACHE_CONTROL: _NO_STORE}, answer.body)


def _plain_key(key: str) -> bool:
    """Whether `key` is a plain form key (no `@version`): the only key a write names."""
    parsed = parse_form_key(key)
    return parsed is not None and parsed[1] is None


def _catalog_of(document: JsonValue) -> JsonValue:
    """Return the catalog a body carries: `{"catalog": catalog}` unwrapped, else the body itself.

    A body whose one member is `catalog` holding an object of objects is the wrapped form (the page sends it), unless
    that inner object's keys are all kinds (`form`, `components`, ...): then `catalog` is a locale code and the body is
    a bare catalog. The two readings of `{"catalog": {}}` are the same empty catalog.
    """
    if isinstance(document, dict) and len(document) == 1:
        inner = document.get(_CATALOG)
        if (
            isinstance(inner, dict)
            and all(isinstance(entry, dict) for entry in inner.values())
            and not (inner and all(key in CATALOG_KINDS for key in inner))
        ):
            return inner
    return document


type _Mode = dict[str, Any]
"""The keywords every answer of one request takes: the error format and the request's correlation id."""


def _mode(datum: "Datum", request: Request) -> _Mode:
    """Return the error format and the request's correlation id (resolved once per request)."""
    api = datum.config.web.api
    return {
        "problem_details": api.problem_details,
        "correlation_id": resolve_correlation_id(request.headers, header_name=api.correlation_header),
    }


def _answer(outcome: BuilderOutcome, mode: _Mode, *, prefix: str) -> Response:
    """Write the answer of `outcome` (`no-store`; `Location` under `prefix`)."""
    return write(builder_answer(outcome, api_base=prefix, **mode))


async def _body(datum: "Datum", request: Request, mode: _Mode) -> bytes:
    """Return the body capped at `datum.builder.max_definition_size`, or raise its `no-store` 415, 400 or 413.

    A client that leaves mid-upload raises `ClientDisconnect` out of the read, which `DatumRoute` ends with no answer.
    """
    cap = int(datum.config.builder.max_definition_size)
    try:
        return await read_bounded_body(request, max_bytes=cap, problem_details=mode["problem_details"])
    except AnswerError as refused:
        raise AnswerError(_no_store(refused.answer)) from None


def _parsed(body: bytes, mode: _Mode) -> JsonValue:
    """Return the strictly parsed body, or raise the `no-store` 400 `bad_document`."""
    parsed = parse_json_body(body, problem_details=mode["problem_details"])
    if isinstance(parsed, Refused):
        raise AnswerError(_no_store(parsed.answer))
    return parsed


async def _document(datum: "Datum", body: bytes, mode: _Mode) -> JsonValue:
    """Return `_parsed(body)`, parsed off the event loop when the body is large (`off_loop`)."""
    return await off_loop(datum, body, lambda raw: _parsed(raw, mode))


async def _definition_etag(datum: "Datum", key: str) -> str | None:
    """Return the author's-copy `ETag` of a form that exists, else `None` (a read through the runner, no kernel run)."""
    if not _plain_key(key):
        return None
    outcome = await datum.async_definitions.read(key, public=False)
    return outcome.etag if isinstance(outcome, Served) else None


def _changes(request: Request) -> LocaleChanges | Malformed:
    """Return the language changes a write carries (judged by the service after the shape when malformed)."""
    return read_locale_changes(request.headers.get(LOCALE_CHANGES_HEADER))


@privileged
def builder(datum: "Datum", *, prefix: str = "/api", dependencies: Dependencies) -> APIRouter:
    """Build the builder router under `prefix`; `dependencies` guard every route (required, `[]` opts out)."""
    config = datum.config
    router = capability_router(
        datum,
        capability="builder",
        tag="ui",
        dependencies=dependencies,
        privileged=True,
        switches={"datum.builder.enabled": config.builder.enabled},
    )
    if not config.enabled or not config.builder.enabled:
        return router
    _add_definition_writes(router, datum, prefix)
    _add_translations_write(router, datum, prefix)
    _add_author_copy(router, datum, prefix)
    add_group_document(router, datum, prefix=prefix, factory="builder", privileged=True)
    return router


def _add_definition_writes(router: APIRouter, datum: "Datum", prefix: str) -> None:
    """Add `saveForm` (`PUT {prefix}/forms/{key}`) and `createForm` (`POST {prefix}/forms`)."""

    @router.put(f"{prefix}/forms/{{key}}", **operation_options(datum, "saveForm"))
    async def save_form(request: Request, key: str, principal: Annotated[object, Depends(datum.principal)]) -> Response:
        mode = _mode(datum, request)
        etag = await _definition_etag(datum, key)
        if etag is None:
            return _answer(FormNotFound(key), mode, prefix=prefix)
        body = await _body(datum, request, mode)
        refused = if_match_answer(request.headers, etag, **mode)
        if refused is not None:
            return write(refused)
        document = await _document(datum, body, mode)
        outcome = await datum.async_builder.save(
            key,
            document,
            expected_sha256=if_match_expected(request.headers, etag),
            principal=principal,
            changes=_changes(request),
        )
        return _answer(outcome, mode, prefix=prefix)

    @router.post(f"{prefix}/forms", **operation_options(datum, "createForm"))
    async def create_form(request: Request, principal: Annotated[object, Depends(datum.principal)]) -> Response:
        mode = _mode(datum, request)
        document = await _document(datum, await _body(datum, request, mode), mode)
        outcome = await datum.async_builder.create(document, principal=principal, changes=_changes(request))
        return _answer(outcome, mode, prefix=prefix)


def _expected_etag(request: Request, served: str) -> str | None:
    """Return the ETag a save is compared with: `None` (unconditional) for no `If-Match` or `*`, else `served`."""
    return None if if_match_expected(request.headers, served) is None else served


def _add_translations_write(router: APIRouter, datum: "Datum", prefix: str) -> None:
    """Add `saveFormTranslations` (`PUT {prefix}/forms/{key}/translations`)."""

    @router.put(f"{prefix}/forms/{{key}}/translations", **operation_options(datum, "saveFormTranslations"))
    async def save_form_translations(
        request: Request, key: str, principal: Annotated[object, Depends(datum.principal)]
    ) -> Response:
        mode = _mode(datum, request)
        served = await datum.async_translations.read(key) if _plain_key(key) else None
        if not isinstance(served, TranslationsServed):
            return _answer(FormNotFound(key), mode, prefix=prefix)
        body = await _body(datum, request, mode)
        refused = if_match_answer(request.headers, served.etag, **mode)
        if refused is not None:
            return write(refused)
        catalog = _catalog_of(await _document(datum, body, mode))
        # Absent and `*` are the unconditional save (the service serialises it under its lock); a present hash is
        # compared, under that lock, with the ETag served above. The pre-body read only refuses a stale header early,
        # with an ETag that may be one version old under a race: the service's under-lock check is the authority.
        outcome = await datum.async_builder.save_translations(
            key, catalog, expected_etag=_expected_etag(request, served.etag), principal=principal
        )
        return _answer(outcome, mode, prefix=prefix)


def _add_author_copy(router: APIRouter, datum: "Datum", prefix: str) -> None:
    """Add the author's copy, `GET {prefix}/forms/{key}/definition?public=false`, hidden from every document."""
    problem_details = datum.config.web.api.problem_details

    async def get_form_author_copy(request: Request, key: str) -> Response:
        outcome = await datum.async_definitions.read(key, public=False)
        if not isinstance(outcome, Served):  # the author's copy is never customized: a form is served or not found
            return _answer(FormNotFound(key), _mode(datum, request), prefix=prefix)
        verdict = evaluate_conditional(request.method, request.headers, outcome.etag)
        early = conditional_answer(verdict, etag=outcome.etag, cache_control=_NO_STORE, problem_details=problem_details)
        if early is not None:
            return write(_no_store(early))
        return Response(outcome.body, media_type=_JSON, headers={_ETAG: outcome.etag, _CACHE_CONTROL: _NO_STORE})

    router.add_api_route(
        f"{prefix}/forms/{{key}}/definition",
        get_form_author_copy,
        methods=["GET"],
        operation_id=_AUTHOR_COPY,
        include_in_schema=False,
        route_class_override=route_class_for(datum, AuthorCopyRoute),
    )
