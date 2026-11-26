"""`routers.authoring`: `testSubmission` and `inspectDefinition` (catalog tag `datum-submissions`), privileged.

They run a document or a definition the caller sends through the program, so the factory takes `dependencies` as a
required keyword (`dependencies=[]` is the explicit opt-out) and the routes are not part of `routers.submissions`. Each
is on its own switch (`datum.web.api.endpoints.test` and `.inspect`), with the same wire order as a delivery: 415, the
address limit (before a byte is read), the body cap, the strict parse, then the service's per-form throttle (the `test`
kind for both) and run. This module holds no status
code, no wire code and no JSON call.
"""

from collections.abc import Mapping
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, Depends, Request, Response

from datum_core.submissions import FormRef, Malformed, SubmissionMode
from datum_fastapi.body import bounded_body
from datum_fastapi.openapi import add_group_document, operation_options
from datum_fastapi.routers._factory import Dependencies, capability_router, privileged
from datum_fastapi.routers._intake import address_limit, context_of, parsed_document, respond, respond_inspect

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["authoring"]

_OP = "op"
_INSPECT = "inspect"
_DEFINITION = "definition"


@privileged
def authoring(datum: "Datum", *, prefix: str = "/api", dependencies: Dependencies) -> APIRouter:
    """Build the authoring router under `prefix`; `dependencies` guard both routes (required, `[]` opts out)."""
    config = datum.config
    endpoints = config.web.api.endpoints
    router = capability_router(
        datum,
        capability="authoring",
        tag="submissions",
        dependencies=dependencies,
        privileged=True,
        switches={
            "datum.web.api.endpoints.test": endpoints.test,
            "datum.web.api.endpoints.inspect": endpoints.inspect,
        },
    )
    if not config.enabled:
        return router
    api = config.web.api

    if endpoints.test:
        test_body = Depends(
            bounded_body(
                max_bytes=api.max_body_size,
                problem_details=api.problem_details,
                admit=address_limit(datum, SubmissionMode.TEST.value),
            )
        )

        @router.post(f"{prefix}/submissions/test", **operation_options(datum, "testSubmission"))
        async def test_submission(
            request: Request,
            principal: Annotated[object, Depends(datum.principal)],
            body: Annotated[bytes, test_body],
        ) -> Response:
            document = await parsed_document(datum, body, problem_details=api.problem_details)
            outcome = await datum.async_submissions.test(
                FormRef.from_document(), document, context_of(request, principal, body)
            )
            return respond(datum, request, outcome)

    if endpoints.inspect:
        inspect_body = Depends(
            bounded_body(
                max_bytes=api.max_body_size,
                problem_details=api.problem_details,
                admit=address_limit(datum, _INSPECT),
            )
        )

        @router.post(f"{prefix}/inspect", **operation_options(datum, "inspectDefinition"))
        async def inspect_definition(
            request: Request,
            principal: Annotated[object, Depends(datum.principal)],
            body: Annotated[bytes, inspect_body],
        ) -> Response:
            document = await parsed_document(datum, body, problem_details=api.problem_details)
            if not isinstance(document, Mapping) or not isinstance(document.get(_OP), str):
                return respond_inspect(datum, request, Malformed("an inspect body is an object with an op"))
            outcome = await datum.async_submissions.inspect(
                str(document[_OP]), document.get(_DEFINITION), context_of(request, principal, body)
            )
            return respond_inspect(datum, request, outcome)

    add_group_document(router, datum, prefix=prefix, factory="authoring", privileged=True)
    return router
