"""The option snapshot of a validation: every data-sourced choice under ONE deadline, one awaiter hop.

`DataSourceService.snapshot` asks every source at once: side by side on the pool with no awaiter, or as one coroutine
through the awaiter (async providers awaited on the loop, sync ones sent to the same pool). A failing source or the
spent deadline makes the whole snapshot unavailable; a source no provider serves is left out.
"""

import asyncio
import threading
import time
from collections.abc import Awaitable
from typing import Any, TypeVar

import pytest
from submissions_support import ThreadLoopAwaiter

from datum_core.forms import DataSourceRequest, DataSourceService, DataSourceUnavailable
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import JsonValue

T = TypeVar("T")


def rows(source_id: str) -> list[dict[str, JsonValue]]:
    return [{"value": f"{source_id}-1", "label": source_id}]


class Slow:
    """A sync provider for every source in `serves`; each `items` call sleeps `seconds` (released at teardown)."""

    def __init__(self, seconds: float, serves: tuple[str, ...] = ("a", "b", "c", "d")) -> None:
        self.seconds = seconds
        self.serves = serves
        self.release = threading.Event()
        self.asked: list[str] = []

    def exists(self, source_id: str) -> bool:
        return source_id in self.serves

    def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        self.asked.append(request.source_id)
        self.release.wait(self.seconds)
        return rows(request.source_id)


class AsyncSlow:
    """An async provider for every source in `serves`; each `items` call awaits `seconds`."""

    def __init__(self, seconds: float, serves: tuple[str, ...] = ("a", "b", "c", "d")) -> None:
        self.seconds = seconds
        self.serves = serves
        self.requests: list[DataSourceRequest] = []

    async def exists(self, source_id: str) -> bool:
        return source_id in self.serves

    async def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        self.requests.append(request)
        await asyncio.sleep(self.seconds)
        return rows(request.source_id)


class CountingAwaiter:
    """The test awaiter, counting its hops."""

    def __init__(self) -> None:
        self.inner = ThreadLoopAwaiter()
        self.hops = 0

    def __call__(self, awaitable: Awaitable[T], /) -> T:
        self.hops += 1
        return self.inner(awaitable)

    def close(self) -> None:
        self.inner.close()


@pytest.fixture
def awaiter() -> Any:
    counting = CountingAwaiter()
    yield counting
    counting.close()


def test_every_source_is_asked_and_the_snapshot_holds_its_items_by_source_id() -> None:
    service = DataSourceService([Slow(0)])
    found = service.snapshot(["a", "b"], form_key="contact", locale="fr")
    service.close()
    assert found == {"a": rows("a"), "b": rows("b")}


def test_a_source_no_provider_serves_is_left_out_not_refused() -> None:
    service = DataSourceService([Slow(0, serves=("a",))])
    found = service.snapshot(["a", "zz"], form_key="contact", locale="en")
    service.close()
    assert found == {"a": rows("a")}


def test_no_source_asks_nothing() -> None:
    slow = Slow(0)
    service = DataSourceService([slow])
    assert service.snapshot([], form_key="contact", locale="en") == {}
    service.close()
    assert slow.asked == []


def test_one_deadline_bounds_the_whole_snapshot_not_each_source() -> None:
    # Four sources of 0.3 s each, side by side, under a 0.6 s deadline: one deadline for the snapshot holds them all.
    slow = Slow(0.3)
    service = DataSourceService([slow], timeout=0.6, max_threads=4)
    began = time.monotonic()
    found = service.snapshot(["a", "b", "c", "d"], form_key="contact", locale="en")
    took = time.monotonic() - began
    service.close()
    assert found == {name: rows(name) for name in ("a", "b", "c", "d")}
    assert took < 1.2  # in series they would take 1.2 s


def test_hung_sources_make_the_snapshot_unavailable_at_the_one_deadline() -> None:
    names = ("a", "b", "c", "d", "e", "f")
    slow = Slow(30, serves=names)
    service = DataSourceService([slow], timeout=0.3, max_threads=8)
    began = time.monotonic()
    found = service.snapshot(list(names), form_key="contact", locale="en")
    took = time.monotonic() - began
    slow.release.set()
    service.close()
    assert isinstance(found, DataSourceUnavailable)
    assert took < 1.0  # one 0.3 s deadline for the snapshot; 0.3 s per source would be 1.8 s


def test_a_failing_source_makes_the_whole_snapshot_unavailable() -> None:
    class Broken(Slow):
        def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
            if request.source_id == "b":
                raise RuntimeError("password=ZZSECRETZZ")
            return rows(request.source_id)

    service = DataSourceService([Broken(0)])
    found = service.snapshot(["a", "b"], form_key="contact", locale="en")
    service.close()
    assert isinstance(found, DataSourceUnavailable)
    assert "ZZSECRETZZ" not in repr(found)


def test_async_providers_cross_the_awaiter_once_for_the_whole_snapshot(awaiter: CountingAwaiter) -> None:
    provider = AsyncSlow(0.05)
    service = DataSourceService([provider], awaiter=awaiter)
    found = service.snapshot(["a", "b", "c", "d"], form_key="contact", locale="de")
    service.close()
    assert found == {name: rows(name) for name in ("a", "b", "c", "d")}
    assert awaiter.hops == 1
    assert {(r.form_key, r.locale) for r in provider.requests} == {("contact", "de")}


def test_sync_and_async_providers_mix_in_one_hop_and_sync_calls_stay_off_the_loop(
    awaiter: CountingAwaiter,
) -> None:
    sync = Slow(0, serves=("a",))
    threads: list[str] = []
    original = sync.items

    def items(request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        threads.append(threading.current_thread().name)
        return original(request)

    sync.items = items  # type: ignore[method-assign]
    service = DataSourceService([sync, AsyncSlow(0, serves=("b",))], awaiter=awaiter)
    found = service.snapshot(["a", "b"], form_key=None, locale="en")
    service.close()
    assert found == {"a": rows("a"), "b": rows("b")}
    assert awaiter.hops == 1
    assert threads
    assert all(name.startswith("datum-data-source") for name in threads)


def test_a_hung_async_source_is_unavailable_at_the_deadline(awaiter: CountingAwaiter) -> None:
    service = DataSourceService([AsyncSlow(30)], timeout=0.3, awaiter=awaiter)
    began = time.monotonic()
    found = service.snapshot(["a", "b"], form_key="contact", locale="en")
    took = time.monotonic() - began
    service.close()
    assert isinstance(found, DataSourceUnavailable)
    assert took < 2


def test_an_async_provider_with_no_awaiter_names_the_missing_bridge() -> None:
    service = DataSourceService([AsyncSlow(0)])
    with pytest.raises(DatumConfigurationError, match="awaiter"):
        service.snapshot(["a"], form_key="contact", locale="en")
    service.close()


def test_a_configuration_error_inside_the_one_hop_is_raised_as_it_is(awaiter: CountingAwaiter) -> None:
    class Misconfigured(AsyncSlow):
        async def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
            raise DatumConfigurationError("the provider is not set up", hint="set it up")

    service = DataSourceService([Misconfigured(0)], awaiter=awaiter)
    with pytest.raises(DatumConfigurationError, match="not set up"):
        service.snapshot(["a"], form_key="contact", locale="en")
    service.close()
