"""The privileged rule, held for every factory at once.

Every `@privileged` factory runs the application's `dependencies` FIRST and the started (or entered) guard SECOND, so an
unauthenticated caller gets its 401 before any 503 and never learns the server's state. A public factory has no
dependencies of its own to run first, so its guard comes first. The privileged factories are found by their signature
(a keyword-only `dependencies` with no default), so a new factory cannot forget the order: it is in this test the day it
exists. The builder factory is privileged; so is the pdf router on the three routes that print,
while verify and the server's certificate stay public (the catalog lists no 403 on them), so those two carry
the guard alone, first.
"""

import inspect
from collections.abc import Callable
from typing import Any

import pytest
from datum_fakes import (
    StubRepository,
    StubRuntime,
    StubSandbox,
    config,
    definition,
    dep_a,
    dep_b,
    refusing,
    runtime_of,
    sandbox_of,
)
from fastapi import APIRouter, Depends, FastAPI
from fastapi.routing import APIRoute
from fastapi.testclient import TestClient

from datum_fastapi import Datum, routers

EVERYTHING_ON: dict[str, Any] = {
    "builder": {"enabled": True},
    "web": {
        "management": {"recheck": True},
        "api": {
            "endpoints": {
                "submissions": True,
                "validate": True,
                "test": True,
                "inspect": True,
                "pdf": True,
                "fill": True,
                "sign": True,
                "verify": True,
                "certificate": True,
            }
        },
    },
}


def datum_for() -> Datum:
    return Datum(
        config=config(**EVERYTHING_ON),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )


def is_privileged(factory: Callable[..., APIRouter]) -> bool:
    parameter = inspect.signature(factory).parameters.get("dependencies")
    return (
        parameter is not None
        and parameter.kind is inspect.Parameter.KEYWORD_ONLY
        and parameter.default is inspect.Parameter.empty
    )


def factories() -> dict[str, Callable[..., APIRouter]]:
    found: dict[str, Callable[..., APIRouter]] = {}
    for name in routers.__all__:
        member = getattr(routers, name)
        if name != "capability_router" and callable(member) and "dependencies" in inspect.signature(member).parameters:
            found[name] = member
    return found


PUBLIC_PROBES = {"datumLivez", "datumReadyz"}  # the management router's two probes answer anyone by design
PUBLIC_PDF = {"verifyPdf", "serverCertificate"}  # the pdf router's two public routes, the guard alone
PUBLIC_ROUTES = PUBLIC_PROBES | PUBLIC_PDF
PRIVILEGED = sorted(name for name, factory in factories().items() if is_privileged(factory))
PUBLIC = sorted(name for name, factory in factories().items() if not is_privileged(factory))


def guards(datum: Datum) -> tuple[Any, ...]:
    return (datum.started_guard, datum.started_guard.entered)


def application_first_then_guard(datum: Datum, router: APIRouter) -> int:
    """Check every guarded route of the router; return how many there were."""
    counted = 0
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        chain = [item.dependency for item in route.dependencies]
        if dep_a not in chain:
            continue  # a public probe (`livez`, `readyz`) holds none of the application's dependencies
        counted += 1
        assert chain.index(dep_a) < chain.index(dep_b), route.path
        assert chain[-1] in guards(datum), (route.path, chain)
        assert chain.index(dep_b) < len(chain) - 1, route.path
        assert sum(item in guards(datum) for item in chain) == 1, route.path
    return counted


def test_the_privileged_factories_are_found_by_their_signature_and_include_the_builder() -> None:
    assert {"authoring", "management", "builder", "pdf"} <= set(PRIVILEGED)
    assert not {"forms", "submissions", "assets"} & set(PRIVILEGED)


@pytest.mark.parametrize("name", PRIVILEGED)
def test_a_privileged_factory_runs_the_applications_dependencies_before_the_guard_on_every_guarded_route(
    name: str,
) -> None:
    datum = datum_for()
    router = factories()[name](datum, dependencies=[Depends(dep_a), Depends(dep_b)])
    assert application_first_then_guard(datum, router) >= 1


@pytest.mark.parametrize("name", PRIVILEGED)
def test_the_guard_is_never_the_first_dependency_of_a_privileged_route(name: str) -> None:
    datum = datum_for()
    router = factories()[name](datum, dependencies=[Depends(dep_a)])
    for route in router.routes:
        if isinstance(route, APIRoute) and route.dependencies and route.operation_id not in PUBLIC_PDF:
            chain = [item.dependency for item in route.dependencies]
            assert chain[0] not in guards(datum), route.path


@pytest.mark.parametrize("name", PRIVILEGED)
def test_an_empty_dependencies_list_leaves_the_guard_alone_on_the_guarded_routes(name: str) -> None:
    datum = datum_for()
    router = factories()[name](datum, dependencies=[])
    guarded = [
        route
        for route in router.routes
        if isinstance(route, APIRoute) and any(d.dependency in guards(datum) for d in route.dependencies)
    ]
    assert guarded


@pytest.mark.parametrize("name", PUBLIC)
def test_a_public_factory_keeps_the_guard_first_because_it_has_no_dependencies_of_its_own_to_run_first(
    name: str,
) -> None:
    datum = datum_for()
    factory = factories()[name]
    router = factory(datum, dependencies=[Depends(dep_a), Depends(dep_b)])
    checked = 0
    for route in router.routes:
        if not isinstance(route, APIRoute):
            continue
        chain = [item.dependency for item in route.dependencies]
        if dep_a in chain:
            checked += 1
            assert chain[0] in guards(datum), (name, route.path)
            assert chain.index(dep_a) < chain.index(dep_b)
    assert checked >= 1 or name == "assets"


@pytest.mark.parametrize("name", PRIVILEGED)
def test_every_route_of_a_privileged_factory_carries_the_include_time_dependency(name: str) -> None:
    """Structural: no APIRoute of a privileged factory (hidden ones included) escapes the dependency."""
    datum = datum_for()
    router = factories()[name](datum, dependencies=[Depends(dep_a)])
    routes = [route for route in router.routes if isinstance(route, APIRoute)]
    assert routes
    assert len(routes) == len(router.routes), "a route of another kind sits on a privileged router"
    for route in routes:
        if route.operation_id in PUBLIC_ROUTES:
            continue
        assert dep_a in [item.dependency for item in route.dependencies], route.path


def test_the_pdf_routers_public_routes_carry_the_guard_alone_and_its_printing_routes_the_application_first() -> None:
    datum = datum_for()
    router = routers.pdf(datum, dependencies=[Depends(dep_a), Depends(dep_b)])
    chains = {
        route.operation_id: [item.dependency for item in route.dependencies]
        for route in router.routes
        if isinstance(route, APIRoute)
    }
    assert set(chains) == PUBLIC_PDF | {"renderPdf", "fillPdf", "signPdf"}
    for operation_id in PUBLIC_PDF:
        assert chains[operation_id] == [datum.started_guard], operation_id
    for operation_id in ("renderPdf", "fillPdf", "signPdf"):
        assert chains[operation_id] == [dep_a, dep_b, datum.started_guard], operation_id


def group_document_reply(name: str) -> Any:
    datum = Datum(
        config=config(**{**EVERYTHING_ON, "web": {**EVERYTHING_ON["web"], "openapi": {"group_documents": True}}}),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    app = FastAPI(lifespan=datum.lifespan)
    factory = factories()[name]
    app.include_router(factory(datum, dependencies=[]) if name in PRIVILEGED else factory(datum))
    with TestClient(app) as client:
        return client.get(f"/api/openapi/{name}.json")


@pytest.mark.parametrize("name", ["builder", "authoring", "pdf"])
def test_a_privileged_factorys_group_document_is_no_store(name: str) -> None:
    reply = group_document_reply(name)
    assert reply.status_code == 200
    assert reply.headers["cache-control"] == "no-store"


@pytest.mark.parametrize("name", ["forms", "submissions"])
def test_a_public_factorys_group_document_is_unchanged(name: str) -> None:
    reply = group_document_reply(name)
    assert reply.status_code == 200
    assert "cache-control" not in reply.headers


def test_the_pdf_group_document_carries_the_guarded_list_and_is_refused_to_an_anonymous_caller() -> None:
    datum = Datum(
        config=config(**{**EVERYTHING_ON, "web": {**EVERYTHING_ON["web"], "openapi": {"group_documents": True}}}),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
    )
    refuse = refusing(401, "auth")
    router = routers.pdf(datum, dependencies=[Depends(refuse)])
    document = [r for r in router.routes if isinstance(r, APIRoute) and r.path.endswith("/openapi/pdf.json")]
    assert len(document) == 1
    assert [item.dependency for item in document[0].dependencies] == [refuse, datum.started_guard]
    app = FastAPI(lifespan=datum.lifespan)
    app.include_router(router)
    with TestClient(app) as client:
        assert client.get("/api/openapi/pdf.json").status_code == 401
