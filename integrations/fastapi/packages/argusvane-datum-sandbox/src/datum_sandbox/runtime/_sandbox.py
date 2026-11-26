"""`DatumSandbox`: the framework-free lifecycle of the two programs: build, start, status, recheck, stop.

The start, in order: the failed-run capture opened (only while `datum.runtime.diagnostics.capture.enabled`; a directory
that is not owner-only refuses the start), the engine (the application's runtime, or the one `settings.engine.id`
selects from the installed engines, built for the clamped limits and closed by `stop`), the settings report logged once
(`datum.runtime.diagnostics.report`), the sandbox service over the packaged (or overridden) program composed with the
host's seams (a replacement, the middleware outermost, the observation innermost), the ABI proof, the smoke and warm-up
runs, then, while `pdf` is on, the PDF kernel composed and proved beside it.

A configuration the start refuses (`DatumConfigurationError`: an engine that cannot be selected, a memory below the
module's floor, a capture directory that is not owner-only) stops it whatever `fail_fast` says. Any other failure stops
it with `fail_fast` (the default), or leaves it DOWN with the reason, so `sandbox` answers 503 until `recheck()` brings
it up. Either way a failed start undoes what it built: the engine is closed and no thread is left. A PDF program that
fails its proof stops the start with `fail_fast`, else leaves PDFs unavailable (the status says why) and the sandbox up.
`recheck()` re-proves a running sandbox (ABI and smoke) or builds a down one again, and is soft about the PDF program.

The engine layer's refusals are translated here, once: an `EngineConfigurationError` becomes a `DatumConfigurationError`
with the same words, a `MemoryFloorError` the `datum.E003` check. The class is synchronous (a run blocks the calling
thread; `datum_sandbox.aio` awaits it from an event loop) and a context manager (`with` starts and stops it).
"""

import contextlib
import enum
import logging
import tempfile
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import AbstractContextManager, ExitStack
from dataclasses import dataclass, field
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType, TracebackType
from typing import Final, Self
from zoneinfo import ZoneInfo

from datum_sandbox.checks import DatumConfigurationError, memory_below_floor, startup_over_budget
from datum_sandbox.diagnostics import (
    DirectoryCaptureSink,
    FailedRunCapture,
    ProgramFacts,
    RunCaptureSink,
    RunDiagnostics,
    RunTrace,
    SettingsReport,
    log_trace,
    without_paths,
)
from datum_sandbox.loggers import RUNTIME, SETTINGS
from datum_sandbox.protocol import (
    AbiProbe,
    HostOptions,
    PdfKernel,
    PdfKernelMiddleware,
    PdfKernelService,
    PoolKind,
    Program,
    ProgramUnavailableError,
    RunLog,
    Sandbox,
    SandboxError,
    SandboxMiddleware,
    SandboxService,
    compose_pdf_kernel,
    compose_sandbox,
    declared_abis,
    freeze_snippet,
    pdf_program,
    sandbox_program,
)
from datum_sandbox.runtime._settings import SandboxSettings, TraceMode
from datum_sandbox.wasi import (
    EngineConfigurationError,
    EngineInfo,
    EngineSettings,
    GuestRuntime,
    GuestRuntimes,
    HarnessStats,
    MemoryFloorError,
    served_pools,
)

logger = logging.getLogger(RUNTIME)
_settings_logger = logging.getLogger(SETTINGS)

_NOT_RUNNING: Final = "The Datum runtime is not running."


class SandboxState(enum.StrEnum):
    """Where the sandbox is in its life."""

    NEW = "new"
    STARTING = "starting"
    READY = "ready"
    DOWN = "down"
    """Started, but the runtime could not be brought up (or a recheck took it down): runs answer 503."""
    FAILED = "failed"
    """The start raised; nothing is left running."""
    STOPPED = "stopped"


@dataclass(frozen=True, slots=True)
class SandboxStatus:
    """The sandbox's state, why it is not up, and the details a health check shows (no web type: a binding adapts)."""

    state: SandboxState
    reason: str | None = None
    details: Mapping[str, object] = field(default_factory=lambda: MappingProxyType({}))

    @property
    def is_up(self) -> bool:
        """Whether the sandbox answers runs."""
        return self.state is SandboxState.READY


@dataclass(frozen=True, slots=True)
class SandboxReady:
    """What a start (or a recheck that rebuilt the runtime) hands `on_ready`: the engine, the ABIs, the warm-up time."""

    engine: EngineInfo
    sandbox_abi: str
    pdf_abi: str
    warm_up_millis: float


type PhaseTimer = Callable[[str], AbstractContextManager[None]]
"""Measures one start phase (`runtime`, `ABI proof and warm-up runs`); a host's timer may refuse at the boundary."""


def translated(error: EngineConfigurationError) -> DatumConfigurationError:
    """Return the host refusal of an engine layer refusal: the same words; a memory floor as its `datum.E003` check."""
    if isinstance(error, MemoryFloorError):
        return DatumConfigurationError.from_checks(
            [memory_below_floor(error.setting, error.memory_bytes, error.floor_bytes)]
        )
    return DatumConfigurationError(error.message, hint=error.hint)


def can_run_pdf(runtime: GuestRuntime | None) -> bool:
    """Whether the PDF program may run on `runtime`: there is one, it serves the PDF pool, its report answers.

    It fails closed: an `engine_info()` that raises or answers something else cannot vouch for the engine, and a runtime
    that names its pools without the PDF pool (a validation-only engine) never runs the PDF program. A runtime that does
    not name its pools serves every pool.
    """
    if runtime is None:
        return False
    pools = served_pools(runtime)
    if pools is not None and PoolKind.PDF.value not in pools:
        return False
    try:
        info: object = runtime.engine_info()
    except Exception:
        return False
    return isinstance(info, EngineInfo)


def harness_details(runtime: GuestRuntime | None) -> dict[str, object]:
    """Sum the slot counters of a runtime that reports them (`stats()`), as the `runtime` health component's details."""
    stats = getattr(runtime, "stats", None)
    if not callable(stats):
        return {}
    answer: object = stats()
    if isinstance(answer, HarnessStats):
        pools = [answer]
    elif isinstance(answer, Mapping):
        pools = [item for item in answer.values() if isinstance(item, HarnessStats)]  # pyright: ignore[reportUnknownVariableType]
    else:
        return {}
    return {
        "slots": sum(pool.slots for pool in pools),
        "slotsInUse": sum(pool.slots_in_use for pool in pools),
        "runsInFlight": sum(pool.runs_in_flight for pool in pools),
        "stuckRuns": sum(pool.stuck_runs for pool in pools),
        "strayRuns": sum(pool.stray_runs for pool in pools),
    }


def _utc_now() -> datetime:
    return datetime.now(UTC)


class DatumSandbox:
    """The two programs' lifecycle over one engine: `start`, `sandbox`, `pdf_kernel`, `status`, `recheck`, `stop`.

    Every input is keyword-only and optional: `settings` (the defaults when `None`), `runtime` (the application's own
    `GuestRuntime`, closed by `stop` as one the sandbox built is), `sandbox` (a replacement `Sandbox`, composed with the
    seams like Datum's own), `engine_settings` (replaces the stop grace and stray bound of the settings), `run_log`, the
    middleware and observation seams of both programs, `pdf` (whether the PDF kernel is composed and proved), `now`
    (the clock `today` is read from), `trace` (where trace records go; `log_trace` by default) and `capture_sink` (where
    failed-run captures go; the owner-only directory of the settings by default), `on_ready` (told of each ready
    start), the two ABI `probe`s (a host that restarts keeps its proofs), `unobserved` (a context the start's own proof
    and warm-up runs are made in, so a host's observation can leave them out) and `discover` (the engine listing).
    """

    def __init__(
        self,
        settings: SandboxSettings | None = None,
        *,
        runtime: GuestRuntime | None = None,
        sandbox: Sandbox | None = None,
        engine_settings: EngineSettings | None = None,
        run_log: RunLog | None = None,
        sandbox_middleware: Sequence[SandboxMiddleware] = (),
        observation: SandboxMiddleware | None = None,
        pdf: bool = True,
        pdf_middleware: Sequence[PdfKernelMiddleware] = (),
        pdf_observation: PdfKernelMiddleware | None = None,
        now: Callable[[], datetime] | None = None,
        trace: RunTrace | None = None,
        capture_sink: RunCaptureSink | None = None,
        on_ready: Callable[[SandboxReady], None] | None = None,
        probe: AbiProbe | None = None,
        pdf_probe: AbiProbe | None = None,
        unobserved: Callable[[], AbstractContextManager[object]] | None = None,
        discover: Callable[[], GuestRuntimes] | None = None,
    ) -> None:
        """Keep the settings and the seams; nothing starts here (`start()` does)."""
        self.settings: SandboxSettings = settings if settings is not None else SandboxSettings.defaults()
        self._given_runtime = runtime
        self._given_sandbox = sandbox
        self._engine_settings = engine_settings
        self._run_log = run_log
        self._middleware = tuple(sandbox_middleware)
        self._observation = observation
        self._pdf_on = pdf
        self._pdf_middleware = tuple(pdf_middleware)
        self._pdf_observation = pdf_observation
        self._now = now or _utc_now
        self._trace = trace
        self._capture_sink = capture_sink
        self._on_ready = on_ready
        self._probe = probe or AbiProbe()
        self._pdf_probe = pdf_probe or AbiProbe()
        self._unobserved: Callable[[], AbstractContextManager[object]] = unobserved or contextlib.nullcontext
        self._discover = discover or GuestRuntimes.discover
        self._lock = threading.RLock()
        self._state = SandboxState.NEW
        self._reason: str | None = None
        self._runtime: GuestRuntime | None = None
        self._sandbox: Sandbox | None = None
        self._pdf_kernel: PdfKernel | None = None
        self._pdf_down: str | None = None
        self._pdf_absent: str | None = None
        self._resources: ExitStack | None = None
        self._capture: FailedRunCapture | None = None
        self._last_capture: FailedRunCapture | None = None
        self._diagnostics: RunDiagnostics | None = None
        self._programs: tuple[Program, ...] = ()
        self._pdf_program: Program | None = None

    # -- state -------------------------------------------------------------------------------------------------------
    @property
    def state(self) -> SandboxState:
        """Where the sandbox is in its life."""
        return self._state

    @property
    def sandbox(self) -> Sandbox:
        """The composed sandbox; `ProgramUnavailableError` (503) while it is not up."""
        sandbox = self._sandbox
        if sandbox is None or self._state is not SandboxState.READY:
            raise ProgramUnavailableError(_NOT_RUNNING)
        return sandbox

    @property
    def pdf_kernel(self) -> PdfKernel | None:
        """The composed PDF kernel, or `None` when PDFs are unavailable or off (`pdf_unavailable` says why)."""
        return self._pdf_kernel if self._state is SandboxState.READY else None

    @property
    def pdf_down(self) -> str | None:
        """Why the PDF program failed its proof (a failure), else `None`."""
        return self._pdf_down

    @property
    def pdf_absent(self) -> str | None:
        """Why the PDF program cannot run on this engine (a choice, not a failure), else `None`."""
        return self._pdf_absent

    @property
    def runtime(self) -> GuestRuntime | None:
        """The engine in use (the application's or the selected one), once started."""
        return self._runtime

    @property
    def pdf_runnable(self) -> bool:
        """Whether the PDF program may run on the engine in use (the `pdfCapable` health detail)."""
        return can_run_pdf(self._runtime)

    @property
    def capture(self) -> FailedRunCapture | None:
        """The failed-run capture of this start, while it is on."""
        return self._capture

    def engine_info(self) -> EngineInfo:
        """Describe the engine in use; a replacement sandbox's class, or `none`, when there is no runtime."""
        runtime = self._runtime
        if runtime is not None:
            return runtime.engine_info()
        name = type(self._given_sandbox).__name__ if self._given_sandbox is not None else "none"
        return EngineInfo(id=name, release="", mode="unknown")

    def stats(self) -> dict[str, object]:
        """Return the slot counters of the engine in use (`slots`, `slotsInUse`, ...), empty when it reports none."""
        return harness_details(self._runtime)

    def slot_limit(self) -> int:
        """Return the slots of the engine in use (0 when it reports none)."""
        slots = self.stats().get("slots", 0)
        return slots if isinstance(slots, int) else 0

    def status(self) -> SandboxStatus:
        """Return the state, the reason it is not up, and the details: engine, ABIs, PDF, slots, capture counters."""
        state = self._state
        if state is not SandboxState.READY:
            reason = self._reason or {SandboxState.NEW: "not started", SandboxState.STARTING: "starting"}.get(
                state, str(state)
            )
            return SandboxStatus(state, reason)
        info = self.engine_info()
        sandbox_abi, pdf_abi = declared_abis()
        runnable = self.pdf_runnable
        details: dict[str, object] = {
            "state": "ready",
            "engine": info.id,
            "engineRelease": info.release,
            "engineMode": info.mode,
            "pdfCapable": runnable,
            "engineNotes": [without_paths(note) for note in info.notes],  # a status names no path of the host
            "sandboxAbi": sandbox_abi,
            "pdfAbi": pdf_abi,
        }
        if not runnable:
            details["pdfUnavailable"] = f"the {info.id} engine cannot run the PDF program"
        elif self._pdf_down is not None:
            details["pdfUnavailable"] = self._pdf_down
        details.update(self.stats())
        capture = self._capture
        if capture is not None:
            details["captureDropped"] = capture.dropped
            details["captureFailed"] = capture.failed
        return SandboxStatus(state, None, MappingProxyType(details))

    # -- start, recheck, stop ------------------------------------------------------------------------------------------
    def start(self, *, phase: PhaseTimer | None = None) -> None:
        """Bring the sandbox up (see the module docstring); a second call while started does nothing.

        `phase` measures the start's phases (a host's start-up budget); without one, the settings' `startup_budget` is
        met at each phase boundary (`datum.E004`).
        """
        with self._lock:
            if self._state in {SandboxState.READY, SandboxState.DOWN, SandboxState.STARTING}:
                return
            self._state = SandboxState.STARTING
            self._reason = None
            timer = phase or self._budget_timer()
            try:
                warm_up = self._bring_up(timer, recheck=False)
            except DatumConfigurationError as error:
                self._fail(error)
                raise
            except Exception as error:
                if self.settings.lifecycle.fail_fast:
                    self._fail(error)
                    raise
                self._close_runtime()
                self._went_down(error, "start")
                return
            except BaseException as error:
                self._fail(error)
                raise
            self._state = SandboxState.READY
            self._publish_ready(warm_up)

    def recheck(self) -> SandboxStatus:
        """Re-prove a running sandbox (the ABI and a smoke run), or build a down one again; return the status after.

        Before a start (or after a stop) it changes nothing.
        """
        with self._lock:
            if self._state is SandboxState.READY:
                self._reprove()
            elif self._state is SandboxState.DOWN:
                self._retry()
            return self.status()

    def stop(self, *, deadline: float | None = None) -> None:
        """Close the engine (its runs end interrupted within the stop grace), then let the capture drain; then a no-op.

        `deadline` (`time.monotonic`) is the one shutdown deadline: what is left of it after the engine closed is the
        capture's to drain its queue in, and what is still queued then is dropped and counted. Without one, the deadline
        is `shutdown_grace` from now.
        """
        with self._lock:
            if self._state is SandboxState.NEW:
                return
            end = deadline if deadline is not None else time.monotonic() + self.settings.lifecycle.shutdown_grace
            was = self._state
            self._close_runtime()
            self._close_capture(end)
            if was is not SandboxState.FAILED:
                self._state = SandboxState.STOPPED
                self._reason = None

    def close(self) -> None:
        """Stop the sandbox (`stop()`), for `contextlib.closing` and a host's exit stack."""
        self.stop()

    def __enter__(self) -> Self:
        """Start the sandbox."""
        self.start()
        return self

    def __exit__(
        self, exc_type: type[BaseException] | None, exc: BaseException | None, traceback: TracebackType | None
    ) -> None:
        """Stop the sandbox."""
        self.stop()

    # -- explain -------------------------------------------------------------------------------------------------------
    def explain(self) -> SettingsReport:
        """Return the settings report of what runs.

        It holds the settings, the inputs the application replaced, the engine and the programs (once started), and the
        trace and capture state.
        """
        report = self.settings.explain()
        replaced: dict[str, object] = {}
        if self._given_runtime is not None:
            replaced["datum.runtime.engine"] = f"the application's runtime ({type(self._given_runtime).__name__})"
        elif self._given_sandbox is not None:
            replaced["datum.runtime.engine"] = f"the application's sandbox ({type(self._given_sandbox).__name__})"
        given = self._engine_settings
        if given is not None:
            if given.stop_grace != self.settings.engine.stop_grace:
                replaced["datum.runtime.stop_grace"] = given.stop_grace
            if given.stray_bound != self.settings.engine.stray_bound:
                replaced["datum.runtime.max_strays"] = given.stray_bound
        if replaced:
            report = report.replaced(replaced)
        engine: EngineInfo | None = None
        if self._runtime is not None or self._given_sandbox is not None:
            with contextlib.suppress(Exception):
                engine = self.engine_info()
        programs = tuple(
            ProgramFacts(
                program.kind.value,
                program.sha256,
                program.abi,
                "packaged" if self._override(program) is None else str(self._override(program)),
            )
            for program in self._programs
        )
        return report.with_runtime(engine=engine, programs=programs, lines=self._state_lines())

    def _override(self, program: Program) -> str | None:
        programs = self.settings.programs
        return programs.sandbox if program.kind.value == "sandbox" else programs.pdf

    def _state_lines(self) -> list[str]:
        diagnostics = self.settings.diagnostics
        lines = [f"trace: {diagnostics.trace.value}"]
        capture = self._capture
        if capture is not None:
            lines.append(
                f"capture: on, {capture.describe()}, at most {diagnostics.capture.max_runs} runs and"
                f" {diagnostics.capture.max_bytes} bytes kept, {diagnostics.capture.queue_bytes} bytes queued"
            )
        else:
            lines.append("capture: off" if not diagnostics.capture.enabled else "capture: on, not open")
        return lines

    # -- the start's parts ---------------------------------------------------------------------------------------------
    def _budget_timer(self) -> PhaseTimer:
        budget = self.settings.lifecycle.startup_budget
        began = time.perf_counter()
        phases: list[tuple[str, float]] = []

        @contextlib.contextmanager
        def timed(name: str) -> Iterator[None]:
            at = time.perf_counter()
            try:
                yield
            finally:
                phases.append((name, time.perf_counter() - at))
            if time.perf_counter() - began > budget:
                raise DatumConfigurationError.from_checks([startup_over_budget(budget, phases)])

        return timed

    def _fail(self, error: BaseException) -> None:
        self._close_runtime()
        # The failed start's own failed runs are worth keeping: the capture drains within the shutdown grace.
        self._close_capture(time.monotonic() + self.settings.lifecycle.shutdown_grace)
        self._state = SandboxState.FAILED
        self._reason = str(error) or type(error).__name__

    def _went_down(self, error: Exception, during: str) -> None:
        self._state = SandboxState.DOWN
        self._reason = str(error) or type(error).__name__
        logger.error(
            "the Datum runtime failed its %s (%s: %s); the routes answer 503 server.unavailable until a recheck"
            " brings it up",
            during,
            type(error).__name__,
            self._reason,
        )

    def _close_runtime(self) -> None:
        resources, self._resources = self._resources, None
        self._sandbox = None
        self._pdf_kernel = None
        self._runtime = None
        if resources is not None:
            resources.close()

    def _close_capture(self, deadline: float) -> None:
        capture, self._capture = self._capture, None
        self._diagnostics = None
        if capture is not None:
            capture.stop(max(0.0, deadline - time.monotonic()))

    def _open_diagnostics(self) -> RunDiagnostics | None:
        """Open the capture (refusing an unsafe directory) and build the recorder; `None` while both are off."""
        diagnostics = self.settings.diagnostics
        last = self._last_capture
        if self._capture is None and diagnostics.capture.enabled and last is not None and last.writer_alive:
            raise RuntimeError(
                "the failed-run capture of the last start is still writing; the sandbox cannot start a capture"
                " again yet"
            )
        if self._capture is None and diagnostics.capture.enabled:
            sink = self._capture_sink
            if sink is None:
                if diagnostics.capture.directory is None:
                    raise DatumConfigurationError(
                        "datum.runtime.diagnostics.capture.enabled is true but"
                        " datum.runtime.diagnostics.capture.directory is not set",
                        hint="set datum.runtime.diagnostics.capture.directory to an owner-only directory, or turn the"
                        " capture off",
                    )
                sink = DirectoryCaptureSink(diagnostics.capture.directory)
            capture = FailedRunCapture(
                sink,
                max_runs=diagnostics.capture.max_runs,
                max_bytes=diagnostics.capture.max_bytes,
                queue_bytes=diagnostics.capture.queue_bytes,
            )
            capture.start()
            self._capture = capture
            self._last_capture = capture
        if diagnostics.trace is TraceMode.OFF and self._capture is None:
            return None
        return RunDiagnostics(
            mode=diagnostics.trace,
            trace=self._trace or log_trace,
            capture=self._capture,
            report=lambda: self.explain().to_json(hide_paths=False),
        )

    def _build_runtime(self) -> GuestRuntime:
        settings = self.settings
        engine = settings.engine
        work_dir = Path(engine.work_dir or tempfile.gettempdir())
        limits = settings.limits.engine_limits(
            work_dir, engine.tick, qjs_path=engine.qjs_path, qjs_sha256=engine.qjs_sha256
        )
        try:
            provider = self._discover().select(engine.id)
            return provider.create(limits, self._engine_settings or engine.engine_settings())
        except EngineConfigurationError as error:
            raise translated(error) from error

    def _bring_up(self, timer: PhaseTimer, *, recheck: bool) -> float:
        """Open the diagnostics, build or adopt the engine, log the report, compose the sandbox, prove, warm up.

        Returns the warm-up runs' milliseconds. On a failure the caller closes the engine (`_close_runtime`).
        """
        resources = ExitStack()
        self._resources = resources
        with timer("runtime"):
            self._diagnostics = self._open_diagnostics()
            runtime = self._given_runtime
            if runtime is None and self._given_sandbox is None:
                runtime = self._build_runtime()
            if runtime is not None:
                resources.callback(runtime.close)
            self._runtime = runtime
            own: Sandbox | None = None
            programs: list[Program] = []
            program: Program | None = None
            if self._given_sandbox is None and runtime is not None:
                program = sandbox_program(self.settings.programs.sandbox)
                programs.append(program)
            self._pdf_program = None
            if self._pdf_on and can_run_pdf(runtime):
                self._pdf_program = pdf_program(self.settings.programs.pdf)
                programs.append(self._pdf_program)
            self._programs = tuple(programs)
            if self.settings.diagnostics.report and not recheck:
                _settings_logger.info("%s", self.explain())  # once per start, before any program is proved
            if program is not None and runtime is not None:
                own = SandboxService(
                    runtime,
                    program,
                    freeze_snippet=freeze_snippet(),
                    limits=self.settings.limits,
                    host_options=self._host_options(),
                    probe=self._probe,
                    run_log=self._run_log,
                    recorder=self._diagnostics,
                )
            base = own if own is not None else self._given_sandbox
            if base is None:  # pragma: no cover - one of the two branches above always gives a sandbox
                raise DatumConfigurationError("the sandbox has neither a runtime nor a sandbox to run")
            self._sandbox = compose_sandbox(
                base, replacement=self._given_sandbox, middleware=self._middleware, observation=self._observation
            )
        with timer("ABI proof and warm-up runs"):
            warm_up = self._prove(self._sandbox)
            self._bring_up_pdf(soft=recheck or not self.settings.lifecycle.fail_fast)
            return warm_up

    def _host_options(self) -> HostOptions:
        host = self.settings.host
        return HostOptions(host.formula_errors, host.risky_patterns, ZoneInfo(host.time_zone), self._now)

    def _bring_up_pdf(self, *, soft: bool) -> None:
        """Compose the PDF kernel and prove its ABI once, beside the sandbox's (only while `pdf` is on).

        A runtime that cannot run the PDF program leaves PDFs unavailable and the start standing. A program that fails
        its proof stops the start unless `soft`, else leaves PDFs unavailable the same way. The new kernel is built and
        proved first and swapped in only then, so a recheck leaves the running kernel serving until the new one passed.
        """
        kernel, down, absent = self._compose_pdf(soft=soft)
        self._pdf_down, self._pdf_absent = down, absent
        self._pdf_kernel = kernel

    def _compose_pdf(self, *, soft: bool) -> tuple[PdfKernel | None, str | None, str | None]:
        if not self._pdf_on:
            return None, None, None
        runtime = self._runtime
        if runtime is None:
            return None, None, "no program runtime is running, so the PDF program cannot run"
        if not can_run_pdf(runtime):
            return None, None, f"the {self._engine_id()} engine cannot run the PDF program"
        program = self._pdf_program or pdf_program(self.settings.programs.pdf)
        self._pdf_program = None  # read once per start: a recheck reads the file again
        self._programs = (*(p for p in self._programs if p.kind is not program.kind), program)
        own = PdfKernelService(
            runtime, program, limits=self.settings.limits, probe=self._pdf_probe, recorder=self._diagnostics
        )
        refusal = self._prove_pdf(own, soft=soft)
        if refusal is not None:
            return None, refusal, None
        return compose_pdf_kernel(own, middleware=self._pdf_middleware, observation=self._pdf_observation), None, None

    def _engine_id(self) -> str:
        try:
            return self.engine_info().id
        except Exception:
            return "unknown"

    def _prove_pdf(self, own: PdfKernelService, *, soft: bool) -> str | None:
        try:
            with self._unobserved():
                own.prove_abi()
        except (ProgramUnavailableError, SandboxError) as error:
            if not soft:
                raise
            down = str(error) or type(error).__name__
            logger.error(  # noqa: TRY400 - the refusal's own words suffice
                "the PDF program failed its proof (%s); PDFs answer 503 until a recheck passes it", down
            )
            return down
        return None

    def _prove(self, sandbox: Sandbox) -> float:
        with self._unobserved():  # the proof and the warm-ups are the start's own, not calls to observe
            sandbox.prove_abi()
            began = time.perf_counter()
            for _ in range(max(1, self.settings.lifecycle.warm_up_runs)):
                smoke = sandbox.smoke()
                if not smoke.ok:
                    raise ProgramUnavailableError(f"The sandbox smoke run failed: {smoke.message}")
            return (time.perf_counter() - began) * 1000.0

    def _reprove(self) -> None:
        sandbox = self._sandbox
        if sandbox is None:  # pragma: no cover - ready always has a sandbox
            return
        self._probe.forget()
        try:
            self._prove(sandbox)
        except Exception as error:  # the runtime stays built; the next recheck builds it again
            self._went_down(error, "recheck")
            return
        self._pdf_probe.forget()
        try:
            self._bring_up_pdf(soft=True)
        except Exception as error:  # the PDF program is the capability's: the sandbox stays up
            self._pdf_kernel = None
            self._pdf_down = f"the PDF program could not be set up ({type(error).__name__})"
            logger.error("the PDF program failed its recheck (%s)", type(error).__name__)  # noqa: TRY400

    def _retry(self) -> None:
        self._close_runtime()
        try:
            warm_up = self._bring_up(_untimed, recheck=True)
        except Exception as error:
            self._close_runtime()
            self._went_down(error, "recheck")
            return
        self._state = SandboxState.READY
        self._reason = None
        self._publish_ready(warm_up)

    def _publish_ready(self, warm_up: float) -> None:
        sandbox_abi, pdf_abi = declared_abis()
        if self._on_ready is not None:
            self._on_ready(SandboxReady(self.engine_info(), sandbox_abi, pdf_abi, warm_up))


@contextlib.contextmanager
def _untimed(_name: str) -> Iterator[None]:
    yield


__all__ = [
    "DatumSandbox",
    "PhaseTimer",
    "SandboxReady",
    "SandboxState",
    "SandboxStatus",
    "can_run_pdf",
    "harness_details",
    "translated",
]
