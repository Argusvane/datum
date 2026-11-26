"""`routers.management`: health, livez, readyz, info and recheck.

Privileged: `dependencies` is a required keyword (`dependencies=[]` the explicit opt-out). `livez` and `readyz` are
public probes and stay open; `health`, `info` and `recheck` are guarded. Tag `datum-management`; none of the routes is a
catalog operation.
"""

import asyncio
import inspect
import sys
from collections.abc import Iterator
from typing import Any

import httpx2
import pytest
from catalog_support import catalog
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, refusing, runtime_of, sandbox_of
from fastapi import Depends, FastAPI
from fastapi.testclient import TestClient
from submissions_fakes import operations_of, paths_of
from trace_log import TRACE

from datum_core import DatumConfig
from datum_core.health import ComponentHealth, HealthReport
from datum_fastapi import Datum, routers
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.protocol import ProgramUnavailableError


class FlakySandbox(StubSandbox):
    """A sandbox whose ABI proof fails until `fixed` is set: the runtime starts down with `fail_fast` off."""

    def __init__(self) -> None:
        super().__init__()
        self.fixed = False

    def prove_abi(self) -> None:
        if not self.fixed:
            raise ProgramUnavailableError("the program is too old")
        super().prove_abi()


def make_datum(cfg: DatumConfig | None = None, **seams: Any) -> Datum:
    seams.setdefault("runtime", runtime_of(StubRuntime()))
    seams.setdefault("sandbox", sandbox_of(StubSandbox()))
    return Datum(config=cfg or config(), form_repository=StubRepository(definition("contact")), **seams)


def app_of(datum: Datum, *, dependencies: Any = (), **kwargs: Any) -> FastAPI:
    app = FastAPI()
    app.include_router(routers.management(datum, dependencies=list(dependencies), **kwargs))
    return app


@pytest.fixture
def client() -> Iterator[TestClient]:
    with TestClient(app_of(make_datum())) as running:
        yield running


# -- the privileged rule -----------------------------------------------------------------------------------------------
@pytest.mark.parametrize("factory", [routers.management, routers.authoring], ids=["management", "authoring"])
def test_a_privileged_factory_requires_dependencies_as_a_keyword_without_a_default(factory: Any) -> None:
    parameter = inspect.signature(factory).parameters["dependencies"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty
    with pytest.raises(TypeError):
        factory(make_datum())


def test_an_empty_list_is_the_explicit_opt_out_and_the_prefix_defaults_to_the_root() -> None:
    router = routers.management(make_datum(), dependencies=[])
    assert paths_of(router) >= {"/health", "/livez", "/readyz", "/info"}


def test_the_prefix_keyword_moves_every_route() -> None:
    router = routers.management(make_datum(), prefix="/ops", dependencies=[])
    paths = paths_of(router)
    assert {"/ops/health", "/ops/livez", "/ops/readyz", "/ops/info"} <= paths


def test_the_routes_carry_the_management_tag_an_operation_id_outside_the_catalog_and_are_documented() -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    app = app_of(datum)
    document = app.openapi()
    operations = [op for item in document["paths"].values() for op in item.values()]
    assert {op["tags"][0] for op in operations} == {"datum-management"}
    ids = {op["operationId"] for op in operations}
    assert len(ids) == 5
    assert not ids & {e["operationId"] for e in catalog()["endpoints"]}
    assert len(catalog()["endpoints"]) == 24


def test_the_management_paths_methods_and_nothing_else() -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    routes = {
        (method, route.path)
        for route in operations_of(routers.management(datum, dependencies=[])).values()
        for method in route.methods or ()
    }
    assert routes == {
        ("GET", "/health"),
        ("GET", "/livez"),
        ("GET", "/readyz"),
        ("GET", "/info"),
        ("POST", "/recheck"),
    }


# -- livez -------------------------------------------------------------------------------------------------------------
def test_livez_is_200_with_no_body_and_builds_no_report(monkeypatch: pytest.MonkeyPatch) -> None:
    datum = make_datum()
    calls: list[str] = []

    def spy() -> HealthReport:
        calls.append("health")
        raise AssertionError("livez must not build a report")

    monkeypatch.setattr(datum, "health", spy)
    with TestClient(app_of(datum)) as running:
        replies = [running.get("/livez") for _ in range(3)]
    assert [reply.status_code for reply in replies] == [200, 200, 200]
    assert all(reply.content == b"" for reply in replies)
    assert calls == []


def test_livez_answers_while_the_process_answers_even_before_the_lifespan_ran() -> None:
    reply = TestClient(app_of(make_datum())).get("/livez")  # no `with`: no lifespan
    assert reply.status_code == 200
    assert reply.content == b""


def test_livez_is_public_a_guard_does_not_apply_to_it() -> None:
    app = app_of(make_datum(), dependencies=[Depends(refusing(401, "guard"))])
    with TestClient(app) as running:
        assert running.get("/livez").status_code == 200
    assert "guard" not in TRACE


# -- readyz ------------------------------------------------------------------------------------------------------------
def test_readyz_is_200_with_no_body_when_the_runtime_is_up(client: TestClient) -> None:
    reply = client.get("/readyz")
    assert reply.status_code == 200
    assert reply.content == b""


def test_readyz_is_503_with_no_body_until_the_runtime_probed() -> None:
    sandbox = FlakySandbox()
    datum = make_datum(config(runtime={"fail_fast": False}), sandbox=sandbox_of(sandbox))
    with TestClient(app_of(datum)) as running:
        reply = running.get("/readyz")
        assert reply.status_code == 503
        assert reply.content == b""
        sandbox.fixed = True
        datum.recheck()
        assert running.get("/readyz").status_code == 200


def test_readyz_reads_the_runtime_only_so_another_components_problem_never_fails_it() -> None:
    datum = make_datum()
    datum.health_registry.register("tsa", lambda: ComponentHealth.down("no time source"))
    with TestClient(app_of(datum)) as running:
        assert running.get("/readyz").status_code == 200
        assert running.get("/health").status_code == 503


def test_readyz_is_the_health_reports_is_ready(monkeypatch: pytest.MonkeyPatch) -> None:
    datum = make_datum()
    asked: list[str] = []
    real = datum.health

    def spy() -> HealthReport:
        asked.append("health")
        return real()

    monkeypatch.setattr(datum, "health", spy)
    with TestClient(app_of(datum)) as running:
        running.get("/readyz")
    assert asked == ["health"]


def test_readyz_is_public_a_guard_does_not_apply_to_it() -> None:
    app = app_of(make_datum(), dependencies=[Depends(refusing(403, "guard"))])
    with TestClient(app) as running:
        assert running.get("/readyz").status_code == 200


# -- health ------------------------------------------------------------------------------------------------------------
def test_health_is_200_with_the_flat_report_when_everything_is_up(client: TestClient) -> None:
    reply = client.get("/health")
    assert reply.status_code == 200
    document = reply.json()
    assert document["status"] == "up"
    assert {"runtime", "stores.snapshots", "stores.translations"} <= set(document["components"])
    assert all(set(item) == {"status", "details"} for item in document["components"].values())


def test_health_is_503_with_the_report_when_a_component_is_down() -> None:
    datum = make_datum()
    datum.health_registry.register("tsa", lambda: ComponentHealth.down("no time source"))
    with TestClient(app_of(datum)) as running:
        reply = running.get("/health")
    assert reply.status_code == 503
    assert reply.json()["status"] == "down"
    assert reply.json()["components"]["tsa"] == {"status": "down", "details": {"reason": "no time source"}}


def test_health_with_the_runtime_down_names_the_reason() -> None:
    datum = make_datum(config(runtime={"fail_fast": False}), sandbox=sandbox_of(FlakySandbox()))
    with TestClient(app_of(datum)) as running:
        reply = running.get("/health")
    assert reply.status_code == 503
    assert "too old" in reply.json()["components"]["runtime"]["details"]["reason"]


# -- info --------------------------------------------------------------------------------------------------------------
def test_info_is_the_flat_datum_info(client: TestClient) -> None:
    reply = client.get("/info")
    assert reply.status_code == 200
    document = reply.json()
    assert {"engineVersion", "sandboxAbi", "pdfAbi", "buildId", "engine", "capabilities"} <= set(document)
    assert "components" not in document


def test_info_carries_the_sandbox_settings_report_without_a_host_path(tmp_path: Any) -> None:
    captures = tmp_path / "captures"
    cfg = config(runtime={"validation": {"wait": 3}, "diagnostics": {"capture": {"directory": str(captures)}}})
    with TestClient(app_of(make_datum(cfg))) as running:
        reply = running.get("/info")
    settings = reply.json()["settings"]
    entries = {entry["key"]: entry for entry in settings["entries"]}
    assert entries["datum.runtime.validation.wait"] == {
        "key": "datum.runtime.validation.wait",
        "value": 3.0,
        "source": "configured",
    }
    assert entries["datum.runtime.engine"]["source"] == "replaced", "the application gave its own runtime"
    assert "datum.runtime.diagnostics.capture.directory" not in entries
    assert str(captures) not in reply.text, "no value naming a path of the host"
    assert "notes" not in settings["engine"]


def test_info_holds_no_secret() -> None:
    cfg = config(web={"throttle": {"storage": "redis://:hunter2@cache.internal:6379/0"}})
    with TestClient(app_of(make_datum(cfg))) as running:
        text = running.get("/info").text
    assert "hunter2" not in text
    assert "cache.internal" not in text


# -- the guard ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(("method", "path"), [("get", "/health"), ("get", "/info"), ("post", "/recheck")])
@pytest.mark.parametrize("status", [401, 403])
def test_health_info_and_recheck_refuse_an_unauthenticated_caller(method: str, path: str, status: int) -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    app = app_of(datum, dependencies=[Depends(refusing(status, "guard"))])
    with TestClient(app) as running:
        reply = getattr(running, method)(path)
    assert reply.status_code == status
    assert reply.json() == {"detail": "guard refused"}
    assert TRACE == ["guard"]


def test_the_probes_stay_open_beside_the_guarded_routes() -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    app = app_of(datum, dependencies=[Depends(refusing(401, "guard"))])
    with TestClient(app) as running:
        assert [running.get("/livez").status_code, running.get("/readyz").status_code] == [200, 200]
        assert [running.get("/health").status_code, running.get("/info").status_code] == [401, 401]


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_include_time_dependencies_run_before_the_started_guard() -> None:
    datum = make_datum()
    app = FastAPI()
    app.include_router(routers.management(datum, dependencies=[]), dependencies=[Depends(refusing(401, "outer"))])
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:  # no lifespan: no 503
        reply = await http.get("/info")
    assert reply.status_code == 401
    assert TRACE == ["outer"]


# -- recheck -----------------------------------------------------------------------------------------------------------
def test_recheck_is_absent_with_the_switch_off(client: TestClient) -> None:
    reply = client.post("/recheck")
    assert reply.status_code == 404
    assert reply.json() == {"detail": "Not Found"}


def test_recheck_is_present_with_the_switch_on_and_answers_the_report() -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    with TestClient(app_of(datum)) as running:
        reply = running.post("/recheck")
        assert running.get("/recheck").status_code == 405
    assert reply.status_code == 200
    assert reply.json()["status"] == "up"


def test_recheck_brings_a_down_runtime_up_and_answers_503_while_it_stays_down() -> None:
    sandbox = FlakySandbox()
    datum = make_datum(
        config(runtime={"fail_fast": False}, web={"management": {"recheck": True}}), sandbox=sandbox_of(sandbox)
    )
    with TestClient(app_of(datum)) as running:
        still_down = running.post("/recheck")
        sandbox.fixed = True
        up = running.post("/recheck")
    assert still_down.status_code == 503
    assert up.status_code == 200
    assert up.json()["components"]["runtime"]["status"] == "up"


def test_recheck_runs_off_the_event_loop(monkeypatch: pytest.MonkeyPatch) -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    seen: list[str] = []
    real = datum.recheck

    def spy() -> HealthReport:
        try:
            asyncio.get_running_loop()
        except RuntimeError:
            seen.append("worker")
        else:
            seen.append("loop")
        return real()

    monkeypatch.setattr(datum, "recheck", spy)
    with TestClient(app_of(datum)) as running:
        running.post("/recheck")
    assert seen == ["worker"]


def test_readyz_is_503_before_the_lifespan_and_after_its_exit() -> None:
    app = app_of(make_datum())
    with TestClient(app) as running:
        assert running.get("/readyz").status_code == 200
    for state in ("after",):
        reply = TestClient(app).get("/readyz")
        assert (reply.status_code, reply.content, state) == (503, b"", state)
    before = TestClient(app_of(make_datum())).get("/readyz")
    assert (before.status_code, before.content) == (503, b"")


def test_a_router_with_the_recheck_off_adds_no_recheck_route() -> None:
    router = routers.management(make_datum(), dependencies=[])
    assert "/recheck" not in paths_of(router)


# -- the guard order and the bodiless readyz -------------------------------------------------------------------
@pytest.mark.parametrize(("method", "path"), [("get", "/health"), ("get", "/info"), ("post", "/recheck")])
def test_the_applications_dependencies_run_before_the_entered_guard(method: str, path: str) -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    order: list[str] = []
    real = datum.started_guard.entered

    async def spy() -> None:
        order.append("entered")
        await real()

    datum.started_guard.entered = spy  # type: ignore[method-assign]
    app = app_of(datum, dependencies=[Depends(refusing(401, "guard"))])
    reply = getattr(TestClient(app), method)(path)  # no lifespan: the entered guard would answer 503
    assert reply.status_code == 401
    assert TRACE == ["guard"]
    assert order == []


@pytest.mark.parametrize(("method", "path"), [("get", "/health"), ("get", "/info"), ("post", "/recheck")])
def test_a_caller_the_dependencies_let_through_meets_the_entered_guard_second(method: str, path: str) -> None:
    datum = make_datum(config(web={"management": {"recheck": True}}))
    reply = getattr(TestClient(app_of(datum)), method)(path)  # no lifespan
    assert reply.status_code == 503
    assert reply.json()["errors"][0]["code"] == "server.unavailable"


def _runtime_down_datum() -> Datum:
    return make_datum(config(runtime={"fail_fast": False}), sandbox=sandbox_of(FlakySandbox()))


def test_readyz_refuses_bodiless_in_each_state_without_the_guards_envelope(caplog: pytest.LogCaptureFixture) -> None:
    app = app_of(_runtime_down_datum())
    before = TestClient(app).get("/readyz")
    with TestClient(app) as running:
        down = running.get("/readyz")
    after = TestClient(app).get("/readyz")
    for reply in (before, down, after):
        assert reply.status_code == 503
        assert reply.content == b""
        assert "retry-after" not in reply.headers
        assert "content-type" not in reply.headers
    assert not [record for record in caplog.records if record.name == "datum.web" and record.levelname == "ERROR"]


def test_readyz_does_not_pass_through_the_started_guard() -> None:
    datum = make_datum()

    async def refuse() -> None:
        raise AssertionError("readyz must not ask the StartedGuard")

    datum.started_guard.entered = refuse  # type: ignore[method-assign]
    assert TestClient(app_of(datum)).get("/readyz").status_code == 503


def test_a_network_throttle_that_cannot_be_built_stops_the_start_with_e006(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setitem(sys.modules, "redis", None)  # the absence this test depends on, pinned
    monkeypatch.setitem(sys.modules, "coredis", None)
    cfg = config(
        web={
            "api": {"endpoints": {"submissions": True}},
            "throttle": {"storage": "redis://localhost:6379", "key_salt": "s" * 32},
        }
    )
    with pytest.raises(DatumConfigurationError, match=r"datum\.E006"), TestClient(app_of(make_datum(cfg))):
        pass
