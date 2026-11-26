"""The anyio awaiter: resolve a hook's or store's awaitable from a worker thread on the application's event loop."""

from collections.abc import Awaitable

import anyio.from_thread


async def _awaited[T](awaitable: Awaitable[T]) -> T:
    return await awaitable


def anyio_awaiter[T](awaitable: Awaitable[T], /) -> T:
    """Run `awaitable` on the event loop that owns this anyio worker thread and return its result (an `Awaiter`).

    It is `anyio.from_thread.run`, adapted to take an awaitable: a pool owned by the application's loop stays on that
    loop (never `asyncio.run`, whose private loop would break it). Called on the event loop's own thread, or on a thread
    anyio did not start, it raises `RuntimeError` (anyio's `NoEventLoopError`) before the awaitable is touched, instead
    of deadlocking; the caller still owns the awaitable then.
    """
    return anyio.from_thread.run(_awaited, awaitable)
