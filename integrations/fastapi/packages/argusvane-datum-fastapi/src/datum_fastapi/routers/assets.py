"""`routers.assets`: the asset route, `host.json` and the page glue (outside the catalog, `include_in_schema=False`).

`GET|HEAD {prefix}/{build_id}/{path:path}` is a real route, never `StaticFiles`: the request path is only ever a key of
the `AssetCatalog` dictionary the start resolved, so it is never joined to a file system path. `FileResponse` carries
the file with the manifest sha256 as its `ETag`; a 304 comes from the shared conditional helper, never from Starlette.
`host.json` and `datum-host.js` answer `no-cache`; only a file under the build id is `immutable`.
"""

from importlib import resources
from typing import TYPE_CHECKING, Final

from fastapi import APIRouter, Request, Response
from fastapi.exceptions import HTTPException
from fastapi.responses import FileResponse

from datum_core.http import (
    HostBindingEntry,
    HostBindingsTable,
    HostCsrf,
    HostJson,
    conditional_answer,
    evaluate_conditional,
)
from datum_core.http.assets import ASSET_NOT_FOUND, NO_CACHE, AssetCatalog, resolve_assets_root
from datum_fastapi.routers._factory import Dependencies, capability_router
from datum_fastapi.routing import AnswerError, write

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["assets"]

_GLUE: Final = "datum-host.js"
_JSON: Final = "application/json"
_JAVASCRIPT: Final = "text/javascript"
_HEAD: Final = "HEAD"


def _catalog(datum: "Datum") -> AssetCatalog:
    catalog = datum.asset_catalog
    if catalog is None:  # the guard lets a request through only after a start, which builds it when assets are on
        raise AnswerError(datum.unavailable_answer())
    return catalog


def _bindings_table(datum: "Datum") -> HostBindingsTable:
    """Return the host's binding table (`datum.bindings.*`) as `host.json` publishes it for the page glue."""
    table = datum.bindings
    return HostBindingsTable(
        default=table.default,
        routes=dict(sorted(table.routes.items())),
        catalog=[
            HostBindingEntry(id=entry.id, label=entry.label, pdf_theme=entry.pdf_theme) for entry in table.catalog
        ],
    )


def _bytes_response(request: Request, body: bytes, media_type: str) -> Response:
    """Answer a small body that is never cached; HEAD gets the headers (with the real length) and no body."""
    headers = {"Cache-Control": NO_CACHE}
    if request.method == _HEAD:
        return Response(b"", media_type=media_type, headers={**headers, "Content-Length": str(len(body))})
    return Response(body, media_type=media_type, headers=headers)


def assets(
    datum: "Datum", *, prefix: str = "/datum/assets", dependencies: Dependencies = (), api_prefix: str = "/api"
) -> APIRouter:
    """Build the assets router under `prefix` (`/datum/assets` by default).

    `api_prefix` is the base `host.json` publishes for the application's API routers (the catalog's `/api`).
    """
    config = datum.config
    router = capability_router(
        datum,
        capability="assets",
        dependencies=dependencies,
        switches={"datum.web.assets.enabled": config.web.assets.enabled},
    )
    if not (config.enabled and config.web.assets.enabled):
        return router
    csrf = HostCsrf(
        header_name=config.web.csrf.header_name,
        cookie_name=config.web.csrf.cookie_name,
        meta_name=config.web.csrf.meta_name,
    )
    cache_period = int(config.web.assets.cache_period.total_seconds())
    api = config.web.api
    glue = resolve_assets_root(resources.files("datum_fastapi").joinpath("web", "resources")) / _GLUE
    methods = ["GET", "HEAD"]

    @router.api_route(f"{prefix}/host.json", methods=methods, include_in_schema=False, operation_id="getDatumHostJson")
    async def host_json(request: Request) -> Response:
        catalog = _catalog(datum)
        root = request.scope.get("root_path", "")
        endpoints = datum.endpoints
        model = HostJson(
            build_id=catalog.build_id,
            assets_base=f"{root}{prefix}/{catalog.build_id}",
            api_base=f"{root}{api_prefix}",
            csrf=csrf,
            bindings=_bindings_table(datum),
            paths={name: f"{root}{base}" for name, base in endpoints.items()} if endpoints else None,
        )
        return _bytes_response(request, model.model_dump_json(exclude_none=True).encode(), _JSON)

    @router.api_route(f"{prefix}/{_GLUE}", methods=methods, include_in_schema=False, operation_id="getDatumHostGlue")
    async def host_glue() -> Response:
        return FileResponse(glue, media_type=_JAVASCRIPT, headers={"Cache-Control": NO_CACHE})

    @router.api_route(
        f"{prefix}/{{build_id}}/{{path:path}}", methods=methods, include_in_schema=False, operation_id="getDatumAsset"
    )
    async def asset(request: Request, build_id: str, path: str) -> Response:
        found = _catalog(datum).find(build_id, path)
        if found is None:
            raise HTTPException(status_code=ASSET_NOT_FOUND)
        headers = found.cache_headers(cache_period)
        verdict = evaluate_conditional(request.method, request.headers, found.etag)
        early = conditional_answer(
            verdict, etag=found.etag, cache_control=headers["Cache-Control"], problem_details=api.problem_details
        )
        if early is not None:
            return write(early)
        return FileResponse(found.path, media_type=found.media_type, headers=headers)

    return router
