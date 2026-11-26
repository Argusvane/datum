"""`datum_fastapi.Datum` beyond the scenarios: W001, the guard's states, busy, native cancel, the grace, helpers."""

import asyncio
import copy
import inspect
import logging
import threading
import time
from collections.abc import Mapping
from typing import Any, cast

import anyio
import anyio.to_thread
import httpx2
import pytest
from blockbuster import blockbuster_ctx
from datum_fakes import StubRepository, config, definition, runtime_of, sandbox_of, strip_secret
from fastapi import APIRouter, FastAPI, Request
from fastapi.testclient import TestClient

from datum_core import DatumNotStartedError
from datum_fastapi import Datum, preferred_language, routers
from datum_fastapi.lifespan import COMPOSITION_ERROR
from datum_fastapi.routers import privileged
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError, SandboxError, SandboxFailure, Smoke
from datum_sandbox.wasi import EngineInfo

PATH = "/api/forms/contact/definition"
CHECKS = "datum.checks"


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class Timeline:
    """One ordered record shared by the runtime and the sandbox below."""

    def __init__(self) -> None:
        self.lines: list[str] = []
        self._lock = threading.Lock()

    def add(self, line: str) -> None:
        with self._lock:
            self.lines.append(line)


class RecordingRuntime:
    def __init__(self, timeline: Timeline, *, blocking: bool = False) -> None:
        self.timeline = timeline
        self.blocking = blocking

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        if self.blocking:
            time.sleep(0.001)  # a real blocking call: blockbuster refuses it on the event loop
        self.timeline.add("runtime closed")


class GatedSandbox:
    """A sandbox whose public copy (the work of a definition read) waits for `gate`, then records its effect."""

    def __init__(
        self,
        timeline: Timeline,
        *,
        abi_error: Exception | None = None,
        blocking: bool = False,
        copy_error: Exception | None = None,
    ) -> None:
        self.timeline = timeline
        self.abi_error = abi_error
        self.blocking = blocking
        self.copy_error = copy_error
        self.gate_abi = False
        self.gate = threading.Event()
        self.entered = threading.Event()

    def prove_abi(self) -> None:
        if self.gate_abi:
            self.entered.set()
            self.gate.wait(10)
        if self.abi_error is not None:
            raise self.abi_error

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.entered.set()
        if self.blocking:
            time.sleep(0.001)  # a real blocking call: blockbuster refuses it on the event loop
        self.gate.wait(10)
        if self.copy_error is not None:
            raise self.copy_error
        self.timeline.add("effect done")
        return cast("dict[str, JsonValue]", strip_secret(copy.deepcopy(dict(definition))))


def gated(
    *, blocking: bool = False, copy_error: Exception | None = None, **sections: Any
) -> tuple[Datum, GatedSandbox, Timeline]:
    timeline = Timeline()
    sandbox = GatedSandbox(timeline, blocking=blocking, copy_error=copy_error)
    datum = Datum(
        config=config(**sections),
        runtime=runtime_of(cast("Any", RecordingRuntime(timeline, blocking=blocking))),
        sandbox=sandbox_of(cast("Any", sandbox)),
        form_repository=StubRepository(definition("contact", secret=True)),
    )
    return datum, sandbox, timeline


def app_of(datum: Datum) -> FastAPI:
    app = FastAPI()
    app.include_router(routers.forms(datum))
    return app


def client_of(app: FastAPI) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver")


def datum_errors(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno >= logging.ERROR and r.name.split(".")[0] == "datum"]


# ---- W001 ----------------------------------------------------------------------------------------------------------
def test_a_router_whose_every_switch_is_off_is_one_w001_at_the_start(caplog: pytest.LogCaptureFixture) -> None:
    datum, _, _ = gated(definition_route=False)
    app = FastAPI()
    app.include_router(routers.forms(datum))
    app.include_router(routers.assets(datum))
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(app):
        pass
    lines = [r.getMessage() for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"]
    messages = [line for line in lines if line.startswith("(")]
    assert len(messages) == 2
    assert any("router forms" in m for m in messages)
    assert any("router assets" in m for m in messages)


def test_a_router_with_a_switch_on_raises_no_w001(caplog: pytest.LogCaptureFixture) -> None:
    datum, _, _ = gated()
    with caplog.at_level(logging.WARNING, logger=CHECKS), TestClient(app_of(datum)):
        pass
    assert [r for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.W001"] == []


# ---- the guard's states --------------------------------------------------------------------------------------------
def test_after_the_lifespan_ended_the_guard_answers_503_without_the_composition_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, sandbox, _ = gated()
    sandbox.gate.set()
    app = app_of(datum)
    with TestClient(app) as client:
        assert client.get(PATH).status_code == 200
    with caplog.at_level(logging.ERROR):
        reply = TestClient(app).get(PATH)
    assert reply.status_code == 503
    assert reply.json()["errors"][0]["code"] == "server.unavailable"
    assert datum_errors(caplog) == []


def test_a_runtime_left_down_by_fail_fast_off_answers_503_without_the_composition_error(
    caplog: pytest.LogCaptureFixture,
) -> None:
    timeline = Timeline()
    datum = Datum(
        config=config(runtime={"fail_fast": False}),
        runtime=runtime_of(cast("Any", RecordingRuntime(timeline))),
        sandbox=sandbox_of(cast("Any", GatedSandbox(timeline, abi_error=ProgramUnavailableError("abi too old")))),
        form_repository=StubRepository(definition("contact", secret=True)),
    )
    with caplog.at_level(logging.ERROR), TestClient(app_of(datum)) as client:
        reply = client.get(PATH)
        assert datum.health().components["runtime"].status == "down"
    assert (reply.status_code, reply.headers.get("retry-after")) == (503, None)
    assert all(COMPOSITION_ERROR not in r.getMessage() for r in caplog.records)
    assert len(datum_errors(caplog)) == 1  # the start's own report of the failure, not the guard's


# ---- the runner under the routes -----------------------------------------------------------------------------------
@pytest.mark.anyio
async def test_a_request_that_gets_no_worker_thread_within_the_wait_answers_503_busy() -> None:
    datum, sandbox, _ = gated(runtime={"worker_threads": 1, "validation": {"wait": 0.2}})
    async with datum, client_of(app_of(datum)) as client:
        first = asyncio.create_task(client.get(PATH))
        await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
        began = time.monotonic()
        second = await client.get(PATH)
        waited = time.monotonic() - began
        sandbox.gate.set()
        assert (await first).status_code == 200
    assert second.status_code == 503
    assert second.json()["errors"][0]["code"] == "server.busy"
    assert second.headers["retry-after"] == "5"
    assert 0.15 <= waited < 3.0


@pytest.mark.anyio
async def test_a_native_cancel_of_the_request_completes_the_effect_before_the_runtime_stops() -> None:
    datum, sandbox, timeline = gated(runtime={"shutdown_grace": 3})
    async with client_of(app_of(datum)) as client:
        async with datum:
            request = asyncio.create_task(client.get(PATH))
            await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
            request.cancel()  # what uvicorn does when --timeout-graceful-shutdown expires
            with pytest.raises(asyncio.CancelledError):
                await request
            runner = datum.runner
            assert runner is not None
            assert (runner.in_flight, runner.slots_in_use) == (1, 1)  # the call outlives its caller and keeps its slot
            asyncio.get_running_loop().call_later(0.2, sandbox.gate.set)
        assert timeline.lines == ["effect done", "runtime closed"]  # drained, then stopped


@pytest.mark.anyio
async def test_at_the_grace_the_runtime_interrupts_what_is_left_and_the_exit_returns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, sandbox, timeline = gated(runtime={"shutdown_grace": 0.3})
    async with client_of(app_of(datum)) as client:
        with caplog.at_level(logging.WARNING, logger="datum.runtime"):
            async with datum:
                request = asyncio.create_task(client.get(PATH))
                await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
                began = time.monotonic()
            took = time.monotonic() - began
        assert 0.25 <= took < 3.0  # bounded by the grace, not by the call
        assert timeline.lines == ["runtime closed"]  # interrupted at the expiry; the effect has not ended
        assert any("shutdown_grace" in r.getMessage() for r in caplog.records)
        sandbox.gate.set()
        reply = await request
    assert timeline.lines == ["runtime closed", "effect done"]
    assert reply.status_code == 200  # the call's own ending; its answer reached the caller whole


@pytest.mark.anyio
async def test_a_run_the_stop_interrupted_answers_503_server_unavailable() -> None:
    error = SandboxError(SandboxFailure.INTERRUPTED, "The sandbox runtime stopped the run while closing.")
    datum, sandbox, _ = gated(runtime={"shutdown_grace": 0.3}, copy_error=error)
    async with client_of(app_of(datum)) as client:
        async with datum:
            request = asyncio.create_task(client.get(PATH))
            await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
        sandbox.gate.set()
        reply = await request
    assert reply.status_code == 503
    assert "retry-after" not in reply.headers
    assert reply.json()["errors"][0]["code"] == "server.unavailable"


@pytest.mark.anyio
async def test_the_engines_own_slot_refusal_answers_503_server_busy() -> None:
    error = SandboxError(SandboxFailure.BUSY, "No engine slot is free.")
    datum, sandbox, _ = gated(copy_error=error)
    sandbox.gate.set()
    async with datum, client_of(app_of(datum)) as client:
        reply = await client.get(PATH)
    assert reply.status_code == 503
    assert reply.headers["retry-after"] == "5"
    assert reply.json()["errors"][0]["code"] == "server.busy"


@pytest.mark.anyio
async def test_a_request_during_the_drain_answers_503_and_never_reaches_the_sandbox() -> None:
    datum, sandbox, _ = gated(runtime={"shutdown_grace": 3})
    async with client_of(app_of(datum)) as client:
        async with datum:
            first = asyncio.create_task(client.get(PATH))
            await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
            sandbox.entered.clear()
            second_task: list[asyncio.Task[httpx2.Response]] = []

            async def later() -> None:
                await asyncio.sleep(0.2)
                second_task.append(asyncio.create_task(client.get(PATH)))

            starter = asyncio.create_task(later())
            asyncio.get_running_loop().call_later(0.6, sandbox.gate.set)
        # the block ended: the drain runs until the gate opens at 0.6 s
        await starter
        second = await second_task[0]
        assert not sandbox.entered.is_set()  # the second request never reached the sandbox
        first_reply = await first
    assert second.status_code == 503
    assert "retry-after" not in second.headers
    assert second.json()["errors"][0]["code"] == "server.unavailable"
    assert first_reply.status_code == 200


@pytest.mark.anyio
async def test_the_async_paths_make_no_blocking_call_on_the_event_loop() -> None:
    datum, sandbox, _ = gated(blocking=True)
    sandbox.gate.set()
    app = app_of(datum)
    with blockbuster_ctx():
        async with datum, client_of(app) as client:
            replies = [await client.get(PATH) for _ in range(3)]
            missing = await client.get("/api/forms/nope/definition")
    assert [r.status_code for r in replies] == [200, 200, 200]
    assert missing.status_code == 404


@pytest.mark.anyio
async def test_the_guard_makes_no_blocking_call_either_while_it_reports_the_composition_error() -> None:
    datum, _, _ = gated()
    with blockbuster_ctx():
        async with client_of(app_of(datum)) as client:
            reply = await client.get(PATH)
    assert reply.status_code == 503


@pytest.mark.anyio
async def test_a_failed_start_counts_no_entry_so_the_next_entry_starts_again() -> None:
    timeline = Timeline()
    sandbox = GatedSandbox(timeline, abi_error=ProgramUnavailableError("abi too old"))
    sandbox.gate.set()
    datum = Datum(
        config=config(),
        runtime=runtime_of(cast("Any", RecordingRuntime(timeline))),
        sandbox=sandbox_of(cast("Any", sandbox)),
        form_repository=StubRepository(definition("contact", secret=True)),
    )
    with pytest.raises(ProgramUnavailableError):
        async with datum:
            pass
    assert (datum.entries, datum.runner) == (0, None)
    assert timeline.lines == ["runtime closed"]  # the failed start undid itself
    for service in ("definition_service", "translation_service", "data_source_service"):
        with pytest.raises(DatumNotStartedError):
            getattr(datum, service)
    sandbox.abi_error = None
    async with datum, client_of(app_of(datum)) as client:
        assert datum.entries == 1
        assert (await client.get(PATH)).status_code == 200
    assert datum.entries == 0


@pytest.mark.anyio
async def test_a_native_cancel_of_the_first_entry_lets_the_start_finish_then_stops_it() -> None:
    datum, sandbox, timeline = gated()
    sandbox.gate_abi = True
    task = asyncio.create_task(datum.__aenter__())
    await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
    task.cancel()
    asyncio.get_running_loop().call_later(0.2, sandbox.gate.set)
    with pytest.raises(asyncio.CancelledError):
        await task
    assert datum.started is False
    assert timeline.lines == ["runtime closed"]
    assert datum.entries == 0
    assert datum.runner is None


@pytest.mark.anyio
async def test_a_native_cancel_of_the_last_exit_still_drains_before_the_stop() -> None:
    datum, sandbox, timeline = gated(runtime={"shutdown_grace": 3})
    async with client_of(app_of(datum)) as client:
        await datum.__aenter__()
        request = asyncio.create_task(client.get(PATH))
        await anyio.to_thread.run_sync(sandbox.entered.wait, 5)
        exit_task = asyncio.create_task(datum.__aexit__(None, None, None))
        await asyncio.sleep(0.1)
        exit_task.cancel()
        asyncio.get_running_loop().call_later(0.3, sandbox.gate.set)
        with pytest.raises(asyncio.CancelledError):
            await exit_task
        await request
    assert timeline.lines == ["effect done", "runtime closed"]
    assert datum.started is False


@pytest.mark.anyio
async def test_nested_entries_start_once_and_stop_at_the_last_exit() -> None:
    datum, sandbox, timeline = gated()
    sandbox.gate.set()
    async with datum:
        async with datum:
            assert datum.entries == 2
        assert datum.entries == 1
        assert datum.ready
        assert timeline.lines == []
    assert timeline.lines == ["runtime closed"]
    assert not datum.started


@pytest.mark.anyio
async def test_the_worker_threads_follow_the_setting_or_the_default_from_the_slots() -> None:
    datum, _, _ = gated(runtime={"worker_threads": 7})
    async with datum:
        assert datum.runner is not None
        assert datum.runner.worker_threads == 7
    datum, _, _ = gated(runtime={"validation": {"concurrency": 3}, "pdf": {"concurrency": 1}})
    async with datum:
        assert datum.runner is not None
        assert datum.runner.worker_threads == 2 * (3 + 1) + 2
    assert datum.runner is None


# ---- principal and locale ------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("header", "expected"),
    [
        ("fr-CA,fr;q=0.9,en;q=0.8", "fr-CA"),
        ("en;q=0.5, de;q=0.9", "de"),
        ("*, es;q=0.4", "es"),
        ("da, en-GB;q=0.8, en;q=0.7", "da"),
        ("en;q=0, fr;q=0.001", "fr"),
        ("en;q=1.5, fr;q=0.2", "fr"),  # a weight outside the grammar is no weight
        ("not a tag, it;q=0.3", "it"),
        ("de;q=0.5, fr;q=0.5", "de"),  # first on a tie
        ("", None),
        ("*", None),
        ("en;q=0", None),
    ],
)
def test_the_preferred_language_follows_the_weights(header: str, expected: str | None) -> None:
    assert preferred_language(header) == expected


def test_the_default_locale_dependency_falls_back_to_the_process_locale(monkeypatch: pytest.MonkeyPatch) -> None:
    import datum_fastapi.datum as module  # noqa: PLC0415 - the module whose fallback is replaced

    monkeypatch.setattr(module, "_process_language", lambda: "pt-BR")
    seen: list[str] = []
    datum, _, _ = gated()
    router = APIRouter()

    @router.get("/locale")
    def read(request: Request) -> dict[str, str]:
        seen.append(datum.locale(request))
        return {}

    app = FastAPI()
    app.include_router(router)
    client = TestClient(app)
    client.get("/locale", headers={"Accept-Language": "fr-CA;q=0.8"})
    client.get("/locale")
    assert seen == ["fr-CA", "pt-BR"]


# ---- the privileged-factory rule -----------------------------------------------------------------------------------
def test_a_privileged_factory_must_take_dependencies_as_a_required_keyword() -> None:
    def good(datum: Datum, *, prefix: str = "/api", dependencies: routers.Dependencies) -> APIRouter:
        return APIRouter()

    assert privileged(good) is good
    assert inspect.signature(good).parameters["dependencies"].default is inspect.Parameter.empty

    def defaulted(datum: Datum, *, dependencies: routers.Dependencies = ()) -> APIRouter:
        return APIRouter()

    def positional(datum: Datum, dependencies: routers.Dependencies) -> APIRouter:
        return APIRouter()

    def missing(datum: Datum, *, prefix: str = "/api") -> APIRouter:
        return APIRouter()

    for factory in (defaulted, positional, missing):
        with pytest.raises(TypeError, match="required keyword"):
            privileged(factory)
