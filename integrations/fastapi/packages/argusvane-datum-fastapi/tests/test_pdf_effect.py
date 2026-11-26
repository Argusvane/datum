"""Through `POST /api/pdf`: the effect stage survives a native cancel, the lifespan drains it, a disconnect
mid-upload costs nothing, and a busy slot is a 503 once.

The whole print (the customizers, the program, the validators, the signature, the timestamp, `complete` and the
`PdfRenderedEvent`) is ONE tracked task awaited through `asyncio.shield`: a request task cancelled natively (uvicorn at
`--timeout-graceful-shutdown`) leaves the seal to finish, the slot stays taken while it drains, and the event is
published inside the call. A client that leaves before the body is whole costs nothing: no answer, no throttle count, no
run, no signature, no event. Every program run takes a PDF-pool slot. Ported from `test_tsa_effect.py`.
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
from pdf_fakes import Parts, Signer, build_app, config, envelope, make_datum

from datum_core.events import DatumEvent
from datum_core.testing.tsa_pki import DocumentPki, build_document_pki
from datum_sandbox.protocol import PoolKind

pytestmark = pytest.mark.anyio

SEAL = {"seal": {"enabled": True, "timestamp": False, "posted_answers": False}}
"""Posted answers sealed with the throwaway test seal (`posted_answers` true would seal them with the server's key)."""


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


async def until(condition: Callable[[], object], *, seconds: float = 10.0) -> None:
    for _ in range(int(seconds / 0.01)):
        if condition():
            return
        await anyio.sleep(0.01)
    raise AssertionError("the condition never came true")


def client(app: Any) -> httpx2.AsyncClient:
    return httpx2.AsyncClient(transport=httpx2.ASGITransport(app=app), base_url="http://testserver")


class Scenario:
    """A Datum whose customizer (the effect's doorstep) waits on `gate`, with one ordered list of what happened."""

    def __init__(self, pki: DocumentPki, **sections: Any) -> None:
        self.order: list[str] = []
        self.gate = threading.Event()
        self.parts = Parts(signer=Signer(pki.signer))

        def doorstep(draft: Any) -> None:
            self.order.append("effect start")
            self.gate.wait(30)
            self.order.append("effect done")

        sections.setdefault("runtime", {"worker_threads": 4, "shutdown_grace": 5})
        pdf = sections.pop("pdf", SEAL)
        self.datum, _ = make_datum(
            config(pdf=pdf, **sections),
            self.parts,
            pdf_request_customizers=[doorstep],
            listeners=[(DatumEvent, self.on_event)],
        )
        self.app = build_app(self.datum)

    def on_event(self, event: DatumEvent) -> None:
        self.order.append(f"event {type(event).__name__}")
        self.parts.record(event)

    def post(self, http: httpx2.AsyncClient) -> "asyncio.Task[httpx2.Response]":
        return asyncio.create_task(http.post("/api/pdf", json={"document": envelope()}))


# -- the native cancel -------------------------------------------------------------------------------------------------
async def test_a_native_task_cancel_of_the_request_still_seals_completes_and_publishes_the_event(
    pki: DocumentPki,
) -> None:
    run = Scenario(pki)
    async with run.datum, client(run.app) as http:
        request = run.post(http)
        await until(lambda: "effect start" in run.order)
        request.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await request
        run.gate.set()
        await until(lambda: "event PdfRenderedEvent" in run.order)
    assert run.order.index("effect done") < run.order.index("event PdfRenderedEvent")
    assert run.parts.kinds() == ["PdfRenderedEvent"]
    assert run.parts.program.ops().count("complete") == 1
    assert run.parts.signer is not None
    assert run.parts.signer.signs == 0, "posted answers: the test seal signed, not the key"


async def test_the_slot_stays_taken_while_the_cancelled_call_drains_and_is_free_after(pki: DocumentPki) -> None:
    run = Scenario(pki, runtime={"worker_threads": 1, "shutdown_grace": 5})
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
    assert run.parts.kinds() == ["PdfRenderedEvent"]


# -- the lifespan exit -------------------------------------------------------------------------------------------------
async def test_the_lifespan_exit_waits_for_the_print_and_its_event_before_datum_stops(pki: DocumentPki) -> None:
    run = Scenario(pki)
    run.parts.program.close = lambda: run.order.append("datum stop")  # type: ignore[method-assign]
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
    assert run.order.index("effect done") < run.order.index("event PdfRenderedEvent") < run.order.index("datum stop")


async def test_a_print_the_grace_abandons_publishes_no_event_and_uses_no_key_after_the_stop(pki: DocumentPki) -> None:
    run = Scenario(
        pki,
        runtime={"worker_threads": 4, "shutdown_grace": 0.2},
        pdf={"seal": {"enabled": True, "timestamp": False, "posted_answers": True}},
    )
    await run.datum.__aenter__()
    async with client(run.app) as http:
        request = run.post(http)
        await until(lambda: "effect start" in run.order)
        await run.datum.__aexit__(None, None, None)  # the grace expires with the call still held
        run.gate.set()  # the customizer returns after the stop
        try:
            reply: httpx2.Response | None = await request
        except Exception:  # a dropped connection is an accepted end
            reply = None
        await until(lambda: "effect done" in run.order)
    if reply is not None:
        assert reply.status_code in {500, 503}, "the stop gate holds for a call already in flight: no 200 is possible"
    assert "PdfRenderedEvent" not in run.parts.kinds()
    assert run.parts.program.requests("complete") == []
    assert run.parts.signer is not None
    assert run.parts.signer.signs == 0


# -- a client that leaves ----------------------------------------------------------------------------------------------
async def test_a_disconnect_mid_upload_answers_nothing_runs_nothing_logs_no_error_and_frees_the_slot(
    pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    run = Scenario(pki, runtime={"worker_threads": 1, "shutdown_grace": 5})
    run.gate.set()
    sent: list[dict[str, Any]] = []
    async with run.datum:
        waiting, release = asyncio.Event(), asyncio.Event()
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    path="/api/pdf",
                    headers={"content-type": "application/json", "content-length": "400"},
                    events=[{"type": "http.request", "body": b'{"document": {"versionContext"', "more_body": True}],
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
        assert run.parts.kinds() == []
        assert run.parts.program.ops() == []
        assert run.parts.sandbox.validations == 0
        assert run.parts.signer is not None
        assert run.parts.signer.signs == 0
        assert not [r for r in caplog.records if r.levelno >= logging.ERROR]
        runner = run.datum.runner
        assert runner is not None
        assert (runner.slots_in_use, runner.in_flight) == (0, 0)
        async with client(run.app) as http:  # the only worker thread is free: the next request is served, not busy
            assert (await run.post(http)).status_code == 200


async def test_a_disconnect_after_the_body_cancels_nothing_the_print_and_the_event_complete(
    pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    import json  # noqa: PLC0415 - one use

    run = Scenario(pki)
    raw = json.dumps({"document": envelope()}).encode()
    async with run.datum:
        with caplog.at_level(logging.WARNING):
            request = asyncio.create_task(
                call(
                    run.app,
                    path="/api/pdf",
                    headers={"content-type": "application/json", "content-length": str(len(raw))},
                    events=[{"type": "http.request", "body": raw, "more_body": False}],  # then http.disconnect
                    sent=[],
                )
            )
            await until(lambda: "effect start" in run.order)
            run.gate.set()
            await request
        await until(lambda: run.parts.events)
    assert run.parts.kinds() == ["PdfRenderedEvent"]
    assert not [r for r in caplog.records if r.levelno >= logging.ERROR]


async def test_a_disconnect_mid_verify_upload_costs_nothing(pki: DocumentPki) -> None:
    run = Scenario(pki)
    sent: list[dict[str, Any]] = []
    async with run.datum:
        waiting, release = asyncio.Event(), asyncio.Event()
        request = asyncio.create_task(
            call(
                run.app,
                path="/api/pdf/verify",
                headers={"content-type": "application/pdf", "content-length": "5000"},
                events=[{"type": "http.request", "body": b"%PDF-1.7 abcdef", "more_body": True}],
                sent=sent,
                waiting=waiting,
                release=release,
            )
        )
        await asyncio.wait_for(waiting.wait(), 10)
        release.set()
        await request
    assert status_of(sent) is None
    assert run.parts.program.requests("verify") == []
    assert run.parts.kinds() == []


# -- busy --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("problem", [False, True], ids=["errors body", "problem details"])
async def test_a_second_request_while_the_only_slot_is_held_is_503_busy_once_in_both_error_modes(
    pki: DocumentPki, problem: bool
) -> None:
    run = Scenario(
        pki,
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
    assert run.parts.kinds() == ["PdfRenderedEvent"], "the refused request printed and announced nothing"
    assert run.order.count("effect start") == 1, "the busy request never reached the doorstep"


# -- the PDF pool ------------------------------------------------------------------------------------------------------
async def test_every_program_run_of_a_print_is_made_in_the_pdf_pool(pki: DocumentPki) -> None:
    run = Scenario(pki)
    run.gate.set()
    async with run.datum, client(run.app) as http:
        reply = await run.post(http)
    assert reply.status_code == 200
    assert run.parts.program.budgets, "the program was asked"
    assert {budget.pool for budget in run.parts.program.budgets} == {PoolKind.PDF}


async def test_verify_and_the_certificate_take_no_application_dependency_and_a_verify_takes_a_pdf_slot_too(
    pki: DocumentPki,
) -> None:
    run = Scenario(pki)
    async with run.datum, client(run.app) as http:
        reply = await http.post("/api/pdf/verify", content=b"%PDF-1.7\nxx", headers={"Content-Type": "application/pdf"})
        pem = await http.get("/api/server/certificate")
    assert reply.status_code == 200
    assert pem.status_code == 200
    assert {budget.pool for budget in run.parts.program.budgets} == {PoolKind.PDF}
    assert run.parts.kinds() == ["PdfVerifiedEvent"]
