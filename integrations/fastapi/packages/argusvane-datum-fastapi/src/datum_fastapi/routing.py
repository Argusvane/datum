"""`DatumRoute`: the one mapping point between a Datum route and the answer it writes.

FastAPI's documented custom-route pattern, kept small. The mapping itself is `datum_core.http`'s; this module only
translates what a route raises into the `HttpAnswer` the core builds, in this order:

1. An `HTTPException` (the application's dependency, a 401 or 403) passes through untouched.
2. A `ClientDisconnect` (the client left mid-upload) ends the request with no answer, no event and no log.
3. A raised `AnswerError` (the started guard, the body reader, a route's own refusal) is written as it carries.
4. Anything else is asked of the application's `error_translators` first, in list order (the first answer wins),
   then of the core's table (a bad path or query parameter, a hook's refusal, a busy or closed engine, a `DatumError`),
   and last answers 500 `internal`, logged with the request's correlation id.

The correlation id is resolved once per request, through `datum_core.http`, and only when an answer or a log needs it.
The response the route returns is written inside a watcher: a failure while writing it (a file removed under a running
process) before the status went out is mapped like any other; after the status went out it is logged once with the
correlation id and re-raised, so the server closes the connection. No handler is registered on the application and no
middleware added.

The author's copy and the public copy of a form definition share the contract's GET path
(`{api}/forms/{key}/definition`); the query decides which route takes a request.
`claims_author_copy` is the one predicate: a request is the author's when ANY `public` value, percent-decoded and
case-folded, is `false`. `AuthorCopyRoute` (the builder's) matches only such a request and `PublicCopyRoute` (the forms
router's) yields every one of them, so the two partition every query and the order the routers are included in never
matters; without the builder the query is the application's own 404. The override is the route class's `matches`, so it
survives `include_router` (which builds a route of the same class) and adds nothing to the application.

Built on: Starlette and FastAPI match on the path and the method only, with
no query discriminator; `starlette.datastructures.QueryParams` is the query reader the requests themselves use, so the
predicate reads the query exactly as a route's handler would. The classes add one `matches` override each.
"""

import logging
from collections.abc import Callable, Coroutine, MutableMapping
from typing import Any, ClassVar, Final

from fastapi import Request
from fastapi.exceptions import RequestValidationError
from fastapi.routing import APIRoute
from starlette.datastructures import QueryParams
from starlette.exceptions import HTTPException
from starlette.requests import ClientDisconnect
from starlette.responses import Response
from starlette.routing import Match
from starlette.types import Receive, Scope, Send

from datum_core import DatumConfig
from datum_core.datum import Datum
from datum_core.forms import Unavailable
from datum_core.hooks import HookRefusedError
from datum_core.http import (
    HttpAnswer,
    bad_request_answer,
    datum_error_answer,
    hook_refusal_answer,
    internal_answer,
    outcome_answer,
    resolve_correlation_id,
)
from datum_core.loggers import ROOT
from datum_sandbox.protocol import DatumError
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

__all__ = [
    "AnswerError",
    "AuthorCopyRoute",
    "DatumRoute",
    "PublicCopyRoute",
    "claims_author_copy",
    "route_class_for",
    "write",
]

WEB: Final = f"{ROOT}.web"
"""The binding's logger: the 500 `internal`, a failed response write and a failing translator."""

logger = logging.getLogger(WEB)


class AnswerError(Exception):
    """Carries the answer a Datum dependency or route decided on; `DatumRoute` writes it."""

    def __init__(self, answer: HttpAnswer) -> None:
        """Keep the answer."""
        super().__init__(f"Datum answers {answer.status}")
        self.answer = answer


def write(answer: HttpAnswer) -> Response:
    """Turn an `HttpAnswer` into a Starlette response, headers and body unchanged."""
    return Response(content=answer.body, status_code=answer.status, headers=dict(answer.headers))


class _NoAnswer(Response):
    """The response of a request whose client is gone: it writes nothing, so there is nothing to discard or log."""

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Send nothing."""


class _Watched(Response):
    """Writes the wrapped response and maps a failure of the writing itself."""

    def __init__(self, inner: Response, request: Request, datum: Datum | None) -> None:
        """Keep the response to write and what mapping a failure needs."""
        super().__init__()
        self._inner = inner
        self._request = request
        self._datum = datum

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        """Delegate to the inner response, watching whether the status went out."""
        started = False

        async def watching(message: MutableMapping[str, Any]) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self._inner(scope, receive, watching)
        except Exception as error:
            if started:
                settings = _Settings(self._datum)
                correlation_id = resolve_correlation_id(self._request.headers, header_name=settings.correlation_header)
                logger.exception(
                    "A Datum response failed after its status was sent (correlation id %s); the connection closes.",
                    correlation_id,
                    extra={"datum_correlation_id": correlation_id},
                )
                raise
            await write(_map(error, self._request, self._datum))(scope, receive, send)


class DatumRoute(APIRoute):
    """The route class every Datum router sets (`route_class=DatumRoute`, bound to its `Datum` by `route_class_for`).

    A `DatumRoute` used directly, with no `Datum` bound, maps with the defaults (no translators, the default error
    format, `X-Request-ID`, a 5 s `Retry-After`).
    """

    datum: ClassVar[Datum | None] = None

    def get_route_handler(self) -> Callable[[Request], Coroutine[Any, Any, Response]]:
        """Wrap FastAPI's handler with the mapping above."""
        handler = super().get_route_handler()
        datum = self.datum

        async def datum_route_handler(request: Request) -> Response:
            try:
                return _Watched(await handler(request), request, datum)
            except HTTPException:
                raise
            except ClientDisconnect:
                return _NoAnswer()
            except AnswerError as raised:
                return write(raised.answer)
            except Exception as error:
                return write(_map(error, request, datum))

        return datum_route_handler


def route_class_for(datum: Datum, base: type[DatumRoute] = DatumRoute) -> type[DatumRoute]:
    """Return the subclass of `base` (a `DatumRoute`) that maps with `datum`'s error translators and error settings."""
    return type(base.__name__, (base,), {"datum": datum})


_PUBLIC_PARAMETER: Final = "public"
_AUTHOR_VALUE: Final = "false"


def claims_author_copy(scope: Scope) -> bool:
    """Whether a request asks for the author's copy: any `public` value, percent-decoded and case-folded, is `false`.

    `public=FALSE`, `public=%66alse`, `public=true&public=false` are claimed; `public=`, `public=no`, `Public=false` and
    `public=false%20` are not (the public route serves them the public copy, which is never the unredacted one).
    """
    query = QueryParams(scope.get("query_string", b""))
    return any(value.casefold() == _AUTHOR_VALUE for value in query.getlist(_PUBLIC_PARAMETER))


class AuthorCopyRoute(DatumRoute):
    """The builder's author-copy route: it matches an HTTP request only when `claims_author_copy` holds.

    A claimed request whose method is not `GET` (HEAD included) still matches by path, so the router answers its 405
    (with `Allow: GET`) after the application's dependencies: the public copy is never reached by a claimed query,
    whatever the method.
    """

    def matches(self, scope: Scope) -> tuple[Match, Scope]:
        """Match as a route does, for a claimed query only; anything else is no match at all."""
        if scope["type"] == "http" and not claims_author_copy(scope):
            return Match.NONE, {}
        return super().matches(scope)


class PublicCopyRoute(DatumRoute):
    """The public definition route: it yields every request `claims_author_copy` holds for, whatever its method."""

    def matches(self, scope: Scope) -> tuple[Match, Scope]:
        """Match as a route does, except a claimed query, which is no match at all."""
        if scope["type"] == "http" and claims_author_copy(scope):
            return Match.NONE, {}
        return super().matches(scope)


class _Settings:
    """What the mapping reads of a `Datum`, or the configuration model's own defaults when the route has none."""

    def __init__(self, datum: Datum | None) -> None:
        api = (datum.config if datum is not None else DatumConfig()).web.api
        self.translators = datum.error_translators if datum is not None else ()
        self.problem_details = api.problem_details
        self.retry_after = api.busy_retry_after
        self.correlation_header = api.correlation_header


def _map(error: Exception, request: Request, datum: Datum | None) -> HttpAnswer:
    settings = _Settings(datum)
    correlation: list[str] = []

    def correlation_id() -> str:
        """Resolve the id once for this failure: the translator log and the 500 name the same one."""
        if not correlation:
            correlation.append(resolve_correlation_id(request.headers, header_name=settings.correlation_header))
        return correlation[0]

    translated = _translated(error, settings, correlation_id)
    if translated is not None:
        return translated
    mapped = _mapped(error, settings)
    if mapped is not None:
        return mapped
    logger.error(
        "A Datum route failed unexpectedly and answered 500 internal (correlation id %s).",
        correlation_id(),
        extra={"datum_correlation_id": correlation_id()},
        exc_info=error,
    )
    return internal_answer(problem_details=settings.problem_details, correlation_id=correlation_id())


def _translated(error: Exception, settings: _Settings, correlation_id: Callable[[], str]) -> HttpAnswer | None:
    """Ask the application's translators in list order; one that itself fails is logged (with the id) and skipped."""
    for translator in settings.translators:
        try:
            answer = translator(error)
        except Exception:
            logger.exception(
                "An error translator raised (correlation id %s); the next one is asked.",
                correlation_id(),
                extra={"datum_correlation_id": correlation_id()},
            )
            continue
        if answer is not None:
            return answer
    return None


def _mapped(error: Exception, settings: _Settings) -> HttpAnswer | None:
    """Datum's own table: parameters, hook refusals, the engine's refusals, the sandbox's errors."""
    mode = settings.problem_details
    if isinstance(error, RequestValidationError):
        return bad_request_answer(_parameter(error), problem_details=mode)
    if isinstance(error, HookRefusedError):
        return hook_refusal_answer(error, problem_details=mode)
    if isinstance(error, EngineClosedError):
        return outcome_answer(Unavailable(), problem_details=mode)
    if isinstance(error, DatumError | EngineBusyError):
        return datum_error_answer(error, retry_after=settings.retry_after, problem_details=mode)
    return None


def _parameter(error: RequestValidationError) -> str:
    """Name the first parameter that failed: the last element of its location, never its value."""
    for item in error.errors():
        location = item.get("loc", ())
        if location:
            return str(location[-1])
    return "request"
