"""Data sources: W006 on a default `exists`, one shared deadline, a pool for sync providers, the awaiter for async."""

import asyncio
import dataclasses
import logging
import threading
import time
from collections.abc import Awaitable, Mapping, Sequence
from typing import Any, TypeVar

import pytest

from datum_core.checks import W006
from datum_core.forms import (
    CompositeDataSourceProvider,
    DataSourceNotFound,
    DataSourceProvider,
    DataSourceRequest,
    DataSourceService,
    DataSourceUnavailable,
    Deadline,
    Items,
    keeps_default_exists,
)
from datum_sandbox.checks import CheckLevel, DatumConfigurationError
from datum_sandbox.json import JsonValue

T = TypeVar("T")
ROWS: list[dict[str, JsonValue]] = [{"value": "ca", "label": "Canada"}]


class Explicit(DataSourceProvider):
    def exists(self, source_id: str) -> bool:
        return source_id == "countries"

    def items(self, request: DataSourceRequest) -> Sequence[Mapping[str, JsonValue]]:
        return ROWS


class Defaulting(DataSourceProvider):
    """Inherits the default `exists`: it answers yes to every id."""

    def items(self, request: DataSourceRequest) -> Sequence[Mapping[str, JsonValue]]:
        return ROWS


class Sleeper:
    """Takes `seconds` to answer, then says yes; records the thread that ran it."""

    def __init__(self, seconds: float) -> None:
        self.seconds = seconds
        self.threads: list[str] = []
        self.release = threading.Event()

    def exists(self, source_id: str) -> bool:
        return True

    def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        self.threads.append(threading.current_thread().name)
        self.release.wait(self.seconds)
        return ROWS


# ---- W006 -----------------------------------------------------------------------------------------------------------
def test_a_provider_that_keeps_the_default_exists_is_a_w006_warning_naming_it() -> None:
    checks = CompositeDataSourceProvider([Explicit(), Defaulting()]).checks()
    assert [(c.level, c.id) for c in checks] == [(CheckLevel.WARNING, W006)]
    assert "Defaulting" in checks[0].msg
    assert checks[0].hint == "implement exists"


def test_providers_with_their_own_exists_raise_no_check() -> None:
    assert CompositeDataSourceProvider([Explicit()]).checks() == ()
    assert not keeps_default_exists(Explicit())
    assert keeps_default_exists(Defaulting())


def test_a_provider_with_no_exists_at_all_is_taken_for_the_default_and_answers_every_id() -> None:
    class OnlyItems:
        def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
            return ROWS

    assert keeps_default_exists(OnlyItems())
    service = DataSourceService([OnlyItems()])  # type: ignore[list-item]
    assert isinstance(service.items(DataSourceRequest("anything")), Items)


def test_a_default_exists_provider_hides_the_ones_after_it() -> None:
    service = DataSourceService([Defaulting(), Explicit()])
    assert isinstance(service.items(DataSourceRequest("countries")), Items)
    assert service.providers.checks()


# ---- the deadline ----------------------------------------------------------------------------------------------------
def test_a_hung_sync_provider_is_abandoned_at_the_deadline_and_the_source_is_unavailable(
    caplog: pytest.LogCaptureFixture,
) -> None:
    sleeper = Sleeper(30)
    service = DataSourceService([sleeper], timeout=0.2)
    started = time.monotonic()
    with caplog.at_level(logging.WARNING, logger="datum.forms"):
        outcome = service.items(DataSourceRequest("slow"))
    took = time.monotonic() - started
    sleeper.release.set()
    service.close()
    assert isinstance(outcome, DataSourceUnavailable)
    assert took < 3
    assert [r for r in caplog.records if r.name == "datum.forms"]


def test_a_hung_exists_is_unavailable_never_not_found() -> None:
    release = threading.Event()

    class HungExists:
        def exists(self, source_id: str) -> bool:
            release.wait(30)
            return True

        def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
            return ROWS

    service = DataSourceService([HungExists(), Explicit()], timeout=0.2)
    outcome = service.items(DataSourceRequest("countries"))
    release.set()
    service.close()
    assert isinstance(outcome, DataSourceUnavailable)


def test_sync_providers_run_on_the_pool_not_the_calling_thread() -> None:
    sleeper = Sleeper(0)
    service = DataSourceService([sleeper])
    assert isinstance(service.items(DataSourceRequest("x")), Items)
    service.close()
    assert sleeper.threads
    assert all(name.startswith("datum-data-source") for name in sleeper.threads)


def test_one_deadline_bounds_every_call_that_shares_it() -> None:
    sleeper = Sleeper(0.15)
    service = DataSourceService([sleeper], timeout=60)
    shared = Deadline.after(0.25)
    started = time.monotonic()
    outcomes = [service.items(DataSourceRequest(name), deadline=shared) for name in ("a", "b", "c", "d")]
    took = time.monotonic() - started
    service.close()
    assert isinstance(outcomes[0], Items)
    assert isinstance(outcomes[-1], DataSourceUnavailable)
    assert took < 3


def test_a_spent_deadline_asks_no_provider_for_its_items() -> None:
    sleeper = Sleeper(0)
    service = DataSourceService([sleeper])
    spent = Deadline(expires_at=0.0)
    assert isinstance(service.items(DataSourceRequest("x"), deadline=spent), DataSourceUnavailable)
    service.close()
    assert sleeper.threads == []


def test_the_deadline_remaining_never_goes_below_zero() -> None:
    clock = iter([10.0, 11.0, 99.0])
    deadline = Deadline.after(5, clock=lambda: next(clock))
    assert deadline.remaining() == 4.0
    assert deadline.remaining() == 0.0


def test_the_providers_words_are_logged_by_class_and_never_carried(caplog: pytest.LogCaptureFixture) -> None:
    class Leaky:
        def exists(self, source_id: str) -> bool:
            return True

        def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
            raise RuntimeError("password=hunter2")

    service = DataSourceService([Leaky()])
    with caplog.at_level(logging.WARNING, logger="datum.forms"):
        outcome = service.items(DataSourceRequest("db"))
    service.close()
    assert outcome == DataSourceUnavailable()
    assert "hunter2" not in repr(outcome)
    assert any("RuntimeError" in r.getMessage() for r in caplog.records)


@pytest.mark.parametrize("answer", ["text", {"value": "x"}, [1, 2], 5])
def test_an_answer_that_is_not_a_list_of_objects_is_unavailable(answer: Any) -> None:
    class Odd:
        def exists(self, source_id: str) -> bool:
            return True

        def items(self, request: DataSourceRequest) -> Any:
            return answer

    service = DataSourceService([Odd()])
    assert isinstance(service.items(DataSourceRequest("x")), DataSourceUnavailable)
    service.close()


def test_a_provider_that_says_no_for_every_id_is_not_found() -> None:
    service = DataSourceService([Explicit()])
    assert isinstance(service.items(DataSourceRequest("nothing")), DataSourceNotFound)
    service.close()


def test_the_pool_has_at_least_one_thread() -> None:
    with pytest.raises(ValueError, match="at least one"):
        DataSourceService([], max_threads=0)


# ---- async providers through the awaiter ---------------------------------------------------------------------------
class LoopThread:
    """A running event loop on its own thread, and the awaiter that hands it awaitables."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, name="loop", daemon=True)
        self.thread.start()

    def awaiter(self, awaitable: Awaitable[T], /) -> T:
        async def run() -> T:
            return await awaitable

        return asyncio.run_coroutine_threadsafe(run(), self.loop).result(10)

    def stop(self) -> None:
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()


class AsyncCountries:
    async def exists(self, source_id: str) -> bool:
        return source_id == "countries"

    async def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        return ROWS


class AsyncHung:
    async def exists(self, source_id: str) -> bool:
        return True

    async def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        await asyncio.sleep(30)
        return ROWS


def test_an_async_provider_runs_through_the_awaiter() -> None:
    loop = LoopThread()
    try:
        service = DataSourceService([AsyncCountries()], awaiter=loop.awaiter)
        assert service.items(DataSourceRequest("countries")) == Items(ROWS)
        assert isinstance(service.items(DataSourceRequest("other")), DataSourceNotFound)
    finally:
        loop.stop()


def test_an_async_provider_is_bounded_by_the_deadline() -> None:
    loop = LoopThread()
    try:
        service = DataSourceService([AsyncHung()], awaiter=loop.awaiter, timeout=0.2)
        started = time.monotonic()
        assert isinstance(service.items(DataSourceRequest("x")), DataSourceUnavailable)
        assert time.monotonic() - started < 5
    finally:
        loop.stop()


def test_an_async_provider_with_no_awaiter_is_a_configuration_error_not_an_unavailable_source() -> None:
    service = DataSourceService([AsyncCountries()])
    with pytest.raises(DatumConfigurationError, match="awaiter"):
        service.items(DataSourceRequest("countries"))
    service.close()


def test_a_provider_is_given_the_frozen_request_with_form_locale_and_query() -> None:
    seen: list[DataSourceRequest] = []

    class Recording:
        def exists(self, source_id: str) -> bool:
            return source_id == "cities"

        def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
            seen.append(request)
            return ROWS

    asked = DataSourceRequest("cities", "contact@1", "fr", {"q": "ot"})
    assert isinstance(DataSourceService([Recording()]).items(asked), Items)
    assert seen == [asked]
    assert (seen[0].source_id, seen[0].form_key, seen[0].locale, dict(seen[0].query)) == (
        "cities",
        "contact@1",
        "fr",
        {"q": "ot"},
    )
    with pytest.raises(dataclasses.FrozenInstanceError):
        asked.locale = "en"  # type: ignore[misc]


def test_the_request_defaults_name_no_form_the_default_locale_and_an_empty_read_only_query() -> None:
    request = DataSourceRequest("cities")
    assert (request.form_key, request.locale, dict(request.query)) == (None, "en", {})
    with pytest.raises(TypeError):
        request.query["q"] = "x"  # type: ignore[index]
