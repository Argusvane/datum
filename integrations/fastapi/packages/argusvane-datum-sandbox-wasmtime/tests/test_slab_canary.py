"""Slab canary: 16 threads x 200 Store + WasiConfig cycles with custom outputs, no corruption, no crosstalk.

What it guards. wasmtime-py keeps the Python callbacks of a `WasiConfig`'s custom stdout and stderr in a process-wide
table. On wasmtime 49.0.0 that table is a free list that is not thread safe, and wasmtime frees the entries on its own
tokio threads, outside any Python lock, so a lock around output set-up and disposal does not help. The failure on 49.0.0
(reproduced independently): with the GIL at a 1 microsecond switch interval, about 2,900 of 3,200 runs raised
`TypeError: list indices must be integers or slices, not function` and 142 to 306 duplicate handles were handed out;
81 to 177 runs received another run's bytes; and with a lock the table was still corrupt at the end (the free chain lost
6 to 22 entries). On the free-threaded build the default interval already failed (15 to 40 duplicate handles, "'int'
object is not callable" printed inside the callback glue). PR #344 replaced the table; the first release that
ships it is 50.0.0 (`wasmtime>=50,<51`), where the same run is clean on both builds (82 of 82 cells).

Two tests, split because a probabilistic race must not be a strict expected failure:

- the SHAPE test is deterministic: it reads the installed binding's output table and is `xfail(strict=True)` while
  the table has the 49.x free-list shape, so it passes (and its marker must go) the day the floor is 50;
- the STRESS test (16 threads x 200 cycles) is SKIPPED on the 49.x shape (a known-racy table: whether it fails
  on a given run is chance) and runs, as a hard requirement, on any other shape: the development environment
  carrying #344's table today, 50.0.0 later.

The condition is structural, not the installed version. The stress test's deciding audit is behavioural: an exception in
a run, a callback that received bytes that are not its own token (a duplicate handle shows up as that), a short or long
total, an unraisable exception, a thread that died with an exception, anything the binding printed on the process's
streams, and a thread left behind; a slab left corrupt is caught by a second round of sequential runs after the threads
are gone. This test is the one place allowed to read a private module of the binding: a guarded
read of `wasmtime._wasi.CUSTOM_OUTPUTS` decides the shape test's xfail and the stress test's skip and, when the table
has #344's shape (a `handles` mapping), adds a direct audit that every handle the runs took was given back. Product code
never reads it.
"""

import gc
import importlib
import sys
import threading
import time
from collections.abc import Sized
from dataclasses import dataclass, field
from importlib import metadata
from typing import Final

import pytest
import wasmtime
from guests import Clock, epoch_engine

pytestmark = pytest.mark.runtime

THREADS: Final = 16
CYCLES: Final = 200
WRITES: Final = 4
VERSION: Final = metadata.version("wasmtime")


def _output_table() -> object | None:
    """Return the binding's private table of custom-output callbacks, or None when it is not where 49.x keeps it."""
    try:
        wasi = importlib.import_module("wasmtime._wasi")
    except ImportError:
        return None
    table: object | None = getattr(wasi, "CUSTOM_OUTPUTS", None)
    return table


def _has_free_list_shape(table: object | None) -> bool:
    """Whether the table is 49.x's free list: a `list` of handles or links and a `next` free index, no `handles`."""
    return (
        table is not None
        and isinstance(getattr(table, "list", None), list)
        and isinstance(getattr(table, "next", None), int)
        and not hasattr(table, "handles")
    )


def _live_handles(table: object | None) -> int | None:
    """Return how many handles #344's table holds (its `handles` mapping), or None for any other shape."""
    handles = getattr(table, "handles", None)
    return len(handles) if isinstance(handles, Sized) else None


TABLE: Final = _output_table()
OLD_TABLE: Final = _has_free_list_shape(TABLE)

WAT_TEMPLATE: Final = """
(module
 (import "wasi_snapshot_preview1" "args_sizes_get" (func $asg (param i32 i32) (result i32)))
 (import "wasi_snapshot_preview1" "args_get" (func $ag (param i32 i32) (result i32)))
 (import "wasi_snapshot_preview1" "fd_write" (func $fw (param i32 i32 i32 i32) (result i32)))
 (memory (export "memory") 1)
 (func (export "_start") (local $i i32)
   (drop (call $asg (i32.const 0) (i32.const 4)))
   (drop (call $ag (i32.const 16) (i32.const 256)))
   (i32.store (i32.const 8) (i32.const 256))
   (i32.store (i32.const 12) (i32.load (i32.const 4)))
   (block $done (loop $l
     (br_if $done (i32.ge_u (local.get $i) (i32.const WRITES)))
     (drop (call $fw (i32.const 1) (i32.const 8) (i32.const 1) (i32.const 1024)))
     (drop (call $fw (i32.const 2) (i32.const 8) (i32.const 1) (i32.const 1024)))
     (local.set $i (i32.add (local.get $i) (i32.const 1)))
     (br $l)))))
"""
WAT: Final = WAT_TEMPLATE.replace("WRITES", str(WRITES))
"""A guest that writes its argv token (`g\\0<token>\\0`) four times to stdout and to stderr."""


def _cycle(engine: wasmtime.Engine, module: wasmtime.Module, linker: wasmtime.Linker, token: str) -> tuple[bool, bool]:
    """Run one Store + WasiConfig cycle; return whether its stdout and its stderr were exactly its own bytes."""
    want = (b"g\0" + token.encode() + b"\0") * WRITES
    out: list[bytes] = []
    err: list[bytes] = []
    store = wasmtime.Store(engine)
    try:
        store.set_limits(memory_size=64 << 20, instances=1, memories=1, tables=1)
        store.set_epoch_deadline(400)
        wasi = wasmtime.WasiConfig()
        wasi.argv = ["g", token]
        wasi.stdout_custom = out.append
        wasi.stderr_custom = err.append
        store.set_wasi(wasi)
        instance = linker.instantiate(store, module)
        start = instance.exports(store)["_start"]
        assert isinstance(start, wasmtime.Func)
        start(store)
    finally:
        store.close()
    return b"".join(out) == want, b"".join(err) == want


@dataclass
class Audit:
    """What the 16 threads saw: every way a corrupt output table shows up."""

    raised: list[str] = field(default_factory=list[str])
    wrong: list[str] = field(default_factory=list[str])
    crashed: list[str] = field(default_factory=list[str])
    unraisable: list[str] = field(default_factory=list[str])
    guard: threading.Lock = field(default_factory=threading.Lock)

    def note(self, kind: list[str], text: str) -> None:
        with self.guard:
            kind.append(text[:200])


def _hammer(engine: wasmtime.Engine, module: wasmtime.Module, linker: wasmtime.Linker) -> Audit:
    """Run `THREADS` workers of `CYCLES` cycles at a 1 microsecond switch interval and return what they saw."""
    audit = Audit()
    barrier = threading.Barrier(THREADS)

    def worker(index: int) -> None:
        barrier.wait()
        for cycle in range(CYCLES):
            token = f"T{index:02d}C{cycle:03d}"
            try:
                good_out, good_err = _cycle(engine, module, linker, token)
            except BaseException as error:
                audit.note(audit.raised, f"{token}: {type(error).__name__}: {error}")
                continue
            if not (good_out and good_err):
                audit.note(audit.wrong, token)

    old_interval = sys.getswitchinterval()
    old_thread_hook, old_unraisable_hook = threading.excepthook, sys.unraisablehook
    threading.excepthook = lambda args: audit.note(audit.crashed, repr(args.exc_value))
    sys.unraisablehook = lambda args: audit.note(audit.unraisable, repr(args.exc_value))
    sys.setswitchinterval(1e-6)
    try:
        threads = [threading.Thread(target=worker, args=(i,), name=f"canary-{i}") for i in range(THREADS)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join()
    finally:
        sys.setswitchinterval(old_interval)
        threading.excepthook, sys.unraisablehook = old_thread_hook, old_unraisable_hook
    return audit


def test_the_free_list_shape_reading_tells_the_two_tables_apart() -> None:
    """The structural condition reads 49.x's free list as old and #344's handle mapping as fixed; unknown is not old."""

    class FreeList:
        def __init__(self) -> None:
            self.list: list[object] = []
            self.next = 0

    class Handles:
        def __init__(self) -> None:
            self.handles: dict[int, object] = {}

    assert _has_free_list_shape(FreeList()) is True
    assert _has_free_list_shape(Handles()) is False
    assert _has_free_list_shape(None) is False
    assert _has_free_list_shape(object()) is False
    assert _live_handles(Handles()) == 0
    assert _live_handles(FreeList()) is None


@pytest.mark.xfail(OLD_TABLE, strict=True, reason=f"wasmtime {VERSION} has the thread-unsafe output table")
def test_the_installed_binding_does_not_have_the_49x_free_list_output_table() -> None:
    """The deterministic half of the canary: the custom-output table is not 49.x's thread-unsafe free list."""
    assert not _has_free_list_shape(TABLE), "the binding keeps custom outputs in 49.x's free list"


@pytest.mark.skipif(OLD_TABLE, reason=f"wasmtime {VERSION}: known-racy output table; the shape test pins it")
def test_sixteen_threads_cycle_stores_with_custom_outputs_without_corruption(
    capfd: pytest.CaptureFixture[str],
) -> None:
    engine = epoch_engine()
    module = wasmtime.Module(engine, WAT)
    linker = wasmtime.Linker(engine)
    linker.define_wasi()
    gc.collect()
    handles_before = _live_handles(TABLE)
    before = threading.active_count()
    clock = Clock(engine)
    try:
        audit = _hammer(engine, module, linker)
        gc.collect()
        # Sequential rounds after the threads are gone: a table left corrupt shows here as an exception or crosstalk.
        after_wrong = [t for t in (f"S{n:03d}" for n in range(64)) if _cycle(engine, module, linker, t) != (True, True)]
    finally:
        clock.close()
    gc.collect()
    time.sleep(0.05)  # let wasmtime's own threads drop their last entries

    assert audit.raised == [], f"{len(audit.raised)} of {THREADS * CYCLES} runs raised, first: {audit.raised[:3]}"
    assert audit.wrong == [], f"{len(audit.wrong)} runs received bytes that were not their own: {audit.wrong[:5]}"
    assert audit.crashed == []
    assert audit.unraisable == []
    assert after_wrong == [], "a corrupt output table shows in the runs that follow"
    seen = capfd.readouterr()
    assert (seen.out, seen.err) == ("", ""), "the binding printed a failed custom output on the process's streams"
    assert threading.active_count() <= before, "threads left behind"
    if handles_before is not None:
        # The direct audit, only on #344's shape: wasmtime gives entries back on its own threads, so allow a settle.
        deadline = time.monotonic() + 2.0
        while (_live_handles(TABLE) or 0) > handles_before and time.monotonic() < deadline:
            gc.collect()
            time.sleep(0.01)
        assert _live_handles(TABLE) == handles_before, "every handle the runs took was given back"
