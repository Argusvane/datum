"""The capped body read: bytes in, an `AnswerError` out for every refusal, nothing else.

Built on: `Request.body()` reads the whole body before any cap can act and
`Body()` makes FastAPI read it too, so a chunked body would pass; `RequestBodyLimitMiddleware` is application-wide and
answers `text/plain`. `Request.stream()` yields the chunks, and the counting `BodyBudget` and the refusals are
`datum_core.http`'s, so this module is the glue between the two.

The order is fixed: 415 from `Content-Type`, then the route's `admit` (the address limit, 429), then 400/413 from
`Content-Length`, all before a byte is read, then the counted read, which stops at the first chunk that takes the total
over the cap. So every request that passes the `Content-Type` check is counted before its body is read, whether or not
the body fits or parses. A client that leaves mid-upload raises
`ClientDisconnect` out of `Request.stream()`; it is not caught here, so the read holds nothing when it ends, and
`DatumRoute` ends the request with no answer, no event and no log.

A route whose header checks are not the shared ones passes its own as `check` (the PDF routes: `application/pdf` only
on verify, and a `Content-Length` that is not a whole number is their malformed-framing 400 `bad_request`); the counted
read and the 413 stay the same.
"""

from collections.abc import Awaitable, Callable, Mapping
from typing import Protocol

from fastapi import Request

from datum_core.http import (
    JSON_MEDIA_TYPES,
    BodyBudget,
    BodyTooLargeError,
    Refused,
    check_request_headers,
    refuse_too_large,
    refuses_media_type,
)
from datum_fastapi.routing import AnswerError

__all__ = ["Admit", "HeaderCheck", "bounded_body", "read_bounded_body"]

type Admit = Callable[[Request], Awaitable[None]]
"""A route's step between the `Content-Type` check and the rest: it raises the `AnswerError` of a refusal."""


class HeaderCheck(Protocol):
    """A route's own refusal from the request headers alone (`datum_core.http.check_pdf_upload_headers`).

    The route's cap is passed in by the body dependency (`max_bytes`), so the check and the counted read share one
    source for it.
    """

    def __call__(self, headers: Mapping[str, str], /, *, max_bytes: int) -> Refused | None:
        """Return the refusal for `headers` under the cap `max_bytes`, or `None`."""
        ...


async def read_bounded_body(
    request: Request,
    *,
    max_bytes: int,
    media_types: tuple[str, ...] = JSON_MEDIA_TYPES,
    problem_details: bool = False,
    check: HeaderCheck | None = None,
    admit: Admit | None = None,
) -> bytes:
    """Return the request body, or raise the `AnswerError` of the refusal (415, 429, 400 or 413 `bad_document`).

    `max_bytes` is the route's cap (`datum.web.api.max_body_size`, `datum.builder.max_definition_size`,
    `datum.runtime.verify_max_bytes`). The strict JSON parse is not done here (`datum_core.http.parse_json_body`).
    `check`, when given, replaces the shared header checks (`media_types` is then unused); it runs before a byte is
    read. `admit` runs after the `Content-Type` passed and before the length is judged: a 415 is not counted, a
    request refused for its declared length is.
    """
    refused = (
        check(request.headers, max_bytes=max_bytes)
        if check is not None
        else check_request_headers(
            request.headers, max_bytes=max_bytes, media_types=media_types, problem_details=problem_details
        )
    )
    if refused is not None and refuses_media_type(refused):
        raise AnswerError(refused.answer)
    if admit is not None:
        await admit(request)
    if refused is not None:
        raise AnswerError(refused.answer)
    budget = BodyBudget(max_bytes)
    received: list[bytes] = []
    async for chunk in request.stream():
        try:
            budget.add(chunk)
        except BodyTooLargeError:
            raise AnswerError(refuse_too_large(problem_details=problem_details).answer) from None
        received.append(chunk)
    return b"".join(received)


def bounded_body(
    *,
    max_bytes: int,
    media_types: tuple[str, ...] = JSON_MEDIA_TYPES,
    problem_details: bool = False,
    check: HeaderCheck | None = None,
    admit: Admit | None = None,
) -> Callable[[Request], Awaitable[bytes]]:
    """Return the body dependency of one route: `body: Annotated[bytes, Depends(bounded_body(max_bytes=...))]`.

    A router factory builds it once per route, so a test overrides it through `app.dependency_overrides[dependency]`.
    `admit` is the route's address limit (`routers._intake.address_limit`).
    """

    async def dependency(request: Request) -> bytes:
        return await read_bounded_body(
            request,
            max_bytes=max_bytes,
            media_types=media_types,
            problem_details=problem_details,
            check=check,
            admit=admit,
        )

    return dependency
