"""WebAssembly guests and a small driver for the tests that exercise the wasmtime binding directly (no Datum engine)."""

import math
import threading
import time
from dataclasses import dataclass
from importlib import resources
from pathlib import Path
from typing import Final

import wasmtime

from datum_sandbox.wasi import EngineLimits, OutputSink


def datum_limits(
    validation_slots: int,
    pdf_slots: int,
    work_dir: Path,
    tick_seconds: float = 0.05,
    *,
    validation_memory: int = 32 << 20,
    pdf_memory: int = 256 << 20,
    qjs_path: Path | None = None,
    qjs_sha256: str | None = None,
    allow_unguarded_stack: bool = False,
) -> EngineLimits:
    """Return the engine limits of a Datum host: the validation and PDF pools and their two memory sizes."""
    return EngineLimits(
        pools={"validation": validation_slots, "pdf": pdf_slots},
        work_dir=work_dir,
        tick_seconds=tick_seconds,
        memory_bytes=validation_memory,
        max_memory_bytes=pdf_memory,
        module_path=qjs_path,
        module_sha256=qjs_sha256,
        allow_unguarded_stack=allow_unguarded_stack,
    )


TICK: Final = 0.05
"""The epoch clock tick in seconds (`datum.runtime.tick`)."""
LINE: Final = 1024

FINITE: Final = """(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\\10\\00\\00\\00\\00\\04\\00\\00")
  (func (export "_start") (local $i i32)
    (loop $l
      (drop (call $fd_write (i32.const FD) (i32.const 0) (i32.const 1) (i32.const 8)))
      (local.set $i (i32.add (local.get $i) (i32.const 1)))
      (br_if $l (i32.lt_u (local.get $i) (i32.const 4096))))))
"""
"""4096 writes of 1 KiB of zeros to descriptor FD, ignoring every result, then a plain return."""

ENDLESS: Final = """(module
  (import "wasi_snapshot_preview1" "fd_write" (func $fd_write (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (data (i32.const 0) "\\10\\00\\00\\00\\00\\04\\00\\00")
  (func (export "_start")
    (loop $l
      (drop (call $fd_write (i32.const FD) (i32.const 0) (i32.const 1) (i32.const 8)))
      (br $l))))
"""
"""Writes 1 KiB of zeros to descriptor FD without end."""


class Clock:
    """One epoch clock thread for an engine: the shape the product runs, a tick every 50 ms."""

    def __init__(self, engine: wasmtime.Engine) -> None:
        self._engine = engine
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name="test-clock", daemon=True)
        self._thread.start()

    def _run(self) -> None:
        while not self._stop.wait(TICK):
            self._engine.increment_epoch()

    def close(self) -> None:
        self._stop.set()
        self._thread.join()


def epoch_engine() -> wasmtime.Engine:
    """Return an engine with epoch interruption on and fuel off (`consume_fuel` stays off in the product)."""
    config = wasmtime.Config()
    config.epoch_interruption = True
    return wasmtime.Engine(config)


@dataclass
class Ended:
    """How one guest run ended and what its sink kept."""

    how: str
    sink: OutputSink
    seconds: float
    calls: int = 0
    exit_code: int | None = None
    trap: str = ""


class CountingSink:
    """An `OutputSink` that also counts the callbacks it received; it touches only its own state."""

    def __init__(self, cap: int) -> None:
        self.sink = OutputSink(cap)
        self.calls = 0

    def write(self, data: bytes) -> int:
        self.calls += 1
        return self.sink.write(data)


def run_guest(
    engine: wasmtime.Engine,
    module: wasmtime.Module,
    *,
    fd: int,
    cap: int,
    wall: float,
    argv: tuple[str, ...] = ("guest",),
    files: dict[str, bytes] | None = None,
    workdir: Path | None = None,
) -> Ended:
    """Run `_start` once the way the product does: one Store, callbacks that keep to the cap and return the full count.

    The callbacks never raise and never touch the Store; the guest is ended by its own return or by the epoch deadline
    (`ceil(wall / tick) + 1` ticks from the engine's clock thread).
    """
    counting = CountingSink(cap)
    store = wasmtime.Store(engine)
    store.set_limits(memory_size=64 * 1024 * 1024, instances=1, memories=1, tables=1)
    store.set_epoch_deadline(math.ceil(wall / TICK) + 1)
    wasi = wasmtime.WasiConfig()
    wasi.argv = list(argv)
    if fd == 1:
        wasi.stdout_custom = counting.write
    else:
        wasi.stderr_custom = counting.write
    if files:
        assert workdir is not None
        for name, data in files.items():
            (workdir / name).write_bytes(data)
            (workdir / name).chmod(0o400)
        wasi.preopen_dir(str(workdir), "/app", False)
    store.set_wasi(wasi)
    linker = wasmtime.Linker(engine)
    linker.define_wasi()
    began = time.perf_counter()
    try:
        instance = linker.instantiate(store, module)
        try:
            start = instance.exports(store)["_start"]
            assert isinstance(start, wasmtime.Func)
            start(store)
            ended = Ended("return", counting.sink, 0.0)
        except wasmtime.ExitTrap as error:
            ended = Ended("exit", counting.sink, 0.0, exit_code=error.code)
        except wasmtime.Trap as error:
            ended = Ended("trap", counting.sink, 0.0, trap=str(error.trap_code))
    finally:
        store.close()
    ended.seconds = time.perf_counter() - began
    ended.calls = counting.calls
    return ended


def qjs_module(engine: wasmtime.Engine) -> wasmtime.Module:
    """Compile the pinned `qjs-wasi.wasm` that `argusvane-datum-qjs-wasm` ships."""
    path = resources.files("datum_qjs_wasm") / "qjs-wasi.wasm"
    return wasmtime.Module(engine, path.read_bytes())
