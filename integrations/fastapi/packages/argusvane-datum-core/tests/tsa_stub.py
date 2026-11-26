"""A stub HTTP server on a thread (no mocking library): records every request, answers what the test scripted.

`StubServer` is the third party the timestamp client talks to: it keeps each request's method, target, every header as
received (name and value, in order) and body, and answers with the `Reply` its `behavior` returns. It can answer slowly
(`delay`), a byte at a time (`trickle`), with a wrong `Content-Length`, or hang up. `honest` is a behavior that answers
with a real token from the authority under test, so a hostile test changes one thing about an otherwise good reply.
The server is closed (socket and thread) by the context manager, so no ResourceWarning reaches `filterwarnings = error`.
"""

import contextlib
import http.server
import socket
import ssl
import threading
from collections.abc import Callable, Generator
from dataclasses import dataclass, field


@dataclass
class Seen:
    """One request as the server received it."""

    method: str
    target: str
    headers: list[tuple[str, str]]
    body: bytes

    def header(self, name: str) -> str | None:
        """Return the first value of header `name` (case-insensitive), or None."""
        for key, value in self.headers:
            if key.lower() == name.lower():
                return value
        return None

    @property
    def names(self) -> set[str]:
        """The lower-cased header names received."""
        return {key.lower() for key, _ in self.headers}


@dataclass
class Reply:
    """What to answer: a status, headers, a body and how to deliver it."""

    status: int = 200
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes = b""
    delay: float = 0.0
    """Seconds to wait before the status line."""
    trickle: float | None = None
    """Seconds between single body bytes (the Content-Length is the full body)."""
    content_length: int | None = None
    """Announce this Content-Length instead of the body's."""
    hang_up: bool = False
    """Close the connection without a reply."""
    stream: int | None = None
    """Send no Content-Length: write this many bytes (64 KiB at a time, counted in `written`) and close."""


type Behavior = Callable[[Seen], Reply]


class _Handler(http.server.BaseHTTPRequestHandler):
    server: "_Server"  # pyright: ignore[reportIncompatibleVariableOverride]
    protocol_version = "HTTP/1.1"
    timeout = 5  # a client that stops reading cannot hold the server (and the test) for longer than this

    def log_message(self, format: str, *args: object) -> None:  # noqa: A002 - the base signature
        return

    def _serve(self) -> None:
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        seen = Seen(self.command, self.path, list(self.headers.items()), body)
        with self.server.lock:
            self.server.requests.append(seen)
        reply = self.server.behavior(seen)
        if reply.hang_up:
            self.close_connection = True
            return
        if reply.delay:
            self.server.stopping.wait(reply.delay)
        self.send_response(reply.status)
        if reply.stream is not None:
            for key, value in reply.headers.items():
                self.send_header(key, value)
            self.send_header("Connection", "close")
            self.end_headers()
            self.close_connection = True
            chunk = b"\x30" * 65536
            try:
                while self.server.written < reply.stream:
                    self.wfile.write(chunk)
                    self.wfile.flush()
                    self.server.written += len(chunk)
            except OSError:  # the client hung up once it had read enough
                return
            return
        announced = len(reply.body) if reply.content_length is None else reply.content_length
        for key, value in reply.headers.items():
            self.send_header(key, value)
        self.send_header("Content-Length", str(announced))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            if reply.trickle is None:
                self.wfile.write(reply.body)
            else:
                for index in range(len(reply.body)):
                    self.wfile.write(reply.body[index : index + 1])
                    self.wfile.flush()
                    if self.server.stopping.wait(reply.trickle):
                        return
        except OSError:  # a client that hangs up, resets or stops reading is part of the test, not an error
            return

    do_POST = do_GET = do_PUT = do_CONNECT = _serve  # noqa: N815 - the handler's verb names


class _Server(http.server.ThreadingHTTPServer):
    daemon_threads = False  # handler threads are joined by `server_close`, so none outlives its test

    def __init__(self, behavior: Behavior, context: ssl.SSLContext | None) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.behavior = behavior
        self.requests: list[Seen] = []
        self.lock = threading.Lock()
        self.stopping = threading.Event()
        self.written = 0
        self._context = context
        if context is not None:
            self.socket = context.wrap_socket(self.socket, server_side=True)

    def handle_error(self, request: object, client_address: object) -> None:
        return  # a client that hangs up mid-reply is part of the test, not an error


class StubServer:
    """The server and its thread; use as a context manager."""

    def __init__(self, behavior: Behavior, *, tls: ssl.SSLContext | None = None) -> None:
        self._server = _Server(behavior, tls)
        self._thread = threading.Thread(target=self._server.serve_forever, kwargs={"poll_interval": 0.02}, daemon=True)
        self._tls = tls is not None

    @property
    def port(self) -> int:
        """The port the server listens on (127.0.0.1)."""
        return int(self._server.server_address[1])

    @property
    def url(self) -> str:
        """The base URL (``http`` or ``https``) of the server."""
        return f"{'https' if self._tls else 'http'}://127.0.0.1:{self.port}"

    @property
    def requests(self) -> list[Seen]:
        """The requests received so far."""
        with self._server.lock:
            return list(self._server.requests)

    @property
    def written(self) -> int:
        """The bytes a `stream` reply has written so far."""
        return self._server.written

    @property
    def behavior(self) -> Behavior:
        return self._server.behavior

    @behavior.setter
    def behavior(self, value: Behavior) -> None:
        self._server.behavior = value

    def __enter__(self) -> "StubServer":
        self._thread.start()
        return self

    def __exit__(self, *exc_info: object) -> None:
        self._server.stopping.set()
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(10)


@contextlib.contextmanager
def serving(behavior: Behavior, *, tls: ssl.SSLContext | None = None) -> Generator[StubServer]:
    """Run a stub server for the block."""
    with StubServer(behavior, tls=tls) as server:
        yield server


def free_port() -> int:
    """Return a TCP port nothing listens on (just released)."""
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])
