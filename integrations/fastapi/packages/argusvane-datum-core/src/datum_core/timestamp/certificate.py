"""The timestamp certificate: the rules it must meet, the throwaway one for development, and the retired ones.

`TsaCertificateRules` holds RFC 3161 section 2.3 as a check: the key is RSA of at least 2048 bits or EC on P-256 or
P-384, and the extended key usage is exactly `id-kp-timeStamping`, marked critical. The key loader applies it to the
signer's certificate at start; the PDF trust policy reuses it for an authority's chain. `SelfSignedTsaCertificate`
makes a throwaway key and certificate for `datum.tsa.signer.self_signed=true`: development and tests only, it says so in
its subject and in a WARN. `read_retired_certificates` reads the PEM files of `datum.tsa.retired_certificates`
(and `datum.pdf.signing.retired_certificates`): a bare path, or `package:<pkg>/<file>`.

Libraries: `cryptography` builds, parses and signs X.509 and holds the key (this package already signs with it);
`trustme` and `pyOpenSSL` would add a dependency for a subset, and the standard library has no X.509. The key holder
below is a thin adapter, because the library's key objects take algorithm-specific `sign` arguments and the authority
asks for one `sign(data)`. `importlib.resources` (standard library) reads a packaged file; the same
`package:<pkg>/<file>` spelling the forms locations use.
"""

import datetime as dt
import importlib.resources
import logging
from collections.abc import Sequence
from pathlib import Path
from typing import Final, Literal, Self

from cryptography import x509
from cryptography.exceptions import UnsupportedAlgorithm
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

from datum_core.loggers import TSA
from datum_sandbox.checks import DatumConfigurationError

__all__ = [
    "SelfSignedTsaCertificate",
    "TsaCertificateRules",
    "TsaPrivateKey",
    "TsaSigningKey",
    "algorithm_of",
    "read_limited",
    "read_retired_certificates",
]

type TsaPrivateKey = ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey
type SignatureAlgorithm = Literal["rsa-sha256", "ecdsa-sha256"]

logger = logging.getLogger(TSA)

MIN_RSA_BITS: Final = 2048
MAX_FILE_BYTES: Final = 1 << 20
"""A key store, a PEM key or a certificate file is read up to this size (1 MiB); a larger file is refused."""
_PACKAGE_PREFIX: Final = "package:"
_RETIRED_SETTING: Final = "datum.tsa.retired_certificates"
_SELF_SIGNED_NAME: Final = "Datum development TSA (self-signed, development only)"
_SELF_SIGNED_DAYS: Final = 365

PROBLEM_TEXT: Final[dict[str, str]] = {
    "unreadable": "the certificate cannot be read",
    "key": "the key must be RSA of at least 2048 bits or EC on P-256 or P-384",
    "eku": "the extended key usage must be exactly id-kp-timeStamping (RFC 3161 section 2.3)",
    "critical": "the extended key usage must be marked critical (RFC 3161 section 2.3)",
}
"""One sentence per problem code of `TsaCertificateRules.problems`."""


def algorithm_of(key: object) -> SignatureAlgorithm | None:
    """Return the SignerInfo algorithm a private key signs with, or None when the signer cannot use the key."""
    if isinstance(key, rsa.RSAPrivateKey):
        return "rsa-sha256" if key.key_size >= MIN_RSA_BITS else None
    if isinstance(key, ec.EllipticCurvePrivateKey):
        return "ecdsa-sha256" if isinstance(key.curve, ec.SECP256R1 | ec.SECP384R1) else None
    return None


class TsaCertificateRules:
    """RFC 3161 section 2.3 for the signer's certificate: problem codes `unreadable`, `key`, `eku` and `critical`."""

    __slots__ = ()

    def problems(self, certificate_der: bytes) -> tuple[str, ...]:
        """Return the codes of the rules the certificate breaks (none: it conforms), in the order key, eku, critical."""
        try:
            certificate = x509.load_der_x509_certificate(certificate_der)
            key_problems = self._key_problems(certificate)
            usage = self._usage(certificate)
        except (ValueError, UnsupportedAlgorithm, x509.DuplicateExtension):
            return ("unreadable",)
        if usage is None:
            return (*key_problems, "eku")
        found = key_problems
        if len(usage.value) != 1 or ExtendedKeyUsageOID.TIME_STAMPING not in usage.value:
            found = (*found, "eku")
        if not usage.critical:
            found = (*found, "critical")
        return found

    @staticmethod
    def _usage(certificate: x509.Certificate) -> x509.Extension[x509.ExtendedKeyUsage] | None:
        try:
            return certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage)
        except x509.ExtensionNotFound:
            return None

    @staticmethod
    def _key_problems(certificate: x509.Certificate) -> tuple[str, ...]:
        try:
            public = certificate.public_key()
        except (ValueError, UnsupportedAlgorithm):
            return ("key",)
        if isinstance(public, rsa.RSAPublicKey):
            return () if public.key_size >= MIN_RSA_BITS else ("key",)
        if isinstance(public, ec.EllipticCurvePublicKey):
            return () if isinstance(public.curve, ec.SECP256R1 | ec.SECP384R1) else ("key",)
        return ("key",)

    def explain(self, problems: Sequence[str]) -> str:
        """Return the problems as one sentence, for a refusal text."""
        return "; ".join(PROBLEM_TEXT.get(code, code) for code in problems)


class TsaSigningKey:
    """A private key and its certificate chain behind the one operation the authority needs: `sign`.

    The key stays the library's object (no bytes copy is kept) and is reachable only through `sign`; `repr` and `str`
    name the algorithm and the chain length and nothing else, and the object refuses to be pickled or copied. The
    constructor refuses a key the signer cannot use (`ValueError`, naming no key material).
    """

    __slots__ = ("_algorithm", "_chain_der", "_key")

    def __init__(self, key: TsaPrivateKey, chain_der: Sequence[bytes]) -> None:
        """Hold `key` and the DER certificates (the signer's first)."""
        algorithm = algorithm_of(key)
        if algorithm is None:
            raise ValueError("the key must be RSA of at least 2048 bits or EC on P-256 or P-384")
        if not chain_der:
            raise ValueError("the chain holds at least the signer's certificate")
        self._key: TsaPrivateKey = key
        self._algorithm: SignatureAlgorithm = algorithm
        self._chain_der = tuple(chain_der)

    @property
    def signature_algorithm(self) -> SignatureAlgorithm:
        """The SignerInfo algorithm: PKCS#1 v1.5 with SHA-256, or ECDSA with SHA-256."""
        return self._algorithm

    @property
    def chain_der(self) -> tuple[bytes, ...]:
        """The DER certificates, the signer's first."""
        return self._chain_der

    def sign(self, data: bytes) -> bytes:
        """Return the signature over `data` (SHA-256 inside): ECDSA as DER, RSA as PKCS#1 v1.5."""
        key = self._key
        if isinstance(key, ec.EllipticCurvePrivateKey):
            return key.sign(data, ec.ECDSA(hashes.SHA256()))
        return key.sign(data, padding.PKCS1v15(), hashes.SHA256())

    def __repr__(self) -> str:
        """Name the class, the algorithm and the number of certificates; nothing of the key."""
        return f"{type(self).__name__}({self._algorithm}, {len(self._chain_der)} certificate(s))"

    def __reduce__(self) -> str | tuple[object, ...]:
        """Refuse pickling and copying: the key never leaves its object."""
        raise TypeError(f"{type(self).__name__} holds a private key and cannot be pickled or copied")


class SelfSignedTsaCertificate(TsaSigningKey):
    """A throwaway EC P-256 key and its self-signed certificate: development and tests only.

    `generate()` makes both; the certificate conforms to `TsaCertificateRules`, says "development only" in its subject,
    lasts a year, and is different every time. No verifier trusts it unless told to; a WARN on `datum.tsa` says so.
    """

    __slots__ = ()

    @classmethod
    def generate(cls, now: dt.datetime | None = None) -> Self:
        """Make a key and a certificate valid from a day before `now` (default: the real clock) for a year."""
        moment = dt.datetime.now(dt.UTC) if now is None else now.astimezone(dt.UTC)
        key = ec.generate_private_key(ec.SECP256R1())
        name = x509.Name(
            [
                x509.NameAttribute(NameOID.ORGANIZATION_NAME, "Datum"),
                x509.NameAttribute(NameOID.COMMON_NAME, _SELF_SIGNED_NAME),
            ]
        )
        certificate = (
            x509.CertificateBuilder()
            .subject_name(name)
            .issuer_name(name)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(moment - dt.timedelta(days=1))
            .not_valid_after(moment + dt.timedelta(days=_SELF_SIGNED_DAYS))
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.KeyUsage(True, False, False, False, False, False, False, False, False), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.TIME_STAMPING]), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256())
        )
        logger.warning(
            "datum.tsa.signer.self_signed is true: tokens are signed with a throwaway self-signed certificate made "
            "for this process; it is for development only and no verifier trusts it"
        )
        return cls(key, [certificate.public_bytes(serialization.Encoding.DER)])


def read_limited(path: Path) -> bytes | None:
    """Return the file's bytes, or None when it cannot be read or is over 1 MiB (the reason is not distinguished)."""
    try:
        with path.open("rb") as handle:
            data = handle.read(MAX_FILE_BYTES + 1)
    except OSError:
        return None
    return data if len(data) <= MAX_FILE_BYTES else None


def _read_location(location: str) -> bytes | None:
    """Read one location: a bare path (a drive path included) or `package:<pkg>/<file>`; None when it is unreadable."""
    if not location.startswith(_PACKAGE_PREFIX):
        return read_limited(Path(location))
    package, _, name = location[len(_PACKAGE_PREFIX) :].partition("/")
    parts = [part for part in name.split("/") if part]
    if not package or not parts or ".." in parts:
        return None
    try:
        node = importlib.resources.files(package).joinpath(*parts)
        data = node.read_bytes()
    except (ImportError, TypeError, ValueError, OSError):
        return None
    return data if len(data) <= MAX_FILE_BYTES else None


def read_retired_certificates(locations: Sequence[str], *, setting: str = _RETIRED_SETTING) -> tuple[bytes, ...]:
    """Return the DER of every certificate in the PEM files `locations` name, in order.

    A location is a bare path or `package:<pkg>/<file>`. A location that cannot be read, or holds no PEM certificate,
    or holds a block that is not one, is a `DatumConfigurationError` naming `setting` and the location (never the
    file's content).
    """
    found: list[bytes] = []
    for location in locations:
        data = _read_location(location)
        certificates = None
        if data is not None:
            try:
                certificates = x509.load_pem_x509_certificates(data)
            except ValueError:
                certificates = None
        if not certificates:
            raise DatumConfigurationError(
                f'{setting}: "{location}" cannot be read as a file of PEM certificates.',
                hint=f"fix or remove the location in {setting}; use a path or package:<pkg>/<file>",
            )
        found.extend(item.public_bytes(serialization.Encoding.DER) for item in certificates)
    return tuple(found)
