"""How DatumRoute maps what a route raises, and the body reader behind it.

The forms routes carry the common cases (test_routes_errors.py, test_routes_forms.py); these routes are the test's own,
so each mapping is reached on its own, in both error formats.
"""

import logging
from collections.abc import AsyncIterator, Iterator
from typing import Annotated, Any

import pytest
from asgi_driver import body_of, call, status_of
from datum_fakes import StubRepository, StubRuntime, StubSandbox, config, definition, runtime_of, sandbox_of
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.testclient import TestClient
from starlette.responses import FileResponse, Response, StreamingResponse

from datum_core import DatumConfig
from datum_core.events import DatumRuntimeReadyEvent, SandboxRunInterruptedEvent, listener
from datum_core.forms import DefinitionDraft
from datum_core.http import HttpAnswer, resolve_correlation_id
from datum_fastapi import AnswerError, Datum, bounded_body, read_bounded_body, routers
from datum_fastapi.routing import route_class_for
from datum_sandbox.protocol import ProgramUnavailableError
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

PROBLEM = config(web={"api": {"problem_details": True}})
PATH = "/api/forms/contact/definition"


def make_datum(cfg: DatumConfig | None = None, **seams: Any) -> Datum:
    return Datum(
        config=cfg or config(),
        runtime=runtime_of(StubRuntime()),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition("contact")),
        **seams,
    )


def own_app(datum: Datum, *routes: Any) -> FastAPI:
    """An application with a router of the test's own whose routes use Datum's route class and guard."""
    router = APIRouter(route_class=route_class_for(datum), lifespan=datum.lifespan)
    for add in routes:
        add(router)
    app = FastAPI()
    app.include_router(router)
    return app


def raising(error: BaseException, *, path: str = "/boom") -> Any:
    def add(router: APIRouter) -> None:
        @router.get(path)
        async def boom() -> Response:
            raise error

    return add


class Refusing:
    """A customizer that raises what it is given."""

    def __init__(self, error: Exception) -> None:
        self.error = error

    def __call__(self, draft: DefinitionDraft) -> None:
        raise self.error

    def cache_key(self, request: Any) -> str | None:
        return None


# ---- busy and unavailable, in both formats -------------------------------------------------------
@pytest.mark.parametrize("cfg", [config(), PROBLEM], ids=["errors", "problem"])
def test_a_busy_engine_is_503_server_busy_with_retry_after(cfg: DatumConfig) -> None:
    datum = make_datum(cfg, definition_customizers=[Refusing(EngineBusyError("slots"))])
    with TestClient(own_app(datum, raising(EngineBusyError("slots")))) as client:
        reply = client.get("/boom")
    assert reply.status_code == 503
    assert reply.headers["retry-after"] == "5"
    assert reply.json()["errors"][0]["code"] == "server.busy"
    assert reply.headers["content-type"] == (
        "application/problem+json" if cfg.web.api.problem_details else "application/json"
    )


@pytest.mark.parametrize("cfg", [config(), PROBLEM], ids=["errors", "problem"])
def test_the_busy_answer_through_the_forms_route_follows_the_error_format(cfg: DatumConfig) -> None:
    datum = make_datum(cfg, definition_customizers=[Refusing(EngineBusyError("slots"))])
    app = FastAPI()
    app.include_router(routers.forms(datum))
    with TestClient(app) as client:
        reply = client.get(PATH)
    assert reply.status_code == 503
    assert reply.headers["retry-after"] == "5"
    assert reply.json()["errors"][0]["code"] == "server.busy"
    problem = cfg.web.api.problem_details
    assert reply.headers["content-type"] == ("application/problem+json" if problem else "application/json")
    if problem:
        assert (reply.json()["status"], reply.json()["code"]) == (503, "server.busy")


@pytest.mark.parametrize("cfg", [config(), PROBLEM], ids=["errors", "problem"])
def test_a_closed_engine_is_503_server_unavailable_with_no_retry_after(cfg: DatumConfig) -> None:
    datum = make_datum(cfg)
    with TestClient(own_app(datum, raising(EngineClosedError("closed")))) as client:
        reply = client.get("/boom")
    assert (reply.status_code, reply.headers.get("retry-after")) == (503, None)
    assert reply.json()["errors"][0]["code"] == "server.unavailable"
    assert reply.headers["content-type"].startswith(
        "application/problem+json" if cfg.web.api.problem_details else "application/json"
    )


@pytest.mark.parametrize("cfg", [config(), PROBLEM], ids=["errors", "problem"])
def test_a_program_that_is_unavailable_is_503_with_no_retry_after_in_both_formats(cfg: DatumConfig) -> None:
    datum = make_datum(cfg)
    with TestClient(own_app(datum, raising(ProgramUnavailableError("down")))) as client:
        reply = client.get("/boom")
    assert (reply.status_code, reply.headers.get("retry-after")) == (503, None)
    assert reply.json()["errors"][0]["code"] == "server.unavailable"
    assert reply.headers["content-type"].startswith(
        "application/problem+json" if cfg.web.api.problem_details else "application/json"
    )


def test_the_retry_after_follows_the_busy_retry_after_setting() -> None:
    datum = make_datum(config(web={"api": {"busy_retry_after": 17}}))
    with TestClient(own_app(datum, raising(EngineBusyError("slots")))) as client:
        assert client.get("/boom").headers["retry-after"] == "17"


# ---- the mapping's order and its edges -----------------------------------------------------------
@pytest.mark.parametrize("cfg", [config(), PROBLEM], ids=["errors", "problem"])
def test_a_bad_query_parameter_is_400_bad_request_naming_the_parameter_and_never_its_value(cfg: DatumConfig) -> None:
    def add(router: APIRouter) -> None:
        @router.get("/typed")
        async def typed(count: int) -> Response:
            return Response()

    with TestClient(own_app(make_datum(cfg), add)) as client:
        reply = client.get("/typed", params={"count": "hunter2"})
    assert reply.status_code == 400
    item = reply.json()["errors"][0]
    assert (item["code"], item["field"]) == ("bad_request", "count")
    assert "hunter2" not in reply.text


def test_an_http_exception_the_route_itself_raises_passes_through_untouched() -> None:
    with TestClient(own_app(make_datum(), raising(HTTPException(418, "short and stout")))) as client:
        reply = client.get("/boom")
    assert (reply.status_code, reply.json()) == (418, {"detail": "short and stout"})


def test_a_translator_that_raises_is_logged_and_the_next_one_is_asked(caplog: pytest.LogCaptureFixture) -> None:
    def broken(error: Exception) -> HttpAnswer | None:
        raise ValueError("the translator itself failed")

    def answers(error: Exception) -> HttpAnswer | None:
        return HttpAnswer(status=409, headers={"Content-Type": "application/json"}, body=b'{"errors":[]}')

    datum = make_datum(error_translators=[broken, answers])
    with caplog.at_level(logging.ERROR), TestClient(own_app(datum, raising(RuntimeError("x")))) as client:
        assert client.get("/boom").status_code == 409
    assert any("translator" in r.getMessage() for r in caplog.records)


def test_the_correlation_id_is_resolved_once_per_request(monkeypatch: pytest.MonkeyPatch) -> None:
    calls: list[object] = []

    def counted(*args: Any, **kwargs: Any) -> str:
        calls.append(args)
        return resolve_correlation_id(*args, **kwargs)

    monkeypatch.setattr("datum_fastapi.routing.resolve_correlation_id", counted)
    with TestClient(own_app(make_datum(PROBLEM), raising(RuntimeError("x"))), raise_server_exceptions=False) as client:
        assert client.get("/boom").status_code == 500
    assert len(calls) == 1


def test_a_route_that_is_not_bound_to_a_datum_maps_with_the_defaults() -> None:
    from datum_fastapi import DatumRoute  # noqa: PLC0415 - the unbound class, used directly

    router = APIRouter(route_class=DatumRoute)

    @router.get("/boom")
    async def boom() -> Response:
        raise RuntimeError("x")

    app = FastAPI()
    app.include_router(router)
    with TestClient(app, raise_server_exceptions=False) as client:
        reply = client.get("/boom")
    assert (reply.status_code, reply.json()["errors"][0]["code"]) == (500, "internal")


# ---- a failure after the status is sent ----------------------------------------------------------
@pytest.mark.anyio
async def test_a_failure_after_the_response_started_is_not_turned_into_an_answer(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def add(router: APIRouter) -> None:
        @router.get("/stream")
        async def stream() -> Response:
            async def chunks() -> AsyncIterator[bytes]:
                yield b"first"
                raise RuntimeError("the file went away")

            return StreamingResponse(chunks())

    sent: list[dict[str, Any]] = []
    with caplog.at_level(logging.ERROR), pytest.raises(RuntimeError, match="went away"):
        await call(own_app(make_datum(), add), method="GET", path="/stream", sent=sent)
    assert [m["type"] for m in sent] == ["http.response.start", "http.response.body"]
    logged = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert len(logged) == 1
    assert getattr(logged[0], "datum_correlation_id", None)
    assert logged[0].exc_info is not None
    assert isinstance(logged[0].exc_info[1], RuntimeError)
    assert status_of(sent) == 200  # no second status was written over it: the server closes the connection


@pytest.mark.parametrize("problem", [False, True])
def test_a_failure_while_writing_the_response_before_its_status_is_mapped_to_500_internal(
    problem: bool, caplog: pytest.LogCaptureFixture, tmp_path: Any
) -> None:
    def add(router: APIRouter) -> None:
        @router.get("/gone")
        async def gone() -> Response:
            return FileResponse(tmp_path / "missing.bin")

    cfg = config(web={"api": {"problem_details": problem}})
    with (
        caplog.at_level(logging.ERROR),
        TestClient(own_app(make_datum(cfg), add), raise_server_exceptions=False) as client,
    ):
        reply = client.get("/gone")
    assert reply.status_code == 500
    assert "text/plain" not in reply.headers["content-type"]
    if problem:
        body = reply.json()
        assert body["code"] == "internal"
        logged = [r for r in caplog.records if getattr(r, "datum_correlation_id", None) == body["correlationId"]]
        assert len(logged) == 1
    else:
        assert reply.json()["errors"][0]["code"] == "internal"
        assert [r for r in caplog.records if getattr(r, "datum_correlation_id", None)]


# ---- the body reader -----------------------------------------------------------------------------
def body_app(datum: Datum, *, cap: int = 100) -> FastAPI:
    def add(router: APIRouter) -> None:
        @router.post("/body")
        async def body(data: Annotated[bytes, Depends(bounded_body(max_bytes=cap, problem_details=False))]) -> Response:
            return Response(str(len(data)))

    return own_app(datum, add)


def test_a_body_at_the_cap_is_read_and_one_byte_over_is_413_bad_document() -> None:
    with TestClient(body_app(make_datum())) as client:
        ok = client.post("/body", content=b"x" * 100, headers={"Content-Type": "application/json"})
        over = client.post("/body", content=b"x" * 101, headers={"Content-Type": "application/json"})
    assert (ok.status_code, ok.text) == (200, "100")
    assert over.status_code == 413
    assert over.json()["errors"][0]["code"] == "bad_document"


def test_a_chunked_body_cannot_pass_the_cap() -> None:
    def chunks() -> Iterator[bytes]:
        for _ in range(20):
            yield b"x" * 10

    with TestClient(body_app(make_datum())) as client:
        reply = client.post("/body", content=chunks(), headers={"Content-Type": "application/json"})
    assert reply.status_code == 413


def test_a_media_type_outside_json_is_415_before_any_byte_is_read() -> None:
    with TestClient(body_app(make_datum())) as client:
        reply = client.post("/body", content=b"x" * 5000, headers={"Content-Type": "text/plain"})
    assert reply.status_code == 415  # also over the cap: 415 comes first
    assert reply.json()["errors"][0]["code"] == "unsupported_media_type"


@pytest.mark.anyio
async def test_a_content_length_over_the_cap_is_413_without_touching_the_body() -> None:
    app = body_app(make_datum())

    sent = await call(
        app,
        path="/body",
        headers={"Content-Type": "application/json", "Content-Length": "5000"},
        events=[],
    )
    assert status_of(sent) == 413
    assert b"bad_document" in body_of(sent)


@pytest.mark.anyio
async def test_a_content_length_that_is_not_a_number_is_400_bad_document() -> None:
    sent = await call(
        body_app(make_datum()),
        path="/body",
        headers={"Content-Type": "application/json", "Content-Length": "12abc"},
    )
    assert status_of(sent) == 400
    assert b"bad_document" in body_of(sent)


def test_the_refusals_follow_the_problem_details_setting() -> None:
    def add(router: APIRouter) -> None:
        @router.post("/body")
        async def body(data: Annotated[bytes, Depends(bounded_body(max_bytes=10, problem_details=True))]) -> Response:
            return Response(str(len(data)))

    with TestClient(own_app(make_datum(PROBLEM), add)) as client:
        reply = client.post("/body", content=b"x" * 11, headers={"Content-Type": "application/json"})
    assert reply.status_code == 413
    assert reply.headers["content-type"] == "application/problem+json"


def test_the_body_dependency_is_overridable_through_dependency_overrides() -> None:
    datum = make_datum()
    dependency = bounded_body(max_bytes=10)

    def add(router: APIRouter) -> None:
        @router.post("/body")
        async def body(data: Annotated[bytes, Depends(dependency)]) -> Response:
            return Response(data)

    app = own_app(datum, add)

    async def fixed(request: Request) -> bytes:
        return b"fixed"

    app.dependency_overrides[dependency] = fixed
    with TestClient(app) as client:
        assert client.post("/body", content=b"x" * 1000).text == "fixed"


def test_the_reader_raises_an_answer_error_a_route_may_catch() -> None:
    def add(router: APIRouter) -> None:
        @router.post("/direct")
        async def direct(request: Request) -> Response:
            try:
                await read_bounded_body(request, max_bytes=1)
            except AnswerError as refusal:
                return Response(str(refusal.answer.status))
            return Response("read")

    with TestClient(own_app(make_datum(), add)) as client:
        assert client.post("/direct", content=b"xx", headers={"Content-Type": "application/json"}).text == "413"


# ---- a client that leaves mid-upload ----------------------------------------------------------------------------
@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_a_disconnect_mid_upload_releases_the_slot_and_answers_nothing(caplog: pytest.LogCaptureFixture) -> None:
    ready: list[object] = []
    interrupted: list[object] = []
    datum = make_datum(
        listeners=[
            listener(DatumRuntimeReadyEvent, ready.append),
            listener(SandboxRunInterruptedEvent, interrupted.append),
        ]
    )
    app = body_app(datum)
    async with datum:
        assert datum.runner is not None
        started = len(ready)
        with caplog.at_level(logging.DEBUG):
            sent = await call(
                app,
                path="/body",
                headers={"Content-Type": "application/json"},
                events=[
                    {"type": "http.request", "body": b"abc", "more_body": True},
                    {"type": "http.disconnect"},
                ],
            )
        assert sent == []  # no answer: nothing was started, not even a 500
        assert datum.runner.slots_in_use == 0
        assert datum.runner.in_flight == 0
        assert len(ready) == started
        assert interrupted == []
    assert [r for r in caplog.records if r.levelno >= logging.ERROR] == []
    assert not [r for r in caplog.records if "internal" in r.getMessage().lower()]


@pytest.mark.anyio
async def test_a_disconnect_mid_upload_is_never_a_500_through_the_forms_style_route() -> None:
    sent = await call(
        body_app(make_datum()),
        path="/body",
        headers={"Content-Type": "application/json"},
        events=[{"type": "http.disconnect"}],
    )
    assert status_of(sent) is None
