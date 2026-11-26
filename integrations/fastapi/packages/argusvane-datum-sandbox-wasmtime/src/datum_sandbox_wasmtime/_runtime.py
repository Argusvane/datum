"""`WasmtimeGuestRuntime`: the pinned QuickJS on wasmtime.

It is a `GuestEngine` under argusvane-datum-sandbox's `RunHarness` (the WASI layer, `datum_sandbox.wasi`).

The harness owns everything engine-neutral (the worker thread per run, the slots, the private run directory, the
bounded `OutputSink` streams, the stop grace, the strays); this module owns what is wasmtime's:

- at start, once: the wasmtime import (refused naming the platform), the guest bytes re-hashed, one `Engine` with
  epoch interruption on, fuel off, `memory_guard_size=0` and the reservation of `_memory`, one compiled `Module`, one
  `InstancePre` with WASI linked and its `poll_oneoff` shadowed (`_poll`: a guest's sleep is cut to its run's wall
  budget and woken by its stop), a throwaway store that turns an address-space refusal into a start-up error, and one
  epoch clock thread;
- per run, on the run's worker thread only: a `Store` with `set_limits(memory_size=<budget>, instances=1, memories=1,
  tables=1)` and an epoch deadline of `ceil(wall / tick) + 1` ticks, a `WasiConfig` with the run's argv, its stdin
  file, the read-only preopen of its `app/` as `/app` and the two sinks as custom outputs, all closed by the run's
  `ExitStack`, never by a finalizer, before the harness removes the directory;
- the shadow stack guard (`_stack`): a canary over the stack's floor before `_start`, and after it the canary and the
  module's `.rodata` compared, so a run whose C stack overran its statics is a trap whatever it printed;
- the reading of how `_start` ended: a stack overrun, then `ExitTrap` (exit code), then `Trap` by `trap_code`
  (`INTERRUPT` is the budget), then `WasmtimeError`; the cap flags are read after, by the harness;
- shutdown: the harness marks every run in flight as interrupted, the clock advances the epoch past every deadline,
  the runs end within the grace, the clock thread stops.

One harness per pool, one `run`: a budget's `pool` picks the harness (`EngineLimits.pools`: the validation and the PDF
pools of a Datum host). The engine's memory reservation follows `EngineLimits.memory_bytes` and `max_memory_bytes`; a
run whose budget is above both together is still limited to its budget, but its store is moved to a new reservation as
it grows (logged once per process).

The output callbacks are the sinks' own `write`: they keep bytes up to the cap, then set the flag and discard,
return the full count, never raise and never touch a store (wasmtime calls them on its own threads while the worker is
parked in the guest's `fd_write`). No lock is held across a run.
"""

import functools
import gc
import logging
import os
import threading
import time
from collections.abc import Callable
from contextlib import ExitStack
from dataclasses import dataclass
from importlib import metadata
from pathlib import Path
from typing import Final

from datum_sandbox.wasi import (
    LOGGER_NAME,
    EngineConfigurationError,
    EngineInfo,
    EngineLimits,
    EngineSettings,
    GuestEnd,
    GuestEndKind,
    GuestIo,
    GuestRun,
    HarnessStats,
    MemoryFloorError,
    RunBudget,
    RunHarness,
    RunResult,
)
from datum_sandbox_wasmtime._clock import EpochClock
from datum_sandbox_wasmtime._memory import (
    PAGE,
    RESERVATION_SETTING,
    growth_refusal,
    reservation,
    reservation_refusal,
)
from datum_sandbox_wasmtime._platform import load_wasmtime
from datum_sandbox_wasmtime._provider import ENGINE_ID
from datum_sandbox_wasmtime._qjs import QjsBinary, load_qjs
from datum_sandbox_wasmtime._stack import StackGuard, StackOverrunError, describe_unguarded, stack_guard

load_wasmtime()  # refuses with the platform named before the plain import below can fail with a bare OSError
import wasmtime  # noqa: E402 - after the guarded load on purpose

from datum_sandbox_wasmtime import _poll  # noqa: E402 - imports wasmtime

logger = logging.getLogger(LOGGER_NAME)

GUEST_APP: Final = "/app"
_BEYOND_RESERVATION: Final = threading.Event()
_BEYOND_RESERVATION_LOCK: Final = threading.Lock()
_PROBE_TICKS: Final = 1 << 32
DEFAULT_SWEEP_AGE: Final = 300.0 + 60.0
"""Leftover run directories older than this are swept at start: the longest budget (300 s) plus a minute."""


@dataclass(frozen=True, slots=True)
class StartupTimings:
    """What the start cost, in seconds: reading and hashing the guest, compiling it, and the throwaway store."""

    load: float
    compile: float
    probe: float


class WasmtimeInstance:
    """One instantiated guest: its store, its `_start`, its memory and the stack that closes them. One run owns it."""

    def __init__(
        self,
        store: wasmtime.Store,
        start: wasmtime.Func,
        memory: wasmtime.Memory | None,
        memory_cap: int,
        resources: ExitStack,
        *,
        guard: StackGuard | None,
        deadline: float,
        expired: Callable[[], bool],
        tick: float,
    ) -> None:
        """Keep what the run needs; nothing is started.

        `deadline` is when the wall budget ends (`time.monotonic`), `expired` says whether the store's epoch deadline
        has passed, `tick` is the clock's tick: what the `poll_oneoff` shadow reads while this guest runs. `guard` is
        the shadow stack guard, already armed in `memory` (`None`: the module runs without one).
        """
        self._store = store
        self._start = start
        self._memory = memory
        self._memory_cap = memory_cap
        self._resources = resources
        self._guard = guard if memory is not None else None
        self._stop = threading.Event()
        self._window = _poll.RunWindow(deadline, self._stop, expired, tick)

    def start(self) -> None:
        """Call `_start` on this (the owning) thread; a stop asked before it ends the guest at its first check.

        However the guest ended, a shadow stack that reached its floor raises `StackOverrunError`: a guest running
        over its own overwritten statics can still exit cleanly, throw, or loop until the epoch ends it. A memory that
        cannot be read back raises too, so the guard fails closed (a trap, by `classify`).
        """
        if self._stop.is_set():
            self._store.set_epoch_deadline(0)
        try:
            with _poll.run_window(self._window):
                self._start(self._store)
        except Exception as error:
            if self._overran():
                raise StackOverrunError from error
            raise
        if self._overran():
            raise StackOverrunError

    def _overran(self) -> bool:
        return self._guard is not None and self._memory is not None and self._guard.overran(self._store, self._memory)

    def request_stop(self) -> None:
        """Note the stop (any thread, at once, never raises) and wake a guest waiting in `poll_oneoff`.

        The store is never touched here (it belongs to the worker thread, parked in the guest call). What ends the
        guest is the epoch: its store's deadline, armed from the wall budget at instantiation, or the shutdown advance
        past every deadline; a started guest meets it at its next epoch check, a guest not yet started at its first
        (`start` sets a zero deadline when the stop came first). A guest sleeping in `poll_oneoff` wakes on this stop
        and then meets the epoch the same way.
        """
        self._stop.set()

    def classify(self, error: BaseException, /) -> GuestEnd:
        """Read how `_start` ended: a stack overrun, `ExitTrap` by code, `Trap` by `trap_code`, then `WasmtimeError`."""
        if isinstance(error, StackOverrunError):
            cause = error.__cause__
            ended = "" if cause is None else f" (it ended with {type(cause).__name__}: {str(cause)[:120]})"
            return GuestEnd(GuestEndKind.TRAP, detail=f"the guest's shadow stack reached its floor{ended}")
        if isinstance(error, wasmtime.ExitTrap):
            if error.code != 0 and self._limit_reached():
                return GuestEnd(GuestEndKind.MEMORY, detail=f"exit {error.code} at the memory limit")
            return GuestEnd(GuestEndKind.EXIT, exit_code=error.code, detail=f"exit {error.code}")
        if isinstance(error, wasmtime.Trap):
            return self._trap_end(error.trap_code)
        if isinstance(error, wasmtime.WasmtimeError):
            return GuestEnd(GuestEndKind.TRAP, detail=f"wasmtime error: {str(error)[:200]}")
        return GuestEnd(GuestEndKind.TRAP, detail=f"host error: {type(error).__name__}")

    def _trap_end(self, code: wasmtime.TrapCode | None) -> GuestEnd:
        """Read a trap by its code: `INTERRUPT` is the epoch deadline; any other is a trap, or memory at the limit."""
        if code == wasmtime.TrapCode.INTERRUPT:
            return GuestEnd(GuestEndKind.INTERRUPT, detail="epoch deadline")
        if self._limit_reached():
            return GuestEnd(GuestEndKind.MEMORY, detail=f"trap {code} at the memory limit")
        return GuestEnd(GuestEndKind.TRAP, detail=f"trap {code}")

    def close(self) -> None:
        """Close the store and its `WasiConfig` (the run's stack), on the worker thread, before the directory goes."""
        self._resources.close()
        if os.name == "nt":
            # Windows keeps a preopened directory's handle until the store is collected (wasmtime-py issue #132).
            gc.collect()

    def _limit_reached(self) -> bool:
        """Whether the guest's memory ended at the store's limit: the one observable sign the limit refused a grow."""
        if self._memory is None:
            return False
        try:
            size = self._memory.data_len(self._store)
        except (wasmtime.WasmtimeError, ValueError):
            return False
        return size >= (self._memory_cap // PAGE) * PAGE


class WasmtimeGuestRuntime:
    """A `GuestRuntime` on wasmtime: one run pool per named pool over one compiled guest, one epoch clock, one stop.

    `run` takes a slot in the pool its budget names (`RunBudget.pool`, one of `EngineLimits.pools`); every pool runs on
    the same engine and module. The engine's memory reservation follows `EngineLimits.memory_bytes` and
    `max_memory_bytes`. Construction compiles the guest (about a second, several on a
    small VM): call it off the event loop and report the runtime as down until it returns.
    """

    def __init__(
        self,
        limits: EngineLimits,
        settings: EngineSettings | None = None,
        *,
        qjs_path: Path | None = None,
        qjs_sha256: str | None = None,
        sweep_older_than: float | None = DEFAULT_SWEEP_AGE,
    ) -> None:
        """Verify and compile the guest, check the reservation with a throwaway store, start the clock and pools."""
        self._settings = settings or EngineSettings()
        began = time.perf_counter()
        # The location the application gave this class wins; else the one the limits carry (datum.runtime.qjs_*).
        located = (qjs_path, qjs_sha256) if qjs_path is not None else (limits.module_path, limits.module_sha256)
        qjs = load_qjs(*located)
        loaded = time.perf_counter()
        reserved, growth = reservation(limits.memory_bytes, limits.max_memory_bytes)
        self._room = reserved + growth
        config = wasmtime.Config()
        config.epoch_interruption = True
        config.consume_fuel = False  # the default, stated: fuel costs 15 to 24% per run; the epoch is the stop
        config.memory_guard_size = 0
        config.memory_reservation = reserved
        config.memory_reservation_for_growth = growth
        self._engine = wasmtime.Engine(config)
        self._module = wasmtime.Module(self._engine, qjs.data)
        compiled = time.perf_counter()
        self._guard = stack_guard(qjs.data)
        linker = wasmtime.Linker(self._engine)
        linker.define_wasi()
        linker.allow_shadowing = True
        linker.define_func(
            _poll.WASI_MODULE, _poll.NAME, _poll.poll_oneoff_type(), _poll.poll_oneoff, access_caller=True
        )
        linker.allow_shadowing = False
        self._pre = linker.instantiate_pre(self._module)
        self._floor = _memory_floor(self._module)
        self._exports_memory = "memory" in {export.name for export in self._module.exports}
        if reserved < self._floor:
            raise MemoryFloorError(RESERVATION_SETTING, reserved, self._floor)
        self._probe_reservation(reserved, growth)
        probed = time.perf_counter()
        self.timings = StartupTimings(load=loaded - began, compile=compiled - loaded, probe=probed - compiled)
        self._info = _engine_info(self._engine, qjs, reserved, growth, limits.tick_seconds, guard=self._guard)
        limits.work_dir.mkdir(parents=True, exist_ok=True)
        self._pools = {
            name: RunHarness(self, slots=slots, work_dir=limits.work_dir, settings=self._settings)
            for name, slots in limits.pools.items()
        }
        self._close_lock = threading.Lock()
        self._closed = False
        # The clock thread starts last, so a refusal above leaves no thread behind.
        self._clock = EpochClock(self._engine, limits.tick_seconds)
        if sweep_older_than is not None:
            swept = self._first_pool().sweep(sweep_older_than)
            if swept:
                logger.info("swept %d leftover run directories from %s", swept, limits.work_dir)

    # -- GuestRuntime ----------------------------------------------------------------------------------------------

    def run(self, run: GuestRun, /) -> RunResult:
        """Run a guest in a slot of the pool its budget names; an unknown pool is refused with `ValueError`."""
        harness = self._pools.get(run.budget.pool)
        if harness is None:
            known = ", ".join(sorted(self._pools))
            raise ValueError(f"the run names the pool {run.budget.pool!r}, which this runtime has not ({known})")
        return harness.run(run)

    @property
    def pools(self) -> frozenset[str]:
        """The pools this runtime serves: the names of `EngineLimits.pools`."""
        return frozenset(str(name) for name in self._pools)

    def _first_pool(self) -> RunHarness:
        return next(iter(self._pools.values()))

    def engine_info(self) -> EngineInfo:
        """Describe the engine: id, wasmtime release, compilation mode, notes."""
        return self._info

    def close(self) -> None:
        """Stop every run in flight as INTERRUPTED within the stop grace, refuse new runs, stop the clock (once)."""
        with self._close_lock:
            if self._closed:
                return
            self._closed = True
        harnesses = tuple(self._pools.values())
        for harness in harnesses:
            harness.interrupt()
        self._clock.advance_past_every_deadline()
        deadline = time.monotonic() + self._settings.stop_grace
        alive = sum(harness.close(max(0.0, deadline - time.monotonic())) for harness in harnesses)
        self._clock.close()
        if alive:
            logger.error("%d run worker(s) did not stop within the stop grace at shutdown", alive)

    # -- what the binding reads ---------------------------------------------------------------------------------------

    @property
    def clock(self) -> EpochClock:
        """The runtime's epoch clock (health reads whether it runs and how many stores are armed)."""
        return self._clock

    @property
    def memory_floor(self) -> int:
        """The least memory a run can have: the module's initial pages times 64 KiB (`datum.E003` below it)."""
        return self._floor

    def stats(self) -> dict[str, HarnessStats]:
        """Return each pool's counters for health, by pool name."""
        return {str(name): harness.stats() for name, harness in self._pools.items()}

    def sweep(self, older_than: float) -> int:
        """Remove leftover run directories older than `older_than` seconds from the work directory."""
        return self._first_pool().sweep(older_than)

    # -- GuestEngine ------------------------------------------------------------------------------------------------

    def instantiate(self, io: GuestIo, budget: RunBudget, /) -> WasmtimeInstance:
        """Make the run's store and WASI context and instantiate the guest, on the run's worker thread."""
        if budget.memory_bytes < self._floor:
            raise MemoryFloorError("the run's memory budget", budget.memory_bytes, self._floor)
        if budget.memory_bytes > self._room:
            _warn_beyond_reservation(budget.memory_bytes, self._room)
        resources = ExitStack()
        try:
            store = wasmtime.Store(self._engine)
            resources.callback(store.close)
            store.set_limits(memory_size=budget.memory_bytes, instances=1, memories=1, tables=1)
            deadline = time.monotonic() + budget.wall_seconds
            token = self._clock.arm(store, budget.wall_seconds)
            resources.callback(self._clock.disarm, token)
            wasi = wasmtime.WasiConfig()
            # Closes only a config that never reached `set_wasi` (set-up failed first): `set_wasi` consumes it.
            resources.callback(wasi.close)
            wasi.argv = list(io.argv)
            wasi.stdin_file = io.stdin_path
            wasi.stdout_custom = io.stdout.write
            wasi.stderr_custom = io.stderr.write
            wasi.preopen_dir(str(io.app_dir), GUEST_APP, fs_mutable=False)
            store.set_wasi(wasi)
            exports = self._pre.instantiate(store).exports(store)
            start = exports["_start"]
            memory = exports["memory"] if self._exports_memory else None
            if self._guard is not None and isinstance(memory, wasmtime.Memory):
                self._guard.arm(store, memory)
        except BaseException:
            resources.close()
            raise
        if not isinstance(start, wasmtime.Func):
            resources.close()
            raise EngineConfigurationError("the guest module exports no _start function")
        return WasmtimeInstance(
            store,
            start,
            memory if isinstance(memory, wasmtime.Memory) else None,
            budget.memory_bytes,
            resources,
            guard=self._guard,
            deadline=deadline,
            expired=functools.partial(self._clock.expired, token),
            tick=self._clock.tick,
        )

    # -- start ------------------------------------------------------------------------------------------------------

    def _probe_reservation(self, reserved: int, growth: int) -> None:
        """Instantiate one throwaway store, so an address-space refusal stops the start instead of the first run.

        With a growth reservation the store is also grown to `reserved + growth` bytes (address space only, nothing
        touched): a PDF run reserves that much when it first grows past the validation cap, so a limit that admits
        the start but not that grow is refused here, naming the PDF setting, not by every PDF run later.
        """
        with ExitStack() as stack:
            store = wasmtime.Store(self._engine)
            stack.callback(store.close)
            store.set_limits(memory_size=reserved + growth, instances=1, memories=1, tables=1)
            store.set_epoch_deadline(_PROBE_TICKS)  # the clock has not started: no tick can reach it
            wasi = wasmtime.WasiConfig()
            stack.callback(wasi.close)
            store.set_wasi(wasi)
            try:
                instance = self._pre.instantiate(store)
            except wasmtime.WasmtimeError as error:
                refusal = reservation_refusal(str(error), reserved)
                if refusal is not None:
                    raise refusal from error
                raise EngineConfigurationError(
                    f"the wasmtime runtime could not instantiate the guest module at start: {error}",
                    hint="check the guest module (datum.runtime.qjs_path) and the memory settings",
                ) from error
            if growth > 0 and self._exports_memory:
                memory = instance.exports(store)["memory"]
                if isinstance(memory, wasmtime.Memory):
                    try:
                        memory.grow(store, (reserved + growth) // PAGE - memory.size(store))
                    except wasmtime.WasmtimeError as error:
                        raise growth_refusal(str(error), reserved + growth) from error


def _warn_beyond_reservation(asked: int, room: int) -> None:
    """Log, once per process, that a run's memory budget is above the reservation plus its growth room."""
    with _BEYOND_RESERVATION_LOCK:
        if _BEYOND_RESERVATION.is_set():
            return
        _BEYOND_RESERVATION.set()
    logger.warning(
        "a run's memory budget (%d bytes) is above the engine's reservation plus growth (%d bytes, from "
        "datum.runtime.validation.memory and datum.runtime.pdf.memory): the run is still limited to its budget, but "
        "its store is moved to a new address-space reservation as it grows, which the sizing in the documentation "
        "does not cover; raise datum.runtime.pdf.memory to the largest budget (logged once per process)",
        asked,
        room,
    )


def _memory_floor(module: wasmtime.Module) -> int:
    """Return the module's exported memory's initial pages times 64 KiB (0 when it exports none)."""
    for export in module.exports:
        kind = export.type
        if isinstance(kind, wasmtime.MemoryType):
            return int(kind.limits.min) * PAGE
    return 0


def _engine_info(
    engine: wasmtime.Engine, qjs: QjsBinary, reserved: int, growth: int, tick: float, *, guard: StackGuard | None
) -> EngineInfo:
    mode = "pulley" if engine.is_pulley() else "cranelift"
    return EngineInfo(
        id=ENGINE_ID,
        release=metadata.version("wasmtime"),
        mode=mode,
        notes=(
            f"guest: QuickJS-ng {qjs.version} qjs-wasi.wasm sha256 {qjs.sha256} ({qjs.source})",
            f"epoch interruption every {tick * 1000:g} ms; fuel off; WASI poll_oneoff cut to the run's wall budget",
            f"memory: reservation {reserved} bytes, growth {growth} bytes, guard 0",
            guard.describe() if guard is not None else describe_unguarded(),
        ),
    )
