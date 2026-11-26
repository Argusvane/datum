"""`access_errors`: the opt-in handler that gives the application's own 403 the catalog's `access.denied` body.

Datum adds no authentication and registers no handler of its own: an application dependency's 401 or 403 reaches the
wire as FastAPI writes it (`{"detail": ...}`). An application that wants its 403 in Datum's error format, so one
client code path reads every refusal, registers this itself:

    app = FastAPI(exception_handlers=access_errors(datum))

or `for status, handler in access_errors(datum).items(): app.add_exception_handler(status, handler)`. The mapping is
keyed by status code, which Starlette accepts for `HTTPException`. Only 403 is mapped: the catalog has a row for
`access.denied` and none for a 401, whose `WWW-Authenticate` challenge belongs to the application. The headers the
application put on its exception are kept. Built on: Starlette's status-keyed handlers are the mechanism; there
is nothing to add.
"""

from collections.abc import Awaitable, Callable, Mapping
from http import HTTPStatus

from fastapi import Request
from starlette.exceptions import HTTPException
from starlette.responses import Response

from datum_core.datum import Datum
from datum_core.http import error_answer

__all__ = ["AccessHandler", "access_errors"]

type AccessHandler = Callable[[Request, Exception], Awaitable[Response]]


def access_errors(datum: Datum) -> Mapping[int, AccessHandler]:
    """Return the handlers to register: status 403 answers `access.denied` in the configured error format."""
    problem_details = datum.config.web.api.problem_details

    async def denied(request: Request, error: Exception) -> Response:  # noqa: ARG001 - the handler signature
        answer = error_answer(HTTPStatus.FORBIDDEN, "access.denied", problem_details=problem_details)
        headers = dict(answer.headers)
        if isinstance(error, HTTPException) and error.headers:
            headers = {**error.headers, **headers}
        return Response(content=answer.body, status_code=answer.status, headers=headers)

    return {HTTPStatus.FORBIDDEN.value: denied}
