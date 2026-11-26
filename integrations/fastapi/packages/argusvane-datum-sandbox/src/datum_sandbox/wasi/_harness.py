"""`RunHarness`: one worker thread per run over a `GuestEngine`, on `threading` only (never an anyio primitive)."""

import contextlib
import logging
import os
import shutil
import stat
import tempfile
import threading
import time
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import NoReturn

from datum_sandbox.wasi._protocols import GuestEngine, GuestInstance, GuestIo
from datum_sandbox.wasi._records import (
    LOGGER_NAME,
    EngineSettings,
    GuestEndKind,
    GuestRun,
    RunEnd,
    RunResult,
    RunTimings,
)
from datum_sandbox.wasi._streams import OutputSink

logger = logging.getLogger(LOGGER_NAME)

RUN_DIR_PREFIX = "datum-run-"
_REMOVE_ATTEMPTS = 4
_REMOVE_PAUSE = 0.05


class EngineBusyError(RuntimeError):
    """A run was refused because no slot came within its wait: `reason` is `"slots"`."""

    def __init__(self, reason: str) -> None:
        """Name the reason."""
        super().__init__(f"the engine is busy ({reason})")
        self.reason = reason


class EngineStrayBoundError(RuntimeError):
    """A run was refused because the stray bound is reached: `strays` runs that would not stop are still alive.

    Not an `EngineBusyError`: waiting for a slot cannot help while guests the engine asked to stop keep running, so the
    layer above answers it as a runtime that is unavailable, never as a busy one.
    """

    def __init__(self, strays: int, bound: int) -> None:
        """Keep the count of strays and the bound."""
        super().__init__(
            f"the engine refuses new runs: {strays} runs that would not stop are still alive (bound {bound})"
        )
        self.strays = strays
        self.bound = bound


class EngineClosedError(RuntimeError):
    """A run was asked of a harness that has been closed."""


@dataclass(frozen=True, slots=True)
class HarnessStats:
    """A snapshot for health: slots, runs in flight, runs given up on, and worker threads still alive past their run."""

    slots: int
    slots_in_use: int
    runs_in_flight: int
    stuck_runs: int
    stray_runs: int


class _Run:
    """The state one run shares between its caller and its worker thread."""

    def __init__(self, stdout: OutputSink, stderr: OutputSink) -> None:
        self.stdout = stdout
        self.stderr = stderr
        self.done = threading.Event()
        self.instance: GuestInstance | None = None
        self.stop_requested = False
        self.interrupted = False
        self.abandoned = False
        self.finished = False
        self.end: RunEnd = RunEnd.CLEAN
        self.exit_code: int | None = None
        self.detail = ""
        self.error: BaseException | None = None
        self.prepare = 0.0
        self.instantiate = 0.0
        self.start = 0.0


class RunHarness:
    """Run programs one per worker thread over a `GuestEngine`.

    A run takes a slot (`threading.BoundedSemaphore.acquire(timeout=wait)`), writes the run's `app_files` into a
    private 0700 directory under `work_dir` (made read-only before the engine sees it), hands the engine that
    application directory and bounded streams, and waits for the worker for the wall budget. Then it asks the guest to
    stop and waits `stop_grace` more. A worker that still has not ended is a stray: the caller is answered
    `RunEnd.STUCK` at once, the worker keeps its slot until it really ends (so the engine never runs more than `slots`
    guests), and new runs are refused with `EngineStrayBoundError` (never `EngineBusyError`) while the strays are at the
    bound. The slot is released exactly once, by the worker's `finally` (or by the caller when no worker could start).
    `interrupt` is the shutdown stop: it refuses new runs and stops every run in flight, and a run its stop ends reads
    `RunEnd.INTERRUPTED`. A harness is one pool: a runtime keeps one per `PoolKind` and hands each run to the harness
    its `budget.pool` names; the harness runs whatever budget it is given.
    """

    def __init__(
        self,
        engine: GuestEngine,
        *,
        slots: int,
        work_dir: Path,
        settings: EngineSettings | None = None,
        on_busy: Callable[[str], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        entropy: Callable[[int], bytes] = os.urandom,
    ) -> None:
        """Create a harness with `slots` concurrent runs; `on_busy(reason)` is told of every busy refusal (`"slots"`).

        A run refused at the stray bound is not busy and is not told to `on_busy`.
        """
        if slots < 1:
            raise ValueError("a harness needs at least one slot")
        self._engine = engine
        self._slots_total = slots
        self._slots = threading.BoundedSemaphore(slots)
        self._work_dir = work_dir
        self._settings = settings or EngineSettings()
        self._on_busy = on_busy
        self._clock = clock
        self._entropy = entropy
        self._lock = threading.Lock()
        self._in_flight = 0
        self._slots_in_use = 0
        self._stuck = 0
        self._strays = 0
        self._closed = False
        self._threads: set[threading.Thread] = set()
        self._runs: set[_Run] = set()

    # -- public ----------------------------------------------------------------------------------------------------

    def run(self, job: GuestRun, /) -> RunResult:
        """Run one guest; raise a refusal of the admission or whatever the engine raises while instantiating.

        The refusals: `EngineBusyError` when no slot came within the wait, `EngineStrayBoundError` while the strays are
        at the bound, `EngineClosedError` once the harness is closed.

        The `GuestRun` has already refused a bare string for `argv` and every file name that is not one plain name.
        A timed run (`job.timed`) answers its `RunTimings`; any other is not measured.
        """
        if not isinstance(job, GuestRun):  # pyright: ignore[reportUnnecessaryIsInstance] - untyped callers
            raise TypeError(f"a harness runs a GuestRun, not {type(job).__name__}")
        budget = job.budget
        run = _Run(OutputSink(budget.stdout_cap), OutputSink(budget.stderr_cap))
        asked = time.perf_counter() if job.timed else 0.0
        self._admit(budget.wait, run)
        waited = time.perf_counter() - asked if job.timed else 0.0
        started = self._clock()
        thread = threading.Thread(
            target=self._work,
            args=(run, job),
            name="datum-run",
            daemon=True,
        )
        with self._lock:
            self._threads.add(thread)
        try:
            thread.start()
        except BaseException:
            with self._lock:
                self._threads.discard(thread)
                self._runs.discard(run)
            self._release()
            raise
        # From here the worker owns the slot and releases it.
        if not run.done.wait(budget.wall_seconds):
            self._request_stop(run)
            if not run.done.wait(self._settings.stop_grace):
                self._abandon(run)
        return self._result(run, self._clock() - started, waited if job.timed else None)

    def stats(self) -> HarnessStats:
        """Return a consistent snapshot of the counters."""
        with self._lock:
            return HarnessStats(
                slots=self._slots_total,
                slots_in_use=self._slots_in_use,
                runs_in_flight=self._in_flight,
                stuck_runs=self._stuck,
                stray_runs=self._strays,
            )

    def sweep(self, older_than: float) -> int:
        """Remove run directories under the work directory older than `older_than` seconds; return how many."""
        removed = 0
        cutoff = time.time() - older_than
        try:
            entries = list(self._work_dir.iterdir())
        except OSError:
            return 0
        for entry in entries:
            if not entry.name.startswith(RUN_DIR_PREFIX):
                continue
            try:
                st = entry.lstat()
                if not stat.S_ISDIR(st.st_mode):
                    continue
                if hasattr(os, "getuid") and st.st_uid != os.getuid():
                    continue
                if st.st_mtime < cutoff and _remove_tree(entry):
                    removed += 1
            except OSError:
                logger.warning("could not sweep %s", entry.name)
        return removed

    def interrupt(self) -> int:
        """Refuse new runs, mark every run in flight as interrupted and ask its guest to stop; return how many.

        This is the shutdown stop. A marked run that its guest's stop ends reads `RunEnd.INTERRUPTED`; one that ends
        by itself first keeps its own end, and one that does not stop within the grace is STUCK as always. A run still
        in set-up is marked too: its stop is forwarded as soon as its instance exists. The engine's own stop for
        every guest at once (for wasmtime, the epoch advanced past every deadline) belongs after this call.
        """
        with self._lock:
            self._closed = True
            runs = [run for run in self._runs if not run.finished]
            for run in runs:
                run.interrupted = True
        for run in runs:
            self._request_stop(run)
        return len(runs)

    def close(self, timeout: float = 0.0) -> int:
        """Refuse new runs and wait up to `timeout` seconds for live workers; return how many are still alive."""
        with self._lock:
            self._closed = True
            threads = list(self._threads)
        deadline = self._clock() + timeout
        for thread in threads:
            thread.join(max(0.0, deadline - self._clock()))
        return sum(1 for thread in threads if thread.is_alive())

    # -- admission and accounting ------------------------------------------------------------------------------------

    def _admit(self, wait: float, run: _Run) -> None:
        with self._lock:
            closed = self._is_closed()
            strays = self._strays
        if closed:
            raise EngineClosedError("the run harness is closed")
        if strays >= self._settings.stray_bound:
            # Not busy: no wait frees a slot while guests asked to stop keep running, so `on_busy` is not told.
            raise EngineStrayBoundError(strays, self._settings.stray_bound)
        if not self._slots.acquire(timeout=max(0.0, wait)):
            self._busy("slots")
        with self._lock:
            closed = self._is_closed()
            if not closed:
                self._in_flight += 1
                self._slots_in_use += 1
                # Registered under the same lock as the closed check, so `interrupt` sees every admitted run.
                self._runs.add(run)
        if closed:
            self._slots.release()
            raise EngineClosedError("the run harness is closed")

    def _is_closed(self) -> bool:
        return self._closed

    def _busy(self, reason: str) -> NoReturn:
        if self._on_busy is not None:
            with contextlib.suppress(Exception):
                self._on_busy(reason)
        raise EngineBusyError(reason)

    def _release(self) -> None:
        """Give the slot back: the one place it happens, called once per admitted run."""
        with self._lock:
            self._in_flight -= 1
            self._slots_in_use -= 1
        self._slots.release()

    def _request_stop(self, run: _Run) -> None:
        with self._lock:
            run.stop_requested = True
            instance = run.instance
        if instance is not None:
            with contextlib.suppress(Exception):
                instance.request_stop()

    def _abandon(self, run: _Run) -> None:
        """Give up waiting: count the worker as a stray until it really ends."""
        with self._lock:
            if run.finished:
                return
            run.abandoned = True
            self._stuck += 1
            self._strays += 1
        logger.error("a run did not end within its budget and the stop grace; its worker thread is a stray")

    # -- the worker ------------------------------------------------------------------------------------------------

    def _work(self, run: _Run, job: GuestRun) -> None:
        run_dir: Path | None = None
        instance: GuestInstance | None = None
        timed = job.timed
        try:
            began = time.perf_counter() if timed else 0.0
            run_dir = Path(tempfile.mkdtemp(prefix=RUN_DIR_PREFIX, dir=self._work_dir))
            run_dir.chmod(0o700)
            app_dir = run_dir / "app"
            app_dir.mkdir(mode=0o700)
            for name, data in job.app_files.items():
                _write_private(app_dir / name, data)
            _write_private(run_dir / "stdin", job.stdin)
            app_dir.chmod(0o500)
            io = GuestIo(
                app_dir=app_dir,
                stdin_path=run_dir / "stdin",
                stdout=run.stdout,
                stderr=run.stderr,
                argv=tuple(job.argv),
                entropy=self._entropy,
            )
            if timed:
                prepared = time.perf_counter()
                run.prepare = prepared - began
            instance = self._engine.instantiate(io, job.budget)
            if timed:
                instantiated = time.perf_counter()
                run.instantiate = instantiated - prepared
            with self._lock:
                run.instance = instance
                stop_already = run.stop_requested
            if stop_already:
                instance.request_stop()
            self._start(run, instance)
            if timed:
                run.start = time.perf_counter() - instantiated
        except BaseException as error:
            run.error = error
        finally:
            self._finish(run, instance, run_dir)

    def _start(self, run: _Run, instance: GuestInstance) -> None:
        try:
            instance.start()
        except BaseException as error:
            end = instance.classify(error)
            run.detail = end.detail
            run.exit_code = end.exit_code
            run.end = _END_OF[end.kind]
            if end.kind is GuestEndKind.EXIT and end.exit_code == 0:
                run.end = RunEnd.CLEAN
            if end.kind is GuestEndKind.INTERRUPT:
                with self._lock:
                    interrupted = run.interrupted
                if interrupted:
                    run.end = RunEnd.INTERRUPTED
        else:
            run.end = RunEnd.CLEAN

    def _finish(self, run: _Run, instance: GuestInstance | None, run_dir: Path | None) -> None:
        try:
            try:
                if instance is not None:
                    try:
                        instance.close()
                    except Exception:
                        logger.exception("closing a guest instance failed")
            finally:
                if run_dir is not None:
                    _remove_tree(run_dir)
        finally:
            with self._lock:
                run.finished = True
                if run.abandoned:
                    self._strays -= 1
                self._threads.discard(threading.current_thread())
                self._runs.discard(run)
            self._release()
            run.done.set()

    # -- the answer ------------------------------------------------------------------------------------------------

    def _result(self, run: _Run, elapsed: float, waited: float | None) -> RunResult:
        with self._lock:
            abandoned = run.abandoned
        if run.error is not None and not abandoned:
            raise run.error
        stdout_capped = run.stdout.capped
        stderr_capped = run.stderr.capped
        end = run.end
        if abandoned:
            end = RunEnd.STUCK
        elif stdout_capped or stderr_capped:
            end = RunEnd.OUTPUT_CAP
        return RunResult(
            end=end,
            stdout=run.stdout.value(),
            stderr=run.stderr.value(),
            exit_code=run.exit_code,
            stdout_capped=stdout_capped,
            stderr_capped=stderr_capped,
            elapsed=elapsed,
            detail=run.detail,
            timings=None
            if waited is None
            else RunTimings(slot_wait=waited, prepare=run.prepare, instantiate=run.instantiate, start=run.start),
        )


_END_OF: dict[GuestEndKind, RunEnd] = {
    GuestEndKind.EXIT: RunEnd.EXIT,
    GuestEndKind.TRAP: RunEnd.TRAP,
    GuestEndKind.INTERRUPT: RunEnd.BUDGET,
    GuestEndKind.MEMORY: RunEnd.MEMORY,
}


def _write_private(path: Path, data: bytes) -> None:
    """Write `data` to a new file readable by the owner only, refusing an existing path and a symbolic link."""
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    fd = os.open(path, flags, 0o400)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)


def _remove_tree(path: Path) -> bool:
    """Remove a run directory, restoring write permission first and retrying (a Windows file may stay held briefly)."""
    for attempt in range(_REMOVE_ATTEMPTS):
        with contextlib.suppress(OSError):
            for sub in (path / "app", path):
                if not sub.is_symlink() and sub.is_dir():
                    sub.chmod(stat.S_IRWXU)
        try:
            shutil.rmtree(path)
        except FileNotFoundError:
            return True
        except OSError:
            if attempt + 1 < _REMOVE_ATTEMPTS:
                time.sleep(_REMOVE_PAUSE)
        else:
            return True
    logger.warning("could not remove a run directory (%s)", path.name)
    return False
