"""The wasmtime engine's own promises, beyond the shared contracts: registration, engine settings, the floor, the
stores closed on every path, the private run directory removed, both pools, the start-up costs, and shutdown.

Built directly (`WasmtimeGuestRuntime`) except where the entry point itself is under test. Nothing here runs under
xdist.
"""

import gc
import json
import os
import re
import shutil
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest
import wasmtime
from guests import datum_limits

from datum_sandbox.protocol import (
    APP_PROGRAM,
    APP_RUN_SCRIPT,
    PDF_ABI_MIN,
    PDF_RUN_SCRIPT,
    PoolKind,
    RuleModule,
    SandboxError,
    SandboxFailure,
    new_nonce,
    program_run,
    sandbox_answer,
)
from datum_sandbox.testing.fixtures import pdf_program, sandbox_program
from datum_sandbox.testing.runtime_support import MIB, STARTED, budget, live_threads, run_raw, sandbox_run, settle
from datum_sandbox.wasi import (
    GROUP,
    EngineClosedError,
    EngineConfigurationError,
    EngineSettings,
    GuestEndKind,
    GuestIo,
    GuestRun,
    GuestRuntimes,
    MemoryFloorError,
    OutputSink,
    RunBudget,
    RunEnd,
    RunHarness,
)
from datum_sandbox_wasmtime import ENGINE_ID, WasmtimeGuestRuntime, WasmtimeProvider
from datum_sandbox_wasmtime import _runtime as runtime_module
from datum_sandbox_wasmtime._clock import THREAD_NAME, deadline_ticks
from datum_sandbox_wasmtime._memory import PAGE, reservation
from datum_sandbox_wasmtime._qjs import load_qjs

pytestmark = pytest.mark.runtime

SPIN = f"print('{STARTED}'); for (;;) {{}}"
TICK = 0.05


@pytest.fixture(scope="module")
def work_dir() -> Iterator[Path]:
    path = Path(tempfile.mkdtemp(prefix="datum-wasmtime-test-"))
    yield path
    shutil.rmtree(path, ignore_errors=True)


@pytest.fixture(scope="module")
def runtime(work_dir: Path) -> Iterator[WasmtimeGuestRuntime]:
    made = WasmtimeGuestRuntime(datum_limits(4, 2, work_dir, TICK), EngineSettings(stop_grace=5.0))
    yield made
    made.close()


@pytest.fixture
def store_closes(monkeypatch: pytest.MonkeyPatch) -> list[wasmtime.Store]:
    """The stores MADE DURING THE TEST and closed so far, once each.

    A finalizer's second close of the same store is not counted, and neither is a finalizer closing a store an earlier
    test left to the garbage collector (that race made the count read 9 for 1 under pytest-randomly), so the stores
    are recorded at construction and only those count.
    """
    gc.collect()
    made: list[wasmtime.Store] = []
    closed: list[wasmtime.Store] = []
    original_init = wasmtime.Store.__init__
    original_close = wasmtime.Store.close

    def making(self: wasmtime.Store, *args: Any, **kwargs: Any) -> None:
        original_init(self, *args, **kwargs)
        made.append(self)

    def counting(self: wasmtime.Store) -> None:
        if any(seen is self for seen in made) and not any(seen is self for seen in closed):
            closed.append(self)
        original_close(self)

    monkeypatch.setattr(wasmtime.Store, "__init__", making)
    monkeypatch.setattr(wasmtime.Store, "close", counting)
    return closed


def _io(app: Path, stdin: Path) -> GuestIo:
    return GuestIo(
        app_dir=app,
        stdin_path=stdin,
        stdout=OutputSink(1024),
        stderr=OutputSink(1024),
        argv=("qjs", "--std", "/app/run.js"),
        entropy=lambda n: b"\0" * n,
    )


# -- registration and description -----------------------------------------------------------------------------------


def test_the_engine_is_registered_as_wasmtime_and_discoverable() -> None:
    found = GuestRuntimes.discover()
    entries = [item for item in found.listing if item.id == ENGINE_ID]
    assert entries, f"no 'wasmtime' entry in the {GROUP} group: re-sync the workspace after the entry point landed"
    assert entries[0].distribution == "argusvane-datum-sandbox-wasmtime"
    assert isinstance(found.select(ENGINE_ID), WasmtimeProvider)


def test_engine_info_names_the_release_the_mode_and_the_guest(runtime: WasmtimeGuestRuntime) -> None:
    info = runtime.engine_info()
    assert info.id == "wasmtime"
    assert info.release.split(".")[0].isdigit()
    assert info.mode in {"cranelift", "pulley"}
    notes = " ".join(info.notes)
    assert "sha256" in notes
    assert "fuel off" in notes
    reserved, growth = reservation(32 * MIB, 256 * MIB)
    assert f"reservation {reserved} bytes, growth {growth} bytes, guard 0" in notes


def test_the_memory_floor_is_the_modules_initial_pages(runtime: WasmtimeGuestRuntime) -> None:
    assert runtime.memory_floor > 0
    assert runtime.memory_floor % PAGE == 0


def test_a_run_budget_below_the_floor_is_the_e003_refusal(runtime: WasmtimeGuestRuntime) -> None:
    with pytest.raises(EngineConfigurationError) as caught:
        run_raw(
            runtime,
            "print(1);",
            RunBudget(wall_seconds=5, memory_bytes=runtime.memory_floor - PAGE, wait=30, pool=PoolKind.VALIDATION),
        )
    assert isinstance(caught.value, MemoryFloorError)
    assert (
        run_raw(
            runtime, "print(1);", RunBudget(wall_seconds=5, memory_bytes=32 * MIB, wait=30, pool=PoolKind.VALIDATION)
        ).end
        is RunEnd.CLEAN
    )


def test_a_reservation_below_the_floor_refuses_the_start(tmp_path: Path) -> None:
    with pytest.raises(EngineConfigurationError) as caught:
        WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, validation_memory=PAGE))
    assert isinstance(caught.value, MemoryFloorError)
    assert "datum.runtime.validation.memory" in str(caught.value)


def test_a_tampered_own_guest_copy_refuses_the_start(tmp_path: Path) -> None:
    copy = tmp_path / "qjs.wasm"
    copy.write_bytes(b"\0asm\1\0\0\0")
    with pytest.raises(EngineConfigurationError, match="SHA-256"):
        WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path), qjs_path=copy)


def test_the_start_sweeps_leftover_run_directories_older_than_the_longest_budget(tmp_path: Path) -> None:
    old = tmp_path / "datum-run-left-by-a-crash"
    (old / "app").mkdir(parents=True)
    (old / "app" / "program.js").write_bytes(b"x")
    fresh = tmp_path / "datum-run-in-use"
    fresh.mkdir()
    other = tmp_path / "not-a-run"
    other.mkdir()
    hour_ago = time.time() - 3600
    os.utime(old, (hour_ago, hour_ago))
    os.utime(other, (hour_ago, hour_ago))
    own = WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK))
    try:
        assert not old.exists()
        assert fresh.exists()
        assert other.exists()
    finally:
        own.close()


# -- stores and run directories -------------------------------------------------------------------------------------


def test_every_store_is_closed_and_every_run_directory_removed(
    runtime: WasmtimeGuestRuntime, work_dir: Path, store_closes: list[wasmtime.Store]
) -> None:
    results = [run_raw(runtime, script, budget(5, 32)) for script in ("print(1);", "std.exit(3);", "throw 1;", SPIN)]
    assert [r.end for r in results] == [RunEnd.CLEAN, RunEnd.EXIT, RunEnd.EXIT, RunEnd.BUDGET]
    assert len(store_closes) == len(results), "each run's store was closed by its stack before the run returned"
    assert runtime.clock.armed == 0, "every store was disarmed (its run's stack closed)"
    assert not [p for p in work_dir.iterdir() if p.name.startswith("datum-run-")], "every run directory is gone"


def test_an_instantiate_failure_closes_what_it_opened(
    runtime: WasmtimeGuestRuntime, tmp_path: Path, store_closes: list[wasmtime.Store]
) -> None:
    app = tmp_path / "app"
    app.mkdir()
    with pytest.raises(Exception):  # noqa: B017, PT011 - the binding's own error type for a missing stdin file
        runtime.instantiate(_io(app, tmp_path / "no-such-stdin"), budget(5, 32))
    assert runtime.clock.armed == 0
    assert len(store_closes) == 1, "the store the failed instantiate opened was closed before it raised"


def test_an_instance_reads_its_ends_in_the_ruled_order(runtime: WasmtimeGuestRuntime, tmp_path: Path) -> None:
    import wasmtime  # noqa: PLC0415 - the binding's own exception types

    app = tmp_path / "app"
    app.mkdir()
    (tmp_path / "stdin").write_bytes(b"")
    instance = runtime.instantiate(_io(app, tmp_path / "stdin"), budget(5, 32))
    try:
        assert instance.classify(wasmtime.Trap("no code")).kind is GuestEndKind.TRAP
        assert instance.classify(wasmtime.WasmtimeError("broken")).kind is GuestEndKind.TRAP
        assert instance.classify(ValueError("already closed")).kind is GuestEndKind.TRAP
    finally:
        instance.close()
    assert runtime.clock.armed == 0


def test_a_trap_with_memory_at_the_store_limit_is_the_memory_end(runtime: WasmtimeGuestRuntime, tmp_path: Path) -> None:
    app = tmp_path / "app"
    app.mkdir()
    (tmp_path / "stdin").write_bytes(b"")
    cap_pages = (32 * MIB) // PAGE
    at_cap = runtime.instantiate(_io(app, tmp_path / "stdin"), budget(5, 32))
    try:
        memory = at_cap._memory
        assert memory is not None
        memory.grow(at_cap._store, cap_pages - memory.size(at_cap._store))
        assert at_cap.classify(wasmtime.Trap("no code")).kind is GuestEndKind.MEMORY
    finally:
        at_cap.close()
    below = runtime.instantiate(_io(app, tmp_path / "stdin"), budget(5, 32))
    try:
        memory = below._memory
        assert memory is not None
        memory.grow(below._store, cap_pages - 1 - memory.size(below._store))
        assert below.classify(wasmtime.Trap("no code")).kind is GuestEndKind.TRAP
    finally:
        below.close()


def test_a_stop_asked_before_the_guest_starts_ends_it_at_once(runtime: WasmtimeGuestRuntime, tmp_path: Path) -> None:
    import wasmtime  # noqa: PLC0415

    app = tmp_path / "app"
    app.mkdir()
    (app / "run.js").write_text(SPIN, encoding="utf-8")
    (tmp_path / "stdin").write_bytes(b"")
    io = _io(app, tmp_path / "stdin")
    instance = runtime.instantiate(io, budget(60, 32))
    try:
        instance.request_stop()
        began = time.monotonic()
        with pytest.raises(wasmtime.Trap) as caught:
            instance.start()
        assert time.monotonic() - began < 1.0
        assert instance.classify(caught.value).kind is GuestEndKind.INTERRUPT
        assert io.stdout.value() == b"", "it never ran"
    finally:
        instance.close()


def test_the_wall_budget_ends_a_loop_within_two_ticks(runtime: WasmtimeGuestRuntime) -> None:
    wall = 0.5
    result = run_raw(runtime, SPIN, budget(wall, 32))
    assert result.end is RunEnd.BUDGET
    assert result.stdout == f"{STARTED}\n".encode()
    assert wall - TICK <= result.elapsed < wall + 2 * TICK + 0.2, result.elapsed
    assert deadline_ticks(wall, TICK) == 11


def test_the_run_budget_arms_the_store_with_exactly_its_wall_seconds(
    runtime: WasmtimeGuestRuntime, monkeypatch: pytest.MonkeyPatch
) -> None:
    armed: list[float] = []
    deadlines: list[int] = []
    arm = runtime.clock.arm
    set_deadline = wasmtime.Store.set_epoch_deadline

    def arm_spy(store: wasmtime.Store, seconds: float) -> int:
        armed.append(seconds)
        return arm(store, seconds)

    def deadline_spy(self: wasmtime.Store, ticks: int) -> None:
        deadlines.append(ticks)
        set_deadline(self, ticks)

    monkeypatch.setattr(runtime.clock, "arm", arm_spy)
    monkeypatch.setattr(wasmtime.Store, "set_epoch_deadline", deadline_spy)
    assert run_raw(runtime, "print(1);", budget(5, 32)).end is RunEnd.CLEAN
    assert armed == [5.0], "armed once, with the budget itself and no allowance"
    assert deadlines == [deadline_ticks(5.0, TICK)]


def test_the_engine_settings_and_the_store_limits_are_the_ruled_ones(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    recorded: dict[str, object] = {}
    base = wasmtime.Config

    class RecordingConfig(base):  # type: ignore[valid-type, misc]
        def __setattr__(self, name: str, value: object) -> None:
            recorded[name] = value
            super().__setattr__(name, value)

    limits: list[dict[str, int]] = []
    set_limits = wasmtime.Store.set_limits

    def limits_spy(self: wasmtime.Store, **kwargs: int) -> None:
        limits.append(kwargs)
        set_limits(self, **kwargs)

    monkeypatch.setattr(wasmtime, "Config", RecordingConfig)
    monkeypatch.setattr(wasmtime.Store, "set_limits", limits_spy)
    own = WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK))
    try:
        reserved, growth = reservation(32 * MIB, 256 * MIB)
        assert recorded["epoch_interruption"] is True
        assert recorded["consume_fuel"] is False
        assert recorded["memory_guard_size"] == 0
        assert recorded["memory_reservation"] == reserved
        assert recorded["memory_reservation_for_growth"] == growth
        limits.clear()
        assert run_raw(own, "print(1);", budget(5, 32)).end is RunEnd.CLEAN
        assert limits == [{"memory_size": 32 * MIB, "instances": 1, "memories": 1, "tables": 1}]
    finally:
        own.close()


MMAP_TEXT = "mmap failed to reserve 0x2000000 bytes\n\nCaused by:\n    Out of memory (os error 12)"


def test_the_start_up_store_turns_an_address_space_refusal_into_the_start_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, store_closes: list[wasmtime.Store]
) -> None:
    def refuse(self: wasmtime.InstancePre, store: wasmtime.Store) -> object:
        raise wasmtime.WasmtimeError(MMAP_TEXT)

    before = live_threads()
    monkeypatch.setattr(wasmtime.InstancePre, "instantiate", refuse)
    with pytest.raises(EngineConfigurationError) as caught:
        WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK))
    message = str(caught.value)
    assert "datum.runtime.validation.memory" in message
    assert str(0x2000000) in message
    assert "ulimit -v" in message
    assert len(store_closes) == 1, "the throwaway store was closed"
    assert not [t for t in live_threads() - before if t.name == THREAD_NAME], "no clock thread was started"


def test_any_other_instantiate_error_at_start_is_the_generic_start_refusal(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(self: wasmtime.InstancePre, store: wasmtime.Store) -> object:
        raise wasmtime.WasmtimeError("some other failure")

    monkeypatch.setattr(wasmtime.InstancePre, "instantiate", refuse)
    with pytest.raises(EngineConfigurationError, match="could not instantiate the guest module at start"):
        WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK))


def test_a_store_that_cannot_grow_to_the_pdf_cap_refuses_the_start_naming_the_pdf_setting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    def refuse(self: wasmtime.Memory, store: wasmtime.Store, delta: int) -> int:
        raise wasmtime.WasmtimeError("failed to grow memory")

    before = live_threads()
    monkeypatch.setattr(wasmtime.Memory, "grow", refuse)
    with pytest.raises(EngineConfigurationError) as caught:
        WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK))
    message = str(caught.value)
    assert "datum.runtime.pdf.memory" in message
    assert str(32 * MIB + 224 * MIB) in message
    assert "ulimit -v" in message
    assert not [t for t in live_threads() - before if t.name == THREAD_NAME]


# -- how a run ends at the memory limit -----------------------------------------------------------------------------


def test_a_guest_that_ends_at_the_store_limit_is_the_memory_end(runtime: WasmtimeGuestRuntime) -> None:
    script = f"print('{STARTED}'); var a = []; for (;;) {{ a.push({{ x: a.length }}); }}"
    result = run_raw(runtime, script, budget(20, 32))
    assert result.end is RunEnd.MEMORY, result.stderr
    assert result.exit_code is None
    assert "at the memory limit" in result.detail
    assert result.stdout == f"{STARTED}\n".encode()


def test_a_guest_that_runs_out_of_memory_below_the_limit_is_an_exit(runtime: WasmtimeGuestRuntime) -> None:
    script = f"print('{STARTED}'); var a = []; for (;;) {{ a.push(new ArrayBuffer(1 << 20)); }}"
    result = run_raw(runtime, script, budget(20, 32))
    assert result.end is RunEnd.EXIT
    assert result.exit_code == 1
    assert b"InternalError: out of memory" in result.stderr


def test_an_epoch_deadline_after_memory_was_exhausted_is_the_budget_not_memory(runtime: WasmtimeGuestRuntime) -> None:
    script = "var a = []; try { for (;;) { a.push({ x: a.length }); } } catch (e) {} for (;;) {}"
    result = run_raw(runtime, script, budget(5, 32))
    assert result.end is RunEnd.BUDGET, "the interrupt is read before the memory limit"


# -- a guest waiting in WASI poll_oneoff (the engine's own, cut to the wall budget) ----------------------------------


def test_a_raw_sleep_past_the_budget_ends_at_the_budget_with_no_stuck_run_and_no_stray(tmp_path: Path) -> None:
    own = WasmtimeGuestRuntime(datum_limits(2, 1, tmp_path, TICK), EngineSettings(stop_grace=0.5, stray_bound=1))
    try:
        result = run_raw(own, f"print('{STARTED}'); os.sleep(60000); print('woke');", budget(0.5, 32))
        assert result.end is RunEnd.BUDGET, result.stderr
        assert result.stdout == f"{STARTED}\n".encode(), "the guest never ran past the cut sleep"
        assert 0.5 - TICK <= result.elapsed < 0.5 + 2 * TICK + 0.2, result.elapsed
        stats = own.stats()["validation"]
        assert (stats.stuck_runs, stats.stray_runs) == (0, 0)
        assert settle(lambda: own.stats()["validation"].slots_in_use == 0, timeout=1)
        assert run_raw(own, "print(1);", budget(5, 32)).end is RunEnd.CLEAN, "no stray holds the one slot"

        nonce = new_nonce()
        run_budget = budget(0.5, 32)
        sleeper = RuleModule(
            "probe", "1", "(import('qjs:os').then(function (m) { m.sleep(60000); }), { validators: [] })"
        )
        slept = sandbox_run(own, nonce, run_budget, rules=[sleeper])
        assert slept.end is RunEnd.BUDGET
        with pytest.raises(SandboxError) as failed:
            sandbox_answer(slept, nonce, run_budget)
        assert failed.value.reason is SandboxFailure.BUDGET
        assert failed.value.guest_stopped is True, "the rule's own sleep, after the started marker"
        assert own.stats()["validation"].stray_runs == 0
    finally:
        own.close()


@pytest.mark.parametrize(
    "tail",
    [
        "os.setTimeout(function () { print('woke'); }, 60000);",
        "function chain() { os.setTimeout(chain, 30); } chain();",
        "os.setReadHandler(0, function () {}); os.setTimeout(function () { print('woke'); }, 60000);",
    ],
    ids=["long-timer", "timer-chain", "read-handler-and-long-timer"],
)
def test_a_timer_loop_past_the_budget_ends_at_the_budget_with_no_stuck_run_and_no_stray(
    tmp_path: Path, tail: str
) -> None:
    own = WasmtimeGuestRuntime(datum_limits(2, 1, tmp_path, TICK), EngineSettings(stop_grace=0.5, stray_bound=1))
    try:
        result = run_raw(own, f"print('{STARTED}'); {tail}", budget(0.5, 32))
        assert result.end is RunEnd.BUDGET, result.stderr
        assert result.stdout == f"{STARTED}\n".encode(), "nothing ran after the cut"
        stats = own.stats()["validation"]
        assert (stats.stuck_runs, stats.stray_runs) == (0, 0)
    finally:
        own.close()


def test_a_single_allocation_larger_than_the_room_left_is_an_exit(runtime: WasmtimeGuestRuntime) -> None:
    """Pinned: the run THREW, it is not a memory end."""
    result = run_raw(runtime, f"print('{STARTED}'); new ArrayBuffer(64 << 20);", budget(20, 32))
    assert result.end is RunEnd.EXIT
    assert result.exit_code == 1


def test_a_short_sleep_and_a_timer_inside_the_budget_still_take_their_time(runtime: WasmtimeGuestRuntime) -> None:
    script = (
        "var t = Date.now(); os.sleep(300); print(Date.now() - t >= 290);"
        "var u = Date.now(); os.setTimeout(function () { print(Date.now() - u >= 190); }, 200);"
    )
    result = run_raw(runtime, script, budget(5, 32))
    assert result.end is RunEnd.CLEAN, result.stderr
    assert result.stdout == b"true\ntrue\n"
    assert 0.45 <= result.elapsed < 2.0, result.elapsed


def test_a_read_handler_on_stdin_is_called_at_once(runtime: WasmtimeGuestRuntime) -> None:
    script = "os.setReadHandler(0, function () { print(std.in.getline()); os.setReadHandler(0, null); });"
    result = run_raw(runtime, script, budget(5, 32), stdin=b"hello\n")
    assert result.end is RunEnd.CLEAN, result.stderr
    assert result.stdout == b"hello\n"
    assert result.elapsed < 2.0


def test_shutdown_wakes_a_sleeping_guest_at_once_as_interrupted(tmp_path: Path) -> None:
    own = WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK), EngineSettings(stop_grace=5.0))
    ends: list[RunEnd] = []
    worker = threading.Thread(target=lambda: ends.append(run_raw(own, "os.sleep(60000);", budget(60, 32)).end))
    worker.start()
    assert settle(lambda: own.stats()["validation"].runs_in_flight == 1, timeout=10)
    time.sleep(0.3)
    began = time.monotonic()
    own.close()
    assert time.monotonic() - began < 1.0, "the sleep was woken, not waited out"
    worker.join(5)
    assert ends == [RunEnd.INTERRUPTED]


def test_poll_oneoff_is_the_one_shadowed_import_with_the_wasi_preview1_signature(
    runtime: WasmtimeGuestRuntime,
) -> None:
    from datum_sandbox_wasmtime import _poll  # noqa: PLC0415 - the shadow's own module

    module = wasmtime.Module(wasmtime.Engine(), load_qjs().data)
    imports = {(item.module, item.name): item.type for item in module.imports}
    wanted = imports[(_poll.WASI_MODULE, _poll.NAME)]
    assert isinstance(wanted, wasmtime.FuncType)
    shadow = _poll.poll_oneoff_type()
    assert [str(t) for t in wanted.params] == [str(t) for t in shadow.params] == ["i32"] * 4
    assert [str(t) for t in wanted.results] == [str(t) for t in shadow.results] == ["i32"]
    assert "poll_oneoff" in " ".join(runtime.engine_info().notes)


# -- memory: the budget above the reservation, and exit 0 at the cap -----------------------------------------------


def test_exit_zero_after_filling_memory_to_the_cap_is_clean(runtime: WasmtimeGuestRuntime) -> None:
    script = (
        f"print('{STARTED}'); var a = []; try {{ for (;;) {{ a.push({{ x: a.length }}); }} }} catch (e) {{}} "
        "a = null; std.exit(0);"
    )
    result = run_raw(runtime, script, budget(20, 32))
    assert result.end is RunEnd.CLEAN, (result.end, result.detail, result.stderr)
    assert result.exit_code == 0


def test_a_budget_above_the_reservation_and_growth_is_logged_once_per_process(
    runtime: WasmtimeGuestRuntime, caplog: pytest.LogCaptureFixture, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(runtime_module, "_BEYOND_RESERVATION", threading.Event())
    reserved, growth = reservation(32 * MIB, 256 * MIB)
    with caplog.at_level("WARNING", logger="datum.runtime"):
        assert run_raw(runtime, "print(1);", budget(5, 256)).end is RunEnd.CLEAN
        assert not caplog.records, "a budget within the reservation and growth says nothing"
        for _ in range(3):
            assert run_raw(runtime, "print(1);", budget(5, 300)).end is RunEnd.CLEAN
    warned = [record for record in caplog.records if "reservation plus growth" in record.getMessage()]
    assert len(warned) == 1, [record.getMessage() for record in caplog.records]
    assert warned[0].levelname == "WARNING"
    assert str(300 * MIB) in warned[0].getMessage()
    assert str(reserved + growth) in warned[0].getMessage()


def test_the_engine_id_is_defined_once_by_the_provider() -> None:
    sources = Path(runtime_module.__file__).parent.glob("*.py")
    pattern = re.compile(r"^ENGINE_ID\s*(:[^=\n]*)?=", re.MULTILINE)
    defining = sorted(path.name for path in sources if pattern.search(path.read_text(encoding="utf-8")))
    assert defining == ["_provider.py"]
    assert ENGINE_ID == "wasmtime"


# -- both pools ----------------------------------------------------------------------------------------------------


def test_the_pdf_pool_runs_the_pdf_program_beside_the_validation_pool(runtime: WasmtimeGuestRuntime) -> None:
    request = json.dumps({"abi": PDF_ABI_MIN, "op": "capabilities"}).encode()
    pdf_budget = budget(60, 256, pool=PoolKind.PDF)
    result = runtime.run(program_run(pdf_program().data, PDF_RUN_SCRIPT.encode(), request, pdf_budget))
    assert result.end is RunEnd.CLEAN, result.stderr
    assert b'"ok":true' in result.stdout
    stats = runtime.stats()
    assert stats["pdf"].slots == 2
    assert stats["validation"].slots == 4
    assert stats["pdf"].slots_in_use == stats["validation"].slots_in_use == 0


def test_a_budget_runs_in_the_pool_it_names(runtime: WasmtimeGuestRuntime) -> None:
    seen: dict[PoolKind, tuple[int, int]] = {}
    for pool in PoolKind:
        worker = threading.Thread(target=run_raw, args=(runtime, SPIN, budget(1.0, 32, pool=pool)))
        worker.start()
        assert settle(lambda: sum(s.runs_in_flight for s in runtime.stats().values()) == 1, timeout=10)
        stats = runtime.stats()
        seen[pool] = (stats["validation"].runs_in_flight, stats["pdf"].runs_in_flight)
        worker.join(10)
    assert seen == {PoolKind.VALIDATION: (1, 0), PoolKind.PDF: (0, 1)}


# -- start-up costs -------------------------------------------------------------------------------------------------


def test_the_start_up_and_per_run_copy_costs_are_recorded(
    runtime: WasmtimeGuestRuntime, capsys: pytest.CaptureFixture[str], tmp_path: Path
) -> None:
    timings = runtime.timings
    assert timings.compile > 0
    program = sandbox_program().data
    copies: list[float] = []
    for index in range(50):
        began = time.perf_counter()
        target = tmp_path / f"run-{index}"
        target.mkdir(mode=0o700)
        (target / "program.js").write_bytes(program)
        shutil.rmtree(target)
        copies.append(time.perf_counter() - began)
    copies.sort()
    with capsys.disabled():
        print(  # noqa: T201 - the verify step reads this line
            f"\n[wasmtime start-up] load {timings.load * 1000:.1f} ms, compile {timings.compile * 1000:.0f} ms, "
            f"throwaway store {timings.probe * 1000:.1f} ms; per-run program copy p50 "
            f"{copies[len(copies) // 2] * 1000:.2f} ms, max {copies[-1] * 1000:.2f} ms ({len(program)} bytes)"
        )


# -- shutdown -------------------------------------------------------------------------------------------------------


def test_shutdown_interrupts_both_pools_and_leaves_only_the_threads_it_found(tmp_path: Path) -> None:
    before = live_threads()
    own = WasmtimeGuestRuntime(datum_limits(2, 1, tmp_path, TICK), EngineSettings(stop_grace=5.0))
    results: list[RunEnd] = []
    guard = threading.Lock()

    def one(pdf: bool) -> None:
        pool = PoolKind.PDF if pdf else PoolKind.VALIDATION
        argv = ("qjs", "--std", "/app/run.js")
        files = {APP_PROGRAM: sandbox_program().data, APP_RUN_SCRIPT: SPIN.encode()}
        result = own.run(GuestRun(app_files=files, argv=argv, stdin=b"", budget=budget(60, 32, pool=pool)))
        with guard:
            results.append(result.end)

    workers = [threading.Thread(target=one, args=(pdf,)) for pdf in (False, False, True)]
    for worker in workers:
        worker.start()
    assert settle(lambda: sum(s.runs_in_flight for s in own.stats().values()) == 3, timeout=10)
    time.sleep(0.3)
    began = time.monotonic()
    own.close()
    assert time.monotonic() - began < 2.0
    for worker in workers:
        worker.join(10)
    assert results == [RunEnd.INTERRUPTED] * 3
    assert not [t for t in live_threads() - before if t.name in {THREAD_NAME, "datum-run"}], "gone at once"
    assert settle(lambda: live_threads() <= before), sorted(t.name for t in live_threads() - before)
    with pytest.raises(EngineClosedError):
        own.run(GuestRun(app_files={}, argv=("qjs",), stdin=b"", budget=budget(5, 32, pool=PoolKind.PDF)))
    own.close()


def test_shutdown_marks_the_runs_interrupted_before_the_epoch_advances(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    own = WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, TICK))
    events: list[str] = []
    interrupt = RunHarness.interrupt
    harness_close = RunHarness.close
    advance = own.clock.advance_past_every_deadline
    clock_close = own.clock.close

    def interrupt_spy(self: RunHarness) -> int:
        events.append("interrupt")
        return interrupt(self)

    def close_spy(self: RunHarness, timeout: float = 0.0) -> int:
        events.append("harness.close")
        return harness_close(self, timeout)

    def advance_spy() -> int:
        events.append("advance")
        return advance()

    def clock_close_spy() -> None:
        events.append("clock.close")
        clock_close()

    monkeypatch.setattr(RunHarness, "interrupt", interrupt_spy)
    monkeypatch.setattr(RunHarness, "close", close_spy)
    monkeypatch.setattr(own.clock, "advance_past_every_deadline", advance_spy)
    monkeypatch.setattr(own.clock, "close", clock_close_spy)
    own.close()
    assert events == ["interrupt", "interrupt", "advance", "harness.close", "harness.close", "clock.close"]
