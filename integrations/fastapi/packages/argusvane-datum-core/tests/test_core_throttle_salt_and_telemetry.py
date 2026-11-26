"""datum_core: E005 at the start, a degraded throttle shown, the slot gauge, the runner's busy count,
the 503 code set from the answer table, and listeners that raise on the throttled and journey events."""

import asyncio
import logging
import threading
from typing import Any

import pytest
from limits.aio.storage import Storage as AsyncStorage
from observe_support import Telemetry, telemetry
from submissions_support import (
    Repository,
    ThreadLoopAwaiter,
    bus,
    envelope,
    http_context,
    journey_check,
    plain_datum,
    started,
)
from test_health_submissions import SUBMISSIONS_ON, CountingRuntime, started_datum
from test_throttle_storage_failure import NetworkStorage
from throttle_support import settings

from datum_core import checks
from datum_core.aio import AsyncRunner, AsyncSubmissionService
from datum_core.checks import CHECK_LEVELS
from datum_core.events import DatumEvent, listener
from datum_core.http import submissions as http_submissions
from datum_core.http.errors import ANSWER_ROWS, RETRY_AFTER
from datum_core.loggers import EVENTS
from datum_core.submissions import (
    Accepted,
    FormRef,
    JourneyCheckedEvent,
    SubmissionThrottledEvent,
)
from datum_core.throttle import AsyncLimitsThrottle, BoundedMemoryStorage, LimitsThrottle
from datum_sandbox.checks import CheckLevel, DatumConfigurationError
from datum_sandbox.wasi import EngineBusyError, HarnessStats


# -- datum.E005 ----------------------------------------------------------------------------------------------------
def test_e005_is_a_documented_error_id_and_the_throttle_uses_it() -> None:
    assert checks.E005 == "datum.E005"
    assert CHECK_LEVELS[checks.E005] is CheckLevel.ERROR
    check = LimitsThrottle(settings(), storage=NetworkStorage()).check_key_salt()
    assert check is not None
    assert check.id == checks.E005


def test_a_shared_throttle_storage_without_a_key_salt_stops_the_start_with_e005() -> None:
    throttle = LimitsThrottle(settings(), storage=NetworkStorage())
    datum = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]), throttle=throttle)
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [problem.id for problem in raised.value.problems] == [checks.E005]
    assert "datum.web.throttle.key_salt" in str(raised.value)


def test_a_shared_throttle_storage_with_a_key_salt_starts() -> None:
    throttle = LimitsThrottle(settings(key_salt="s" * 32), storage=NetworkStorage())
    datum = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]), throttle=throttle)
    datum.start()
    datum.stop()


ASYNC_REDIS = "async+redis://localhost:6379"


def test_an_async_shared_throttle_without_a_key_salt_stops_the_start_with_e005() -> None:
    throttle = AsyncLimitsThrottle(settings(storage=ASYNC_REDIS), storage=AsyncRedisLike())
    datum = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]), throttle=throttle)
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [problem.id for problem in raised.value.problems] == [checks.E005]


class AsyncRedisLike(AsyncStorage):
    """An async shared store that is not limits' memory store, with a scheme of its own (not shadowing redis)."""

    STORAGE_SCHEME = ["async+fakeshared"]  # noqa: RUF012 - mirrors limits' own class attribute

    @property
    def base_exceptions(self) -> type[Exception]:
        return ValueError

    async def incr(self, key: str, expiry: float, amount: int = 1) -> int:
        return amount

    async def get(self, key: str) -> int:
        return 0

    async def get_expiry(self, key: str) -> float:
        return 0.0

    async def check(self) -> bool:
        return True

    async def reset(self) -> int | None:
        return None

    async def clear(self, key: str) -> None:
        return None


def test_an_async_shared_throttle_with_a_key_salt_starts_and_reports_its_kind_and_degradation() -> None:
    throttle = AsyncLimitsThrottle(settings(storage=ASYNC_REDIS, key_salt="s" * 32), storage=AsyncRedisLike())
    datum = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]), throttle=throttle)
    datum.start()
    try:
        capabilities = datum.info()["capabilities"]
        assert capabilities["throttle"] == "fakeshared"  # type: ignore[index]
        assert capabilities["throttleDegraded"] is False  # type: ignore[index]
        assert datum.health().components["stores.throttle"].details["degraded"] is False
        throttle._degraded = True  # pyright: ignore[reportPrivateUsage]
        assert datum.info()["capabilities"]["throttleDegraded"] is True  # type: ignore[index]
        degraded = datum.health().components["stores.throttle"]
        assert degraded.status == "up"
        assert degraded.details["degraded"] is True
    finally:
        datum.stop()


# -- degraded is surfaced ------------------------------------------------------------------------------------------
class DownStorage(BoundedMemoryStorage):
    down = False

    def incr(self, key: str, expiry: int, amount: int = 1) -> int:
        if self.down:
            raise RuntimeError("the counter store is unreachable")
        return super().incr(key, expiry, amount)


def test_a_degraded_throttle_shows_in_the_component_and_in_info_with_the_status_staying_up() -> None:
    storage = DownStorage()
    throttle = LimitsThrottle(settings(), storage=storage)
    datum = started_datum(throttle=throttle)
    try:
        healthy = datum.health().components["stores.throttle"]
        assert healthy.details["degraded"] is False
        assert datum.info()["capabilities"]["throttleDegraded"] is False  # type: ignore[index]
        storage.down = True
        datum.submission_service.submit(FormRef.from_document(), envelope(), http_context())
        report = datum.health()
        degraded = report.components["stores.throttle"]
        assert degraded.status == "up"
        assert degraded.details["degraded"] is True
        assert report.is_up
        assert report.is_ready
        assert datum.info()["capabilities"]["throttleDegraded"] is True  # type: ignore[index]
    finally:
        datum.stop()


def test_a_custom_throttle_reports_no_degradation() -> None:
    with started() as rig:
        assert rig.datum.info()["capabilities"]["throttleDegraded"] is False  # type: ignore[index]


# -- the slot limit gauge ------------------------------------------------------------------------------------------
def test_the_slot_limit_is_an_observable_gauge_over_the_runtime_stats_and_leaves_with_the_runtime() -> None:
    otel = telemetry()
    runtime = CountingRuntime(HarnessStats(slots=4, slots_in_use=1, runs_in_flight=1, stuck_runs=0, stray_runs=0))
    datum = started_datum(runtime)
    try:
        assert otel.total("datum.sandbox.slot.limit") == 4
        (point,) = otel.points("datum.sandbox.slot.limit")
        assert dict(point.attributes or {}) == {}
    finally:
        datum.stop()
    assert otel.total("datum.sandbox.slot.limit") == 0


def test_a_runtime_with_no_stats_adds_no_slot_limit() -> None:
    otel = telemetry()
    datum = started_datum()
    try:
        assert otel.total("datum.sandbox.slot.limit") == 0
    finally:
        datum.stop()


# -- the runner's own busy refusal ---------------------------------------------------------------------------------
@pytest.mark.anyio
@pytest.mark.parametrize("anyio_backend", ["asyncio"])
async def test_a_runner_level_busy_and_an_engine_level_busy_each_count_exactly_once(anyio_backend: str) -> None:
    otel: Telemetry = telemetry()
    runner = AsyncRunner(worker_threads=1, wait=0.0, shutdown_grace=2.0)
    held, release = threading.Event(), threading.Event()

    def hold() -> None:
        held.set()
        release.wait(10)

    first = asyncio.create_task(runner.run(hold))
    assert await asyncio.to_thread(held.wait, 5)
    before = otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
    with pytest.raises(EngineBusyError):
        await runner.run(lambda: None)
    assert otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == before + 1
    release.set()
    await first

    waiting = AsyncRunner(worker_threads=1, wait=0.05, shutdown_grace=2.0)
    held.clear()
    release.clear()
    holder = asyncio.create_task(waiting.run(hold))
    try:
        assert await asyncio.to_thread(held.wait, 5)
        mark_wait = otel.observations("datum.sandbox.run.wait.duration")
        mark_busy = otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
        with pytest.raises(EngineBusyError):
            await waiting.run(lambda: None)
        assert otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == mark_busy + 1
        assert otel.observations("datum.sandbox.run.wait.duration") == mark_wait + 1
    finally:
        release.set()
        await holder
    await waiting.drain()

    with started() as rig:
        rig.sandbox.error = EngineBusyError("slots")
        facade = AsyncSubmissionService(rig.service, AsyncRunner(worker_threads=2, wait=1.0, shutdown_grace=2.0))
        mark = otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
        await facade.submit(FormRef.from_document(), envelope(), bus())
        assert otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == mark + 1
    await runner.drain()


# -- the 503 codes come from the table -----------------------------------------------------------------------------
def test_the_unavailable_codes_are_the_listed_503_codes_of_the_answer_table() -> None:
    expected = frozenset(code for row in ANSWER_ROWS if row.status == 503 for code in row.codes)
    assert expected
    assert expected == http_submissions._UNAVAILABLE_CODES  # pyright: ignore[reportPrivateUsage]
    assert {"server.busy", "signing.not_set_up", "wasm.execution_error"} <= expected
    assert {code for row in ANSWER_ROWS if row.status == 503 and RETRY_AFTER in row.headers for code in row.codes} == {
        "server.busy"
    }


# -- a raising listener --------------------------------------------------------------------------------------------
def _throttled(rig: Any) -> Any:
    rig.throttle.deny = 5
    return rig.submit(envelope(), http_context())


def _journey(rig: Any) -> Any:
    return rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())


@pytest.mark.parametrize(
    ("event_type", "act"),
    [(SubmissionThrottledEvent, _throttled), (JourneyCheckedEvent, _journey)],
    ids=["throttled", "journey"],
)
def test_a_raising_listener_on_the_throttled_and_journey_events_changes_no_answer(
    event_type: type[DatumEvent], act: Any, caplog: pytest.LogCaptureFixture
) -> None:
    def explode(event: DatumEvent) -> None:
        raise RuntimeError("listener broke")

    with started() as plain:
        expected = type(act(plain)).__name__
    with caplog.at_level(logging.ERROR, logger=EVENTS), started(listeners=[listener(event_type, explode)]) as rig:
        answered = act(rig)
    assert type(answered).__name__ == expected
    assert any(record.name == EVENTS and record.levelno == logging.ERROR for record in caplog.records)


def test_an_async_listener_that_raises_is_logged_at_error_on_the_events_logger_and_the_answer_stands(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def audit(event: DatumEvent) -> None:
        await asyncio.sleep(0)
        raise RuntimeError("async listener broke")

    awaiter = ThreadLoopAwaiter()
    try:
        with (
            caplog.at_level(logging.ERROR, logger=EVENTS),
            started(listeners=[listener(DatumEvent, audit)], awaiter=awaiter) as rig,
        ):
            caplog.clear()
            outcome = rig.submit()
    finally:
        awaiter.close()
    assert isinstance(outcome, Accepted)
    assert len(rig.handler.calls) == 1
    records = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert records
    assert all(r.name == EVENTS for r in records)
    assert records[0].exc_info is not None
