"""`routers.forms`: the form definition, its translations and the data sources (catalog tag `datum-forms`).

Three routes of the catalog's 24, each on its own switch: `getFormDefinition` and `getFormTranslations` on
`datum.web.api.endpoints.definition`, `getDataSourceItems` on `datum.web.api.endpoints.data_sources`. The public
definition route serves only the public copy: it has no `public` parameter, and its route class (`PublicCopyRoute`)
yields every `public=false` spelling, so the unredacted author's copy is reachable only through the privileged builder
factory, behind its `dependencies`; without that router the query is the application's own 404.

A route reads its answer from the async services (the runner bounds the worker threads), writes what `datum_core.http`
builds, and lets `DatumRoute` map everything it raises. This module holds no status code, no wire code and no JSON call.
"""

from types import MappingProxyType
from typing import TYPE_CHECKING, Annotated

from fastapi import APIRouter, Depends, Request, Response

from datum_core.forms import (
    DataSourceNotFound,
    DataSourceRequest,
    DataSourceUnavailable,
    Items,
    NotFound,
    Served,
    TooDeep,
    TranslationsServed,
    Unavailable,
)
from datum_core.http import conditional_answer, evaluate_conditional, outcome_answer
from datum_fastapi.openapi import add_group_document, operation_options
from datum_fastapi.routers._factory import Dependencies, capability_router
from datum_fastapi.routing import PublicCopyRoute, route_class_for, write
from datum_fastapi.wire import items_response

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["forms"]

_JSON = "application/json"
_OWN_QUERY = frozenset({"locale", "form"})


def forms(datum: "Datum", *, prefix: str = "/api", dependencies: Dependencies = ()) -> APIRouter:
    """Build the forms router under `prefix` (the catalog base `/api` by default)."""
    config = datum.config
    endpoints = config.web.api.endpoints
    router = capability_router(
        datum,
        capability="forms",
        dependencies=dependencies,
        switches={
            "datum.web.api.endpoints.definition": endpoints.definition,
            "datum.web.api.endpoints.data_sources": endpoints.data_sources,
        },
    )
    if not config.enabled:
        return router
    api = config.web.api
    cache_control = config.forms.cache.definition

    def refusal(outcome: NotFound | Unavailable | TooDeep | DataSourceNotFound | DataSourceUnavailable) -> Response:
        return write(outcome_answer(outcome, problem_details=api.problem_details))

    def representation(request: Request, body: bytes, etag: str) -> Response:
        verdict = evaluate_conditional(request.method, request.headers, etag)
        early = conditional_answer(verdict, etag=etag, cache_control=cache_control, problem_details=api.problem_details)
        if early is not None:
            return write(early)
        return Response(body, media_type=_JSON, headers={"ETag": etag, "Cache-Control": cache_control})

    if endpoints.definition:

        async def get_form_definition(
            request: Request,
            key: str,
            principal: Annotated[object, Depends(datum.principal)],
            locale: Annotated[str, Depends(datum.locale)],
        ) -> Response:
            outcome = await datum.async_definitions.read(key, principal=principal, locale=locale)
            if isinstance(outcome, Served):
                return representation(request, outcome.body, outcome.etag)
            return refusal(outcome)

        router.add_api_route(
            f"{prefix}/forms/{{key}}/definition",
            get_form_definition,
            methods=["GET"],
            route_class_override=route_class_for(datum, PublicCopyRoute),
            **operation_options(datum, "getFormDefinition"),
        )

        @router.get(f"{prefix}/forms/{{key}}/translations", **operation_options(datum, "getFormTranslations"))
        async def get_form_translations(request: Request, key: str) -> Response:
            outcome = await datum.async_translations.read(key)
            if isinstance(outcome, TranslationsServed):
                return representation(request, outcome.body, outcome.etag)
            return refusal(outcome)

    if endpoints.data_sources:

        @router.get(f"{prefix}/data-sources/{{id}}", **operation_options(datum, "getDataSourceItems"))
        async def get_data_source_items(
            request: Request,
            id: str,  # noqa: A002 - the catalog's path parameter
            negotiated: Annotated[str, Depends(datum.locale)],
            locale: str | None = None,
            form: str | None = None,
        ) -> Response:
            asked = DataSourceRequest(
                source_id=id,
                form_key=form,
                locale=locale or negotiated,
                query=MappingProxyType({k: v for k, v in request.query_params.items() if k not in _OWN_QUERY}),
            )
            outcome = await datum.async_data_sources.items(asked)
            if isinstance(outcome, Items):
                return items_response(outcome.items)
            return refusal(outcome)

    add_group_document(router, datum, prefix=prefix, factory="forms")
    return router
