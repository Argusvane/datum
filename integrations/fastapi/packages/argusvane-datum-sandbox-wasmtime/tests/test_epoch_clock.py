"""The epoch clock: the deadline arithmetic, arming and disarming, the shutdown advance, and one thread that stops."""

import threading
import time

import pytest

from datum_sandbox_wasmtime._clock import THREAD_NAME, EpochClock, deadline_ticks


class CountingEngine:
    def __init__(self) -> None:
        self.epoch = 0
        self.lock = threading.Lock()

    def increment_epoch(self) -> None:
        with self.lock:
            self.epoch += 1


class RecordingStore:
    def __init__(self) -> None:
        self.deadlines: list[int] = []

    def set_epoch_deadline(self, ticks_after_current: int) -> None:
        self.deadlines.append(ticks_after_current)


@pytest.mark.parametrize(
    ("seconds", "tick", "ticks"),
    [
        (2.0, 0.05, 41),
        (0.3, 0.05, 7),
        (0.05, 0.05, 2),
        (0.01, 0.05, 2),
        (5.0, 0.05, 101),
        (300.0, 0.001, 300_001),
    ],
)
def test_a_store_is_armed_with_ceil_of_budget_over_tick_plus_one(seconds: float, tick: float, ticks: int) -> None:
    assert deadline_ticks(seconds, tick) == ticks


@pytest.mark.parametrize("seconds", [0.0, -1.0, float("inf"), float("nan")])
def test_a_wall_budget_that_is_not_positive_and_finite_is_refused(seconds: float) -> None:
    with pytest.raises(ValueError, match="positive finite"):
        deadline_ticks(seconds, 0.05)


def test_the_tick_must_be_positive() -> None:
    with pytest.raises(ValueError, match="positive finite"):
        EpochClock(CountingEngine(), 0.0)


def test_the_clock_advances_on_its_own_named_thread_and_stops() -> None:
    engine = CountingEngine()
    clock = EpochClock(engine, 0.01)
    try:
        assert any(t.name == THREAD_NAME for t in threading.enumerate())
        deadline = time.monotonic() + 3
        while engine.epoch < 5 and time.monotonic() < deadline:
            time.sleep(0.01)
        assert engine.epoch >= 5
        assert clock.epoch >= 5
    finally:
        clock.close()
    assert not clock.running
    assert not any(t.name == THREAD_NAME for t in threading.enumerate())
    stopped_at = engine.epoch
    time.sleep(0.05)
    assert engine.epoch == stopped_at, "no tick after close"


def test_shutdown_advances_the_epoch_past_every_armed_deadline() -> None:
    engine = CountingEngine()
    clock = EpochClock(engine, 3600.0)  # never ticks by itself during the test
    try:
        short, long_ = RecordingStore(), RecordingStore()
        first = clock.arm(short, 1.0)
        clock.arm(long_, 60.0)
        assert short.deadlines == [deadline_ticks(1.0, 3600.0)]
        assert clock.armed == 2
        clock.disarm(first)
        assert clock.armed == 1
        steps = clock.advance_past_every_deadline()
        assert steps == deadline_ticks(60.0, 3600.0) + 1
        assert engine.epoch == steps, "the epoch now stands past the longest deadline"
        assert clock.advance_past_every_deadline() == 1, "with every deadline passed, one more tick"
    finally:
        clock.close()


def test_a_deadline_armed_later_counts_from_the_epoch_then() -> None:
    engine = CountingEngine()
    clock = EpochClock(engine, 3600.0)
    try:
        clock.advance_past_every_deadline()
        before = engine.epoch
        clock.arm(RecordingStore(), 1.0)
        assert clock.advance_past_every_deadline() == deadline_ticks(1.0, 3600.0) + 1
        assert engine.epoch == before + deadline_ticks(1.0, 3600.0) + 1
    finally:
        clock.close()
