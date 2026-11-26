"""The verify report: values, tokens, trust.

The program is the authority on a file's structure: it reports each signature's byte range, `digestMatches`,
`certificateMatches`, `coversDocument`, the later revisions and whether a certification permits them, the token's
facts, `toBeVerified` and the signer's certificate. It verifies no signature value. This module does what is left, and
fails closed on everything it cannot judge:

- the VALUE of every signature (`toBeVerified` under the signer's key, RSA PKCS#1 v1.5 or ECDSA over SHA-256, SHA-384
  or SHA-512, with `cryptography`): `valid`, `invalid`, or `unchecked` when the report names no signer, an algorithm
  outside that list, no `publicKey` or one that is not the certificate's (strict base64), or bytes that do not decode;
- `intact`: the value is valid, the digest and the binding hold, and either nothing follows the signature or the
  program says the changes that follow are permitted (`permitted` the boolean true) and every signature they rely on
  (matched by field AND byte range) is itself intact; a missing or unreadable list of them is not intact;
- the token: `timestamped` only when every fact the program reports holds
  (`coversSignature`, `messageDigestMatches`, `certificateMatches`, `contentTypeMatches`) AND
  `TimestampToken.verify_over(value, known)` finds nothing, the certificate the program names as the token's signer is
  the one that check found, and the signature itself is intact (a token over a broken signature proves nothing); any
  disagreement reads not timestamped, with a warning;
- trust, through the `PdfTrustPolicy`, for an intact signature only (one that is not intact vouches for no one and
  reads `unknown`); under `SIGNING_TIME` a token moves the judging instant only when it is timestamped and its
  authority reads `site` or `trusted` now. The policy's `reason` (a proven time later than now was not used) rides in
  the verdict as `trust_reason`. The signature's own `/M` is reported, never used. `known_certificates` is the set the
  program was given (capped at 64 certificates of 16 KiB), so the host finds no signer the program could not.

Libraries: `cryptography` verifies the values (no other library is a dependency of the `pdf` extra);
`datum_core.timestamp.TimestampToken` checks a token without PDF code; `datum_core.pdf.trust.PdfTrustPolicy` builds
paths. pyHanko validates whole PDFs but is a test-scope cross-check only and would parse the file the
program already read. The report records are frozen slotted dataclasses (the catalog's `PdfVerifyReport` and
`PdfSignatureVerdict` shapes); nothing standard models them.
"""

import base64
import binascii
import hashlib
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime
from typing import Final, Literal, cast

from cryptography import x509
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa

from datum_core.pdf.protocols import PdfTrustVerdict, PdfTrustWord, PdfValidationTime, PdfValueVerdict
from datum_core.pdf.trust import PdfTrustPolicy, PdfTrustPolicySummary
from datum_core.timestamp.token import TimestampToken
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import PdfVerified

__all__ = ["PdfVerifyReport", "SignatureVerdict", "assemble_report"]

_RSA_HASHES: Final[Mapping[str, type[hashes.HashAlgorithm]]] = {
    "1.2.840.113549.1.1.11": hashes.SHA256,  # sha256WithRSAEncryption
    "1.2.840.113549.1.1.12": hashes.SHA384,
    "1.2.840.113549.1.1.13": hashes.SHA512,
}
_ECDSA_HASHES: Final[Mapping[str, type[hashes.HashAlgorithm]]] = {
    "1.2.840.10045.4.3.2": hashes.SHA256,  # ecdsa-with-SHA256
    "1.2.840.10045.4.3.3": hashes.SHA384,
    "1.2.840.10045.4.3.4": hashes.SHA512,
}
_TOKEN_FACTS: Final = ("coversSignature", "messageDigestMatches", "certificateMatches", "contentTypeMatches")
_PROVING_WORDS: Final[frozenset[PdfTrustWord]] = frozenset({"site", "trusted"})
_BYTE_RANGE_LENGTH: Final = 4
_UNKNOWN: Final = PdfTrustVerdict("unknown")


@dataclass(frozen=True, slots=True)
class SignatureVerdict:
    """One signature, checked and placed (the catalog's `PdfSignatureVerdict`).

    `value`, `intact`, `trust` and `trusted_at` are the host's; `digest_matches`, `certificate_matches` and
    `covers_document` the program's facts as reported (a missing or non-boolean fact reads false). `signing_time` is
    the signed revision's `/M`, the signer's own claim, never used. `timestamped` and `timestamp_time` (the token's
    genTime) are set only for a token both the program and the host accept, and only on an intact signature.
    `trust_reason` is the policy's note when the chain was not judged as asked (a proven time later than now was not
    used); None otherwise. It is the report's own member: no event carries it.
    """

    field: str
    value: PdfValueVerdict
    digest_matches: bool
    certificate_matches: bool
    covers_document: bool
    intact: bool
    trust: PdfTrustWord
    trusted_at: datetime | None = None
    signing_time: str | None = None
    timestamped: bool = False
    timestamp_time: datetime | None = None
    trust_reason: str | None = None


@dataclass(frozen=True, slots=True)
class PdfVerifyReport:
    """What `PdfService.verify` reports of a file (the catalog's `PdfVerifyReport`); never the file itself.

    `sha256` (lowercase hex) and `size` name the file. `document_id` is the `signedDocumentId` of the first intact
    signature that carries one (`document_id_source` `signed`), else the file's current claim (`current`), else None.
    `warnings` are the program's messages, then the host's (a timestamp not counted). `trust_policy` summarises the
    policy the signers were placed under.
    """

    sha256: str
    size: int
    signatures: tuple[SignatureVerdict, ...]
    document_id: str | None
    document_id_source: Literal["signed", "current"] | None
    warnings: tuple[str, ...]
    trust_policy: PdfTrustPolicySummary


@dataclass(frozen=True, slots=True)
class _Facts:
    """What one report says before the relied-on signatures are followed."""

    field: str
    byte_range: tuple[int, ...] | None
    value: PdfValueVerdict
    digest_matches: bool
    certificate_matches: bool
    covers_document: bool


@dataclass(frozen=True, slots=True)
class _Stamp:
    """A token both sides accepted: its time and the authority's chain (leaf first)."""

    gen_time: datetime
    chain: tuple[bytes, ...]


def assemble_report(
    data: bytes,
    verified: PdfVerified,
    *,
    policy: PdfTrustPolicy,
    now: datetime,
    known_certificates: Sequence[bytes] = (),
) -> PdfVerifyReport:
    """Return the report of `data` from the program's `verified` answer, judged at `now` under `policy`.

    `known_certificates` are the DER certificates the program was given (knowing is not trusting): a token's signer is
    looked for among them as well as among the ones it carries.
    """
    reports = tuple(verified.signatures)
    facts = tuple(_facts_of(report) for report in reports)
    intact = _intact_all(reports, facts)
    warnings: list[str] = [warning.message for warning in verified.warnings]
    verdicts: list[SignatureVerdict] = []
    known = tuple(known_certificates)
    for report, fact, whole in zip(reports, facts, intact, strict=True):
        # a token over a broken signature proves nothing: only an intact signature is looked at
        stamp, problem = _stamp_of(report, known) if whole else (None, None)
        if problem is not None:
            warnings.append(f"The timestamp of the signature {fact.field or '(unnamed)'} is not counted: {problem}.")
        trust = _trust_of(report, policy, now, stamp) if whole else _UNKNOWN
        signing_time = report.get("signingTime")
        verdicts.append(
            SignatureVerdict(
                field=fact.field,
                value=fact.value,
                digest_matches=fact.digest_matches,
                certificate_matches=fact.certificate_matches,
                covers_document=fact.covers_document,
                intact=whole,
                trust=trust.word,
                trusted_at=trust.trusted_at,
                signing_time=signing_time if isinstance(signing_time, str) else None,
                timestamped=stamp is not None,
                timestamp_time=stamp.gen_time if stamp is not None else None,
                trust_reason=trust.reason,
            )
        )
    document_id, source = _document_id(reports, intact, verified.document_id)
    return PdfVerifyReport(
        sha256=hashlib.sha256(data).hexdigest(),
        size=len(data),
        signatures=tuple(verdicts),
        document_id=document_id,
        document_id_source=source,
        warnings=tuple(warnings),
        trust_policy=policy.summary(),
    )


# -- the value ---------------------------------------------------------------------------------------------------------


def _decoded(value: object) -> bytes | None:
    """Return the bytes of a non-empty strict base64 text, else None."""
    if not isinstance(value, str) or not value:
        return None
    try:
        data = base64.b64decode(value, validate=True)
    except (binascii.Error, ValueError):
        return None
    return data or None


def _flag(report: Mapping[str, JsonValue], key: str) -> bool:
    return report.get(key) is True


def _byte_range(value: object) -> tuple[int, ...] | None:
    if not isinstance(value, list) or len(cast("list[object]", value)) != _BYTE_RANGE_LENGTH:
        return None
    items = cast("list[object]", value)
    if not all(isinstance(item, int) and not isinstance(item, bool) for item in items):
        return None
    return tuple(cast("list[int]", items))


def _facts_of(report: Mapping[str, JsonValue]) -> _Facts:
    name = report.get("field")
    return _Facts(
        field=name if isinstance(name, str) else "",
        byte_range=_byte_range(report.get("byteRange")),
        value=_value_of(report),
        digest_matches=_flag(report, "digestMatches"),
        certificate_matches=_flag(report, "certificateMatches"),
        covers_document=_flag(report, "coversDocument"),
    )


def _value_of(report: Mapping[str, JsonValue]) -> PdfValueVerdict:  # noqa: PLR0911 - one answer per refusal
    """Check `toBeVerified` under the key of the signer's certificate; `unchecked` when it cannot be checked."""
    signer = report.get("signer")
    algorithm = report.get("signatureAlgorithm")
    if not isinstance(signer, dict) or not isinstance(algorithm, str):
        return "unchecked"
    rsa_hash, ec_hash = _RSA_HASHES.get(algorithm), _ECDSA_HASHES.get(algorithm)
    certificate = _decoded(signer.get("certificate"))
    to_be_verified = _decoded(report.get("toBeVerified"))
    value = _decoded(report.get("signature"))
    if (rsa_hash is None and ec_hash is None) or certificate is None or to_be_verified is None or value is None:
        return "unchecked"
    try:
        key = x509.load_der_x509_certificate(certificate).public_key()
        spki = key.public_bytes(serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return "unchecked"
    # `publicKey` is required by the ABI: a missing or unreadable one, or one that is not the certificate's, leaves no
    # one key to check under
    if _decoded(signer.get("publicKey")) != spki:
        return "unchecked"
    try:
        if rsa_hash is not None and isinstance(key, rsa.RSAPublicKey):
            key.verify(value, to_be_verified, padding.PKCS1v15(), rsa_hash())
        elif ec_hash is not None and isinstance(key, ec.EllipticCurvePublicKey):
            key.verify(value, to_be_verified, ec.ECDSA(ec_hash()))
        else:
            return "unchecked"  # an RSA algorithm over an EC key, or the reverse
    except InvalidSignature:
        return "invalid"
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return "unchecked"
    return "valid"


# -- intact ------------------------------------------------------------------------------------------------------------


def _intact_all(reports: Sequence[Mapping[str, JsonValue]], facts: Sequence[_Facts]) -> tuple[bool, ...]:
    """Whether each signature holds, each one judged once.

    The relied-on signatures form a graph the file chooses. A depth-first walk keeps every answer it reaches and the
    signatures on its current path: reaching one on the path is a cycle, which reads not intact, and reaching one
    already judged reads its answer. The verdicts are those of following every path (a signature in a cycle, or
    relying on one, is not intact; one two paths reach is not a cycle), in time linear in the signatures and their
    relied-on entries.
    """
    judged: dict[int, bool] = {}
    path: set[int] = set()
    for index in range(len(reports)):
        _intact(index, reports, facts, judged, path)
    return tuple(judged[index] for index in range(len(reports)))


def _intact(
    index: int,
    reports: Sequence[Mapping[str, JsonValue]],
    facts: Sequence[_Facts],
    judged: dict[int, bool],
    path: set[int],
) -> bool:
    """Whether signature `index` holds, following the signatures its permitted later changes rely on."""
    known = judged.get(index)
    if known is not None:
        return known
    path.add(index)
    try:
        whole = _holds(index, reports, facts, judged, path)
    finally:
        path.discard(index)
    judged[index] = whole
    return whole


def _holds(  # noqa: PLR0911 - one answer per refusal
    index: int,
    reports: Sequence[Mapping[str, JsonValue]],
    facts: Sequence[_Facts],
    judged: dict[int, bool],
    path: set[int],
) -> bool:
    fact = facts[index]
    if fact.value != "valid" or not fact.digest_matches or not fact.certificate_matches:
        return False
    if fact.covers_document:
        return True
    later = reports[index].get("laterRevisions")
    if not isinstance(later, dict) or later.get("permitted") is not True:
        return False  # nothing tells what followed, or the certification does not permit it
    relied = later.get("reliedOnSignatures")  # required by the ABI: a missing list is an answer we cannot judge
    if not isinstance(relied, list):
        return False
    for entry in relied:
        if not isinstance(entry, dict):
            return False
        name, byte_range = entry.get("field"), _byte_range(entry.get("byteRange"))
        if not isinstance(name, str) or not name or byte_range is None:
            return False  # an entry the program could not match counts as an invalid signature
        matches = [
            other
            for other, candidate in enumerate(facts)
            if other != index and candidate.field == name and candidate.byte_range == byte_range
        ]
        if not matches or any(other in path for other in matches):
            return False  # unmatched, or a signature on the current path: a cycle
        if not all(_intact(other, reports, facts, judged, path) for other in matches):
            return False
    return True


# -- the token ---------------------------------------------------------------------------------------------------------


def _stamp_of(  # noqa: PLR0911 - one answer per refusal
    report: Mapping[str, JsonValue], known: Sequence[bytes]
) -> tuple[_Stamp | None, str | None]:
    """Return the accepted token, or None with the reason a token present is not counted (None when there is none)."""
    timestamp = report.get("timestamp")
    if timestamp is None:
        return None, None
    if not isinstance(timestamp, dict):
        return None, "the program's report of it is not readable"
    failed = [fact for fact in _TOKEN_FACTS if timestamp.get(fact) is not True]
    if failed:
        return None, f"the program reports {', '.join(failed)} as not holding"
    token_der, value = _decoded(timestamp.get("token")), _decoded(report.get("signature"))
    if token_der is None or value is None:
        return None, "the token or the signature value is missing"
    try:
        token = TimestampToken.parse(token_der)
    except ValueError:
        return None, "the token cannot be read"
    problems = token.verify_over(value, known)
    if problems:
        return None, f"the host's own check finds {', '.join(problems)}"
    signer = timestamp.get("signer")
    leaf = _decoded(signer.get("certificate")) if isinstance(signer, dict) else None
    if leaf is None:
        return None, "the program names no signer for the token"
    if token.signer_certificate(known) != leaf:  # the certificate `verify_over` judged the token under
        return None, "the program's token signer is not the certificate the host's own check found"
    carried = [item for item in map(_decoded, _list(timestamp.get("certificates"))) if item is not None]
    chain = _chain(leaf, [*carried, *token.certificates, *known])
    return _Stamp(token.gen_time, chain), None


def _list(value: object) -> list[object]:
    return cast("list[object]", value) if isinstance(value, list) else []


def _chain(leaf: bytes, others: Sequence[bytes]) -> tuple[bytes, ...]:
    """Return `leaf` then the other certificates, each once."""
    seen = {leaf}
    chain = [leaf]
    for item in others:
        if item not in seen:
            seen.add(item)
            chain.append(item)
    return tuple(chain)


# -- trust -------------------------------------------------------------------------------------------------------------


def _trust_of(
    report: Mapping[str, JsonValue], policy: PdfTrustPolicy, now: datetime, stamp: _Stamp | None
) -> PdfTrustVerdict:
    """Judge the signer's chain (the program's signer certificate, then the carried ones) under `policy`."""
    signer = report.get("signer")
    leaf = _decoded(signer.get("certificate")) if isinstance(signer, dict) else None
    if leaf is None:
        return _UNKNOWN
    carried = [item for item in map(_decoded, _list(report.get("certificates"))) if item is not None]
    proven: datetime | None = None
    if (
        stamp is not None
        and stamp.chain
        and policy.validation_time is PdfValidationTime.SIGNING_TIME
        and policy.judge_authority(stamp.chain, now=now).word in _PROVING_WORDS
    ):
        proven = stamp.gen_time
    return policy.judge(_chain(leaf, carried), now=now, proven_time=proven)


# -- the document id ---------------------------------------------------------------------------------------------------


def _document_id(
    reports: Sequence[Mapping[str, JsonValue]], intact: Sequence[bool], current: str | None
) -> tuple[str | None, Literal["signed", "current"] | None]:
    for report, whole in zip(reports, intact, strict=True):
        signed = report.get("signedDocumentId")
        if whole and isinstance(signed, str) and signed:
            return signed, "signed"
    if current is not None:
        return current, "current"
    return None, None
