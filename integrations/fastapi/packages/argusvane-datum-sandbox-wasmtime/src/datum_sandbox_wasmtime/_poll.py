"""The engine's own WASI `poll_oneoff`: a guest's sleep never outlives its run's wall budget.

The epoch interrupt only reaches a guest between its own instructions: a guest waiting inside a host call is not
interrupted until the call returns. Of the WASI preview1 imports the pinned QuickJS links (`args_*`, `environ_*`,
`clock_time_get`, `fd_*`, `path_*`, `poll_oneoff`, `proc_exit`), only `poll_oneoff` waits on a clock: it is how
`os.sleep` (wasi-libc `nanosleep`) and the `os.setTimeout` event loop (wasi-libc `poll`) sleep, and a rule module can
reach both through `import('qjs:os')`. Every other import returns without waiting: stdin is a regular file, the
preopened `/app` holds only the run's regular files, the two output streams are the harness's bounded sinks that never
block, and `proc_exit` ends the guest. So the runtime shadows exactly this one import (`Linker.allow_shadowing` and
`Linker.define_func`) with the signature WASI preview1 gives it:

    poll_oneoff(in: i32 (const subscription*), out: i32 (event*), nsubscriptions: i32, nevents: i32 (size*)) -> errno

answered here rather than by wasmtime's own (a WASI function taken from another linker cannot be called from a host
function: it finds no caller memory):

- clock subscriptions (realtime or monotonic, relative; realtime absolute against the wall clock) wait for the earliest
  timeout, cut to the run's remaining wall budget, on the run's stop event, so the harness's stop and the shutdown stop
  wake the wait at once. The clocks that elapsed fire. A wait cut short (by the wall budget or a stop) is held until
  the store's epoch deadline has passed (at most a tick or two past the wall budget, or at once after the shutdown
  advance), then fires the earliest clock: the guest meets its deadline at its very next check (`RunEnd.BUDGET`, or
  `INTERRUPTED` at shutdown) and never gets the rest of a sleep, nor time to finish, after its budget. A monotonic
  absolute timeout (whose base only wasmtime knows) answers `notsup`, and the CPU-time clocks `inval`, at once;
- descriptor subscriptions are ready at once (every descriptor the guest has is a regular file or a sink, ready as
  wasmtime itself reports them), with no clock wait;
- no subscription is `inval`; a pointer outside the guest's memory is `fault`; nothing here raises into the guest.

The run's window (its deadline and stop event) is a thread-local: a host function runs on the thread that called
`_start`, the run's own worker thread. A call with no window (no run on this thread) waits for nothing.
"""

import struct
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

import wasmtime

WASI_MODULE: Final = "wasi_snapshot_preview1"
NAME: Final = "poll_oneoff"

_SUBSCRIPTION: Final = 48
_EVENT: Final = 32
_U32: Final = 0xFFFFFFFF
_CLOCK: Final = 0
_FD_READ: Final = 1
_FD_WRITE: Final = 2
_REALTIME: Final = 0
_MONOTONIC: Final = 1
_ABSTIME: Final = 1
_SUCCESS: Final = 0
_FAULT: Final = 21
_INVAL: Final = 28
_NOTSUP: Final = 58
_HEAD: Final = struct.Struct("<QB")
"""A subscription's userdata (u64) and tag (u8)."""
_CLOCK_BODY: Final = struct.Struct("<I4xQQH")
"""A clock subscription at offset 16: id (u32), timeout (u64 ns), precision (u64 ns), flags (u16)."""
_EVENT_BODY: Final = struct.Struct("<QHB5xQH6x")
"""An event: userdata (u64), errno (u16), type (u8), then `fd_readwrite` nbytes (u64) and flags (u16)."""

_STATE: Final = threading.local()
_HOLD_TICKS: Final = 4
"""How many ticks past the wall budget a cut wait is held at most for the epoch deadline (a stalled clock)."""


@dataclass(frozen=True, slots=True)
class RunWindow:
    """What the shadow knows of the run calling it.

    Its wall deadline (`time.monotonic()`), its stop event, whether its store's epoch deadline has passed
    (`EpochClock.expired` for its token), and the clock tick in seconds.
    """

    deadline: float
    stop: threading.Event
    expired: Callable[[], bool]
    tick: float


@contextmanager
def run_window(window: RunWindow) -> Iterator[None]:
    """Make `window` the window of the guest this thread runs, for the duration of the block."""
    _STATE.window = window
    try:
        yield
    finally:
        _STATE.window = None


def poll_oneoff_type() -> wasmtime.FuncType:
    """Return the core signature of WASI preview1 `poll_oneoff`: four i32 parameters, an i32 errno."""
    i32 = wasmtime.ValType.i32()
    return wasmtime.FuncType([i32, i32, i32, i32], [i32])


def poll_oneoff(caller: wasmtime.Caller, in_ptr: int, out_ptr: int, count: int, result_ptr: int) -> int:
    """Answer the guest's `poll_oneoff`; return a WASI errno and never raise."""
    memory = caller.get("memory")
    if not isinstance(memory, wasmtime.Memory):
        return _FAULT
    try:
        return _answer(
            caller, memory, in_ptr=in_ptr & _U32, out_ptr=out_ptr & _U32, count=count & _U32, result=result_ptr & _U32
        )
    except (IndexError, ValueError, struct.error, wasmtime.WasmtimeError):
        return _FAULT


def _answer(
    caller: wasmtime.Caller, memory: wasmtime.Memory, *, in_ptr: int, out_ptr: int, count: int, result: int
) -> int:
    if count == 0:
        return _INVAL
    size = memory.data_len(caller)
    if in_ptr + count * _SUBSCRIPTION > size or out_ptr + count * _EVENT > size or result + 4 > size:
        return _FAULT
    raw = bytes(memory.read(caller, in_ptr, in_ptr + count * _SUBSCRIPTION))
    events: list[tuple[int, int, int]] = []
    clocks: list[tuple[int, float]] = []
    for index in range(count):
        base = index * _SUBSCRIPTION
        userdata, tag = _HEAD.unpack_from(raw, base)
        if tag == _CLOCK:
            clock, timeout, _precision, flags = _CLOCK_BODY.unpack_from(raw, base + 16)
            if clock not in {_REALTIME, _MONOTONIC}:
                events.append((userdata, _INVAL, _CLOCK))
            elif flags & _ABSTIME and clock != _REALTIME:
                events.append((userdata, _NOTSUP, _CLOCK))
            else:
                nanoseconds = timeout - time.time_ns() if flags & _ABSTIME else timeout
                clocks.append((userdata, max(0, nanoseconds) / 1e9))
        elif tag in {_FD_READ, _FD_WRITE}:
            events.append((userdata, _SUCCESS, tag))
        else:
            return _INVAL
    if events:
        events.extend((userdata, _SUCCESS, _CLOCK) for userdata, delay in clocks if delay <= 0)
    else:
        events = _wait(clocks)
    memory.write(caller, b"".join(_EVENT_BODY.pack(u, error, kind, 0, 0) for u, error, kind in events), out_ptr)
    memory.write(caller, len(events).to_bytes(4, "little"), result)
    return _SUCCESS


def _wait(clocks: list[tuple[int, float]]) -> list[tuple[int, int, int]]:
    """Wait for the earliest clock, cut to the run's remaining wall budget and woken by its stop; return the events."""
    earliest_userdata, earliest = min(clocks, key=lambda item: item[1])
    window: RunWindow | None = getattr(_STATE, "window", None)
    if window is None:
        return [(earliest_userdata, _SUCCESS, _CLOCK)]
    began = time.monotonic()
    remaining = window.deadline - began
    stopped = window.stop.wait(max(0.0, min(earliest, remaining)))
    if stopped or earliest > remaining:
        _hold_until_expired(window)
        return [(earliest_userdata, _SUCCESS, _CLOCK)]
    waited = time.monotonic() - began
    fired = [(userdata, _SUCCESS, _CLOCK) for userdata, delay in clocks if delay <= waited]
    return fired or [(earliest_userdata, _SUCCESS, _CLOCK)]


def _hold_until_expired(window: RunWindow) -> None:
    """Hold a cut wait until the store's epoch deadline has passed, a few ticks past the wall budget at most."""
    until = max(window.deadline, time.monotonic()) + _HOLD_TICKS * window.tick
    step = window.tick / 5
    while not window.expired() and time.monotonic() < until:
        time.sleep(step)
