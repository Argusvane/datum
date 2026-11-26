"""The binding's `Datum`: `async_submissions` on the runner, and the async throttle it hands in for a network store."""

import asyncio
import threading
import uuid

import pytest
from blockbuster import blockbuster_ctx
from submissions_fakes import Parts, config, envelope, make_datum

from datum_core import DatumNotStartedError
from datum_core.events import DatumEvent, DatumRuntimeReadyEvent
from datum_core.submissions import Accepted, FormRef, SubmissionContext, SubmissionValidatedEvent, Throttled
from datum_core.throttle import AsyncLimitsThrottle, LimitsThrottle, ThrottleKey

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def bus() -> SubmissionContext:
    return SubmissionContext(channel="bus", submission_key=str(uuid.uuid4()))


async def test_async_submissions_exists_only_inside_the_lifespan() -> None:
    datum, _ = make_datum()
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_submissions
    async with datum:
        assert datum.async_submissions.service is datum.submission_service
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_submissions


async def test_an_async_submit_runs_the_service_on_a_worker_thread_and_blockbuster_finds_nothing_on_the_loop() -> None:
    loop_thread = threading.get_ident()
    datum, parts = make_datum()
    ran_on: list[int] = []
    original = parts.handler.__call__

    def handler(accepted: object) -> object:
        ran_on.append(threading.get_ident())
        return original(accepted)

    datum.handler = handler  # type: ignore[assignment]
    with blockbuster_ctx():
        async with datum:
            outcome = await datum.async_submissions.submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Accepted)
    assert ran_on
    assert loop_thread not in ran_on


async def test_the_throttle_the_service_counts_with_is_the_one_datum_holds() -> None:
    datum, parts = make_datum()
    parts.throttle.deny = 7
    async with datum:
        context = SubmissionContext(
            channel="http", throttle_key=ThrottleKey(ip="203.0.113.7"), submission_key=str(uuid.uuid4())
        )
        outcome = await datum.async_submissions.submit(FormRef.from_document(), envelope(), context)
    assert isinstance(outcome, Throttled)
    assert outcome.retry_after == 7


def test_a_memory_throttle_is_the_sync_limits_throttle() -> None:
    from datum_fastapi import Datum  # noqa: PLC0415

    assert isinstance(Datum(config=config()).throttle, LimitsThrottle)


@pytest.mark.parametrize("uri", ["async+redis://localhost:6379", "async+memcached://localhost:11211"])
def test_a_network_store_gets_the_async_limits_face(uri: str) -> None:
    from datum_fastapi import Datum  # noqa: PLC0415

    datum = Datum(config=config(web={"throttle": {"storage": uri}}))
    assert isinstance(datum.throttle, AsyncLimitsThrottle)


def test_a_throttle_the_application_gives_is_used_as_given_whatever_the_storage() -> None:
    datum, parts = make_datum(config(web={"throttle": {"storage": "async+redis://localhost:6379"}}))
    assert datum.throttle is parts.throttle


async def test_a_call_abandoned_in_the_handler_publishes_no_event_and_a_later_start_delivers() -> None:
    gate = threading.Event()
    datum, parts = make_datum(config(runtime={"worker_threads": 4, "shutdown_grace": 0.2}))
    parts.handler.gate = gate
    await datum.__aenter__()
    task = asyncio.create_task(datum.async_submissions.submit(FormRef.from_document(), envelope(), bus()))
    assert await asyncio.to_thread(parts.handler.entered.wait, 10)
    await datum.__aexit__(None, None, None)
    gate.set()
    await asyncio.gather(task, return_exceptions=True)
    assert len(parts.handler.calls) == 1
    assert not [e for e in parts.events if isinstance(e, SubmissionValidatedEvent)]
    ready: list[DatumEvent] = []
    datum2, _ = make_datum(listeners=[(DatumRuntimeReadyEvent, ready.append)])
    async with datum2:
        pass
    assert ready


async def test_the_events_of_an_async_call_land_before_the_drain_ends_and_before_the_stop() -> None:
    gate = threading.Event()
    order: list[str] = []
    seen: list[DatumEvent] = []

    def record(event: DatumEvent) -> None:
        if isinstance(event, SubmissionValidatedEvent):
            order.append("event")
            seen.append(event)

    parts = Parts()
    parts.handler.gate = gate
    datum, _ = make_datum(
        config(runtime={"worker_threads": 4, "shutdown_grace": 5}), parts, listeners=[(DatumEvent, record)]
    )
    original = datum.stop

    def stop(*, deadline: float | None = None) -> None:
        order.append("datum stop")
        original(deadline=deadline)

    datum.stop = stop  # type: ignore[method-assign]
    await datum.__aenter__()
    task = asyncio.create_task(datum.async_submissions.submit(FormRef.from_document(), envelope(), bus()))
    assert await asyncio.to_thread(parts.handler.entered.wait, 10)
    task.cancel()
    leaving = asyncio.create_task(datum.__aexit__(None, None, None))
    await asyncio.sleep(0.2)
    assert "datum stop" not in order
    gate.set()
    await leaving
    await asyncio.gather(task, return_exceptions=True)
    assert order.index("event") < order.index("datum stop")
    assert getattr(seen[0], "channel", None) == "bus"
