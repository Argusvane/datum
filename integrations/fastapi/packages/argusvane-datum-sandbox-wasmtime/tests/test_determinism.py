"""The guest's clock and randomness come from its run: every run reads the same clock and the same random bytes.

QuickJS reads `clock_time_get` at start (its time origin, the seed of `Math.random`) and on every `Date.now`,
`performance.now` and `os.now`; a rule module reaches `os` through `import('qjs:os')`. The run's clock starts at zero
and moves only by the guest's own completed waits, so a sleep still takes its time and a timer still fires. Nothing here
runs under xdist.
"""

import json
import shutil
import tempfile
import threading
import time
from collections.abc import Iterator
from pathlib import Path

import pytest
import wasmtime
from guests import datum_limits

from datum_sandbox.testing.runtime_support import budget, run_raw
from datum_sandbox.wasi import EngineSettings, RunEnd
from datum_sandbox_wasmtime import WasmtimeGuestRuntime, _determinism, _poll
from datum_sandbox_wasmtime._determinism import REALTIME_EPOCH, GuestClock
from datum_sandbox_wasmtime._qjs import load_qjs

pytestmark = pytest.mark.runtime

READINGS = (
    "import('qjs:os').then(function (os) {"
    " print(JSON.stringify([Date.now(), new Date().toISOString(), os.now(), performance.now(),"
    " Math.random(), Math.random()])); });"
)
"""What a rule module can read of time and chance, through `qjs:os` and the language."""


@pytest.fixture(scope="module")
def runtime() -> Iterator[WasmtimeGuestRuntime]:
    work_dir = Path(tempfile.mkdtemp(prefix="datum-wasmtime-determinism-"))
    made = WasmtimeGuestRuntime(datum_limits(2, 1, work_dir, 0.05), EngineSettings(stop_grace=5.0))
    yield made
    made.close()
    shutil.rmtree(work_dir, ignore_errors=True)


def _read(runtime: WasmtimeGuestRuntime, script: str) -> list[object]:
    result = run_raw(runtime, script, budget(10, 32))
    assert result.end is RunEnd.CLEAN, result.stderr
    value = json.loads(result.stdout)
    assert isinstance(value, list)
    return value


def test_a_guest_reads_the_same_clock_and_random_values_on_every_run(runtime: WasmtimeGuestRuntime) -> None:
    first = _read(runtime, READINGS)
    time.sleep(0.05)
    assert _read(runtime, READINGS) == first
    assert _read(runtime, READINGS) == first
    assert first[:2] == [REALTIME_EPOCH // 1_000_000, "1970-01-01T00:00:00.000Z"], "the realtime clock is the epoch"
    assert first[2:4] == [0, 0], "the monotonic clock starts at zero"
    assert first[4] != first[5], "Math.random still varies within a run"


def test_a_sleep_moves_the_clock_by_exactly_its_own_length_and_still_takes_its_time(
    runtime: WasmtimeGuestRuntime,
) -> None:
    script = (
        "var a = [Date.now(), os.now()]; os.sleep(120); var b = [Date.now(), os.now()];"
        " os.setTimeout(function () { print(JSON.stringify([a, b, [Date.now(), os.now()]])); }, 80);"
    )
    began = time.monotonic()
    readings = _read(runtime, script)
    assert time.monotonic() - began >= 0.18, "the waits are real"
    assert readings == [[0, 0], [120, 120_000], [200, 200_000]]
    assert _read(runtime, script) == readings


def test_clock_time_get_and_random_get_have_the_wasi_preview1_signatures() -> None:
    module = wasmtime.Module(wasmtime.Engine(), load_qjs().data)
    imports = {(item.module, item.name): item.type for item in module.imports}
    wanted = imports[(_determinism.WASI_MODULE, _determinism.CLOCK_TIME_GET)]
    assert isinstance(wanted, wasmtime.FuncType)
    shadow = _determinism.clock_time_get_type()
    assert [str(t) for t in wanted.params] == [str(t) for t in shadow.params] == ["i32", "i64", "i32"]
    assert [str(t) for t in wanted.results] == [str(t) for t in shadow.results] == ["i32"]
    assert (_determinism.WASI_MODULE, _determinism.RANDOM_GET) not in imports, "the pinned guest draws no randomness"
    assert [str(t) for t in _determinism.random_get_type().params] == ["i32", "i32"]


SHIM = """(module
  (import "wasi_snapshot_preview1" "clock_time_get" (func $clock (param i32 i64 i32) (result i32)))
  (import "wasi_snapshot_preview1" "random_get" (func $random (param i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "clock") (param i32 i32) (result i32) (call $clock (local.get 0) (i64.const 1) (local.get 1)))
  (func (export "random") (param i32 i32) (result i32) (call $random (local.get 0) (local.get 1))))
"""


class Shim:
    """A guest whose exports forward to the two shadows."""

    def __init__(self) -> None:
        engine = wasmtime.Engine()
        self.store = wasmtime.Store(engine)
        linker = wasmtime.Linker(engine)
        for name, kind, shadow in (
            (_determinism.CLOCK_TIME_GET, _determinism.clock_time_get_type(), _determinism.clock_time_get),
            (_determinism.RANDOM_GET, _determinism.random_get_type(), _determinism.random_get),
        ):
            linker.define_func(_determinism.WASI_MODULE, name, kind, shadow, access_caller=True)
        self.instance = linker.instantiate(self.store, wasmtime.Module(engine, SHIM))
        memory = self.instance.exports(self.store)["memory"]
        assert isinstance(memory, wasmtime.Memory)
        self.memory = memory

    def call(self, name: str, *args: int) -> int:
        func = self.instance.exports(self.store)[name]
        assert isinstance(func, wasmtime.Func)
        errno = func(self.store, *args)
        assert isinstance(errno, int)
        return errno

    def read(self, at: int, length: int) -> bytes:
        return bytes(self.memory.read(self.store, at, at + length))


@pytest.mark.parametrize(("clock", "base"), [(0, REALTIME_EPOCH), (1, 0), (2, 0), (3, 0)])
def test_every_clock_reads_the_runs_own_time(clock: int, base: int) -> None:
    shim, run = Shim(), GuestClock()
    with _determinism.running(run):
        assert shim.call("clock", clock, 64) == 0
        assert int.from_bytes(shim.read(64, 8), "little") == base
        run.advance(1_500_000)
        assert shim.call("clock", clock, 64) == 0
        assert int.from_bytes(shim.read(64, 8), "little") == base + 1_500_000


def test_an_unknown_clock_is_inval_and_a_pointer_outside_memory_is_fault() -> None:
    shim = Shim()
    assert shim.call("clock", 4, 64) == 28
    assert shim.call("clock", 0, 65536 - 4) == 21
    assert shim.call("random", 65536 - 4, 8) == 21


def test_random_get_is_one_fixed_stream_per_run() -> None:
    shim = Shim()
    with _determinism.running(GuestClock()):
        assert shim.call("random", 0, 40) == 0
        assert shim.call("random", 40, 24) == 0
        drawn = shim.read(0, 64)
    with _determinism.running(GuestClock()):
        assert shim.call("random", 100, 64) == 0
        assert shim.read(100, 64) == drawn, "the next run draws the same bytes, however it splits its reads"
    assert len(set(drawn)) > 16, "not a constant"
    assert GuestClock().draw(64) == drawn


def test_the_poll_shadow_reads_and_moves_the_runs_clock() -> None:
    run = GuestClock()
    run.advance(5_000_000_000)
    window = _poll.RunWindow(time.monotonic() + 3600.0, threading.Event(), lambda: True, 0.05)
    with _poll.run_window(window), _determinism.running(run):
        assert _poll._guest_realtime() == REALTIME_EPOCH + 5_000_000_000, "an absolute timeout is read against it"
        began = time.monotonic()
        fired = _poll._wait([(9, 100_000_000), (10, 100_000_001)])
    assert fired == [(9, 0, 0)], "only the clocks due by the earliest timeout fire"
    assert 0.09 <= time.monotonic() - began < 1.0
    assert run.elapsed == 5_100_000_000, "the clock moved by exactly the wait"


def test_a_wait_cut_by_a_stop_does_not_move_the_clock() -> None:
    run, stop = GuestClock(), threading.Event()
    stop.set()
    window = _poll.RunWindow(time.monotonic() + 3600.0, stop, lambda: True, 0.05)
    with _poll.run_window(window), _determinism.running(run):
        assert _poll._wait([(11, 5_000_000_000)]) == [(11, 0, 0)]
    assert run.elapsed == 0
