"""`routers.submissions`: `submitSubmission` and `validateSubmission` against the catalog rows.

The wire order is contract: 415 > address limit > body cap > strict parse > per-form throttle > pre-check > sandbox.
Each step has a test whose trace would differ if it swapped places with its neighbour; the address limit's own tests
are test_routes_address_limit.py (the recording throttle here keeps no address limit, so it sees per-form keys only).
"""

import hashlib
import json
import logging
from collections.abc import Iterator
from typing import Any

import pytest
from asgi_driver import body_of as sent_body
from asgi_driver import call, status_of
from catalog_support import endpoint, full_path
from datum_fakes import refusing
from fastapi import Depends
from fastapi.testclient import TestClient
from submissions_fakes import (
    FORM,
    Parts,
    body_of,
    build_app,
    check_body_of,
    config,
    envelope,
    make_datum,
    operations_of,
    paths_of,
    pre_check_that_records,
)
from trace_log import TRACE

from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.http import HttpAnswer
from datum_core.submissions import Allow, PreCheckStatuses, Reject
from datum_fastapi import routers
from datum_sandbox.protocol import (
    DefinitionTooDeepError,
    ProgramUnavailableError,
    SandboxError,
    SandboxFailure,
    SandboxResult,
    StrayBoundError,
)
from datum_sandbox.wasi import EngineBusyError

JSON = {"Content-Type": "application/json"}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture
def parts() -> Parts:
    return Parts()


@pytest.fixture
def client(parts: Parts) -> Iterator[TestClient]:
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        yield running


def code(reply: Any) -> str:
    return str(reply.json()["errors"][0]["code"])


# -- the catalog rows --------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("operation_id", ["submitSubmission", "validateSubmission"])
def test_each_route_is_the_catalog_row_by_method_path_tag_and_operation_id(operation_id: str) -> None:
    datum, _ = make_datum()
    routes = operations_of(routers.submissions(datum))
    row = endpoint(operation_id)
    route = routes[operation_id]
    assert route.path == full_path(row)
    assert route.methods == {row["method"]}
    assert route.tags == [row["tag"]]


@pytest.mark.parametrize(
    ("switches", "expected"),
    [
        ({"submissions": True, "validate": False}, {"submitSubmission"}),
        ({"submissions": False, "validate": True}, {"validateSubmission"}),
        ({"submissions": True, "validate": True}, {"submitSubmission", "validateSubmission"}),
        ({"submissions": False, "validate": False}, set()),
    ],
)
def test_each_switch_adds_exactly_its_route_and_the_other_two_endpoints_add_none_here(
    switches: dict[str, bool], expected: set[str]
) -> None:
    cfg = config(web={"api": {"endpoints": {**switches, "test": True, "inspect": True}}})
    datum, _ = make_datum(cfg)
    found = set(operations_of(routers.submissions(datum)))
    assert found == expected


def test_a_route_whose_switch_is_off_answers_the_applications_404() -> None:
    cfg = config(web={"api": {"endpoints": {"submissions": False}}})
    datum, _ = make_datum(cfg)
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert reply.status_code == 404
    assert reply.json() == {"detail": "Not Found"}


def test_the_factory_takes_the_datum_first_and_prefix_and_dependencies_by_keyword() -> None:
    datum, _ = make_datum()
    factory: Any = routers.submissions
    with pytest.raises(TypeError):
        factory(datum, "/api")
    moved = paths_of(routers.submissions(datum, prefix="/v2/api"))
    assert {"/v2/api/submissions", "/v2/api/submissions/validate"} <= moved


def test_the_router_carries_the_started_guard_and_answers_503_until_a_lifespan_entered_datum() -> None:
    datum, parts = make_datum()
    app = build_app(datum)
    reply = TestClient(app).post("/api/submissions", content=body_of(), headers=JSON)  # no `with`: no lifespan
    assert (reply.status_code, code(reply)) == (503, "server.unavailable")
    assert "retry-after" not in reply.headers
    assert parts.handler.calls == []


# -- the answers (SUB-01 to SUB-06 in process) -------------------------------------------------------------------------
def test_a_valid_document_is_200_with_status_accepted_a_64_hex_digest_and_an_id(client: TestClient) -> None:
    reply = client.post("/api/submissions", content=body_of(), headers=JSON)
    assert reply.status_code == 200
    assert reply.headers["content-type"].split(";")[0].endswith("json")
    document = reply.json()
    assert document["status"] == "accepted"
    assert document["handled"] is False
    assert len(document["digest"]) == 64
    assert document["id"]


def test_a_delivery_without_its_submission_key_is_400_and_reaches_no_handler(client: TestClient, parts: Parts) -> None:
    keyless = json.dumps({"document": envelope()}).encode()
    not_a_key = json.dumps({"document": envelope(), "submissionKey": "has space"}).encode()
    for raw in (body_of(wrapped=False), keyless, not_a_key):
        reply = client.post("/api/submissions", content=raw, headers=JSON)
        assert (reply.status_code, code(reply)) == (400, "bad_document")
    assert parts.handler.calls == []


def test_two_attempts_with_the_same_answers_are_two_records(client: TestClient, parts: Parts) -> None:
    first = client.post("/api/submissions", content=body_of(), headers=JSON).json()
    other = client.post("/api/submissions", content=body_of(), headers=JSON).json()
    assert (first["handled"], other["handled"]) == (False, False)
    assert first["id"] != other["id"]
    assert len(parts.handler.calls) == 2


def test_a_known_key_with_another_document_is_409_and_never_the_first_receipt(client: TestClient, parts: Parts) -> None:
    first = client.post("/api/submissions", content=body_of(key="attempt-1"), headers=JSON).json()
    other = envelope(values={"name": "Grace Hopper"})
    reply = client.post("/api/submissions", content=body_of(other, key="attempt-1"), headers=JSON)
    assert (reply.status_code, code(reply)) == (409, "submission.keyConflict")
    assert first["id"] not in reply.text
    assert len(parts.handler.calls) == 1


def test_the_same_attempt_twice_is_one_record_and_the_second_answer_is_handled(
    client: TestClient, parts: Parts
) -> None:
    first = client.post("/api/submissions", content=body_of(key="attempt-1"), headers=JSON).json()
    again = client.post("/api/submissions", content=body_of(key="attempt-1"), headers=JSON).json()
    assert (first["handled"], again["handled"]) == (False, True)
    assert (again["id"], again["reference"], again["digest"]) == (first["id"], first["reference"], first["digest"])
    assert len(parts.handler.calls) == 1


def test_a_refused_document_is_422_with_the_kernels_errors(client: TestClient, parts: Parts) -> None:
    parts.sandbox.verdict = SandboxResult(
        {"errors": [{"code": "required", "componentId": "name", "path": "name", "severity": "error"}], "values": {}},
        0.0,
    )
    reply = client.post("/api/submissions", content=body_of(envelope(values={"name": ""})), headers=JSON)
    assert reply.status_code == 422
    assert [(e["field"], e["code"]) for e in reply.json()["errors"]] == [("name", "required")]
    assert parts.handler.calls == []


def test_a_stale_version_is_409_form_outdated_with_no_hash(client: TestClient) -> None:
    reply = client.post("/api/submissions", content=body_of(envelope(version="0")), headers=JSON)
    assert (reply.status_code, code(reply)) == (409, "form.outdated")
    assert "etag" not in reply.headers
    assert not any(len(token) == 64 for token in reply.text.replace('"', " ").split())


def test_an_unknown_form_is_404_and_the_key_is_not_echoed(client: TestClient) -> None:
    reply = client.post("/api/submissions", content=body_of(envelope(form="datum-tck-no-such-form")), headers=JSON)
    assert (reply.status_code, code(reply)) == (404, "form.notFound")
    assert "datum-tck-no-such-form" not in reply.text


def test_a_body_cut_off_is_400_bad_document(client: TestClient) -> None:
    reply = client.post("/api/submissions", content=b'{"document":', headers=JSON)
    assert (reply.status_code, code(reply)) == (400, "bad_document")


@pytest.mark.parametrize(
    "raw",
    [b"[1, 2]", b'"text"', b"null", b"{}", b'{"document": []}', b'{"a": NaN}', b'{"a": 1e999}', b"\xff\xfe"],
    ids=["array", "string", "null", "empty object", "document not an object", "NaN", "overflow", "not utf-8"],
)
def test_a_body_that_is_not_a_document_is_400_and_never_a_500(client: TestClient, raw: bytes) -> None:
    reply = client.post("/api/submissions", content=raw, headers=JSON)
    assert reply.status_code == 400
    assert code(reply) == "bad_document"


def test_validate_is_200_with_accepted_and_the_errors_and_no_notes_member_when_there_are_none(
    client: TestClient, parts: Parts
) -> None:
    reply = client.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
    assert reply.status_code == 200
    assert reply.json() == {"accepted": True, "errors": []}  # `notes` is absent, never an empty list
    assert parts.handler.calls == []


def test_validate_with_a_refused_document_is_200_accepted_false(client: TestClient, parts: Parts) -> None:
    parts.sandbox.verdict = SandboxResult(
        {"errors": [{"code": "required", "componentId": "name", "path": "name", "severity": "error"}], "values": {}},
        0.0,
    )
    reply = client.post("/api/submissions/validate", content=check_body_of(envelope(values={"name": ""})), headers=JSON)
    assert reply.status_code == 200
    assert reply.json() == {"accepted": False, "errors": [{"field": "name", "code": "required"}]}


def test_validate_with_only_warnings_is_accepted_and_lists_them_under_notes_never_under_errors(
    client: TestClient, parts: Parts
) -> None:
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [
                {"code": "soft", "componentId": "name", "severity": "warning"},
                {"code": "heads_up", "severity": "info"},
            ],
            "values": {},
        },
        0.0,
    )
    reply = client.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
    assert reply.status_code == 200
    assert reply.json() == {
        "accepted": True,
        "errors": [],
        "notes": [
            {"field": "name", "code": "soft", "severity": "warning"},
            {"code": "heads_up", "severity": "info"},  # `field` is omitted when there is none
        ],
    }


def test_validate_with_a_blocking_error_and_a_warning_keeps_each_in_its_own_list(
    client: TestClient, parts: Parts
) -> None:
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [
                {"code": "required", "componentId": "name", "severity": "error"},
                {"code": "soft", "componentId": "name", "severity": "warning"},
            ],
            "values": {},
        },
        0.0,
    )
    reply = client.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
    assert reply.json() == {
        "accepted": False,
        "errors": [{"field": "name", "code": "required"}],
        "notes": [{"field": "name", "code": "soft", "severity": "warning"}],
    }


def test_a_note_carries_the_message_the_sandbox_gave_and_none_when_it_gave_none(
    client: TestClient, parts: Parts
) -> None:
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [
                {"code": "soft", "componentId": "name", "severity": "warning", "message": "Check the spelling"},
                {"code": "heads_up", "severity": "info", "message": ""},
                {"code": "odd", "severity": "info", "message": 7},
            ],
            "values": {},
        },
        0.0,
    )
    reply = client.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
    assert reply.json()["notes"] == [
        {"field": "name", "code": "soft", "severity": "warning", "message": "Check the spelling"},
        {"code": "heads_up", "severity": "info"},  # an empty message is no message
        {"code": "odd", "severity": "info"},  # a message that is not text is none
    ]


def test_an_error_carries_the_message_the_sandbox_gave_on_submit_validate_and_test() -> None:
    parts = Parts()
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [
                {"code": "required", "componentId": "name", "severity": "error", "message": "Enter your name"},
                {"code": "pattern", "componentId": "mail", "severity": "error", "message": ""},
                {"code": "odd", "severity": "error", "message": 7},
            ],
            "values": {},
        },
        0.0,
    )
    expected = [
        {"field": "name", "code": "required", "message": "Enter your name"},
        {"field": "mail", "code": "pattern"},  # an empty message is no message
        {"code": "odd"},  # a message that is not text is none
    ]
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        submitted = running.post("/api/submissions", content=body_of(), headers=JSON)
        checked = running.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
        tried = running.post("/api/submissions/test", content=body_of(), headers=JSON)
    assert (submitted.status_code, submitted.json()["errors"]) == (422, expected)
    assert (checked.status_code, checked.json()["errors"]) == (200, expected)
    assert tried.status_code == 200
    assert [{k: v for k, v in item.items() if v is not None} for item in tried.json()["errors"]] == [
        {"field": "name", "code": "required", "message": "Enter your name", "severity": "error"},
        {"field": "mail", "code": "pattern", "severity": "error"},
        {"code": "odd", "severity": "error"},
    ]


def test_a_validators_error_carries_the_validators_own_message() -> None:
    parts = Parts()
    parts.sandbox.verdict = SandboxResult({"errors": [{"code": "soft", "severity": "warning"}], "values": {}}, 0.0)

    def validator(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem("name", "name.taken", "That name is taken"),))

    datum, _ = make_datum(parts=parts, validators=[validator])
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert reply.status_code == 422
    assert reply.json()["errors"] == [{"field": "name", "code": "name.taken", "message": "That name is taken"}]


def test_a_validators_warning_is_a_note_on_validate_with_its_message() -> None:
    def validator(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(
            warnings=(HookProblem("name", "name.short", "That name is short"), HookProblem(None, "late", ""))
        )

    datum, _ = make_datum(validators=[validator])
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
    assert reply.json() == {
        "accepted": True,
        "errors": [],
        "notes": [
            {"field": "name", "code": "name.short", "severity": "warning", "message": "That name is short"},
            {"code": "late", "severity": "warning"},
        ],
    }


def test_validate_scope_page_with_its_page_id_is_judged(client: TestClient) -> None:
    reply = client.post("/api/submissions/validate", content=check_body_of(scope="page", pageId="p1"), headers=JSON)
    assert reply.status_code in {200, 400}  # the stub form has no journey: a page it lacks is a 400, not a 5xx


@pytest.mark.parametrize(
    "raw",
    [
        pytest.param(json.dumps({"document": envelope()}).encode(), id="no scope"),
        pytest.param(json.dumps({"document": envelope(), "pageId": "p1"}).encode(), id="a page id and no scope"),
        pytest.param(json.dumps({"document": envelope(), "scope": "everything"}).encode(), id="an unknown scope"),
        pytest.param(json.dumps({"document": envelope(), "scope": ["page"]}).encode(), id="a list for the scope"),
        pytest.param(check_body_of(scope="page"), id="a page check with no page id"),
        pytest.param(check_body_of(scope="journey", pageId="p1"), id="a page id on a journey check"),
        pytest.param(json.dumps(envelope()).encode(), id="a bare envelope"),
        pytest.param(json.dumps({**envelope(), "scope": "journey"}).encode(), id="a bare envelope with a scope"),
    ],
)
def test_validate_is_400_bad_document_without_the_wrapper_and_a_scope_and_runs_nothing(
    client: TestClient, parts: Parts, raw: bytes
) -> None:
    reply = client.post("/api/submissions/validate", content=raw, headers=JSON)
    assert (reply.status_code, code(reply)) == (400, "bad_document")
    assert parts.throttle.keys == []
    assert TRACE == []


@pytest.mark.parametrize(
    ("failure", "wire"),
    [
        pytest.param(SandboxError(SandboxFailure.THREW, "program threw"), "wasm.execution_error", id="execution"),
        pytest.param(SandboxError(SandboxFailure.BUDGET, "time budget"), "wasm.execution_error", id="time limit"),
        pytest.param(SandboxError(SandboxFailure.MEMORY, "memory"), "wasm.execution_error", id="memory limit"),
        pytest.param(SandboxError(SandboxFailure.OUTCOME_TOO_LARGE, "big"), "outcome_too_large", id="outcome"),
        pytest.param(DefinitionTooDeepError(32, "deep"), "definition.tooDeep", id="the registered form too deep"),
    ],
)
@pytest.mark.parametrize("problem", [False, True])
def test_a_failed_run_is_a_503_with_the_runs_code_and_no_retry_after_on_submit_validate_and_test(
    failure: Exception, wire: str, problem: bool
) -> None:
    # A run that gave no verdict is no verdict on every judging route (never 500, never 422).
    parts = Parts()
    parts.sandbox.error = failure
    datum, _ = make_datum(config(web={"api": {"problem_details": problem}}), parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        replies = {
            "validate": running.post("/api/submissions/validate", content=check_body_of(), headers=JSON),
            "submit": running.post("/api/submissions", content=body_of(), headers=JSON),
            "test": running.post("/api/submissions/test", content=body_of(), headers=JSON),
        }
    for route, reply in replies.items():
        assert reply.status_code == 503, route
        assert "retry-after" not in reply.headers, route
        document = reply.json()
        assert (document["code"] if problem else document["errors"][0]["code"]) == wire, route
        assert "program threw" not in reply.text


@pytest.mark.parametrize(
    ("failure", "wire"),
    [
        pytest.param(EngineBusyError("slots"), "server.busy", id="busy"),
        pytest.param(ProgramUnavailableError("down"), "server.unavailable", id="unavailable"),
        pytest.param(SandboxError(SandboxFailure.BUSY, "waited"), "server.busy", id="no free slot"),
        pytest.param(SandboxError(SandboxFailure.INTERRUPTED, "closed"), "server.unavailable", id="interrupted"),
    ],
)
def test_a_busy_or_unavailable_sandbox_on_validate_is_503_and_only_busy_has_retry_after(
    failure: Exception, wire: str
) -> None:
    parts = Parts()
    parts.sandbox.error = failure
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions/validate", content=check_body_of(), headers=JSON)
    assert (reply.status_code, code(reply)) == (503, wire)
    assert ("retry-after" in reply.headers) == (wire == "server.busy")


@pytest.mark.parametrize(
    ("failure", "wire", "retry"),
    [
        pytest.param(StrayBoundError("runs that would not stop"), "server.unavailable", False, id="a full stray bound"),
        pytest.param(SandboxError(SandboxFailure.BUSY, "waited"), "server.busy", True, id="every slot taken"),
        pytest.param(SandboxError(SandboxFailure.BUDGET, "stuck"), "wasm.execution_error", False, id="the stuck run"),
    ],
)
@pytest.mark.parametrize("problem", [False, True])
def test_a_full_stray_bound_is_503_server_unavailable_with_no_retry_after_on_submit_validate_and_test(
    failure: Exception, wire: str, *, retry: bool, problem: bool
) -> None:
    # A new run while the runs that would not stop fill their bound is a runtime fault, not a queue to wait in; slot
    # saturation stays the retryable server.busy, and the stuck run's own caller is answered as a timeout is.
    parts = Parts()
    parts.sandbox.error = failure
    datum, _ = make_datum(config(web={"api": {"problem_details": problem}}), parts=parts)
    with TestClient(build_app(datum, authoring=[])) as running:
        replies = {
            "validate": running.post("/api/submissions/validate", content=check_body_of(), headers=JSON),
            "submit": running.post("/api/submissions", content=body_of(), headers=JSON),
            "test": running.post("/api/submissions/test", content=body_of(), headers=JSON),
        }
    for route, reply in replies.items():
        assert reply.status_code == 503, route
        document = reply.json()
        assert (document["code"] if problem else document["errors"][0]["code"]) == wire, route
        assert ("retry-after" in reply.headers) is retry, route


def test_a_submitted_document_nested_too_deep_is_400_not_a_server_fault(client: TestClient) -> None:
    value: Any = 1
    for _ in range(70):
        value = {"n": value}
    reply = client.post("/api/submissions/validate", content=check_body_of({**envelope(), "deep": value}), headers=JSON)
    assert (reply.status_code, code(reply)) == (400, "bad_document")


# -- admission: 415, the cap and the parse -----------------------------------------------------------------------------
def capped(limit: str = "4KiB") -> tuple[Any, Parts]:
    parts = Parts()
    datum, _ = make_datum(
        config(web={"api": {"max_body_size": limit}}), parts=parts, pre_checks=[pre_check_that_records]
    )
    return build_app(datum), parts


def test_a_wrong_content_type_is_415_unsupported_media_type_and_nothing_else_runs() -> None:
    app, parts = capped()
    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=b"{}", headers={"Content-Type": "text/plain"})
    assert (reply.status_code, code(reply)) == (415, "unsupported_media_type")
    assert TRACE == []
    assert parts.throttle.keys == []


def test_415_comes_before_the_body_cap() -> None:
    app, _ = capped()
    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=b"x" * 10_000, headers={"Content-Type": "text/plain"})
    assert reply.status_code == 415


def test_the_body_cap_comes_before_the_parse_a_huge_invalid_body_is_413_not_400() -> None:
    app, _ = capped()
    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=b"{" + b"x" * 10_000, headers=JSON)
    assert (reply.status_code, code(reply)) == (413, "bad_document")
    assert TRACE == []


def padded(total: int) -> bytes:
    head, tail = b'{"document":{"pad":"', b'"}}'
    return head + b"x" * (total - len(head) - len(tail)) + tail


def test_a_body_one_byte_over_the_cap_is_413_and_one_at_the_cap_is_read() -> None:
    app, _ = capped("1KiB")
    with TestClient(app) as running:
        assert running.post("/api/submissions", content=padded(1025), headers=JSON).status_code == 413
        assert running.post("/api/submissions", content=padded(1024), headers=JSON).status_code != 413


def test_a_chunked_body_over_the_cap_is_counted_and_refused() -> None:
    app, _ = capped()

    def chunks() -> Iterator[bytes]:
        for _ in range(10):
            yield b"x" * 1000

    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=chunks(), headers=JSON)
    assert (reply.status_code, code(reply)) == (413, "bad_document")


@pytest.mark.anyio
async def test_a_declared_content_length_over_the_cap_is_refused_before_a_byte_is_read() -> None:
    app, _ = capped()
    async with app.router.lifespan_context(app):
        sent = await call(
            app,
            path="/api/submissions",
            headers={"content-type": "application/json", "content-length": "99999"},
            events=[{"type": "http.request", "body": b"{}", "more_body": False}],
        )
    assert status_of(sent) == 413
    assert TRACE == []
    assert b"bad_document" in sent_body(sent)


def test_the_parse_comes_before_the_per_form_throttle_a_bad_body_is_400_and_costs_no_per_form_count() -> None:
    app, parts = capped()
    parts.throttle.deny = 30
    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=b'{"document":', headers=JSON)
    assert reply.status_code == 400
    assert parts.throttle.keys == []
    assert TRACE == []


def test_the_throttle_comes_before_the_pre_check() -> None:
    app, parts = capped()
    parts.throttle.deny = 30
    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert (reply.status_code, code(reply)) == (429, "flood")
    assert reply.headers["retry-after"] == "30"
    assert TRACE == ["throttle"]


def test_the_pre_check_comes_before_the_sandbox() -> None:
    parts = Parts()

    def refuse(incoming: Any) -> Any:
        TRACE.append("pre_check")
        return Reject("closed.today", "Closed")

    datum, _ = make_datum(parts=parts, pre_checks=[refuse])
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert (reply.status_code, code(reply)) == (403, "closed.today")
    assert TRACE == ["throttle", "pre_check"]


def test_a_full_pass_runs_the_throttle_then_the_pre_check_then_the_sandbox_then_the_handler() -> None:
    app, _ = capped()
    with TestClient(app) as running:
        assert running.post("/api/submissions", content=body_of(), headers=JSON).status_code == 200
    assert TRACE == ["throttle", "pre_check", "sandbox", "handler"]


def test_validate_has_the_same_admission_order() -> None:
    app, _ = capped()
    with TestClient(app) as running:
        assert (
            running.post("/api/submissions/validate", content=b"{}", headers={"Content-Type": "text/plain"}).status_code
            == 415
        )
        assert running.post("/api/submissions/validate", content=b"{" + b"x" * 9999, headers=JSON).status_code == 413
        assert running.post("/api/submissions/validate", content=b"{", headers=JSON).status_code == 400
    assert TRACE == []


# -- the throttle on the wire ------------------------------------------------------------------------------------------
def test_a_throttled_request_is_429_flood_with_retry_after_and_publishes_the_event() -> None:
    parts = Parts()
    parts.throttle.deny = 12
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert (reply.status_code, code(reply)) == (429, "flood")
    assert reply.headers["retry-after"] == "12"
    assert [type(event).__name__ for event in parts.events] == ["SubmissionThrottledEvent"]
    assert parts.sandbox.contexts == []


def test_the_real_throttle_denies_the_request_after_the_limit_with_whole_seconds_at_least_one() -> None:
    cfg = config(web={"throttle": {"limit": 2, "window": 60}})
    parts = Parts()
    datum, _ = make_datum(cfg, parts=parts, throttle=None)
    with TestClient(build_app(datum)) as running:
        answers = [
            running.post("/api/submissions", content=body_of(envelope(values={"name": f"n{n}"})), headers=JSON)
            for n in range(3)
        ]
    assert [a.status_code for a in answers] == [200, 200, 429]
    assert int(answers[2].headers["retry-after"]) >= 1
    assert answers[2].headers["retry-after"].isdigit()


# -- what the route hands the service ----------------------------------------------------------------------------------
def test_the_context_comes_from_the_request_channel_http_address_agent_key_and_the_body_digest() -> None:
    seen: list[Any] = []

    def pre_check(incoming: Any) -> Any:
        seen.append(incoming)
        return Allow()

    def principal() -> str:
        return "alice"

    parts = Parts()
    datum, _ = make_datum(parts=parts, pre_checks=[pre_check], principal=principal)
    raw = body_of()
    with TestClient(build_app(datum)) as running:
        running.post("/api/submissions", content=raw, headers={**JSON, "User-Agent": "pytest-agent/1"})
    (incoming,) = seen
    context = incoming.context
    assert context.channel == "http"
    assert context.remote_address == "testclient"
    assert context.user_agent == "pytest-agent/1"
    assert context.body_digest == hashlib.sha256(raw).hexdigest()
    assert (parts.throttle.keys[0].ip, parts.throttle.keys[0].principal) == ("testclient", "alice")


def test_a_spoofed_x_forwarded_for_never_reaches_the_throttle_key_or_the_context() -> None:
    parts = Parts()
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        running.post("/api/submissions", content=body_of(), headers={**JSON, "X-Forwarded-For": "6.6.6.6"})
    assert parts.throttle.keys[0].ip == "testclient"
    assert "6.6.6.6" not in repr(parts.throttle.keys)


# -- the application's own dependencies --------------------------------------------------------------------------------
@pytest.mark.parametrize("status", [401, 403])
def test_an_application_401_or_403_is_untouched_and_nothing_of_datum_ran(status: int) -> None:
    parts = Parts()
    datum, _ = make_datum(parts=parts)
    app = build_app(datum, submissions=[Depends(refusing(status, "guard"))])
    with TestClient(app) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert reply.status_code == status
    assert reply.json() == {"detail": "guard refused"}
    assert TRACE == ["guard"]
    assert parts.throttle.keys == []


# -- the error modes ---------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])
@pytest.mark.parametrize(
    ("name", "status", "wire"),
    [
        ("not-found", 404, "form.notFound"),
        ("outdated", 409, "form.outdated"),
        ("too-large", 413, "bad_document"),
        ("media", 415, "unsupported_media_type"),
        ("flood", 429, "flood"),
        ("busy", 503, "server.busy"),
        ("down", 503, "server.unavailable"),
        ("bad", 400, "bad_document"),
    ],
)
def test_each_refusal_answers_its_status_and_code_in_both_error_modes(
    problem: bool, name: str, status: int, wire: str
) -> None:
    parts = Parts()
    cfg = config(web={"api": {"problem_details": problem, "max_body_size": "4KiB"}})
    datum, _ = make_datum(cfg, parts=parts)
    headers, content = dict(JSON), body_of()
    if name == "not-found":
        content = body_of(envelope(form="missing"))
    elif name == "outdated":
        content = body_of(envelope(version="0"))
    elif name == "too-large":
        content = b"x" * 5000
    elif name == "media":
        headers = {"Content-Type": "text/plain"}
    elif name == "flood":
        parts.throttle.deny = 9
    elif name == "busy":
        parts.sandbox.error = EngineBusyError("slots")
    elif name == "down":
        parts.sandbox.error = ProgramUnavailableError("down")
    elif name == "bad":
        content = b"{"
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=content, headers=headers)
    assert reply.status_code == status
    expected = "application/problem+json" if problem else "application/json"
    assert reply.headers["content-type"].split(";")[0] == expected
    document = reply.json()
    if problem:
        assert (document["status"], document["code"]) == (status, wire)
        assert document["type"] == "about:blank"
    else:
        assert document["errors"][0]["code"] == wire
    assert ("retry-after" in reply.headers) == (status == 429 or wire == "server.busy")


def test_a_busy_503_carries_the_configured_busy_retry_after() -> None:
    parts = Parts()
    parts.sandbox.error = EngineBusyError("slots")
    datum, _ = make_datum(config(web={"api": {"busy_retry_after": 11}}), parts=parts)
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert (reply.status_code, code(reply), reply.headers["retry-after"]) == (503, "server.busy", "11")


@pytest.mark.parametrize("problem", [False, True])
def test_an_unexpected_failure_is_500_internal_with_no_text_and_the_correlation_id_logged(
    problem: bool, caplog: pytest.LogCaptureFixture
) -> None:
    parts = Parts()
    parts.handler.fail = RuntimeError("password=ZZSECRETZZ")
    datum, _ = make_datum(config(web={"api": {"problem_details": problem}}), parts=parts)
    with caplog.at_level(logging.ERROR), TestClient(build_app(datum), raise_server_exceptions=False) as running:
        reply = running.post("/api/submissions", content=body_of(), headers={**JSON, "X-Request-ID": "req-500"})
    assert reply.status_code == 500
    assert "ZZSECRETZZ" not in reply.text
    document = reply.json()
    if problem:
        assert (document["code"], document["correlationId"]) == ("internal", "req-500")
    else:
        assert document == {"errors": [{"code": "internal"}]}
    logged = [r for r in caplog.records if r.name == "datum.web" and "req-500" in r.getMessage()]
    assert len(logged) == 1
    assert logged[0].exc_info is not None


@pytest.mark.parametrize(
    ("factory", "status"),
    [
        (HookRefusedError.forbidden, 403),
        (HookRefusedError.conflict, 409),
        (HookRefusedError.invalid, 422),
    ],
)
def test_a_hook_refusal_is_answered_by_its_kind_with_the_hooks_own_codes(factory: Any, status: int) -> None:
    def refuse(incoming: Any) -> Any:
        raise factory("tenant.closed", "The tenant is closed")

    datum, _ = make_datum(pre_checks=[refuse])
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert reply.status_code == status
    assert reply.json()["errors"][0]["code"] == "tenant.closed"


def test_error_translators_are_asked_in_list_order_before_the_datum_mapping() -> None:
    order: list[str] = []

    def first(error: Exception) -> HttpAnswer | None:
        order.append("first")
        return None

    def second(error: Exception) -> HttpAnswer | None:
        order.append("second")
        return HttpAnswer(418, {"Content-Type": "application/json"}, b'{"errors":[{"code":"teapot"}]}')

    parts = Parts()
    parts.handler.fail = KeyError("anything")
    datum, _ = make_datum(parts=parts, error_translators=[first, second])
    with TestClient(build_app(datum)) as running:
        reply = running.post("/api/submissions", content=body_of(), headers=JSON)
    assert (reply.status_code, code(reply)) == (418, "teapot")
    assert order == ["first", "second"]


def test_the_default_pre_check_statuses_answer_403_by_suffix_422_and_503_and_a_mapping_can_say_429() -> None:
    def run(statuses: Any, reject_code: str) -> Any:
        datum, _ = make_datum(pre_checks=[lambda incoming: Reject(reject_code, "words")], pre_check_statuses=statuses)
        with TestClient(build_app(datum)) as running:
            return running.post("/api/submissions", content=body_of(), headers=JSON)

    assert run(PreCheckStatuses.standard(), "field.invalid").status_code == 403
    assert run(PreCheckStatuses.by_suffix(), "field.invalid").status_code == 422
    unavailable = run(PreCheckStatuses.by_suffix(), "backend.unavailable")
    assert (unavailable.status_code, "retry-after" in unavailable.headers) == (503, False)
    slow = run(lambda reject: 429, "slow.down")
    assert (slow.status_code, code(slow), "retry-after" in slow.headers) == (429, "slow.down", False)
    assert run(lambda reject: 200, "odd").status_code == 500


def test_the_form_is_the_one_the_document_names_and_the_sandbox_gets_the_values_as_sent() -> None:
    parts = Parts()
    datum, _ = make_datum(parts=parts)
    with TestClient(build_app(datum)) as running:
        running.post("/api/submissions", content=body_of(envelope(values={"name": "Grace"})), headers=JSON)
    (context,) = parts.sandbox.contexts
    assert context["values"] == {"name": "Grace"}
    assert context["formId"] == FORM
