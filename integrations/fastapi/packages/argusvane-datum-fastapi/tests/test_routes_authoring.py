"""`routers.authoring`: `testSubmission` and `inspectDefinition`, privileged.

They run an arbitrary definition or document from the body, so the factory takes `dependencies` as a required keyword;
`dependencies=[]` is the explicit opt-out. Both are catalog operations tagged `datum-submissions`.
"""

import inspect
import json
from collections.abc import Iterator
from typing import Any

import httpx2
import pytest
from catalog_support import endpoint, full_path
from datum_fakes import definition, refusing
from fastapi import Depends
from fastapi.testclient import TestClient
from submissions_fakes import Parts, body_of, build_app, config, envelope, make_datum, operations_of
from trace_log import TRACE

from datum_core.config.models import ThrottleKind
from datum_fastapi import routers
from datum_fastapi.lifespan import StartedGuard
from datum_sandbox.protocol import ProgramUnavailableError

JSON = {"Content-Type": "application/json"}
INSPECT_BODY = json.dumps({"op": "abi", "definition": definition("contact")}).encode()


def code(reply: Any) -> str:
    return str(reply.json()["errors"][0]["code"])


@pytest.fixture
def parts() -> Parts:
    return Parts()


@pytest.fixture
def client(parts: Parts) -> Iterator[TestClient]:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        yield running


# -- the privileged rule -----------------------------------------------------------------------------------------------
def test_the_factory_requires_dependencies_as_a_keyword_without_a_default() -> None:
    parameter = inspect.signature(routers.authoring).parameters["dependencies"]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert parameter.default is inspect.Parameter.empty


def test_a_call_without_dependencies_is_a_type_error_and_an_empty_list_is_the_explicit_opt_out() -> None:
    datum, _ = make_datum()
    factory: Any = routers.authoring
    with pytest.raises(TypeError):
        factory(datum)
    with pytest.raises(TypeError):
        factory(datum, [])
    assert routers.authoring(datum, dependencies=[]) is not None


def test_the_public_submissions_factory_is_not_privileged_and_needs_no_dependencies() -> None:
    parameter = inspect.signature(routers.submissions).parameters["dependencies"]
    assert parameter.default is not inspect.Parameter.empty


# -- the catalog rows --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("operation_id", ["testSubmission", "inspectDefinition"])
def test_each_route_is_the_catalog_row_by_method_path_and_tag(operation_id: str) -> None:
    datum, _ = make_datum()
    routes = operations_of(routers.authoring(datum, dependencies=[]))
    row = endpoint(operation_id)
    route = routes[operation_id]
    assert route.path == full_path(row)
    assert route.methods == {row["method"]}
    assert route.tags == ["datum-submissions"]


@pytest.mark.parametrize(
    ("switches", "expected"),
    [
        ({"test": True, "inspect": False}, {"testSubmission"}),
        ({"test": False, "inspect": True}, {"inspectDefinition"}),
        ({"test": True, "inspect": True}, {"testSubmission", "inspectDefinition"}),
        ({"test": False, "inspect": False}, set()),
    ],
)
def test_each_switch_adds_exactly_its_route_and_the_public_endpoints_add_none_here(
    switches: dict[str, bool], expected: set[str]
) -> None:
    cfg = config(web={"api": {"endpoints": {**switches, "submissions": True, "validate": True}}})
    datum, _ = make_datum(cfg)
    found = set(operations_of(routers.authoring(datum, dependencies=[])))
    assert found == expected


def test_the_public_and_the_privileged_router_split_the_four_operations_with_no_overlap() -> None:
    datum, _ = make_datum()
    public = set(operations_of(routers.submissions(datum)))
    private = set(operations_of(routers.authoring(datum, dependencies=[])))
    assert public & private == set()
    assert public | private == {"submitSubmission", "validateSubmission", "testSubmission", "inspectDefinition"}


# -- the guard ---------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("path", ["/api/submissions/test", "/api/inspect"])
@pytest.mark.parametrize("status", [401, 403])
def test_the_applications_dependencies_guard_every_authoring_route_and_run_before_the_body_is_read(
    path: str, status: int, parts: Parts
) -> None:
    datum, _ = make_datum(parts=parts)
    app = build_app(datum, authoring=[Depends(refusing(status, "guard"))])
    with TestClient(app) as running:
        reply = running.post(path, content=b"not even json", headers={"Content-Type": "text/plain"})
    assert reply.status_code == status
    assert reply.json() == {"detail": "guard refused"}
    assert TRACE == ["guard"]
    assert parts.throttle.keys == []


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
@pytest.mark.parametrize("path", ["/api/submissions/test", "/api/inspect"])
async def test_the_applications_dependencies_run_before_the_started_guard(
    path: str, parts: Parts, monkeypatch: pytest.MonkeyPatch
) -> None:
    datum, _ = make_datum(parts=parts)
    order: list[str] = []
    real = StartedGuard.__call__

    async def spy(self: StartedGuard) -> None:
        order.append("started")
        await real(self)

    monkeypatch.setattr(StartedGuard, "__call__", spy)
    app = build_app(datum, authoring=[Depends(refusing(401, "guard"))])
    transport = httpx2.ASGITransport(app=app)
    async with httpx2.AsyncClient(transport=transport, base_url="http://testserver") as http:  # no lifespan: no 503
        reply = await http.post(path, content=b"{}", headers=JSON)
    assert reply.status_code == 401
    assert TRACE == ["guard"]
    assert order == []


def test_a_guard_on_the_authoring_router_does_not_guard_the_public_one(parts: Parts) -> None:
    datum, _ = make_datum(parts=parts)
    app = build_app(datum, authoring=[Depends(refusing(403, "guard"))])
    with TestClient(app) as running:
        assert running.post("/api/submissions", content=body_of(), headers=JSON).status_code == 200


# -- the dry run -------------------------------------------------------------------------------------------------------
def test_the_dry_run_answers_200_with_a_report_and_stores_nothing(client: TestClient, parts: Parts) -> None:
    reply = client.post("/api/submissions/test", content=body_of(), headers=JSON)
    assert reply.status_code == 200
    document = reply.json()
    assert document["outcome"] == "accepted"
    assert "accepted" not in document
    assert "report" not in document
    assert list(document) == [
        "outcome",
        "stage",
        "errors",
        "sent",
        "values",
        "clientDerived",
        "clockDependent",
        "serverRules",
        "visibilitySkipped",
        "document",
        "digest",
        "logs",
        "sandbox",
        "signature",
    ]
    assert parts.handler.calls == []
    assert parts.events == []


def test_the_dry_run_wants_the_wrapper_and_reads_a_bare_envelope_as_400_bad_document(
    client: TestClient, parts: Parts
) -> None:
    bare = client.post("/api/submissions/test", content=body_of(wrapped=False), headers=JSON)
    assert (bare.status_code, code(bare)) == (400, "bad_document")
    assert parts.sandbox.contexts == []
    assert client.post("/api/submissions/test", content=body_of(), headers=JSON).status_code == 200


def test_the_dry_run_is_counted_under_the_test_kind(client: TestClient, parts: Parts) -> None:
    client.post("/api/submissions/test", content=body_of(), headers=JSON)
    assert [key.kind for key in parts.throttle.keys] == [ThrottleKind.TEST]


def test_the_dry_run_has_the_wire_order_415_cap_parse_per_form_throttle_sandbox() -> None:
    parts = Parts()
    datum, _ = make_datum(config(web={"api": {"max_body_size": "4KiB"}}), parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        assert (
            running.post(
                "/api/submissions/test", content=b"x" * 9000, headers={"Content-Type": "text/plain"}
            ).status_code
            == 415
        )
        assert running.post("/api/submissions/test", content=b"{" + b"x" * 9000, headers=JSON).status_code == 413
        assert running.post("/api/submissions/test", content=b"{", headers=JSON).status_code == 400
        assert TRACE == []
        parts.throttle.deny = 5
        assert running.post("/api/submissions/test", content=body_of(), headers=JSON).status_code == 429
        assert TRACE == ["throttle"]
        parts.throttle.deny = None
        TRACE.clear()
        assert running.post("/api/submissions/test", content=body_of(), headers=JSON).status_code == 200
        assert TRACE == ["throttle", "sandbox"]


def test_the_dry_run_of_an_unknown_form_is_404_and_a_runtime_down_is_503(parts: Parts) -> None:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        missing = running.post("/api/submissions/test", content=body_of(envelope(form="missing")), headers=JSON)
        parts.sandbox.error = ProgramUnavailableError("down")
        down = running.post("/api/submissions/test", content=body_of(), headers=JSON)
    assert (missing.status_code, code(missing)) == (404, "form.notFound")
    assert (down.status_code, code(down)) == (503, "server.unavailable")
    assert "retry-after" not in down.headers


@pytest.mark.parametrize("problem", [False, True])
def test_the_authoring_answers_follow_the_problem_details_mode(problem: bool) -> None:
    parts = Parts()
    parts.throttle.deny = 4
    datum, _ = make_datum(config(web={"api": {"problem_details": problem}}), parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        reply = running.post("/api/submissions/test", content=body_of(), headers=JSON)
    expected = "application/problem+json" if problem else "application/json"
    assert reply.status_code == 429
    assert reply.headers["content-type"].split(";")[0] == expected
    assert (reply.json()["code"] if problem else code(reply)) == "flood"


# -- inspect -----------------------------------------------------------------------------------------------------------
def test_inspect_answers_the_kernels_answer_as_it_is(client: TestClient, parts: Parts) -> None:
    reply = client.post("/api/inspect", content=INSPECT_BODY, headers=JSON)
    assert reply.status_code == 200
    assert reply.json() == {"ok": True, "op": "abi"}
    assert parts.sandbox.inspections == ["abi"]


def test_inspect_counts_as_a_test_throttle_kind(client: TestClient, parts: Parts) -> None:
    client.post("/api/inspect", content=INSPECT_BODY, headers=JSON)
    assert [key.kind for key in parts.throttle.keys] == [ThrottleKind.TEST]


def test_inspect_is_throttled_before_the_sandbox_is_asked(parts: Parts) -> None:
    parts.throttle.deny = 8
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        reply = running.post("/api/inspect", content=INSPECT_BODY, headers=JSON)
    assert (reply.status_code, code(reply), reply.headers["retry-after"]) == (429, "flood", "8")
    assert parts.sandbox.inspections == []


def test_inspect_has_the_same_admission_order() -> None:
    parts = Parts()
    datum, _ = make_datum(config(web={"api": {"max_body_size": "4KiB"}}), parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        assert running.post("/api/inspect", content=b"{}", headers={"Content-Type": "text/plain"}).status_code == 415
        assert running.post("/api/inspect", content=b"{" + b"x" * 9000, headers=JSON).status_code == 413
        assert running.post("/api/inspect", content=b"{", headers=JSON).status_code == 400
    assert TRACE == []


# -- the group documents -----------------------------------------------------------------------------------------------
def test_each_factory_has_its_own_group_document_with_only_its_own_routes() -> None:
    cfg = config(web={"openapi": {"group_documents": True}})
    datum, _ = make_datum(cfg)
    with TestClient(build_app(datum, authoring=[])) as running:
        public = running.get("/api/openapi/submissions.json")
        private = running.get("/api/openapi/authoring.json")
    assert (public.status_code, private.status_code) == (200, 200)
    assert set(public.json()["paths"]) == {"/api/submissions", "/api/submissions/validate"}
    assert set(private.json()["paths"]) == {"/api/submissions/test", "/api/inspect"}


def test_every_route_of_both_factories_carries_the_shared_tag() -> None:
    datum, _ = make_datum()
    for router in (routers.submissions(datum), routers.authoring(datum, dependencies=[])):
        assert operations_of(router)
        for route in operations_of(router).values():
            assert route.tags == ["datum-submissions"]


@pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])
@pytest.mark.parametrize("content", [b"[]", b'{"definition":{}}', b'{"op":3}'])
def test_an_inspect_body_that_is_not_an_object_with_an_op_is_400_bad_document_and_costs_nothing(
    content: bytes, problem: bool
) -> None:
    parts = Parts()
    datum, _ = make_datum(config(web={"api": {"problem_details": problem}}), parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        reply = running.post("/api/inspect", content=content, headers=JSON)
    document = reply.json()
    assert reply.status_code == 400
    assert (document["code"] if problem else document["errors"][0]["code"]) == "bad_document"
    assert parts.throttle.keys == []
    assert parts.sandbox.inspections == []
    assert TRACE == []
