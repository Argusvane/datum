"""RunHarness invariants over a fake engine: worker thread, private directories, bounded streams, slots and strays."""

# ruff: noqa: PT018, PT011

import os
import stat
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest

from datum_sandbox.wasi import (
    EngineBusyError,
    EngineClosedError,
    EngineSettings,
    EngineStrayBoundError,
    GuestEnd,
    GuestEndKind,
    GuestIo,
    GuestRun,
    OutputSink,
    RunBudget,
    RunEnd,
    RunHarness,
    RunResult,
)

posix_only = pytest.mark.skipif(os.name != "posix", reason="POSIX permission bits")


class Stop(Exception):  # noqa: N818 - a fake control-flow exception
    """Raised by a fake guest to end its run with a chosen classification."""

    def __init__(self, end: GuestEnd) -> None:
        super().__init__("stop")
        self.end = end


class Boom(BaseException):
    """A close failure that `except Exception` does not catch."""


class FakeInstance:
    def __init__(self, engine: "FakeEngine", io: GuestIo) -> None:
        self.engine = engine
        self.io = io
        self.stop_called = threading.Event()
        self.closed = threading.Event()

    def start(self) -> None:
        self.engine.started.set()
        self.engine.threads.append(threading.current_thread())
        self.engine.script(self)

    def request_stop(self) -> None:
        self.stop_called.set()

    def classify(self, error: BaseException, /) -> GuestEnd:
        if self.engine.classify_raises:
            raise RuntimeError("classify failed")
        if isinstance(error, Stop):
            return error.end
        return GuestEnd(GuestEndKind.TRAP, detail=type(error).__name__)

    def close(self) -> None:
        self.closed.set()
        if self.engine.close_raises:
            raise RuntimeError("close failed")
        if self.engine.close_raises_base:
            raise Boom


class FakeEngine:
    def __init__(self, script: Callable[[FakeInstance], object] | None = None) -> None:
        self.script: Callable[[FakeInstance], object] = script or (lambda inst: None)
        self.instances: list[FakeInstance] = []
        self.threads: list[threading.Thread] = []
        self.started = threading.Event()
        self.instantiate_raises: Exception | None = None
        self.classify_raises = False
        self.close_raises = False
        self.close_raises_base = False
        self.instantiate_delay = 0.0
        self.memory_seen: list[int] = []
        self.budgets_seen: list[RunBudget] = []
        self.seen: dict[str, object] = {}

    def instantiate(self, io: GuestIo, budget: RunBudget, /) -> FakeInstance:
        if self.instantiate_delay:
            time.sleep(self.instantiate_delay)
        if self.instantiate_raises is not None:
            raise self.instantiate_raises
        self.memory_seen.append(budget.memory_bytes)
        self.budgets_seen.append(budget)
        instance = FakeInstance(self, io)
        self.instances.append(instance)
        return instance


BUDGET = RunBudget(wall_seconds=2.0, memory_bytes=1 << 20, stdout_cap=64, stderr_cap=16, wait=0.0)


def harness(engine: FakeEngine, tmp_path: Path, *, slots: int = 2, **kw: object) -> RunHarness:
    settings = kw.pop("settings", EngineSettings(stop_grace=0.2, stray_bound=2))
    assert isinstance(settings, EngineSettings)
    return RunHarness(engine, slots=slots, work_dir=tmp_path, settings=settings, **kw)  # type: ignore[arg-type]


APP_PROGRAM = "program.js"
APP_RUN_SCRIPT = "run.js"


def guest_run(program: bytes = b"P", stdin: bytes = b"in", budget: RunBudget = BUDGET, **extra: Any) -> GuestRun:
    """A generic run: two files under `/app`, the arguments, stdin and the budget (no Datum program involved)."""
    return GuestRun(
        app_files={APP_PROGRAM: program, APP_RUN_SCRIPT: b"RUN"},
        argv=("qjs", "/app/run.js"),
        stdin=stdin,
        budget=budget,
        **extra,
    )


def run(h: RunHarness, budget: RunBudget = BUDGET, program: bytes = b"P", stdin: bytes = b"in") -> RunResult:
    return h.run(guest_run(program, stdin, budget))


def wait_on(event: threading.Event) -> None:
    event.wait(5)


def wait_for(predicate: Callable[[], bool], timeout: float = 3.0) -> None:
    deadline = time.monotonic() + timeout
    while not predicate():
        assert time.monotonic() < deadline, "condition not reached"
        time.sleep(0.005)


def no_run_dirs(tmp_path: Path) -> bool:
    return not any(tmp_path.iterdir())


def test_clean_run_on_a_worker_thread_with_bytes_from_memory(tmp_path: Path) -> None:
    seen: dict[str, object] = {}

    def script(inst: FakeInstance) -> None:
        seen["thread"] = threading.current_thread()
        seen["program"] = (inst.io.app_dir / APP_PROGRAM).read_bytes()
        seen["run"] = (inst.io.app_dir / APP_RUN_SCRIPT).read_bytes()
        seen["stdin"] = inst.io.stdin_path.read_bytes()
        seen["listing"] = sorted(p.name for p in inst.io.app_dir.iterdir())
        seen["argv"] = inst.io.argv
        seen["parent"] = inst.io.app_dir.parent
        inst.io.stdout.write(b"hello")
        inst.io.stderr.write(b"warn")

    engine = FakeEngine(script)
    result = run(harness(engine, tmp_path))
    assert result.end is RunEnd.CLEAN
    assert (result.stdout, result.stderr) == (b"hello", b"warn")
    assert seen["thread"] is not threading.current_thread()
    assert (seen["program"], seen["run"], seen["stdin"]) == (b"P", b"RUN", b"in")
    assert seen["listing"] == [APP_PROGRAM, APP_RUN_SCRIPT]  # program and run script only
    assert seen["argv"] == ("qjs", "/app/run.js")
    assert engine.memory_seen == [BUDGET.memory_bytes]
    assert engine.instances[0].closed.is_set()
    assert no_run_dirs(tmp_path)


@posix_only
def test_run_directory_is_private_and_app_is_read_only(tmp_path: Path) -> None:
    modes: dict[str, int] = {}

    def script(inst: FakeInstance) -> None:
        run_dir = inst.io.app_dir.parent
        modes["run"] = stat.S_IMODE(run_dir.stat().st_mode)
        modes["app"] = stat.S_IMODE(inst.io.app_dir.stat().st_mode)
        modes["program"] = stat.S_IMODE((inst.io.app_dir / APP_PROGRAM).stat().st_mode)
        modes["stdin"] = stat.S_IMODE(inst.io.stdin_path.stat().st_mode)
        modes["under_work_dir"] = int(run_dir.parent == tmp_path)

    run(harness(FakeEngine(script), tmp_path))
    assert modes == {"run": 0o700, "app": 0o500, "program": 0o400, "stdin": 0o400, "under_work_dir": 1}
    assert no_run_dirs(tmp_path)


def test_two_concurrent_runs_never_share_a_directory(tmp_path: Path) -> None:
    barrier = threading.Barrier(2, timeout=3)
    dirs: list[Path] = []

    def script(inst: FakeInstance) -> None:
        dirs.append(inst.io.app_dir)
        barrier.wait()

    h = harness(FakeEngine(script), tmp_path)
    threads = [threading.Thread(target=lambda: run(h)) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join(5)
    assert len(set(dirs)) == 2
    assert no_run_dirs(tmp_path)


@pytest.mark.parametrize(
    ("end", "expected", "code"),
    [
        (GuestEnd(GuestEndKind.EXIT, 0), RunEnd.CLEAN, 0),
        (GuestEnd(GuestEndKind.EXIT, 3), RunEnd.EXIT, 3),
        (GuestEnd(GuestEndKind.TRAP, detail="unreachable"), RunEnd.TRAP, None),
        (GuestEnd(GuestEndKind.INTERRUPT), RunEnd.BUDGET, None),
        (GuestEnd(GuestEndKind.MEMORY), RunEnd.MEMORY, None),
    ],
)
def test_classification(tmp_path: Path, end: GuestEnd, expected: RunEnd, code: int | None) -> None:
    def script(inst: FakeInstance) -> None:
        raise Stop(end)

    result = run(harness(FakeEngine(script), tmp_path))
    assert (result.end, result.exit_code, result.detail) == (expected, code, end.detail)


def test_output_cap_wins_whatever_ended_the_run(tmp_path: Path) -> None:
    def script(inst: FakeInstance) -> None:
        # an unaligned cap: one call straddles it, and a later call is dropped whole
        for chunk in (b"a" * 60, b"b" * 10, b"c" * 10):
            assert inst.io.stdout.write(chunk) == len(chunk)  # the full count, never an error
        raise Stop(GuestEnd(GuestEndKind.TRAP))

    result = run(harness(FakeEngine(script), tmp_path))
    assert result.end is RunEnd.OUTPUT_CAP
    assert result.stdout == b"a" * 60 + b"b" * 4  # exactly the cap
    assert result.stdout_capped and not result.stderr_capped


def test_output_sink_bounds() -> None:
    sink = OutputSink(5)
    assert sink.write(b"abc") == 3
    before = sink.capped
    assert before is False
    assert sink.write(memoryview(b"defgh")) == 5
    assert sink.capped is True
    assert sink.value() == b"abcde"
    assert sink.write(b"x") == 1 and sink.value() == b"abcde"
    zero = OutputSink(0)
    assert zero.write(b"abc") == 3 and zero.value() == b"" and zero.capped
    with pytest.raises(ValueError):
        OutputSink(-1)


def test_budget_expiry_asks_the_guest_to_stop(tmp_path: Path) -> None:
    def script(inst: FakeInstance) -> None:
        assert inst.stop_called.wait(3)
        raise Stop(GuestEnd(GuestEndKind.INTERRUPT))

    engine = FakeEngine(script)
    h = harness(engine, tmp_path)
    started = time.monotonic()
    result = run(h, RunBudget(wall_seconds=0.1, memory_bytes=1))
    assert result.end is RunEnd.BUDGET
    assert time.monotonic() - started < 1.0
    assert h.stats().stuck_runs == 0 and h.stats().slots_in_use == 0
    assert no_run_dirs(tmp_path)


def test_stuck_run_is_a_bounded_stray_that_keeps_its_slot(tmp_path: Path) -> None:
    gate = threading.Event()

    def script(inst: FakeInstance) -> None:
        gate.wait(5)  # ignores the stop request

    engine = FakeEngine(script)
    h = harness(engine, tmp_path, slots=1)
    result = run(h, RunBudget(wall_seconds=0.05, memory_bytes=1))
    assert result.end is RunEnd.STUCK
    stats = h.stats()
    assert (stats.stuck_runs, stats.stray_runs, stats.slots_in_use) == (1, 1, 1)
    with pytest.raises(EngineBusyError) as busy:  # the stray still owns the only slot
        run(h)
    assert busy.value.reason == "slots"
    assert all(t.daemon for t in engine.threads)
    gate.set()
    wait_for(lambda: not any(t.is_alive() for t in engine.threads))
    wait_for(lambda: h.stats().stray_runs == 0 and h.stats().slots_in_use == 0)
    assert h.stats().stuck_runs == 1  # the count of runs given up on stays
    wait_for(lambda: no_run_dirs(tmp_path))
    assert run(h).end is RunEnd.CLEAN  # the slot came back


def test_stray_bound_refuses_new_runs(tmp_path: Path) -> None:
    gate = threading.Event()
    busy_reasons: list[str] = []
    h = harness(
        FakeEngine(lambda inst: wait_on(gate)),
        tmp_path,
        slots=4,
        settings=EngineSettings(stop_grace=0.05, stray_bound=1),
        on_busy=busy_reasons.append,
    )
    assert run(h, RunBudget(wall_seconds=0.02, memory_bytes=1)).end is RunEnd.STUCK
    with pytest.raises(EngineStrayBoundError) as full:
        run(h)
    # A fault of the runtime (its guests would not stop), never the retryable busy of a slot wait.
    assert not isinstance(full.value, EngineBusyError)
    assert (full.value.strays, full.value.bound) == (1, 1)
    assert busy_reasons == [], "a full stray bound is not a busy refusal"
    gate.set()
    wait_for(lambda: h.stats().stray_runs == 0)
    assert run(h).end is RunEnd.CLEAN


def test_slot_wait_times_out_and_is_reported(tmp_path: Path) -> None:
    release = threading.Event()
    engine = FakeEngine(lambda inst: wait_on(release))
    reasons: list[str] = []
    h = harness(engine, tmp_path, slots=1, on_busy=reasons.append)
    first = threading.Thread(target=lambda: run(h))
    first.start()
    assert engine.started.wait(3)
    began = time.monotonic()
    with pytest.raises(EngineBusyError):
        run(h, RunBudget(wall_seconds=1, memory_bytes=1, wait=0.15))
    assert 0.1 <= time.monotonic() - began < 1.0
    assert reasons == ["slots"]
    release.set()
    first.join(3)
    assert h.stats().slots_in_use == 0


def test_a_waiting_run_gets_the_slot_when_it_frees(tmp_path: Path) -> None:
    release = threading.Event()
    engine = FakeEngine()
    calls: list[int] = []

    def script(inst: FakeInstance) -> None:
        calls.append(1)
        if len(calls) == 1:
            release.wait(5)

    engine.script = script
    h = harness(engine, tmp_path, slots=1)
    first = threading.Thread(target=lambda: run(h))
    first.start()
    assert engine.started.wait(3)
    threading.Timer(0.1, release.set).start()
    assert run(h, RunBudget(wall_seconds=2, memory_bytes=1, wait=2)).end is RunEnd.CLEAN
    first.join(3)


@pytest.mark.parametrize(
    "failure", ["instantiate", "classify", "close", "close_base", "work_dir", "start_unclassified"]
)
def test_the_slot_and_directory_are_released_on_every_exit_path(
    tmp_path: Path, failure: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(threading, "excepthook", lambda args: None)
    engine = FakeEngine()
    work = tmp_path / "work"
    work.mkdir()
    if failure == "instantiate":
        engine.instantiate_raises = ValueError("no instance")
    elif failure == "classify":
        engine.classify_raises = True
        engine.script = lambda inst: (_ for _ in ()).throw(Stop(GuestEnd(GuestEndKind.TRAP)))
    elif failure == "close":
        engine.close_raises = True
    elif failure == "close_base":
        engine.close_raises_base = True
    elif failure == "start_unclassified":
        engine.script = lambda inst: (_ for _ in ()).throw(KeyError("odd"))
    h = harness(engine, work, slots=1)
    if failure == "work_dir":
        h = harness(engine, tmp_path / "missing", slots=1)
    outcomes: list[object] = []
    for _ in range(3):  # a leak of the single slot would show on the second attempt
        try:
            outcomes.append(run(h).end)
        except (ValueError, RuntimeError, OSError) as error:
            outcomes.append(type(error).__name__)
    assert "EngineBusyError" not in outcomes
    stats = h.stats()
    assert (stats.slots_in_use, stats.runs_in_flight, stats.stray_runs) == (0, 0, 0)
    assert no_run_dirs(work)
    if failure == "instantiate":
        assert outcomes == ["ValueError"] * 3
    if failure in ("close", "close_base"):
        assert outcomes == [RunEnd.CLEAN] * 3
    if failure == "start_unclassified":
        assert outcomes == [RunEnd.TRAP] * 3


def test_a_running_thread_count_returns_to_baseline(tmp_path: Path) -> None:
    before = threading.active_count()
    h = harness(FakeEngine(), tmp_path)
    for _ in range(10):
        run(h)
    wait_for(lambda: threading.active_count() <= before)


def test_sweep_removes_only_old_run_directories(tmp_path: Path) -> None:
    old = tmp_path / "datum-run-old"
    new = tmp_path / "datum-run-new"
    other = tmp_path / "keep-me"
    for path in (old, new, other):
        path.mkdir()
    long_ago = time.time() - 3600
    os.utime(old, (long_ago, long_ago))
    os.utime(other, (long_ago, long_ago))
    h = harness(FakeEngine(), tmp_path)
    assert h.sweep(600) == 1
    assert not old.exists() and new.exists() and other.exists()


def test_close_refuses_new_runs_and_waits_for_live_workers(tmp_path: Path) -> None:
    release = threading.Event()
    engine = FakeEngine(lambda inst: wait_on(release))
    h = harness(engine, tmp_path)
    t = threading.Thread(target=lambda: run(h))
    t.start()
    assert engine.started.wait(3)
    assert h.close(timeout=0.05) == 1  # one worker still alive
    with pytest.raises(EngineClosedError):
        run(h)
    release.set()
    t.join(3)
    assert h.close(timeout=1) == 0


def test_settings_and_slots_are_validated(tmp_path: Path) -> None:
    with pytest.raises(ValueError):
        RunHarness(FakeEngine(), slots=0, work_dir=tmp_path)
    with pytest.raises(ValueError):
        EngineSettings(stray_bound=0)
    with pytest.raises(ValueError):
        EngineSettings(stop_grace=-1)
    assert EngineSettings().stop_grace == 5.0
    assert EngineSettings().stray_bound >= 2


def test_a_failed_thread_start_releases_the_slot(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    h = harness(FakeEngine(), tmp_path, slots=1)
    real_start = threading.Thread.start

    def failing(self: threading.Thread) -> None:
        raise RuntimeError("can't start new thread")

    monkeypatch.setattr(threading.Thread, "start", failing)
    with pytest.raises(RuntimeError, match="start new thread"):
        run(h)
    stats = h.stats()
    assert (stats.slots_in_use, stats.runs_in_flight) == (0, 0)
    monkeypatch.setattr(threading.Thread, "start", real_start)
    assert run(h).end is RunEnd.CLEAN


def test_close_while_a_run_waits_for_a_slot_leaks_and_over_releases_nothing(tmp_path: Path) -> None:
    release = threading.Event()
    engine = FakeEngine(lambda inst: wait_on(release))
    h = harness(engine, tmp_path, slots=1)
    first = threading.Thread(target=lambda: run(h))
    first.start()
    assert engine.started.wait(3)
    outcome: list[object] = []

    def second() -> None:
        try:
            outcome.append(run(h, RunBudget(wall_seconds=2, memory_bytes=1, wait=2)))
        except EngineClosedError as error:
            outcome.append(error)

    waiter = threading.Thread(target=second)
    waiter.start()
    time.sleep(0.2)  # the second run is parked on the slot
    h.close(timeout=0)
    release.set()
    first.join(3)
    waiter.join(3)
    assert len(outcome) == 1 and isinstance(outcome[0], EngineClosedError)
    wait_for(lambda: h.stats().slots_in_use == 0)
    assert h._slots.acquire(timeout=0)
    assert not h._slots.acquire(timeout=0)


def test_the_wall_budget_is_waited_before_a_stop_is_asked(tmp_path: Path) -> None:
    engine = FakeEngine(lambda inst: time.sleep(0.4))
    h = harness(engine, tmp_path, settings=EngineSettings(stop_grace=0.2, stray_bound=2))
    assert run(h, RunBudget(wall_seconds=2, memory_bytes=1)).end is RunEnd.CLEAN
    assert not engine.instances[0].stop_called.is_set()


def test_a_stop_requested_before_the_instance_exists_is_forwarded(tmp_path: Path) -> None:
    seen: list[bool] = []

    def script(inst: FakeInstance) -> None:
        seen.append(inst.stop_called.is_set())
        raise Stop(GuestEnd(GuestEndKind.INTERRUPT))

    engine = FakeEngine(script)
    engine.instantiate_delay = 0.2
    h = harness(engine, tmp_path, settings=EngineSettings(stop_grace=1.0, stray_bound=2))
    result = run(h, RunBudget(wall_seconds=0.05, memory_bytes=1))
    assert seen == [True]
    assert result.end is RunEnd.BUDGET


def test_a_sink_that_fits_exactly_is_not_capped() -> None:
    sink = OutputSink(5)
    sink.write(b"abcde")
    assert sink.capped is False


def test_a_run_writing_exactly_the_stdout_cap_is_clean(tmp_path: Path) -> None:
    engine = FakeEngine(lambda inst: inst.io.stdout.write(b"x" * 64))
    result = run(harness(engine, tmp_path))
    assert result.end is RunEnd.CLEAN
    assert len(result.stdout) == 64


def test_one_byte_over_the_stderr_cap_is_output_cap(tmp_path: Path) -> None:
    engine = FakeEngine(lambda inst: inst.io.stderr.write(b"e" * 17))
    result = run(harness(engine, tmp_path))
    assert result.end is RunEnd.OUTPUT_CAP
    assert (result.stderr_capped, result.stdout_capped) == (True, False)


@posix_only
def test_sweep_never_follows_a_link(tmp_path: Path) -> None:
    work = tmp_path / "work"
    work.mkdir()
    victim = tmp_path / "victim"
    victim.mkdir()
    victim.chmod(0o755)
    victim2 = tmp_path / "victim2"
    (victim2 / "app").mkdir(parents=True)
    victim2.chmod(0o755)
    (victim2 / "app").chmod(0o755)
    (work / "datum-run-evil").symlink_to(victim)
    real = work / "datum-run-evil2"
    real.mkdir()
    (real / "app").symlink_to(victim2 / "app")
    old = time.time() - 3600
    os.utime(real, (old, old))
    os.utime(work / "datum-run-evil", (old, old), follow_symlinks=False)
    harness(FakeEngine(), work).sweep(60)
    assert stat.S_IMODE(victim.stat().st_mode) == 0o755
    assert stat.S_IMODE(victim2.stat().st_mode) == 0o755
    assert stat.S_IMODE((victim2 / "app").stat().st_mode) == 0o755
    assert victim.exists() and (victim2 / "app").exists()


# --- further edge cases -----------------------------------------------------------------------------------------------


def test_a_bare_str_argv_is_refused(tmp_path: Path) -> None:
    engine = FakeEngine()
    h = harness(engine, tmp_path, slots=1)
    with pytest.raises(TypeError, match="argv"):
        h.run(GuestRun(app_files={APP_PROGRAM: b"P"}, argv="qjs /app/run.js", stdin=b"in", budget=BUDGET))
    assert engine.instances == []
    assert h.stats().slots_in_use == 0
    assert run(h).end is RunEnd.CLEAN  # the refusal took no slot


def test_abandon_after_the_worker_finished_counts_no_stray(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The race guard: the worker ends between the grace wait timing out and `_abandon` taking the lock."""
    original = RunHarness._abandon  # pyright: ignore[reportPrivateUsage]
    abandoned: list[bool] = []

    def late(self: RunHarness, run_state: object) -> None:
        wait_on(run_state.done)  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue, reportUnknownArgumentType, reportUnknownMemberType]
        original(self, run_state)  # type: ignore[arg-type]  # pyright: ignore[reportArgumentType]
        abandoned.append(run_state.abandoned)  # type: ignore[attr-defined]  # pyright: ignore[reportAttributeAccessIssue, reportUnknownArgumentType, reportUnknownMemberType]

    monkeypatch.setattr(RunHarness, "_abandon", late)
    engine = FakeEngine(lambda inst: time.sleep(0.3))  # ignores the stop request
    h = harness(engine, tmp_path, slots=1, settings=EngineSettings(stop_grace=0.05, stray_bound=1))
    budget = RunBudget(wall_seconds=0.05, memory_bytes=1 << 20, stdout_cap=64, stderr_cap=16, wait=0.0)
    result = run(h, budget)
    assert abandoned == [False]
    assert result.end is RunEnd.CLEAN
    stats = h.stats()
    assert (stats.stuck_runs, stats.stray_runs, stats.slots_in_use, stats.runs_in_flight) == (0, 0, 0, 0)
    monkeypatch.undo()
    assert run(h).end is RunEnd.CLEAN  # not refused for "strays"


def test_the_default_stray_bound_counts_the_cpus_this_process_may_use(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(os, "process_cpu_count", lambda: 3, raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: 64)
    assert EngineSettings().stray_bound == 3
    monkeypatch.setattr(os, "process_cpu_count", lambda: 1, raising=False)
    assert EngineSettings().stray_bound == 2  # at least two
    monkeypatch.setattr(os, "process_cpu_count", lambda: None, raising=False)
    monkeypatch.setattr(os, "cpu_count", lambda: None)
    assert EngineSettings().stray_bound == 2
    monkeypatch.delattr(os, "process_cpu_count", raising=False)  # before 3.13: os.cpu_count
    monkeypatch.setattr(os, "cpu_count", lambda: 5)
    assert EngineSettings().stray_bound == 5


# --- the whole budget reaches the engine; the shutdown stop reads INTERRUPTED -----------------------------


def test_the_engine_receives_the_whole_budget(tmp_path: Path) -> None:
    engine = FakeEngine()
    h = harness(engine, tmp_path)
    budget = RunBudget(wall_seconds=1.5, memory_bytes=3 << 20, stdout_cap=64, stderr_cap=16, wait=0.0)
    assert run(h, budget).end is RunEnd.CLEAN
    assert engine.budgets_seen == [budget]
    assert engine.memory_seen == [3 << 20]


def _stops_when_asked(inst: FakeInstance) -> None:
    """A guest that runs until asked to stop, then ends the way an interrupted guest does."""
    wait_on(inst.stop_called)
    raise Stop(GuestEnd(GuestEndKind.INTERRUPT))


def test_interrupt_stops_a_run_in_flight_as_interrupted_and_refuses_new_runs(tmp_path: Path) -> None:
    engine = FakeEngine(_stops_when_asked)
    h = harness(engine, tmp_path)
    results: list[RunResult] = []
    worker = threading.Thread(target=lambda: results.append(run(h, RunBudget(wall_seconds=30, memory_bytes=1))))
    worker.start()
    assert engine.started.wait(3)
    began = time.monotonic()
    assert h.interrupt() == 1
    worker.join(5)
    assert time.monotonic() - began < 1.0, "the stop was asked at once, not at the wall budget"
    assert [r.end for r in results] == [RunEnd.INTERRUPTED]
    with pytest.raises(EngineClosedError):
        run(h)
    assert h.stats().slots_in_use == 0
    assert no_run_dirs(tmp_path)


def test_a_budget_stop_without_interrupt_stays_a_budget_stop(tmp_path: Path) -> None:
    engine = FakeEngine(_stops_when_asked)
    h = harness(engine, tmp_path)
    assert run(h, RunBudget(wall_seconds=0.05, memory_bytes=1)).end is RunEnd.BUDGET


def test_interrupt_reaches_a_run_still_in_set_up(tmp_path: Path) -> None:
    def script(inst: FakeInstance) -> None:
        if inst.stop_called.is_set():
            raise Stop(GuestEnd(GuestEndKind.INTERRUPT))

    engine = FakeEngine(script)
    engine.instantiate_delay = 0.3
    h = harness(engine, tmp_path)
    results: list[RunResult] = []
    worker = threading.Thread(target=lambda: results.append(run(h, RunBudget(wall_seconds=30, memory_bytes=1))))
    worker.start()
    wait_for(lambda: h.stats().runs_in_flight == 1)
    assert h.interrupt() == 1
    worker.join(5)
    assert engine.instances[0].stop_called.is_set(), "the stop was forwarded once the instance existed"
    assert [r.end for r in results] == [RunEnd.INTERRUPTED]


@pytest.mark.parametrize(
    ("end", "expected"),
    [
        (None, RunEnd.CLEAN),
        (GuestEnd(GuestEndKind.EXIT, 3), RunEnd.EXIT),
        (GuestEnd(GuestEndKind.TRAP, detail="unreachable"), RunEnd.TRAP),
    ],
)
def test_a_run_that_ends_by_itself_after_interrupt_keeps_its_own_end(
    tmp_path: Path, end: GuestEnd | None, expected: RunEnd
) -> None:
    def script(inst: FakeInstance) -> None:
        wait_on(inst.stop_called)
        if end is not None:
            raise Stop(end)

    h = harness(FakeEngine(script), tmp_path)
    results: list[RunResult] = []
    worker = threading.Thread(target=lambda: results.append(run(h, RunBudget(wall_seconds=30, memory_bytes=1))))
    worker.start()
    wait_for(lambda: h.stats().runs_in_flight == 1)
    h.interrupt()
    worker.join(5)
    assert [r.end for r in results] == [expected]


def test_interrupt_with_nothing_in_flight_closes_the_harness(tmp_path: Path) -> None:
    h = harness(FakeEngine(), tmp_path)
    assert run(h).end is RunEnd.CLEAN
    assert h.interrupt() == 0
    assert h.interrupt() == 0
    with pytest.raises(EngineClosedError):
        run(h)
