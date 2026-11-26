"""In-process lifecycle: reference-counted router lifespans, the started guard, Mount, dependency order."""

import logging
import threading
import time
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

import pytest
from datum_fakes import (
    HEADERS,
    StubRepository,
    StubRuntime,
    StubSandbox,
    config,
    definition,
    dep_a,
    dep_b,
    refusing,
    runtime_of,
    sandbox_of,
)
from fastapi import APIRouter, Depends, FastAPI
from fastapi.testclient import TestClient
from starlette.applications import Starlette
from starlette.routing import Mount
from trace_log import TRACE

from datum_core.events import DatumRuntimeReadyEvent, listener
from datum_fastapi import Datum, routers
from datum_fastapi.lifespan import COMPOSITION_ERROR
from datum_sandbox.checks import DatumConfigurationError

PATH = "/api/forms/contact/definition"
SECOND = "/second/forms/contact/definition"
THIRD = "/third/forms/contact/definition"


class CountingDatum(Datum):
    """Counts how often a router lifespan enters and leaves it."""

    entries = 0
    exits = 0

    async def __aenter__(self) -> "CountingDatum":
        type(self).entries += 1
        await super().__aenter__()
        return self

    async def __aexit__(self, *exc: object) -> None:
        type(self).exits += 1
        await super().__aexit__(*exc)


@dataclass
class Harness:
    datum: CountingDatum
    runtime: StubRuntime
    starts: list[DatumRuntimeReadyEvent] = field(default_factory=list)


def harness(*, fail_start: bool = False) -> Harness:
    CountingDatum.entries = CountingDatum.exits = 0
    runtime = StubRuntime()
    starts: list[DatumRuntimeReadyEvent] = []
    sections: dict[str, Any] = {"builder": {"enabled": True}, "workers_expected": 2} if fail_start else {}
    datum = CountingDatum(
        config=config(**sections),
        runtime=runtime_of(runtime),
        sandbox=sandbox_of(StubSandbox()),
        form_repository=StubRepository(definition()),
        listeners=[listener(DatumRuntimeReadyEvent, starts.append)],
    )
    return Harness(datum, runtime, starts)


def build(datum: Datum, *, a: Any = dep_a, b: Any = dep_b, **app_kwargs: Any) -> FastAPI:
    """Four routers, one of them included twice, each with a router-level list `a` and an include-time list `b`."""
    app = FastAPI(**app_kwargs)
    forms = routers.forms(datum, dependencies=[Depends(a)])
    app.include_router(forms, dependencies=[Depends(b)])
    app.include_router(forms, prefix="/alt", dependencies=[Depends(b)])
    for name in ("second", "third", "fourth"):
        app.include_router(
            routers.forms(datum, prefix=f"/{name}", dependencies=[Depends(a)]), dependencies=[Depends(b)]
        )
    return app


def census() -> set[threading.Thread]:
    """The threads alive now, as objects (a finished thread's ident can be reused, so idents can alias)."""
    return set(threading.enumerate())


def left_behind(before: set[threading.Thread], seconds: float = 3.0) -> set[threading.Thread]:
    """The threads alive now that were not alive at `before`, once each new one had `seconds` to finish.

    anyio runs Datum's start and stop on its worker threads and, when the TestClient's portal ends, tells each to stop
    without joining it (anyio 4.16 `WorkerThread.stop` only queues the stop), so on a loaded machine a worker that has
    already been told to stop can still be alive when the `with` block returns. The join gives it the moment it needs;
    a thread Datum really left running is still alive after it.
    """
    deadline = time.monotonic() + seconds
    extra = census() - before
    for thread in extra:
        thread.join(max(0.0, deadline - time.monotonic()))
    return {thread for thread in extra if thread.is_alive()}


def datum_errors(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.levelno >= logging.ERROR and r.name.split(".")[0] == "datum"]


def test_testclient_with_the_lifespan_enters_five_times_starts_once_stops_once_and_leaves_no_thread() -> None:
    before = census()
    h = harness()
    with TestClient(build(h.datum)) as client:
        assert client.get(PATH, headers=HEADERS).status_code == 200
        assert client.get("/alt" + PATH, headers=HEADERS).status_code == 200
    assert (CountingDatum.entries, CountingDatum.exits) == (5, 5)
    assert len(h.starts) == 1
    assert h.runtime.closed == 1
    assert left_behind(before) == set()


def test_testclient_without_with_answers_503_server_unavailable_with_one_error_over_three_requests(
    caplog: pytest.LogCaptureFixture,
) -> None:
    h = harness()
    client = TestClient(build(h.datum))
    with caplog.at_level(logging.ERROR):
        replies = [client.get(path, headers=HEADERS) for path in (PATH, THIRD, "/alt" + PATH)]
    assert [r.status_code for r in replies] == [503, 503, 503]
    assert replies[0].json()["errors"][0]["code"] == "server.unavailable"
    assert "retry-after" not in replies[0].headers  # only server.busy carries it
    assert h.starts == []
    assert len(datum_errors(caplog)) == 1
    assert datum_errors(caplog)[0].getMessage() == COMPOSITION_ERROR
    assert "--lifespan off" in COMPOSITION_ERROR
    assert "async with datum:" in COMPOSITION_ERROR


def test_a_raising_start_surfaces_from_the_testclient_with_nothing_leaked() -> None:
    before = census()
    h = harness(fail_start=True)
    with pytest.raises(DatumConfigurationError) as raised, TestClient(build(h.datum)):
        pass
    assert [p.id for p in raised.value.problems] == ["datum.E002"]
    assert h.starts == []
    assert h.datum.started is False
    assert left_behind(before) == set()


def test_a_mount_without_the_parents_lifespan_answers_503_with_one_error(caplog: pytest.LogCaptureFixture) -> None:
    h = harness()
    parent = Starlette(routes=[Mount("/m", app=build(h.datum))])
    with caplog.at_level(logging.ERROR), TestClient(parent) as client:
        codes = [
            client.get("/m" + PATH, headers=HEADERS).status_code,
            client.get("/m" + SECOND, headers=HEADERS).status_code,
        ]
    assert codes == [503, 503]
    assert h.starts == []
    assert len(datum_errors(caplog)) == 1
    assert datum_errors(caplog)[0].getMessage() == COMPOSITION_ERROR


def test_a_mount_with_async_with_datum_in_the_parents_lifespan_answers_200_and_starts_and_stops_once() -> None:
    h = harness()

    @asynccontextmanager
    async def lifespan(app: Starlette) -> AsyncIterator[None]:
        async with h.datum:
            yield

    parent = Starlette(routes=[Mount("/m", app=build(h.datum))], lifespan=lifespan)
    with TestClient(parent) as client:
        assert client.get("/m" + PATH, headers=HEADERS).status_code == 200
    assert CountingDatum.entries == 1  # a Mount forwards no lifespan: only the parent's entry
    assert len(h.starts) == 1
    assert h.runtime.closed == 1


def test_async_with_datum_in_the_app_lifespan_plus_the_routers_enters_six_times_and_starts_once() -> None:
    h = harness()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with h.datum:
            yield

    with TestClient(build(h.datum, lifespan=lifespan)) as client:
        assert client.get(PATH, headers=HEADERS).status_code == 200
    assert CountingDatum.entries == 6
    assert len(h.starts) == 1
    assert h.runtime.closed == 1


def test_the_control_with_a_plain_router_orders_the_include_time_list_before_the_router_list() -> None:
    h = harness()
    router = APIRouter(lifespan=h.datum.lifespan, dependencies=[Depends(dep_a)])

    @router.get("/ping")
    async def ping() -> dict[str, list[str]]:
        return {"trace": list(TRACE)}

    app = FastAPI()
    app.include_router(router, dependencies=[Depends(dep_b)])
    with TestClient(app) as client:
        assert client.get("/ping", headers=HEADERS).json()["trace"] == ["b", "a"]


def test_the_application_dependency_runs_include_time_first_then_router_level() -> None:
    h = harness()
    with TestClient(build(h.datum)) as client:
        assert client.get(PATH, headers=HEADERS).status_code == 200
    assert TRACE == ["b", "a"]


def test_a_router_level_refusal_is_a_403_and_an_include_time_refusal_a_401_both_untouched() -> None:
    h = harness()
    with TestClient(build(h.datum, a=refusing(403, "a"))) as client:
        reply = client.get(PATH, headers=HEADERS)
    assert (reply.status_code, reply.json()) == (403, {"detail": "a refused"})
    assert TRACE == ["b", "a"]
    TRACE.clear()
    with TestClient(build(h.datum, b=refusing(401, "b"))) as client:
        reply = client.get(PATH, headers=HEADERS)
    assert (reply.status_code, reply.json()) == (401, {"detail": "b refused"})
    assert TRACE == ["b"]


def test_with_the_lifespan_off_the_include_time_refusal_comes_before_the_guard_and_the_router_one_after_it() -> None:
    h = harness()
    reply = TestClient(build(h.datum, b=refusing(401, "b"))).get(PATH, headers=HEADERS)
    assert reply.status_code == 401  # the application's refusal precedes the guard
    TRACE.clear()
    reply = TestClient(build(h.datum, a=refusing(403, "a"))).get(PATH, headers=HEADERS)
    assert reply.status_code == 503  # the guard precedes the router-level list
    assert TRACE == ["b"]


def test_the_same_dependency_in_both_lists_runs_once() -> None:
    h = harness()
    app = FastAPI()
    app.include_router(routers.forms(h.datum, dependencies=[Depends(dep_a)]), dependencies=[Depends(dep_a)])
    with TestClient(app) as client:
        assert client.get(PATH, headers=HEADERS).status_code == 200
    assert TRACE == ["a"]


def test_including_a_router_twice_warns_about_duplicate_operation_ids() -> None:
    h = harness()
    with pytest.warns(UserWarning, match="Duplicate Operation ID"):
        build(h.datum).openapi()


def test_a_failed_router_start_still_exits_the_applications_own_lifespan() -> None:
    events: list[str] = []

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        events.append("app start")
        try:
            yield
        finally:
            events.append("app stop")

    h = harness(fail_start=True)
    with pytest.raises(DatumConfigurationError), TestClient(build(h.datum, lifespan=lifespan)):
        pass
    assert events == ["app start", "app stop"]
