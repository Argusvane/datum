"""The lifecycle on the real engine: discovery, the packaged programs, the ABI proof, a public copy, the thread census.

Marked `runtime` (the wasm engine compiles its guest at the start); serial, never under xdist.
"""

import asyncio
import functools
import threading
import time
from pathlib import Path
from typing import Any

import pytest
from datum_fakes import SECRET_MARKER, StubRepository, config, definition
from fastapi import FastAPI
from fastapi.testclient import TestClient

from datum_core.events import DatumRuntimeReadyEvent, SandboxRunInterruptedEvent, listener
from datum_fastapi import Datum, routers
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError, RuleModule, SandboxError, SandboxFailure
from datum_sandbox.wasi import GuestRuntimes

pytestmark = pytest.mark.runtime

ENGINE = "wasmtime"
PATH = "/api/forms/contact/definition"


@pytest.fixture(scope="module", autouse=True)
def _engine_installed() -> None:
    if ENGINE not in GuestRuntimes.discover().ids():
        pytest.skip(f"the {ENGINE} engine is not installed (argusvane-datum-sandbox-wasmtime registers it)")


def datum_threads() -> set[str]:
    return {t.name for t in threading.enumerate() if t.name.startswith("datum")}


def settled(before: set[int | None], seconds: float = 3.0) -> set[int | None]:
    """The threads alive now that were not before, after a short settle poll (anyio workers linger briefly)."""
    deadline = time.monotonic() + seconds
    while True:
        extra = {t.ident for t in threading.enumerate()} - before
        if not extra or time.monotonic() > deadline:
            return extra
        time.sleep(0.02)


def test_the_discovered_engine_serves_the_public_copy_and_leaves_no_thread_after_the_exit(tmp_path: Path) -> None:
    before = {t.ident for t in threading.enumerate()}
    ready: list[DatumRuntimeReadyEvent] = []
    sections: dict[str, Any] = {
        "runtime": {
            "work_dir": str(tmp_path),
            "warm_up_runs": 1,
            "validation": {"concurrency": 2},
            "pdf": {"concurrency": 1},
        }
    }
    datum = Datum(
        config=config(**sections),
        form_repository=StubRepository(definition("contact", secret=True)),
        listeners=[listener(DatumRuntimeReadyEvent, ready.append)],
    )
    app = FastAPI()
    app.include_router(routers.forms(datum))
    with TestClient(app) as client:
        reply = client.get(PATH)
        runtime = datum.health().components["runtime"]
        info = datum.info()
        assert datum_threads()  # the engine's clock thread runs while Datum is up
    assert reply.status_code == 200
    assert SECRET_MARKER not in reply.text  # the kernel's public copy dropped the server-secret rule
    assert runtime.status == "up"
    assert runtime.details["engine"] == ENGINE
    assert runtime.details["slots"] == 3
    assert info["engine"] == ENGINE
    assert len(ready) == 1
    assert ready[0].engine.id == ENGINE
    assert datum_threads() == set()  # Datum's own threads end with the exit
    assert settled(before) == set()
    assert datum.health().components["runtime"].details["reason"] == "stopped"


class FailingAbi:
    """Delegates to the real sandbox, but its ABI proof fails after the engine was built."""

    def __init__(self, inner: Any) -> None:
        self._inner = inner

    def prove_abi(self) -> None:
        raise ProgramUnavailableError("abi too old")

    def __getattr__(self, name: str) -> Any:
        return getattr(self._inner, name)


def test_a_start_that_fails_after_the_engine_was_built_leaves_no_thread(tmp_path: Path) -> None:
    before = {t.ident for t in threading.enumerate()}
    datum = Datum(
        config=config(runtime={"work_dir": str(tmp_path), "warm_up_runs": 1}),
        sandbox_middleware=[FailingAbi],
        form_repository=StubRepository(definition("contact", secret=True)),
    )

    async def enter() -> None:
        async with datum:
            pass

    with pytest.raises(ProgramUnavailableError):
        asyncio.run(enter())
    assert datum_threads() == set()
    assert settled(before) == set()
    assert datum.entries == 0
    assert datum.runner is None
    assert datum.started is False


LOOP = [RuleModule("loop", "1", "({ validators: [function () { for (;;) {} }] })")]
CONTEXT: dict[str, JsonValue] = {
    "formId": "loop",
    "form": {
        "id": "root",
        "type": "form",
        "configuration": {},
        "children": {"content": [{"id": "name", "type": "text", "configuration": {"label": "Name"}}]},
    },
    "values": {},
    "locale": "en",
}


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


@pytest.mark.anyio
async def test_a_looping_run_still_in_flight_at_the_grace_is_interrupted_and_reads_unavailable(tmp_path: Path) -> None:
    stopped: list[SandboxRunInterruptedEvent] = []
    sections: dict[str, Any] = {
        "runtime": {
            "work_dir": str(tmp_path),
            "warm_up_runs": 1,
            "shutdown_grace": 0.3,
            "validation": {"time_limit": 20, "concurrency": 1},
            "pdf": {"concurrency": 1},
        }
    }
    datum = Datum(config=config(**sections), listeners=[listener(SandboxRunInterruptedEvent, stopped.append)])
    async with datum:
        runner = datum.runner
        assert runner is not None
        call = asyncio.create_task(runner.run(functools.partial(datum.sandbox.validate, CONTEXT, LOOP, real=False)))
        deadline = time.monotonic() + 10
        while datum.health().components["runtime"].details.get("runsInFlight") != 1:
            assert time.monotonic() < deadline, "the looping run never started"
            await asyncio.sleep(0.02)
        began = time.monotonic()
    took = time.monotonic() - began
    with pytest.raises(SandboxError) as raised:
        await call
    assert raised.value.reason is SandboxFailure.INTERRUPTED
    assert (raised.value.status, raised.value.code) == (503, "server.unavailable")
    assert [event.reason for event in stopped] == ["interrupted"]
    assert took < 3.0  # the grace, then the engine's stop: never the run's own 20 s budget
