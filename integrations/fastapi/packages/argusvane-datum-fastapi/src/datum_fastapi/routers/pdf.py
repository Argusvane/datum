"""`routers.pdf`: `renderPdf`, `fillPdf`, `signPdf`, `verifyPdf` and `serverCertificate` (catalog tag `datum-pdf`).

The factory is `@privileged`: `dependencies` is a required keyword (`dependencies=[]` is the explicit
opt-out) and guards the three routes that print, which run posted answers through the PDF program and may sign them;
the application's dependencies run FIRST on them and the started guard second, so an unauthenticated caller meets its
own 401 before any 503. Verify and the server's certificate stay public (the catalog lists no 403 on them): the guard is
their only dependency, and verify never runs the application's `principal` seam (a refusing seam would end the public
route), so its throttle key is the client address alone. The dependencies sit on each route, never on the router (the
group document carries the guarded list: it describes the printing routes the application guards and the two public
ones with them). Each route exists only with its own switch
(`datum.web.api.endpoints.{pdf, fill, sign, verify, certificate}`), with `datum.pdf.enabled` and `datum.enabled`.

The wire order is contract: the dependencies, the `Content-Type` check (415), the address limit (429, before a byte is
read, `_intake.address_limit` under the `pdf` kind), the length checks (the malformed-framing 400, then a declared
length over the cap 413), the counted read (413), the strict parse (400), then the service's per-form throttle (429),
availability (503), dry run and print as ONE tracked task of the runner (`Datum.async_pdf`). The JSON routes read under
`datum.web.api.max_body_size` (a large body is parsed on a worker thread, `_intake.off_loop`), verify under
`datum.runtime.verify_max_bytes` as clamped. This module holds no status, no wire code, no media type and no JSON call:
the admission and the answers are `datum_core.http`'s, and `DatumRoute` maps whatever else a call raises.
"""

from collections.abc import Awaitable, Callable
from functools import partial
from typing import TYPE_CHECKING, Annotated, Any

from fastapi import APIRouter, Depends, Request, Response

from datum_core.http import (
    FILL_OPERATION,
    PdfRequestBody,
    Refused,
    check_pdf_request_headers,
    check_pdf_upload_headers,
    parse_pdf_request,
    pdf_answer,
    resolve_correlation_id,
    server_certificate_answer,
    verify_answer,
)
from datum_core.submissions import FormRef, SubmissionContext
from datum_fastapi.body import bounded_body
from datum_fastapi.openapi import add_group_document, operation_options
from datum_fastapi.routers._factory import Dependencies, privileged
from datum_fastapi.routers._intake import PDF_MODE, address_limit, context_of, off_loop
from datum_fastapi.routing import AnswerError, route_class_for, write
from datum_sandbox.protocol import PdfKernelError

if TYPE_CHECKING:
    from datum_core.aio import AsyncPdfService
    from datum_core.pdf.outcomes import PdfOutcome
    from datum_fastapi.datum import Datum

__all__ = ["pdf"]

_CAPABILITY = "pdf"
_SWITCH = "datum.web.api.endpoints."

type _Print = Callable[["AsyncPdfService", PdfRequestBody, SubmissionContext], Awaitable["PdfOutcome"]]
"""One printing operation of the async face, given the parsed body and the request's context."""


async def _render(service: "AsyncPdfService", asked: PdfRequestBody, context: SubmissionContext) -> "PdfOutcome":
    return await service.render(FormRef.from_document(), asked.document, context, layout_id=asked.layout_id)


async def _fill(service: "AsyncPdfService", asked: PdfRequestBody, context: SubmissionContext) -> "PdfOutcome":
    layout_id = asked.layout_id
    if layout_id is None:  # the reader refuses a fill without one (layout_required); kept for the type
        raise ValueError("a fill names its layout")
    return await service.fill(FormRef.from_document(), asked.document, context, layout_id=layout_id)


async def _sign(service: "AsyncPdfService", asked: PdfRequestBody, context: SubmissionContext) -> "PdfOutcome":
    return await service.sign(FormRef.from_document(), asked.document, context, layout_id=asked.layout_id)


def _modes(datum: "Datum", request: Request) -> dict[str, Any]:
    api = datum.config.web.api
    return {
        "problem_details": api.problem_details,
        "correlation_id": resolve_correlation_id(request.headers, header_name=api.correlation_header),
    }


@privileged
def pdf(datum: "Datum", *, prefix: str = "/api", dependencies: Dependencies) -> APIRouter:
    """Build the PDF router under `prefix`; `dependencies` guard render, fill and sign (required, `[]` opts out)."""
    config = datum.config
    endpoints = config.web.api.endpoints
    on = {
        "pdf": endpoints.pdf,
        "fill": endpoints.fill,
        "sign": endpoints.sign,
        "verify": endpoints.verify,
        "certificate": endpoints.certificate,
    }
    datum.register_router(_CAPABILITY, {f"{_SWITCH}{name}": value for name, value in on.items()})
    router = APIRouter(
        route_class=route_class_for(datum),
        lifespan=datum.lifespan,
        tags=[f"{config.web.openapi.tag_prefix}{_CAPABILITY}"],
    )
    if not (config.enabled and config.pdf.enabled):
        return router
    api = config.web.api
    problem = api.problem_details
    guard = Depends(datum.started_guard)
    guarded = [*dependencies, guard]
    public = [guard]
    json_cap = int(api.max_body_size)
    counted = address_limit(datum, PDF_MODE)
    json_body = Depends(
        bounded_body(
            max_bytes=json_cap,
            problem_details=problem,
            check=partial(check_pdf_request_headers, problem_details=problem),
            admit=counted,
        )
    )

    def printing(path: str, operation: str, run: _Print) -> None:
        layout_required = operation == FILL_OPERATION

        @router.post(f"{prefix}{path}", dependencies=guarded, **operation_options(datum, operation))
        async def print_pdf(
            request: Request,
            principal: Annotated[object, Depends(datum.principal)],
            body: Annotated[bytes, json_body],
        ) -> Response:
            asked = await off_loop(
                datum,
                body,
                lambda raw: parse_pdf_request(raw, layout_required=layout_required, problem_details=problem),
            )
            if isinstance(asked, Refused):
                raise AnswerError(asked.answer)
            outcome: PdfOutcome | PdfKernelError
            try:
                outcome = await run(datum.async_pdf, asked, context_of(request, principal, body))
            except PdfKernelError as error:  # the program's own refusal: answered by its word
                outcome = error
            answer = pdf_answer(
                outcome,
                operation=operation,
                retry_after=api.busy_retry_after,
                pre_check_statuses=datum.pre_check_statuses,
                **_modes(datum, request),
            )
            return write(answer)

    if on["pdf"]:
        printing("/pdf", "renderPdf", _render)
    if on["fill"]:
        printing("/pdf/fill", FILL_OPERATION, _fill)
    if on["sign"]:
        printing("/pdf/sign", "signPdf", _sign)

    if on["verify"]:
        verify_cap = datum.limits.verify_max_bytes
        upload = Depends(
            bounded_body(
                max_bytes=verify_cap,
                problem_details=problem,
                check=partial(check_pdf_upload_headers, problem_details=problem),
                admit=counted,
            )
        )

        @router.post(f"{prefix}/pdf/verify", dependencies=public, **operation_options(datum, "verifyPdf"))
        async def verify_pdf(
            request: Request,
            body: Annotated[bytes, upload],
        ) -> Response:
            # public: the application's principal seam never runs here (a refusing seam would end the public
            # route), so the throttle counts the client address alone
            outcome = await datum.async_pdf.verify(body, context_of(request, None, body))
            return write(verify_answer(outcome, retry_after=api.busy_retry_after, **_modes(datum, request)))

    if on["certificate"]:

        @router.get(
            f"{prefix}/server/certificate", dependencies=public, **operation_options(datum, "serverCertificate")
        )
        async def server_certificate(request: Request) -> Response:
            chain = await datum.async_pdf.certificate_chain()
            return write(server_certificate_answer(chain, **_modes(datum, request)))

    add_group_document(router, datum, prefix=prefix, factory=_CAPABILITY, privileged=True, dependencies=guarded)
    return router
