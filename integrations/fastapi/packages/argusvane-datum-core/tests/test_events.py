"""The event dispatcher: guarded delivery, list order, subclass match, forwarding, awaiter rules."""

# ruff: noqa: PT018

import asyncio
import logging
import threading
from collections.abc import Awaitable
from dataclasses import FrozenInstanceError, dataclass

import pytest

from datum_core.events import DatumEvent, EventDispatcher, listener
from datum_core.loggers import EVENTS
from datum_sandbox.checks import DatumConfigurationError


@dataclass(frozen=True, slots=True)
class Base(DatumEvent):
    n: int = 0


@dataclass(frozen=True, slots=True)
class Child(Base):
    pass


@dataclass(frozen=True, slots=True)
class Other(DatumEvent):
    pass


def run_awaiter[T](awaitable: Awaitable[T]) -> T:
    async def wrap() -> T:
        return await awaitable

    return asyncio.run(wrap())


def test_events_are_frozen_and_slotted() -> None:
    event = Base(1)
    with pytest.raises(FrozenInstanceError):
        event.n = 2  # type: ignore[misc]
    assert not hasattr(event, "__dict__")


def test_delivery_is_in_list_order_across_types() -> None:
    seen: list[str] = []
    dispatcher = EventDispatcher(
        [
            listener(Base, lambda e: seen.append("first")),
            listener(DatumEvent, lambda e: seen.append("second")),
            listener(Child, lambda e: seen.append("third")),
            listener(Base, lambda e: seen.append("fourth")),
        ]
    )
    dispatcher.publish(Child())
    assert seen == ["first", "second", "third", "fourth"]


def test_a_listener_on_a_base_class_sees_subclasses_but_not_siblings() -> None:
    seen: list[DatumEvent] = []
    dispatcher = EventDispatcher([listener(Base, seen.append)])
    dispatcher.publish(Child(2))
    dispatcher.publish(Base(1))
    dispatcher.publish(Other())
    assert seen == [Child(2), Base(1)]


def test_a_forwarding_listener_sees_every_event() -> None:
    bus: list[DatumEvent] = []
    dispatcher = EventDispatcher([(DatumEvent, bus.append)])
    events = [Base(), Child(), Other()]
    for event in events:
        dispatcher.publish(event)
    assert bus == events


@pytest.mark.parametrize("error", [RuntimeError("x"), AssertionError("a"), RecursionError("r"), ValueError("v")])
def test_a_raising_listener_is_logged_and_never_breaks_the_caller(
    error: Exception, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[str] = []

    def bad(event: Base) -> None:
        raise error

    dispatcher = EventDispatcher(
        [
            listener(Base, lambda e: seen.append("before")),
            listener(Base, bad),
            listener(Base, lambda e: seen.append("after")),
        ]
    )
    with caplog.at_level(logging.ERROR, logger=EVENTS):
        dispatcher.publish(Base())
    assert seen == ["before", "after"]
    (record,) = [r for r in caplog.records if r.name == EVENTS]
    assert record.levelno == logging.ERROR
    assert record.exc_info is not None and record.exc_info[1] is error
    assert getattr(record, "datum_event", None) == "Base"


@pytest.mark.parametrize("error", [MemoryError(), SystemExit(2), KeyboardInterrupt(), asyncio.CancelledError()])
def test_memory_errors_exits_and_cancellation_propagate(error: BaseException) -> None:
    seen: list[str] = []

    def bad(event: Base) -> None:
        raise error

    dispatcher = EventDispatcher([listener(Base, bad), listener(Base, lambda e: seen.append("after"))])
    with pytest.raises(type(error)):
        dispatcher.publish(Base())
    assert seen == []


def test_async_listeners_go_through_the_awaiter_and_sync_run_inline() -> None:
    seen: list[tuple[str, bool]] = []
    caller = threading.current_thread()

    async def a(event: Base) -> None:
        seen.append(("async", True))

    def s(event: Base) -> None:
        seen.append(("sync", threading.current_thread() is caller))

    dispatcher = EventDispatcher([listener(Base, a), listener(Base, s)], awaiter=run_awaiter)
    dispatcher.publish(Base())
    assert seen == [("async", True), ("sync", True)]


def test_async_listener_with_no_awaiter_is_a_configuration_error_at_validate_and_logged_at_publish(
    caplog: pytest.LogCaptureFixture,
) -> None:
    async def a(event: Base) -> None:
        raise AssertionError("must never run")

    dispatcher = EventDispatcher([listener(Base, a)])
    with pytest.raises(DatumConfigurationError, match="awaiter"):
        dispatcher.validate()
    with caplog.at_level(logging.ERROR, logger=EVENTS):
        dispatcher.publish(Base())  # guarded: logged, the caller is not broken
    assert len(caplog.records) == 1
    dispatcher.bind(run_awaiter)
    dispatcher.validate()


def test_registration_refuses_a_non_event_type() -> None:
    with pytest.raises(TypeError):
        EventDispatcher([(int, print)])  # type: ignore[list-item]


def test_registration_refuses_a_listener_that_is_not_callable() -> None:
    with pytest.raises(TypeError, match="not callable"):
        EventDispatcher([(Base, 42)])  # type: ignore[list-item]


def test_listeners_property_keeps_order() -> None:
    first, second = listener(Base, print), listener(Other, print)
    assert EventDispatcher([first, second]).listeners == (first, second)
