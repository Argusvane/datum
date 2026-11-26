"""Through `POST /tsa`: the effect stage survives a native cancel, the lifespan drains it, a disconnect mid-upload
costs nothing, and a busy slot is a 503 once.

The whole token (the customizers, the time, the serial, the signature, the log row and the events) is ONE tracked task
awaited through `asyncio.shield`: a request task cancelled natively (uvicorn at `--timeout-graceful-shutdown`) leaves
the issue to finish, the slot stays taken while it drains, and `TimestampIssuedEvent` is published inside the call. A
client that leaves before the body is whole costs nothing: no answer, no serial, no key use, no event.
Mirrors `test_builder_effect_stage.py`.
"""

import asyncio
import logging
import threading
import time
from collections.abc import Callable
from typing import Any, cast

import anyio
import httpx2
import pytest
from asgi_driver import call, status_of
from datum_fakes import StubSandbox, sandbox_of
from tsa_fakes import QUERY_TYPE, Parts, build_app, config, make_datum, parse_reply, query_der

from datum_core.events import DatumEvent
from datum_core.testing.tsa_pki import TsaPki
from datum_sandbox.wasi import EngineInfo, GuestRuntime, HarnessStats

pytestmark = pytest.mark.anyio


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

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        self.order.append("datum stop")


class Scenario:
    """A Datum whose customizer (the effect's doorstep) waits on `gate`, with one ordered list of what happened."""

    def __init__(self, tsa_pki: TsaPki, **sections: Any) -> None:
        self.order: list[str] = []
        self.gate = threading.Event()
        self.parts = Parts(tsa_pki.ec)
        self.runtime = Runtime(self.order)

        def doorstep(draft: Any) -> None:
            self.order.append("effect start")
            self.gate.wait(30)
            self.order.append("effect done")

        sections.setdefault("runtime", {"worker_threads": 4, "shutdown_grace": 5})
        self.datum, _ = make_datum(
            tsa_pki.ec,
            config(**sections),
            parts=self.parts,
            runtime=self.runtime,
            timestamp_request_customizers=[doorstep],
            listeners=[(DatumEvent, self.on_event)],
        )
        self.app = build_app(self.datum)

    def on_event(self, event: DatumEvent) -> None:
        self.order.append(f"event {type(event).__name__}")
        self.parts.record(event)

    def post(self, http: httpx2.AsyncClient) -> "asyncio.Task[httpx2.Response]":
        return asyncio.create_task(http.post("/tsa", content=query_der(nonce=7), headers={"Content-Type": QUERY_TYPE}))


# -- the native cancel -------------------------------------------------------------------------------------------------
async def test_a_native_task_cancel_of_the_request_still_issues_logs_and_publishes_the_issued_event(
    tsa_pki: TsaPki,
) -> None:
    run = Scenario(tsa_pki)
    async with run.datum, client(run.app) as http:
        request = run.post(http)
        await until(lambda: "effect start" in run.order)
        request.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: "event TimestampIssuedEvent" in run.order)
    assert run.order.index("effect done") < run.order.index("event TimestampIssuedEvent")
    assert [type(e).__name__ for e in run.parts.events] == ["TimestampIssuedEvent"]
    assert len(run.parts.log.entries) == 1
    assert run.parts.serials.allocations == 1


async def test_the_next_request_gets_the_next_serial_after_a_cancelled_one_finished(tsa_pki: TsaPki) -> None:
    run = Scenario(tsa_pki)
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        request = run.post(http)
        await until(lambda: runner.in_flight == 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: runner.in_flight == 0)
        reply = await run.post(http)
    assert reply.status_code == 200
    assert [log.serial for log in run.parts.log.entries] == [1, 2]


async def test_the_slot_stays_taken_while_the_cancelled_call_drains_and_is_free_after(tsa_pki: TsaPki) -> None:
    run = Scenario(tsa_pki, runtime={"worker_threads": 1, "shutdown_grace": 5})
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
    assert run.parts.serials.allocations == 1


# -- the lifespan exit -------------------------------------------------------------------------------------------------
async def test_the_lifespan_exit_waits_for_the_token_and_its_event_before_datum_stops(tsa_pki: TsaPki) -> None:
    run = Scenario(tsa_pki)
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
    assert (
        run.order.index("effect done") < run.order.index("event TimestampIssuedEvent") < run.order.index("datum stop")
    )


async def test_a_token_the_grace_abandons_publishes_no_issued_event_after_the_stop(tsa_pki: TsaPki) -> None:
    """The dispatcher is closed with Datum: a call held past the grace may end either way, but announces nothing."""
    run = Scenario(tsa_pki, runtime={"worker_threads": 4, "shutdown_grace": 0.2})
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.post(http)
        await until(lambda: "effect start" in run.order)
        await run.datum.__aexit__(None, None, None)  # the grace expires with the call still held
        assert "datum stop" in run.order
        run.gate.set()  # the customizer returns after the stop
        try:
            reply: httpx2.Response | None = await request
        except Exception:  # a dropped connection is an accepted end
            reply = None
        await until(lambda: "effect done" in run.order)
    if reply is not None:  # the stop gate holds for a call already in flight: no 200 is possible
        assert reply.status_code == 503
        assert parse_reply(reply.content).fail_bits == {25}
    assert not any(type(e).__name__ == "TimestampIssuedEvent" for e in run.parts.events)
    assert "event TimestampIssuedEvent" not in run.order
    assert run.parts.serials.allocations == 0
    assert run.parts.key.signs == 0


# -- a client that leaves ----------------------------------------------------------------------------------------------
async def test_a_disconnect_mid_upload_answers_nothing_runs_nothing_logs_no_error_and_frees_the_slot(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    run = Scenario(tsa_pki, runtime={"worker_threads": 1, "shutdown_grace": 5})
    run.gate.set()
    sent: list[dict[str, Any]] = []
    async with run.datum:
        waiting, release = asyncio.Event(), asyncio.Event()
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    path="/tsa",
                    headers={"content-type": QUERY_TYPE, "content-length": "100"},
                    events=[{"type": "http.request", "body": query_der()[:20], "more_body": True}],
                    sent=sent,
                    waiting=waiting,
                    release=release,
                )
            )
            await asyncio.wait_for(waiting.wait(), 10)  # the first chunk was read and the application wants more
            assert not request.done()
            release.set()  # now the client leaves
            await request
        assert status_of(sent) is None  # no answer at all, never a 500
        assert run.parts.events == []
        assert run.parts.serials.allocations == 0
        assert run.parts.key.signs == 0
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
        gate = run.datum.timestamp_gate
        assert gate is not None
        flood = gate._flood
        assert flood.peek("addr:testclient", window=3600.0, now=time.monotonic()).count == 1  # counted at admission
        runner = run.datum.runner
        assert runner is not None
        assert (runner.slots_in_use, runner.in_flight) == (0, 0)
        async with client(run.app) as http:  # the only worker thread is free: the next request is served, not busy
            assert (await run.post(http)).status_code == 200


async def test_a_disconnect_after_the_body_cancels_nothing_the_token_and_the_event_complete(
    tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    run = Scenario(tsa_pki)
    raw = query_der(nonce=7)
    async with run.datum:
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    path="/tsa",
                    headers={"content-type": QUERY_TYPE, "content-length": str(len(raw))},
                    events=[{"type": "http.request", "body": raw, "more_body": False}],  # then http.disconnect
                    sent=[],
                )
            )
            await until(lambda: "effect start" in run.order)
            run.gate.set()
            await request
        await until(lambda: run.parts.events)
    assert [type(e).__name__ for e in run.parts.events] == ["TimestampIssuedEvent"]
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


# -- busy --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])
async def test_a_second_request_while_the_only_slot_is_held_is_503_busy_once_in_both_error_modes(
    tsa_pki: TsaPki, problem: bool
) -> None:
    run = Scenario(
        tsa_pki,
        runtime={"worker_threads": 1, "shutdown_grace": 5, "validation": {"wait": 0.1}},
        web={"api": {"problem_details": problem, "busy_retry_after": 7}},
    )
    async with run.datum, client(run.app) as http:
        first = run.post(http)
        await until(lambda: "effect start" in run.order)
        second = await run.post(http)
        run.gate.set()
        done = await first
    assert second.status_code == 503
    assert second.headers["retry-after"] == "7"
    assert second.headers["content-type"].startswith("application/problem+json" if problem else "application/json")
    assert done.status_code == 200
    assert parse_reply(done.content).status == 0
    assert run.parts.serials.allocations == 1, "the refused request took no serial"
    assert run.order.count("effect start") == 1, "the busy request never reached the doorstep"


# -- no sandbox slot ---------------------------------------------------------------------------------------------------
class SlotRuntime:
    """A runtime whose health reads a slot counter that any call into the engine beyond its identity would move."""

    def __init__(self) -> None:
        self.unexpected: list[str] = []
        self.slots_taken = 0

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        pass

    def stats(self) -> HarnessStats:
        return HarnessStats(slots=4, slots_in_use=self.slots_taken, runs_in_flight=0, stuck_runs=0, stray_runs=0)

    def __getattr__(self, name: str) -> Callable[..., None]:
        def taken(*args: object, **kwargs: object) -> None:
            self.unexpected.append(name)
            self.slots_taken += 1

        return taken


class RecordingSandbox(StubSandbox):
    """The stub sandbox, noting any call beyond the ones a start makes."""

    def __init__(self) -> None:
        super().__init__()
        self.unexpected: list[str] = []

    def __getattr__(self, name: str) -> Callable[..., None]:
        def called(*args: object, **kwargs: object) -> None:
            self.unexpected.append(name)

        return called


async def test_issuance_takes_no_sandbox_slot_and_the_sandbox_sees_no_call(tsa_pki: TsaPki) -> None:
    runtime, sandbox = SlotRuntime(), RecordingSandbox()
    datum, parts = make_datum(tsa_pki.ec, config(), runtime=cast("GuestRuntime", runtime), sandbox=sandbox_of(sandbox))
    async with datum:
        before = (sandbox.abi_proofs, sandbox.public_copies, list(sandbox.unexpected), list(runtime.unexpected))
        slots_before = datum.health().components["runtime"].details["slotsInUse"]
        answer = await datum.async_timestamps.answer(query_der(nonce=11))
        slots_after = datum.health().components["runtime"].details["slotsInUse"]
    assert answer.grant is not None
    assert parts.key.signs == 1, "the token was really signed"
    assert (sandbox.abi_proofs, sandbox.public_copies, sandbox.unexpected, runtime.unexpected) == before
    assert sandbox.unexpected == []
    assert runtime.unexpected == []
    assert slots_before == slots_after == 0
