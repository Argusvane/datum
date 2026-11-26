"""The shadow stack guard: QuickJS's C stack running into the module's statics is a trap, never an answer.

The pinned `qjs-wasi.wasm` keeps wasm-ld's 64 KiB shadow stack above its static data and QuickJS-ng checks no stack
under WASI, so plain JavaScript recursion of about 190 frames overwrites the statics before wasmtime's own stack check
fires. These cases hold the guard to that: ordinary depth is untouched, recursion past the stack is a trap however the
guest ended, and a touched canary or `.rodata` byte is an overrun even when the guest then exits 0. Nothing here runs
under xdist.
"""

import shutil
import tempfile
from collections.abc import Iterator
from pathlib import Path

import pytest
from guests import datum_limits

from datum_sandbox.testing.runtime_support import budget, run_raw
from datum_sandbox.wasi import EngineSettings, GuestEndKind, GuestIo, OutputSink, RunEnd
from datum_sandbox_wasmtime import WasmtimeGuestRuntime
from datum_sandbox_wasmtime._qjs import load_qjs
from datum_sandbox_wasmtime._runtime import WasmtimeInstance
from datum_sandbox_wasmtime._stack import CANARY, STACK_SIZE, StackGuard, StackOverrunError, stack_guard

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
def test_a_module_without_the_layout_runs_unguarded(module: bytes) -> None:
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
