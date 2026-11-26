"""Data sources: providers asked in order, one shared deadline, sync providers on a pool.

The first provider whose `exists(id)` answers true serves `items(id)`. A provider that fails, or the deadline, makes the
source unavailable; the provider's own words go to the log, never into an outcome. Sync providers run on a pool of
`datum.forms.data_sources.max_threads` threads so a hung one is abandoned at the deadline; an `async` provider runs
through the awaiter on the calling thread, bounded by the same deadline (asyncio loops; the awaiter is the binding's).

The option snapshot of a validation (`snapshot`) asks every data-sourced choice's source together under ONE deadline,
`datum.forms.data_sources.timeout`, for the whole snapshot: with no awaiter the sources run side by side on the pool;
with one, the whole snapshot crosses it once (one coroutine gathering every source, async methods awaited on the loop
and sync ones sent to the same pool), never once per provider call.

Built on: `concurrent.futures.ThreadPoolExecutor` is the pool and the bounded wait (a hung call cannot be
killed, only abandoned: documented); `asyncio.timeout` bounds an awaitable and `asyncio.TaskGroup` gathers the
snapshot's sources (a failing one cancels the rest); `anyio.fail_after` is out of bounds here (anyio lives in
`datum_core.aio`); the stdlib has no deadline value that is shared across calls, hence `Deadline` (a monotonic expiry,
ten lines).
"""

import asyncio
import inspect
import logging
import threading
import time
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from concurrent.futures import Future, ThreadPoolExecutor, wait
from concurrent.futures import TimeoutError as FutureTimeout
from dataclasses import dataclass
from typing import TYPE_CHECKING, Final, cast

from datum_core.checks import W006
from datum_core.forms.outcomes import DataSourceNotFound, DataSourceOutcome, DataSourceUnavailable, Items
from datum_core.forms.protocols import DataSourceProvider, DataSourceRequest
from datum_core.hooks import Awaiter, MaybeAwaitable, is_async_callable, resolve
from datum_core.loggers import FORMS
from datum_sandbox.checks import CheckLevel, DatumCheck, DatumConfigurationError
from datum_sandbox.json import JsonValue

if TYPE_CHECKING:
    from asyncio import AbstractEventLoop

__all__ = ["CompositeDataSourceProvider", "DataSourceService", "Deadline", "OptionSnapshot"]

logger = logging.getLogger(FORMS)

_LOGGED_ID: Final = 64

type OptionSnapshot = dict[str, list[dict[str, JsonValue]]]
"""The items of every source a snapshot found, by source id; a source no provider serves is left out."""


@dataclass(frozen=True, slots=True)
class Deadline:
    """A point on the monotonic clock; one value bounds every call that shares it."""

    expires_at: float
    clock: Callable[[], float] = time.monotonic

    @classmethod
    def after(cls, seconds: float, *, clock: Callable[[], float] = time.monotonic) -> "Deadline":
        """Return a deadline `seconds` from now."""
        return cls(clock() + seconds, clock)

    def remaining(self) -> float:
        """Seconds left, never below zero."""
        return max(self.expires_at - self.clock(), 0.0)


class _Expired(Exception):  # noqa: N818 - control flow inside this module only
    """The deadline ran out before a provider answered."""


class CompositeDataSourceProvider:
    """The providers in the order they are asked, and the `datum.W006` check for default `exists` ones."""

    def __init__(self, providers: Sequence[DataSourceProvider]) -> None:
        """Keep the providers in list order."""
        self.providers = tuple(providers)

    def __iter__(self) -> Iterator[DataSourceProvider]:
        """Iterate the providers in order."""
        return iter(self.providers)

    def __len__(self) -> int:
        """How many providers there are."""
        return len(self.providers)

    def checks(self) -> tuple[DatumCheck, ...]:
        """One `datum.W006` per provider that keeps the default `exists` (it answers for every id)."""
        return tuple(
            DatumCheck(
                CheckLevel.WARNING,
                W006,
                f"the data-source provider {type(provider).__qualname__} keeps the default exists, so it answers for"
                " every id and hides the providers after it",
                "implement exists",
            )
            for provider in self.providers
            if keeps_default_exists(provider)
        )


def keeps_default_exists(provider: object) -> bool:
    """Say whether the provider's class has no `exists` of its own (it inherits the default, or has none)."""
    return getattr(type(provider), "exists", None) in (None, DataSourceProvider.exists)


async def _within(awaitable: Awaitable[object], seconds: float) -> object:
    async with asyncio.timeout(seconds):
        return await awaitable


class DataSourceService:
    """Answer a data source's items under one deadline."""

    def __init__(
        self,
        providers: Sequence[DataSourceProvider] = (),
        *,
        timeout: float = 15.0,
        max_threads: int = 16,
        awaiter: Awaiter | None = None,
    ) -> None:
        """Keep the providers; `timeout` (seconds) is `datum.forms.data_sources.timeout`, `max_threads` the pool's."""
        if max_threads < 1:
            raise ValueError("the data-source pool has at least one thread")
        self.providers = CompositeDataSourceProvider(providers)
        self.timeout = timeout
        self._max_threads = max_threads
        self._awaiter = awaiter
        self._pool: ThreadPoolExecutor | None = None
        self._lock = threading.Lock()

    def items(self, request: DataSourceRequest, *, deadline: Deadline | None = None) -> DataSourceOutcome:
        """Ask the providers in order; `deadline` is shared across calls (default: this call's own `timeout`)."""
        source_id = request.source_id
        bound = deadline or Deadline.after(self.timeout)
        try:
            for provider in self.providers:
                if self._call(provider, "exists", source_id, bound):
                    return self._items(provider, request, bound)
        except _Expired:
            logger.warning("Data source %s ran past its deadline.", _shown(source_id))
            return DataSourceUnavailable()
        except DatumConfigurationError:
            raise
        except Exception as error:
            logger.warning("Data source %s failed (%s).", _shown(source_id), type(error).__name__, exc_info=True)
            return DataSourceUnavailable()
        return DataSourceNotFound()

    def snapshot(
        self, source_ids: Sequence[str], *, form_key: str | None, locale: str
    ) -> OptionSnapshot | DataSourceUnavailable:
        """Ask every source of a validation's option snapshot under ONE deadline (this service's `timeout`).

        A source no provider serves is left out (the program then refuses an answer that picks from it); a provider
        that fails, an answer that is no list of objects, or the deadline makes the whole snapshot unavailable. An
        async provider with no awaiter raises `DatumConfigurationError`.
        """
        asked = [DataSourceRequest(source_id, form_key, locale) for source_id in dict.fromkeys(source_ids)]
        if not asked:
            return {}
        deadline = Deadline.after(self.timeout)
        try:
            found = self._gathered(asked, deadline) if self._awaiter is not None else self._pooled(asked, deadline)
        except _Expired:
            logger.warning("The option snapshot of %d sources ran past its deadline.", len(asked))
            return DataSourceUnavailable()
        except DatumConfigurationError:
            raise
        except Exception as error:
            configuration = _configuration_error(error)
            if configuration is not None:
                raise configuration from None
            logger.warning("The option snapshot failed (%s).", type(error).__name__)
            return DataSourceUnavailable()
        snapshot: OptionSnapshot = {}
        for ask, outcome in zip(asked, found, strict=True):
            match outcome:
                case Items(rows):
                    snapshot[ask.source_id] = rows
                case DataSourceNotFound():
                    continue
                case DataSourceUnavailable():
                    return outcome
        return snapshot

    def _pooled(self, asked: Sequence[DataSourceRequest], deadline: Deadline) -> list[DataSourceOutcome]:
        """Every source's provider chain on the pool, side by side, waited for until the deadline."""
        futures = [self._submit(self._chain, ask) for ask in asked]
        _, pending = wait(futures, timeout=deadline.remaining())
        if pending:
            for future in pending:
                future.cancel()
            raise _Expired
        return [cast("DataSourceOutcome", future.result()) for future in futures]

    def _chain(self, ask: object) -> DataSourceOutcome:
        """One source's providers in order, on a pool thread (no awaiter: an awaitable is a configuration error)."""
        source = cast("DataSourceRequest", ask)
        for provider in self.providers:
            if _sync_call(provider, "exists", source.source_id):
                return _rows(_sync_call(provider, "items", source), source.source_id)
        return DataSourceNotFound()

    def _gathered(self, asked: Sequence[DataSourceRequest], deadline: Deadline) -> list[DataSourceOutcome]:
        """Run the whole snapshot as one coroutine through the awaiter: one hop, one `asyncio.timeout`."""

        async def gather() -> list[DataSourceOutcome]:
            loop = asyncio.get_running_loop()
            async with asyncio.timeout(deadline.remaining()), asyncio.TaskGroup() as group:
                tasks = [group.create_task(self._chain_on(loop, ask)) for ask in asked]
            return [task.result() for task in tasks]

        try:
            return resolve(gather(), self._awaiter, what="the option snapshot")
        except TimeoutError:
            raise _Expired from None

    async def _chain_on(self, loop: "AbstractEventLoop", ask: DataSourceRequest) -> DataSourceOutcome:
        for provider in self.providers:
            if await self._ask_on(loop, provider, "exists", ask.source_id):
                return _rows(await self._ask_on(loop, provider, "items", ask), ask.source_id)
        return DataSourceNotFound()

    async def _ask_on(
        self, loop: "AbstractEventLoop", provider: DataSourceProvider, name: str, argument: object
    ) -> object:
        method = cast("Callable[[object], object] | None", getattr(provider, name, None))
        if method is None:  # no exists at all: the default
            return True
        if is_async_callable(method):
            return await cast("Awaitable[object]", method(argument))
        answer = await loop.run_in_executor(self._executor(), method, argument)
        if inspect.isawaitable(answer):
            return await answer
        return answer

    def _executor(self) -> ThreadPoolExecutor:
        with self._lock:
            if self._pool is None:
                self._pool = ThreadPoolExecutor(max_workers=self._max_threads, thread_name_prefix="datum-data-source")
            return self._pool

    def close(self) -> None:
        """Stop the pool; a provider call still running is abandoned."""
        with self._lock:
            pool, self._pool = self._pool, None
        if pool is not None:
            pool.shutdown(wait=False, cancel_futures=True)

    # -- one provider call ------------------------------------------------------------------------------------------
    def _items(self, provider: DataSourceProvider, request: DataSourceRequest, deadline: Deadline) -> DataSourceOutcome:
        return _rows(self._call(provider, "items", request, deadline), request.source_id)

    def _call(self, provider: DataSourceProvider, name: str, argument: object, deadline: Deadline) -> object:
        method = cast("Callable[[object], object] | None", getattr(provider, name, None))
        if method is None:  # no exists at all: the default
            return True
        if is_async_callable(method):
            return self._await(method(argument), deadline)
        future = self._submit(method, argument)
        try:
            result = future.result(timeout=deadline.remaining())
        except FutureTimeout:
            future.cancel()
            raise _Expired from None
        return self._await(result, deadline) if asyncio.iscoroutine(result) or hasattr(result, "__await__") else result

    def _await(self, value: object, deadline: Deadline) -> object:
        if not hasattr(value, "__await__"):
            return value
        remaining = deadline.remaining()
        if remaining <= 0:
            close = getattr(value, "close", None)
            if callable(close):
                close()
            raise _Expired
        awaitable = cast("Awaitable[object]", value)
        bounded: Awaitable[object] = _within(awaitable, remaining) if self._awaiter is not None else awaitable
        try:
            return resolve(cast("MaybeAwaitable[object]", bounded), self._awaiter, what="a data-source provider")
        except TimeoutError:
            raise _Expired from None

    def _submit(self, method: Callable[[object], object], argument: object) -> Future[object]:
        return self._executor().submit(method, argument)


def _rows(found: object, source_id: str) -> DataSourceOutcome:
    """Hold a provider's answer to a list of objects (copied), else the source is unavailable."""
    if isinstance(found, str | bytes | Mapping) or not isinstance(found, Sequence):
        logger.warning("Data source %s answered something other than a list of items.", _shown(source_id))
        return DataSourceUnavailable()
    rows = cast("Sequence[object]", found)
    if not all(isinstance(row, Mapping) for row in rows):
        logger.warning("Data source %s answered an item that is not an object.", _shown(source_id))
        return DataSourceUnavailable()
    return Items([dict(cast("Mapping[str, JsonValue]", row)) for row in rows])


def _sync_call(provider: DataSourceProvider, name: str, argument: object) -> object:
    """Call a provider method on this thread; with no awaiter an awaitable answer is refused (and closed)."""
    method = cast("Callable[[object], object] | None", getattr(provider, name, None))
    if method is None:  # no exists at all: the default
        return True
    if is_async_callable(method):
        raise DatumConfigurationError(
            f"the data-source provider {type(provider).__qualname__} is asynchronous but no awaiter was supplied",
            hint="use the binding that supplies one, or make the provider's methods plain functions",
        )
    return resolve(method(argument), None, what="a data-source provider")


def _configuration_error(error: BaseException) -> DatumConfigurationError | None:
    """Return the configuration error a task group wrapped, if any (raised as it is, never read as unavailable)."""
    if isinstance(error, DatumConfigurationError):
        return error
    if isinstance(error, BaseExceptionGroup):
        for inner in cast("BaseExceptionGroup[BaseException]", error).exceptions:
            found = _configuration_error(inner)
            if found is not None:
                return found
    return None


def _shown(source_id: str) -> str:
    """Show a request-supplied id in a log: quoted and cut, so no input travels whole."""
    return repr(source_id[:_LOGGED_ID])
