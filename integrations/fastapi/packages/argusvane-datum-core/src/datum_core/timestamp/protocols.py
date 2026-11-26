"""The timestamp seams: protocols and the plain records they pass, nothing third-party.

Built on: the standard library (`typing.Protocol`, `dataclasses`, `datetime`) and `datum_core.hooks` (the
`MaybeAwaitable` alias and `HookRefusedError`) cover every shape here. `pydantic` models would add validation these
records do not need, `anyio` and `httpx` carry no TSA vocabulary, and no standard type reads a clock, allocates a
serial or posts once; so the protocols are written here, once, for the authority, the client, the stores and the
application to implement against.

Stores and the transport are synchronous (the authority runs on a worker thread); a time source and a customizer may
answer an awaitable, resolved through the service's awaiter like every other hook. The private key never leaves its
`TsaKeyMaterial`: the authority asks it to sign and never to hand the key over.

The store seams (`TsaSerialAllocator`, `TsaLog`, `TsaLogEntry`, `TsaClientStore`, `TsaClientRecord`) live in
`datum_core.stores.tsa`, below this package in the layering; the `datum_core.timestamp` facade names them too.
"""

from collections.abc import Mapping
from dataclasses import dataclass, replace
from datetime import datetime
from typing import Literal, Protocol

from datum_core.hooks import Hook, MaybeAwaitable

__all__ = [
    "HTTP_CHANNEL",
    "Reading",
    "TimestampChannel",
    "TimestampFailure",
    "TimestampGrant",
    "TimestampRefusedError",
    "TimestampRequestCustomizer",
    "TimestampRequestDraft",
    "TimestampRequestHook",
    "Timestamper",
    "TransportReply",
    "TsaKeyMaterial",
    "TsaTimeSource",
    "TsaTransport",
    "every_channel",
]

type TimestampChannel = Literal["http", "seal", "receipt"]
"""Where a token is asked for: the endpoint, a PDF seal, or a submission receipt."""

HTTP_CHANNEL: TimestampChannel = "http"
"""The channel of `POST /tsa`: the only one a customizer sees unless it opts in."""

type TimestampFailure = Literal[
    "badAlg",
    "badRequest",
    "badDataFormat",
    "timeNotAvailable",
    "unacceptedPolicy",
    "unacceptedExtension",
    "systemFailure",
]
"""The RFC 3161 failure names a refusal may carry (bit numbers and statuses are the refusal module's)."""


# -- the clock --


@dataclass(frozen=True, slots=True)
class Reading:
    """What a time source answers: an instant, or the reason there is none.

    The reason reaches clients and the health detail: it carries no hostname and no address.
    """

    instant: datetime | None
    reason: str | None = None

    def __post_init__(self) -> None:
        """Refuse a reading that is both available and unavailable, or neither (build one with the two constructors)."""
        if (self.instant is None) == (self.reason is None):
            raise ValueError("a reading holds an instant or a reason, never both and never neither")

    @classmethod
    def available(cls, instant: datetime) -> "Reading":
        """Return a reading holding `instant` (timezone-aware)."""
        if instant.tzinfo is None or instant.utcoffset() is None:
            raise ValueError("a reading's instant is timezone-aware")
        return cls(instant, None)

    @classmethod
    def unavailable(cls, reason: str) -> "Reading":
        """Return a reading that says why the time cannot be vouched for."""
        return cls(None, reason)

    @property
    def is_available(self) -> bool:
        """Whether there is an instant."""
        return self.instant is not None


class TsaTimeSource(Protocol):
    """The authority's clock; a source that raises counts as unavailable (its message goes to the log only)."""

    def read(self) -> MaybeAwaitable[Reading]:
        """Return `Reading.available(instant)` or `Reading.unavailable(reason)`."""
        ...


# -- the key (the serial, log and client seams live in `datum_core.stores.tsa`, re-exported here) --


class TsaKeyMaterial(Protocol):
    """The signing key and its chain, loaded once at start; the key is used through `sign` and is never exposed."""

    @property
    def signature_algorithm(self) -> Literal["rsa-sha256", "ecdsa-sha256"]:
        """The SignerInfo algorithm: PKCS#1 v1.5 with SHA-256, or ECDSA with SHA-256."""
        ...

    @property
    def chain_der(self) -> tuple[bytes, ...]:
        """The DER certificates, the signer's first."""
        ...

    def sign(self, data: bytes) -> bytes:
        """Return the signature over `data` (hashed with SHA-256 inside) in the algorithm's wire form."""
        ...


# -- the customizer --


class TimestampRefusedError(Exception):
    """A customizer's (or the host's) refusal of a request, carrying the RFC 3161 failure it answers with.

    `failure` is a name from `TimestampFailure`; `message` is Datum-side words for the status text and echoes no
    request byte. A `HookRefusedError` of any kind is `badRequest`; any other raise is `systemFailure`.
    """

    def __init__(self, failure: TimestampFailure, message: str = "") -> None:
        """Keep the failure name and the message."""
        super().__init__(failure, message)  # the arguments the class takes, so the error pickles and copies
        self.failure: TimestampFailure = failure
        self.message = message

    def __str__(self) -> str:
        """Return the message, or the failure name when there is none."""
        return self.message or self.failure


@dataclass(frozen=True, slots=True)
class TimestampRequestDraft:
    """What a customizer is told; it returns a changed copy (`with_policy`, `with_accuracy`, `replace`).

    `requested_policy` is what the request named (None: none); `policy` is the one that will be issued and may be
    changed only when the request named none, and only to one of `accepted_policies`; `accuracy` is whole or
    fractional seconds, 0 to 60. A value out of bounds is a defect of the hook (`systemFailure`).
    """

    channel: TimestampChannel
    imprint_algorithm: str
    requested_policy: str | None
    policy: str
    accepted_policies: tuple[str, ...]
    accuracy: float
    cert_req: bool
    client: str | None = None
    principal: object | None = None

    def with_policy(self, policy: str) -> "TimestampRequestDraft":
        """Return a copy that issues under `policy`."""
        return replace(self, policy=policy)

    def with_accuracy(self, seconds: float) -> "TimestampRequestDraft":
        """Return a copy that states `seconds` of accuracy."""
        return replace(self, accuracy=seconds)


type TimestampRequestHook = Hook[[TimestampRequestDraft], TimestampRequestDraft | None]
"""A plain customizer: a sync or async callable over the draft. The service reads `getattr(hook, "applies_to", None)`
to learn the channels it runs on (none: the endpoint's `http` only); `every_channel` supplies it."""


class TimestampRequestCustomizer(Protocol):
    """Refuses a request or adjusts it (policy among the accepted, accuracy); sync or async.

    Answer the changed draft, or None to leave it. Raise `TimestampRefusedError` to refuse with a failure bit, or
    `HookRefusedError` to refuse as `badRequest`. The endpoint's tokens carry channel `http`; the host's own seals and
    receipts reach only a customizer whose `applies_to` says so (see `every_channel`).
    """

    def __call__(self, draft: TimestampRequestDraft) -> MaybeAwaitable[TimestampRequestDraft | None]:
        """Return the draft to issue under, or None."""
        ...

    def applies_to(self, channel: TimestampChannel) -> bool:
        """Say whether the customizer runs for tokens on `channel`."""
        ...


class _EveryChannel:
    """A customizer wrapped to run on every channel."""

    __slots__ = ("_inner",)

    def __init__(self, inner: TimestampRequestHook) -> None:
        self._inner = inner

    def __call__(self, draft: TimestampRequestDraft) -> MaybeAwaitable[TimestampRequestDraft | None]:
        return self._inner(draft)

    def applies_to(self, channel: TimestampChannel) -> bool:  # noqa: ARG002 - every channel
        return True


def every_channel(customizer: TimestampRequestHook) -> TimestampRequestCustomizer:
    """Wrap a plain callable (or a customizer) so it runs for the endpoint, seals and receipts alike."""
    return _EveryChannel(customizer)


# -- the outbound side --


@dataclass(frozen=True, slots=True)
class TransportReply:
    """What one POST answered: the status, the content type (None: none sent) and the body (already bounded)."""

    status: int
    content_type: str | None
    body: bytes


class TsaTransport(Protocol):
    """One POST to a timestamp authority, answered with status, content type and bytes.

    The default never follows a redirect, honours `HTTPS_PROXY` and `SSL_CERT_FILE`, bounds the reply and the wait,
    and sends credentials only to `url` (an `https://` `HTTPS_PROXY` is not supported: only an http proxy URL is).
    A transport raises on a network failure; it never returns a redirect as a success.

    The client refuses a transport whose `follow_redirects` attribute is true at construction, and that attribute is
    the only construction-time signal it reads: a transport that follows redirects without saying so is not detected
    until it has sent the credentials. The client applies its own 1 MiB check to whatever reply a transport returns.
    """

    def post(
        self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
    ) -> TransportReply:
        """POST `body` to `url` and return the reply."""
        ...


@dataclass(frozen=True, slots=True)
class TimestampGrant:
    """A token obtained: the whole `TimeStampResp` bytes (what a PDF `complete` takes) and the token's DER."""

    response: bytes
    token: bytes
    gen_time: datetime
    serial: int


class Timestamper(Protocol):
    """Asks for a token over an imprint; the authority and the client both implement it."""

    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",
    ) -> TimestampGrant:
        """Return a verified grant over `imprint` (`algorithm`: sha256, sha384 or sha512), or raise a typed refusal.

        `channel` says what the token is for (a PDF `seal` or a submission `receipt`): the in-process authority runs
        the customizers that apply to it, and a client of a remote authority ignores it.
        """
        ...
