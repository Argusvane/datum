"""`datum_core.aio.AsyncTimestampService`: the authority on the runner, one tracked call per token.

The whole issue (the customizers, the time, the serial, the signature, the log row, the events) is ONE tracked task: a
caller cancelled natively leaves the effect to finish and the drain waits for it. Signing runs on a worker thread and
never on the loop. A store that raises ends the token as a 503 `systemFailure` rejection (the serial, if taken, is not
reused); the runner's busy and closed errors reach the caller as raised.
"""

import asyncio
import inspect
import threading
from typing import Any

import anyio
import anyio.lowlevel
import anyio.to_thread
import pytest
from tsa_der import parse_reply, query_der
from tsa_support import Clock, CountingSerials, FailingSerials, IdentityKey, ListLog, query_of, sha256, started_tsa

from datum_core.aio import AsyncRunner, AsyncTimestampService, anyio_awaiter
from datum_core.events import TimestampRefusedEvent
from datum_core.testing.tsa_pki import TsaPki
from datum_core.timestamp import TimestampAuthority, TimestampRefusedError, TimestampRequestDraft
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

pytestmark = pytest.mark.anyio

REQUEST = query_der(sha256(b"hello"), nonce=77)


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def runner(threads: int = 4) -> AsyncRunner:
    return AsyncRunner(worker_threads=threads, wait=1.0, shutdown_grace=2.0)


async def test_an_async_answer_is_what_the_sync_authority_answers(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.rsa) as rig:
        facade = AsyncTimestampService(rig.authority, runner())
        granted = await facade.answer(REQUEST)
        refused = await facade.answer(b"not a request")
    assert granted.grant is not None
    assert parse_reply(granted.response).status == 0
    assert refused.refusal is not None
    assert parse_reply(refused.response).fail_bits == {5}


async def test_issue_is_an_async_call_too(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        grant = await AsyncTimestampService(rig.authority, runner()).issue(query_of(), channel="seal", client="c-1")
    assert grant.serial == 1


async def test_the_facade_exposes_the_authority_it_wraps(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        assert AsyncTimestampService(rig.authority, runner()).service is rig.authority


async def test_every_token_is_made_on_a_worker_thread_not_the_loop(tsa_pki: TsaPki) -> None:
    seen: list[int] = []

    def customize(draft: TimestampRequestDraft) -> None:
        seen.append(threading.get_ident())

    class SpyKey(IdentityKey):
        def sign(self, data: bytes) -> bytes:
            seen.append(threading.get_ident())
            return super().sign(data)

    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[customize], tsa_key_material=SpyKey(tsa_pki.ec)) as rig:
        await AsyncTimestampService(rig.authority, runner()).answer(REQUEST)
    assert len(seen) == 2
    assert threading.get_ident() not in seen


async def test_an_async_customizer_is_resolved_through_the_anyio_awaiter_on_the_loop(tsa_pki: TsaPki) -> None:
    loop_thread = threading.get_ident()
    ran_on: list[int] = []

    async def customize(draft: TimestampRequestDraft) -> None:
        ran_on.append(threading.get_ident())
        await anyio.lowlevel.checkpoint()

    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[customize], awaiter=anyio_awaiter) as rig:
        await AsyncTimestampService(rig.authority, runner()).answer(REQUEST)
    assert ran_on == [loop_thread]


async def test_the_signatures_take_the_same_keywords_as_the_sync_authority() -> None:
    for name in ("issue", "answer"):
        sync = inspect.signature(getattr(TimestampAuthority, name))
        wrapped = inspect.signature(getattr(AsyncTimestampService, name))
        assert [(p.name, p.kind) for p in wrapped.parameters.values()] == [
            (p.name, p.kind) for p in sync.parameters.values()
        ]


# -- stores that raise -------------------------------------------------------------------------------------------------
async def test_a_serial_store_that_raises_ends_in_a_503_system_failure_rejection_without_its_words(
    tsa_pki: TsaPki,
) -> None:
    with started_tsa(tsa_pki.ec, tsa_serial_allocator=FailingSerials()) as rig:
        facade = AsyncTimestampService(rig.authority, runner())
        answer = await facade.answer(REQUEST)
        with pytest.raises(TimestampRefusedError) as raised:
            await facade.issue(query_of())
    assert answer.refusal is not None
    assert answer.refusal.http_status == 503
    assert parse_reply(answer.response).fail_bits == {25}
    assert "db.internal.example" not in answer.response.decode("latin-1")
    assert raised.value.failure == "systemFailure"
    assert isinstance(raised.value.__cause__, ConnectionError)
    assert rig.key.signs == 0


async def test_a_key_that_fails_to_sign_is_a_system_failure_too(tsa_pki: TsaPki) -> None:
    class Broken(IdentityKey):
        def sign(self, data: bytes) -> bytes:
            raise RuntimeError("hsm offline")

    with started_tsa(tsa_pki.ec, tsa_key_material=Broken(tsa_pki.ec)) as rig:
        answer = await AsyncTimestampService(rig.authority, runner()).answer(REQUEST)
    assert parse_reply(answer.response).fail_bits == {25}
    assert "hsm offline" not in answer.response.decode("latin-1")


async def test_a_log_that_fails_to_append_means_no_token_and_the_serial_is_not_reused(tsa_pki: TsaPki) -> None:
    class Failing(ListLog):
        def append(self, entry: Any) -> None:
            raise OSError("disk full")

    serials = CountingSerials()
    with started_tsa(tsa_pki.ec, tsa_log=Failing(), tsa_serial_allocator=serials) as rig:
        facade = AsyncTimestampService(rig.authority, runner())
        answer = await facade.answer(REQUEST)
        assert answer.grant is None
        assert parse_reply(answer.response).fail_bits == {25}
        assert serials.allocations == 1
        assert [type(e) for e in rig.events] == [TimestampRefusedEvent]  # no issued event for a token never completed
        refused = rig.events[0]
        assert isinstance(refused, TimestampRefusedEvent)
        assert refused.fail_info == "systemFailure"
    with started_tsa(tsa_pki.ec, tsa_serial_allocator=serials) as rig:
        grant = await AsyncTimestampService(rig.authority, runner()).issue(query_of())
    assert grant.serial == 2


# -- the runner --------------------------------------------------------------------------------------------------------
async def test_a_call_that_the_runner_refuses_after_the_drain_began_raises_engine_closed(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        pool = runner()
        facade = AsyncTimestampService(rig.authority, pool)
        await pool.drain()
        with pytest.raises(EngineClosedError):
            await facade.answer(REQUEST)
        assert rig.serials.allocations == 0


async def test_a_call_that_finds_no_free_worker_thread_raises_engine_busy_and_takes_no_serial(tsa_pki: TsaPki) -> None:
    gate, entered = threading.Event(), threading.Event()

    def hold(draft: TimestampRequestDraft) -> None:
        entered.set()
        gate.wait(10)

    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[hold]) as rig:
        pool = AsyncRunner(worker_threads=1, wait=0.05, shutdown_grace=2.0)
        facade = AsyncTimestampService(rig.authority, pool)
        first = asyncio.create_task(facade.answer(REQUEST))
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        with pytest.raises(EngineBusyError):
            await facade.answer(REQUEST)
        gate.set()
        assert (await first).grant is not None
        assert rig.serials.allocations == 1


async def test_a_native_cancel_of_the_caller_still_issues_publishes_and_the_drain_waits(tsa_pki: TsaPki) -> None:
    gate, entered = threading.Event(), threading.Event()

    def hold(draft: TimestampRequestDraft) -> None:
        entered.set()
        gate.wait(10)

    with started_tsa(tsa_pki.ec, timestamp_request_customizers=[hold]) as rig:
        pool = runner()
        call = asyncio.create_task(AsyncTimestampService(rig.authority, pool).answer(REQUEST))
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        call.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await call
        assert pool.in_flight == 1
        assert pool.slots_in_use == 1
        gate.set()
        result = await pool.drain()
        assert result.abandoned == 0
        assert rig.serials.allocations == 1
        assert [type(event).__name__ for event in rig.events] == ["TimestampIssuedEvent"]
        assert len(rig.log.entries) == 1


async def test_concurrent_requests_get_distinct_serials(tsa_pki: TsaPki) -> None:
    with started_tsa(tsa_pki.ec) as rig:
        facade = AsyncTimestampService(rig.authority, runner(8))
        answers = await asyncio.gather(*(facade.answer(REQUEST) for _ in range(16)))
    serials = {answer.grant.serial for answer in answers if answer.grant is not None}
    assert len(serials) == 16


async def test_the_clock_the_authority_reads_is_the_one_the_datum_was_given(tsa_pki: TsaPki) -> None:
    clock = Clock()
    with started_tsa(tsa_pki.ec, tsa_time_source=clock) as rig:
        await AsyncTimestampService(rig.authority, runner()).answer(REQUEST)
    assert clock.reads == 1
