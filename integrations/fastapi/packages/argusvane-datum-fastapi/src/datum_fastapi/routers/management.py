"""`routers.management`: `health`, `livez`, `readyz`, `info` and (on its switch) `recheck`, tag `datum-management`.

`info` carries, under `settings`, the sandbox's effective-settings report (`Datum.explain()`, the same report the start
logs on `datum.sandbox.settings`): every `datum.runtime.*` and `datum.host.*` value with its source, the engine and the
programs' sha256 and ABI, without anything that names a path of the host (the capture directory, a program override, the
engine's notes).

Privileged: `dependencies` is a required keyword (`dependencies=[]` the explicit opt-out), and it guards the routes
that tell something about the deployment (`health`, `info`, `recheck`). Those run the application's `dependencies`
FIRST and the "entered" guard SECOND, so an unauthenticated caller gets its 401 before any 503 and never learns the
server's state; the guard is the "entered" one, never `Datum.ready`, so they answer while a runtime that failed to
start is down. `livez` and `readyz` are bodiless probes and stay public: `livez` answers while the process answers
(no guard, no report); `readyz` is the report's `is_ready` (the runtime component alone) and is bodiless in every
state, 503 before the lifespan, after its exit and while the runtime is down, through the guard's pure `is_entered`
(no envelope, no `Retry-After`, nothing logged). The routes are not catalog operations; they are in the
application's document under their own tag and carry no group document. Health contributors run on the event loop and
are cheap by contract (`() -> ComponentHealth`); `recheck` runs off it, through the runner.

The prefix defaults to the root (`/health`, ...); the application includes the router where it wants its probes.
"""

from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, Response

from datum_fastapi.openapi import management_options
from datum_fastapi.probes import health_response, info_response, live_response, not_ready_response, ready_response
from datum_fastapi.routers._factory import Dependencies, privileged
from datum_fastapi.routing import route_class_for

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["management"]


@privileged
def management(datum: "Datum", *, prefix: str = "", dependencies: Dependencies) -> APIRouter:
    """Build the management router under `prefix`; `dependencies` guard health, info and recheck (required)."""
    router = APIRouter(
        route_class=route_class_for(datum),
        lifespan=datum.lifespan,
        tags=[f"{datum.config.web.openapi.tag_prefix}management"],
    )
    guarded = [*dependencies, Depends(datum.started_guard.entered)]  # the application's first: a 401 before any 503

    @router.get(f"{prefix}/livez", **management_options(datum, "datumLivez"))
    async def livez() -> Response:
        return live_response()

    @router.get(f"{prefix}/readyz", **management_options(datum, "datumReadyz"))
    async def readyz() -> Response:
        if not datum.started_guard.is_entered():  # its own guard: no envelope, no Retry-After, nothing logged
            return not_ready_response()
        return ready_response(datum.health())

    @router.get(f"{prefix}/health", dependencies=guarded, **management_options(datum, "datumHealth"))
    async def health() -> Response:
        return health_response(datum.health())

    @router.get(f"{prefix}/info", dependencies=guarded, **management_options(datum, "datumInfo"))
    async def info() -> Response:
        # The sandbox's effective settings ride beside the flat body: every value with its source, no host path.
        return info_response({**datum.info(), "settings": datum.settings_info()})

    if datum.config.web.management.recheck:

        @router.post(f"{prefix}/recheck", dependencies=guarded, **management_options(datum, "datumRecheck"))
        async def recheck() -> Response:
            return health_response(await datum.async_recheck())

    return router
