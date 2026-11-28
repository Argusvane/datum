"""The guest's clock and randomness: WASI `clock_time_get` and `random_get` answer from the run, never from the host.

The sandbox program disables `Date` and `Math.random`, but a rule module can still `import('qjs:os')` (`os.now`) and
QuickJS reads the clock itself: the pinned `qjs-wasi.wasm` calls `clock_time_get` at start (the monotonic clock for its
time origin, the realtime clock to seed `Math.random`) and on every `Date.now`, `performance.now` and `os.now`. It does
not import `random_get`. So the runtime shadows both imports, the way it shadows `poll_oneoff`, and every run reads the
same values:

- each run has its own `GuestClock`, which starts at zero and moves only by the waits the guest's own `poll_oneoff`
  completed (an `os.sleep(300)` moves it by exactly 300 ms, a timer that fires by its own delay). The realtime clock
  reads `REALTIME_EPOCH` plus that, the monotonic and the CPU-time clocks read it as it is; an unknown clock is `inval`.
  The run's deadline is the store's epoch, which the host's own clock drives, so it is untouched; the waits themselves
  still take their real time, cut to the run's wall budget (`_poll`);
- `random_get` fills its buffer from a fixed stream (SHA-256 of a fixed seed and a block counter), restarted for every
  run: a guest that draws the same bytes sees the same bytes;
- a pointer outside the guest's memory is `fault`; nothing here raises into the guest.

The clock is a thread-local, like the `poll_oneoff` window: a host function runs on the thread that called `_start`.
A call with no clock (no run on this thread) reads a clock that stays at zero and the same fixed stream.
"""

import hashlib
import struct
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from typing import Final

import wasmtime

WASI_MODULE: Final = "wasi_snapshot_preview1"
CLOCK_TIME_GET: Final = "clock_time_get"
RANDOM_GET: Final = "random_get"

REALTIME_EPOCH: Final = 0
"""What the guest's realtime clock reads at the start of every run, in nanoseconds since 1970: the epoch itself."""

_REALTIME, _MONOTONIC, _PROCESS_CPUTIME, _THREAD_CPUTIME = 0, 1, 2, 3
_SUCCESS: Final = 0
_FAULT: Final = 21
_INVAL: Final = 28
_U32: Final = 0xFFFFFFFF
_U64: Final = struct.Struct("<Q")
_SEED: Final = b"datum guest random_get"
_BLOCK: Final = 32

_STATE: Final = threading.local()


class GuestClock:
    """One run's clock and random stream: zero at the start, moved only by the guest's completed waits."""

    __slots__ = ("_drawn", "_elapsed")

    def __init__(self) -> None:
        """Start at zero, with nothing drawn from the stream."""
        self._elapsed = 0
        self._drawn = 0

    @property
    def elapsed(self) -> int:
        """Nanoseconds the guest has waited out in `poll_oneoff` this run."""
        return self._elapsed

    def advance(self, nanoseconds: int) -> None:
        """Move the clock by a wait the guest completed (never backwards)."""
        self._elapsed += max(0, nanoseconds)

    def read(self, clock: int) -> int | None:
        """Return what the guest's clock `clock` reads now, in nanoseconds; `None` for an unknown clock."""
        if clock == _REALTIME:
            return REALTIME_EPOCH + self._elapsed
        if clock in {_MONOTONIC, _PROCESS_CPUTIME, _THREAD_CPUTIME}:
            return self._elapsed
        return None

    def draw(self, length: int) -> bytes:
        """Return the stream's next `length` bytes."""
        start, end = self._drawn, self._drawn + length
        first, last = start // _BLOCK, (end + _BLOCK - 1) // _BLOCK
        blocks = b"".join(hashlib.sha256(_SEED + index.to_bytes(8, "little")).digest() for index in range(first, last))
        self._drawn = end
        return blocks[start - first * _BLOCK : end - first * _BLOCK]


@contextmanager
def running(clock: GuestClock) -> Iterator[None]:
    """Make `clock` the clock of the guest this thread runs, for the duration of the block."""
    _STATE.clock = clock
    try:
        yield
    finally:
        _STATE.clock = None


def current() -> GuestClock | None:
    """Return the clock of the guest this thread runs, if any."""
    clock: GuestClock | None = getattr(_STATE, "clock", None)
    return clock


def clock_time_get_type() -> wasmtime.FuncType:
    """Return the core signature of WASI preview1 `clock_time_get`: clock id (i32), precision (i64), result pointer."""
    i32, i64 = wasmtime.ValType.i32(), wasmtime.ValType.i64()
    return wasmtime.FuncType([i32, i64, i32], [i32])


def random_get_type() -> wasmtime.FuncType:
    """Return the core signature of WASI preview1 `random_get`: buffer pointer and length (i32), an i32 errno."""
    i32 = wasmtime.ValType.i32()
    return wasmtime.FuncType([i32, i32], [i32])


def clock_time_get(caller: wasmtime.Caller, clock: int, _precision: int, result: int) -> int:
    """Answer the guest's `clock_time_get` from its run's clock; return a WASI errno and never raise."""
    memory = caller.get("memory")
    if not isinstance(memory, wasmtime.Memory):
        return _FAULT
    value = (current() or GuestClock()).read(clock & _U32)
    if value is None:
        return _INVAL
    result &= _U32
    try:
        if result + _U64.size > memory.data_len(caller):
            return _FAULT
        memory.write(caller, _U64.pack(value), result)
    except (ValueError, wasmtime.WasmtimeError):
        return _FAULT
    return _SUCCESS


def random_get(caller: wasmtime.Caller, buffer: int, length: int) -> int:
    """Fill the guest's buffer from its run's fixed stream; return a WASI errno and never raise."""
    memory = caller.get("memory")
    if not isinstance(memory, wasmtime.Memory):
        return _FAULT
    buffer, length = buffer & _U32, length & _U32
    try:
        if buffer + length > memory.data_len(caller):
            return _FAULT
        clock = current()
        memory.write(caller, (clock or GuestClock()).draw(length), buffer)
    except (ValueError, wasmtime.WasmtimeError):
        return _FAULT
    return _SUCCESS
