"""The seal : who signs what, and how.

`datum.pdf.seal.*` presets what the service signs. Which key:

- `render` and `fill` of POSTED answers (nothing stored): the throwaway "Datum test seal", made once when the seal is
  built, unless `posted_answers` is true and the server has a key (with no key, posted answers keep the test seal:
  `datum.W013` says so at start);
- `render_submission` (an accepted submission): the server's key, never the test seal; a sealed layout with no key is
  the 500 `signature` (`PdfSignatureError`);
- `sign`: the server's key whatever `enabled` and `layouts` say ("keeps its explicit shape": the seal's settings, its
  own route); with no key the service answers `Unavailable` before anything runs.

A `TestSealSigner` given as the application's own signer is still the test seal: it never serves `sign` or
`render_submission`. `layouts` lists the sealed layouts (empty: every one). The settings reach the program as the
request's `signature` member: the certificates, `certify`, `reason`, `location`, `appearance` (`false` for
`visible=false`, the program's default drawing for `true`, the layout's choice when unset) and `timestamp: true` when a
token will be asked, so the placeholder has room. The private key never leaves the signer: the seal hands it the
program's `toBeSigned` and takes a value back, held to the program's wire form (`wire_signature_value`) before
`complete`. Before the key signs, the handoff is tied to the prepared bytes (`_require_handoff_over`): the byte range
covers the file but for one gap, the digest is over those ranges, and `toBeSigned` is DER signed attributes whose one
`messageDigest` is that digest. A handoff refused there or for another algorithm than the signer's, a signer with no
certificate, a signer that raises and a value of no shape the program takes are the 500 `signature`
(`PdfSignatureError`); the signer's own exception stays in the log, never on the error or its chain.

The timestamp: the SHA-256 of the signature VALUE, asked of the `Timestamper` with channel `seal` and a
certificate requested; the whole `TimeStampResp` goes to `complete`, which checks it covers the value. A
`TimestampClientError` (a remote authority) or a `TimestampRefusedError` (the in-process one) is the
`sealing.timestamp` warning and the seal goes on without a token; so is a seal that asks a timestamp with no
timestamper. Any other raise is not swallowed. The throwaway test seal is NEVER timestamped: it proves nothing about
the server, so it burns no serial, makes no timestamp request and warns of nothing missing; only the server's key
carries a token.

Built on: the standard library (`dataclasses`, `hashlib`, `hmac`, `typing`), `cryptography` (the certificate's name),
`datum_core.pdf.signer` (`TestSealSigner`, `wire_signature_value`, `certificate_chain_pem`) and `datum_core.timestamp`
(`Timestamper`, `TimestampClient`, the two refusals, `signed_attributes_digest`) cover it. No library knows Datum's
seal preset or the order of a two-call signature with an optional token, so `PdfSeal` and its plan are written here;
the timestamper choice is a function.
"""

import hashlib
import hmac
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import datetime
from typing import Final, Literal

from cryptography import x509
from cryptography.x509.oid import NameOID

from datum_core.config.models import Seal, TsaClientOptions
from datum_core.hooks import HookProblem
from datum_core.loggers import PDF
from datum_core.pdf.outcomes import PdfSignatureError, PdfUnavailableError, SealWord
from datum_core.pdf.protocols import PdfOperation, PdfSigner
from datum_core.pdf.request import b64
from datum_core.pdf.signer import TestSealSigner, certificate_chain_pem, wire_signature_value
from datum_core.timestamp.attributes import signed_attributes_digest
from datum_core.timestamp.client import TimestampClient, TimestampClientError
from datum_core.timestamp.protocols import Timestamper, TimestampRefusedError, TsaTransport
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import DatumError, PdfKernel, PdfSigningHandoff

__all__ = ["PdfSeal", "SealPlan", "Sealed", "TimestampSource", "choose_timestamper"]

logger = logging.getLogger(PDF)

type TimestampSource = Literal["custom", "server", "site", "none"]
"""Where a seal's token comes from: the application's `Timestamper`, the client of `datum.pdf.signing.tsa.url`, the
in-process authority, or nowhere (the `info()` word)."""

_TIMESTAMP_CODE: Final = "sealing.timestamp"
_NO_TIMESTAMPER: Final = "The seal asked for a timestamp and no timestamper is set up, so the PDF carries none."
_REFUSED: Final = "The timestamp authority did not issue a token, so the PDF carries none."
_UNNAMED: Final = "unnamed signer"
_RANGE_LENGTH: Final = 4


def choose_timestamper(
    given: Timestamper | None,
    *,
    options: TsaClientOptions,
    transport: TsaTransport | None = None,
    authority: Timestamper | None = None,
) -> tuple[Timestamper | None, TimestampSource]:
    """Return the seal's timestamper and its word: the application's, else the URL's client, else the authority.

    `options` are `datum.pdf.signing.tsa`; `transport` the outbound POST the client uses (the default one when None);
    `authority` the in-process timestamp authority while `datum.tsa.enabled` (never counted as the application's).
    """
    if given is not None:
        return given, "custom"
    if options.url is not None:
        return TimestampClient(options, transport=transport), "server"
    if authority is not None:
        return authority, "site"
    return None, "none"


@dataclass(frozen=True, slots=True)
class SealPlan:
    """What one call's seal will do: the signer, its word, the program's `signature` settings, and the token asked."""

    signer: PdfSigner = field(repr=False)
    word: SealWord
    settings: Mapping[str, JsonValue]
    timestamp: bool
    """Ask a token (a timestamper exists and the preset asks one)."""
    timestamp_wanted: bool
    """The preset asks a token, whether or not there is a timestamper (none: the `sealing.timestamp` warning)."""

    def signature(self) -> dict[str, JsonValue]:
        """Return the request's `signature` member: the certificates (DER, base64, leaf first) and the settings."""
        member: dict[str, JsonValue] = {"certificates": [b64(der) for der in self.signer.certificates()]}
        member.update(self.settings)
        if self.timestamp:
            member["timestamp"] = True
        return member


@dataclass(frozen=True, slots=True)
class Sealed:
    """A sealed file: its bytes, the signature's field, the signer's name, whether a token is in, the warnings."""

    pdf: bytes = field(repr=False)
    field_name: str
    signed_by: str
    timestamped: bool
    warnings: tuple[HookProblem, ...] = ()


class PdfSeal:
    """The seal preset over the server's signer, the test seal and the timestamper (see the module text)."""

    __slots__ = ("_settings", "_signer", "_test_seal", "_timestamp_source", "_timestamper")

    def __init__(
        self,
        settings: Seal,
        *,
        signer: PdfSigner | None,
        timestamper: Timestamper | None,
        timestamp_source: TimestampSource | None = None,
        now: Callable[[], datetime] | None = None,
        test_seal: PdfSigner | None = None,
    ) -> None:
        """Keep the preset; make the test seal now when posted answers will need it and none is given.

        `signer` is the server's key (`KeyFilePdfSigner` or the application's `pdf_signer`; a `TestSealSigner` here is
        not a key of the server's). `timestamp_source` defaults to `custom` for a given timestamper and `none` else.
        """
        self._settings = settings
        self._signer = None if signer is None or isinstance(signer, TestSealSigner) else signer
        self._timestamper = timestamper
        self._timestamp_source: TimestampSource = timestamp_source or ("none" if timestamper is None else "custom")
        if test_seal is None and settings.enabled and (not settings.posted_answers or self._signer is None):
            test_seal = signer if isinstance(signer, TestSealSigner) else TestSealSigner(now=now() if now else None)
        self._test_seal = test_seal

    def __repr__(self) -> str:
        """Name the preset's switches only."""
        return f"PdfSeal(enabled={self._settings.enabled}, server_key={self._signer is not None})"

    @property
    def settings(self) -> Seal:
        """The preset (`datum.pdf.seal`)."""
        return self._settings

    @property
    def server_signer(self) -> PdfSigner | None:
        """The server's key, or None (the test seal is never the server's)."""
        return self._signer

    @property
    def timestamp_source(self) -> TimestampSource:
        """Where tokens come from (`custom`, `server`, `site`, `none`)."""
        return self._timestamp_source

    def certificate_chain(self) -> str | None:
        """Return the server's certificate chain as PEM (leaf first), or None without a key."""
        return None if self._signer is None else certificate_chain_pem(self._signer.certificates())

    # -- the plan ----------------------------------------------------------------------------------------------------

    def covers(self, op: PdfOperation, layout_id: str | None) -> bool | None:
        """Say whether a PDF of `op` printed with `layout_id` is sealed; None while the layout is still unknown."""
        if op == "sign":
            return True
        if not self._settings.enabled:
            return False
        if not self._settings.layouts:
            return True
        if layout_id is None:
            return None
        return layout_id in self._settings.layouts

    def plan(self, op: PdfOperation) -> SealPlan:
        """Return how a sealed PDF of `op` is signed; `PdfSignatureError` when the server has no key it needs."""
        signer: PdfSigner | None
        word: SealWord
        if op in {"sign", "render_submission"} or (self._settings.posted_answers and self._signer is not None):
            signer, word = self._signer, "server"
        else:
            signer, word = self._test_seal, "test"
        if signer is None:
            logger.error("a %s PDF must be sealed with the server's key and none is set up (datum.pdf.signing)", op)
            raise PdfSignatureError("the PDF must be sealed and the server has no signing key")
        wanted = self._settings.timestamp and word == "server"  # the test seal proves nothing: no token, no serial
        return SealPlan(
            signer=signer,
            word=word,
            settings=self._signature_settings(),
            timestamp=wanted and self._timestamper is not None,
            timestamp_wanted=wanted,
        )

    def _signature_settings(self) -> dict[str, JsonValue]:
        preset = self._settings
        settings: dict[str, JsonValue] = {"certify": preset.certify.program_word}
        if preset.reason is not None:
            settings["reason"] = preset.reason
        if preset.location is not None:
            settings["location"] = preset.location
        if preset.visible is False:
            settings["appearance"] = False
        elif preset.visible is True:
            settings["appearance"] = {}
        return settings

    # -- the signature -----------------------------------------------------------------------------------------------

    def seal(
        self,
        kernel: PdfKernel,
        plan: SealPlan,
        prepared: bytes,
        handoff: PdfSigningHandoff,
        *,
        open_: Callable[[], bool],
    ) -> Sealed:
        """Sign `handoff` with the plan's signer, ask the token, and have the program embed both into `prepared`.

        `open_` is the stop gate, asked before the key is used: a closed gate is `PdfUnavailableError` (the service
        answers `Unavailable` 503, as for every call after the owner's stop) and nothing is signed.
        """
        signer = plan.signer
        certificates = signer.certificates()
        if not certificates:
            raise PdfSignatureError("the signer names no certificate")
        if handoff.signature_algorithm != signer.algorithm:
            logger.error(
                "the program asked for a %s signature and the signer signs %s",
                handoff.signature_algorithm,
                signer.algorithm,
            )
            raise PdfSignatureError("the program's handoff names another algorithm than the signer's")
        _require_handoff_over(prepared, handoff)
        if not open_():
            raise PdfUnavailableError("the PDF service has stopped; nothing was signed")
        try:
            answered = signer.sign(handoff.to_be_signed)
        except DatumError:
            raise  # a signer that answers in Datum's own terms (unavailable, refused) keeps that answer
        except Exception as error:  # any failure of the application's signer is a seal not made
            # the type only, no traceback: a key store's words may name the key; they go to the debug line
            logger.error("the signer raised %s while signing; nothing was embedded", type(error).__name__)  # noqa: TRY400
            logger.debug("the signer's words: %s", error)
            raise PdfSignatureError("the signer could not sign the handoff") from None
        try:
            value = wire_signature_value(answered, algorithm=handoff.signature_algorithm, certificate=certificates[0])
        except ValueError as error:
            logger.error("the signer's value was refused before complete: %s", error)  # noqa: TRY400 - its words suffice
            raise PdfSignatureError("the signer's value has no shape the program takes") from None
        signing: dict[str, JsonValue] = {
            "certificates": [b64(der) for der in certificates],
            **plan.settings,
            "value": b64(value),
            "toBeSignedDigest": b64(handoff.to_be_signed_digest),
        }
        warnings: list[HookProblem] = []
        token = self._token(value, plan, warnings)
        if token is not None:
            signing["timestamp"] = {"token": b64(token)}
        completed = kernel.complete({"pdf": {"data": b64(prepared)}, "signing": signing})
        return Sealed(
            pdf=completed.pdf,
            field_name=completed.field_name,
            signed_by=signer_name(certificates[0]),
            timestamped=completed.timestamped,
            warnings=tuple(warnings),
        )

    def _token(self, value: bytes, plan: SealPlan, warnings: list[HookProblem]) -> bytes | None:
        """Ask a token over SHA-256 of the value (channel `seal`); a refusal is the `sealing.timestamp` warning."""
        if not plan.timestamp_wanted:
            return None
        timestamper = self._timestamper
        if not plan.timestamp or timestamper is None:
            warnings.append(HookProblem(None, _TIMESTAMP_CODE, _NO_TIMESTAMPER))
            return None
        try:
            grant = timestamper.request(hashlib.sha256(value).digest(), "sha256", cert_req=True, channel="seal")
        except (TimestampClientError, TimestampRefusedError) as error:
            logger.warning("the seal's timestamp was refused (%s); the PDF carries none", _refusal_word(error))
            warnings.append(HookProblem(None, _TIMESTAMP_CODE, _REFUSED))
            return None
        return bytes(grant.response)


def _require_handoff_over(prepared: bytes, handoff: PdfSigningHandoff) -> None:
    """Raise `PdfSignatureError` unless `handoff` is over `prepared`; asked before the key signs anything.

    `complete` re-derives it all from the bytes, but only after the key has made a value, so the key would otherwise
    sign what the sandboxed program handed out. The byte range is `[0, a, b, c]` with `a < b` and `b + c` the file's
    length (one gap, reaching the end, as `complete` requires); `digest` is the SHA-256 over those ranges;
    `to_be_signed_digest` is the SHA-256 of `to_be_signed`; and `to_be_signed` is DER signed attributes holding
    exactly one `messageDigest` whose one value is that digest. So a program answer shaped otherwise (a bug reachable
    from answer values or a template) cannot make the key sign attributes of anything but the file delivered.
    """
    problem = _handoff_problem(prepared, handoff)
    if problem is not None:
        logger.error("the program's signing handoff was refused before signing: %s", problem)
        raise PdfSignatureError("the program's signing handoff is not over the prepared file")


def _handoff_problem(prepared: bytes, handoff: PdfSigningHandoff) -> str | None:
    offsets: tuple[object, ...] = handoff.byte_range  # a kernel middleware may hand over any shape
    if len(offsets) != _RANGE_LENGTH or not all(type(offset) is int and offset >= 0 for offset in offsets):
        return "the byte range is not four offsets"
    start, gap, resume, tail = handoff.byte_range
    if start != 0 or gap >= resume or resume + tail != len(prepared):
        return "the byte range does not cover the prepared file but for one gap"
    digest = hashlib.sha256(prepared[:gap] + prepared[resume:]).digest()
    if not hmac.compare_digest(digest, handoff.digest):
        return "the digest is not the digest of the prepared file"
    if not hmac.compare_digest(hashlib.sha256(handoff.to_be_signed).digest(), handoff.to_be_signed_digest):
        return "the toBeSignedDigest is not the digest of what it handed out to sign"
    in_attributes = signed_attributes_digest(handoff.to_be_signed)
    if in_attributes is None or not hmac.compare_digest(digest, in_attributes):
        return "the signed attributes it handed out are not over the prepared file"
    return None


def _refusal_word(error: TimestampClientError | TimestampRefusedError) -> str:
    return error.failure if isinstance(error, TimestampRefusedError) else error.reason


def signer_name(certificate: bytes) -> str:
    """Return a certificate's common name, else its RFC 4514 subject (the signer a printed PDF names)."""
    try:
        subject = x509.load_der_x509_certificate(certificate).subject
    except ValueError:
        return _UNNAMED
    names = subject.get_attributes_for_oid(NameOID.COMMON_NAME)
    if names:
        value = names[0].value
        return value if isinstance(value, str) else value.decode("utf-8", "replace")
    return subject.rfc4514_string() or _UNNAMED
