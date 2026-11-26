"""Drive an ASGI application by hand: a request with chosen body events, collecting what the application sends."""

import asyncio
from collections.abc import MutableMapping
from typing import Any

from starlette.types import ASGIApp


async def call(
    app: ASGIApp,
    *,
    method: str = "POST",
    path: str = "/",
    headers: dict[str, str] | None = None,
    events: list[dict[str, Any]] | None = None,
    sent: list[dict[str, Any]] | None = None,
    waiting: asyncio.Event | None = None,
    release: asyncio.Event | None = None,
    client: tuple[str, int] | None = ("testclient", 5000),
    pulled: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Run one request whose receive channel yields `events` in order (then a disconnect); return the sent messages.

    Pass `sent` to keep the messages when the application raises. Pass `waiting` and `release` to hold the client: once
    `events` are used up the driver sets `waiting` (the application has read them and asks for more) and answers the
    disconnect only after `release` is set. `client` is the scope's client (None for a request with no address);
    `pulled` keeps every message the application took from the receive channel."""
    queue = list(events or [{"type": "http.request", "body": b"", "more_body": False}])
    sent = [] if sent is None else sent
    scope: dict[str, Any] = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.4"},
        "http_version": "1.1",
        "method": method,
        "scheme": "http",
        "path": path,
        "raw_path": path.encode(),
        "root_path": "",
        "query_string": b"",
        "headers": [(name.lower().encode(), value.encode()) for name, value in (headers or {}).items()],
        "client": client,
        "server": ("testserver", 80),
    }

    async def receive() -> dict[str, Any]:
        if queue:
            message = queue.pop(0)
            if pulled is not None:
                pulled.append(message)
            return message
        if waiting is not None:
            waiting.set()
        if release is not None:
            await release.wait()
        return {"type": "http.disconnect"}

    async def send(message: MutableMapping[str, Any]) -> None:
        sent.append(dict(message))

    await app(scope, receive, send)
    return sent


def status_of(sent: list[dict[str, Any]]) -> int | None:
    """The status of the response the application started, or None when it sent none."""
    starts = [m for m in sent if m["type"] == "http.response.start"]
    return int(starts[0]["status"]) if starts else None


def body_of(sent: list[dict[str, Any]]) -> bytes:
    """The body bytes the application sent."""
    return b"".join(m.get("body", b"") for m in sent if m["type"] == "http.response.body")
