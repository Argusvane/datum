"""`datum_core.aio.AsyncSubmissionService`: the sync service on the runner, one tracked call per service call."""

import asyncio
import threading
import time
from typing import Any

import anyio
import anyio.lowlevel
import pytest
from submissions_support import (
    bus,
    definition,
    envelope,
    http_context,
    journey_check,
    refused_by_kernel,
    started,
    wrapped,
)

from datum_core.aio import AsyncRunner, AsyncSubmissionService, anyio_awaiter
from datum_core.events import listener
from datum_core.hooks import HookFindings
from datum_core.submissions import (
    Accepted,
    Allow,
    FormRef,
    Redelivered,
    Rejected,
    SubmissionContext,
    SubmissionValidatedEvent,
    Throttled,
    ValidatedSubmission,
)
from datum_sandbox.wasi import EngineClosedError

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def runner(threads: int = 4) -> AsyncRunner:
    return AsyncRunner(worker_threads=threads, wait=1.0, shutdown_grace=2.0)


async def test_an_async_submit_answers_what_the_sync_service_answers_with_the_handler_called_once() -> None:
    with started() as rig:
        facade = AsyncSubmissionService(rig.service, runner())
        first = await facade.submit(FormRef.from_document(), envelope(), bus(submission_key="attempt-1"))
        again = await facade.submit(FormRef.from_document(), envelope(), http_context(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert len(rig.handler.calls) == 1


async def test_validate_test_and_inspect_each_run_on_a_worker_thread_not_the_loop() -> None:
    seen: list[int] = []

    def pre_check(incoming: Any) -> Any:
        seen.append(threading.get_ident())
        return Allow()

    with started(pre_checks=[pre_check]) as rig:
        facade = AsyncSubmissionService(rig.service, runner())
        original = rig.sandbox.inspect

        def inspect(*args: Any, **kwargs: Any) -> Any:
            seen.append(threading.get_ident())
            return original(*args, **kwargs)

        rig.sandbox.inspect = inspect  # type: ignore[method-assign]
        await facade.validate(FormRef.from_document(), journey_check(envelope()), bus())
        await facade.test(FormRef.from_document(), wrapped(envelope()), bus())
        await facade.inspect("abi", definition(), bus())
    assert len(seen) == 3
    assert threading.get_ident() not in seen


async def test_an_async_hook_is_resolved_through_the_anyio_awaiter_on_the_loop() -> None:
    loop_thread = threading.get_ident()
    ran_on: list[int] = []

    async def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        ran_on.append(threading.get_ident())
        await anyio.lowlevel.checkpoint()
        return None

    with started(validators=[validator], awaiter=anyio_awaiter) as rig:
        facade = AsyncSubmissionService(rig.service, runner())
        outcome = await facade.submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Accepted)
    assert ran_on == [loop_thread]


async def test_a_call_that_the_runner_refuses_after_the_drain_began_raises_engine_closed() -> None:
    with started() as rig:
        pool = runner()
        facade = AsyncSubmissionService(rig.service, pool)
        await pool.drain()
        with pytest.raises(EngineClosedError):
            await facade.submit(FormRef.from_document(), envelope(), bus())
    assert rig.handler.calls == []


async def test_the_call_completes_its_effect_and_events_when_its_caller_is_cancelled() -> None:
    gate = threading.Event()
    with started() as rig:
        rig.handler.hold = lambda: gate.wait(timeout=10)
        facade = AsyncSubmissionService(rig.service, runner())
        outer = asyncio.create_task(facade.submit(FormRef.from_document(), envelope(), bus()))
        for _ in range(200):
            if rig.handler.calls:
                break
            await anyio.sleep(0.01)
        outer.cancel()
        with pytest.raises(asyncio.CancelledError):
            await outer
        gate.set()
        for _ in range(200):
            if "event:SubmissionValidatedEvent" in rig.trail:
                break
            await anyio.sleep(0.01)
    assert "event:SubmissionValidatedEvent" in rig.trail
    assert [r for *_, r in rig.idempotency.records]


async def test_a_concurrent_load_accounts_for_every_call_and_stores_one_receipt_per_document() -> None:
    """Every started call ends as exactly one outcome; repeats of a document end Accepted or Redelivered."""
    with started() as rig:
        facade = AsyncSubmissionService(rig.service, runner(8))
        results: list[Any] = []

        async def one(number: int) -> None:
            # Six attempts, each retried five times: a retry carries its attempt's key.
            document = envelope(values={"name": f"person-{number % 6}"})
            results.append(
                await facade.submit(FormRef.from_document(), document, bus(submission_key=f"attempt-{number % 6}"))
            )

        async with anyio.create_task_group() as group:
            for number in range(30):
                group.start_soon(one, number)
    assert len(results) == 30
    assert {type(item) for item in results} <= {Accepted, Redelivered}
    assert 6 <= len(rig.handler.calls) <= 30
    assert len({key for _, _, key, _ in rig.idempotency.records}) == 6
    assert all(rig.idempotency.find("contact", "1", key) is not None for _, _, key, _ in rig.idempotency.records)


async def test_refusals_and_failures_are_counted_in_the_same_load() -> None:
    with started() as rig:
        facade = AsyncSubmissionService(rig.service, runner(8))
        rig.sandbox.verdict = refused_by_kernel()
        outcomes = [
            await facade.submit(FormRef.from_document(), envelope(values={"name": ""}), bus()) for _ in range(3)
        ]
        rig.sandbox.verdict = None
        rig.throttle.deny = 1
        outcomes.append(await facade.submit(FormRef.from_document(), envelope(), http_context()))
    assert [type(item) for item in outcomes] == [Rejected, Rejected, Rejected, Throttled]
    assert rig.handler.calls == []


async def test_a_sync_listener_that_sleeps_holds_a_worker_thread_and_never_the_loop() -> None:
    ticks = 0

    def slow(event: SubmissionValidatedEvent) -> None:
        time.sleep(0.3)

    async def ticker() -> None:
        nonlocal ticks
        while True:
            await anyio.sleep(0.02)
            ticks += 1

    with started(listeners=[listener(SubmissionValidatedEvent, slow)]) as rig:
        facade = AsyncSubmissionService(rig.service, runner())
        async with anyio.create_task_group() as group:
            group.start_soon(ticker)
            outcome = await facade.submit(FormRef.from_document(), envelope(), bus())
            group.cancel_scope.cancel()
    assert isinstance(outcome, Accepted)
    assert ticks >= 5
