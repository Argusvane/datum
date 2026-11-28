"""A run's store caps how many elements a table may hold (`TABLE_ELEMENTS`), with room over the pinned guest's table."""

import hashlib
from pathlib import Path

import pytest
import wasmtime
from guests import datum_limits

from datum_sandbox.testing.runtime_support import budget
from datum_sandbox.wasi import GuestEndKind, GuestIo, OutputSink
from datum_sandbox_wasmtime import WasmtimeGuestRuntime
from datum_sandbox_wasmtime._qjs import load_qjs
from datum_sandbox_wasmtime._runtime import TABLE_ELEMENTS

pytestmark = pytest.mark.runtime

GROWER = """(module
  (import "wasi_snapshot_preview1" "proc_exit" (func $exit (param i32)))
  (memory (export "memory") 1)
  (table 1 funcref)
  (func (export "_start")
    (call $exit (i32.add (i32.const 10) (i32.eq (table.grow (ref.null func) (i32.const BY)) (i32.const -1))))))
"""
"""Grows its one table by BY elements; exits 11 when the grow is refused, 10 when it is made."""


def _exit_code(tmp_path: Path, by: int) -> int | None:
    module = wasmtime.wat2wasm(GROWER.replace("BY", str(by)))
    path = tmp_path / "grower.wasm"
    path.write_bytes(module)
    limits = datum_limits(
        1,
        1,
        tmp_path / "work",
        qjs_path=path,
        qjs_sha256=hashlib.sha256(module).hexdigest(),
        allow_unguarded_stack=True,
    )
    runtime = WasmtimeGuestRuntime(limits, sweep_older_than=None)
    try:
        app = tmp_path / "app"
        app.mkdir(exist_ok=True)
        (tmp_path / "stdin").write_bytes(b"")
        io = GuestIo(
            app_dir=app,
            stdin_path=tmp_path / "stdin",
            stdout=OutputSink(64),
            stderr=OutputSink(64),
            argv=("grower",),
            entropy=lambda n: b"\0" * n,
        )
        instance = runtime.instantiate(io, budget(5, 32))
        try:
            with pytest.raises(wasmtime.ExitTrap) as caught:
                instance.start()
            end = instance.classify(caught.value)
            assert end.kind is GuestEndKind.EXIT
            return end.exit_code
        finally:
            instance.close()
    finally:
        runtime.close()


def test_a_table_grown_past_the_cap_is_refused(tmp_path: Path) -> None:
    assert _exit_code(tmp_path, TABLE_ELEMENTS) == 11


def test_a_table_grown_within_the_cap_is_grown(tmp_path: Path) -> None:
    assert _exit_code(tmp_path, TABLE_ELEMENTS - 1) == 10


def test_the_cap_leaves_room_over_the_pinned_guests_table() -> None:
    module = wasmtime.Module(wasmtime.Engine(), load_qjs().data)
    tables = [item.type for item in module.imports if isinstance(item.type, wasmtime.TableType)]
    assert not tables, "the pinned guest imports no table"
    raw = load_qjs().data
    # The table section (id 4) of the pinned guest: one funcref table, its minimum and maximum.
    at = 8
    sizes: list[tuple[int, int | None]] = []
    while at < len(raw):
        section, size, at = raw[at], *_uleb(raw, at + 1)
        if section == 4:
            flags, (minimum, cursor) = raw[at + 2], _uleb(raw, at + 3)
            sizes.append((minimum, _uleb(raw, cursor)[0] if flags & 1 else None))
        at += size
    assert len(sizes) == 1
    minimum, maximum = sizes[0]
    assert maximum == minimum, "the pinned guest's table cannot grow"
    assert 4 * minimum <= TABLE_ELEMENTS


def _uleb(data: bytes, at: int) -> tuple[int, int]:
    result = shift = 0
    while True:
        byte = data[at]
        at += 1
        result |= (byte & 0x7F) << shift
        shift += 7
        if not byte & 0x80:
            return result, at
