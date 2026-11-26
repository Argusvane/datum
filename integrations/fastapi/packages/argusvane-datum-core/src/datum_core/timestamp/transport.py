"""`HttpTsaTransport`: the default `TsaTransport`, on the standard library (`http.client` over `ssl`).

One POST, answered with the status, the content type and the (bounded) body. The rules are Datum's own, written here
because no standard class carries them (`urllib.request` follows redirects and has no reply bound, and `httpx` is not a
dependency of `datum_core`):

- no redirect is ever followed: a 3xx is returned as the status it is, and the request is never repeated, so the
  credentials the caller built go to the URL named and to nobody else (`follow_redirects=True` is refused at
  construction);
- the whole call (connect, TLS handshake, send, status line, headers, body) answers to one monotonic deadline, the
  `timeout` the client passes, enforced by a timer that cuts the socket (a per-read timeout can be fed a byte at a
  time): a server that trickles is cut off exactly as a silent one is, and a cut is a `TimeoutError`, never a short
  reply;
- the reply is bounded at `max_reply` octets (1 MiB): a longer announced `Content-Length` is refused before the body
  arrives, a body with no length is cut off at the bound (`ReplyTooLargeError`); only a 200's body is read at all;
- TLS is the default context of the standard library with the certificates `SSL_CERT_FILE` / `SSL_CERT_DIR` name when
  set, and the hostname is always checked; nothing here turns either check off;
- `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` are read from the environment on each call: an https URL goes through a
  CONNECT tunnel that carries no credential of the request (only the proxy's own, from its URL), an http URL is
  tunnelled the same way,
  so the proxy never sees the request or its credentials; only an http proxy URL is supported (an `https://`
  `HTTPS_PROXY` is unsupported and the request is unreachable);
- the user-info of a URL is never sent (the client strips it and builds the `Authorization` header itself).

A transport raises on a network failure; it never returns a redirect as a success. Its exceptions are the
standard library's (`OSError` and its subclasses, `http.client.HTTPException`, `ValueError`) plus
`ReplyTooLargeError`; the client reads none of their words.
"""

import base64
import contextlib
import http.client
import os
import socket
import ssl
import threading
import time
from collections.abc import Mapping
from typing import Final
from urllib.parse import SplitResult, unquote, urlsplit
from urllib.request import getproxies_environment, proxy_bypass

from datum_core.timestamp.protocols import TransportReply
from datum_sandbox.checks import DatumConfigurationError

__all__ = ["MAX_REPLY", "HttpTsaTransport", "ReplyTooLargeError"]

MAX_REPLY: Final = 1024 * 1024
"""The most reply octets read: 1 MiB (a token with a long chain is a few KiB)."""

_CHUNK: Final = 64 * 1024
_OK: Final = 200
_USER_AGENT: Final = "argusvane-datum-core"
_DEFAULT_PORTS: Final = {"http": 80, "https": 443}


class ReplyTooLargeError(Exception):
    """The reply is longer than the bound; raised as soon as that is known, with no part of the body kept."""

    def __init__(self, limit: int = MAX_REPLY) -> None:
        """Keep the bound."""
        super().__init__(limit)
        self.limit = limit

    def __str__(self) -> str:
        """Return the fixed words (no server byte)."""
        return f"the timestamp server's reply is longer than {self.limit} octets"


class HttpTsaTransport:
    """POST once over `http.client`, with no redirect, a bounded reply, one deadline and verified TLS."""

    __slots__ = ("_max_reply",)

    def __init__(self, *, follow_redirects: bool = False, max_reply: int = MAX_REPLY) -> None:
        """Refuse `follow_redirects=True` (a redirect would carry the credentials to another host)."""
        if follow_redirects:
            raise DatumConfigurationError(
                "The timestamp transport follows no redirect: the credentials go only to the URL named.",
                hint="Point the timestamp URL at the final address of the authority.",
            )
        if max_reply < 1:
            raise ValueError("the reply bound is at least one octet")
        self._max_reply = max_reply

    def __repr__(self) -> str:
        """Name the bound; nothing else is held."""
        return f"HttpTsaTransport(max_reply={self._max_reply})"

    @property
    def follow_redirects(self) -> bool:
        """Always False (the client refuses a transport that says otherwise)."""
        return False

    def post(
        self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
    ) -> TransportReply:
        """POST `body` to `url` and return the status, the content type and (for a 200) the bounded body."""
        parts = urlsplit(url)
        if parts.scheme not in _DEFAULT_PORTS or not parts.hostname:
            raise ValueError("the timestamp URL is an http or https URL with a host")
        watchdog = _Watchdog(timeout)
        host_port = f"{parts.hostname}:{parts.port or _DEFAULT_PORTS[parts.scheme]}"
        proxy = self._proxy(parts.scheme, host_port)
        connection = http.client.HTTPConnection(parts.hostname, parts.port or _DEFAULT_PORTS[parts.scheme])
        response: http.client.HTTPResponse | None = None
        try:
            sock = self._open(parts, proxy, watchdog)
            connection.sock = sock
            connection.request(
                "POST",
                self._target(parts),
                body=body,
                headers={
                    "User-Agent": _USER_AGENT,
                    "Content-Type": content_type,
                    "Accept": accept,
                    "Connection": "close",
                    **headers,
                },
            )
            sock.settimeout(watchdog.remaining())
            response = connection.getresponse()
            status = response.status
            media = response.getheader("Content-Type")
            if status != _OK:
                watchdog.check()
                return TransportReply(status, media, b"")
            if response.length is not None and response.length > self._max_reply:
                raise ReplyTooLargeError(self._max_reply)  # noqa: TRY301 - one handler cleans up both paths
            chunks: list[bytes] = []
            total = 0
            while not response.isclosed():  # the response closes itself (and the socket) once it has the last octet
                sock.settimeout(watchdog.remaining())
                chunk = response.read1(_CHUNK)
                if not chunk:
                    break
                total += len(chunk)
                if total > self._max_reply:
                    raise ReplyTooLargeError(self._max_reply)  # noqa: TRY301 - one handler cleans up both paths
                chunks.append(chunk)
            watchdog.check()  # a cut socket reads as the end of a close-delimited body: never a short 200
            return TransportReply(status, media, b"".join(chunks))
        except ReplyTooLargeError:
            raise
        except Exception:
            watchdog.check()
            raise
        finally:
            watchdog.cancel()
            if response is not None:
                response.close()
            connection.close()
            watchdog.close()

    # -- the connection ------------------------------------------------------------------------------------------------

    @staticmethod
    def _open(parts: SplitResult, proxy: str | None, watchdog: "_Watchdog") -> socket.socket:
        """Return the connected socket (tunnelled through `proxy` when there is one, TLS-wrapped for https)."""
        host = parts.hostname or ""
        port = parts.port or _DEFAULT_PORTS[parts.scheme]
        proxy_parts: SplitResult | None = None
        address = (host, port)
        if proxy is not None:
            proxy_parts = urlsplit(proxy if "//" in proxy else f"http://{proxy}")
            if proxy_parts.scheme != "http" or not proxy_parts.hostname:
                raise ValueError("only an http proxy is supported")
            address = (proxy_parts.hostname, proxy_parts.port or _DEFAULT_PORTS["http"])
        raw = socket.create_connection(address, watchdog.remaining())
        watchdog.watch(raw)
        if proxy_parts is not None:
            HttpTsaTransport._tunnel(raw, host, port, HttpTsaTransport._proxy_headers(proxy_parts))
        if parts.scheme != "https":
            return raw
        tls = HttpTsaTransport._tls_context().wrap_socket(raw, server_hostname=host, do_handshake_on_connect=False)
        watchdog.watch(tls)
        tls.settimeout(watchdog.remaining())
        tls.do_handshake()
        return tls

    @staticmethod
    def _tunnel(raw: socket.socket, host: str, port: int, proxy_headers: Mapping[str, str]) -> None:
        """Ask the proxy for a CONNECT tunnel to `host:port` (it carries the proxy's credential only)."""
        authority = f"[{host}]:{port}" if ":" in host else f"{host}:{port}"
        lines = [
            f"CONNECT {authority} HTTP/1.1",
            f"Host: {authority}",
            *(f"{k}: {v}" for k, v in proxy_headers.items()),
        ]
        raw.sendall(("\r\n".join(lines) + "\r\n\r\n").encode("ascii"))
        answer = http.client.HTTPResponse(raw, method="CONNECT")
        try:
            answer.begin()
            if answer.status != _OK:
                raise OSError("the proxy refused the tunnel")
        finally:
            answer.close()

    @staticmethod
    def _proxy(scheme: str, host_port: str) -> str | None:
        """Return the proxy the environment names for `scheme` unless `NO_PROXY` lists the host."""
        proxy = getproxies_environment().get(scheme)
        if not proxy or proxy_bypass(host_port):
            return None
        return proxy

    @staticmethod
    def _proxy_headers(proxy: SplitResult) -> dict[str, str]:
        """Return the proxy's own credential for the CONNECT (from the proxy URL), never one of the request's."""
        if proxy.username is None:
            return {}
        pair = f"{unquote(proxy.username)}:{unquote(proxy.password or '')}".encode()
        return {"Proxy-Authorization": "Basic " + base64.b64encode(pair).decode("ascii")}

    @staticmethod
    def _tls_context() -> ssl.SSLContext:
        """Return the default client context, with the trust file or directory the environment names (if any)."""
        return ssl.create_default_context(
            cafile=os.environ.get("SSL_CERT_FILE") or None, capath=os.environ.get("SSL_CERT_DIR") or None
        )

    @staticmethod
    def _target(parts: SplitResult) -> str:
        """Return the request target: the path and query (origin form; a proxy only ever sees the CONNECT)."""
        path = parts.path or "/"
        return f"{path}?{parts.query}" if parts.query else path


class _Watchdog:
    """One deadline for the whole call, enforced from outside the reads (a per-read timeout can be fed byte by byte).

    A timer cuts every socket it watches when the deadline passes; `check()` then raises `TimeoutError`, so a cut
    never reads as the end of a close-delimited body.
    """

    __slots__ = ("_deadline", "_fired", "_socks", "_timer")

    def __init__(self, timeout: float) -> None:
        self._deadline = time.monotonic() + timeout
        self._fired = threading.Event()
        self._socks: list[socket.socket] = []
        self._timer = threading.Timer(max(timeout, 0.0), self._cut)
        self._timer.daemon = True
        self._timer.start()

    def remaining(self) -> float:
        """Return the seconds left, or raise `TimeoutError`."""
        left = self._deadline - time.monotonic()
        if left <= 0 or self._fired.is_set():
            raise TimeoutError("the timestamp request ran past its deadline")
        return left

    def check(self) -> None:
        """Raise `TimeoutError` when the deadline has cut the call."""
        if self._fired.is_set():
            raise TimeoutError("the timestamp request ran past its deadline")

    def watch(self, sock: socket.socket) -> None:
        """Cut `sock` too when the deadline passes (at once when it already has)."""
        self._socks.append(sock)
        if self._fired.is_set():
            self._shut(sock)

    def cancel(self) -> None:
        """Stop the timer."""
        self._timer.cancel()

    def close(self) -> None:
        """Close every watched socket."""
        for sock in self._socks:
            with contextlib.suppress(OSError):
                sock.close()

    def _cut(self) -> None:
        self._fired.set()
        for sock in tuple(self._socks):
            self._shut(sock)

    @staticmethod
    def _shut(sock: socket.socket) -> None:
        with contextlib.suppress(OSError, ValueError):
            socket.socket.shutdown(sock, socket.SHUT_RDWR)  # the base method: an SSL socket's own would drop its state
