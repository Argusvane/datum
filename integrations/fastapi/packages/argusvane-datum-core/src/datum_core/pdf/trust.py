"""The PDF trust policy: where a signer's chain stands, in the catalog's five words.

`PdfTrustPolicy` is a frozen record of the anchors, the optional revocation checker, the archived CRLs and OCSP
responses handed to it, the judging time (`NOW` or `SIGNING_TIME`) and the server's own certificates
(`site_certificates`, and the replaced ones in `retired_certificates`). `judge` answers a `PdfTrustVerdict` for a
signer's chain:

- `site` when the leaf is, byte for byte, one of the server's own certificates; `site_retired` for a replaced one (an
  expired retired certificate included: it was the server's when it signed). Neither consults the revocation checker.
- `trusted`, with the instant the chain was judged at, when a path builds from the leaf to an anchor at that instant
  (and, with a checker, its status there is `good`).
- `self_signed` for a self-issued leaf that builds no path; `unknown` for everything else (no path, an unreadable
  chain, a status that is `revoked` or `unknown`, a checker that raises or answers another word).

The judging instant is `now`, except under `SIGNING_TIME` when the caller hands a `proven_time`: the time a timestamp
token proves that was verified whole and whose authority is this server's or trusted (`judge_authority`, which always
judges now). A `proven_time` later than `now` is not usable: the chain is judged at `now` and the verdict's `reason`
says so. The signature's own `/M` time is not an input. The revocation check moves back with the instant, so a
chain judged in the past reads `unknown` unless the checker holds the status of that time (the archived CRLs and OCSP
responses go with each call).

Paths are built by `cryptography.x509.verification.PolicyBuilder` (`store`, `time`, `extension_policies`): the WebPKI
defaults with Datum's own extended key usage rules, because the defaults ask a client certificate for clientAuth and a
subject alternative name, which a document signer or a timestamp authority does not carry. A document signer's leaf
carries documentSigning, emailProtection or no extended key usage; a timestamp authority's leaf meets
`TsaCertificateRules` (RFC 3161 section 2.3) and carries timeStamping. A document signer's leaf that has a KeyUsage
must carry digitalSignature or contentCommitment. A CA certificate that restricts its extended key usage must allow the
leaf's. A path that is only an anchor reads `unknown` when revocation is asked: nothing was looked up. Nothing is
fetched: no AIA chase, no CRL, no OCSP request (the checker is offline too).

Built on: `cryptography.x509.verification` builds and checks the path (validity, signatures, basic constraints,
key usage, name chaining, critical extensions) and is the path builder used here; pyhanko-certvalidator would do it too
but is the optional extra and only the revocation adapter's. No library speaks the five words, the site comparison, the
signing-time rule or the policy summary, so those are written here; the record is a frozen dataclass (the standard
library).
"""

import asyncio
import dataclasses
import datetime as dt
from collections.abc import Callable, Sequence
from dataclasses import dataclass, field
from typing import Final, Self, cast

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import serialization
from cryptography.x509 import ocsp
from cryptography.x509.oid import ExtendedKeyUsageOID
from cryptography.x509.verification import Criticality, ExtensionPolicy, Policy, PolicyBuilder, Store, VerificationError

from datum_core.config.models import Signing
from datum_core.pdf.protocols import PdfTrustVerdict, PdfValidationTime, RevocationChecker
from datum_core.timestamp.certificate import TsaCertificateRules, read_retired_certificates

__all__ = ["DOCUMENT_SIGNING", "PdfTrustPolicy", "PdfTrustPolicySummary"]

DOCUMENT_SIGNING: Final = x509.ObjectIdentifier("1.3.6.1.5.5.7.3.36")
"""id-kp-documentSigning (RFC 9336)."""
TRUST_ANCHORS_SETTING: Final = "datum.pdf.signing.trust_anchors"
RETIRED_SETTING: Final = "datum.pdf.signing.retired_certificates"

_DOCUMENT_USAGES: Final = frozenset({DOCUMENT_SIGNING, ExtendedKeyUsageOID.EMAIL_PROTECTION})
_AUTHORITY_USAGES: Final = frozenset({ExtendedKeyUsageOID.TIME_STAMPING})
_DER: Final = serialization.Encoding.DER
_TSA_RULES: Final = TsaCertificateRules()
_PATH_WITH_AN_ISSUER: Final = 2  # a leaf and the anchor that issued it: the shortest path with a status to look up


@dataclass(frozen=True, slots=True)
class PdfTrustPolicySummary:
    """What a verify report says of the policy (`trustPolicy`).

    Its name, whether revocation is checked, and when chains are judged (`now` or `signing-time`).
    """

    name: str
    revocation_checking: bool
    validation_time: str


@dataclass(frozen=True, slots=True)
class PdfTrustPolicy:
    """Where a signer's chain stands: the anchors, revocation, archived status, the judging time, the site's own keys.

    Every certificate, CRL and OCSP response is DER. `archived_crls` and `archived_ocsp` (possibly none) are handed to
    the checker on every call, by the keywords `crls=` and `ocsps=`, as the `RevocationChecker` protocol says; archived
    data with no `revocation` checker is refused here. `name` is what the verify report and the event call the policy. A
    field that cannot be read is a `ValueError` here, at construction, never a verdict later.
    """

    anchors: tuple[bytes, ...] = field(repr=False)
    revocation: RevocationChecker | None = None
    archived_crls: tuple[bytes, ...] = field(default=(), repr=False)
    archived_ocsp: tuple[bytes, ...] = field(default=(), repr=False)
    validation_time: PdfValidationTime = PdfValidationTime.NOW
    site_certificates: tuple[bytes, ...] = field(default=(), repr=False)
    retired_certificates: tuple[bytes, ...] = field(default=(), repr=False)
    name: str = "default"

    def __post_init__(self) -> None:
        """Keep the DER as tuples of bytes, and refuse what cannot be read or used."""
        for name in ("anchors", "archived_crls", "archived_ocsp", "site_certificates", "retired_certificates"):
            object.__setattr__(self, name, tuple(bytes(item) for item in getattr(self, name)))
        for name in ("anchors", "site_certificates", "retired_certificates"):
            for index, item in enumerate(cast("tuple[bytes, ...]", getattr(self, name))):
                if _certificate(item) is None:
                    raise ValueError(f"{name}[{index}] is not a DER certificate")
        for index, item in enumerate(self.archived_crls):
            if not _reads(x509.load_der_x509_crl, item):
                raise ValueError(f"archived_crls[{index}] is not a DER CRL")
        for index, item in enumerate(self.archived_ocsp):
            if not _reads(ocsp.load_der_ocsp_response, item):
                raise ValueError(f"archived_ocsp[{index}] is not a DER OCSP response")
        object.__setattr__(self, "validation_time", PdfValidationTime(self.validation_time))  # "now" reads as NOW
        if (self.archived_crls or self.archived_ocsp) and self.revocation is None:
            raise ValueError("archived CRLs and OCSP responses need a revocation checker to read them")

    @classmethod
    def standard(cls, signing: Signing, *, site_certificates: Sequence[bytes] = ()) -> Self:
        """Return the default policy: `datum.pdf.signing.trust_anchors`, no revocation, every chain judged now.

        `site_certificates` are the server's own (its signer's leaf, its timestamp authority's); the replaced ones come
        from `datum.pdf.signing.retired_certificates`. A location that cannot be read is a `DatumConfigurationError`
        naming its setting.
        """
        anchors = read_retired_certificates(signing.trust_anchors, setting=TRUST_ANCHORS_SETTING)
        retired = read_retired_certificates(signing.retired_certificates, setting=RETIRED_SETTING)
        return cls(anchors=anchors, site_certificates=tuple(site_certificates), retired_certificates=retired)

    def summary(self) -> PdfTrustPolicySummary:
        """Return the policy as the verify report names it."""
        return PdfTrustPolicySummary(self.name, self.revocation is not None, self.validation_time.value)

    def judge(
        self, chain: Sequence[bytes], *, now: dt.datetime, proven_time: dt.datetime | None = None
    ) -> PdfTrustVerdict:
        """Return the trust word of a signer's DER `chain` (leaf first, the issuers after, in any order).

        `now` is the verifying instant; `proven_time` the instant a whole-verified token from this server or a trusted
        authority proves, which only a `SIGNING_TIME` policy judges at. Both are timezone-aware (`ValueError`).
        """
        _require_aware(now, "now")
        if proven_time is not None:
            _require_aware(proven_time, "proven_time")
        moment, reason = now, None
        if proven_time is not None and self.validation_time is PdfValidationTime.SIGNING_TIME:
            if proven_time > now:  # a token cannot prove a time that has not come: judge now, and say so
                reason = "the proven time is later than now, so the chain was judged at now"
            else:
                moment = proven_time
        verdict = self._judge(tuple(bytes(item) for item in chain), moment, authority=False)
        return dataclasses.replace(verdict, reason=reason) if reason is not None else verdict

    def judge_authority(self, chain: Sequence[bytes], *, now: dt.datetime) -> PdfTrustVerdict:
        """Return the trust word of a timestamp authority's DER `chain`, always judged at `now` (timezone-aware).

        The leaf must meet `TsaCertificateRules` and carry timeStamping; the site words apply as for a signer.
        """
        _require_aware(now, "now")
        return self._judge(tuple(bytes(item) for item in chain), now, authority=True)

    # -- the steps --

    def _judge(self, chain: tuple[bytes, ...], moment: dt.datetime, *, authority: bool) -> PdfTrustVerdict:
        if chain and chain[0] in self.site_certificates:
            return PdfTrustVerdict("site")
        if chain and chain[0] in self.retired_certificates:
            return PdfTrustVerdict("site_retired")
        return self._path_word(chain, moment, authority=authority)

    def _path_word(self, chain: tuple[bytes, ...], moment: dt.datetime, *, authority: bool) -> PdfTrustVerdict:
        parsed = _certificates(chain)
        if parsed is None or (authority and _TSA_RULES.problems(chain[0])):
            return PdfTrustVerdict("unknown")
        path = self._path(parsed[0], parsed[1:], moment, authority=authority)
        if path is None:
            return PdfTrustVerdict("self_signed" if _self_signed(parsed[0]) else "unknown")
        if self.revocation is not None and (
            len(path) < _PATH_WITH_AN_ISSUER or not self._good(self.revocation, path, moment)
        ):
            # a path that is only an anchor has no issuer to hold a status: nothing was looked up, never good
            return PdfTrustVerdict("unknown")
        return PdfTrustVerdict("trusted", moment)

    def _path(
        self, leaf: x509.Certificate, others: list[x509.Certificate], moment: dt.datetime, *, authority: bool
    ) -> tuple[bytes, ...] | None:
        if not self.anchors:
            return None
        store = Store([x509.load_der_x509_certificate(item) for item in self.anchors])
        ca_policy, ee_policy = _AUTHORITY_POLICIES if authority else _DOCUMENT_POLICIES
        verifier = (
            PolicyBuilder()
            .store(store)
            .time(moment)
            .extension_policies(ca_policy=ca_policy, ee_policy=ee_policy)
            .build_client_verifier()
        )
        try:
            verified = verifier.verify(leaf, others)
        except VerificationError:
            return None
        if not authority and not _may_sign_documents(leaf):  # a built path to a key that may not sign is no path
            return None
        return tuple(item.public_bytes(_DER) for item in verified.chain)

    def _good(self, checker: RevocationChecker, path: tuple[bytes, ...], moment: dt.datetime) -> bool:
        """Whether the checker answers exactly `good` for the built path at the moment (anything else is unknown)."""
        try:
            answer = checker.status(path, moment, crls=self.archived_crls, ocsps=self.archived_ocsp)
        except (Exception, asyncio.CancelledError):  # a checker that raises did not learn the status: never trusted
            return False
        return _is_good(answer)


# -- the extension policies --


def _ee_policy(usages: frozenset[x509.ObjectIdentifier], *, required: bool) -> ExtensionPolicy:
    """Build the WebPKI end-entity rules with Datum's extended key usage and no subject alternative name asked."""

    def check(_policy: Policy, _certificate: x509.Certificate, usage: x509.ExtendedKeyUsage | None) -> None:
        if usage is None:
            if required:
                raise ValueError("the leaf names no extended key usage")
            return
        if not usages.intersection(usage):
            raise ValueError("the leaf's extended key usage is not one this signer may have")

    policy = ExtensionPolicy.webpki_defaults_ee().may_be_present(
        x509.SubjectAlternativeName, Criticality.AGNOSTIC, None
    )
    if required:
        return policy.require_present(x509.ExtendedKeyUsage, Criticality.AGNOSTIC, check)
    return policy.may_be_present(x509.ExtendedKeyUsage, Criticality.AGNOSTIC, check)


def _ca_policy(usages: frozenset[x509.ObjectIdentifier]) -> ExtensionPolicy:
    """Build the WebPKI CA rules, where a CA that restricts its extended key usage must allow the leaf's."""
    allowed = usages | {ExtendedKeyUsageOID.ANY_EXTENDED_KEY_USAGE}

    def check(_policy: Policy, _certificate: x509.Certificate, usage: x509.ExtendedKeyUsage | None) -> None:
        if usage is not None and not allowed.intersection(usage):
            raise ValueError("the CA's extended key usage does not allow the leaf's")

    return ExtensionPolicy.webpki_defaults_ca().may_be_present(x509.ExtendedKeyUsage, Criticality.AGNOSTIC, check)


_DOCUMENT_POLICIES: Final = (_ca_policy(_DOCUMENT_USAGES), _ee_policy(_DOCUMENT_USAGES, required=False))
_AUTHORITY_POLICIES: Final = (_ca_policy(_AUTHORITY_USAGES), _ee_policy(_AUTHORITY_USAGES, required=True))


# -- small readers --


def _require_aware(moment: dt.datetime, name: str) -> None:
    if moment.tzinfo is None or moment.utcoffset() is None:
        raise ValueError(f"{name} must be timezone-aware")


def _may_sign_documents(leaf: x509.Certificate) -> bool:
    """Whether the leaf's KeyUsage, when it has one, allows signing (digitalSignature or contentCommitment)."""
    try:
        usage = leaf.extensions.get_extension_for_class(x509.KeyUsage).value
    except x509.ExtensionNotFound:
        return True
    return usage.digital_signature or usage.content_commitment


def _is_good(answer: object) -> bool:
    return type(answer) is str and answer == "good"


def _certificates(chain: tuple[bytes, ...]) -> list[x509.Certificate] | None:
    """Return the parsed chain, or None for an empty one or one holding anything that is not a DER certificate."""
    parsed = [_certificate(item) for item in chain]
    if not parsed:
        return None
    readable = [item for item in parsed if item is not None]
    return readable if len(readable) == len(parsed) else None


def _certificate(der: bytes) -> x509.Certificate | None:
    try:
        return x509.load_der_x509_certificate(der)
    except ValueError:
        return None


def _reads(loader: Callable[[bytes], object], der: bytes) -> bool:
    try:
        loader(der)
    except ValueError:
        return False
    return True


def _self_signed(certificate: x509.Certificate) -> bool:
    """Whether the certificate names itself as issuer and its signature verifies under its own key."""
    if certificate.issuer != certificate.subject:
        return False
    try:
        certificate.verify_directly_issued_by(certificate)
    except (ValueError, TypeError, InvalidSignature, UnsupportedAlgorithm):
        return False
    return True
