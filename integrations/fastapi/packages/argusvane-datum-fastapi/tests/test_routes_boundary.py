"""The binding's boundary: switches off add no route; no handler, middleware or app state; the AST rules."""

import ast
import importlib
import re
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
from catalog_support import catalog
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, runtime_of, sandbox_of
from fastapi import FastAPI
from fastapi.testclient import TestClient

from datum_core import DatumConfig
from datum_fastapi import Datum, DatumRoute, routers


def make_datum(cfg: DatumConfig, **seams: Any) -> Datum:
    return Datum(
        config=cfg,
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
        **seams,
    )


# ---- switches --------------------------------------------------------------------------------------------------------
def test_a_forms_router_with_every_switch_off_adds_no_route() -> None:
    router = routers.forms(make_datum(DatumConfig()))
    assert list(router.routes) == []
    app = FastAPI()
    app.include_router(router)
    assert app.openapi()["paths"] == {}


def test_an_assets_router_with_assets_off_adds_no_route() -> None:
    assert list(routers.assets(make_datum(DatumConfig())).routes) == []


def test_datum_enabled_false_adds_no_route_even_with_every_switch_on() -> None:
    cfg = config(enabled=False, web={"assets": {"enabled": True}})
    assert list(routers.forms(make_datum(cfg)).routes) == []
    assert list(routers.assets(make_datum(cfg)).routes) == []


def test_each_forms_switch_adds_exactly_its_routes() -> None:
    definition_only = config(definition_route=False, web={"api": {"endpoints": {"definition": True}}})
    paths = {route.path for route in routers.forms(make_datum(definition_only)).routes}  # type: ignore[attr-defined]
    assert paths == {"/api/forms/{key}/definition", "/api/forms/{key}/translations"}
    sources_only = config(definition_route=False, web={"api": {"endpoints": {"data_sources": True}}})
    paths = {route.path for route in routers.forms(make_datum(sources_only)).routes}  # type: ignore[attr-defined]
    assert paths == {"/api/data-sources/{id}"}


def test_a_router_with_a_switch_off_answers_the_applications_404_not_a_datum_one() -> None:
    app = FastAPI()
    app.include_router(routers.forms(make_datum(DatumConfig())))
    with TestClient(app) as client:
        reply = client.get("/api/forms/contact/definition")
    assert reply.status_code == 404
    assert reply.json() == {"detail": "Not Found"}


def test_the_prefix_keyword_moves_the_base_and_defaults_to_the_catalogs() -> None:
    cfg = config()
    default = {route.path for route in routers.forms(make_datum(cfg)).routes}  # type: ignore[attr-defined]
    assert default == {
        "/api/forms/{key}/definition",
        "/api/forms/{key}/translations",
        "/api/data-sources/{id}",
    }
    moved = {route.path for route in routers.forms(make_datum(cfg), prefix="/v2/api").routes}  # type: ignore[attr-defined]
    assert moved == {p.replace("/api", "/v2/api", 1) for p in default}


def test_every_route_carries_the_catalog_tag_an_explicit_operation_id_and_the_datum_route_class() -> None:
    router = routers.forms(make_datum(config()))
    for route in router.routes:
        assert isinstance(route, DatumRoute)
        assert route.operation_id in {"getFormDefinition", "getFormTranslations", "getDataSourceItems"}
        assert route.tags == ["datum-forms"]


def test_a_factory_takes_its_datum_first_and_everything_else_by_keyword() -> None:
    with pytest.raises(TypeError):
        routers.forms(make_datum(config()), "/api")  # type: ignore[call-arg]


# ---- nothing global ------------------------------------------------------------------------------------------------
def test_including_the_routers_adds_no_middleware_no_handler_and_no_app_state() -> None:
    app = FastAPI()
    handlers_before = dict(app.exception_handlers)
    middleware_before = list(app.user_middleware)
    state_before = dict(vars(app.state))
    datum = make_datum(config(web={"assets": {"enabled": True}}))
    app.include_router(routers.forms(datum))
    app.include_router(routers.assets(datum))
    assert app.exception_handlers == handlers_before
    assert app.user_middleware == middleware_before
    assert dict(vars(app.state)) == state_before
    assert not hasattr(app.state, "datum")
    with TestClient(app):
        assert app.user_middleware == middleware_before
        assert not hasattr(app.state, "datum")


def test_the_applications_generate_unique_id_function_is_left_alone() -> None:
    def generate(route: Any) -> str:
        return f"app_{route.name}"

    app = FastAPI(generate_unique_id_function=generate)
    app.include_router(routers.forms(make_datum(config())))
    assert app.router.generate_unique_id_function is generate
    ids = {operation["operationId"] for item in app.openapi()["paths"].values() for operation in item.values()}
    assert ids == {"getFormDefinition", "getFormTranslations", "getDataSourceItems"}


# ---- group documents -----------------------------------------------------------------------------------------------
def group(**more: Any) -> DatumConfig:
    return config(web={"openapi": {"group_documents": True}, **more})


def test_the_group_document_is_that_factorys_routes_only_and_hidden_from_the_applications_schema() -> None:
    datum = make_datum(group(assets={"enabled": True}))
    app = FastAPI()

    @app.get("/mine")
    async def mine() -> dict[str, Any]:
        return {}

    app.include_router(routers.forms(datum))
    app.include_router(routers.assets(datum))
    with TestClient(app) as client:
        reply = client.get("/api/openapi/forms.json")
        assert reply.status_code == 200
        document = reply.json()
        assert set(document["paths"]) == {
            "/api/forms/{key}/definition",
            "/api/forms/{key}/translations",
            "/api/data-sources/{id}",
        }
        assert "/mine" not in document["paths"]
        assert "/api/openapi/forms.json" not in client.get("/openapi.json").json()["paths"]


def test_group_documents_on_with_every_switch_off_adds_no_route() -> None:
    cfg = config(definition_route=False, web={"openapi": {"group_documents": True}})
    assert list(routers.forms(make_datum(cfg)).routes) == []


def test_without_the_group_documents_switch_there_is_no_such_route() -> None:
    app = FastAPI()
    app.include_router(routers.forms(make_datum(config())))
    with TestClient(app) as client:
        assert client.get("/api/openapi/forms.json").status_code == 404


def test_the_group_document_is_404_when_the_application_has_no_openapi_url() -> None:
    app = FastAPI(openapi_url=None)
    app.include_router(routers.forms(make_datum(group())))
    with TestClient(app) as client:
        assert client.get("/api/openapi/forms.json").status_code == 404


def test_the_group_document_path_is_one_literal_per_factory_under_the_prefix() -> None:
    router = routers.forms(make_datum(group()), prefix="/v2/api")
    assert "/v2/api/openapi/forms.json" in {route.path for route in router.routes}  # type: ignore[attr-defined]


# ---- the AST rules ---------------------------------------------------------------------------------------------------
def routers_dir() -> Path:
    package = importlib.import_module("datum_fastapi.routers")
    assert package.__file__ is not None
    return Path(package.__file__).parent


def route_modules() -> list[Path]:
    """The router factories: `datum_fastapi/routers/*.py`."""
    return sorted(routers_dir().glob("*.py"))


def serializing_modules() -> list[Path]:
    """The route modules plus the route class and the body reader: none of them owns a serializer."""
    siblings = [routers_dir().parent / name for name in ("routing.py", "body.py")]
    return [*route_modules(), *(path for path in siblings if path.exists())]


def wire_codes() -> set[str]:
    codes = {code for e in catalog()["endpoints"] for s in e["statuses"] for code in s["codes"]}
    codes |= {code for c in catalog()["responses"] for code in c["codes"]}
    return codes | {"internal", "definition.tooDeep"}


def walk(path: Path) -> Iterator[ast.AST]:
    yield from ast.walk(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))


def test_there_are_route_modules_to_scan() -> None:
    names = {p.name for p in route_modules()}
    assert {"forms.py", "assets.py"} <= names


def test_route_modules_hold_no_json_library_call() -> None:
    offenders: list[str] = []
    for path in serializing_modules():
        for node in walk(path):
            if isinstance(node, ast.Import | ast.ImportFrom):
                names = [a.name for a in node.names] + [getattr(node, "module", None) or ""]
                if any(re.fullmatch(r"(ujson|orjson|simplejson|rapidjson|json)(\..*)?", n) for n in names):
                    offenders.append(f"{path.name}:{node.lineno} imports a JSON library")
            if isinstance(node, ast.Attribute) and node.attr in {
                "loads",
                "dumps",
                "load",
                "dump",
                "from_json",
                "to_json",
            }:
                offenders.append(f"{path.name}:{node.lineno} calls {node.attr}")
    assert offenders == []


def test_route_modules_hold_no_status_code_literal() -> None:
    """The rule covers routers/, routing.py and body.py; the codes live in datum_core.http."""
    offenders = [
        f"{path.name}:{node.lineno} {node.value}"
        for path in serializing_modules()
        for node in walk(path)
        if isinstance(node, ast.Constant)
        and isinstance(node.value, int)
        and not isinstance(node.value, bool)
        and 100 <= node.value <= 599
    ]
    for path in serializing_modules():
        for node in walk(path):
            if isinstance(node, ast.Attribute) and ast.unparse(node.value) == "HTTPStatus":
                offenders.append(f"{path.name}:{node.lineno} HTTPStatus.{node.attr}")
            if isinstance(node, ast.ImportFrom) and (node.module or "") in {"starlette.status", "fastapi.status"}:
                offenders.append(f"{path.name}:{node.lineno} imports {node.module}")
            if isinstance(node, ast.Import) and any(
                a.name in {"starlette.status", "fastapi.status"} for a in node.names
            ):
                offenders.append(f"{path.name}:{node.lineno} imports a status module")
            if (
                isinstance(node, ast.ImportFrom)
                and node.module in {"starlette", "fastapi"}
                and any(a.name == "status" for a in node.names)
            ):
                offenders.append(f"{path.name}:{node.lineno} imports status")
    assert offenders == []


def test_route_modules_hold_no_wire_code_literal() -> None:
    codes = wire_codes()
    offenders = [
        f"{path.name}:{node.lineno} {node.value!r}"
        for path in serializing_modules()
        for node in walk(path)
        if isinstance(node, ast.Constant) and isinstance(node.value, str) and node.value in codes
    ]
    assert offenders == []


def test_route_modules_raise_no_datum_error() -> None:
    offenders: list[str] = []
    for path in route_modules():
        for node in walk(path):
            if isinstance(node, ast.Raise) and node.exc is not None:
                target = node.exc.func if isinstance(node.exc, ast.Call) else node.exc
                name = target.id if isinstance(target, ast.Name) else getattr(target, "attr", "")
                if name.startswith("Datum") and name.endswith("Error"):
                    offenders.append(f"{path.name}:{node.lineno} raises {name}")
    assert offenders == []


def _owner_is_the_application(text: str, owner: ast.expr) -> bool:
    """Whether an owner spells the application: `app`, `*.app`, `*.app.router`, `app.router` or a scope key."""
    if text in {"app", "app.router"} or text.endswith((".app", ".app.router")):
        return True
    return (
        isinstance(owner, ast.Subscript)
        and isinstance(owner.slice, ast.Constant)
        and owner.slice.value in {"app", "router"}
    )


def application_reaches(tree: ast.AST) -> list[str]:
    """The reaches into the application: its routes, its state, or a schema built from its routes."""
    found: list[str] = []
    for node in ast.walk(tree):
        if (
            isinstance(node, ast.Attribute)
            and node.attr in {"routes", "state"}
            and _owner_is_the_application(ast.unparse(node.value), node.value)
        ):
            found.append(f"{node.lineno} {ast.unparse(node)}")
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute) and node.func.attr == "openapi":
            owner = ast.unparse(node.func.value)
            if owner.endswith("app"):
                found.append(f"{node.lineno} {ast.unparse(node)}")
    return found


@pytest.mark.parametrize(
    "source",
    [
        "request.app.routes",
        "app.routes",
        "request.app.router.routes",
        "app.router.routes",
        'request.scope["app"].routes',
        'request.scope["router"].routes',
        "request.app.openapi()",
        "app.state",
        "request.app.state",
        'request.scope["app"].state',
    ],
)
def test_the_application_reach_matcher_flags_each_spelling(source: str) -> None:
    assert application_reaches(ast.parse(source)) != []


@pytest.mark.parametrize("source", ["router.routes", "self.routes", "request.state", "datum.state", "self.openapi()"])
def test_the_application_reach_matcher_leaves_a_factorys_own_names_alone(source: str) -> None:
    assert application_reaches(ast.parse(source)) == []


def test_no_module_of_the_binding_walks_the_applications_routes_or_state() -> None:
    package = importlib.import_module("datum_fastapi")
    assert package.__file__ is not None
    offenders = [
        f"{path.name}:{found}"
        for path in sorted(Path(package.__file__).parent.rglob("*.py"))
        for found in application_reaches(ast.parse(path.read_text(encoding="utf-8"), filename=str(path)))
    ]
    assert offenders == []


def test_the_binding_never_registers_a_handler_a_middleware_or_a_id_generator() -> None:
    package = importlib.import_module("datum_fastapi")
    assert package.__file__ is not None
    forbidden = {"add_middleware", "add_exception_handler", "exception_handler", "generate_unique_id_function"}
    offenders = [
        f"{path.name}:{node.lineno} {node.attr}"
        for path in sorted(Path(package.__file__).parent.rglob("*.py"))
        for node in walk(path)
        if isinstance(node, ast.Attribute) and node.attr in forbidden
    ]
    assert offenders == []
