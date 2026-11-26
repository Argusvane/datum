"""The binding's `Datum`: `async_builder` exists only inside the lifespan and wraps the start's builder service."""

import asyncio
import threading

import pytest
from blockbuster import blockbuster_ctx
from builder_fakes import FORM, Parts, config, make_datum
from datum_fakes import definition

from datum_core import DatumNotStartedError
from datum_core.builder import Saved
from datum_core.events import DatumEvent
from datum_core.events import FormDefinitionSavedEvent as Saved_event

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


async def test_async_builder_exists_only_inside_the_lifespan() -> None:
    datum, _ = make_datum()
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_builder
    async with datum:
        assert datum.async_builder.service is datum.builder_service
    with pytest.raises(DatumNotStartedError):
        _ = datum.async_builder


async def test_an_async_save_over_the_memory_repository_answers_saved_off_the_loop() -> None:
    datum, parts = make_datum()
    with blockbuster_ctx():
        async with datum:
            outcome = await datum.async_builder.save(
                FORM, definition(FORM, "2"), expected_sha256=parts.stored().sha256, principal=None
            )
    assert isinstance(outcome, Saved)
    assert parts.stored().definition["version"] == "2"


async def test_a_save_held_in_the_kernel_and_cancelled_publishes_its_event_before_the_stop() -> None:
    gate = threading.Event()
    order: list[str] = []

    def record(event: DatumEvent) -> None:
        if isinstance(event, Saved_event):
            order.append("event")

    parts = Parts(gate=gate)
    datum, _ = make_datum(
        config(runtime={"worker_threads": 4, "shutdown_grace": 5}), parts, listeners=[(DatumEvent, record)]
    )
    original = datum.stop

    def stop(*, deadline: float | None = None) -> None:
        order.append("datum stop")
        original(deadline=deadline)

    datum.stop = stop  # type: ignore[method-assign]
    await datum.__aenter__()
    task = asyncio.create_task(
        datum.async_builder.save(FORM, definition(FORM, "2"), expected_sha256=None, principal=None)
    )
    assert await asyncio.to_thread(parts.sandbox.entered.wait, 10)
    task.cancel()
    leaving = asyncio.create_task(datum.__aexit__(None, None, None))
    await asyncio.sleep(0.2)
    assert "datum stop" not in order
    gate.set()
    await leaving
    await asyncio.gather(task, return_exceptions=True)
    assert order.index("event") < order.index("datum stop")
