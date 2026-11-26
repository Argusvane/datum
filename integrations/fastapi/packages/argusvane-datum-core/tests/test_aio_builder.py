"""`datum_core.aio.AsyncBuilderService`: the sync builder on the runner, one tracked call per write.

The whole write (the hooks, the kernel's check, the store, the snapshot, the saved event) is ONE tracked task: a caller
cancelled natively leaves the effect to finish and the drain waits for it.
"""

import asyncio
import inspect
import threading

import anyio
import anyio.lowlevel
import anyio.to_thread
import pytest
from builder_support import FORM, PRINCIPAL, definition, started_builder

from datum_core.aio import AsyncBuilderService, AsyncRunner, anyio_awaiter
from datum_core.builder import (
    BuilderSaveCandidate,
    BuilderSaveDraft,
    BuilderService,
    CatalogOutdated,
    CatalogSaved,
    Exists,
    LocaleChanges,
    Outdated,
    Saved,
    Unavailable,
)
from datum_core.hooks import HookFindings
from datum_core.stores import catalog_etag
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

pytestmark = pytest.mark.anyio


@pytest.fixture
def anyio_backend() -> str:
    return "asyncio"


def runner(threads: int = 4) -> AsyncRunner:
    return AsyncRunner(worker_threads=threads, wait=1.0, shutdown_grace=2.0)


async def test_an_async_save_answers_what_the_sync_service_answers() -> None:
    with started_builder() as rig:
        facade = AsyncBuilderService(rig.service, runner())
        saved = await facade.save(
            FORM, definition(version="2"), expected_sha256=rig.current_hash(), principal=PRINCIPAL, changes=None
        )
        stale = await facade.save(FORM, definition(version="3"), expected_sha256="0" * 64, principal=None)
        created = await facade.create(definition("fresh"), principal=None)
        again = await facade.create(definition("fresh"), principal=None)
    assert isinstance(saved, Saved)
    assert saved.sha256 == rig.current_hash()
    assert rig.stored().definition["version"] == "2"
    assert isinstance(stale, Outdated)
    assert isinstance(created, Saved)
    assert created.created is True
    assert isinstance(again, Exists)


async def test_the_catalog_write_is_an_async_call_too() -> None:
    with started_builder() as rig:
        facade = AsyncBuilderService(rig.service, runner())
        first = await facade.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=None
        )
        second = await facade.save_translations(
            FORM, {"fr": {"form": {"title": "deux"}}}, expected_etag=catalog_etag({}), principal=None
        )
    assert isinstance(first, CatalogSaved)
    assert isinstance(second, CatalogOutdated)
    assert second.current_etag == first.etag


async def test_the_facade_exposes_the_service_it_wraps() -> None:
    with started_builder() as rig:
        facade = AsyncBuilderService(rig.service, runner())
        assert facade.service is rig.service


async def test_every_write_runs_on_a_worker_thread_not_the_loop() -> None:
    seen: list[int] = []

    def customize(draft: BuilderSaveDraft) -> None:
        seen.append(threading.get_ident())

    def validate(candidate: BuilderSaveCandidate) -> HookFindings | None:
        seen.append(threading.get_ident())
        return None

    with started_builder(builder_save_customizers=[customize], builder_save_validators=[validate]) as rig:
        facade = AsyncBuilderService(rig.service, runner())
        await facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None)
        await facade.create(definition("fresh"), principal=None)
    assert len(seen) == 4
    assert threading.get_ident() not in seen


async def test_an_async_hook_is_resolved_through_the_anyio_awaiter_on_the_loop() -> None:
    loop_thread = threading.get_ident()
    ran_on: list[int] = []

    async def customize(draft: BuilderSaveDraft) -> None:
        ran_on.append(threading.get_ident())
        await anyio.lowlevel.checkpoint()
        draft.definition["title"] = "async"

    async def validate(candidate: BuilderSaveCandidate) -> HookFindings | None:
        ran_on.append(threading.get_ident())
        await anyio.lowlevel.checkpoint()
        return None

    with started_builder(
        builder_save_customizers=[customize], builder_save_validators=[validate], awaiter=anyio_awaiter
    ) as rig:
        facade = AsyncBuilderService(rig.service, runner())
        outcome = await facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None)
    assert isinstance(outcome, Saved)
    assert ran_on == [loop_thread, loop_thread]


async def test_a_hook_raise_reaches_the_awaiting_caller_as_raised() -> None:
    def customize(draft: BuilderSaveDraft) -> None:
        raise RuntimeError("the hook failed")

    with started_builder(builder_save_customizers=[customize]) as rig:
        facade = AsyncBuilderService(rig.service, runner())
        with pytest.raises(RuntimeError, match="the hook failed"):
            await facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None)
        assert rig.stored().definition["version"] == "1"


async def test_a_call_that_the_runner_refuses_after_the_drain_began_raises_engine_closed() -> None:
    with started_builder() as rig:
        pool = runner()
        facade = AsyncBuilderService(rig.service, pool)
        await pool.drain()
        with pytest.raises(EngineClosedError):
            await facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None)
        assert rig.stored().definition["version"] == "1"


async def test_a_call_that_finds_no_free_worker_thread_raises_engine_busy_and_stores_nothing() -> None:
    gate = threading.Event()
    entered = threading.Event()

    def hold(draft: BuilderSaveDraft) -> None:
        entered.set()
        gate.wait(10)

    with started_builder(builder_save_customizers=[hold]) as rig:
        pool = AsyncRunner(worker_threads=1, wait=0.05, shutdown_grace=2.0)
        facade = AsyncBuilderService(rig.service, pool)
        first = asyncio.create_task(facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None))
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        with pytest.raises(EngineBusyError):
            await facade.save(FORM, definition(version="3"), expected_sha256=None, principal=None)
        gate.set()
        assert isinstance(await first, Saved)
        assert rig.stored().definition["version"] == "2"


async def test_a_native_cancel_of_the_caller_still_stores_and_publishes_and_the_drain_waits() -> None:
    gate = threading.Event()
    entered = threading.Event()

    def hold(candidate: BuilderSaveCandidate) -> HookFindings | None:
        entered.set()
        gate.wait(10)
        return None

    with started_builder(builder_save_validators=[hold]) as rig:
        pool = runner()
        facade = AsyncBuilderService(rig.service, pool)
        call = asyncio.create_task(facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None))
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        call.cancel()  # what uvicorn does at --timeout-graceful-shutdown
        with pytest.raises(asyncio.CancelledError):
            await call
        assert pool.in_flight == 1
        assert pool.slots_in_use == 1  # the limiter never undercounts while the call drains
        gate.set()
        result = await pool.drain()
        assert result.abandoned == 0
        assert rig.stored().definition["version"] == "2"
        assert [type(event).__name__ for event in rig.events] == ["FormDefinitionSavedEvent"]


async def test_two_concurrent_saves_on_one_hash_give_one_saved_and_one_outdated() -> None:
    with started_builder() as rig:
        facade = AsyncBuilderService(rig.service, runner(8))
        first = rig.current_hash()
        outcomes = await asyncio.gather(
            *(facade.save(FORM, definition(version=f"v{n}"), expected_sha256=first, principal=None) for n in range(6))
        )
    assert sum(isinstance(o, Saved) for o in outcomes) == 1
    assert sum(isinstance(o, Outdated) for o in outcomes) == 5


async def test_the_signatures_take_the_same_keywords_as_the_sync_service() -> None:
    for name in ("save", "create", "save_translations"):
        sync = inspect.signature(getattr(BuilderService, name))
        wrapped = inspect.signature(getattr(AsyncBuilderService, name))
        assert [(p.name, p.kind) for p in wrapped.parameters.values()] == [
            (p.name, p.kind) for p in sync.parameters.values()
        ]


# -- the three writes share one path -----------------------------------------------------------------------------------
WRITES = ["save", "create", "save_translations"]


def _start_write(facade: AsyncBuilderService, kind: str) -> "asyncio.Task[object]":
    if kind == "save":
        coro = facade.save(FORM, definition(version="2"), expected_sha256=None, principal=None)
    elif kind == "create":
        coro = facade.create(definition("fresh"), principal=None)
    else:
        coro = facade.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=None
        )
    return asyncio.create_task(coro)


def _held_rig(kind: str, gate: threading.Event, entered: threading.Event):  # type: ignore[no-untyped-def]
    def hold_candidate(candidate: BuilderSaveCandidate) -> HookFindings | None:
        entered.set()
        gate.wait(10)
        return None

    return started_builder(builder_save_validators=[hold_candidate] if kind != "save_translations" else [])


def _hold_translations(rig: object, gate: threading.Event, entered: threading.Event, method: str = "write") -> None:
    inner = getattr(rig.translations, method)  # type: ignore[attr-defined]

    def write(*args: object, **kwargs: object) -> object:
        entered.set()
        gate.wait(10)
        return inner(*args, **kwargs)

    setattr(rig.translations, method, write)  # type: ignore[attr-defined]


def _stored(rig: object, kind: str) -> bool:
    if kind == "save":
        return bool(rig.stored().definition["version"] == "2")  # type: ignore[attr-defined]
    if kind == "create":
        return rig.repository.inner.current("fresh") is not None  # type: ignore[attr-defined]
    return rig.translations.inner.read(FORM) is not None  # type: ignore[attr-defined]


@pytest.mark.parametrize("kind", WRITES)
async def test_every_write_holds_the_slot_and_the_drain_through_a_native_cancel(kind: str) -> None:
    gate, entered = threading.Event(), threading.Event()
    with _held_rig(kind, gate, entered) as rig:
        if kind == "save_translations":
            _hold_translations(rig, gate, entered)
        pool = runner()
        call = _start_write(AsyncBuilderService(rig.service, pool), kind)
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        call.cancel()
        with pytest.raises(asyncio.CancelledError):
            await call
        assert pool.in_flight == 1
        assert pool.slots_in_use == 1
        gate.set()
        result = await pool.drain()
        assert result.abandoned == 0
        assert _stored(rig, kind)


@pytest.mark.parametrize("kind", WRITES)
async def test_every_write_finding_no_free_worker_thread_raises_engine_busy_and_stores_nothing(kind: str) -> None:
    gate, entered = threading.Event(), threading.Event()
    with _held_rig(kind, gate, entered) as rig:
        if kind == "save_translations":
            _hold_translations(rig, gate, entered)
        pool = AsyncRunner(worker_threads=1, wait=0.05, shutdown_grace=2.0)
        facade = AsyncBuilderService(rig.service, pool)
        first = _start_write(facade, kind)
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        with pytest.raises(EngineBusyError):
            await _start_write(facade, kind)
        assert not _stored(rig, kind)
        gate.set()
        await first
        assert _stored(rig, kind)


async def test_the_principal_reaches_the_hooks_of_a_save_and_a_create_and_the_catalog_write(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    drafts: list[object] = []
    candidates: list[object] = []

    def customize(draft: BuilderSaveDraft) -> None:
        drafts.append(draft.principal)

    def validate(candidate: BuilderSaveCandidate) -> HookFindings | None:
        candidates.append(candidate.principal)
        return None

    with started_builder(builder_save_customizers=[customize], builder_save_validators=[validate]) as rig:
        passed: list[object] = []
        original = rig.service.save_translations

        def spy(*args: object, **kwargs: object) -> object:
            passed.append(kwargs.get("principal"))
            return original(*args, **kwargs)  # type: ignore[arg-type]

        monkeypatch.setattr(rig.service, "save_translations", spy)
        facade = AsyncBuilderService(rig.service, runner())
        await facade.save(FORM, definition(version="2"), expected_sha256=None, principal=PRINCIPAL)
        await facade.create(definition("fresh"), principal=PRINCIPAL)
        await facade.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=PRINCIPAL
        )
    assert drafts == [PRINCIPAL, PRINCIPAL]
    assert candidates == [PRINCIPAL, PRINCIPAL]
    assert passed == [PRINCIPAL]


async def test_the_locale_changes_of_an_async_save_reach_the_outcome() -> None:
    with started_builder() as rig:
        facade = AsyncBuilderService(rig.service, runner())
        outcome = await facade.save(
            FORM,
            definition(version="2"),
            expected_sha256=None,
            principal=None,
            changes=LocaleChanges(removed=("fr",)),
        )
    assert isinstance(outcome, Saved)
    assert outcome.removed_locales == ("fr",)


# -- a write the grace abandoned stores nothing after the stop ---------------------------------------------------------
@pytest.mark.parametrize("kind", WRITES)
async def test_a_write_abandoned_by_the_grace_stores_nothing_after_the_stop(kind: str) -> None:
    gate, entered = threading.Event(), threading.Event()
    with _held_rig(kind, gate, entered) as rig:
        if kind == "save_translations":
            _hold_translations(rig, gate, entered, "read")
        pool = AsyncRunner(worker_threads=4, wait=1.0, shutdown_grace=0.2)
        call = _start_write(AsyncBuilderService(rig.service, pool), kind)
        assert await anyio.to_thread.run_sync(entered.wait, 10)
        assert (await pool.drain()).abandoned == 1
        rig.datum.stop()
        gate.set()
        outcome = await asyncio.gather(call, return_exceptions=True)
        assert isinstance(outcome[0], Unavailable)
        assert not _stored(rig, kind)
        assert rig.events == []
