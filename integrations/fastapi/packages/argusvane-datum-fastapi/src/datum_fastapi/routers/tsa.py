"""`routers.tsa`: `issueTimestamp`, `getTimestampCertificate` and `getTimestampCertificates` (catalog tag `datum-tsa`).

The router is public: the timestamp server has its own client-key rule, so the factory takes no `dependencies`. The
started guard runs first. Admission follows the H5 order in `datum_core.http.timestamp` (cookie, media type, client
key, flood, size); the gate judges the headers BEFORE the body is read, and the body is then counted chunk by chunk
with `BodyBudget`, a chunked body over the cap ending in the same plain-text 413. Admission needs only the headers
and the client address, so no cookie, session or `app.state` is touched. The token is ONE tracked task of the runner
(`Datum.async_timestamps`); this module writes the answer `datum_core.http` gives it and lets `DatumRoute` map
everything it raises. It holds no status code, no DER and no JSON call, and each route exists only with
`datum.tsa.enabled`.
"""

from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from datum_core.http import (
    Admitted,
    BodyBudget,
    BodyTooLargeError,
    Refused,
    answer_for,
    certificate_answer,
    certificates_answer,
)
from datum_fastapi.openapi import add_group_document, operation_options
from datum_fastapi.routers._factory import capability_router
from datum_fastapi.routing import AnswerError, write

if TYPE_CHECKING:
    from datum_core.timestamp.authority import TimestampAuthority
    from datum_fastapi.datum import Datum

__all__ = ["tsa"]


def tsa(datum: "Datum", *, prefix: str = "/tsa") -> APIRouter:
    """Build the public timestamp router under `prefix` (the catalog base `/tsa` by default)."""
    config = datum.config
    router = capability_router(
        datum,
        capability="tsa",
        dependencies=(),
        switches={"datum.tsa.enabled": config.tsa.enabled},
    )
    if not (config.enabled and config.tsa.enabled):
        return router
    datum.register_endpoint("tsa", prefix)
    retry_after = config.web.api.busy_retry_after
    max_bytes = int(config.tsa.max_request_size)

    def authority_of() -> "TimestampAuthority":
        authority = datum.timestamp_authority
        if authority is None:  # the guard lets a request through only after a start, which builds it when the TSA is on
            raise AnswerError(datum.unavailable_answer())
        return authority

    async def admission(request: Request) -> Admitted:
        gate = datum.timestamp_gate
        if gate is None:
            raise AnswerError(datum.unavailable_answer())
        address = request.client.host if request.client is not None else None
        verdict = gate.admit(request.headers, remote_address=address, retry_after=retry_after)
        if isinstance(verdict, Refused):
            raise AnswerError(verdict.answer)
        return verdict

    async def counted_body(request: Request, _admitted: Annotated[Admitted, Depends(admission)]) -> bytes:
        gate = datum.timestamp_gate
        if gate is None:
            raise AnswerError(datum.unavailable_answer())
        budget = BodyBudget(max_bytes)
        received: list[bytes] = []
        async for chunk in request.stream():
            try:
                budget.add(chunk)
            except BodyTooLargeError:
                raise AnswerError(gate.refuse_too_large().answer) from None
            received.append(chunk)
        return b"".join(received)

    @router.post(prefix, **operation_options(datum, "issueTimestamp"))
    async def issue_timestamp(
        admitted: Annotated[Admitted, Depends(admission)], body: Annotated[bytes, Depends(counted_body)]
    ) -> Response:
        answer = await datum.async_timestamps.answer(body, client=admitted.client)
        return write(answer_for(answer, retry_after=retry_after))

    @router.get(f"{prefix}/certificate", **operation_options(datum, "getTimestampCertificate"))
    async def get_certificate(
        fmt: Annotated[
            str | None,
            Query(
                alias="format",
                description=(
                    "`pem` (the default): the chain, leaf first; `der`: the leaf alone; "
                    "any value other than `der` answers PEM."
                ),
            ),
        ] = None,
    ) -> Response:
        return write(certificate_answer(authority_of().certificate_chain_der, fmt=fmt))

    @router.get(f"{prefix}/certificates", **operation_options(datum, "getTimestampCertificates"))
    async def get_certificates() -> Response:
        authority = authority_of()
        return write(certificates_answer(authority.certificate_chain_der, authority.retired_certificates_der))

    add_group_document(router, datum, prefix=prefix, factory="tsa")
    return router
