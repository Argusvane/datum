"""`routers.submissions`: `submitSubmission` and `validateSubmission` (catalog tag `datum-submissions`, both public).

Each route is on its own switch (`datum.web.api.endpoints.submissions` and `.validate`). The route reads the body with
the capped dependency, which asks the address limit after the `Content-Type` check and before a byte is read
(`_intake.address_limit`), parses it strictly (off the event loop when large: `_intake.off_loop`), builds the context
from the request and awaits the async service, which runs the whole call (per-form throttle, pre-check, run, handler,
remember, events) as ONE tracked task; this module writes the answer `datum_core.http` gives the outcome and lets
`DatumRoute` map everything it raises. It holds no status code, no wire code and no JSON call. The routes that run an
arbitrary definition (dry run, inspect) are `routers.authoring`.
"""

from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, Depends, Request, Response

from datum_core.submissions import FormRef, SubmissionMode
from datum_fastapi.body import bounded_body
from datum_fastapi.openapi import add_group_document, operation_options
from datum_fastapi.routers._factory import Dependencies, capability_router
from datum_fastapi.routers._intake import address_limit, context_of, parsed_document, respond, submission_key_of

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["submissions"]


def submissions(datum: "Datum", *, prefix: str = "/api", dependencies: Dependencies = ()) -> APIRouter:
    """Build the public submissions router under `prefix` (the catalog base `/api` by default)."""
    config = datum.config
    endpoints = config.web.api.endpoints
    router = capability_router(
        datum,
        capability="submissions",
        dependencies=dependencies,
        switches={
            "datum.web.api.endpoints.submissions": endpoints.submissions,
            "datum.web.api.endpoints.validate": endpoints.validate,
        },
    )
    if not config.enabled:
        return router
    api = config.web.api

    if endpoints.submissions:
        submit_body = Depends(
            bounded_body(
                max_bytes=api.max_body_size,
                problem_details=api.problem_details,
                admit=address_limit(datum, SubmissionMode.SUBMIT.value),
            )
        )

        @router.post(f"{prefix}/submissions", **operation_options(datum, "submitSubmission"))
        async def submit_submission(
            request: Request,
            principal: Annotated[object, Depends(datum.principal)],
            body: Annotated[bytes, submit_body],
        ) -> Response:
            document = await parsed_document(datum, body, problem_details=api.problem_details)
            context = context_of(request, principal, body, submission_key=submission_key_of(document))
            outcome = await datum.async_submissions.submit(FormRef.from_document(), document, context)
            return respond(datum, request, outcome)

    if endpoints.validate:
        validate_body = Depends(
            bounded_body(
                max_bytes=api.max_body_size,
                problem_details=api.problem_details,
                admit=address_limit(datum, SubmissionMode.VALIDATE.value),
            )
        )

        @router.post(f"{prefix}/submissions/validate", **operation_options(datum, "validateSubmission"))
        async def validate_submission(
            request: Request,
            principal: Annotated[object, Depends(datum.principal)],
            body: Annotated[bytes, validate_body],
        ) -> Response:
            document = await parsed_document(datum, body, problem_details=api.problem_details)
            outcome = await datum.async_submissions.validate(
                FormRef.from_document(), document, context_of(request, principal, body)
            )
            return respond(datum, request, outcome)

    add_group_document(router, datum, prefix=prefix, factory="submissions")
    return router
