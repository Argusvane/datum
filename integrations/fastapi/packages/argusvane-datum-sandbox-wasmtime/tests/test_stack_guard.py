"""The shadow stack guard: QuickJS's C stack running into the module's statics is a trap, never an answer.

The pinned `qjs-wasi.wasm` keeps wasm-ld's 64 KiB shadow stack above its static data and QuickJS-ng checks no stack
under WASI, so plain JavaScript recursion of about 190 frames overwrites the statics before wasmtime's own stack check
fires. These cases hold the guard to that: ordinary depth is untouched, recursion past the stack is a trap however the
guest ended, a frame that reserves more than it writes cannot step over the canary into `.bss`, a touched canary or
`.rodata` byte is an overrun even when the guest then exits 0, and a module the guard cannot read refuses the start
unless running unguarded is allowed. Nothing here runs under xdist.
"""

import hashlib
import logging
import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
import wasmtime
from guests import datum_limits

from datum_sandbox.testing.runtime_support import budget, run_raw
from datum_sandbox.wasi import EngineConfigurationError, EngineSettings, GuestEndKind, GuestIo, OutputSink, RunEnd
from datum_sandbox_wasmtime import WasmtimeGuestRuntime
from datum_sandbox_wasmtime._qjs import load_qjs
from datum_sandbox_wasmtime._runtime import WasmtimeInstance
from datum_sandbox_wasmtime._stack import (
    CANARY,
    STACK_SIZE,
    StackGuard,
    StackOverrunError,
    describe_unguarded,
    stack_guard,
)

pytestmark = pytest.mark.runtime

OVERRUN = "the guest's shadow stack reached its floor"


@pytest.fixture(scope="module")
def runtime() -> Iterator[WasmtimeGuestRuntime]:
    work_dir = Path(tempfile.mkdtemp(prefix="datum-wasmtime-stack-"))
    made = WasmtimeGuestRuntime(datum_limits(2, 1, work_dir, 0.05), EngineSettings(stop_grace=5.0))
    yield made
    made.close()
    shutil.rmtree(work_dir, ignore_errors=True)


@pytest.fixture(scope="module")
def guard() -> StackGuard:
    found = stack_guard(load_qjs().data)
    assert found is not None, "the pinned guest names its stack pointer and its .rodata"
    return found


def _recurse(depth: int) -> str:
    return f"var f = function (n) {{ return n === {depth} ? 0 : f(n + 1) + 1; }}; print(f(0));"


def _instance(runtime: WasmtimeGuestRuntime, tmp_path: Path, script: str) -> WasmtimeInstance:
    app = tmp_path / "app"
    app.mkdir()
    (app / "run.js").write_text(script)
    (tmp_path / "stdin").write_bytes(b"")
    io = GuestIo(
        app_dir=app,
        stdin_path=tmp_path / "stdin",
        stdout=OutputSink(1024),
        stderr=OutputSink(1024),
        argv=("qjs", "--std", "/app/run.js"),
        entropy=lambda n: b"\0" * n,
    )
    return runtime.instantiate(io, budget(10, 32))


def test_the_pinned_guest_has_its_stack_above_its_statics(guard: StackGuard, runtime: WasmtimeGuestRuntime) -> None:
    assert guard.top - guard.floor == STACK_SIZE
    assert guard.rodata, "the .rodata segment is compared"
    assert all(offset + len(data) <= guard.floor for offset, data in guard.rodata)
    assert f"shadow stack guard: {guard.floor}..{guard.top}" in " ".join(runtime.engine_info().notes)


@pytest.mark.parametrize("module", [b"", b"not wasm", b"\0asm\1\0\0\0"])
def test_a_module_without_the_layout_has_no_guard(module: bytes) -> None:
    assert stack_guard(module) is None


def test_ordinary_recursion_is_no_overrun(runtime: WasmtimeGuestRuntime) -> None:
    result = run_raw(runtime, _recurse(100), budget(10, 32))
    assert result.end is RunEnd.CLEAN, result.detail
    assert result.stdout == b"100\n"


def test_recursion_past_the_shadow_stack_is_a_trap_however_the_guest_ended(runtime: WasmtimeGuestRuntime) -> None:
    """Bounded recursion of 300 frames: the shadow stack overruns, wasmtime's 512 KiB wasm stack does not."""
    result = run_raw(runtime, _recurse(300), budget(10, 32))
    assert result.end is RunEnd.TRAP
    assert OVERRUN in result.detail
    assert run_raw(runtime, _recurse(100), budget(10, 32)).end is RunEnd.CLEAN, "the next run is fine"


@pytest.mark.parametrize("where", ["canary", "rodata"])
def test_a_touched_canary_or_rodata_byte_makes_a_clean_exit_a_trap(
    runtime: WasmtimeGuestRuntime, guard: StackGuard, tmp_path: Path, where: str
) -> None:
    instance = _instance(runtime, tmp_path, "print('done');")
    try:
        memory, store = instance._memory, instance._store
        assert memory is not None
        assert not instance._overran(), "armed and untouched"
        at = guard.floor + CANARY - 1 if where == "canary" else guard.rodata[0][0]
        memory.write(store, bytes([memory.read(store, at, at + 1)[0] ^ 0xFF]), at)
        with pytest.raises(StackOverrunError) as caught:
            instance.start()
        end = instance.classify(caught.value)
        assert end.kind is GuestEndKind.TRAP
        assert end.detail is not None
        assert end.detail.startswith(OVERRUN)
    finally:
        instance.close()


def _wide_frames(depth: int, width: int = 640) -> str:
    """Recursion whose every frame reserves room for a call of `width` arguments that it never makes."""
    zeros = ",".join(["0"] * width)
    return (
        "function g() { return 0; }\n"
        f"function f(n) {{ if (n > 0) return f(n - 1) + 0; if (n < 0) return g({zeros}); return 0; }}\n"
        f"print(f({depth}));"
    )


def test_a_frame_that_reserves_more_than_it_writes_cannot_step_over_the_canary(runtime: WasmtimeGuestRuntime) -> None:
    """Frames that reserve more stack than they write: one that would reach below the floor is a trap before it runs."""
    ends = {depth: run_raw(runtime, _wide_frames(depth), budget(10, 32)) for depth in range(16)}
    for depth, result in ends.items():
        if result.end is RunEnd.CLEAN:
            assert result.stdout == b"0\n", depth
        else:
            assert result.end is RunEnd.TRAP, (depth, result.end)
            assert OVERRUN in result.detail, (depth, result.detail)
    assert all(ends[depth].end is RunEnd.CLEAN for depth in range(8)), "ordinary depth is untouched"
    assert all(ends[depth].end is RunEnd.TRAP for depth in range(12, 16)), "a frame past the floor is a trap"


def test_a_stack_pointer_below_the_floor_traps_and_marks_the_canary(
    runtime: WasmtimeGuestRuntime, guard: StackGuard, tmp_path: Path
) -> None:
    instance = _instance(runtime, tmp_path, _wide_frames(15))
    try:
        memory, store = instance._memory, instance._store
        assert memory is not None
        with pytest.raises(StackOverrunError) as caught:
            instance.start()
        assert isinstance(caught.value.__cause__, wasmtime.Trap)
        assert memory.read(store, guard.floor, guard.floor + 1) != bytes([0xA5]), "the check's own mark"
    finally:
        instance.close()


def _own_module(tmp_path: Path, module: bytes) -> tuple[Path, str]:
    path = tmp_path / "own.wasm"
    path.write_bytes(module)
    return path, hashlib.sha256(module).hexdigest()


UNGUARDABLE = '(module (memory (export "memory") 1) (func (export "_start")))'
"""A module that names no stack pointer, as an own build without a name section does."""


def test_a_module_the_guard_cannot_read_refuses_the_start(tmp_path: Path) -> None:
    path, digest = _own_module(tmp_path, wasmtime.wat2wasm(UNGUARDABLE))
    with pytest.raises(EngineConfigurationError) as caught:
        WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path / "work", qjs_path=path, qjs_sha256=digest))
    assert "datum.runtime.allow_unguarded_stack" in caught.value.hint
    assert str(path) in caught.value.message


def test_a_module_the_guard_cannot_read_runs_when_allowed_and_says_so_at_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    path, digest = _own_module(tmp_path, wasmtime.wat2wasm(UNGUARDABLE))
    limits = datum_limits(1, 1, tmp_path / "work", qjs_path=path, qjs_sha256=digest, allow_unguarded_stack=True)
    with caplog.at_level(logging.WARNING, logger="datum.runtime"):
        own = WasmtimeGuestRuntime(limits)
    try:
        warned = [record for record in caplog.records if "without the shadow stack guard" in record.getMessage()]
        assert [record.levelname for record in warned] == ["WARNING"]
        assert "datum.runtime.allow_unguarded_stack" in warned[0].getMessage()
        assert describe_unguarded() in own.engine_info().notes
    finally:
        own.close()


def test_the_pinned_guest_starts_guarded_whatever_the_setting_says(tmp_path: Path) -> None:
    own = WasmtimeGuestRuntime(datum_limits(1, 1, tmp_path, allow_unguarded_stack=True))
    try:
        assert describe_unguarded() not in own.engine_info().notes
        assert any(note.startswith("shadow stack guard: ") for note in own.engine_info().notes)
    finally:
        own.close()
