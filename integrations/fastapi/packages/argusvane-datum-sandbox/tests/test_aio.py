"""The async facade: the sandbox started, validated, rechecked and stopped from an event loop, off the loop."""

import threading

import pytest
from sandbox_fakes import FakeRuntime, context

from datum_sandbox import DatumSandbox, SandboxSettings, SandboxState
from datum_sandbox.aio import AsyncDatumSandbox
from datum_sandbox.wasi import EngineInfo, GuestRun, RunResult

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class ThreadNoting(FakeRuntime):
    """Notes the thread every run is made on."""

    def __init__(self) -> None:
        super().__init__()
        self.threads: list[int | None] = []

    def run(self, job: GuestRun, /) -> RunResult:
        self.threads.append(threading.get_ident())
        return super().run(job)

    def engine_info(self) -> EngineInfo:
        return super().engine_info()


async def test_the_facade_runs_every_call_off_the_loop() -> None:
    runtime = ThreadNoting()
    loop_thread = threading.get_ident()
    async with AsyncDatumSandbox(
        DatumSandbox(SandboxSettings.build(report=False, warm_up_runs=1), runtime=runtime)
    ) as sandbox:
        assert sandbox.status().is_up
        result = await sandbox.sandbox.validate(context("Ada"), real=False)
        assert result.outcome["errors"] == []
        assert (await sandbox.recheck()).is_up
        assert sandbox.pdf_kernel is None, "the fake engine serves no PDF pool"
    assert sandbox.inner.state is SandboxState.STOPPED
    assert runtime.threads
    assert loop_thread not in runtime.threads
