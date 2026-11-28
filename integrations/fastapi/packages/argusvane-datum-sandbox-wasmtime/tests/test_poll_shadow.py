"""The `poll_oneoff` shadow's own arithmetic and answers, driven through a tiny guest that forwards to it."""

import threading
import time
from collections.abc import Iterator
from contextlib import contextmanager

import pytest
import wasmtime

from datum_sandbox_wasmtime import _poll

pytestmark = pytest.mark.runtime

SHIM = """(module
  (import "wasi_snapshot_preview1" "poll_oneoff" (func $poll (param i32 i32 i32 i32) (result i32)))
  (memory (export "memory") 1)
  (func (export "call") (param i32 i32 i32 i32) (result i32)
    (call $poll (local.get 0) (local.get 1) (local.get 2) (local.get 3))))
"""
IN, OUT, RESULT = 0, 4096, 8192
REALTIME, MONOTONIC = 0, 1
FAR = 3600.0
SECOND = 1_000_000_000


class Shim:
    """A guest whose one export forwards to the shadow; subscriptions are written to and events read from its memory."""

    def __init__(self) -> None:
        engine = wasmtime.Engine()
        self.store = wasmtime.Store(engine)
        linker = wasmtime.Linker(engine)
        linker.define_func(
            _poll.WASI_MODULE, _poll.NAME, _poll.poll_oneoff_type(), _poll.poll_oneoff, access_caller=True
        )
        instance = linker.instantiate(self.store, wasmtime.Module(engine, SHIM))
        memory = instance.exports(self.store)["memory"]
        assert isinstance(memory, wasmtime.Memory)
        self.memory = memory
        func = instance.exports(self.store)["call"]
        assert isinstance(func, wasmtime.Func)
        self.func = func

    def clock(self, index: int, userdata: int, clock: int, timeout_ns: int, flags: int = 0) -> None:
        base = IN + index * 48
        self.memory.write(self.store, _poll._HEAD.pack(userdata, 0), base)
        self.memory.write(self.store, _poll._CLOCK_BODY.pack(clock, timeout_ns, 0, flags), base + 16)

    def descriptor(self, index: int, userdata: int, tag: int) -> None:
        self.memory.write(self.store, _poll._HEAD.pack(userdata, tag), IN + index * 48)

    def call(self, count: int, *, in_ptr: int = IN, out_ptr: int = OUT, result_ptr: int = RESULT) -> int:
        errno = self.func(self.store, in_ptr, out_ptr, count, result_ptr)
        assert isinstance(errno, int)
        return errno

    def events(self) -> list[tuple[int, int, int]]:
        count = int.from_bytes(bytes(self.memory.read(self.store, RESULT, RESULT + 4)), "little")
        out: list[tuple[int, int, int]] = []
        for index in range(count):
            raw = bytes(self.memory.read(self.store, OUT + index * 32, OUT + (index + 1) * 32))
            userdata, errno, kind, _nbytes, _flags = _poll._EVENT_BODY.unpack(raw)
            out.append((userdata, errno, kind))
        return out


@pytest.fixture
def shim() -> Shim:
    return Shim()


@contextmanager
def window(seconds: float, *, expired: bool = True) -> Iterator[threading.Event]:
    stop = threading.Event()
    with _poll.run_window(_poll.RunWindow(time.monotonic() + seconds, stop, lambda: expired, 0.05)):
        yield stop


# -- _wait: the clamp to the remaining wall budget ------------------------------------------------------------------


def test_a_clock_past_the_wall_budget_is_cut_to_it() -> None:
    with window(0.2):
        began = time.monotonic()
        fired = _poll._wait([(7, SECOND * 5)])
    assert fired == [(7, 0, 0)]
    assert 0.15 <= time.monotonic() - began < 1.0, "cut to the wall budget, not slept for 5 s"


def test_only_the_clocks_that_elapsed_fire_inside_the_budget() -> None:
    with window(FAR):
        began = time.monotonic()
        fired = _poll._wait([(1, SECOND // 20), (2, SECOND * 5)])
    assert fired == [(1, 0, 0)]
    assert 0.04 <= time.monotonic() - began < 1.0


def test_a_wall_budget_already_past_returns_at_once() -> None:
    with window(-1.0):
        began = time.monotonic()
        fired = _poll._wait([(3, SECOND * 5)])
    assert fired == [(3, 0, 0)]
    assert time.monotonic() - began < 0.5


def test_a_stop_wakes_the_wait_at_once() -> None:
    with window(FAR) as stop:
        stop.set()
        began = time.monotonic()
        assert _poll._wait([(4, SECOND * 5)]) == [(4, 0, 0)]
    assert time.monotonic() - began < 0.5


def test_no_window_waits_for_nothing() -> None:
    began = time.monotonic()
    assert _poll._wait([(5, SECOND * 5)]) == [(5, 0, 0)]
    assert time.monotonic() - began < 0.5


# -- the decoding and the errno answers -----------------------------------------------------------------------------


def test_a_relative_monotonic_clock_fires_after_its_timeout(shim: Shim) -> None:
    shim.clock(0, 11, MONOTONIC, 50_000_000)
    with window(FAR):
        began = time.monotonic()
        assert shim.call(1) == 0
    assert 0.04 <= time.monotonic() - began < 1.0
    assert shim.events() == [(11, 0, 0)]


def test_a_realtime_absolute_clock_is_read_against_the_wall_clock(shim: Shim) -> None:
    shim.clock(0, 12, REALTIME, time.time_ns() + 100_000_000, flags=1)
    with window(FAR):
        began = time.monotonic()
        assert shim.call(1) == 0
    waited = time.monotonic() - began
    assert 0.05 <= waited < 1.0, "neither at once nor a read as relative to the epoch"
    assert shim.events() == [(12, 0, 0)]


def test_a_realtime_absolute_clock_already_past_fires_at_once(shim: Shim) -> None:
    shim.clock(0, 13, REALTIME, time.time_ns() - 1_000_000_000, flags=1)
    with window(FAR):
        began = time.monotonic()
        assert shim.call(1) == 0
    assert time.monotonic() - began < 0.5
    assert shim.events() == [(13, 0, 0)]


def test_a_monotonic_absolute_clock_is_notsup(shim: Shim) -> None:
    shim.clock(0, 14, MONOTONIC, 1, flags=1)
    with window(FAR):
        assert shim.call(1) == 0
    assert shim.events() == [(14, 58, 0)]


@pytest.mark.parametrize("clock", [2, 3, 99])
def test_a_cpu_time_or_unknown_clock_is_inval(shim: Shim, clock: int) -> None:
    shim.clock(0, 15, clock, 1)
    with window(FAR):
        assert shim.call(1) == 0
    assert shim.events() == [(15, 28, 0)]


def test_no_subscription_is_inval(shim: Shim) -> None:
    with window(FAR):
        assert shim.call(0) == 28


def test_an_unknown_subscription_tag_is_inval(shim: Shim) -> None:
    shim.descriptor(0, 16, 9)
    with window(FAR):
        assert shim.call(1) == 28


@pytest.mark.parametrize(
    ("in_ptr", "out_ptr", "result_ptr"),
    [(65536 - 47, OUT, RESULT), (IN, 65536 - 31, RESULT), (IN, OUT, 65536 - 3), (2**32 - 8, OUT, RESULT)],
)
def test_a_pointer_past_memory_is_fault(shim: Shim, in_ptr: int, out_ptr: int, result_ptr: int) -> None:
    shim.clock(0, 17, MONOTONIC, 1)
    with window(FAR):
        assert shim.call(1, in_ptr=in_ptr, out_ptr=out_ptr, result_ptr=result_ptr) == 21


def test_descriptor_subscriptions_are_ready_at_once_with_no_clock_wait(shim: Shim) -> None:
    shim.descriptor(0, 18, 1)
    shim.descriptor(1, 19, 2)
    shim.clock(2, 20, MONOTONIC, 5_000_000_000)
    with window(FAR):
        began = time.monotonic()
        assert shim.call(3) == 0
    assert time.monotonic() - began < 0.5
    assert shim.events() == [(18, 0, 1), (19, 0, 2)]


def test_a_ready_clock_rides_along_with_a_descriptor(shim: Shim) -> None:
    shim.descriptor(0, 21, 1)
    shim.clock(1, 22, MONOTONIC, 0)
    with window(FAR):
        assert shim.call(2) == 0
    assert shim.events() == [(21, 0, 1), (22, 0, 0)]
