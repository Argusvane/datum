"""The PDF signers: the server's seal key and the throwaway test seal.

`KeyFilePdfSigner.from_settings(signing)` reads `datum.pdf.signing.*` ONCE, at start, through the timestamp package's
loader (`load_signing_key`, the one loader both signers call): PKCS#12 (`pkcs12.load_pkcs12`) or a PEM key and chain,
the same refusals as the timestamp key (more than one friendly-named certificate, a `friendly_name` that is not the key
certificate's, a setting the chosen type cannot use, a leaf that is not the key's, a key outside RSA PKCS#1 v1.5 (at
least 2048 bits) and ECDSA P-256/P-384, a negative serial), each naming `datum.pdf.signing` and never a password, a
path's content or a key byte. Unlike a timestamp key, a seal key has no extended-key-usage rule: the kernel signs with
what it is given and the trust policy judges the certificate. A renewed key takes a restart (the replaced certificate
goes in `datum.pdf.signing.retired_certificates`).

`TestSealSigner()` makes a throwaway EC P-256 key and a self-signed certificate named "Datum test seal" when it is
built (once per process, at start): it seals the PDFs of posted, unstored answers, proves nothing about the server, and
is never the server's key (the service never hands it `sign` or `render_submission`).

Both hold the key as the library's object inside a `TsaSigningKey` (reachable only through `sign`); `repr` and `str`
name the class, the algorithm and the number of certificates; pickling and copying are refused. `sign(to_be_signed)`
answers PKCS#1 v1.5 or a DER ECDSA value, SHA-256 inside, for every algorithm the kernel names.

`wire_signature_value` is the host's check of what any `PdfSigner` answered, before `complete`: an RSA value must be
the modulus length, an ECDSA value strict DER or the raw ``r||s`` of IEEE P1363 (64 bytes on P-256, 96 on P-384),
which `encode_dss_signature` turns into DER; any other shape is refused. The kernel's `complete` checks no value, and
what it does with a P1363 value is not the host's to rely on, so the host hands it DER only.
`certificate_chain_pem` writes a signer's certificates as PEM, leaf first, for `/server/certificate`.

Libraries: `cryptography` loads the files (through the shared loader), holds and uses the key, writes PEM and
converts ``r||s`` (`utils.encode_dss_signature`, `decode_dss_signature`); `TsaSigningKey` (timestamp package) is already
the key-behind-`sign` holder and is reused, not copied. `ssl.DER_cert_to_PEM_cert` (standard library) writes PEM but
parses nothing, so a stray non-certificate would be served; `pydantic` and `anyio` offer nothing here. The only code
written is the adapter from the held key to the `PdfSigner` Protocol (the kernel's algorithm words) and the value-shape
rule, which no library states.
"""

import datetime as dt
from collections.abc import Sequence
from typing import Final, Self

from cryptography import x509
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
from cryptography.x509.oid import NameOID, PublicKeyAlgorithmOID

from datum_core.config.models import Signing
from datum_core.timestamp.certificate import TsaSigningKey
from datum_core.timestamp.keys import load_signing_key
from datum_sandbox.protocol import PdfSignatureAlgorithm

__all__ = [
    "TEST_SEAL_NAME",
    "KeyFilePdfSigner",
    "TestSealSigner",
    "certificate_chain_pem",
    "pdf_algorithm_of",
    "wire_signature_value",
]

TEST_SEAL_NAME: Final = "Datum test seal"
"""The common name of the throwaway test seal's certificate (the signer name a posted answer's PDF shows)."""

_SETTING: Final = "datum.pdf.signing"
_TEST_SEAL_DAYS: Final = 365
_RSA_FLOOR_BITS: Final = 2048


def pdf_algorithm_of(certificate_der: bytes) -> PdfSignatureAlgorithm | None:
    """Return the kernel's algorithm word for the key a DER certificate certifies, or None when the kernel signs none.

    RSA is PKCS#1 v1.5 with SHA-256; EC is ECDSA with SHA-256 on P-256 or P-384 (named for the curve).
    """
    try:
        parsed = x509.load_der_x509_certificate(certificate_der)
        public = parsed.public_key()
    except (ValueError, TypeError, UnsupportedAlgorithm):
        return None
    if parsed.public_key_algorithm_oid not in (
        PublicKeyAlgorithmOID.RSAES_PKCS1_v1_5,
        PublicKeyAlgorithmOID.EC_PUBLIC_KEY,
    ):
        return None
    if isinstance(public, rsa.RSAPublicKey):
        return "RSASSA-PKCS1-v1_5-SHA256"
    if isinstance(public, ec.EllipticCurvePublicKey):
        if isinstance(public.curve, ec.SECP256R1):
            return "ECDSA-P256-SHA256"
        if isinstance(public.curve, ec.SECP384R1):
            return "ECDSA-P384-SHA256"
    return None


def _rsa_bits_below_floor(certificate_der: bytes) -> bool:
    """Whether the certificate certifies an RSA key under the 2048-bit floor the refusal names."""
    public = x509.load_der_x509_certificate(certificate_der).public_key()
    return isinstance(public, rsa.RSAPublicKey) and public.key_size < _RSA_FLOOR_BITS


def certificate_chain_pem(certificates: Sequence[bytes]) -> str:
    """Return the DER `certificates` as PEM text, in order (the signer's leaf first); a non-certificate: ValueError."""
    blocks: list[str] = []
    for der in certificates:
        try:
            certificate = x509.load_der_x509_certificate(der)
        except (ValueError, TypeError) as exc:
            raise ValueError("a signer's certificate is not a DER X.509 certificate") from exc
        blocks.append(certificate.public_bytes(serialization.Encoding.PEM).decode("ascii"))
    return "".join(blocks)


def _strict_der(value: bytes, bits: int) -> bool:
    """Whether `value` is one DER ECDSA-Sig-Value, minimally encoded, with r and s in 1 .. 2**bits - 1."""
    try:
        r, s = decode_dss_signature(value)
    except ValueError:
        return False
    in_range = r > 0 and s > 0 and r.bit_length() <= bits and s.bit_length() <= bits
    return in_range and encode_dss_signature(r, s) == value


def wire_signature_value(value: object, *, algorithm: PdfSignatureAlgorithm, certificate: bytes) -> bytes:
    """Return a signer's `value` in the form the kernel's `complete` embeds, or raise ValueError.

    `value` is what a `PdfSigner` answered (typed `object`: an application's signer may answer anything, and a
    value that is not bytes is refused too). `algorithm` is the one the kernel's handoff names and `certificate` the
    signer's DER leaf; the two must agree. An RSA value is kept when it is the modulus length. An ECDSA value is kept
    when it is strict DER, and a raw ``r||s`` (IEEE P1363: twice the curve's size, 64 bytes on P-256, 96 on P-384) is
    converted with `encode_dss_signature`; any other length or shape is refused. The value is not checked against the
    key here (verify reads a wrong one as `invalid`); the refusal names the algorithm and the length, never the value.
    """
    if not isinstance(value, bytes | bytearray):
        kind = type(value).__name__
        raise ValueError(f"a {algorithm} signature value is bytes, not {kind}")  # noqa: TRY004 - one refusal type
    data = bytes(value)
    if pdf_algorithm_of(certificate) != algorithm:
        raise ValueError(f"the signer's certificate does not certify a {algorithm} key")
    public = x509.load_der_x509_certificate(certificate).public_key()
    if isinstance(public, rsa.RSAPublicKey):
        if len(data) == (public.key_size + 7) // 8:
            return data
        raise ValueError(f"a {algorithm} value of {len(data)} bytes is not the modulus length")
    if not isinstance(public, ec.EllipticCurvePublicKey):  # pragma: no cover - pdf_algorithm_of named an EC curve
        raise ValueError(f"the signer's certificate does not certify a {algorithm} key")  # noqa: TRY004 - as above
    bits = public.curve.key_size
    size = (bits + 7) // 8
    if _strict_der(data, bits):
        return data
    if len(data) == 2 * size:
        r, s = int.from_bytes(data[:size], "big"), int.from_bytes(data[size:], "big")
        if r > 0 and s > 0:
            return encode_dss_signature(r, s)
    raise ValueError(
        f"a {algorithm} value of {len(data)} bytes is neither DER nor the {2 * size}-byte raw r||s of IEEE P1363"
    )


class _HeldKeySigner:
    """A `PdfSigner` over a `TsaSigningKey`: the kernel's algorithm word, the certificates, `sign`, the PEM chain."""

    __slots__ = ("_algorithm", "_key")

    def __init__(self, key: TsaSigningKey, /) -> None:
        """Hold `key` (its chain's first certificate certifies it); refuse a key the kernel cannot sign with."""
        algorithm = pdf_algorithm_of(key.chain_der[0])
        if algorithm is None or _rsa_bits_below_floor(key.chain_der[0]):
            raise ValueError("the key must be RSA of at least 2048 bits or EC on P-256 or P-384")
        self._key: TsaSigningKey = key
        self._algorithm: PdfSignatureAlgorithm = algorithm

    @property
    def algorithm(self) -> PdfSignatureAlgorithm:
        """The algorithm the kernel's handoff names for this key: PKCS#1 v1.5 or ECDSA on the key's curve, SHA-256."""
        return self._algorithm

    def certificates(self) -> tuple[bytes, ...]:
        """Return the DER certificates, the signer's leaf first, then the chain the key file holds (public data)."""
        return self._key.chain_der

    def sign(self, to_be_signed: bytes) -> bytes:
        """Return the signature over `to_be_signed` (SHA-256 inside): PKCS#1 v1.5, or ECDSA as DER."""
        return self._key.sign(to_be_signed)

    def certificate_chain_pem(self) -> str:
        """Return the certificates as PEM text, leaf first (what `/server/certificate` serves); no key."""
        return certificate_chain_pem(self._key.chain_der)

    def __repr__(self) -> str:
        """Name the class, the algorithm and the number of certificates; nothing of the key."""
        return f"{type(self).__name__}({self._algorithm}, {len(self._key.chain_der)} certificate(s))"

    def __reduce__(self) -> str | tuple[object, ...]:
        """Refuse pickling and copying: the key never leaves its object."""
        raise TypeError(f"{type(self).__name__} holds a private key and cannot be pickled or copied")


class KeyFilePdfSigner(_HeldKeySigner):
    """The server's seal key and chain, read once from the files `datum.pdf.signing` names (see the module text)."""

    __slots__ = ()

    @classmethod
    def from_settings(cls, signing: Signing) -> Self:
        """Read the key and the chain once and check them; nothing is built if any check fails.

        This is the only checking path: the constructor takes a held key as it is and never matches the leaf to the
        key, so code that builds one directly owns those checks.
        """
        return cls(load_signing_key(signing, setting=_SETTING, holder=TsaSigningKey))


class TestSealSigner(_HeldKeySigner):
    """The throwaway "Datum test seal": an EC P-256 key and a self-signed certificate made when it is built.

    One per process, made at start: it seals the PDFs of posted, unstored answers and proves nothing about the server.
    Every instance has a key of its own, never the server's; the certificate is valid from a day before `now` (default:
    the real clock) for a year and carries no extended key usage.
    """

    __slots__ = ()
    __test__ = False  # a pytest collector reading "Test*" in a test module's namespace passes this class by

    def __init__(self, *, now: dt.datetime | None = None) -> None:
        """Make the key and its certificate."""
        moment = dt.datetime.now(dt.UTC) if now is None else now.astimezone(dt.UTC)
        not_before, not_after = (
            moment - dt.timedelta(days=1),
            moment + dt.timedelta(days=_TEST_SEAL_DAYS),
        )  # before the key
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name(
            [
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Datum"),
                x509.NameAttribute(NameOID.COMMON_NAME, TEST_SEAL_NAME),
            ]
        )
        certificate = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(not_before)
            .not_valid_after(not_after)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256())
        )
        super().__init__(TsaSigningKey(key, [certificate.public_bytes(serialization.Encoding.DER)]))
