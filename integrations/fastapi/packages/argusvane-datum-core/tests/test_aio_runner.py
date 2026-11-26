"""The awaiter, the limiter runner with its bounded acquire, the tracked task and the drain."""

import asyncio
import contextvars
import threading
import time
from collections.abc import Callable
from typing import Any

import anyio
import anyio.lowlevel
import anyio.to_thread
import pytest

from datum_core.aio import (
    AsyncDefinitionService,
    AsyncRunner,
    DrainResult,
    anyio_awaiter,
    size_worker_threads,
    worker_threads_for,
)
from datum_core.hooks import MaybeAwaitable, resolve
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def wait_until(condition: Callable[[], bool], *, seconds: float = 5.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        assert time.monotonic() < deadline, "the condition never came true"
        await anyio.sleep(0.005)


# ---- the awaiter ---------------------------------------------------------------------------------------------------
async def test_the_awaiter_resolves_an_awaitable_from_a_worker_thread_on_the_loop() -> None:
    loop_thread = threading.get_ident()

    async def answer() -> tuple[int, int]:
        await anyio.lowlevel.checkpoint()
        return 42, threading.get_ident()

    def in_worker() -> tuple[int, int, int]:
        value, ran_on = anyio_awaiter(answer())
        return value, ran_on, threading.get_ident()

    value, ran_on, worker = await anyio.to_thread.run_sync(in_worker)
    assert value == 42
    assert ran_on == loop_thread  # the coroutine ran on the loop, not on the worker
    assert worker != loop_thread


async def test_an_error_in_the_awaitable_reaches_the_calling_thread() -> None:
    async def boom() -> None:
        raise KeyError("boom")

    with pytest.raises(KeyError, match="boom"):
        await anyio.to_thread.run_sync(lambda: anyio_awaiter(boom()))


async def test_the_awaiter_serves_hooks_through_resolve() -> None:
    async def hook() -> str:
        return "async"

    def in_worker() -> tuple[str, str]:
        answer: MaybeAwaitable[str] = hook()  # typed as a hook's answer: resolve does not infer T from a bare coroutine
        return resolve(answer, anyio_awaiter), resolve("sync", anyio_awaiter)

    assert await anyio.to_thread.run_sync(in_worker) == ("async", "sync")


async def test_the_awaiter_called_on_the_loop_thread_is_refused_not_deadlocked() -> None:
    async def answer() -> int:
        return 1

    coroutine = answer()
    try:
        with pytest.raises(RuntimeError):
            anyio_awaiter(coroutine)
    finally:
        coroutine.close()


# ---- worker thread sizing -----------------------------------------------------------------------------------
def test_the_worker_threads_default_to_two_per_slot_plus_two() -> None:
    assert worker_threads_for(4) == 10
    assert worker_threads_for(1) == 4
    assert worker_threads_for(4, configured=0) == 10


def test_a_configured_worker_thread_count_wins() -> None:
    assert worker_threads_for(4, configured=7) == 7


def test_the_sizing_formula_is_slots_plus_the_hook_share_plus_two() -> None:
    assert size_worker_threads(4, hook_time=0.0, run_time=1.0) == 6
    assert size_worker_threads(4, hook_time=0.5, run_time=1.0) == 8
    assert size_worker_threads(4, hook_time=1.0, run_time=1.0) == 10
    assert size_worker_threads(4, hook_time=0.1, run_time=1.0) == 7  # ceil(0.4) = 1


# ---- the runner ----------------------------------------------------------------------------------------------------
async def test_a_call_runs_on_a_worker_thread_and_returns_its_result() -> None:
    runner = AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=1.0)
    main = threading.get_ident()
    assert await runner.run(lambda: threading.get_ident() != main) is True
    assert await runner.run(lambda a, b: a + b, 2, 3) == 5
    await runner.drain()


async def test_an_error_in_the_call_reaches_the_caller_and_frees_the_slot() -> None:
    runner = AsyncRunner(worker_threads=1, wait=0.2, shutdown_grace=1.0)

    def fail() -> None:
        raise ValueError("bad")

    with pytest.raises(ValueError, match="bad"):
        await runner.run(fail)
    assert await runner.run(lambda: "after") == "after"
    assert runner.slots_in_use == 0
    await runner.drain()


async def test_the_context_of_the_caller_reaches_the_worker() -> None:
    var: contextvars.ContextVar[str] = contextvars.ContextVar("var", default="unset")
    var.set("request")
    runner = AsyncRunner(worker_threads=1, wait=1.0, shutdown_grace=1.0)
    assert await runner.run(var.get) == "request"
    await runner.drain()


async def test_a_call_that_cannot_get_a_slot_within_the_wait_answers_busy_after_the_wait() -> None:
    runner = AsyncRunner(worker_threads=1, wait=0.15, shutdown_grace=2.0)
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        started.set()
        release.wait(10)

    first = asyncio.create_task(runner.run(hold))
    await wait_until(started.is_set)
    began = time.monotonic()
    with pytest.raises(EngineBusyError) as raised:
        await runner.run(lambda: None)
    waited = time.monotonic() - began
    assert raised.value.reason == "slots"
    assert 0.1 <= waited < 3.0  # it waited the configured time, not for the holder (10 s); 3 s for a 1-vCPU VM
    release.set()
    await first
    assert await runner.run(lambda: "free again") == "free again"
    await runner.drain()


async def test_a_zero_wait_is_busy_at_once() -> None:
    runner = AsyncRunner(worker_threads=1, wait=0.0, shutdown_grace=2.0)
    started, release = threading.Event(), threading.Event()

    def hold() -> None:
        started.set()
        release.wait(10)

    first = asyncio.create_task(runner.run(hold))
    await wait_until(started.is_set)
    with pytest.raises(EngineBusyError):
        await runner.run(lambda: None)
    release.set()
    await first
    await runner.drain()


async def test_a_native_task_cancel_does_not_stop_the_effect_and_the_slot_stays_held_until_it_ends() -> None:
    runner = AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=5.0)
    started, release, effect = threading.Event(), threading.Event(), threading.Event()

    def work() -> str:
        started.set()
        release.wait(10)
        effect.set()
        return "done"

    caller = asyncio.create_task(runner.run(work))
    await wait_until(started.is_set)
    caller.cancel()  # what uvicorn does at --timeout-graceful-shutdown expiry: a native cancel, not an anyio scope
    with pytest.raises(asyncio.CancelledError):
        await caller
    assert not effect.is_set()  # the thread is still working
    assert runner.in_flight == 1  # the tracked task outlives its caller
    assert runner.slots_in_use == 1  # and still holds the slot: the limiter must not undercount
    release.set()
    result = await runner.drain()
    assert effect.is_set()  # the effect completed
    assert result.finished == 1
    assert result.abandoned == 0
    assert runner.in_flight == 0
    assert runner.slots_in_use == 0


async def test_the_drain_waits_for_a_call_that_ends_within_the_grace() -> None:
    runner = AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=3.0)
    done = threading.Event()

    def work() -> None:
        time.sleep(0.2)
        done.set()

    caller = asyncio.create_task(runner.run(work))
    await wait_until(lambda: runner.in_flight == 1)
    expired: list[bool] = []
    began = time.monotonic()
    result = await runner.drain(on_grace_expired=lambda: expired.append(True))
    assert done.is_set()
    assert result == DrainResult(finished=1, abandoned=0)
    assert expired == []
    assert time.monotonic() - began < 3.0  # the call took 0.2 s; waiting out the 3 s grace fails here
    await caller


async def test_the_drain_gives_up_at_the_grace_and_tells_the_engine_to_interrupt_what_is_left() -> None:
    runner = AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=0.25)
    started, release = threading.Event(), threading.Event()

    def stuck() -> None:
        started.set()
        release.wait(10)

    caller = asyncio.create_task(runner.run(stuck))
    await wait_until(started.is_set)
    expired: list[float] = []
    began = time.monotonic()
    result = await runner.drain(on_grace_expired=lambda: expired.append(time.monotonic() - began))
    took = time.monotonic() - began
    assert result == DrainResult(finished=0, abandoned=1)
    assert len(expired) == 1  # the epoch is advanced once, at the expiry
    assert 0.2 <= expired[0] < 3.0
    assert took < 3.0  # the drain is bounded by the grace, not by the stuck call (10 s)
    release.set()
    await caller


async def test_once_the_drain_has_begun_no_new_call_is_taken() -> None:
    runner = AsyncRunner(worker_threads=1, wait=1.0, shutdown_grace=1.0)
    await runner.drain()
    with pytest.raises(EngineClosedError):
        await runner.run(lambda: None)


async def test_a_drain_with_nothing_in_flight_returns_at_once() -> None:
    runner = AsyncRunner(worker_threads=1, wait=1.0, shutdown_grace=5.0)
    began = time.monotonic()
    assert await runner.drain() == DrainResult(finished=0, abandoned=0)
    assert time.monotonic() - began < 3.0  # not the 5 s grace


# ---- the async facade ----------------------------------------------------------------------------------------------
async def test_an_async_definition_service_runs_the_sync_read_on_a_worker_thread_through_the_runner() -> None:
    main = threading.get_ident()
    seen: dict[str, Any] = {}

    class Service:
        def read(self, key: str, *, public: bool = True) -> tuple[str, bool]:
            seen["thread"] = threading.get_ident()
            return key, public

    runner = AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=1.0)
    facade = AsyncDefinitionService(Service(), runner)  # type: ignore[arg-type]
    assert await facade.read("contact", public=False) == ("contact", False)  # type: ignore[comparison-overlap]
    assert seen["thread"] != main
    await runner.drain()
