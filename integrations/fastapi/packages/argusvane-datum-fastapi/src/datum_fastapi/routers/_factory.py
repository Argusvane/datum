"""What every router factory shares: the router itself (route class, lifespan, guard, tag) and the privileged rule.

Datum's rules for a factory: it takes `prefix` (the catalog base by default) and declares
absolute paths; its router sets `route_class=DatumRoute`, carries `lifespan=datum.lifespan` and the `started` guard
first among its dependencies (second, after the application's own, when the factory is privileged), and tags its routes
`datum-<capability>`; each route sets an explicit `operation_id`. A privileged factory (management, authoring, builder,
pdf) takes `dependencies` as a REQUIRED keyword, so an unprotected one reads `dependencies=[]` in the application's
source.
"""

import inspect
from collections.abc import Callable, Mapping, Sequence
from typing import TYPE_CHECKING

from fastapi import APIRouter, Depends, params

from datum_fastapi.routing import route_class_for

if TYPE_CHECKING:
    from datum_fastapi.datum import Datum

__all__ = ["Dependencies", "capability_router", "privileged"]

type Dependencies = Sequence[params.Depends]
"""A router's dependencies, as `include_router` and `APIRouter` take them."""


def capability_router(
    datum: "Datum",
    *,
    capability: str,
    dependencies: Dependencies,
    switches: Mapping[str, bool],
    tag: str | None = None,
    privileged: bool = False,
) -> APIRouter:
    """Build a capability's router: the guard first, then the application's `dependencies` (the router-level list).

    A `privileged` router reverses that: the application's `dependencies` run FIRST and the guard second, so an
    unauthenticated caller gets its 401 before any 503 and never learns the server's state (a public factory has no
    dependencies of its own to run first).

    `switches` names the settings the factory reads and their values; Datum's start warns (`datum.W001`) when a
    router was built and every one of them is off. `tag` is the catalog tag's name after the prefix when it differs
    from the capability (the authoring router carries the `submissions` tag).
    """
    datum.register_router(capability, switches)
    guard = Depends(datum.started_guard)
    return APIRouter(
        route_class=route_class_for(datum),
        lifespan=datum.lifespan,
        dependencies=[*dependencies, guard] if privileged else [guard, *dependencies],
        tags=[f"{datum.config.web.openapi.tag_prefix}{tag or capability}"],
    )


def privileged[**P, R](factory: Callable[P, R]) -> Callable[P, R]:
    """Mark a privileged router factory, refusing at definition time one whose `dependencies` is not required.

    The keyword must be keyword-only with no default, so a type checker and the interpreter both refuse a call
    that leaves the routes unprotected without saying so (`dependencies=[]` is the explicit opt-out).
    """
    parameter = inspect.signature(factory).parameters.get("dependencies")
    if (
        parameter is None
        or parameter.kind is not inspect.Parameter.KEYWORD_ONLY
        or parameter.default is not inspect.Parameter.empty
    ):
        name = getattr(factory, "__qualname__", repr(factory))
        raise TypeError(f"the privileged router factory {name} must take dependencies as a required keyword")
    return factory
