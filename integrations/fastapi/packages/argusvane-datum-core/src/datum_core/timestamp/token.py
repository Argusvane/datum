"""`TimestampToken`: a timestamp token read and checked without any PDF code.

`parse` reads a token (a CMS ContentInfo of SignedData over a TSTInfo) or raises `ValueError`. `check()` says whether
the token is intact: the contentType attribute names the TSTInfo, the messageDigest covers it, and the signature
verifies under the signer's certificate (found among the carried certificates and the known ones by issuer AND serial,
or by its key identifier). `verify_over(data)` adds what binds the token to a value and a certificate: the imprint is
the digest of `data`, the ESSCertID(v2) names the signer's own certificate bytes (and its issuer and serial), and
genTime lies inside that certificate's validity. Both answer a tuple of problem codes, empty when there is none:
`imprint`, `signature`, `binding`, `time`. Trust in the certificate (a chain to a root, revocation) is the caller's
policy.
"""

import hashlib
from collections.abc import Iterable, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from typing import Final, Self

from datum_core.timestamp import _der

__all__ = ["PROBLEMS", "TimestampToken"]

PROBLEMS: Final = ("imprint", "signature", "binding", "time")
"""Every problem code, in the order they are reported."""


@dataclass(frozen=True, slots=True)
class TimestampToken:
    """A parsed timestamp token: what the TSTInfo says and the certificates it carries (DER, as carried).

    `imprint_algorithm` is `sha256`, `sha384` or `sha512` (another algorithm's dotted OID otherwise); `accuracy` is in
    seconds (None: none stated); `gen_time` is timezone-aware.
    """

    der: bytes = field(repr=False)
    serial: int
    policy: str
    imprint_algorithm: str
    imprint: bytes
    nonce: int | None
    gen_time: datetime
    accuracy: float | None
    certificates: tuple[bytes, ...] = field(repr=False)
    _fields: _der.TokenFields = field(repr=False, compare=False)

    @classmethod
    def parse(cls, token_der: bytes) -> Self:
        """Read a token; raise `ValueError` when the bytes are not one."""
        fields = _der.read_token(bytes(token_der))
        accuracy = None
        if fields.accuracy is not None:
            seconds, millis, micros = fields.accuracy
            accuracy = seconds + millis / 1_000 + micros / 1_000_000
        return cls(
            der=bytes(token_der),
            serial=fields.serial,
            policy=fields.policy,
            imprint_algorithm=_der.DIGESTS.get(fields.imprint_oid, fields.imprint_oid),
            imprint=fields.imprint,
            nonce=fields.nonce,
            gen_time=fields.gen_time,
            accuracy=accuracy,
            certificates=fields.certificates,
            _fields=fields,
        )

    def check(self, known_certificates: Iterable[bytes] = ()) -> tuple[str, ...]:
        """Return `("signature",)` when the token is not intact under its signer's certificate, else `()`."""
        signer = self._signer(known_certificates)
        return () if self._intact(signer) else ("signature",)

    def verify_over(self, data: bytes, known_certificates: Iterable[bytes] = ()) -> tuple[str, ...]:
        """Return the problems of this token as a timestamp over `data` (`imprint`, `signature`, `binding`, `time`)."""
        algorithm = self.imprint_algorithm if self.imprint_algorithm in {"sha256", "sha384", "sha512"} else None
        digest = hashlib.new(algorithm, data).digest() if algorithm is not None else None
        return self._problems(digest, known_certificates)

    def verify_digest(self, digest: bytes, algorithm: str, known_certificates: Iterable[bytes] = ()) -> tuple[str, ...]:
        """Return the problems of this token as a timestamp over `digest` (`algorithm`'s digest of the value)."""
        same = algorithm in {"sha256", "sha384", "sha512"} and algorithm == self.imprint_algorithm
        return self._problems(digest if same else None, known_certificates)

    def _problems(self, digest: bytes | None, known_certificates: Iterable[bytes]) -> tuple[str, ...]:
        signer = self._signer(known_certificates)
        found: set[str] = set()
        if digest is None or digest != self.imprint:
            found.add("imprint")
        if not self._intact(signer):
            found.add("signature")
        if signer is not None:
            if not self._names(signer):
                found.add("binding")
            if not signer.not_before <= self.gen_time <= signer.not_after:
                found.add("time")
        return tuple(code for code in PROBLEMS if code in found)

    def signer_certificate(self, known: Sequence[bytes] = ()) -> bytes | None:
        """Return the DER of the certificate this token is judged under (carried first, then `known`), or None."""
        found = self._signer(known)
        return None if found is None else found.der

    # -- internals -----------------------------------------------------------------------------------------------------

    def _signer(self, known_certificates: Iterable[bytes]) -> _der.CertificateFields | None:
        """Find the SignerInfo's certificate: carried first, then known; by issuer and serial, or by key identifier."""
        fields = self._fields
        for der in (*fields.certificates, *known_certificates):
            try:
                certificate = _der.read_certificate(bytes(der))
            except ValueError:
                continue
            if fields.sid_serial is not None:
                if certificate.serial == fields.sid_serial and certificate.issuer == fields.sid_issuer:
                    return certificate
            elif fields.sid_key_id is not None and certificate.key_identifier == fields.sid_key_id:
                return certificate
        return None

    def _intact(self, signer: _der.CertificateFields | None) -> bool:
        fields = self._fields
        digest = _der.DIGESTS.get(fields.digest_oid)
        if (
            signer is None
            or fields.signed_attributes is None
            or digest is None
            or digest == "sha1"
            or fields.econtent_type != _der.OID_TST_INFO
            or fields.content_type_attribute != _der.OID_TST_INFO
            or fields.message_digest_attribute != hashlib.new(digest, fields.tst_der).digest()
        ):
            return False
        try:
            public_key = _der.public_key_of(signer.spki)
        except ValueError:
            return False
        return _der.verify_signature(
            public_key,
            signature_oid=fields.signature_oid,
            digest_oid=fields.digest_oid,
            signature=fields.signature,
            data=fields.signed_attributes,
        )

    def _names(self, signer: _der.CertificateFields) -> bool:
        """Whether the first ESSCertID(v2) names `signer`: its hash over the certificate's bytes, its issuer, serial."""
        if not self._fields.ess:
            return False
        first = self._fields.ess[0]
        if first.hash_algorithm not in {"sha1", "sha256", "sha384", "sha512"}:
            return False
        if hashlib.new(first.hash_algorithm, signer.der).digest() != first.cert_hash:
            return False
        return first.serial is None or (first.serial == signer.serial and signer.issuer in first.issuers)
