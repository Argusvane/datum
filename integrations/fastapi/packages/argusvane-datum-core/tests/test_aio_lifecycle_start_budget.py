"""The lifecycle: the start budget (E004), one event loop at a time, one problem per line."""

import asyncio
import logging
import threading
import time
from typing import cast

import anyio
import pytest

from datum_core import Datum, DatumConfig
from datum_core.aio import AsyncLifecycle
from datum_core.events import DatumRuntimeReadyEvent, listener
from datum_sandbox.checks import E004, CheckLevel, DatumConfigurationError
from datum_sandbox.protocol import Sandbox, Smoke
from datum_sandbox.wasi import EngineInfo, GuestRuntime

pytestmark = pytest.mark.anyio

BUDGET = 0.2
SLOW = 0.8


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


class FakeEngine:
    """A fake engine whose ABI proof is slow, the way a synchronous guest compile is."""

    def __init__(self, delay: float = 0.0) -> None:
        self.delay = delay
        self.closed = 0

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="fake", release="1", mode="test")

    def close(self) -> None:
        self.closed += 1


class SlowSandbox:
    def __init__(self, delay: float) -> None:
        self.delay = delay

    def prove_abi(self) -> None:
        time.sleep(self.delay)

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")


def slow_datum(delay: float, budget: float = BUDGET) -> tuple[Datum, FakeEngine]:
    engine = FakeEngine(delay)
    config = DatumConfig.model_validate({"runtime": {"startup_budget": budget, "shutdown_grace": 0.5}})
    datum = Datum(config=config, runtime=cast("GuestRuntime", engine), sandbox=cast("Sandbox", SlowSandbox(delay)))
    return datum, engine


# ---- datum.runtime.startup_budget (E004) -----------------------------------------------------------------------------
async def test_a_start_slower_than_the_budget_is_e004_naming_the_setting_and_the_phases() -> None:
    # the timing rule: no sub-second budget on a loaded runner, so a 3 s budget and a start that needs 6 s
    budget, slow = 3.0, 6.0
    datum, engine = slow_datum(slow, budget=budget)
    lifecycle = AsyncLifecycle(datum)
    began = time.monotonic()
    with pytest.raises(DatumConfigurationError) as raised:
        await lifecycle.enter()
    waited = time.monotonic() - began
    assert budget <= waited < slow, "the lifecycle stopped waiting at the budget, not when the slow engine finished"
    error = raised.value
    assert [problem.id for problem in error.problems] == [E004]
    assert error.problems[0].level is CheckLevel.ERROR
    assert "datum.runtime.startup_budget" in str(error)
    assert "runtime" in str(error), "the phases measured so far are named"
    assert lifecycle.entries == 0
    assert not lifecycle.entered_once
    with anyio.fail_after(15):  # let the orphaned start finish and undo itself before the next test begins
        while datum.started or engine.closed == 0:  # noqa: ASYNC110 - polls a worker thread, no event to wait on
            await anyio.sleep(0.05)


async def test_the_orphaned_start_undoes_itself_when_it_finishes_over_the_budget() -> None:
    datum, engine = slow_datum(SLOW)
    lifecycle = AsyncLifecycle(datum)
    with pytest.raises(DatumConfigurationError):
        await lifecycle.enter()
    with anyio.fail_after(5):
        while datum.started or engine.closed == 0:  # noqa: ASYNC110 - polls a worker thread, no event to wait on
            await anyio.sleep(0.02)
    assert not datum.started
    assert engine.closed == 1


async def test_a_start_inside_the_budget_is_unchanged() -> None:
    datum, _engine = slow_datum(0.0, budget=5.0)
    lifecycle = AsyncLifecycle(datum)
    await lifecycle.enter()
    assert datum.started
    await lifecycle.exit()
    assert not datum.started


def test_a_sync_start_over_the_budget_raises_e004_after_the_slow_phase_and_leaves_nothing_up(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, engine = slow_datum(SLOW)
    with caplog.at_level(logging.ERROR, logger="datum.runtime"):
        with pytest.raises(DatumConfigurationError) as raised:
            datum.start()
        time.sleep(0.05)
    assert [problem.id for problem in raised.value.problems] == [E004]
    assert "datum.runtime.startup_budget" in str(raised.value)
    assert not datum.started
    assert engine.closed == 1
    assert any("datum.runtime.startup_budget" in record.getMessage() for record in caplog.records), (
        "the timer thread reports the overrun while the slow phase is still running"
    )


def test_the_sync_start_timer_thread_is_gone_after_the_start() -> None:
    datum, _engine = slow_datum(0.0, budget=5.0)
    datum.start()
    datum.stop()
    assert not [thread for thread in threading.enumerate() if thread.name.startswith("datum-start-budget")]


def slow_ready_datum(budget: float = BUDGET, ready_sleep: float = 0.6) -> tuple[Datum, FakeEngine]:
    """A fast start whose ready listener sleeps past the budget: the last measured phase ends inside it."""
    engine = FakeEngine()
    config = DatumConfig.model_validate({"runtime": {"startup_budget": budget, "shutdown_grace": 0.5}})
    datum = Datum(
        config=config,
        runtime=cast("GuestRuntime", engine),
        sandbox=cast("Sandbox", SlowSandbox(0.0)),
        listeners=[listener(DatumRuntimeReadyEvent, lambda _event: time.sleep(ready_sleep))],
    )
    return datum, engine


async def test_an_abandoned_start_that_succeeds_after_e004_is_stopped() -> None:
    datum, engine = slow_ready_datum()
    lifecycle = AsyncLifecycle(datum)
    with pytest.raises(DatumConfigurationError):
        await lifecycle.enter()
    with anyio.fail_after(5):
        while datum.started or engine.closed != 1:  # noqa: ASYNC110 - polls a worker thread, no event to wait on
            await anyio.sleep(0.02)
    assert lifecycle.entries == 0


def test_a_sync_start_that_succeeds_logs_no_overrun(caplog: pytest.LogCaptureFixture) -> None:
    # a 3 s budget (the timing rule: no sub-second budget on a loaded runner); the ready listener outlasts it by 1 s
    datum, _engine = slow_ready_datum(budget=3.0, ready_sleep=4.0)
    with caplog.at_level(logging.ERROR, logger="datum.runtime"):
        datum.start()
        time.sleep(0.05)
    assert datum.started
    assert not [record for record in caplog.records if "startup_budget" in record.getMessage()]
    datum.stop()


# ---- one event loop at a time ----------------------------------------------------------------------------------------
def test_a_second_event_loop_entering_while_entries_are_open_is_refused() -> None:
    datum, _engine = slow_datum(0.0, budget=5.0)
    lifecycle = AsyncLifecycle(datum)
    first = asyncio.new_event_loop()
    second = asyncio.new_event_loop()
    try:
        first.run_until_complete(lifecycle.enter())
        with pytest.raises(RuntimeError, match="one event loop"):
            second.run_until_complete(lifecycle.enter())
        with pytest.raises(RuntimeError, match="one event loop"):
            second.run_until_complete(lifecycle.exit())
        assert lifecycle.entries == 1
        first.run_until_complete(lifecycle.exit())
        assert lifecycle.entries == 0
    finally:
        first.close()
        second.close()


def test_sequential_event_loops_are_fine() -> None:
    datum, _engine = slow_datum(0.0, budget=5.0)
    lifecycle = AsyncLifecycle(datum)
    for _ in range(2):
        loop = asyncio.new_event_loop()
        try:
            loop.run_until_complete(lifecycle.enter())
            loop.run_until_complete(lifecycle.exit())
        finally:
            loop.close()
    assert lifecycle.entries == 0
