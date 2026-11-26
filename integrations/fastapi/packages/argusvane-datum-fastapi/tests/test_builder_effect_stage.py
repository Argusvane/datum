"""Through `PUT /api/forms/{key}`: the effect stage survives a native cancel, the lifespan drains it, a mid-upload
disconnect costs nothing, and a busy slot is a 503 once, in both error modes.

The whole write (the hooks, the kernel's check, the store, the snapshot, the saved event) is ONE tracked task awaited
through `asyncio.shield`: a request task cancelled natively (uvicorn at `--timeout-graceful-shutdown`) leaves the effect
to finish, the slot stays taken while it drains, and `FormDefinitionSavedEvent` is published inside the call. A client
that leaves before the body is whole costs nothing: no answer, no event, no log, nothing stored. Same shape as
`test_effect_stage.py` for submissions.
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
from builder_fakes import FORM, PERSON, WRITE, Parts, body_of, build_app, config, etag_of, make_datum
from datum_fakes import definition

from datum_core.events import DatumEvent
from datum_sandbox.protocol import SandboxError, SandboxFailure
from datum_sandbox.wasi import EngineInfo

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
        self.on_close: Callable[[], None] | None = None

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        self.order.append("datum stop")
        if self.on_close is not None:
            self.on_close()


class Scenario:
    """A Datum whose last validator (the effect's doorstep) waits on `gate`, with one ordered list of what happened."""

    def __init__(self, **sections: Any) -> None:
        self.order: list[str] = []
        self.gate = threading.Event()
        self.parts = Parts()
        self.runtime = Runtime(self.order)

        def doorstep(candidate: Any) -> None:
            self.order.append("effect start")
            self.gate.wait(30)
            self.order.append("effect done")

        sections.setdefault("runtime", {"worker_threads": 4, "shutdown_grace": 5})
        self.datum, _ = make_datum(
            config(**sections),
            parts=self.parts,
            runtime=self.runtime,
            builder_save_validators=[doorstep],
            listeners=[(DatumEvent, self.on_event)],
        )
        self.app = build_app(self.datum)
        self.etag = etag_of(self.parts.stored().definition)

    def on_event(self, event: DatumEvent) -> None:
        self.order.append(f"event {type(event).__name__}")
        self.parts.record(event)

    def put(
        self, http: httpx2.AsyncClient, version: str = "2", *, etag: str | None = None
    ) -> "asyncio.Task[httpx2.Response]":
        headers = {**WRITE, "If-Match": etag or self.etag}
        return asyncio.create_task(
            http.put(f"/api/forms/{FORM}", content=body_of(definition(FORM, version)), headers=headers)
        )

    @property
    def stored_version(self) -> str:
        return str(self.parts.stored().definition["version"])


# -- the native cancel ------------------------------------------------------------------------------------------------
async def test_a_native_task_cancel_of_the_request_still_stores_and_publishes_the_saved_event() -> None:
    run = Scenario()
    async with run.datum, client(run.app) as http:
        request = run.put(http)
        await until(lambda: "effect start" in run.order)
        request.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: "event FormDefinitionSavedEvent" in run.order)
    assert run.order.index("effect done") < run.order.index("event FormDefinitionSavedEvent")
    assert run.stored_version == "2"
    assert [type(e).__name__ for e in run.parts.events] == ["FormDefinitionSavedEvent"]


async def test_after_the_cancelled_call_ended_the_next_save_names_the_hash_it_stored() -> None:
    run = Scenario()
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        request = run.put(http)
        await until(lambda: runner.in_flight == 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: runner.in_flight == 0)
        stale = await run.put(http)  # the cancelled caller never saw the new ETag, so its own hash is stale now
        current = (await http.get(f"/api/forms/{FORM}/definition?public=false", headers=PERSON)).headers["etag"]
    assert stale.status_code == 409
    assert stale.headers["etag"] == current != run.etag
    assert run.stored_version == "2"


async def test_the_slot_stays_taken_while_the_cancelled_call_drains_and_is_free_after() -> None:
    run = Scenario(runtime={"worker_threads": 1, "shutdown_grace": 5})
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        request = run.put(http)
        await until(lambda: runner.slots_in_use == 1)
        request.cancel()
        with pytest.raises(asyncio.CancelledError):
            await request
        assert runner.slots_in_use == 1  # the limiter never undercounts while the call drains
        run.gate.set()
        await until(lambda: runner.slots_in_use == 0)
    assert run.stored_version == "2"


# -- the lifespan exit ------------------------------------------------------------------------------------------------
async def test_the_lifespan_exit_waits_for_the_write_and_its_event_before_datum_stops() -> None:
    run = Scenario()
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.put(http)
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
    assert order.index("effect done") < order.index("event FormDefinitionSavedEvent") < order.index("datum stop")
    assert run.stored_version == "2"


async def test_a_call_the_grace_abandons_ends_503_with_no_saved_event_and_nothing_stored() -> None:
    run = Scenario(runtime={"worker_threads": 4, "shutdown_grace": 0.2})
    release = threading.Event()
    run.parts.sandbox.gate = release
    run.runtime.on_close = release.set  # closing the runtime interrupts the run
    original = run.parts.sandbox.check

    def check(*args: Any, **kwargs: Any) -> Any:
        result = original(*args, **kwargs)
        if "datum stop" in run.order:
            raise SandboxError(SandboxFailure.INTERRUPTED, "the runtime was stopped")
        return result

    run.parts.sandbox.check = check  # type: ignore[method-assign]
    run.gate.set()
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.put(http)
        await until(run.parts.sandbox.entered.is_set)
        await run.datum.__aexit__(None, None, None)
        reply = await request
    assert reply.status_code == 503
    assert reply.json()["errors"][0]["code"] == "server.unavailable"
    assert "retry-after" not in reply.headers
    assert not any(type(e).__name__ == "FormDefinitionSavedEvent" for e in run.parts.events)
    assert run.stored_version == "1"


async def test_a_save_the_grace_abandons_in_a_validator_stores_nothing_and_publishes_no_event_after_the_stop() -> None:
    """The stop gate: a write held past the grace in a validator, not the kernel, lands nothing after the stop."""
    run = Scenario(runtime={"worker_threads": 4, "shutdown_grace": 0.2})
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.put(http)
        await until(lambda: "effect start" in run.order)  # held in the validator, after the kernel's check
        await run.datum.__aexit__(None, None, None)  # the grace expires and Datum stops with the call still held
        assert "datum stop" in run.order
        assert "effect done" not in run.order
        run.gate.set()  # the validator returns after the stop: the store would be next
        try:
            reply: httpx2.Response | None = await request
        except Exception:  # a dropped connection is an accepted end; nothing may be stored either way
            reply = None
        await until(lambda: "effect done" in run.order)
    if reply is not None:
        assert (reply.status_code, reply.json()["errors"][0]["code"]) == (503, "server.unavailable")
    assert run.stored_version == "1"
    assert not any(type(e).__name__ == "FormDefinitionSavedEvent" for e in run.parts.events)
    assert "event FormDefinitionSavedEvent" not in run.order


# -- a client that leaves ---------------------------------------------------------------------------------------------
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
                    method="PUT",
                    path=f"/api/forms/{FORM}",
                    headers={
                        "content-type": "application/json",
                        "content-length": "1000",
                        "if-match": run.etag,
                        "x-persona": "person",
                    },
                    events=[{"type": "http.request", "body": b'{"id": "contact", ', "more_body": True}],
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
        assert run.parts.sandbox.checks == []
        assert run.parts.events == []
        assert run.stored_version == "1"
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
        runner = run.datum.runner
        assert runner is not None
        assert (runner.slots_in_use, runner.in_flight) == (0, 0)
        async with client(run.app) as http:  # the only worker thread is free: the next save is served, not busy
            assert (await run.put(http)).status_code == 200


async def test_a_disconnect_after_the_body_cancels_nothing_the_store_and_the_event_complete(
    caplog: pytest.LogCaptureFixture,
) -> None:
    run = Scenario()
    raw = body_of(definition(FORM, "2"))
    async with run.datum:
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    method="PUT",
                    path=f"/api/forms/{FORM}",
                    headers={
                        "content-type": "application/json",
                        "content-length": str(len(raw)),
                        "if-match": run.etag,
                        "x-persona": "person",
                    },
                    events=[{"type": "http.request", "body": raw, "more_body": False}],  # then http.disconnect
                    sent=[],
                )
            )
            await until(lambda: "effect start" in run.order)
            run.gate.set()
            await request
        await until(lambda: run.parts.events)
    assert run.stored_version == "2"
    assert [type(e).__name__ for e in run.parts.events] == ["FormDefinitionSavedEvent"]
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


async def test_a_create_that_loses_its_client_after_the_body_is_still_created_and_published() -> None:
    run = Scenario()
    raw = body_of(definition("fresh", "1"))
    async with run.datum:
        request = asyncio.create_task(
            call(
                run.app,
                method="POST",
                path="/api/forms",
                headers={"content-type": "application/json", "content-length": str(len(raw)), "x-persona": "person"},
                events=[{"type": "http.request", "body": raw, "more_body": False}],
                sent=[],
            )
        )
        await until(lambda: "effect start" in run.order)
        run.gate.set()
        await request
        await until(lambda: run.parts.events)
    assert run.parts.stored("fresh").definition["id"] == "fresh"
    assert [type(e).__name__ for e in run.parts.events] == ["FormDefinitionSavedEvent"]


# -- busy -------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])
async def test_a_second_save_while_the_only_slot_is_held_is_503_busy_once_in_both_error_modes(problem: bool) -> None:
    run = Scenario(
        runtime={"worker_threads": 1, "shutdown_grace": 5, "validation": {"wait": 0.1}},
        web={"api": {"problem_details": problem, "busy_retry_after": 7}},
    )
    async with run.datum, client(run.app) as http:
        first = run.put(http)
        await until(lambda: "effect start" in run.order)
        busy = await run.put(http, "3")
        run.gate.set()
        done = await first
    assert done.status_code == 200
    assert busy.status_code == 503
    assert busy.headers["retry-after"] == "7"
    expected = "application/problem+json" if problem else "application/json"
    assert busy.headers["content-type"].split(";")[0] == expected
    document = busy.json()
    assert (document["code"] if problem else document["errors"][0]["code"]) == "server.busy"
    assert run.stored_version == "2"  # the refused save ran nothing
    assert len(run.parts.sandbox.checks) == 1
    assert run.order.count("effect start") == 1
    assert len(run.parts.events) == 1


async def test_busy_refusals_cost_no_kernel_check_and_leave_the_slot_count_right() -> None:
    run = Scenario(runtime={"worker_threads": 1, "shutdown_grace": 5, "validation": {"wait": 0.05}})
    async with run.datum, client(run.app) as http:
        runner = run.datum.runner
        assert runner is not None
        first = run.put(http)
        await until(lambda: "effect start" in run.order)
        for number in range(3):
            assert (await run.put(http, f"b{number}")).status_code == 503
        assert runner.slots_in_use == 1
        run.gate.set()
        await first
        await until(lambda: runner.slots_in_use == 0)
    assert len(run.parts.sandbox.checks) == 1
    assert run.stored_version == "2"


async def test_the_reads_of_the_author_copy_and_the_existence_step_take_no_slot_the_save_needs() -> None:
    run = Scenario(runtime={"worker_threads": 2, "shutdown_grace": 5})
    async with run.datum, client(run.app) as http:
        first = run.put(http)
        await until(lambda: "effect start" in run.order)
        read = await http.get(f"/api/forms/{FORM}/definition?public=false", headers=PERSON)
        assert read.status_code == 200
        run.gate.set()
        assert (await first).status_code == 200
