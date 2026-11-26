"""`TimestampClient`: asks a remote RFC 3161 authority for a token and believes nothing it was not shown.

The client is the weaker party's guard. One request is one POST of an `application/timestamp-query` carrying a fresh
random nonce, answered by an `application/timestamp-reply`; the token comes back only when every one of these holds:

1. the status is 200 (a 3xx is a `redirect` refusal and is never followed; any other status is `http-status`, read as
   the status alone: none of the server's words are kept);
2. the reply is no longer than 1 MiB (`too-large`) and its content type is `application/timestamp-reply`
   (`content-type`, refused unread);
3. the body is a `TimeStampResp` (read through `TimeStampRespOpt`, so a rejection loads) whose PKIStatus is 0 or 1
   (`unreadable` when it is not a reply or a granted reply holds no token; `rejected` for status 2, naming the failure
   bits and the server's words, however many tokens it carries; `pki-status` for waiting or revocation statuses 3 to 5);
4. the token covers the imprint that was sent (`imprint`), echoes the nonce that was sent (`nonce`), and, when a policy
   was asked, was issued under it (`policy`);
5. the token reads and holds under the certificate it carries, which is the one it names (`verify_digest`; `token`).
   A request that asked for no
   certificates (`cert_req=False`) cannot be checked without the signer's certificate: the grant's `parsed` token is
   then the caller's to check with `check(known_certificates)` or `verify_over`.

Every failure is a `TimestampClientError` with a stable `reason`; its text is Datum's words (plus the sanitised words of
a rejection) and carries no URL, no header, no credential and no word of the network failure behind `unreachable`.

The outbound request carries only the headers this module builds (content type, accept, `Authorization`): no W3C
trace-context header and no baggage, and instrumentation is suppressed for the call so an application's
auto-instrumentation cannot add them. The span `datum.tsa.request` (CLIENT, a child of the caller's span) carries the
outcome and, on a failure, `error.type`; it names no URL.

Credentials come from `TsaClientOptions` (`bearer_token`, or `basic_user` with `basic_password`; a URL's user-info
is the fallback) and are built into the one `Authorization` header sent to the URL named; the URL is handed to the
transport without its user-info. The default transport is `HttpTsaTransport`; an application hands in its own
(mutual TLS, say) through `transport=`. A transport that follows redirects is refused at construction, and so are
credentials (a bearer token, a Basic pair or URL user-info) for an `http://` URL whose host is not loopback
(127.0.0.0/8, `::1`, `localhost`). The client applies its own 1 MiB bound to the reply of any transport.

The PDF seal uses this class as a `Timestamper`: `request()` returns a `TimestampClientGrant`, a
`TimestampGrant` whose `response` is the whole `TimeStampResp` (what a PDF `complete` takes) and whose `parsed` is the
`TimestampToken` (`check()` and `verify_over()` need no PDF code).
"""

import base64
import contextlib
import importlib.metadata
import ipaddress
import logging
import secrets
from collections.abc import Generator
from dataclasses import dataclass
from typing import Final, Literal
from urllib.parse import unquote, urlsplit, urlunsplit

from opentelemetry import context, trace
from opentelemetry.trace import SpanKind, Status, StatusCode

from datum_core.config.models import TsaClientOptions
from datum_core.loggers import TSA
from datum_core.timestamp import _der
from datum_core.timestamp.protocols import (
    TimestampChannel,
    TimestampGrant,
    TransportReply,
    TsaTransport,
)
from datum_core.timestamp.query import TimestampQuery
from datum_core.timestamp.refusal import FAILURES
from datum_core.timestamp.token import TimestampToken
from datum_core.timestamp.transport import MAX_REPLY, HttpTsaTransport, ReplyTooLargeError
from datum_sandbox.checks import DatumConfigurationError

__all__ = ["TimestampClient", "TimestampClientError", "TimestampClientGrant"]

logger = logging.getLogger(TSA)


def _version() -> str:
    try:
        return importlib.metadata.version("argusvane-datum-core")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


_tracer = trace.get_tracer("datum", _version())
"""The same scope as `datum_core.observe.tracer`, acquired here (`lint-imports`: timestamp stays below observe)."""

type ClientFailure = Literal[
    "redirect",
    "http-status",
    "content-type",
    "unreadable",
    "rejected",
    "pki-status",
    "imprint",
    "nonce",
    "policy",
    "token",
    "too-large",
    "unreachable",
]
"""Why a request gave no token."""

QUERY_MEDIA_TYPE: Final = "application/timestamp-query"
REPLY_MEDIA_TYPE: Final = "application/timestamp-reply"

_NONCE_BOUND: Final = (1 << 63) - 1
_WORDS: Final[dict[str, str]] = {
    "redirect": "The timestamp server answered with a redirect; Datum follows none.",
    "http-status": "The timestamp server answered with an HTTP status other than 200.",
    "content-type": "The timestamp server's reply is not an application/timestamp-reply.",
    "unreadable": "The timestamp server's reply is not a readable timestamp response.",
    "rejected": "The timestamp server refused the request.",
    "pki-status": "The timestamp server answered with a status that holds no token.",
    "imprint": "The timestamp token does not cover the value that was sent.",
    "nonce": "The timestamp token does not echo the nonce that was sent.",
    "policy": "The timestamp token was issued under another policy than the one asked.",
    "token": "The timestamp token is not intact under its certificate.",
    "too-large": "The timestamp server's reply is longer than 1 MiB.",
    "unreachable": "The timestamp server could not be reached or did not answer in time.",
}
_PKI_GRANTED: Final = (0, 1)
_PKI_REJECTION: Final = 2
_PKI_NO_TOKEN: Final = (3, 4, 5)
_FAIL_BITS: Final[dict[int, str]] = {bit: name for name, (bit, _, _) in FAILURES.items()} | {17: "addInfoNotAvailable"}
_WORDS_LIMIT: Final = 200
_HTTP_OK: Final = 200
_REDIRECTS: Final = range(300, 400)
_SUPPRESS_KEY: Final = getattr(context, "_SUPPRESS_INSTRUMENTATION_KEY", None)
"""OpenTelemetry's key that instrumentations honour to stand aside (the API names it, not publicly)."""


class TimestampClientError(Exception):
    """A request that gave no token: the `reason`, and for a refusal the status, the failure names and the words.

    `http_status` is the HTTP status (set for `redirect` and `http-status`); `pki_status` the PKIStatus and `fail_info`
    the failure names of the reply's PKIFailureInfo, `server_text` the server's status text with anything but
    printable ASCII replaced and cut at 200 characters (set for `rejected` and `pki-status`). The text of the error
    never names a URL, a header or a credential.
    """

    def __init__(
        self,
        reason: ClientFailure,
        *,
        http_status: int | None = None,
        pki_status: int | None = None,
        fail_info: tuple[str, ...] = (),
        server_text: str | None = None,
    ) -> None:
        """Keep the reason and the facts of the refusal; build the text from Datum's words."""
        words = _WORDS[reason]
        if pki_status is not None and reason in ("rejected", "pki-status"):
            names = f", {', '.join(fail_info)}" if fail_info else ""
            said = f': "{server_text}"' if server_text else ""
            words = f"{words} (PKIStatus {pki_status}{names}){said}"
        elif http_status is not None:
            words = f"{words} (HTTP {http_status})"
        super().__init__(reason, words)
        self.reason: ClientFailure = reason
        self.http_status = http_status
        self.pki_status = pki_status
        self.fail_info = fail_info
        self.server_text = server_text
        self._words = words

    def __str__(self) -> str:
        """Return the text (Datum's words, plus a rejection's sanitised words)."""
        return self._words

    def __reduce__(self) -> tuple[object, ...]:
        """Pickle and copy by the fields, not by `args`."""
        return (_rebuild, (self.reason, self.http_status, self.pki_status, self.fail_info, self.server_text))


def _rebuild(
    reason: ClientFailure,
    http_status: int | None,
    pki_status: int | None,
    fail_info: tuple[str, ...],
    server_text: str | None,
) -> TimestampClientError:
    return TimestampClientError(
        reason, http_status=http_status, pki_status=pki_status, fail_info=fail_info, server_text=server_text
    )


@dataclass(frozen=True, slots=True)
class TimestampClientGrant(TimestampGrant):
    """A grant from a remote authority: `response` the whole `TimeStampResp`, `token` its DER, `parsed` the token."""

    parsed: TimestampToken


def _printable(words: tuple[str, ...]) -> str | None:
    """Join the server's status texts for a message: printable ASCII only, cut short (log and header injection)."""
    text = " ".join(words)
    clean = "".join(ch if " " <= ch <= "~" else "?" for ch in text).strip()
    return clean[:_WORDS_LIMIT] or None


def _url_without_userinfo(url: str) -> str | None:
    """Return `url` without its user-info, or None when it is not an http(s) URL with a host (keeps no parts)."""
    try:
        parts = urlsplit(url)
        if parts.scheme not in ("http", "https") or not parts.hostname:
            return None
        return urlunsplit(parts._replace(netloc=parts.netloc.rpartition("@")[2]))
    except ValueError:
        return None


def _unsafe(value: str) -> bool:
    return any(ch in value for ch in "\r\n\x00")


def _is_loopback(host: str) -> bool:
    """Whether `host` is `localhost` or a loopback address (127.0.0.0/8, ::1); no name is resolved."""
    name = host.rstrip(".").lower()
    if name == "localhost":
        return True
    try:
        return ipaddress.ip_address(name).is_loopback
    except ValueError:
        return False


class TimestampClient:
    """Obtains verified tokens from the authority at `options.url` (a `Timestamper`); thread-safe, holds no state."""

    __slots__ = ("_options", "_policy", "_timeout", "_transport", "_url")

    def __init__(self, options: TsaClientOptions, *, transport: TsaTransport | None = None) -> None:
        """Check the options (raise `DatumConfigurationError` without echoing the URL or a credential)."""
        if options.url is None:
            raise DatumConfigurationError(
                "The timestamp client has no URL.", hint="Set the timestamp authority URL (datum.pdf.signing.tsa.url)."
            )
        url = _url_without_userinfo(options.url)
        if url is None:
            raise DatumConfigurationError(
                "The timestamp URL is not an http or https URL with a host.",
                hint="Use an address such as https://tsa.example/timestamp.",
            )
        if (options.basic_user is None) != (options.basic_password is None):
            raise DatumConfigurationError(
                "The timestamp client's Basic credentials need both basic_user and basic_password.",
                hint="Set both, or neither.",
            )
        if options.basic_user is not None and (":" in options.basic_user or _unsafe(options.basic_user)):
            raise DatumConfigurationError(
                "The timestamp client's basic_user holds a character a Basic credential cannot carry.",
                hint="Use a user name without a colon or a line break.",
            )
        self._refuse_plain_http_credentials(options)
        self._options = options
        if any(_unsafe(value) for value in self._headers().values()):
            which = "bearer_token" if options.bearer_token is not None else "credential"
            raise DatumConfigurationError(
                f"The timestamp client's {which} holds a character a header cannot carry.",
                hint="Use a token without a line break or a NUL.",
            )
        if getattr(transport, "follow_redirects", False):
            raise DatumConfigurationError(
                "The timestamp transport follows redirects; the credentials would leave the URL named.",
                hint="Use a transport that returns a redirect as the status it is.",
            )
        self._url = url
        self._policy = options.policy
        self._timeout = options.timeout.total_seconds()
        self._transport: TsaTransport = transport if transport is not None else HttpTsaTransport()

    @staticmethod
    def _refuse_plain_http_credentials(options: TsaClientOptions) -> None:
        """Refuse credentials for an `http://` URL whose host is not loopback (they would cross in clear)."""
        parts = urlsplit(options.url or "")
        if parts.scheme != "http" or _is_loopback(parts.hostname or ""):
            return
        if options.bearer_token is not None:
            setting = "bearer_token"
        elif options.basic_user is not None:
            setting = "basic_user and basic_password"
        elif parts.username is not None:
            setting = "url (user-info)"
        else:
            return
        raise DatumConfigurationError(
            f"The timestamp client has {setting} set for an http URL that is not a loopback address; "
            "the credentials would cross the network unprotected.",
            hint="Use an https URL, or remove the credentials (datum.pdf.signing.tsa).",
        )

    def __repr__(self) -> str:
        """Name the timeout; the URL and the credentials are never shown."""
        return f"TimestampClient(timeout={self._timeout})"

    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",  # noqa: ARG002 - a remote authority runs no customizers
    ) -> TimestampClientGrant:
        """Obtain a token over `imprint` (`algorithm`: sha256, sha384 or sha512); raise `TimestampClientError`.

        `policy` (else the option's) is asked for and checked on the token. A bad `imprint`, `algorithm` or policy is
        the `TimestampRefusedError` the request rules raise, before anything is sent.
        """
        asked = policy if policy is not None else self._policy
        nonce = secrets.randbelow(_NONCE_BOUND) + 1
        query = TimestampQuery.of(imprint, algorithm, policy=asked, nonce=nonce, cert_req=cert_req)
        with _tracer.start_as_current_span(
            "datum.tsa.request", kind=SpanKind.CLIENT, record_exception=False, set_status_on_exception=False
        ) as span:
            try:
                grant = self._exchange(query)
            except TimestampClientError as error:
                span.set_attribute("datum.outcome", "refused")
                span.set_attribute("error.type", error.reason)
                span.set_status(Status(StatusCode.ERROR))
                raise
            except Exception as error:
                span.set_attribute("datum.outcome", "refused")
                span.set_attribute("error.type", type(error).__name__)
                span.set_status(Status(StatusCode.ERROR))
                raise
            span.set_attribute("datum.outcome", "granted")
            return grant

    # -- one exchange --------------------------------------------------------------------------------------------------

    def _exchange(self, query: TimestampQuery) -> TimestampClientGrant:
        reply = self._post(query.to_der())
        if not isinstance(reply, TransportReply):
            raise TimestampClientError("unreadable")
        if reply.status in _REDIRECTS:
            raise TimestampClientError("redirect", http_status=reply.status)
        if reply.status != _HTTP_OK:
            raise TimestampClientError("http-status", http_status=reply.status)
        if len(reply.body) > MAX_REPLY:
            raise TimestampClientError("too-large")
        media = (reply.content_type or "").partition(";")[0].strip().lower()
        if media != REPLY_MEDIA_TYPE:
            raise TimestampClientError("content-type")
        try:
            read = _der.read_reply(reply.body)
        except ValueError:
            read = None
        if read is None:
            raise TimestampClientError("unreadable")
        if read.status == _PKI_REJECTION or read.status in _PKI_NO_TOKEN:
            bits = tuple(_FAIL_BITS.get(bit, f"bit{bit}") for bit in sorted(read.fail_bits))
            raise TimestampClientError(
                "rejected" if read.status == _PKI_REJECTION else "pki-status",
                pki_status=read.status,
                fail_info=bits,
                server_text=_printable(read.texts),
            )
        if read.status not in _PKI_GRANTED or read.token is None:
            raise TimestampClientError("unreadable")
        try:
            token = TimestampToken.parse(read.token)
        except ValueError:
            token = None
        if token is None:
            raise TimestampClientError("token")
        self._judge(query, token)
        return TimestampClientGrant(
            response=reply.body, token=read.token, gen_time=token.gen_time, serial=token.serial, parsed=token
        )

    @staticmethod
    def _judge(query: TimestampQuery, token: TimestampToken) -> None:
        """Raise unless `token` answers `query`: its imprint, its nonce, its policy, then its own integrity."""
        if token.imprint_algorithm != query.imprint_algorithm or token.imprint != query.imprint:
            raise TimestampClientError("imprint")
        if token.nonce is None or token.nonce != query.nonce:
            raise TimestampClientError("nonce")
        if query.policy is not None and token.policy != query.policy:
            raise TimestampClientError("policy")
        if token.certificates:
            if token.verify_digest(query.imprint, query.imprint_algorithm):
                raise TimestampClientError("token")
        elif query.cert_req:  # the server ignored certReq: the signer cannot be found
            raise TimestampClientError("token")

    def _post(self, body: bytes) -> object:
        """Send `body` through the transport; a failure to get an answer is `unreachable` or `too-large`."""
        failure: ClientFailure | None = None
        reply: object = None
        with _quiet_instrumentation():
            try:
                reply = self._transport.post(
                    self._url,
                    body,
                    content_type=QUERY_MEDIA_TYPE,
                    accept=REPLY_MEDIA_TYPE,
                    headers=self._headers(),  # no local: a traceback's frame must not hold the credential
                    timeout=self._timeout,
                )
            except TimestampClientError:
                raise
            except ReplyTooLargeError:
                failure = "too-large"
            except Exception as error:  # a transport raises what its library raises; none of its words are kept
                logger.warning("the timestamp request failed (%s)", type(error).__name__)
                failure = "unreachable"
        if failure is not None:
            raise TimestampClientError(failure)  # outside the except block: the cause is not chained
        return reply

    def _headers(self) -> dict[str, str]:
        """Return the headers the client adds: the `Authorization` for the URL named, if there are credentials."""
        options = self._options
        if options.bearer_token is not None:
            return {"Authorization": "Bearer " + options.bearer_token.get_secret_value()}
        if options.basic_user is not None and options.basic_password is not None:
            return {"Authorization": _basic(options.basic_user, options.basic_password.get_secret_value())}
        parts = urlsplit(options.url or "")
        if parts.username is not None:  # the URL's user-info, the way every HTTP client reads it
            return {"Authorization": _basic(unquote(parts.username), unquote(parts.password or ""))}
        return {}


def _basic(user: str, password: str) -> str:
    return "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode("ascii")


@contextlib.contextmanager
def _quiet_instrumentation() -> Generator[None]:
    """Run the block with OpenTelemetry instrumentation told to stand aside (no trace context to a third party)."""
    if _SUPPRESS_KEY is None:
        yield
        return
    token = context.attach(context.set_value(_SUPPRESS_KEY, True))
    try:
        yield
    finally:
        context.detach(token)
