"""`TimestampQuery`: a TimeStampReq read and judged by Datum's rules, or built for the client side.

The rules: version 1; the imprint over SHA-256, SHA-384 or SHA-512 (else `badAlg`) with the length that algorithm
gives (else `badDataFormat`); a nonce of at most 64 content octets that is not negative (zero included; a non-minimal
form such as `02 03 00 00 05` is read by value and written back in its shortest form); a policy OID of
at most 64 characters and 16 arcs (else `badRequest`); any request extension `unacceptedExtension`; anything that is
not a TimeStampReq, or has bytes after it, `badDataFormat`. Whether the server issues under the named policy is the
authority's call, not the parser's. A refusal's words are Datum's and echo no request byte.
"""

from dataclasses import dataclass, field
from typing import Final, Self

from datum_core.timestamp import _der
from datum_core.timestamp.protocols import TimestampRefusedError

__all__ = ["ALGORITHMS", "TimestampQuery", "policy_problem"]

ALGORITHMS: Final[dict[str, tuple[str, int]]] = {
    "sha256": (_der.OID_SHA256, 32),
    "sha384": (_der.OID_SHA384, 48),
    "sha512": (_der.OID_SHA512, 64),
}
"""The imprint algorithms taken, by name: the OID and the digest length."""

_BY_OID: Final = {oid: name for name, (oid, _) in ALGORITHMS.items()}
_NONCE_OCTETS: Final = 64
_POLICY_CHARACTERS: Final = 64
_POLICY_ARCS: Final = 16

_MALFORMED: Final = "The request is not a DER TimeStampReq."
_VERSION: Final = "Only version 1 timestamp requests are read."
_ALGORITHM: Final = "The imprint algorithm is not taken: use SHA-256, SHA-384 or SHA-512."
_PARAMETERS: Final = "The imprint algorithm's parameters must be NULL or absent."
_LENGTH: Final = "The imprint's length does not match its algorithm."
_NONCE: Final = "The nonce must be a non-negative integer of at most 64 octets."
_POLICY: Final = "The requested policy is longer than 64 characters or 16 arcs."
_EXTENSION: Final = "This timestamp server accepts no request extensions."


def policy_problem(policy: str) -> str | None:
    """Say what is wrong with a policy OID's text (None: nothing): at most 64 characters and 16 arcs, digits only."""
    arcs = policy.split(".")
    if len(policy) > _POLICY_CHARACTERS or len(arcs) > _POLICY_ARCS:
        return "a policy OID has at most 64 characters and 16 arcs"
    if len(arcs) < 2 or not all(arc.isdecimal() and arc.isascii() for arc in arcs):  # noqa: PLR2004 - two arcs
        return "a policy OID is dotted decimal arcs"
    if int(arcs[0]) > 2 or (int(arcs[0]) < 2 and int(arcs[1]) > 39):  # noqa: PLR2004 - X.660's first two arcs
        return "a policy OID starts with 0, 1 or 2 and a valid second arc"
    return None


@dataclass(frozen=True, slots=True)
class TimestampQuery:
    """A timestamp request that passed the request rules (however it was built: `__post_init__` applies them).

    `imprint_algorithm` is `sha256`, `sha384` or `sha512`; `nonce` is the value (None: none sent); `null_parameters`
    records whether the hash AlgorithmIdentifier carried NULL parameters, so the token echoes the imprint as sent.
    """

    imprint_algorithm: str
    imprint: bytes
    policy: str | None = None
    nonce: int | None = None
    cert_req: bool = False
    null_parameters: bool = field(default=True, kw_only=True)

    def __post_init__(self) -> None:
        """Apply the request rules to however the query was built (a direct call included); raise the refusal."""
        if self.imprint_algorithm not in ALGORITHMS:
            raise TimestampRefusedError("badAlg", _ALGORITHM)
        if len(self.imprint) != ALGORITHMS[self.imprint_algorithm][1]:
            raise TimestampRefusedError("badDataFormat", _LENGTH)
        if self.nonce is not None and (self.nonce < 0 or self.nonce.bit_length() > _NONCE_OCTETS * 8 - 1):
            raise TimestampRefusedError("badDataFormat", _NONCE)
        if self.policy is not None and policy_problem(self.policy) is not None:
            raise TimestampRefusedError("badRequest", _POLICY)

    @classmethod
    def parse(cls, der: bytes) -> Self:
        """Read `der` (a TimeStampReq and nothing after it); raise `TimestampRefusedError` naming the failure."""
        try:
            read = _der.read_request(der)
        except ValueError:
            raise TimestampRefusedError("badDataFormat", _MALFORMED) from None
        if read.version != 1:
            raise TimestampRefusedError("badDataFormat", _VERSION)
        name = _BY_OID.get(read.algorithm or "")
        if name is None:
            raise TimestampRefusedError("badAlg", _ALGORITHM)
        if read.parameters == "other":
            raise TimestampRefusedError("badDataFormat", _PARAMETERS)
        nonce = None
        if read.nonce is not None:
            content = read.nonce
            if not 0 < len(content) <= _NONCE_OCTETS or content[0] & 0x80:
                raise TimestampRefusedError("badDataFormat", _NONCE)
            nonce = int.from_bytes(content, "big")
        if read.policy_too_long:
            raise TimestampRefusedError("badRequest", _POLICY)
        if read.extensions:
            raise TimestampRefusedError("unacceptedExtension", _EXTENSION)
        return cls(
            name,
            read.imprint,
            read.policy,
            nonce,
            read.cert_req,
            null_parameters=read.parameters == "null",
        )

    @classmethod
    def of(
        cls,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        nonce: int | None = None,
        cert_req: bool = True,
    ) -> Self:
        """Build a query over `imprint` (`algorithm`: sha256, sha384 or sha512) by the same rules `parse` applies."""
        return cls(algorithm, bytes(imprint), policy, nonce, cert_req)

    @property
    def imprint_oid(self) -> str:
        """The imprint algorithm's OID, dotted."""
        return ALGORITHMS[self.imprint_algorithm][0]

    def imprint_der(self) -> bytes:
        """Return the MessageImprint as the request sent it (the token repeats it)."""
        return _der.message_imprint(self.imprint_oid, self.imprint, null_parameters=self.null_parameters)

    def to_der(self) -> bytes:
        """Return the request as DER (the nonce in its shortest form; certReq written only when true)."""
        parts = [_der.integer(1), self.imprint_der()]
        if self.policy is not None:
            parts.append(_der.oid(self.policy))
        if self.nonce is not None:
            parts.append(_der.integer(self.nonce))
        if self.cert_req:
            parts.append(_der.tlv(0x01, b"\xff"))
        return _der.tlv(0x30, b"".join(parts))
