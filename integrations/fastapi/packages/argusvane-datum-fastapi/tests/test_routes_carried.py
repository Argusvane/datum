"""The submission routes' answers per route, the forms-route cases they share, and the intake rules.

Each parametrized case runs on all four routes (`submitSubmission`, `validateSubmission`, `testSubmission`,
`inspectDefinition`): the mapping is `DatumRoute`'s, so it must hold wherever a service raises or answers.
"""

import asyncio
import json
import logging
from collections.abc import Mapping
from typing import TYPE_CHECKING, Any

import pytest
from datum_fakes import definition
from fastapi import APIRouter, FastAPI
from fastapi.testclient import TestClient
from starlette.datastructures import Headers
from starlette.requests import Request
from submissions_fakes import Parts, body_of, build_app, check_body_of, config, envelope, make_datum
from trace_log import TRACE

from datum_core import DatumConfig
from datum_core.health import HealthReport
from datum_core.http import HttpAnswer
from datum_core.loggers import CHECKS
from datum_fastapi import AnswerError, DatumRoute, routers
from datum_fastapi.routers._intake import context_of, principal_name
from datum_sandbox.protocol import DefinitionTooDeepError, ProgramUnavailableError, SandboxError, SandboxFailure
from datum_sandbox.wasi import EngineBusyError

if TYPE_CHECKING:
    from starlette.types import Scope

JSON = {"Content-Type": "application/json"}
INSPECT = json.dumps({"op": "abi", "definition": definition("contact")}).encode()
ROUTES = [
    pytest.param("/api/submissions", body_of(), id="submit"),
    pytest.param("/api/submissions/validate", check_body_of(), id="validate"),
    pytest.param("/api/submissions/test", body_of(), id="test"),
    pytest.param("/api/inspect", INSPECT, id="inspect"),
]
MODES = pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])


def code_of(reply: Any, *, problem: bool) -> str:
    document = reply.json()
    return str(document["code"] if problem else document["errors"][0]["code"])


def post(parts: Parts, path: str, content: bytes, *, problem: bool = False, **sections: Any) -> Any:
    cfg = config(web={"api": {"problem_details": problem, "busy_retry_after": 9}}, **sections)
    datum, _ = make_datum(cfg, parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        return running.post(path, content=content, headers=JSON)


# -- one answer per failure, on every route --------------------------------------------------------------------------
@MODES
@pytest.mark.parametrize(("path", "content"), ROUTES)
def test_a_runtime_that_is_down_is_503_unavailable_with_no_retry_after_on_every_route(
    path: str, content: bytes, problem: bool
) -> None:
    parts = Parts()
    parts.sandbox.error = ProgramUnavailableError("the runtime is down")
    reply = post(parts, path, content, problem=problem)
    assert (reply.status_code, code_of(reply, problem=problem), reply.headers.get("retry-after")) == (
        503,
        "server.unavailable",
        None,
    )


@MODES
@pytest.mark.parametrize(("path", "content"), ROUTES)
def test_a_busy_engine_is_503_busy_with_the_configured_retry_after_on_every_route(
    path: str, content: bytes, problem: bool
) -> None:
    parts = Parts()
    parts.sandbox.error = EngineBusyError("slots")
    reply = post(parts, path, content, problem=problem)
    assert (reply.status_code, code_of(reply, problem=problem), reply.headers["retry-after"]) == (
        503,
        "server.busy",
        "9",
    )


@MODES
@pytest.mark.parametrize(("path", "content"), ROUTES)
def test_a_definition_nested_too_deep_is_too_deep_and_carries_no_retry_after_on_every_route(
    path: str, content: bytes, problem: bool
) -> None:
    parts = Parts()
    parts.sandbox.error = DefinitionTooDeepError(64, "the definition nests past 64 levels")
    reply = post(parts, path, content, problem=problem)
    # The registered form is the server's own: a failed run, 503 with the code. Inspect's definition is the caller's.
    expected = 422 if path == "/api/inspect" else 503
    assert (reply.status_code, code_of(reply, problem=problem)) == (expected, "definition.tooDeep")
    assert "retry-after" not in reply.headers
    assert "64 levels" not in reply.text


@MODES
@pytest.mark.parametrize(
    ("failure", "wire"),
    [
        pytest.param(SandboxFailure.THREW, "wasm.execution_error", id="threw"),
        pytest.param(SandboxFailure.BUDGET, "wasm.execution_error", id="time limit"),
        pytest.param(SandboxFailure.OUTCOME_TOO_LARGE, "outcome_too_large", id="outcome"),
    ],
)
@pytest.mark.parametrize(("path", "content"), ROUTES)
def test_a_run_that_gave_no_answer_is_503_with_the_runs_code_and_no_retry_after_on_every_route_inspect_included(
    path: str, content: bytes, problem: bool, failure: SandboxFailure, wire: str
) -> None:
    parts = Parts()
    parts.sandbox.error = SandboxError(failure, "the guest said secret words")
    reply = post(parts, path, content, problem=problem)
    assert (reply.status_code, code_of(reply, problem=problem)) == (503, wire)
    assert "retry-after" not in reply.headers
    assert "secret words" not in reply.text


@pytest.mark.parametrize(("path", "content"), ROUTES)
def test_a_throttled_request_is_429_flood_with_whole_seconds_on_every_route(path: str, content: bytes) -> None:
    parts = Parts()
    parts.throttle.deny = 13
    reply = post(parts, path, content)
    assert (reply.status_code, code_of(reply, problem=False), reply.headers["retry-after"]) == (429, "flood", "13")


# -- the exact 500 bodies --------------------------------------------------------------------------------------------
def test_the_500_body_is_exactly_the_internal_error_with_no_member_beyond_it_in_the_default_mode() -> None:
    parts = Parts()
    parts.handler.fail = RuntimeError("password=ZZSECRETZZ")
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum), raise_server_exceptions=False) as running:
        reply = running.post("/api/submissions", content=body_of(), headers={**JSON, "X-Request-ID": "req-1"})
    assert reply.status_code == 500
    assert reply.headers["content-type"] == "application/json"
    assert reply.json() == {"errors": [{"code": "internal"}]}
    assert "retry-after" not in reply.headers


def test_the_500_body_is_exactly_the_problem_document_with_the_correlation_id_in_problem_mode() -> None:
    parts = Parts()
    parts.handler.fail = RuntimeError("password=ZZSECRETZZ")
    datum, _ = make_datum(config(web={"api": {"problem_details": True}}), parts=parts)
    with TestClient(build_app(datum), raise_server_exceptions=False) as running:
        reply = running.post("/api/submissions", content=body_of(), headers={**JSON, "X-Request-ID": "req-1"})
    assert reply.status_code == 500
    assert reply.headers["content-type"] == "application/problem+json"
    assert reply.json() == {
        "type": "about:blank",
        "title": "Internal Server Error",
        "status": 500,
        "code": "internal",
        "correlationId": "req-1",
        "errors": [{"code": "internal"}],
    }


def test_the_500_is_logged_on_datum_web_with_the_traceback_and_not_on_the_root_logger(
    caplog: pytest.LogCaptureFixture,
) -> None:
    parts = Parts()
    parts.handler.fail = RuntimeError("boom")
    datum, _ = make_datum(parts=parts)
    with caplog.at_level(logging.ERROR), TestClient(build_app(datum), raise_server_exceptions=False) as running:
        running.post("/api/submissions", content=body_of(), headers={**JSON, "X-Request-ID": "req-2"})
    records = [r for r in caplog.records if "req-2" in r.getMessage()]
    assert [r.name for r in records] == ["datum.web"]
    assert records[0].exc_info is not None
    assert isinstance(records[0].exc_info[1], RuntimeError)


# -- the translator log ----------------------------------------------------------------------------------------------
def test_a_translator_that_raises_is_logged_with_the_correlation_id_and_the_next_one_answers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def broken(error: Exception) -> HttpAnswer | None:
        raise ValueError("translator bug")

    def teapot(error: Exception) -> HttpAnswer | None:
        return HttpAnswer(418, {"Content-Type": "application/json"}, b'{"errors":[{"code":"teapot"}]}')

    parts = Parts()
    parts.handler.fail = KeyError("anything")
    datum, _ = make_datum(parts=parts, error_translators=[broken, teapot])
    with caplog.at_level(logging.ERROR), TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers={**JSON, "X-Request-ID": "req-3"})
    assert reply.status_code == 418
    logged = [r for r in caplog.records if getattr(r, "datum_correlation_id", None) == "req-3"]
    assert len(logged) == 1
    assert logged[0].name == "datum.web"
    assert "req-3" in logged[0].getMessage()
    assert logged[0].exc_info is not None


# -- the unbound route class -----------------------------------------------------------------------------------------
def test_a_datum_route_with_no_datum_bound_takes_its_defaults_from_the_configuration_model() -> None:
    api = DatumConfig().web.api
    app = FastAPI()
    router = APIRouter(route_class=DatumRoute)

    @router.get("/busy")
    async def busy() -> None:
        raise EngineBusyError("slots")

    app.include_router(router)
    with TestClient(app) as running:
        reply = running.get("/busy")
    assert reply.status_code == 503
    assert reply.headers["retry-after"] == str(api.busy_retry_after)


# -- the loop guard --------------------------------------------------------------------------------------------------
def test_a_second_event_loop_is_refused_with_its_own_message_and_is_not_a_failed_start() -> None:
    datum, _ = make_datum()
    first = asyncio.new_event_loop()
    second = asyncio.new_event_loop()
    try:
        first.run_until_complete(datum.__aenter__())
        with pytest.raises(RuntimeError, match="one event loop at a time"):
            second.run_until_complete(datum.__aenter__())
        assert datum.entries == 1
        assert datum.started_guard._start_failed is False
        first.run_until_complete(datum.__aexit__(None, None, None))
    finally:
        first.close()
        second.close()


# -- the group documents ---------------------------------------------------------------------------------------------
def test_a_group_document_lists_only_the_tags_its_routes_use() -> None:
    datum, _ = make_datum(config(web={"openapi": {"group_documents": True}}))
    with TestClient(build_app(datum, authoring=[])) as running:
        public = running.get("/api/openapi/submissions.json").json()
        private = running.get("/api/openapi/authoring.json").json()
    assert [tag["name"] for tag in public["tags"]] == ["datum-submissions"]
    assert [tag["name"] for tag in private["tags"]] == ["datum-submissions"]


def test_a_group_document_keeps_the_factorys_own_paths_whatever_prefix_the_application_includes_it_under() -> None:
    datum, _ = make_datum(config(web={"openapi": {"group_documents": True}}))
    app = FastAPI()
    app.include_router(routers.submissions(datum), prefix="/v1")
    with TestClient(app) as running:
        document = running.get("/v1/api/openapi/submissions.json").json()
    assert set(document["paths"]) == {"/api/submissions", "/api/submissions/validate"}  # not under /v1


# -- W001 ------------------------------------------------------------------------------------------------------------
def test_a_submissions_or_authoring_router_with_every_switch_off_adds_no_route_and_one_w001_each(
    caplog: pytest.LogCaptureFixture,
) -> None:
    cfg = config(web={"api": {"endpoints": {"submissions": False, "validate": False, "test": False, "inspect": False}}})
    datum, _ = make_datum(cfg)
    public, private = routers.submissions(datum), routers.authoring(datum, dependencies=[])
    assert list(public.routes) == []
    assert list(private.routes) == []
    app = FastAPI()
    app.include_router(public)
    app.include_router(private)
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(app):
        pass
    lines = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"]
    messages = [line for line in lines if line.startswith("(")]
    assert len(messages) == 2
    assert any("router submissions" in m for m in messages)
    assert any("router authoring" in m for m in messages)


# -- the intake ------------------------------------------------------------------------------------------------------
class Named:
    def __init__(self, **attributes: object) -> None:
        for name, value in attributes.items():
            setattr(self, name, value)


@pytest.mark.parametrize(
    ("principal", "expected"),
    [
        (None, None),
        ("alice", "alice"),
        ("", None),
        (Named(username="bob", name="Robert"), "bob"),
        (Named(name="Robert"), "Robert"),
        (Named(username=42), None),
        (object(), None),
    ],
)
def test_the_throttle_counts_a_principal_by_its_name_when_it_has_one(principal: object, expected: str | None) -> None:
    assert principal_name(principal) == expected


def request_of(headers: Mapping[str, str], client: tuple[str, int] | None = ("203.0.113.5", 1234)) -> Request:
    scope: Scope = {
        "type": "http",
        "method": "POST",
        "path": "/",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": client,
    }
    return Request(scope)


def test_the_context_withholds_the_credentials_and_keeps_the_other_headers() -> None:
    request = request_of({"Authorization": "Bearer s3cret", "Cookie": "sid=1", "X-Tenant": "north", "User-Agent": "ua"})
    context = context_of(request, None, b"{}")
    assert context.headers == {"x-tenant": "north", "user-agent": "ua"}
    assert "s3cret" not in repr(context)
    assert context.remote_address == "203.0.113.5"


def test_a_request_with_no_client_is_counted_by_principal_alone() -> None:
    context = context_of(request_of({}, client=None), "alice", b"{}")
    assert context.remote_address is None
    assert context.throttle_key is not None
    assert (context.throttle_key.ip, context.throttle_key.principal) == (None, "alice")


def test_the_header_list_helper_reads_starlettes_headers_as_it_reads_a_plain_mapping() -> None:
    from datum_core.http import resolve_correlation_id  # noqa: PLC0415 - the helper that reads either

    headers = Headers({"X-Request-ID": "abc-123"})
    assert resolve_correlation_id(headers) == "abc-123"
    assert resolve_correlation_id({"X-Request-ID": "abc-123"}) == "abc-123"


# -- the management router and the entered guard ---------------------------------------------------------------------
def test_the_management_router_is_not_a_capability_so_it_raises_no_w001_when_included(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, _ = make_datum()
    app = FastAPI()
    app.include_router(routers.management(datum, dependencies=[]))
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(app):
        pass
    assert [r for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"] == []


def test_recheck_goes_through_the_runner_and_is_the_unavailable_answer_outside_the_lifespan() -> None:
    datum, _ = make_datum(config(web={"management": {"recheck": True}}))

    async def drive() -> HealthReport:
        async with datum:
            return await datum.async_recheck()

    assert asyncio.run(drive()).is_ready

    async def outside() -> None:
        await datum.async_recheck()

    with pytest.raises(AnswerError) as raised:
        asyncio.run(outside())
    assert raised.value.answer.status == datum.unavailable_answer().status


# -- mounted mode ----------------------------------------------------------------------------------------------------
def test_the_mounted_sub_application_serves_the_public_submission_routes_and_not_the_privileged_ones() -> None:
    datum, _ = make_datum()
    with TestClient(datum.asgi_app()) as running:
        assert running.post("/api/submissions", content=body_of(), headers=JSON).status_code == 200
        assert running.post("/api/submissions/validate", content=check_body_of(), headers=JSON).status_code == 200
        assert running.post("/api/submissions/test", content=body_of(), headers=JSON).status_code == 404
        assert running.get("/health").status_code == 404


@MODES
@pytest.mark.parametrize("path", ["/api/submissions", "/api/submissions/validate", "/api/submissions/test"])
def test_a_signed_wrapper_is_503_signing_not_set_up_and_reaches_no_handler_on_every_submission_route(
    path: str, problem: bool
) -> None:
    parts = Parts()
    wrapper = {
        "format": {"scope": "envelope", "placement": "wrapper", "digest": "sha-256", "canonicalization": "jcs"},
        "payload": envelope(),
        "signatures": [],
    }
    sent = check_body_of(wrapper) if path.endswith("/validate") else body_of(wrapper)
    reply = post(parts, path, sent, problem=problem)
    assert reply.status_code == 503
    assert code_of(reply, problem=problem) == "signing.not_set_up"
    assert "retry-after" not in reply.headers
    assert parts.handler.calls == []
    assert parts.throttle.keys == []
    assert parts.events == []
    assert TRACE == []
