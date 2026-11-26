"""The one epoch clock of a runtime: a thread that advances the engine's epoch every tick, and the deadlines it ends.

wasmtime checks a store's epoch deadline at function entries and loop headers; the engine's epoch is the only clock it
reads. A run's store is armed with `ceil(wall / tick) + 1` ticks from the epoch at arming, so the clock's thread ends it
within two ticks after its wall budget, without a timer per run. The clock keeps the epoch it has counted under its
lock, beside every armed deadline, so the shutdown stop can advance the epoch past all of them at once (the one global
bump). The lock is held only for an increment or for arming one store; no callback of a guest ever takes it.
"""

import itertools
import math
import threading
import time
from typing import Final, Protocol

THREAD_NAME: Final = "datum-epoch-clock"


class EpochEngine(Protocol):
    """The part of `wasmtime.Engine` the clock drives."""

    def increment_epoch(self) -> None:
        """Advance the engine's epoch by one."""
        ...


class EpochStore(Protocol):
    """The part of `wasmtime.Store` the clock arms."""

    def set_epoch_deadline(self, ticks_after_current: int) -> None:
        """Trap the store's guest once the epoch is `ticks_after_current` past the current one."""
        ...


def deadline_ticks(seconds: float, tick: float) -> int:
    """Return the ticks a store is armed with for a wall budget of `seconds`: `ceil(seconds / tick) + 1`."""
    if not (math.isfinite(seconds) and seconds > 0):
        raise ValueError(f"a wall budget must be a positive finite number of seconds, not {seconds!r}")
    return math.ceil(seconds / tick) + 1


class EpochClock:
    """Advance `engine`'s epoch every `tick` seconds on one daemon thread, and keep the deadlines armed against it."""

    def __init__(self, engine: EpochEngine, tick: float) -> None:
        """Start the clock thread."""
        if not (math.isfinite(tick) and tick > 0):
            raise ValueError(f"the clock tick must be a positive finite number of seconds, not {tick!r}")
        self._engine = engine
        self._tick = tick
        self._lock = threading.Lock()
        self._epoch = 0
        self._deadlines: dict[int, int] = {}
        self._tokens = itertools.count(1)
        self._stop = threading.Event()
        self._thread = threading.Thread(target=self._run, name=THREAD_NAME, daemon=True)
        self._thread.start()

    @property
    def tick(self) -> float:
        """The tick in seconds."""
        return self._tick

    @property
    def epoch(self) -> int:
        """How many times the epoch has been advanced since the clock started."""
        with self._lock:
            return self._epoch

    @property
    def armed(self) -> int:
        """How many stores are armed now."""
        with self._lock:
            return len(self._deadlines)

    @property
    def running(self) -> bool:
        """Whether the clock thread is alive."""
        return self._thread.is_alive()

    def arm(self, store: EpochStore, seconds: float) -> int:
        """Arm `store` to trap `ceil(seconds / tick) + 1` ticks from now; return a token for `disarm`."""
        ticks = deadline_ticks(seconds, self._tick)
        with self._lock:
            store.set_epoch_deadline(ticks)
            token = next(self._tokens)
            self._deadlines[token] = self._epoch + ticks
        return token

    def expired(self, token: int) -> bool:
        """Whether the epoch has reached the deadline armed under `token` (or the token is no longer armed)."""
        with self._lock:
            deadline = self._deadlines.get(token)
            return deadline is None or self._epoch >= deadline

    def disarm(self, token: int) -> None:
        """Forget an armed deadline (its store is closing)."""
        with self._lock:
            self._deadlines.pop(token, None)

    def advance_past_every_deadline(self) -> int:
        """Advance the epoch past every armed deadline at once (the shutdown stop); return the ticks advanced."""
        with self._lock:
            target = max(self._deadlines.values(), default=self._epoch)
            steps = max(0, target - self._epoch) + 1
            for _ in range(steps):
                self._engine.increment_epoch()
            self._epoch += steps
        return steps

    def close(self) -> None:
        """Stop the clock thread and wait for it."""
        self._stop.set()
        if self._thread is not threading.current_thread():
            self._thread.join()

    def _advance(self) -> None:
        with self._lock:
            self._engine.increment_epoch()
            self._epoch += 1

    def _run(self) -> None:
        next_at = time.monotonic() + self._tick
        while True:
            delay = next_at - time.monotonic()
            if self._stop.wait(max(0.0, delay)):
                return
            self._advance()
            next_at += self._tick
            now = time.monotonic()
            if next_at < now:
                # Fell behind (a stall): never burst ticks to catch up, which would end budgets early.
                next_at = now + self._tick
