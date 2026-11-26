"""What the throttled routes share: the address limit, the strict parse, the context built from the request, the answer.

The wire order is contract: `Content-Type`, then the address limit (`address_limit`), then the body cap, then the
strict parse (all before a service is called), then the service's own per-form throttle, pre-check and run. The
address limit counts every request under its client address before the body is read, so a flood of bodies that never
parse is counted and refused too: the per-form key names the form, which only the parsed body gives. The parse holds
the GIL for its whole length, so a body larger than `INLINE_PARSE_BYTES` is parsed on a worker thread through the
runner (`off_loop`): the event loop goes on serving other requests, and a flood of large bodies is bounded by the
runner's slots (503 `server.busy` when they are full). The capped read is `datum_fastapi.body`'s dependency; the parse
is `datum_core.http`'s reader; the count is `datum_core.aio.count_address`; the answers are `datum_core.http`'s tables.
This module holds no status, no wire code and no JSON call.

Built on: `hashlib` makes the body digest, `starlette.requests.Request` already answers the client
address (`request.client`, which the ASGI server fills from its proxy-header handling) and the headers, and the core's
`SubmissionContext` and `ThrottleKey` are the records the service reads; the only thing written here is the choice of
what a request contributes to them.
"""

import hashlib
from collections.abc import Callable
from typing import TYPE_CHECKING, Any

from fastapi import Request, Response

from datum_core.aio import count_address
from datum_core.config.models import ThrottleKind
from datum_core.http import Refused, inspect_answer, parse_json_body, resolve_correlation_id, submission_answer
from datum_core.submissions import SUBMISSION_KEY, InspectOutcome, SubmissionContext, SubmissionOutcome, Throttled
from datum_core.throttle import ThrottleKey, address_key
from datum_fastapi.body import Admit
from datum_fastapi.routing import AnswerError, write
from datum_sandbox.json import JsonValue

if TYPE_CHECKING:
    from collections.abc import Mapping

    from datum_fastapi.datum import Datum

__all__ = [
    "HTTP_CHANNEL",
    "INLINE_PARSE_BYTES",
    "PDF_MODE",
    "address_limit",
    "context_of",
    "document_of",
    "off_loop",
    "parsed_document",
    "principal_name",
    "respond",
    "respond_inspect",
]

HTTP_CHANNEL = "http"
"""The channel word of every delivery that arrives over HTTP."""
INLINE_PARSE_BYTES = 16 * 1024
"""The largest body parsed on the event loop; a larger one is parsed on a worker thread through the runner."""
PDF_MODE = "pdf"
"""The mode word of the PDF routes' address limit: counted under the `pdf` kind, with no event, as their throttle."""

_WITHHELD_HEADERS = frozenset({"authorization", "proxy-authorization", "cookie"})
"""Request headers a hook is never handed: the principal is the identity, and a credential must not reach a log."""
_NAME_ATTRIBUTES = ("username", "name")


def document_of(body: bytes, *, problem_details: bool) -> JsonValue:
    """Return the strictly parsed body, or raise the `AnswerError` of the 400 `bad_document` refusal."""
    parsed = parse_json_body(body, problem_details=problem_details)
    if isinstance(parsed, Refused):
        raise AnswerError(parsed.answer)
    return parsed


async def off_loop[T](datum: "Datum", body: bytes, parse: Callable[[bytes], T]) -> T:
    """Return `parse(body)`: where it is for a body up to `INLINE_PARSE_BYTES`, else on a worker thread.

    The thread is the runner's (one slot, the same bounded wait as a service call); outside a lifespan there is none,
    and the answer is the 503 `server.unavailable` every route gives then.

    The parse runs before the per-form throttle, whose key names the form the parsed document gives, and after the
    address limit, which counted the request before its body was read; the contract's wire order is the same on every
    host. What bounds the parse is the body cap: `datum.web.api.max_body_size` is counted on the stream before this
    runs, so no parse reads more than that many bytes, and a body above `INLINE_PARSE_BYTES` also waits for one of the
    runner's slots.
    """
    if len(body) <= INLINE_PARSE_BYTES:
        return parse(body)
    runner = datum.runner
    if runner is None:
        raise AnswerError(datum.unavailable_answer())
    return await runner.run(parse, body)


async def parsed_document(datum: "Datum", body: bytes, *, problem_details: bool) -> JsonValue:
    """Return `document_of(body)`, parsed off the event loop when the body is large (`off_loop`)."""
    return await off_loop(datum, body, lambda raw: document_of(raw, problem_details=problem_details))


def address_limit(datum: "Datum", mode: str) -> Admit:
    """Return the route's address limit, the body dependency's `admit` step: count the request, raise the 429 over it.

    `mode` is the route's: `submit`, `validate`, `test` or `inspect` (the refusal goes through the submission service,
    which publishes and records what its per-form refusal does), or `PDF_MODE` (the `pdf` kind, which records nothing
    more, as the PDF throttle does). The address is `request.client` only, as in `context_of`; a request with none is
    not counted. The answer is the per-form refusal's: 429 `flood` with `Retry-After`, in the configured format.
    """

    async def admit(request: Request) -> None:
        runner = datum.runner
        if runner is None:
            raise AnswerError(datum.unavailable_answer())
        client = request.client
        address = client.host if client is not None else None
        denied = await count_address(datum.throttle, address, runner)
        if denied is None:
            return
        refused: Throttled
        if mode == PDF_MODE:
            refused = Throttled(denied.retry_after, address_key(address, ThrottleKind.PDF, HTTP_CHANNEL))
        else:
            refused = await datum.async_submissions.address_refusal(mode, address, HTTP_CHANNEL, denied.retry_after)
        raise AnswerError(submission_answer(refused, **_modes(datum, request)))

    return admit


def submission_key_of(document: JsonValue) -> str | None:
    """Return the submission key a delivery carries beside its document (`{document, submissionKey}`), or None.

    The browser mints one per submit attempt and sends it again on a retry. None for a body without a usable key,
    which the service refuses as a 400 `bad_document`, like any delivery without one.
    """
    if not isinstance(document, dict) or "document" not in document or "versionContext" in document:
        return None
    key = document.get("submissionKey")
    return key if isinstance(key, str) and SUBMISSION_KEY.fullmatch(key) is not None else None


def principal_name(principal: object | None) -> str | None:
    """Return the name a throttle counts a principal under: a string itself, else `username` or `name`, else none."""
    if principal is None:
        return None
    if isinstance(principal, str):
        return principal or None
    for attribute in _NAME_ATTRIBUTES:
        name = getattr(principal, attribute, None)
        if isinstance(name, str) and name:
            return name
    return None


def context_of(
    request: Request, principal: object | None, body: bytes, *, submission_key: str | None = None
) -> SubmissionContext:
    """Build the context of an HTTP delivery: channel, client address, agent, safe headers, throttle key, body digest.

    `submission_key` is the delivery's own (`submission_key_of`); a check or a dry run has none.

    The address is `request.client` only (a spoofable `X-Forwarded-For` never reaches the key; the ASGI server's
    proxy-header handling decides what `request.client` is). A caller with no address is counted by principal alone.
    """
    client = request.client
    address = client.host if client is not None else None
    headers: Mapping[str, str] = {k: v for k, v in request.headers.items() if k.lower() not in _WITHHELD_HEADERS}
    return SubmissionContext(
        channel=HTTP_CHANNEL,
        principal=principal,
        remote_address=address,
        user_agent=request.headers.get("user-agent"),
        headers=headers,
        throttle_key=ThrottleKey(ip=address, principal=principal_name(principal), channel=HTTP_CHANNEL),
        body_digest=hashlib.sha256(body).hexdigest(),
        submission_key=submission_key,
    )


def _modes(datum: "Datum", request: Request) -> dict[str, Any]:
    api = datum.config.web.api
    return {
        "retry_after": api.busy_retry_after,
        "problem_details": api.problem_details,
        "correlation_id": resolve_correlation_id(request.headers, header_name=api.correlation_header),
    }


def respond(datum: "Datum", request: Request, outcome: SubmissionOutcome) -> Response:
    """Write the answer `datum_core.http` gives a submission outcome, in the configured error format."""
    return write(submission_answer(outcome, pre_check_statuses=datum.pre_check_statuses, **_modes(datum, request)))


def respond_inspect(datum: "Datum", request: Request, outcome: InspectOutcome) -> Response:
    """Write the answer for an inspect outcome: the program's answer as it gave it, or the refusal's row."""
    return write(inspect_answer(outcome, **_modes(datum, request)))
