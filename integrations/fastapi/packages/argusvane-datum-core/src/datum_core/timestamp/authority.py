"""`TimestampAuthority`: issues RFC 3161 tokens.

The pipeline of one token, in this order (each refusal stops it and costs what follows nothing):

1. the request's own policy: one the server does not issue under is `unacceptedPolicy`, the words listing the accepted;
2. `customizers`, in list order, each seeing what the one before left: the endpoint's tokens (channel `http`) reach
   every plain callable; a seal or a receipt reaches only a customizer whose `applies_to(channel)` is true
   (`every_channel`). A `TimestampRefusedError` refuses with its failure; a `HookRefusedError` of any kind is
   `badRequest` with its message; any other raise, and a draft out of bounds (another policy than the accepted ones,
   a policy changed when the request named one, an accuracy outside 0 to 60 seconds, any other field changed), is
   `systemFailure` with the cause logged;
3. the time source, read once: unavailable (or raising, or answering something that is not a `Reading`) is
   `timeNotAvailable`, and nothing is allocated or signed;
4. the serial, allocated before signing and never reused;
5. the signature, by the key material (the key never leaves it);
6. the read-back: the reply is read as a client would read it before it leaves;
7. the log row, then `TimestampIssuedEvent`. A refusal publishes `TimestampRefusedEvent` only.

Failure policy: any store, key or log failure, and a read-back that does not hold, is
`TimestampRefusedError("systemFailure")` with the original as `__cause__`; the cause is logged on `datum.tsa` only and
never reaches the reply. A log append that fails means no token: the serial is burnt, never reused. Once the events
dispatcher is closed (the owning `Datum` stopped) no serial is allocated: the answer is `systemFailure`.
A call that passed that check just before `stop()` still finishes (the check comes before the serial).

One `datum.tsa.issue` span covers each `issue()` or `answer()`: `datum.channel`, `datum.outcome` (`granted` or
`refused`) and, on a refusal, `error.type` set to the RFC 3161 failure name. It carries no imprint, nonce, serial, key
or client. The authority is synchronous: the binding runs it on a worker thread.
"""

import importlib.metadata
import logging
import math
from collections.abc import Callable, Sequence
from contextlib import AbstractContextManager
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Final

from opentelemetry import trace
from opentelemetry.trace import Span, SpanKind, Status, StatusCode

from datum_core.events import EventDispatcher, TimestampIssuedEvent, TimestampRefusedEvent
from datum_core.hooks import Awaiter, HookRefusedError, call_hook
from datum_core.loggers import TSA
from datum_core.stores.tsa import TsaLog, TsaLogEntry, TsaSerialAllocator
from datum_core.timestamp import _der
from datum_core.timestamp.protocols import (
    HTTP_CHANNEL,
    Reading,
    TimestampChannel,
    TimestampGrant,
    TimestampRefusedError,
    TimestampRequestCustomizer,
    TimestampRequestDraft,
    TimestampRequestHook,
    TsaKeyMaterial,
    TsaTimeSource,
)
from datum_core.timestamp.query import TimestampQuery, policy_problem
from datum_core.timestamp.refusal import FAILURES, TimestampRefusal

__all__ = ["TimestampAnswer", "TimestampAuthority"]

logger = logging.getLogger(TSA)

_MAX_ACCURACY: Final = 60.0
_SERIAL_BITS: Final = 160
_UNAVAILABLE: Final = "The timestamp server's time source is not available"


def _version() -> str:
    try:
        return importlib.metadata.version("argusvane-datum-core")
    except importlib.metadata.PackageNotFoundError:
        return "unknown"


_tracer = trace.get_tracer("datum", _version())


@dataclass(frozen=True, slots=True)
class TimestampAnswer:
    """What `POST /tsa` answers: the whole `TimeStampResp`, and either the refusal or the grant."""

    response: bytes
    refusal: TimestampRefusal | None
    grant: TimestampGrant | None


def _accuracy(seconds: object) -> float:
    """Return `seconds` when it is a finite number from 0 to 60, else raise `ValueError`."""
    if isinstance(seconds, bool) or not isinstance(seconds, int | float) or not math.isfinite(seconds):
        raise ValueError("the accuracy is a number of seconds from 0 to 60")
    if not 0 <= seconds <= _MAX_ACCURACY:
        raise ValueError(f"the accuracy is 0 to 60 seconds, not {seconds}")
    return float(seconds)


def _serial_of(value: object) -> int | None:
    """Return `value` when it is a positive serial of at most 160 bits (an allocator may answer anything)."""
    if isinstance(value, bool) or not isinstance(value, int) or not 0 < value < 1 << _SERIAL_BITS:
        return None
    return value


def _reading_of(value: object) -> Reading | None:
    """Return `value` when it is a `Reading` (a time source may answer anything)."""
    return value if isinstance(value, Reading) else None


def _fixed_fields(draft: TimestampRequestDraft) -> tuple[object, ...]:
    """Return the draft's fields a customizer may not change (the principal is compared apart, by identity)."""
    return (
        draft.channel,
        draft.imprint_algorithm,
        draft.requested_policy,
        draft.accepted_policies,
        draft.cert_req,
        draft.client,
    )


class TimestampAuthority:
    """Issues timestamp tokens over a key material, a serial allocator, a clock, customizers, a log and events.

    `policy` is the issuing policy; `accepted_policies` are further policies a request may name (the issuing one is
    always accepted); `accuracy` is the stated accuracy in seconds (0 to 60; 0 states none). `time_source` reads the
    time (None: `now`, always available; `now` defaults to the system clock in UTC). `awaiter` resolves an async
    customizer or time source. `retired_certificates` are the DER certificates of keys no longer used, served beside
    the chain.
    """

    __slots__ = (
        "_accepted",
        "_accuracy",
        "_awaiter",
        "_chain",
        "_customizers",
        "_events",
        "_fixed",
        "_log",
        "_now",
        "_policies_der",
        "_policy",
        "_policy_words",
        "_retired",
        "_serials",
        "_signer",
        "_time_checked",
        "_time_problem",
        "_time_source",
    )

    def __init__(
        self,
        key: TsaKeyMaterial,
        serials: TsaSerialAllocator,
        *,
        policy: str,
        accepted_policies: Sequence[str] = (),
        accuracy: float = 1.0,
        time_source: TsaTimeSource | None = None,
        now: Callable[[], datetime] | None = None,
        customizers: Sequence[TimestampRequestHook | TimestampRequestCustomizer] = (),
        log: TsaLog | None = None,
        events: EventDispatcher | None = None,
        awaiter: Awaiter | None = None,
        retired_certificates: Sequence[bytes] = (),
    ) -> None:
        """Check the settings and build the parts every token shares (raise `ValueError` naming the setting)."""
        self._accuracy = _accuracy(accuracy)
        accepted = tuple(dict.fromkeys((policy, *accepted_policies)))
        for named in accepted:
            problem = policy_problem(named)
            if problem is not None:
                raise ValueError(f"the timestamp policy {named!r} is refused: {problem}")
        self._policy = policy
        self._accepted = accepted
        self._policies_der = {named: _der.oid(named) for named in accepted}
        self._policy_words = "The requested policy is not one this server issues under; it issues under " + (
            ", ".join(accepted) + "."
        )
        self._chain = tuple(bytes(der) for der in key.chain_der)
        self._fixed = _der.fixed_parts(self._chain, key.signature_algorithm)
        self._signer = key
        self._serials = serials
        self._time_source = time_source
        self._time_checked = False
        self._time_problem: str | None = None
        self._now = now
        self._customizers = tuple(customizers)
        self._log = log
        self._events = events
        self._awaiter = awaiter
        self._retired = tuple(bytes(der) for der in retired_certificates)

    def __repr__(self) -> str:
        """Name the policy and how many certificates the chain holds; nothing about the key."""
        return f"TimestampAuthority(policy={self._policy!r}, certificates={len(self._chain)})"

    @property
    def policy(self) -> str:
        """The issuing policy."""
        return self._policy

    @property
    def accepted_policies(self) -> tuple[str, ...]:
        """Every policy a request may name: the issuing one first."""
        return self._accepted

    @property
    def certificate_chain_der(self) -> tuple[bytes, ...]:
        """The signing certificate's chain as DER, the signer's first (what `GET /tsa/certificate` serves)."""
        return self._chain

    @property
    def retired_certificates_der(self) -> tuple[bytes, ...]:
        """Certificates of keys no longer used, as DER (served after the chain by `GET /tsa/certificates`)."""
        return self._retired

    # -- the three entry points ----------------------------------------------------------------------------------------

    @property
    def time_read(self) -> bool:
        """Whether a token has read the time yet (health reports `not read yet` before that)."""
        return self._time_checked

    @property
    def last_time_problem(self) -> str | None:
        """Why the last time read gave no time (None: it did, or none was made yet; see `time_read`).

        Health reports this and never calls the time source itself: the probes run on the event loop.
        """
        return self._time_problem

    def issue(
        self,
        query: TimestampQuery,
        *,
        channel: TimestampChannel = HTTP_CHANNEL,
        client: str | None = None,
        principal: object | None = None,
    ) -> TimestampGrant:
        """Issue a token for `query`; raise `TimestampRefusedError` (the refused event published) when refused."""
        with self._span(channel) as span:
            try:
                grant = self._issue(query, channel, client, principal)
            except TimestampRefusedError as error:
                self._refused(span, TimestampRefusal.of(error))
                raise
            span.set_attribute("datum.outcome", "granted")
            return grant

    def answer(
        self,
        request: bytes,
        *,
        channel: TimestampChannel = HTTP_CHANNEL,
        client: str | None = None,
        principal: object | None = None,
    ) -> TimestampAnswer:
        """Read `request` and answer it: the granted reply, or the rejection (never raises a refusal)."""
        with self._span(channel) as span:
            try:
                grant = self._issue(TimestampQuery.parse(request), channel, client, principal)
            except TimestampRefusedError as error:
                refusal = TimestampRefusal.of(error)
                self._refused(span, refusal)
                return TimestampAnswer(refusal.to_der(), refusal, None)
            span.set_attribute("datum.outcome", "granted")
            return TimestampAnswer(grant.response, None, grant)

    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",
    ) -> TimestampGrant:
        """Issue a token over `imprint` for the host's own use (the `Timestamper` side; channel `seal` unless told)."""
        return self.issue(TimestampQuery.of(imprint, algorithm, policy=policy, cert_req=cert_req), channel=channel)

    # -- the pipeline --------------------------------------------------------------------------------------------------

    def _issue(
        self, query: TimestampQuery, channel: TimestampChannel, client: str | None, principal: object | None
    ) -> TimestampGrant:
        if query.policy is not None and query.policy not in self._accepted:
            raise TimestampRefusedError("unacceptedPolicy", self._policy_words)
        draft = self._customized(
            TimestampRequestDraft(
                channel=channel,
                imprint_algorithm=query.imprint_algorithm,
                requested_policy=query.policy,
                policy=query.policy or self._policy,
                accepted_policies=self._accepted,
                accuracy=self._accuracy,
                cert_req=query.cert_req,
                client=client,
                principal=principal,
            )
        )
        instant = self._read_time()
        if self._events is not None and self._events.closed:
            raise TimestampRefusedError("systemFailure")  # the owner stopped: no serial after the stop
        serial = _serial_of(self._guarded("the serial allocator failed", self._serials.allocate))
        if serial is None:
            raise self._failure("the serial allocator answered something that is not a positive 160-bit serial", None)
        accuracy_millis = round(draft.accuracy * 1000)
        if 0 < accuracy_millis < 1000:  # noqa: PLR2004 - genTime carries milliseconds only under one second
            gen_time = instant.replace(microsecond=instant.microsecond // 1000 * 1000)
        else:
            gen_time = instant.replace(microsecond=0)
        tst_der = _der.tst_info(
            policy=self._policies_der[draft.policy],
            imprint=query.imprint_der(),
            serial=serial,
            gen_time=gen_time,
            accuracy_millis=accuracy_millis,
            nonce=query.nonce,
            tsa=self._fixed.tsa,
        )
        attributes = _der.signed_attributes(self._fixed, tst_der=tst_der, signing_time=gen_time)
        signature = self._guarded("the key material failed to sign", self._signer.sign, attributes)
        response, token = _der.granted_reply(
            self._fixed, tst_der=tst_der, attributes=attributes, signature=bytes(signature), cert_req=query.cert_req
        )
        self._guarded(
            "the issued reply does not read back",
            _der.check_issued,
            response,
            self._fixed,
            chain=self._chain,
            cert_req=query.cert_req,
            serial=serial,
            policy=draft.policy,
            imprint_oid=query.imprint_oid,
            imprint=query.imprint,
            imprint_der=query.imprint_der(),
            nonce=query.nonce,
            gen_time=gen_time,
            accuracy_millis=accuracy_millis,
        )
        if self._log is not None:
            entry = TsaLogEntry(serial, gen_time, query.imprint_algorithm, query.imprint.hex(), client)
            self._guarded("the timestamp log failed to append; the serial is burnt", self._log.append, entry)
        if self._events is not None:
            self._events.publish(
                TimestampIssuedEvent(
                    serial=serial, gen_time=gen_time, imprint_algorithm=query.imprint_algorithm, client=client
                )
            )
        return TimestampGrant(response=response, token=token, gen_time=gen_time, serial=serial)

    def _customized(self, draft: TimestampRequestDraft) -> TimestampRequestDraft:
        for hook in self._customizers:
            try:
                applies_to = getattr(hook, "applies_to", None)
                runs = draft.channel == HTTP_CHANNEL if applies_to is None else bool(applies_to(draft.channel))
                if not runs:
                    continue
                answered = call_hook(hook, self._awaiter, draft)
            except TimestampRefusedError as error:
                if error.failure not in FAILURES:
                    raise self._failure("a timestamp customizer refused with an unknown failure", error) from error
                raise
            except HookRefusedError as error:
                raise TimestampRefusedError("badRequest", str(error)) from error
            except Exception as error:
                raise self._failure("a timestamp customizer failed", error) from error
            if answered is not None:
                draft = self._within_bounds(draft, answered)
        return draft

    def _within_bounds(self, before: TimestampRequestDraft, after: object) -> TimestampRequestDraft:
        """Return `after` when it changes only what a customizer may change, within bounds; else `systemFailure`."""
        if not isinstance(after, TimestampRequestDraft):
            raise self._failure("a timestamp customizer answered something that is not a draft", None)
        if after.principal is not before.principal or _fixed_fields(after) != _fixed_fields(before):
            raise self._failure("a timestamp customizer changed a field it may not change", None)
        if after.policy not in self._accepted:
            raise self._failure("a timestamp customizer chose a policy the server does not accept", None)
        if before.requested_policy is not None and after.policy != before.requested_policy:
            raise self._failure("a timestamp customizer changed the policy the request named", None)
        try:
            _accuracy(after.accuracy)
        except ValueError as error:
            raise self._failure("a timestamp customizer stated an accuracy outside 0 to 60 seconds", error) from error
        return after

    def _read_time(self) -> datetime:
        try:
            if self._time_source is None:
                now = self._now() if self._now is not None else datetime.now(UTC)
                answered: object = Reading.available(now)
            else:
                answered = call_hook(self._time_source.read, self._awaiter)
        except Exception as error:
            logger.warning("the timestamp time source failed; answering timeNotAvailable", exc_info=True)
            self._noted("the time source failed")
            raise TimestampRefusedError("timeNotAvailable", _UNAVAILABLE + ".") from error
        reading = _reading_of(answered)
        if reading is None:
            logger.warning("the timestamp time source answered %s, not a Reading", type(answered).__name__)
            self._noted("the time source answered something that is not a reading")
            raise TimestampRefusedError("timeNotAvailable", _UNAVAILABLE + ".")
        instant = reading.instant
        if instant is None or instant.utcoffset() is None:
            reason = reading.reason if instant is None and reading.reason else ""
            self._noted(
                (reason or "no reason given")
                if instant is None
                else "the time source answered an instant without a zone"
            )
            raise TimestampRefusedError(
                "timeNotAvailable", f"{_UNAVAILABLE}: {reason}" if reason else _UNAVAILABLE + "."
            )
        self._noted(None)
        return instant.astimezone(UTC)

    def _noted(self, problem: str | None) -> None:
        """Record the outcome of this time read for health (a plain attribute write; no lock is needed)."""
        self._time_problem = problem
        self._time_checked = True

    def _guarded[**P, T](self, what: str, call: Callable[P, T], /, *args: P.args, **kwargs: P.kwargs) -> T:
        """Run a store, key or read-back step: a raise becomes `systemFailure` with the cause in the log only."""
        try:
            return call(*args, **kwargs)
        except Exception as error:
            raise self._failure(what, error) from error

    @staticmethod
    def _failure(what: str, cause: BaseException | None) -> TimestampRefusedError:
        """Log `what` (and the cause, with its traceback) on `datum.tsa`; return the `systemFailure` to raise."""
        logger.error("%s; answering systemFailure", what, exc_info=cause)
        return TimestampRefusedError("systemFailure")

    # -- observation ---------------------------------------------------------------------------------------------------

    @staticmethod
    def _span(channel: str) -> AbstractContextManager[Span]:
        return _tracer.start_as_current_span(
            "datum.tsa.issue",
            kind=SpanKind.INTERNAL,
            attributes={"datum.channel": channel},
            record_exception=False,
            set_status_on_exception=False,
        )

    def _refused(self, span: Span, refusal: TimestampRefusal) -> None:
        span.set_attribute("datum.outcome", "refused")
        span.set_attribute("error.type", refusal.failure)
        if refusal.http_status >= 500:  # noqa: PLR2004 - the server's own failures
            span.set_status(Status(StatusCode.ERROR))
        if self._events is not None:
            self._events.publish(TimestampRefusedEvent(fail_info=refusal.failure, reason=refusal.text))
