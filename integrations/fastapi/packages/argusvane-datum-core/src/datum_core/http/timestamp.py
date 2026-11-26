"""`POST /tsa` and its certificate routes, framework-free.

`TimestampGate.admit` is the admission ORDER and each step is a test; a refusal before the service is plain text, never
the JSON `bad_document` of `admission`:

1. a session cookie: 403 (`datum.tsa.session_cookies`: `"*"` refuses any `Cookie` header, a list the cookies it names);
2. the media type: 415 unless `application/timestamp-query` or `application/timestamp-request`;
3. the client key (`access="clients"`): no key, an unknown key or a revoked one is the same 401 with `WWW-Authenticate`;
   a wrong key PRESENTED counts toward `datum.tsa.flood.failed_keys` per address, and the attempt past it is 429 for
   what remains of the window (a request that presents no key counts for nothing; a right key is never locked out);
4. the flood rule: 429 with `Retry-After`, counted per client (per address under open access), admitted requests only;
   an address is counted as `datum_core.throttle.counted_address` gives it (an IPv6 client by its /64);
5. the size: 413 from `Content-Length` here, and from `refuse_too_large` for a body the binding counts chunk by chunk.

Then the service answers: a granted token is `granted_answer`, a rejection `refusal_answer` (a DER `TimeStampResp`,
400, or 503 with `Retry-After`). Every answer carries `Cache-Control: no-store` and none an `ETag`. A refusal's text
echoes no request byte, no header, no cookie and no key; the 401 text is one constant whatever was wrong.

Built on: the standard library supplies the pieces (`hashlib` for the key hash, `base64` for a Basic
credential, `ssl.DER_cert_to_PEM_cert` for PEM, `math` through the flood store's `retry_after`); no standard parser
reads an `Authorization` or `Cookie` header leniently enough to name a malformed cookie, and `http.cookies` drops what
it cannot parse. `starlette` is forbidden here. So the module is the decisions (what counts, in what order) over those
pieces, plus the memory flood counter and the client store the application hands in.
"""

import base64
import binascii
import hashlib
import logging
import re
import ssl
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from http import HTTPStatus
from typing import TYPE_CHECKING, Final

from datum_core.config.models import Tsa, TsaAccess
from datum_core.http._headers import header
from datum_core.http.admission import Refused
from datum_core.http.answer import HttpAnswer
from datum_core.loggers import TSA
from datum_core.stores.memory import InMemoryTsaFlood
from datum_core.stores.tsa import TsaClientStore
from datum_core.throttle import counted_address
from datum_core.timestamp.protocols import TimestampFailure, TimestampGrant, TimestampRefusedError

if TYPE_CHECKING:
    from datum_core.timestamp.authority import TimestampAnswer
    from datum_core.timestamp.refusal import TimestampRefusal

__all__ = [
    "BASIC_CHALLENGE",
    "CERTIFICATE_DER_MEDIA_TYPE",
    "DEFAULT_RETRY_AFTER",
    "MAX_RETRY_AFTER",
    "PEM_MEDIA_TYPE",
    "QUERY_MEDIA_TYPES",
    "REPLY_MEDIA_TYPE",
    "Admitted",
    "TimestampGate",
    "answer_for",
    "certificate_answer",
    "certificates_answer",
    "granted_answer",
    "refusal_answer",
]

logger = logging.getLogger(TSA)

QUERY_MEDIA_TYPES: Final = ("application/timestamp-query", "application/timestamp-request")
"""The request media types: RFC 3161's name and the one older clients send."""
REPLY_MEDIA_TYPE: Final = "application/timestamp-reply"
PEM_MEDIA_TYPE: Final = "application/x-pem-file"
CERTIFICATE_DER_MEDIA_TYPE: Final = "application/pkix-cert"
BASIC_CHALLENGE: Final = 'Bearer realm="timestamp server", Basic realm="timestamp server"'
"""The `WWW-Authenticate` value of the 401 (RFC 9110 allows several challenges in one field)."""
MAX_RETRY_AFTER: Final = 3600
DEFAULT_RETRY_AFTER: Final = 5
"""The `Retry-After` of a 503 the gate itself answers when the client store fails (the binding passes its own)."""

_NO_STORE: Final = "no-store"
_TEXT: Final = "text/plain; charset=utf-8"
_MAX_KEY_LENGTH: Final = 1024
"""A presented key longer than this is a wrong key without hashing (a key is 48 characters)."""
_DIGITS: Final = re.compile(r"[0-9]+", re.ASCII)
_ANY_COOKIE: Final = "*"
_FAILED_PREFIX: Final = "fail:"
_ADDRESS_PREFIX: Final = "addr:"
_CLIENT_PREFIX: Final = "client:"
_NO_ADDRESS: Final = "-"

_COOKIE_TEXT: Final = "A timestamp request must not carry a cookie."
_MEDIA_TEXT: Final = "The Content-Type must be application/timestamp-query."
_KEY_TEXT: Final = "A valid client key is required."
_LOCKED_TEXT: Final = "Too many wrong client keys from this address; try again later."
_FLOOD_TEXT: Final = "Too many timestamp requests; try again later."
_SIZE_TEXT: Final = "The request is larger than the limit."


def _text_answer(status: int, text: str, headers: Mapping[str, str] | None = None) -> HttpAnswer:
    return HttpAnswer(
        status,
        {"Content-Type": _TEXT, "Cache-Control": _NO_STORE, **(headers or {})},
        text.encode("ascii"),
    )


def _retry_after(seconds: int) -> str:
    """Return the `Retry-After` value: the window's remaining whole seconds, at least 1 and at most an hour."""
    return str(min(max(1, seconds), MAX_RETRY_AFTER))


@dataclass(frozen=True, slots=True)
class Admitted:
    """The request passed admission; `client` is the store id of the client whose key it presented (None: open)."""

    client: str | None = None


class TimestampGate:
    """The admission of `POST /tsa`: the five steps above, over the client store and this start's flood counters."""

    def __init__(
        self,
        tsa: Tsa,
        *,
        clients: TsaClientStore,
        flood: InMemoryTsaFlood,
        clock: Callable[[], float],
        now: Callable[[], datetime],
    ) -> None:
        """Judge requests by `tsa`'s settings; `clock` is a steady clock in seconds, `now` the wall clock."""
        self._tsa = tsa
        self._clients = clients
        self._flood = flood
        self._clock = clock
        self._now = now
        self._window = tsa.flood.window.total_seconds()
        self._max_size = int(tsa.max_request_size)
        self._by_clients = tsa.access == TsaAccess.CLIENTS
        self._cookie_names = frozenset(name.casefold() for name in tsa.session_cookies)

    def admit(
        self,
        headers: Mapping[str, str],
        *,
        remote_address: str | None,
        retry_after: int = DEFAULT_RETRY_AFTER,
    ) -> Admitted | Refused:
        """Run the admission order over the request's headers; the first step that refuses answers."""
        if self._carries_session_cookie(headers):
            return Refused(_text_answer(403, _COOKIE_TEXT))
        if _media_type(header(headers, "Content-Type")) not in QUERY_MEDIA_TYPES:
            return Refused(_text_answer(415, _MEDIA_TEXT))
        address = counted_address(remote_address) or _NO_ADDRESS
        try:
            client = None
            if self._by_clients:
                verdict = self._authenticate(headers, address)
                if isinstance(verdict, Refused):
                    return verdict
                client = verdict
            flooded = self._flooded(client, address)
        except Exception:
            logger.exception("The timestamp server's client store or flood counter failed; the request got a 503.")
            return Refused(_system_failure(retry_after))
        if flooded is not None:
            return Refused(flooded)
        return self._sized(headers, client, retry_after)

    def refuse_too_large(self) -> Refused:
        """Return the 413 for a body the binding counted past `datum.tsa.max_request_size`."""
        return Refused(_text_answer(413, _SIZE_TEXT))

    # -- step 1 --
    def _carries_session_cookie(self, headers: Mapping[str, str]) -> bool:
        # Several Cookie field lines (HTTP/2 splits the header) are joined with "; " (RFC 9113 section 8.2.3), not
        # with the comma a list header takes, so every line's names are read.
        getlist = getattr(headers, "getlist", None)
        if callable(getlist):
            lines = list(getlist("Cookie"))
        else:
            lines = [value for key, value in headers.items() if key.casefold() == "cookie"]
        if not lines or not self._cookie_names:
            return False
        if _ANY_COOKIE in self._cookie_names:
            return True
        cookies = "; ".join(lines)
        return any(pair.partition("=")[0].strip().casefold() in self._cookie_names for pair in cookies.split(";"))

    # -- step 3 --
    def _authenticate(self, headers: Mapping[str, str], address: str) -> str | Refused:
        """Return the client's store id, or the 401 (or the lockout's 429).

        The store is asked for the SHA-256 hash of the key and nothing else, never the key text, so the lookup's
        timing says nothing of how close a wrong key is to a right one. A request with no address shares the one
        `-` bucket with every other addressless request, for `failed_keys` and for the flood rule alike.
        """
        key = _presented_key(header(headers, "Authorization"))
        if key is None:
            return Refused(_challenge())
        record = None
        if key.isascii() and len(key) <= _MAX_KEY_LENGTH:
            record = self._clients.find(hashlib.sha256(key.encode("ascii")).hexdigest())
        if record is None or record.revoked:
            return Refused(self._failed_key(address))
        try:
            self._clients.record_use(record.id, self._now())
        except Exception:
            logger.exception("The timestamp server could not note the use of a client; the request goes on.")
        return record.id

    def _failed_key(self, address: str) -> HttpAnswer:
        """Count one wrong key against `address`: the 401, or the 429 once it is past `failed_keys`."""
        tolerated = self._tsa.flood.failed_keys
        if tolerated == 0:
            return _challenge()
        counted = self._flood.hit(_FAILED_PREFIX + address, window=self._window, now=self._clock())
        if counted.count > tolerated:
            return _text_answer(429, _LOCKED_TEXT, {"Retry-After": _retry_after(counted.retry_after)})
        return _challenge()

    # -- step 4 --
    def _flooded(self, client: str | None, address: str) -> HttpAnswer | None:
        limit = self._tsa.flood.limit
        if limit == 0:
            return None
        key = _ADDRESS_PREFIX + address if client is None else _CLIENT_PREFIX + client
        counted = self._flood.hit(key, window=self._window, now=self._clock())
        if counted.count > limit:
            return _text_answer(429, _FLOOD_TEXT, {"Retry-After": _retry_after(counted.retry_after)})
        return None

    # -- step 5 --
    def _sized(self, headers: Mapping[str, str], client: str | None, retry_after: int) -> Admitted | Refused:
        length = header(headers, "Content-Length")
        if length is None:
            return Admitted(client)
        if not _DIGITS.fullmatch(length):
            return Refused(_rejection("badDataFormat", retry_after))
        if int(length) > self._max_size:
            return self.refuse_too_large()
        return Admitted(client)


def _media_type(value: str | None) -> str:
    return "" if value is None else value.partition(";")[0].strip().lower()


def _challenge() -> HttpAnswer:
    return _text_answer(401, _KEY_TEXT, {"WWW-Authenticate": BASIC_CHALLENGE})


def _presented_key(authorization: str | None) -> str | None:
    """Return the key text a client presented as a Bearer token or a Basic password, or `None` when it presented none.

    The scheme is case-insensitive (RFC 9110 section 11.1). Another scheme, a missing token, a Basic credential that
    does not decode or has no password present no key: nobody can guess a key through them.
    """
    if authorization is None:
        return None
    scheme, _, rest = authorization.strip().partition(" ")
    credentials = rest.strip()
    if not credentials:
        return None
    match scheme.lower():
        case "bearer":
            return credentials
        case "basic":
            try:
                decoded = base64.b64decode(credentials, validate=True).decode("latin-1")
            except (binascii.Error, ValueError):
                return None
            _, colon, password = decoded.partition(":")
            return password if colon and password else None
        case _:
            return None


# -- the answers ----------------------------------------------------------------------------------------------------
def _reply_headers() -> dict[str, str]:
    return {"Content-Type": REPLY_MEDIA_TYPE, "Cache-Control": _NO_STORE}


def granted_answer(grant: TimestampGrant) -> HttpAnswer:
    """Return the 200 answer carrying the whole `TimeStampResp` of a granted token."""
    return HttpAnswer(200, _reply_headers(), grant.response)


def refusal_answer(refusal: "TimestampRefusal", *, retry_after: int) -> HttpAnswer:
    """Return the DER rejection with the refusal's status (400, or 503 with `Retry-After: retry_after`)."""
    headers = _reply_headers()
    if refusal.http_status == HTTPStatus.SERVICE_UNAVAILABLE:
        headers["Retry-After"] = _retry_after(retry_after)
    return HttpAnswer(refusal.http_status, headers, refusal.to_der())


def answer_for(answer: "TimestampAnswer", *, retry_after: int) -> HttpAnswer:
    """Return the wire answer of what the authority answered: its grant, else its refusal.

    An authority answers one or the other; an answer with neither is a `ValueError`.
    """
    if answer.grant is not None:
        return granted_answer(answer.grant)
    if answer.refusal is None:
        raise ValueError("A timestamp answer carries a grant or a refusal.")
    return refusal_answer(answer.refusal, retry_after=retry_after)


def _rejection(failure: TimestampFailure, retry_after: int) -> HttpAnswer:
    from datum_core.timestamp.refusal import TimestampRefusal  # noqa: PLC0415 - needs the timestamp extra

    return refusal_answer(TimestampRefusal.of(TimestampRefusedError(failure)), retry_after=retry_after)


def _system_failure(retry_after: int) -> HttpAnswer:
    return _rejection("systemFailure", retry_after)


def _pem(certificates: Sequence[bytes]) -> bytes:
    return "".join(ssl.DER_cert_to_PEM_cert(certificate) for certificate in certificates).encode("ascii")


def _certificate_headers(media_type: str) -> dict[str, str]:
    return {"Content-Type": media_type, "Cache-Control": "no-cache"}


def certificate_answer(chain: Sequence[bytes], *, fmt: str | None) -> HttpAnswer:
    """Return the signing chain (signer first) as PEM; with `fmt="der"` the leaf alone as `application/pkix-cert`."""
    if fmt is not None and fmt.lower() == "der":
        return HttpAnswer(200, _certificate_headers(CERTIFICATE_DER_MEDIA_TYPE), chain[0])
    return HttpAnswer(200, _certificate_headers(PEM_MEDIA_TYPE), _pem(chain))


def certificates_answer(chain: Sequence[bytes], retired: Sequence[bytes]) -> HttpAnswer:
    """Return the current chain and then the retired certificates, all in PEM."""
    return HttpAnswer(200, _certificate_headers(PEM_MEDIA_TYPE), _pem([*chain, *retired]))
