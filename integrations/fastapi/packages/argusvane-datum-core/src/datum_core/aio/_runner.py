"""The binding's runner: worker threads bounded by a lifespan-made limiter, tracked tasks, and the shutdown drain.

How the runner is bounded and shut down:

- The `CapacityLimiter` is created inside the lifespan (an anyio primitive belongs to one loop) and sized by
  `datum.runtime.worker_threads`, default `2 * slots + 2`: it bounds runs plus in-flight async hooks, never the 40-token
  default. Taking a thread waits at most the pool's `wait`; a call that gets none answers `EngineBusyError("slots")`
  (503 `server.busy`) instead of queueing out of sight.
- Each call runs as a TRACKED TASK the caller awaits through `asyncio.shield`. uvicorn's graceful-shutdown expiry
  cancels the request task natively (`task.cancel()`), which `anyio.CancelScope(shield=True)` does not resist;
  the shielded task does, so a call whose caller was cancelled still completes its effect. The task holds the slot
  until it ends, so the limiter never undercounts while it drains.
- `drain()` refuses new calls, waits for the tracked tasks within `datum.runtime.shutdown_grace`, and then tells the
  engine to interrupt what is left (the runs end `RunEnd.INTERRUPTED`, 503 `server.unavailable`).
"""

import asyncio
import inspect
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Final

import anyio
import anyio.to_thread

from datum_core import observe
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

_BUSY_REASON: Final = "slots"


def worker_threads_for(slots: int, configured: int = 0) -> int:
    """Return the limiter size: `configured` when set (above 0), else the default `2 * slots + 2`."""
    if configured < 0 or slots < 0:
        raise ValueError("slots and the configured worker threads are counts, zero or more")
    return configured if configured > 0 else 2 * slots + 2


def size_worker_threads(slots: int, *, hook_time: float, run_time: float) -> int:
    """Return `slots + ceil(slots * hook_time / run_time) + 2`, the sizing formula of `worker_threads`.

    `hook_time` is the time a call spends on its worker thread outside the run (awaited hooks, sync stores, the TSA
    client); `run_time` the run's own time. Both in the same unit; `run_time` must be above 0.
    """
    if slots < 0 or hook_time < 0 or run_time <= 0:
        raise ValueError("slots and hook_time are zero or more and run_time is above zero")
    return slots + math.ceil(slots * hook_time / run_time) + 2


@dataclass(frozen=True, slots=True)
class DrainResult:
    """How the drain ended: calls that finished within the grace, and calls still running when it expired."""

    finished: int
    abandoned: int


type GraceExpired = Callable[[], object]
"""Called once when the grace expires with calls left; an awaitable answer is awaited (an interrupt off the loop)."""


class AsyncRunner:
    """Run sync service calls on worker threads as tracked tasks; create it inside the lifespan, drain it at exit."""

    def __init__(self, *, worker_threads: int, wait: float, shutdown_grace: float) -> None:
        """Size the limiter (`worker_threads`), bound its acquire (`wait`, seconds) and the drain (`shutdown_grace`)."""
        if worker_threads < 1:
            raise ValueError("the runner needs at least one worker thread")
        if wait < 0 or shutdown_grace < 0:
            raise ValueError("wait and shutdown_grace are zero or more seconds")
        # The slots gate every call with a bounded wait. The thread limiter has the same size and is never contended
        # (the slots admit at most that many), but anyio's own acquire is unbounded and a task may hold one token of a
        # limiter only, so the worker thread is taken from the second limiter once the slot is held.
        self._slots = anyio.CapacityLimiter(worker_threads)
        self._threads = anyio.CapacityLimiter(worker_threads)
        self._wait = wait
        self._grace = shutdown_grace
        self._tasks: set[asyncio.Task[Any]] = set()
        self._closed = False

    @property
    def worker_threads(self) -> int:
        """The limiter's size."""
        return int(self._slots.total_tokens)

    @property
    def in_flight(self) -> int:
        """Tracked calls not yet ended, whether or not their caller still waits."""
        return len(self._tasks)

    @property
    def slots_in_use(self) -> int:
        """Slots held now; a call holds its slot until it ends, also after its caller was cancelled."""
        return int(self._slots.borrowed_tokens)

    @property
    def closed(self) -> bool:
        """Whether the drain has begun (no new call is taken)."""
        return self._closed

    async def run[T, *Ts](self, fn: Callable[[*Ts], T], *args: *Ts) -> T:
        """Run `fn(*args)` on a worker thread as a tracked task and return its result.

        Raises `EngineClosedError` once the drain has begun, `EngineBusyError("slots")` when no slot comes within the
        wait. A native cancel of the caller ends the wait, not the call: the call completes and keeps its slot.
        """
        if self._closed:
            raise EngineClosedError("the runner is draining for shutdown; no new call is taken")
        task = asyncio.get_running_loop().create_task(self._call(fn, args))  # copies the caller's context
        self._tasks.add(task)
        task.add_done_callback(self._forget)
        return await asyncio.shield(task)

    async def drain(self, on_grace_expired: GraceExpired | None = None) -> DrainResult:
        """Refuse new calls, wait for the tracked ones within the grace, then report what is left once.

        `on_grace_expired` is called once when calls are left at the expiry (an awaitable answer is awaited).

        The drain never waits past the grace for a call that does not end: what is left is the engine's to interrupt.
        """
        self._closed = True
        pending = set(self._tasks)
        if not pending:
            return DrainResult(finished=0, abandoned=0)
        done, left = await asyncio.wait(pending, timeout=self._grace)
        if left and on_grace_expired is not None:
            answer = on_grace_expired()
            if inspect.isawaitable(answer):
                await answer
        return DrainResult(finished=len(done), abandoned=len(left))

    async def _call[T](self, fn: Callable[..., T], args: tuple[Any, ...]) -> T:
        await self._take_slot()
        try:
            return await anyio.to_thread.run_sync(fn, *args, abandon_on_cancel=False, limiter=self._threads)
        finally:
            self._slots.release()

    async def _take_slot(self) -> None:
        began = time.perf_counter()
        try:
            self._slots.acquire_nowait()
        except anyio.WouldBlock:
            pass
        else:
            return
        if self._wait <= 0:
            observe.count_busy(time.perf_counter() - began)
            raise EngineBusyError(_BUSY_REASON)
        try:
            with anyio.fail_after(self._wait):
                await self._slots.acquire()
        except TimeoutError:
            observe.count_busy(time.perf_counter() - began)
            raise EngineBusyError(_BUSY_REASON) from None

    def _forget(self, task: asyncio.Task[Any]) -> None:
        self._tasks.discard(task)
        if not task.cancelled():
            task.exception()  # retrieved: a caller cancelled under the shield never reads it
