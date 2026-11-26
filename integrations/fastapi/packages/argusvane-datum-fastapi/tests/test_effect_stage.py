"""Through `POST /api/submissions`: the effect stage survives a native cancel, the lifespan drains it, a mid-upload
disconnect costs nothing, and a busy slot is a 503 in both error modes.

The whole service call (run, validators, handler, remember, events) is ONE tracked task awaited through
`asyncio.shield`. `anyio.CancelScope(shield=True)` does not resist uvicorn's native `task.cancel()`; the tracked task
does: scopes that only shield the request (`noshield`, `shield_all`, `shield_effect`) lose the effect on a native
cancel,
while `asyncio.shield` keeps it, and a mid-upload disconnect is harmless. In-process here (the uvicorn half is the
server-marked wire wrappers and `test_lifecycle_shutdown.py`).
"""

import asyncio
import logging
import threading
from collections.abc import Callable
from typing import Any

import anyio
import httpx2
import pytest
from asgi_driver import call, status_of
from datum_fakes import StubRepository, definition
from submissions_fakes import FORM, Parts, body_of, build_app, config, envelope, make_datum

from datum_core.events import DatumEvent, SandboxRunInterruptedEvent
from datum_core.submissions import SubmissionValidatedEvent
from datum_sandbox.protocol import SandboxError, SandboxFailure
from datum_sandbox.wasi import EngineInfo

pytestmark = pytest.mark.anyio
JSON = {"Content-Type": "application/json"}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def until(condition: Callable[[], object], *, seconds: float = 10.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if condition():
            return
        await anyio.sleep(0.01)
    raise AssertionError("the condition never came true")


def client(app: Any) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver")


class Runtime:
    """A stub runtime whose `close` is a step of the shutdown order."""

    def __init__(self, order: list[str]) -> None:
        self.order = order
        self.on_close: Callable[[], None] | None = None

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        self.order.append("datum stop")
        if self.on_close is not None:
            self.on_close()


class Scenario:
    """A Datum whose effect (the handler) waits on `gate`, with one ordered list of what happened."""

    def __init__(self, **sections: Any) -> None:
        self.order: list[str] = []
        self.gate = threading.Event()
        self.parts = Parts()
        self.runtime = Runtime(self.order)

        def effect(accepted: Any) -> Any:
            self.order.append("effect start")
            self.gate.wait(30)
            self.order.append("effect done")
            return self.parts.handler(accepted)

        sections.setdefault("runtime", {"worker_threads": 4, "shutdown_grace": 5})
        self.datum, _ = make_datum(
            config(**sections),
            parts=self.parts,
            runtime=self.runtime,
            handler=effect,
            listeners=[(DatumEvent, self.on_event)],
            form_repository=StubRepository(definition(FORM)),
        )
        self.app = build_app(self.datum)

    def on_event(self, event: DatumEvent) -> None:
        self.order.append(f"event {type(event).__name__}")
        self.parts.record(event)

    def post(
        self, http: httpx2.AsyncClient, *, key: str | None = None, **values: Any
    ) -> "asyncio.Task[httpx2.Response]":
        document = envelope(values=values) if values else envelope()
        return asyncio.create_task(http.post("/api/submissions", content=body_of(document, key=key), headers=JSON))


# -- the native cancel -------------------------------------------------------------------------------------------------
async def test_a_native_task_cancel_of_the_request_still_completes_the_effect_and_its_events() -> None:
    run = Scenario()
    async with run.datum, client(run.app) as http:
        request = run.post(http)
        await until(lambda: "effect start" in run.order)
        request.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: "event SubmissionValidatedEvent" in run.order)
    assert run.order.index("effect done") < run.order.index("event SubmissionValidatedEvent")
    assert len(run.parts.handler.calls) == 1


async def test_after_the_cancelled_call_ended_a_repeat_is_a_redelivery_because_the_record_was_made() -> None:
    run = Scenario()
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        request = run.post(http, key="attempt-1")
        await until(lambda: runner.in_flight == 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: runner.in_flight == 0)
        again = await run.post(http, key="attempt-1")
    assert again.json()["handled"] is True
    assert len(run.parts.handler.calls) == 1


async def test_the_slot_stays_taken_while_the_cancelled_call_drains_and_is_free_after() -> None:
    run = Scenario(runtime={"worker_threads": 1, "shutdown_grace": 5})
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        request = run.post(http)
        await until(lambda: runner.slots_in_use == 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert runner.slots_in_use == 1  # the limiter never undercounts while the call drains
        run.gate.set()
        await until(lambda: runner.slots_in_use == 0)


# -- the lifespan exit -------------------------------------------------------------------------------------------------
async def test_the_lifespan_exit_waits_for_the_call_and_its_events_before_datum_stops() -> None:
    run = Scenario()
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.post(http)
        await until(lambda: "effect start" in run.order)
        leaving = asyncio.create_task(run.datum.__aexit__(None, None, None))
        await anyio.sleep(0.2)
        assert not leaving.done()  # draining: the call is still running
        assert "datum stop" not in run.order
        run.gate.set()
        await leaving
        reply = await request
    assert reply.status_code == 200
    order = run.order
    assert order.index("effect done") < order.index("event SubmissionValidatedEvent") < order.index("datum stop")


async def test_a_call_the_grace_abandons_ends_503_with_the_interrupt_event_and_no_validated_event() -> None:
    run = Scenario(runtime={"worker_threads": 4, "shutdown_grace": 0.2})
    release = threading.Event()
    run.parts.sandbox.gate = release
    run.runtime.on_close = release.set  # closing the runtime interrupts the run
    original = run.parts.sandbox.validate

    def validate(context: Any, rules: Any = (), *, real: bool) -> Any:
        result = original(context, rules, real=real)
        if "datum stop" in run.order:
            raise SandboxError(SandboxFailure.INTERRUPTED, "the runtime was stopped")
        return result

    run.parts.sandbox.validate = validate  # type: ignore[method-assign]
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.post(http)
        await until(run.parts.sandbox.entered.is_set)
        await run.datum.__aexit__(None, None, None)
        reply = await request
    assert reply.status_code == 503
    assert reply.json()["errors"][0]["code"] == "server.unavailable"
    assert "retry-after" not in reply.headers
    events = run.parts.events
    assert any(isinstance(e, SandboxRunInterruptedEvent) and e.reason == "interrupted" for e in events)
    assert not any(isinstance(e, SubmissionValidatedEvent) for e in events)
    assert run.parts.handler.calls == []


# -- a client that leaves ----------------------------------------------------------------------------------------------
async def test_a_disconnect_mid_upload_answers_nothing_runs_nothing_logs_no_error_and_frees_the_slot(
    caplog: pytest.LogCaptureFixture,
) -> None:
    run = Scenario(runtime={"worker_threads": 1, "shutdown_grace": 5})
    run.gate.set()
    sent: list[dict[str, Any]] = []
    async with run.datum:
        waiting = asyncio.Event()
        release = asyncio.Event()
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    path="/api/submissions",
                    headers={"content-type": "application/json", "content-length": "1000"},
                    events=[{"type": "http.request", "body": b'{"document": ', "more_body": True}],
                    sent=sent,
                    waiting=waiting,
                    release=release,
                )
            )
            await asyncio.wait_for(waiting.wait(), 10)  # the first chunk was read and the application wants more
            assert not request.done()  # the request is in flight, holding the body reader
            release.set()  # now the client leaves
            await request
        assert status_of(sent) is None  # no answer at all, never a 500
        assert run.parts.sandbox.contexts == []
        assert run.parts.handler.calls == []
        assert run.parts.events == []
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
        runner = run.datum.runner
        assert runner is not None
        assert (runner.slots_in_use, runner.in_flight) == (0, 0)
        async with client(run.app) as http:  # the only worker thread is free: the next request is served, not busy
            assert (await run.post(http)).status_code == 200


async def test_a_disconnect_after_the_body_cancels_nothing_the_run_the_effect_and_the_events_complete(
    caplog: pytest.LogCaptureFixture,
) -> None:
    run = Scenario()
    raw = body_of()
    async with run.datum:
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    path="/api/submissions",
                    headers={"content-type": "application/json", "content-length": str(len(raw))},
                    events=[{"type": "http.request", "body": raw, "more_body": False}],  # then http.disconnect
                    sent=[],
                )
            )
            await until(lambda: "effect start" in run.order)
            run.gate.set()
            await request
        await until(lambda: run.parts.events)
    assert len(run.parts.handler.calls) == 1
    assert [type(e).__name__ for e in run.parts.events] == ["SubmissionValidatedEvent"]
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


# -- busy --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])
async def test_a_second_request_while_the_only_slot_is_held_is_503_busy_in_both_error_modes(problem: bool) -> None:
    run = Scenario(
        runtime={"worker_threads": 1, "shutdown_grace": 5, "validation": {"wait": 0.1}},
        web={"api": {"problem_details": problem, "busy_retry_after": 7}},
    )
    run.gate.set()
    hold = threading.Event()
    run.parts.sandbox.gate = hold
    async with run.datum, client(run.app) as http:
        first = run.post(http)
        await until(run.parts.sandbox.entered.is_set)
        busy = await run.post(http, name="second")
        hold.set()
        done = await first
    assert done.status_code == 200
    assert busy.status_code == 503
    assert busy.headers["retry-after"] == "7"
    expected = "application/problem+json" if problem else "application/json"
    assert busy.headers["content-type"].split(";")[0] == expected
    document = busy.json()
    assert (document["code"] if problem else document["errors"][0]["code"]) == "server.busy"
    assert len(run.parts.handler.calls) == 1  # the refused request ran nothing


async def test_busy_refusals_cost_no_handler_call_and_leave_the_slot_count_right() -> None:
    run = Scenario(runtime={"worker_threads": 1, "shutdown_grace": 5, "validation": {"wait": 0.05}})
    run.gate.set()
    hold = threading.Event()
    run.parts.sandbox.gate = hold
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        first = run.post(http)
        await until(run.parts.sandbox.entered.is_set)
        for number in range(3):
            assert (await run.post(http, name=f"n{number}")).status_code == 503
        assert runner.slots_in_use == 1
        hold.set()
        await first
        await until(lambda: runner.slots_in_use == 0)
    assert len(run.parts.handler.calls) == 1
