"""The one module that touches asn1crypto: the readers, the rejection, the build-once parts and the read-back check.

Everything RFC 3161 and CMS reads goes through asn1crypto (`tsp`, `cms`, `x509`, `core`); signatures are checked with
`cryptography`. The rest of `datum_core.timestamp` sees plain records and bytes from here, never an asn1crypto object.

Cost rule: asn1crypto 1.5.1 treats a header whose last byte is 0x80 as indefinite and re-encodes the whole
element on `dump()`, so an element whose content is exactly 128 octets (`81 80`) costs 30 to 100 times more to dump. So:

- the parts that do not change between tokens (the algorithm identifiers, the ESS attribute naming the certificate,
  the algorithm-protection attribute, the signer identifier, the certificate set, the TSA name) are built ONCE, when the
  authority is made, and kept as bytes (`FixedParts`);
- the variable outer shapes (TSTInfo, the signed-attribute SET, SignerInfo, SignedData, ContentInfo, the reply) are
  written as raw DER by the TLV helpers below around those bytes, so no asn1crypto `dump()` runs while issuing;
- a reader never calls `dump()` on a parsed element: an element's own encoding is rebuilt from its tag and its
  `contents` (`raw_sequence`) or sliced from its parent's content octets (`split_tlvs`).

The sites that can reach 128 octets with a real certificate are ESSCertIDv2, the ESS attribute and the TSA name; the
TSTInfo itself would need a name far longer than any real one before its content is exactly 128 octets (a TSTInfo with
a policy, an imprint, a serial, a time and a TSA name of a few attributes is already longer), so it is not a practical
site; the signed-attribute SET (five attributes) and a certificate (over 200 octets) never are.

`TimeStampRespOpt` exists because stock `tsp.TimeStampResp` makes the token mandatory (asn1crypto issue #286) and
cannot load a rejection; every reply, granted or rejected, is read and every rejection built through it.

OID cost and structural DER: asn1crypto works out an OBJECT IDENTIFIER's dotted form in time
quadratic in its length (a 256,000-octet policy OID took 12.8 s), and it reads BER lengths. So `read_token`,
`read_reply` and `read_certificate` first run one raw, iterative pre-walk over the bytes (and over the TSTInfo inside
the token's eContent) that refuses, before asn1crypto sees anything:

- an OBJECT IDENTIFIER (universal 6, RELATIVE-OID 13, or a GeneralName `registeredID` `[8]`) of more than 64 content
  octets;
- an indefinite length, and a length not in its shortest form (`81 xx` under 128, a leading zero octet);
- nesting deeper than 64 constructed elements, an element running past its parent, and bytes after the element.

A certificate's SubjectKeyIdentifier is read from its own extension's raw bytes, never through
`Certificate.key_identifier` (which reads every extension's OID). What stays accepted is content-level leniency the
readers already take and DER would not: a non-minimal INTEGER (a request's nonce `02 03 00 00 05`, read by value), a
BOOLEAN other than `FF` (a certificate's `critical` written `01`, as the test PKI's BER leaf has it), and a DEFAULT
value written out (an ESSCertIDv2 naming SHA-256). The pre-walk also takes a constructed form of a primitive type: it
descends into any element whose constructed bit is set, whatever its universal type, and measures the OID cap on
primitive OBJECT IDENTIFIERs only, so a constructed OBJECT IDENTIFIER (`26 ..`) is walked as nested elements and is
not capped; what the typed readers that follow make of it is theirs to refuse. The request reader keeps its own bounds
(`read_request`).

Every reader raises its `ValueError` after its `except` block, so no asn1crypto exception (whose words can quote the
input's structure) stays reachable through `__context__`.
"""

import hashlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from datetime import UTC, datetime
from typing import Any, Final, Literal

from asn1crypto import algos as _algos  # type: ignore[import-untyped, unused-ignore]  # pyright: ignore[reportMissingTypeStubs]
from asn1crypto import cms as _cms  # type: ignore[import-untyped, unused-ignore]  # pyright: ignore[reportMissingTypeStubs]
from asn1crypto import core as _core  # type: ignore[import-untyped, unused-ignore]  # pyright: ignore[reportMissingTypeStubs]
from asn1crypto import tsp as _tsp  # type: ignore[import-untyped, unused-ignore]  # pyright: ignore[reportMissingTypeStubs]
from asn1crypto import x509 as _x509  # type: ignore[import-untyped, unused-ignore]  # pyright: ignore[reportMissingTypeStubs]
from cryptography.exceptions import InvalidSignature, UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.asymmetric.types import PublicKeyTypes

__all__ = [
    "DIGESTS",
    "OID_SHA256",
    "OID_SHA384",
    "OID_SHA512",
    "OID_TST_INFO",
    "CertificateFields",
    "EssId",
    "FixedParts",
    "ReplyFields",
    "RequestFields",
    "TimeStampRespOpt",
    "TokenFields",
    "check_issued",
    "fixed_parts",
    "generalized_time",
    "granted_reply",
    "integer",
    "message_imprint",
    "oid",
    "public_key_of",
    "read_certificate",
    "read_reply",
    "read_request",
    "read_token",
    "rejection",
    "require_der",
    "signed_attributes",
    "split_tlvs",
    "tlv",
    "tst_info",
    "verify_signature",
]

# asn1crypto ships no type information: the modules are used as `Any` here, and only here.
algos: Any = _algos
cms: Any = _cms
core: Any = _core
tsp: Any = _tsp
x509: Any = _x509

OID_SIGNED_DATA: Final = "1.2.840.113549.1.7.2"
OID_TST_INFO: Final = "1.2.840.113549.1.9.16.1.4"
OID_CONTENT_TYPE: Final = "1.2.840.113549.1.9.3"
OID_MESSAGE_DIGEST: Final = "1.2.840.113549.1.9.4"
OID_SIGNING_TIME: Final = "1.2.840.113549.1.9.5"
OID_SIGNING_CERTIFICATE: Final = "1.2.840.113549.1.9.16.2.12"
OID_SIGNING_CERTIFICATE_V2: Final = "1.2.840.113549.1.9.16.2.47"
OID_ALGORITHM_PROTECTION: Final = "1.2.840.113549.1.9.52"
OID_SHA1: Final = "1.3.14.3.2.26"
OID_SHA256: Final = "2.16.840.1.101.3.4.2.1"
OID_SHA384: Final = "2.16.840.1.101.3.4.2.2"
OID_SHA512: Final = "2.16.840.1.101.3.4.2.3"
OID_RSA: Final = "1.2.840.113549.1.1.1"
OID_RSA_SHA256: Final = "1.2.840.113549.1.1.11"
OID_RSA_SHA384: Final = "1.2.840.113549.1.1.12"
OID_RSA_SHA512: Final = "1.2.840.113549.1.1.13"
OID_ECDSA_SHA256: Final = "1.2.840.10045.4.3.2"
OID_ECDSA_SHA384: Final = "1.2.840.10045.4.3.3"
OID_ECDSA_SHA512: Final = "1.2.840.10045.4.3.4"

DIGESTS: Final[dict[str, str]] = {OID_SHA256: "sha256", OID_SHA384: "sha384", OID_SHA512: "sha512", OID_SHA1: "sha1"}
"""Digest OIDs a token may name, by hashlib name (SHA-1 only for reading an old ESSCertID)."""

_RSA_SIGNATURES: Final[dict[str, str | None]] = {
    OID_RSA: None,  # the digest is the SignerInfo's digestAlgorithm
    OID_RSA_SHA256: "sha256",
    OID_RSA_SHA384: "sha384",
    OID_RSA_SHA512: "sha512",
}
_ECDSA_SIGNATURES: Final[dict[str, str]] = {
    OID_ECDSA_SHA256: "sha256",
    OID_ECDSA_SHA384: "sha384",
    OID_ECDSA_SHA512: "sha512",
}
_HASHES: Final[dict[str, type[hashes.HashAlgorithm]]] = {
    "sha256": hashes.SHA256,
    "sha384": hashes.SHA384,
    "sha512": hashes.SHA512,
}

_SHORT_FORM: Final = 0x80
_OID_CONTENT_CAP: Final = 64
"""Content octets of an OBJECT IDENTIFIER Datum reads; a 64-character dotted OID needs far fewer."""
_OID_TAGS: Final = frozenset({0x06, 0x0D, 0x88})
"""OBJECT IDENTIFIER, RELATIVE-OID and a GeneralName's `registeredID` (`[8] IMPLICIT OBJECT IDENTIFIER`)."""
_DEPTH_CAP: Final = 64
"""Constructed elements nested inside each other; a token carrying certificates needs about 20."""
_LENGTH_OCTETS_CAP: Final = 4
"""Octets of a long-form length (up to 4 GiB; every input is far smaller)."""
_TAG_OCTETS_CAP: Final = 4
"""Octets of a high tag number."""
_HIGH_TAG: Final = 0x1F
"""The low five bits of an identifier octet that say a high tag number follows."""
_OID_SKI: Final = b"\x06\x03\x55\x1d\x0e"
"""The OBJECT IDENTIFIER TLV of id-ce-subjectKeyIdentifier (2.5.29.14), compared as bytes."""

_FAIL_INFO_NAMES: Final[dict[int, str]] = {
    0: "bad_alg",
    2: "bad_request",
    5: "bad_data_format",
    14: "time_not_available",
    15: "unaccepted_policy",
    16: "unaccepted_extensions",
    25: "system_failure",
}
"""asn1crypto's names of the PKIFailureInfo bits Datum answers with (bit 16 is plural there)."""


class TimeStampRespOpt(core.Sequence):  # type: ignore[misc]  # pyright: ignore[reportUntypedBaseClass]
    """A `TimeStampResp` whose token is optional, so a rejection loads and builds (RFC 3161 section 2.4.2)."""

    _fields = [  # noqa: RUF012 - asn1crypto's own class attribute
        ("status", tsp.PKIStatusInfo),
        ("time_stamp_token", cms.ContentInfo, {"optional": True}),
    ]


# -- the writer --------------------------------------------------------------------------------------------------------


def tlv(tag: int, content: bytes) -> bytes:
    """Return one DER TLV: `tag`, the definite length in its shortest form, `content`."""
    size = len(content)
    if size < _SHORT_FORM:
        return bytes((tag, size)) + content
    length = size.to_bytes((size.bit_length() + 7) // 8, "big")
    return bytes((tag, 0x80 | len(length))) + length + content


def integer(value: int) -> bytes:
    """Return a non-negative INTEGER in its minimal form (a nonce read as `00 00 05` is written `02 01 05`).

    Every INTEGER Datum writes (versions, serials, nonces, accuracy) is non-negative; a negative one is a `ValueError`
    (the length rule below would write -128 as `FF 80`, which is not minimal).
    """
    if value < 0:
        raise ValueError("Datum writes no negative INTEGER")
    return tlv(0x02, value.to_bytes(value.bit_length() // 8 + 1, "big", signed=True))


def oid(dotted: str) -> bytes:
    """Return an OBJECT IDENTIFIER (built by asn1crypto; called for fixed parts only, never per token)."""
    return bytes(core.ObjectIdentifier(dotted).dump())


def _set_of(parts: Iterable[bytes]) -> bytes:
    """Return the content of a DER SET OF: the encodings in ascending order as octet strings (X.690 11.6)."""
    return b"".join(sorted(parts))


def generalized_time(instant: datetime, *, millis: bool) -> bytes:
    """Return a GeneralizedTime in UTC: whole seconds, or with milliseconds (trailing zeros dropped, as DER asks)."""
    utc = instant.astimezone(UTC)
    text = utc.strftime("%Y%m%d%H%M%S")
    if millis:
        fraction = f"{utc.microsecond // 1000:03d}".rstrip("0")
        if fraction:
            text += "." + fraction
    return tlv(0x18, (text + "Z").encode("ascii"))


def _signing_time(instant: datetime) -> bytes:
    """Return the CMS `Time` of `instant`: UTCTime from 1950 to 2049, else GeneralizedTime (RFC 5652 section 11.3)."""
    utc = instant.astimezone(UTC)
    if 1950 <= utc.year <= 2049:  # noqa: PLR2004 - the RFC's own years
        return tlv(0x17, utc.strftime("%y%m%d%H%M%SZ").encode("ascii"))
    return generalized_time(utc, millis=False)


_ALGORITHM_IDS: Final[dict[tuple[str, bool], bytes]] = {}


def _algorithm_id(dotted: str, *, null: bool) -> bytes:
    """Return an AlgorithmIdentifier with NULL or absent parameters (cached: a handful exist)."""
    found = _ALGORITHM_IDS.get((dotted, null))
    if found is None:
        found = tlv(0x30, oid(dotted) + (b"\x05\x00" if null else b""))
        _ALGORITHM_IDS[(dotted, null)] = found
    return found


def message_imprint(algorithm_oid: str, digest: bytes, *, null_parameters: bool) -> bytes:
    """Return a MessageImprint: the hash AlgorithmIdentifier (parameters as the request sent them) and the digest."""
    return tlv(0x30, _algorithm_id(algorithm_oid, null=null_parameters) + tlv(0x04, digest))


def rejection(bit: int, text: str) -> bytes:
    """Return a rejected `TimeStampResp`: PKIStatus 2, one failure bit and `text`, built through TimeStampRespOpt."""
    status = {"status": "rejection", "status_string": [text], "fail_info": {_FAIL_INFO_NAMES[bit]}}
    return bytes(TimeStampRespOpt({"status": status}).dump())


# -- reading -----------------------------------------------------------------------------------------------------------


def _structural_problem(der: bytes) -> str | None:  # noqa: C901, PLR0911, PLR0912, PLR0915 - one pass, one reason each
    """Walk `der` as one DER element without asn1crypto; return what breaks structural DER or the OID cap, or None.

    Iterative (a stack of the open elements' ends), so no nesting reaches Python's recursion limit; linear in the input.
    """
    total = len(der)
    if total == 0:
        return "no element"
    ends = [total]
    at = 0
    top_level = 0
    while ends:
        if at == ends[-1]:
            ends.pop()
            continue
        if len(ends) == 1:
            top_level += 1
            if top_level > 1:
                return "bytes after the element"
        limit = ends[-1]
        if at + 2 > limit:
            return "a truncated element"
        first = der[at]
        at += 1
        tag = first
        if first & _HIGH_TAG == _HIGH_TAG:  # a high tag number: base-128 octets, the first one never 0x80
            count = 0
            while True:
                if at >= limit or count >= _TAG_OCTETS_CAP:
                    return "a tag that is too long"
                octet = der[at]
                if count == 0 and octet == 0x80:  # noqa: PLR2004 - a leading zero group
                    return "a tag number not in its shortest form"
                at += 1
                count += 1
                if not octet & 0x80:
                    break
            tag = -1  # never an OID tag
        if at >= limit:
            return "a truncated element"
        head = der[at]
        at += 1
        if head < _SHORT_FORM:
            size = head
        elif head == _SHORT_FORM:
            return "an indefinite length"
        else:
            count = head & 0x7F
            if count > _LENGTH_OCTETS_CAP or at + count > limit:
                return "a length that is too long"
            octets = der[at : at + count]
            at += count
            if octets[0] == 0:
                return "a length not in its shortest form"
            size = int.from_bytes(octets, "big")
            if size < _SHORT_FORM:
                return "a length not in its shortest form"
        end = at + size
        if end > limit:
            return "an element runs past its parent"
        if first & 0x20:
            if len(ends) > _DEPTH_CAP:
                return "elements nested too deep"
            ends.append(end)
            continue
        if tag in _OID_TAGS and size > _OID_CONTENT_CAP:
            return "an OBJECT IDENTIFIER longer than any Datum reads"
        at = end
    return None


def require_der(der: bytes) -> None:
    """Raise `ValueError` when `der` breaks structural DER or the OID cap: the pre-walk every reader runs first."""
    _require_der(der)


def _require_der(der: bytes) -> None:
    """Raise `ValueError` when `der` breaks structural DER or the OID cap (see the module text)."""
    problem = _structural_problem(der)
    if problem is not None:
        raise ValueError(problem)


def split_tlvs(content: bytes) -> list[bytes]:
    """Split content octets into the exact encodings of their TLVs (definite lengths only; a bad length raises).

    It reads bytes the pre-walk has already passed (or that Datum itself built), never raw input: it takes a one-octet
    tag and checks nothing the pre-walk checks (shortest-form lengths, depth, the OID cap).
    """
    found: list[bytes] = []
    at = 0
    while at < len(content):
        if at + 2 > len(content):
            raise ValueError("a truncated element")
        first = content[at + 1]
        start = at + 2
        if first < _SHORT_FORM:
            size = first
        elif first == _SHORT_FORM:
            raise ValueError("an indefinite length")
        else:
            count = first & 0x7F
            size = int.from_bytes(content[start : start + count], "big")
            start += count
        end = start + size
        if end > len(content):
            raise ValueError("an element runs past its parent")
        found.append(content[at:end])
        at = end
    return found


def _raw(value: Any, tag: int = 0x30) -> bytes:  # noqa: ANN401 - an asn1crypto value
    """Rebuild a parsed element's encoding from `tag` and its content octets, never through `dump()` (the 128 rule)."""
    return tlv(tag, bytes(value.contents))


def _absent(value: Any) -> bool:  # noqa: ANN401 - an asn1crypto value
    return isinstance(value, core.Void)


def _int_of(value: Any) -> int:  # noqa: ANN401 - an asn1crypto INTEGER
    return int.from_bytes(bytes(value.contents), "big", signed=True)


def _dotted(value: Any) -> str | None:  # noqa: ANN401 - an asn1crypto OBJECT IDENTIFIER
    """Return the dotted form, or None when the OID is longer than any Datum reads (computing it would cost)."""
    if len(value.contents) > _OID_CONTENT_CAP:
        return None
    return str(value.dotted)


@dataclass(frozen=True, slots=True)
class RequestFields:
    """A TimeStampReq as read, before Datum's rules: the query module judges these."""

    version: int
    algorithm: str | None
    """The hash algorithm OID, dotted; None when it is longer than any Datum reads."""
    parameters: Literal["absent", "null", "other"]
    imprint: bytes
    policy: str | None
    policy_too_long: bool
    nonce: bytes | None
    """The nonce INTEGER's content octets as sent (a non-minimal form included)."""
    cert_req: bool
    extensions: bool


def read_request(der: bytes) -> RequestFields:
    """Read a TimeStampReq (DER, nothing after it); raise `ValueError` naming no request byte when it is not one.

    Hash parameters other than NULL or absent read as `parameters="other"` when asn1crypto lets them through (for the
    SHA-2 OIDs it refuses them itself, so they read as no request): either way the answer is `badDataFormat`, where
    openssl's own TSA answers `badAlg` ("superfluous message digest parameter"); Datum keeps its own.
    """
    fields: RequestFields | None = None
    try:
        request = tsp.TimeStampReq.load(der, strict=True)
        imprint = request["message_imprint"]
        algorithm = imprint["hash_algorithm"]
        # The AlgorithmIdentifier is read as raw TLVs and none of its children is touched: asn1crypto works out the
        # OID's dotted form itself once parameters follow it, in time quadratic in the OID's length.
        head = split_tlvs(bytes(algorithm.contents))
        if not head or head[0][0] != 0x06 or len(head) > 2:  # noqa: PLR2004 - OID and parameters
            raise ValueError("not an AlgorithmIdentifier")  # noqa: TRY301
        long_oid = len(head[0]) > _OID_CONTENT_CAP + 2
        algorithm_dotted = None if long_oid else str(core.ObjectIdentifier.load(head[0]).dotted)
        if len(head) == 1:
            shape: Literal["absent", "null", "other"] = "absent"
        else:
            shape = "null" if head[1] == b"\x05\x00" else "other"
        policy = request["req_policy"]
        policy_dotted = None if _absent(policy) else _dotted(policy)
        nonce = request["nonce"]
        digest = imprint["hashed_message"].native
        fields = RequestFields(
            version=_int_of(request["version"]),
            algorithm=algorithm_dotted,
            parameters=shape,
            imprint=bytes(digest),
            policy=policy_dotted,
            policy_too_long=not _absent(policy) and policy_dotted is None,
            nonce=None if _absent(nonce) else bytes(nonce.contents),
            cert_req=bool(request["cert_req"].native),
            extensions=not _absent(request["extensions"]),
        )
        nodes: tuple[Any, Any] = (request, imprint)
        for node in nodes:  # an element the structure does not define is refused, never dropped
            declared: Any = node._fields
            if len(node.children) != len(declared):
                raise ValueError("an element the structure does not define")  # noqa: TRY301
    except Exception:  # asn1crypto raises ValueError, TypeError, KeyError and more: none escapes
        fields = None
    if fields is None:
        raise ValueError("not a TimeStampReq")  # after the except block: no asn1crypto error in __context__
    return fields


@dataclass(frozen=True, slots=True)
class CertificateFields:
    """What a token check needs from a certificate: its own bytes, names, serial, validity and public key."""

    der: bytes
    issuer: bytes
    subject: bytes
    serial: int
    not_before: datetime
    not_after: datetime
    spki: bytes
    key_identifier: bytes | None


def read_certificate(der: bytes) -> CertificateFields:
    """Read a certificate; `ValueError` if it is not one.

    Structural DER is required (the pre-walk); content-level BER (a BOOLEAN written `01`) is tolerated, and a carried
    certificate is never re-encoded.
    """
    fields: CertificateFields | None = None
    try:
        _require_der(der)
        certificate = x509.Certificate.load(der, strict=True)
        tbs = certificate["tbs_certificate"]
        validity = tbs["validity"]
        fields = CertificateFields(
            der=der,
            issuer=_raw(tbs["issuer"]),
            subject=_raw(tbs["subject"]),
            serial=_int_of(tbs["serial_number"]),
            not_before=_aware(validity["not_before"].native),
            not_after=_aware(validity["not_after"].native),
            spki=_raw(tbs["subject_public_key_info"]),
            key_identifier=_subject_key_identifier(bytes(tbs.contents)),
        )
    except Exception:  # asn1crypto's exceptions never escape
        fields = None
    if fields is None:
        raise ValueError("not a certificate")  # after the except block: no asn1crypto error in __context__
    return fields


def _subject_key_identifier(tbs_content: bytes) -> bytes | None:
    """Return the SubjectKeyIdentifier from the TBSCertificate's raw content, or None when there is none.

    Read from the bytes (the `[3]` extensions, each extension's OID compared as bytes, the extnValue's OCTET STRING), so
    no extension's OID is ever decoded; two SubjectKeyIdentifier extensions are a `ValueError`.
    """
    found: bytes | None = None
    for part in split_tlvs(tbs_content):
        if part[0] != 0xA3:  # noqa: PLR2004 - [3] EXPLICIT Extensions
            continue
        (extensions,) = _content_tlvs(part)
        for extension in _content_tlvs(extensions):
            children = _content_tlvs(extension)
            if children[0] != _OID_SKI:
                continue
            if found is not None:
                raise ValueError("two SubjectKeyIdentifier extensions")
            value = children[-1]
            if value[0] != 0x04:  # noqa: PLR2004 - extnValue OCTET STRING
                raise ValueError("an extension value is not an OCTET STRING")
            (key_id,) = _content_tlvs(value)
            if key_id[0] != 0x04:  # noqa: PLR2004 - KeyIdentifier OCTET STRING
                raise ValueError("a SubjectKeyIdentifier is not an OCTET STRING")
            found = bytes(_content_of(key_id))
    return found


def _aware(value: object) -> datetime:
    if not isinstance(value, datetime):
        raise TypeError("not a time")
    return value if value.tzinfo is not None else value.replace(tzinfo=UTC)


@dataclass(frozen=True, slots=True)
class EssId:
    """One ESSCertID(v2): the hash algorithm (hashlib name), the certificate hash, the issuer names and serial."""

    hash_algorithm: str
    cert_hash: bytes
    issuers: tuple[bytes, ...]
    serial: int | None


@dataclass(frozen=True, slots=True)
class TokenFields:
    """A timestamp token as read: the TSTInfo fields, the carried certificates and the one SignerInfo."""

    econtent_type: str
    tst_der: bytes
    version: int
    policy: str
    imprint_oid: str
    imprint: bytes
    serial: int
    gen_time: datetime
    accuracy: tuple[int, int, int] | None
    nonce: int | None
    tsa_name: bytes | None
    certificates: tuple[bytes, ...]
    sid_issuer: bytes | None
    sid_serial: int | None
    sid_key_id: bytes | None
    digest_oid: str
    signature_oid: str
    signature: bytes
    signed_attributes: bytes | None
    """The signed attributes as the signature covers them: the SET OF tag and the content as carried."""
    content_type_attribute: str | None
    message_digest_attribute: bytes | None
    ess: tuple[EssId, ...]
    signing_time_attribute: datetime | None = None
    """The signingTime attribute (timezone-aware), when the signer wrote one."""


def read_token(der: bytes) -> TokenFields:
    """Read a timestamp token (a ContentInfo of SignedData over a TSTInfo); `ValueError` when it is not one."""
    fields: TokenFields | None = None
    try:
        fields = _read_token(der)
    except Exception:  # asn1crypto's exceptions never escape
        fields = None
    if fields is None:
        raise ValueError("not a timestamp token")  # after the except block: no asn1crypto error in __context__
    return fields


def _read_token(der: bytes) -> TokenFields:
    _require_der(der)
    content_info = cms.ContentInfo.load(der, strict=True)
    if content_info["content_type"].dotted != OID_SIGNED_DATA:
        raise ValueError("not SignedData")
    signed = content_info["content"]
    encap = signed["encap_content_info"]
    tst_der = bytes(encap["content"].contents)
    _require_der(tst_der)
    tst = tsp.TSTInfo.load(tst_der, strict=True)
    imprint = tst["message_imprint"]
    accuracy = tst["accuracy"]
    tsa = tst["tsa"]
    tsa_name = None
    if not _absent(tsa) and tsa.name == "directory_name":
        tsa_name = _raw(tsa.chosen)
    nonce = tst["nonce"]
    certificates = signed["certificates"]
    carried = () if _absent(certificates) else tuple(split_tlvs(bytes(certificates.contents)))
    signers = signed["signer_infos"]
    if len(signers) != 1:
        raise ValueError("a timestamp token has exactly one signer")
    signer = signers[0]
    sid = signer["sid"]
    sid_issuer = sid_serial = sid_key_id = None
    if sid.name == "issuer_and_serial_number":
        sid_issuer = _raw(sid.chosen["issuer"])
        sid_serial = _int_of(sid.chosen["serial_number"])
    else:
        sid_key_id = bytes(sid.chosen.native)
    attributes = signer["signed_attrs"]
    content_type = digest = signing_time = None
    ess: tuple[EssId, ...] = ()
    signed_attributes = None
    if not _absent(attributes):
        signed_attributes = tlv(0x31, bytes(attributes.contents))
        content_type, digest, signing_time, ess = _read_attributes(attributes)
    return TokenFields(
        econtent_type=str(encap["content_type"].dotted),
        tst_der=tst_der,
        version=_int_of(tst["version"]),
        policy=str(tst["policy"].dotted),
        imprint_oid=str(imprint["hash_algorithm"]["algorithm"].dotted),
        imprint=bytes(imprint["hashed_message"].native),
        serial=_int_of(tst["serial_number"]),
        gen_time=_aware(tst["gen_time"].native),
        accuracy=None if _absent(accuracy) else _accuracy_of(accuracy),
        nonce=None if _absent(nonce) else _int_of(nonce),
        tsa_name=tsa_name,
        certificates=carried,
        sid_issuer=sid_issuer,
        sid_serial=sid_serial,
        sid_key_id=sid_key_id,
        digest_oid=str(signer["digest_algorithm"]["algorithm"].dotted),
        signature_oid=str(signer["signature_algorithm"]["algorithm"].dotted),
        signature=bytes(signer["signature"].native),
        signed_attributes=signed_attributes,
        content_type_attribute=content_type,
        message_digest_attribute=digest,
        ess=ess,
        signing_time_attribute=signing_time,
    )


def _accuracy_of(accuracy: Any) -> tuple[int, int, int]:  # noqa: ANN401 - an asn1crypto Accuracy
    seconds, millis, micros = (accuracy[name] for name in ("seconds", "millis", "micros"))
    return (
        0 if _absent(seconds) else _int_of(seconds),
        0 if _absent(millis) else _int_of(millis),
        0 if _absent(micros) else _int_of(micros),
    )


def _read_attributes(
    attributes: Any,  # noqa: ANN401 - an asn1crypto CMSAttributes
) -> tuple[str | None, bytes | None, datetime | None, tuple[EssId, ...]]:
    content_type = digest = signing_time = None
    ess: list[EssId] = []
    for attribute in attributes:
        kind = attribute["type"].dotted
        values = attribute["values"]
        if len(values) != 1:
            raise ValueError("a signed attribute holds one value")
        value = values[0]
        if kind == OID_CONTENT_TYPE:
            content_type = str(value.dotted)
        elif kind == OID_MESSAGE_DIGEST:
            digest = bytes(value.native)
        elif kind == OID_SIGNING_TIME:
            signing_time = _aware(value.native)
        elif kind == OID_SIGNING_CERTIFICATE_V2:
            ess += [_ess_id(item, v2=True) for item in value["certs"]]
        elif kind == OID_SIGNING_CERTIFICATE and not ess:
            ess += [_ess_id(item, v2=False) for item in value["certs"]]
    return content_type, digest, signing_time, tuple(ess)


def _ess_id(item: Any, *, v2: bool) -> EssId:  # noqa: ANN401 - an asn1crypto ESSCertID(v2)
    algorithm = "sha1"
    if v2:
        found = item["hash_algorithm"]
        algorithm = "sha256" if _absent(found) else DIGESTS.get(str(found["algorithm"].dotted), "unknown")
    issuers: tuple[bytes, ...] = ()
    serial = None
    issuer_serial = item["issuer_serial"]
    if not _absent(issuer_serial):
        issuers = tuple(_raw(name.chosen) for name in issuer_serial["issuer"] if name.name == "directory_name")
        serial = _int_of(issuer_serial["serial_number"])
    return EssId(algorithm, bytes(item["cert_hash"].native), issuers, serial)


@dataclass(frozen=True, slots=True)
class ReplyFields:
    """A TimeStampResp as read: PKIStatus, the status texts, the failure bits and the token's own bytes (if any)."""

    status: int
    texts: tuple[str, ...]
    fail_bits: frozenset[int]
    token: bytes | None


def read_reply(der: bytes) -> ReplyFields:
    """Read a TimeStampResp, a rejection included, through `TimeStampRespOpt`; `ValueError` when it is not one.

    The pre-walk covers the whole reply, the token inside it included (its TSTInfo is walked by `read_token`).
    """
    fields: ReplyFields | None = None
    try:
        _require_der(der)
        reply = TimeStampRespOpt.load(der, strict=True)
        status = reply["status"]
        texts = status["status_string"]
        fail_info = status["fail_info"]
        bits = frozenset[int]() if _absent(fail_info) else _bits_of(bytes(fail_info.contents))
        parts = split_tlvs(bytes(reply.contents))
        fields = ReplyFields(
            status=_int_of(status["status"]),
            texts=() if _absent(texts) else tuple(str(text.native) for text in texts),
            fail_bits=bits,
            token=parts[1] if len(parts) > 1 else None,
        )
    except Exception:  # asn1crypto's exceptions never escape
        fields = None
    if fields is None:
        raise ValueError("not a TimeStampResp")  # after the except block: no asn1crypto error in __context__
    return fields


# -- signatures --------------------------------------------------------------------------------------------------------


def _bits_of(content: bytes) -> frozenset[int]:
    """Return the indexes of the set bits of a BIT STRING's content octets (the first octet counts the unused bits)."""
    if not content:
        raise ValueError("a BIT STRING without its unused-bits octet")
    body = content[1:]
    total = len(body) * 8 - content[0]
    return frozenset(index for index in range(total) if body[index // 8] & (0x80 >> (index % 8)))


def public_key_of(spki: bytes) -> PublicKeyTypes:
    """Load a SubjectPublicKeyInfo (taken from asn1crypto's read, so a BER certificate elsewhere does not matter).

    Raise `ValueError` when the key cannot be loaded (an unknown algorithm included).
    """
    try:
        return serialization.load_der_public_key(spki)
    except (ValueError, UnsupportedAlgorithm):
        raise ValueError("an unusable public key") from None


def verify_signature(
    public_key: PublicKeyTypes, *, signature_oid: str, digest_oid: str, signature: bytes, data: bytes
) -> bool:
    """Say whether `signature` over `data` verifies under `public_key` with the SignerInfo's algorithms."""
    digest_name: str | None
    if signature_oid in _RSA_SIGNATURES:
        digest_name = _RSA_SIGNATURES[signature_oid] or DIGESTS.get(digest_oid)
        algorithm = _HASHES.get(digest_name or "")
        if algorithm is None or not isinstance(public_key, rsa.RSAPublicKey):
            return False
        try:
            public_key.verify(signature, data, padding.PKCS1v15(), algorithm())
        except (InvalidSignature, ValueError):
            return False
        return True
    digest_name = _ECDSA_SIGNATURES.get(signature_oid)
    algorithm = _HASHES.get(digest_name or "")
    if algorithm is None or not isinstance(public_key, ec.EllipticCurvePublicKey):
        return False
    try:
        public_key.verify(signature, data, ec.ECDSA(algorithm()))
    except (InvalidSignature, ValueError):
        return False
    return True


# -- the parts built once ----------------------------------------------------------------------------------------------


@dataclass(frozen=True, slots=True)
class FixedParts:
    """Everything of a token that depends only on the key material, as bytes built once."""

    signer: CertificateFields
    public_key: PublicKeyTypes
    signature_oid: str
    content_type_attribute: bytes
    ess_attribute: bytes
    protection_attribute: bytes
    signer_identifier: bytes
    digest_algorithm: bytes
    signature_algorithm: bytes
    certificate_set: bytes
    """`[0] IMPLICIT SET OF` the chain's certificates, each byte for byte, in DER SET order."""
    tsa: bytes
    """`[0]` GeneralName `[4]` directoryName holding the signer certificate's subject as it is encoded there."""


def fixed_parts(chain: Sequence[bytes], algorithm: Literal["rsa-sha256", "ecdsa-sha256"]) -> FixedParts:
    """Build the parts every token over this chain shares; `ValueError` when the chain cannot sign with `algorithm`."""
    if not chain:
        raise ValueError("the key material carries no certificate")
    signer = read_certificate(chain[0])
    public_key = public_key_of(signer.spki)
    if algorithm == "rsa-sha256":
        if not isinstance(public_key, rsa.RSAPublicKey):
            raise ValueError("the signing certificate does not hold an RSA key")
        signature_oid, null = OID_RSA_SHA256, True  # RFC 8017: NULL parameters
    else:
        if not isinstance(public_key, ec.EllipticCurvePublicKey):
            raise ValueError("the signing certificate does not hold an EC key")
        signature_oid, null = OID_ECDSA_SHA256, False  # RFC 5758: absent parameters
    signature_algorithm = _algorithm_id(signature_oid, null=null)
    digest_algorithm = _algorithm_id(OID_SHA256, null=False)  # RFC 5754: absent parameters
    # ESSCertIDv2 omits hashAlgorithm: SHA-256 is its DEFAULT and DER leaves a default out (RFC 5035).
    issuer_serial = tlv(0x30, tlv(0x30, tlv(0xA4, signer.issuer)) + integer(signer.serial))
    ess_cert_id = tlv(0x30, tlv(0x04, hashlib.sha256(chain[0]).digest()) + issuer_serial)
    signing_certificate = tlv(0x30, tlv(0x30, ess_cert_id))
    protection = bytes(
        cms.CMSAlgorithmProtection(
            {
                "digest_algorithm": algos.DigestAlgorithm.load(digest_algorithm),
                "signature_algorithm": algos.SignedDigestAlgorithm.load(signature_algorithm),
            }
        ).dump()
    )
    return FixedParts(
        signer=signer,
        public_key=public_key,
        signature_oid=signature_oid,
        content_type_attribute=_attribute(OID_CONTENT_TYPE, oid(OID_TST_INFO)),
        ess_attribute=_attribute(OID_SIGNING_CERTIFICATE_V2, signing_certificate),
        protection_attribute=_attribute(OID_ALGORITHM_PROTECTION, protection),
        signer_identifier=tlv(0x30, signer.issuer + integer(signer.serial)),
        digest_algorithm=digest_algorithm,
        signature_algorithm=signature_algorithm,
        certificate_set=tlv(0xA0, _set_of(chain)),
        tsa=tlv(0xA0, tlv(0xA4, signer.subject)),
    )


_OID_MESSAGE_DIGEST_DER: Final = oid(OID_MESSAGE_DIGEST)
_OID_SIGNING_TIME_DER: Final = oid(OID_SIGNING_TIME)
_OID_TST_INFO_DER: Final = oid(OID_TST_INFO)
_OID_SIGNED_DATA_DER: Final = oid(OID_SIGNED_DATA)
_VERSION_1: Final = integer(1)
_VERSION_3: Final = integer(3)
_GRANTED: Final = tlv(0x30, integer(0))


def _attribute(type_oid: str, value: bytes) -> bytes:
    return tlv(0x30, oid(type_oid) + tlv(0x31, value))


# -- the variable shapes, written by hand ------------------------------------------------------------------------------


def tst_info(
    *,
    policy: bytes,
    imprint: bytes,
    serial: int,
    gen_time: datetime,
    accuracy_millis: int,
    nonce: int | None,
    tsa: bytes,
) -> bytes:
    """Return a TSTInfo: version 1, the policy OID, the imprint as sent, the serial, genTime, accuracy, nonce, tsa.

    `accuracy_millis` is the stated accuracy in whole milliseconds (0: none stated); genTime carries milliseconds only
    when it is under one second.
    """
    parts = [_VERSION_1, policy, imprint, integer(serial)]
    parts.append(generalized_time(gen_time, millis=0 < accuracy_millis < 1000))  # noqa: PLR2004 - a second
    if accuracy_millis:
        seconds, millis = divmod(accuracy_millis, 1000)
        stated = (integer(seconds) if seconds else b"") + (tlv(0x80, integer(millis)[2:]) if millis else b"")
        parts.append(tlv(0x30, stated))
    if nonce is not None:
        parts.append(integer(nonce))
    parts.append(tsa)
    return tlv(0x30, b"".join(parts))


def signed_attributes(fixed: FixedParts, *, tst_der: bytes, signing_time: datetime) -> bytes:
    """Return the signed attributes as signed: a DER SET OF (tag 0x31) in DER order."""
    attributes = (
        fixed.content_type_attribute,
        tlv(0x30, _OID_SIGNING_TIME_DER + tlv(0x31, _signing_time(signing_time))),
        tlv(0x30, _OID_MESSAGE_DIGEST_DER + tlv(0x31, tlv(0x04, hashlib.sha256(tst_der).digest()))),
        fixed.ess_attribute,
        fixed.protection_attribute,
    )
    return tlv(0x31, _set_of(attributes))


def granted_reply(
    fixed: FixedParts, *, tst_der: bytes, attributes: bytes, signature: bytes, cert_req: bool
) -> tuple[bytes, bytes]:
    """Return the granted `TimeStampResp` and the token inside it (`SEQ{SEQ{0}, token}`)."""
    signer_info = tlv(
        0x30,
        _VERSION_1
        + fixed.signer_identifier
        + fixed.digest_algorithm
        + b"\xa0"
        + attributes[1:]  # [0] IMPLICIT: the SET OF signed, re-tagged
        + fixed.signature_algorithm
        + tlv(0x04, signature),
    )
    encapsulated = tlv(0x30, _OID_TST_INFO_DER + tlv(0xA0, tlv(0x04, tst_der)))
    signed_data = tlv(
        0x30,
        _VERSION_3
        + tlv(0x31, fixed.digest_algorithm)
        + encapsulated
        + (fixed.certificate_set if cert_req else b"")
        + tlv(0x31, signer_info),
    )
    token = tlv(0x30, _OID_SIGNED_DATA_DER + tlv(0xA0, signed_data))
    return tlv(0x30, _GRANTED + token), token


def _content_of(element: bytes) -> bytes:
    """Return the content octets of one TLV (a one-octet tag, a definite length).

    Like `split_tlvs`, it reads pre-walked bytes only: it trusts the length octets and checks nothing.
    """
    first = element[1]
    return element[2 if first < _SHORT_FORM else 2 + (first & 0x7F) :]


def _content_tlvs(element: bytes) -> list[bytes]:
    """Split the content octets of one TLV into the exact encodings of its children."""
    return split_tlvs(_content_of(element))


# -- the read-back -----------------------------------------------------------------------------------------------------


def check_issued(
    reply: bytes,
    fixed: FixedParts,
    *,
    chain: Sequence[bytes],
    cert_req: bool,
    serial: int,
    policy: str,
    imprint_oid: str,
    imprint: bytes,
    imprint_der: bytes,
    nonce: int | None,
    gen_time: datetime,
    accuracy_millis: int,
) -> None:
    """Read `reply` back as a client would before it leaves; raise `ValueError` naming the first thing that is wrong.

    Checked: PKIStatus granted; SignedData over a TSTInfo; the TSTInfo's version, policy, imprint as sent (byte for
    byte, parameters included), serial, genTime, the accuracy stated (`accuracy_millis`, 0: none) and nonce echoed by
    value; the signingTime attribute is genTime (to the second: a UTCTime has no fraction); the TSA name is the
    certificate's subject; the certificates carried byte for byte only when asked; the signer named by issuer and
    serial; contentType and messageDigest; ESSCertIDv2 over the certificate's own bytes; and the signature, under the
    certificate's own public key.
    """
    read = read_reply(reply)
    if read.status != 0 or read.token is None:
        raise ValueError("the reply is not granted")
    token = read_token(read.token)
    expected_time = gen_time.astimezone(UTC)
    seconds, millis = divmod(accuracy_millis, 1000)
    expected_accuracy = (seconds, millis, 0) if accuracy_millis else None
    checks = (
        (token.econtent_type == OID_TST_INFO, "the content is not a TSTInfo"),
        (token.version == 1, "the TSTInfo is not version 1"),
        (token.policy == policy, "the policy is not the one issued under"),
        (token.imprint_oid == imprint_oid and token.imprint == imprint, "the imprint is not as sent"),
        (_content_tlvs(token.tst_der)[2] == imprint_der, "the imprint is not as sent"),
        (token.serial == serial, "the serial is not the one allocated"),
        (token.gen_time == expected_time, "genTime is not the time read"),
        (token.accuracy == expected_accuracy, "the accuracy is not the one stated"),
        (token.nonce == nonce, "the nonce is not echoed"),
        (token.tsa_name == fixed.signer.subject, "the TSA name is not the certificate's subject"),
        (sorted(token.certificates) == (sorted(chain) if cert_req else []), "the certificates are not as carried"),
        (
            token.sid_issuer == fixed.signer.issuer and token.sid_serial == fixed.signer.serial,
            "the signer is not named by the certificate's issuer and serial",
        ),
        (token.content_type_attribute == OID_TST_INFO, "the contentType attribute is not TSTInfo"),
        (token.signing_time_attribute == expected_time.replace(microsecond=0), "the signingTime is not genTime"),
        (
            token.message_digest_attribute == hashlib.sha256(token.tst_der).digest(),
            "the messageDigest does not cover the TSTInfo",
        ),
        (
            len(token.ess) >= 1
            and token.ess[0].hash_algorithm == "sha256"
            and token.ess[0].cert_hash == hashlib.sha256(chain[0]).digest(),
            "the ESSCertIDv2 does not name the certificate",
        ),
    )
    for holds, problem in checks:
        if not holds:
            raise ValueError(problem)
    if token.signed_attributes is None or not verify_signature(
        fixed.public_key,
        signature_oid=token.signature_oid,
        digest_oid=token.digest_oid,
        signature=token.signature,
        data=token.signed_attributes,
    ):
        raise ValueError("the signature does not verify under the certificate's key")
