"""A throwaway timestamp PKI built at test time with `cryptography`; nothing is committed and nothing is shared.

Libraries: the standard library has no X.509; `cryptography` (the library the timestamp package signs with) builds
certificates, PKCS#12 and PEM, and `pyOpenSSL`/`trustme` would add a dependency for a subset of it. Only the BER
re-encoding below is written by hand, because no library writes a deliberately non-DER certificate.

`build_pki()` makes, in about a second:

- `ec`: an EC P-384 root and an EC P-256 timestamp leaf under it;
- `rsa`: an RSA-3072 root and an RSA-2048 timestamp leaf under it;
- `wrong_eku`: a leaf under the EC root whose extended key usage is `serverAuth`, not `id-kp-timeStamping`;
- `look_alike(identity)`: a certificate with the leaf's key, issuer and serial but a subject one character different (so
  an ESSCertIDv2 over the real one does not name it, and every length stays the same);
- `ber_leaf`: the RSA leaf's twin whose BasicConstraints critical flag is written as BER (`01 01 01` for TRUE),
  re-signed by the RSA root, to prove a carried certificate stays byte for byte;
- `pkcs12(...)` and `write_pem_pair(...)` for the key loader's inputs.

The leaves carry a critical timeStamping EKU, KeyUsage, SKI and AKI, as RFC 3161 section 2.3 asks. The validity covers
`INSTANT` and ten years on both sides of the fixed test dates.

`build_document_pki()` is the same idea for PDF signers: under an RSA-3072 root, a document-signing leaf
(`signer`, RSA-2048, EKU id-kp-documentSigning), an `email` leaf (emailProtection only), a `no_eku` leaf, an `expired`
leaf (valid in the first half of 2026, so expired at `INSTANT` and valid at `EXPIRED_LEAF_SIGNED_AT`), plus an `ec`
signer under an EC P-384 root, and a `stranger` under a root nobody trusts; `look_alike(identity)` is a certificate with
the leaf's key, issuer and serial and another subject. `make_crl(...)` builds a CRL and `make_ocsp_response(...)` an
OCSP response over a chain's issuer. Every key is made at call time; nothing is committed.
"""

import base64
import datetime as dt
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Final

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509 import ocsp
from cryptography.x509.oid import AuthorityInformationAccessOID, ExtendedKeyUsageOID, NameOID

__all__ = [
    "CRL_URI",
    "DOCUMENT_SIGNING",
    "EXPIRED_LEAF_SIGNED_AT",
    "INSTANT",
    "OCSP_URI",
    "PKI_NOT_AFTER",
    "PKI_NOT_BEFORE",
    "DocumentPki",
    "TsaIdentity",
    "TsaPki",
    "ber_twin",
    "build_document_pki",
    "build_pki",
    "bytes_to_pem",
    "look_alike_of",
    "make_crl",
    "make_leaf",
    "make_ocsp_response",
    "make_root",
]

type PrivateKey = ec.EllipticCurvePrivateKey | rsa.RSAPrivateKey

PKI_NOT_BEFORE: Final = dt.datetime(2026, 1, 1, tzinfo=dt.UTC)
PKI_NOT_AFTER: Final = dt.datetime(2036, 1, 1, tzinfo=dt.UTC)
INSTANT: Final = dt.datetime(2026, 10, 20, 12, 0, 0, tzinfo=dt.UTC)
"""A fixed moment inside every certificate's validity: the tests' `now`."""
DOCUMENT_SIGNING: Final = x509.ObjectIdentifier("1.3.6.1.5.5.7.3.36")
"""id-kp-documentSigning (RFC 9336): the EKU of a document-signing leaf."""
CRL_URI: Final = "http://crl.invalid/datum-test.crl"
"""The CRL distribution point of the document leaves: a `.invalid` host, never fetched (tests patch the network)."""
OCSP_URI: Final = "http://ocsp.invalid/"
"""The OCSP responder of the `ocsp_signer` leaf: a `.invalid` host, never contacted."""
EXPIRED_LEAF_SIGNED_AT: Final = dt.datetime(2026, 3, 1, 12, 0, 0, tzinfo=dt.UTC)
"""A moment inside the `expired` leaf's validity (2026-01-01 to 2026-06-01), before `INSTANT`."""

_SHORT_FORM_LIMIT: Final = 0x80
_BC_CRITICAL_TRUE: Final = bytes.fromhex("0603551d130101ff")
_SHA256_RSA_ALGORITHM: Final = bytes.fromhex("300d06092a864886f70d01010b0500")


def _name(common_name: str, organization: str = "Datum test") -> x509.Name:
    return x509.Name(
        [
            x509.NameAttribute(NameOID.COUNTRY_NAME, "CA"),
            x509.NameAttribute(NameOID.ORGANIZATION_NAME, organization),
            x509.NameAttribute(NameOID.COMMON_NAME, common_name),
        ]
    )


def _digest_for(key: PrivateKey) -> hashes.SHA384 | hashes.SHA256:
    return hashes.SHA384() if isinstance(key, ec.EllipticCurvePrivateKey) else hashes.SHA256()


def make_root(
    common_name: str, key: PrivateKey, *, organization: str = "Datum test", path_length: int | None = 0
) -> x509.Certificate:
    """Build a self-signed CA certificate for `key`; `path_length` is its BasicConstraints (0: issues leaves only)."""
    builder = (
        x509.CertificateBuilder()
        .subject_name(_name(common_name, organization))
        .issuer_name(_name(common_name, organization))
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(PKI_NOT_BEFORE)
        .not_valid_after(PKI_NOT_AFTER)
        .add_extension(x509.BasicConstraints(ca=True, path_length=path_length), critical=True)
        .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    )
    return builder.sign(key, _digest_for(key))


def make_leaf(
    common_name: str,
    key: PrivateKey,
    issuer: x509.Certificate,
    issuer_key: PrivateKey,
    *,
    eku: Sequence[x509.ObjectIdentifier] = (ExtendedKeyUsageOID.TIME_STAMPING,),
    eku_critical: bool = True,
    serial: int | None = None,
    organization: str = "Datum test",
    not_before: dt.datetime = PKI_NOT_BEFORE,
    not_after: dt.datetime = PKI_NOT_AFTER,
    crl_uri: str | None = None,
    ocsp_uri: str | None = None,
) -> x509.Certificate:
    """Build a leaf under `issuer`; the defaults are a conforming timestamp certificate (critical timeStamping EKU).

    An empty `eku` leaves the extended key usage out; a `crl_uri` adds a CRL distribution point naming it (a revocation
    check only looks for a CRL of a certificate that names where one is).
    """
    builder = (
        x509.CertificateBuilder()
        .subject_name(_name(common_name, organization))
        .issuer_name(issuer.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number() if serial is None else serial)
        .not_valid_before(not_before)
        .not_valid_after(not_after)
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), critical=True)
    )
    if eku:  # an empty sequence builds a leaf with no extended key usage at all
        builder = builder.add_extension(x509.ExtendedKeyUsage(list(eku)), critical=eku_critical)
    builder = builder.add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
    builder = builder.add_extension(
        x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False
    )
    if crl_uri is not None:
        point = x509.DistributionPoint([x509.UniformResourceIdentifier(crl_uri)], None, None, None)
        builder = builder.add_extension(x509.CRLDistributionPoints([point]), critical=False)
    if ocsp_uri is not None:
        access = x509.AccessDescription(AuthorityInformationAccessOID.OCSP, x509.UniformResourceIdentifier(ocsp_uri))
        builder = builder.add_extension(x509.AuthorityInformationAccess([access]), critical=False)
    return builder.sign(issuer_key, _digest_for(issuer_key))


def bytes_to_pem(der: bytes, label: str = "CERTIFICATE") -> bytes:
    """Return `der` as a PEM block of `label` (base64 in 64-character lines)."""
    body = base64.b64encode(der).decode("ascii")
    lines = [body[i : i + 64] for i in range(0, len(body), 64)]
    return ("-----BEGIN " + label + "-----\n" + "\n".join(lines) + "\n-----END " + label + "-----\n").encode("ascii")


def _tlv(tag: int, body: bytes) -> bytes:
    size = len(body)
    if size < _SHORT_FORM_LIMIT:
        head = bytes([size])
    else:
        length = size.to_bytes((size.bit_length() + 7) // 8, "big")
        head = bytes([0x80 | len(length)]) + length
    return bytes([tag]) + head + body


def ber_twin(leaf: x509.Certificate, issuer_key: rsa.RSAPrivateKey) -> bytes:
    """Re-encode an RSA-signed `leaf` with its BasicConstraints critical flag as BER (`01`), re-signed by the issuer.

    DER allows only `ff` for TRUE; BER allows any non-zero byte. The result parses as a certificate everywhere
    that is lenient and is refused by a strict DER reader, which is the point.
    """
    tbs = leaf.tbs_certificate_bytes
    at = tbs.index(_BC_CRITICAL_TRUE)
    tbs_ber = tbs[: at + len(_BC_CRITICAL_TRUE) - 1] + b"\x01" + tbs[at + len(_BC_CRITICAL_TRUE) :]
    signature = issuer_key.sign(tbs_ber, padding.PKCS1v15(), hashes.SHA256())
    return _tlv(0x30, tbs_ber + _SHA256_RSA_ALGORITHM + _tlv(0x03, b"\x00" + signature))


def look_alike_of(
    leaf: x509.Certificate, key: PrivateKey, issuer_key: PrivateKey, issuer: x509.Certificate
) -> x509.Certificate:
    """Build a certificate with `leaf`'s key, issuer and serial but a subject one character different.

    The hash differs while every length stays the same (for an RSA leaf), so the look-alike can replace the real leaf
    inside a token byte for byte without disturbing any enclosing length.
    """
    common_name = str(leaf.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value)
    changed = common_name[:-1] + ("X" if common_name[-1] != "X" else "Y")
    return make_leaf(changed, key, issuer, issuer_key, serial=leaf.serial_number)


@dataclass(frozen=True)
class TsaIdentity:
    """A root, a timestamp leaf and the keys: everything a token test signs or verifies with."""

    name: str
    root_key: PrivateKey
    root: x509.Certificate
    key: PrivateKey
    leaf: x509.Certificate

    @property
    def algorithm(self) -> str:
        """The SignerInfo algorithm this leaf signs with."""
        return "ecdsa-sha256" if isinstance(self.key, ec.EllipticCurvePrivateKey) else "rsa-sha256"

    @property
    def leaf_der(self) -> bytes:
        """The leaf as DER."""
        return self.leaf.public_bytes(serialization.Encoding.DER)

    @property
    def root_der(self) -> bytes:
        """The root as DER."""
        return self.root.public_bytes(serialization.Encoding.DER)

    @property
    def chain_der(self) -> tuple[bytes, ...]:
        """The leaf first, then the root."""
        return (self.leaf_der, self.root_der)

    @property
    def leaf_pem(self) -> bytes:
        """The leaf as PEM."""
        return self.leaf.public_bytes(serialization.Encoding.PEM)

    @property
    def root_pem(self) -> bytes:
        """The root as PEM (what `openssl ts -verify -CAfile` trusts)."""
        return self.root.public_bytes(serialization.Encoding.PEM)

    def key_pem(self, password: str | None = None) -> bytes:
        """Return the private key as PKCS#8 PEM, encrypted under `password` when one is given."""
        encryption: serialization.KeySerializationEncryption = (
            serialization.BestAvailableEncryption(password.encode()) if password else serialization.NoEncryption()
        )
        return self.key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, encryption)

    def sign(self, data: bytes) -> bytes:
        """Sign `data` with the leaf's key the way a SignerInfo does (SHA-256; PKCS#1 v1.5 or ECDSA)."""
        if isinstance(self.key, ec.EllipticCurvePrivateKey):
            return self.key.sign(data, ec.ECDSA(hashes.SHA256()))
        return self.key.sign(data, padding.PKCS1v15(), hashes.SHA256())

    def pkcs12(
        self,
        *,
        password: str | None = "p12-secret",  # noqa: S107 - a throwaway test secret
        key_name: str | None = "datum-tsa",
        ca_names: Sequence[str | None] = (None,),
        include_root: bool = True,
    ) -> bytes:
        """Return PKCS#12 bytes holding the key, the leaf (friendly name `key_name`) and the root (named by `ca_names`).

        `ca_names` is one friendly name per CA certificate, `None` for no name; the default carries the root unnamed.
        """
        cas: list[x509.Certificate | pkcs12.PKCS12Certificate] = []
        if include_root:
            cas.extend(
                pkcs12.PKCS12Certificate(self.root, None if name is None else name.encode()) for name in ca_names
            )
        encryption: serialization.KeySerializationEncryption = (
            serialization.BestAvailableEncryption(password.encode()) if password else serialization.NoEncryption()
        )
        return pkcs12.serialize_key_and_certificates(
            None if key_name is None else key_name.encode(), self.key, self.leaf, cas or None, encryption
        )

    def write_pem_pair(
        self, directory: Path, *, key_password: str | None = None, with_root: bool = True
    ) -> tuple[Path, Path]:
        """Write `key.pem` and `chain.pem` (leaf, then the root) under `directory`; return their paths."""
        key_file = directory / "key.pem"
        cert_file = directory / "chain.pem"
        key_file.write_bytes(self.key_pem(key_password))
        cert_file.write_bytes(self.leaf_pem + (self.root_pem if with_root else b""))
        return key_file, cert_file


@dataclass(frozen=True)
class TsaPki:
    """The five certificate kinds of the timestamp tests."""

    ec: TsaIdentity
    rsa: TsaIdentity
    wrong_eku: TsaIdentity
    """A leaf under the EC root whose EKU is `serverAuth`, not timeStamping (`root` is the EC root)."""
    ber_leaf: bytes
    """The RSA leaf's BER twin: same key and issuer, BasicConstraints critical written as `01`."""

    def look_alike(self, identity: TsaIdentity) -> bytes:
        """Return a look-alike of `identity`'s leaf (same key, issuer and serial, another subject) as DER."""
        twin = look_alike_of(identity.leaf, identity.key, identity.root_key, identity.root)
        return twin.public_bytes(serialization.Encoding.DER)


def build_pki() -> TsaPki:
    """Build the whole PKI (fresh random keys each call)."""
    root_ec_key = ec.generate_private_key(ec.SECP384R1())
    root_ec = make_root("Test EC root", root_ec_key)
    leaf_ec_key = ec.generate_private_key(ec.SECP256R1())
    ec_identity = TsaIdentity(
        "ec", root_ec_key, root_ec, leaf_ec_key, make_leaf("Test EC TSA", leaf_ec_key, root_ec, root_ec_key)
    )

    root_rsa_key = rsa.generate_private_key(65537, 3072)
    root_rsa = make_root("Test RSA root", root_rsa_key)
    leaf_rsa_key = rsa.generate_private_key(65537, 2048)
    rsa_leaf = make_leaf("Test RSA TSA", leaf_rsa_key, root_rsa, root_rsa_key)
    rsa_identity = TsaIdentity("rsa", root_rsa_key, root_rsa, leaf_rsa_key, rsa_leaf)

    wrong_key = ec.generate_private_key(ec.SECP256R1())
    wrong = make_leaf("Test web server", wrong_key, root_ec, root_ec_key, eku=(ExtendedKeyUsageOID.SERVER_AUTH,))
    wrong_identity = TsaIdentity("wrong-eku", root_ec_key, root_ec, wrong_key, wrong)

    twin_source = make_leaf("Test RSA TSA (BER)", leaf_rsa_key, root_rsa, root_rsa_key)
    return TsaPki(ec_identity, rsa_identity, wrong_identity, ber_twin(twin_source, root_rsa_key))


# -- the document-signing PKI --------------------------------------------------------------------------------


@dataclass(frozen=True)
class DocumentPki:
    """The signers a PDF trust test needs; each is a `TsaIdentity` (a root, a leaf and the keys) whatever it is for.

    `signer`, `email`, `no_eku` and `expired` share one RSA-3072 root (`signer.root`), so one anchor list trusts them;
    `ec` has its own EC P-384 root; `stranger` has a root that is no one's anchor.
    """

    signer: TsaIdentity
    """An RSA-2048 leaf whose EKU is id-kp-documentSigning."""
    ec: TsaIdentity
    """An EC P-256 documentSigning leaf under an EC P-384 root."""
    email: TsaIdentity
    """An RSA-2048 leaf whose EKU is emailProtection only."""
    no_eku: TsaIdentity
    """An RSA-2048 leaf with no extended key usage."""
    expired: TsaIdentity
    """An RSA-2048 documentSigning leaf valid 2026-01-01 to 2026-06-01: expired at `INSTANT`."""
    stranger: TsaIdentity
    """A documentSigning leaf under a root that is nobody's anchor."""
    server_auth: TsaIdentity
    """An RSA-2048 leaf whose EKU is serverAuth only (an EKU no document signer has)."""
    no_crl_point: TsaIdentity
    """An RSA-2048 documentSigning leaf that names no CRL distribution point and no OCSP responder."""
    ocsp_signer: TsaIdentity
    """An RSA-2048 documentSigning leaf that names an OCSP responder (`OCSP_URI`) and no CRL distribution point."""

    def look_alike(self, identity: TsaIdentity) -> bytes:
        """Return a certificate with `identity`'s key, issuer and serial but another subject, as DER.

        It keeps the leaf's extended key usage, so a trust test can tell a name that merely resembles an anchor's
        leaf from the leaf itself.
        """
        common_name = str(identity.leaf.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value)
        changed = common_name[:-1] + ("X" if common_name[-1] != "X" else "Y")
        try:
            usage = list(identity.leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)
        except x509.ExtensionNotFound:
            usage = []
        twin = make_leaf(
            changed,
            identity.key,
            identity.root,
            identity.root_key,
            eku=usage,
            eku_critical=False,
            serial=identity.leaf.serial_number,
            crl_uri=CRL_URI,
        )
        return twin.public_bytes(serialization.Encoding.DER)


def build_document_pki() -> DocumentPki:
    """Build the document-signing PKI (fresh random keys each call, about a second)."""
    root_key = rsa.generate_private_key(65537, 3072)
    root = make_root("Test document root", root_key)

    def rsa_identity(
        name: str,
        common_name: str,
        eku: Sequence[x509.ObjectIdentifier],
        *,
        crl_uri: str | None = CRL_URI,
        not_before: dt.datetime = PKI_NOT_BEFORE,
        not_after: dt.datetime = PKI_NOT_AFTER,
    ) -> TsaIdentity:
        key = rsa.generate_private_key(65537, 2048)
        leaf = make_leaf(
            common_name,
            key,
            root,
            root_key,
            eku=eku,
            eku_critical=False,
            crl_uri=crl_uri,
            not_before=not_before,
            not_after=not_after,
        )
        return TsaIdentity(name, root_key, root, key, leaf)

    signer = rsa_identity("document-signer", "Test document signer", (DOCUMENT_SIGNING,))
    email = rsa_identity("email", "Test email signer", (ExtendedKeyUsageOID.EMAIL_PROTECTION,))
    no_eku = rsa_identity("no-eku", "Test plain signer", ())
    server_auth = rsa_identity("server-auth", "Test server", (ExtendedKeyUsageOID.SERVER_AUTH,))
    no_crl_point = rsa_identity("no-crl-point", "Test unlisted signer", (DOCUMENT_SIGNING,), crl_uri=None)
    ocsp_key = rsa.generate_private_key(65537, 2048)
    ocsp_leaf = make_leaf(
        "Test ocsp signer", ocsp_key, root, root_key, eku=(DOCUMENT_SIGNING,), eku_critical=False, ocsp_uri=OCSP_URI
    )
    ocsp_signer = TsaIdentity("ocsp-signer", root_key, root, ocsp_key, ocsp_leaf)
    expired = rsa_identity(
        "expired",
        "Test expired signer",
        (DOCUMENT_SIGNING,),
        not_before=dt.datetime(2026, 1, 1, tzinfo=dt.UTC),
        not_after=dt.datetime(2026, 6, 1, tzinfo=dt.UTC),
    )

    ec_root_key = ec.generate_private_key(ec.SECP384R1())
    ec_root = make_root("Test document EC root", ec_root_key)
    ec_key = ec.generate_private_key(ec.SECP256R1())
    ec_identity = TsaIdentity(
        "ec-document-signer",
        ec_root_key,
        ec_root,
        ec_key,
        make_leaf(
            "Test EC document signer",
            ec_key,
            ec_root,
            ec_root_key,
            eku=(DOCUMENT_SIGNING,),
            eku_critical=False,
            crl_uri=CRL_URI,
        ),
    )

    other_root_key = rsa.generate_private_key(65537, 3072)
    other_root = make_root("Test stranger root", other_root_key)
    other_key = rsa.generate_private_key(65537, 2048)
    stranger = TsaIdentity(
        "stranger",
        other_root_key,
        other_root,
        other_key,
        make_leaf(
            "Test stranger signer",
            other_key,
            other_root,
            other_root_key,
            eku=(DOCUMENT_SIGNING,),
            eku_critical=False,
            crl_uri=CRL_URI,
        ),
    )
    return DocumentPki(signer, ec_identity, email, no_eku, expired, stranger, server_auth, no_crl_point, ocsp_signer)


def make_crl(
    issuer: x509.Certificate,
    issuer_key: PrivateKey,
    revoked: Sequence[tuple[int, dt.datetime]] = (),
    *,
    this_update: dt.datetime = INSTANT,
    next_update: dt.datetime | None = None,
    crl_number: int = 1,
) -> x509.CertificateRevocationList:
    """Build and sign a CRL by `issuer`: each `revoked` entry is a certificate serial and the time it was revoked.

    `next_update` defaults to a week after `this_update`. The CRL carries an authority key identifier and a CRL number,
    as a CA's would.
    """
    builder = (
        x509.CertificateRevocationListBuilder()
        .issuer_name(issuer.subject)
        .last_update(this_update)
        .next_update(next_update if next_update is not None else this_update + dt.timedelta(days=7))
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(issuer_key.public_key()), critical=False)
        .add_extension(x509.CRLNumber(crl_number), critical=False)
    )
    for serial, when in revoked:
        builder = builder.add_revoked_certificate(
            x509.RevokedCertificateBuilder().serial_number(serial).revocation_date(when).build()
        )
    return builder.sign(issuer_key, _digest_for(issuer_key))


def make_ocsp_response(
    certificate: x509.Certificate,
    issuer: x509.Certificate,
    issuer_key: PrivateKey,
    status: ocsp.OCSPCertStatus = ocsp.OCSPCertStatus.GOOD,
    *,
    this_update: dt.datetime = INSTANT,
    revoked_at: dt.datetime | None = None,
) -> bytes:
    """Build and sign (by `issuer`) a basic OCSP response about `certificate`; return its DER.

    A `REVOKED` status needs `revoked_at`. The response is good for a week after `this_update`.
    """
    builder = (
        ocsp.OCSPResponseBuilder()
        .add_response(
            cert=certificate,
            issuer=issuer,
            algorithm=hashes.SHA1(),  # noqa: S303 - the CertID hash OCSP uses (RFC 6960), not a signature
            cert_status=status,
            this_update=this_update,
            next_update=this_update + dt.timedelta(days=7),
            revocation_time=revoked_at if status is ocsp.OCSPCertStatus.REVOKED else None,
            revocation_reason=x509.ReasonFlags.key_compromise if status is ocsp.OCSPCertStatus.REVOKED else None,
        )
        .responder_id(ocsp.OCSPResponderEncoding.HASH, issuer)
        .certificates([issuer])
    )
    return builder.sign(issuer_key, _digest_for(issuer_key)).public_bytes(serialization.Encoding.DER)
