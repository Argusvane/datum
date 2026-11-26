"""The reference-counted async entry into a `Datum`, as a lifespan does it, framework-free.

A binding's routers each carry a lifespan, and an application may also write `async with datum:`; every one of them
enters here. The first entry starts Datum off the event loop (the runtime compiles its guest), on an anyio worker
thread so that the awaiter reaches the loop, and creates the runner; later entries only count. The wait for the
worker is bounded by `datum.runtime.startup_budget` (`datum.E004`). One `Datum` serves one event loop at a time: an
entry from a second loop while entries are open is refused; loops that follow each other are fine. The count rises
only after a successful start, and a failed start has already undone itself (`Datum.start`). The last exit drains the
runner's tracked calls within `datum.runtime.shutdown_grace`, has the runtime interrupt what is left (the runs end
INTERRUPTED and answer 503 `server.unavailable`), and stops Datum.
"""

import asyncio
import functools
import logging
import threading
import time
from collections.abc import Callable

import anyio
import anyio.to_thread

from datum_core.aio._awaiter import anyio_awaiter
from datum_core.aio._runner import AsyncRunner, worker_threads_for
from datum_core.datum import Datum
from datum_sandbox.loggers import RUNTIME

logger = logging.getLogger(RUNTIME)


def _abandoned(datum: Datum) -> Callable[["asyncio.Future[None]"], None]:
    """Return the callback for an abandoned start: read its outcome, and stop a start that succeeded after all."""

    def callback(future: "asyncio.Future[None]") -> None:
        if future.cancelled() or future.exception() is not None:  # also retrieves the exception for asyncio
            return
        if datum.started:  # nobody is left to stop it, and the stop must not block the loop
            threading.Thread(target=datum.stop, name="datum-abandoned-start", daemon=True).start()

    return callback


class AsyncLifecycle:
    """The entries into one `Datum`, its runner while entered, and the drain at the last exit."""

    def __init__(self, datum: Datum) -> None:
        """Belong to `datum`; nothing is entered yet."""
        self._datum = datum
        self._entries = 0
        self._runner: AsyncRunner | None = None
        self._entered_once = False
        self._loop: asyncio.AbstractEventLoop | None = None
        self._lock: asyncio.Lock | None = None

    @property
    def entries(self) -> int:
        """How many entries are inside Datum now."""
        return self._entries

    @property
    def runner(self) -> AsyncRunner | None:
        """The runner the first entry created; `None` before it and after the last exit's drain."""
        return self._runner

    @property
    def entered_once(self) -> bool:
        """Whether any entry ever started Datum (a request before that is a composition error)."""
        return self._entered_once

    def _entry_lock(self) -> asyncio.Lock:
        # An asyncio primitive belongs to one loop; a later lifespan may run on another (each TestClient has its own).
        loop = asyncio.get_running_loop()
        if self._entries > 0 and self._loop is not None and self._loop is not loop:
            raise RuntimeError(
                f"Datum serves one event loop at a time: it is still entered ({self._entries} open) from another"
                " event loop; leave it there before entering from this one"
            )
        if self._lock is None or self._loop is not loop:
            self._loop, self._lock = loop, asyncio.Lock()
        return self._lock

    async def enter(self) -> None:
        """Count one entry; the first starts Datum and creates the runner, and a failed start counts nothing."""
        async with self._entry_lock():
            if self._entries == 0:
                await self._start()
            self._entries += 1

    async def exit(self) -> None:
        """Count one exit; the last drains the runner within the grace and stops Datum (never cut short)."""
        async with self._entry_lock():
            if self._entries == 0:
                return
            self._entries -= 1
            if self._entries > 0:
                return
            stop = asyncio.ensure_future(self._stop())
            try:
                await asyncio.shield(stop)
            except BaseException:
                await asyncio.wait({stop})  # a native cancel ends the wait, not the drain and the stop
                raise

    async def _start(self) -> None:
        datum = self._datum
        start = asyncio.ensure_future(anyio.to_thread.run_sync(functools.partial(datum.start, awaiter=anyio_awaiter)))
        budget = datum.config.runtime.startup_budget.total_seconds()
        try:
            done, _ = await asyncio.wait({start}, timeout=budget)  # a wait that neither cancels nor shields the start
            if done:
                start.result()
        except BaseException:
            # A native cancel ends the wait, not the start: let the thread finish, then undo what it built.
            await asyncio.wait({start})
            if not start.cancelled() and start.exception() is None and datum.started:
                await anyio.to_thread.run_sync(datum.stop)
            raise
        if not done:
            # A synchronous compile cannot be cut short from outside; the worker meets the budget at its next phase
            # boundary and undoes its own start (`Datum.start`). The process is expected to exit on this error.
            start.add_done_callback(_abandoned(datum))
            raise datum.startup_budget_error()
        limits = datum.limits
        runtime = datum.config.runtime
        self._runner = AsyncRunner(
            worker_threads=worker_threads_for(limits.validation_slots() + limits.pdf_slots(), runtime.worker_threads),
            wait=limits.validation_wait,
            shutdown_grace=runtime.shutdown_grace.total_seconds(),
        )
        self._entered_once = True

    async def _stop(self) -> None:
        # The stop after the drain closes the runtime, which interrupts every run still in flight at once (they end
        # INTERRUPTED and their callers get 503 server.unavailable): the interrupt at the grace's expiry is that stop.
        # One deadline for the whole stop: what the drain leaves of the grace is the failed-run capture's to finish in.
        deadline = time.monotonic() + self._datum.config.runtime.shutdown_grace.total_seconds()
        runner = self._runner
        try:
            if runner is not None:
                drained = await runner.drain()
                if drained.abandoned:
                    logger.warning(
                        "%d Datum call(s) still ran when datum.runtime.shutdown_grace (%s s) expired; the runtime"
                        " interrupts them now (503 server.unavailable)",
                        drained.abandoned,
                        f"{self._datum.config.runtime.shutdown_grace.total_seconds():g}",
                    )
        finally:
            self._runner = None
            await anyio.to_thread.run_sync(functools.partial(self._datum.stop, deadline=deadline))
