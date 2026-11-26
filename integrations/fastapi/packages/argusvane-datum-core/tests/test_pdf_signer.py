"""`KeyFilePdfSigner` and `TestSealSigner`: the server's seal key, read once.

The PDF signer is the TSA key loader's sibling: PKCS#12 (`pkcs12.load_pkcs12`) or a PEM key and chain, read ONCE at
start, under `datum.pdf.signing.*`; the start refuses (a `DatumConfigurationError` naming the setting, never a password
or a key byte) for more than one friendly-named certificate, a `friendly_name` that is not the key certificate's (naming
both), a setting the chosen type cannot use, a leaf that is not the key's, an algorithm outside RSA PKCS#1 v1.5 and
ECDSA P-256/P-384, and a negative serial. Unlike a timestamp key, a seal key has NO extended-key-usage rule (a
document-signing, an e-mail or a plain certificate all load): the kernel signs with what it is given and the trust
policy judges the rest. The loader is the timestamp package's, called by both signers, not copied.
`wire_signature_value` is the host's shape check of any signer's value before `complete` (a raw P1363 ``r||s`` becomes
DER, any other length is refused), and `openssl cms -verify` accepts what each signer produced through the real
program's `sign` and `complete` (`-m runtime -m openssl`).
"""

import ast
import datetime as dt
import re
from collections.abc import Callable, Generator
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa, utils
from cryptography.hazmat.primitives.serialization import pkcs12
from pdf_kernel import PdfKernelSession, ec_verify, pdf_session, rsa_verify, unb64
from pdf_support import PDF_P12_PASSWORD, b64, pdf_signing, pem_signing, rsa_pss_files, unreadable_curve_chain
from tsa_support import KEY_PASSWORD, P12_PASSWORD, leaks, run_openssl, secrets_of

import datum_core
from datum_core.config.models import Signing
from datum_core.pdf import KeyFilePdfSigner, PdfSignatureAlgorithm, PdfSigner, TestSealSigner
from datum_core.pdf.signer import (
    _HeldKeySigner,  # pyright: ignore[reportPrivateUsage]
    certificate_chain_pem,
    pdf_algorithm_of,
    wire_signature_value,
)
from datum_core.testing.openssl import requires_openssl
from datum_core.testing.tsa_pki import DocumentPki, TsaIdentity, build_document_pki, make_leaf, make_root
from datum_core.timestamp.certificate import TsaSigningKey
from datum_sandbox.checks import DatumConfigurationError

SRC = Path(datum_core.__file__ or "").parent
ALGORITHMS = {"RSASSA-PKCS1-v1_5-SHA256", "ECDSA-P256-SHA256", "ECDSA-P384-SHA256"}


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def load(signing: Signing) -> KeyFilePdfSigner:
    return KeyFilePdfSigner.from_settings(signing)


def refusal_of(signing: Signing) -> DatumConfigurationError:
    with pytest.raises(DatumConfigurationError) as raised:
        load(signing)
    return raised.value


def whole_text(error: BaseException) -> str:
    parts: list[str] = []
    current: BaseException | None = error
    for _ in range(10):
        if current is None:
            break
        parts += [str(current), repr(current), *map(str, current.args), getattr(current, "hint", "")]
        current = current.__cause__ or current.__context__
    return "\n".join(parts)


def public_key(identity: TsaIdentity) -> Any:
    return identity.leaf.public_key()


# -- what the signer is ------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("kind", ["PKCS12", "PEM"])
def test_an_rsa_signer_loads_from_either_kind_and_signs_pkcs1_v1_5_over_sha256(
    tmp_path: Path, pki: DocumentPki, kind: str
) -> None:
    signing = pdf_signing(tmp_path, pki.signer) if kind == "PKCS12" else pem_signing(tmp_path, pki.signer)
    signer = load(signing)
    assert signer.algorithm == "RSASSA-PKCS1-v1_5-SHA256"
    assert signer.certificates() == pki.signer.chain_der, "the leaf first, then the chain the file holds"
    value = signer.sign(b"to be signed")
    public_key(pki.signer).verify(value, b"to be signed", padding.PKCS1v15(), hashes.SHA256())


def test_an_ecdsa_p256_signer_signs_a_der_signature_over_sha256(tmp_path: Path, pki: DocumentPki) -> None:
    signer = load(pdf_signing(tmp_path, pki.ec))
    assert signer.algorithm == "ECDSA-P256-SHA256"
    value = signer.sign(b"to be signed")
    public_key(pki.ec).verify(value, b"to be signed", ec.ECDSA(hashes.SHA256()))
    r, s = utils.decode_dss_signature(value)  # DER, not r||s
    assert r > 0
    assert s > 0


def test_an_ecdsa_p384_signer_is_named_for_its_curve_and_still_hashes_with_sha256(tmp_path: Path) -> None:
    root_key = ec.generate_private_key(ec.SECP384R1())
    root = make_root("P-384 root", root_key)
    key = ec.generate_private_key(ec.SECP384R1())
    leaf = make_leaf("P-384 signer", key, root, root_key, eku=(), eku_critical=False)
    identity = TsaIdentity("p384", root_key, root, key, leaf)
    signer = load(pdf_signing(tmp_path, identity))
    assert signer.algorithm == "ECDSA-P384-SHA256"
    key.public_key().verify(signer.sign(b"data"), b"data", ec.ECDSA(hashes.SHA256()))


def test_the_algorithm_is_one_of_the_three_the_kernel_signs(tmp_path: Path, pki: DocumentPki) -> None:
    assert {
        load(pdf_signing(tmp_path, pki.signer)).algorithm,
        load(pdf_signing(tmp_path, pki.ec)).algorithm,
    } <= ALGORITHMS


@pytest.mark.parametrize("name", ["signer", "email", "no_eku", "server_auth"])
def test_a_seal_key_has_no_extended_key_usage_rule(tmp_path: Path, pki: DocumentPki, name: str) -> None:
    """A timestamp key must be critical timeStamping only; a seal key loads whatever EKU its certificate carries."""
    identity: TsaIdentity = getattr(pki, name)
    assert load(pdf_signing(tmp_path, identity)).certificates()[0] == identity.leaf_der


def test_an_encrypted_pem_key_opens_with_its_password(tmp_path: Path, pki: DocumentPki) -> None:
    signer = load(pem_signing(tmp_path, pki.signer, key_password=KEY_PASSWORD))
    public_key(pki.signer).verify(signer.sign(b"x"), b"x", padding.PKCS1v15(), hashes.SHA256())


def test_a_pem_chain_without_the_root_loads_with_the_leaf_alone(tmp_path: Path, pki: DocumentPki) -> None:
    assert load(pem_signing(tmp_path, pki.signer, with_root=False)).certificates() == (pki.signer.leaf_der,)


def test_the_key_and_chain_are_read_once_so_a_deleted_file_changes_nothing(tmp_path: Path, pki: DocumentPki) -> None:
    signing = pdf_signing(tmp_path, pki.signer)
    signer = load(signing)
    Path(str(signing.pkcs12_file)).unlink()
    public_key(pki.signer).verify(signer.sign(b"y"), b"y", padding.PKCS1v15(), hashes.SHA256())
    assert signer.certificates()[0] == pki.signer.leaf_der


def test_the_signer_exposes_no_key_attribute_and_no_password_in_any_text(tmp_path: Path, pki: DocumentPki) -> None:
    signer = load(pdf_signing(tmp_path, pki.signer))
    for text in (repr(signer), str(signer)):
        assert not leaks(text, secrets_of(pki.signer, P12_PASSWORD, PDF_P12_PASSWORD))
    assert not hasattr(signer, "private_key")
    assert not hasattr(signer, "password")


# -- the start refusals ------------------------------------------------------------------------------------------------
def test_a_missing_pkcs12_file_stops_the_start_naming_the_setting(tmp_path: Path) -> None:
    signing = Signing.model_validate(
        {"type": "PKCS12", "pkcs12_file": str(tmp_path / "gone.p12"), "pkcs12_password": P12_PASSWORD}
    )
    text = whole_text(refusal_of(signing))
    assert "datum.pdf.signing.pkcs12_file" in text
    assert P12_PASSWORD not in text
    assert "gone.p12" not in str(refusal_of(signing)), "the path is not echoed"


def test_a_wrong_pkcs12_password_is_refused_without_either_password(tmp_path: Path, pki: DocumentPki) -> None:
    signing = pdf_signing(tmp_path, pki.signer)
    wrong = Signing.model_validate(
        {"type": "PKCS12", "pkcs12_file": signing.pkcs12_file, "pkcs12_password": "wrong-password-1"}
    )
    text = whole_text(refusal_of(wrong))
    assert "datum.pdf.signing.pkcs12_password" in text or "datum.pdf.signing.pkcs12_file" in text
    assert "wrong-password-1" not in text
    assert P12_PASSWORD not in text


def test_a_pem_key_with_the_wrong_password_is_refused_naming_the_setting(tmp_path: Path, pki: DocumentPki) -> None:
    signing = pem_signing(tmp_path, pki.signer, key_password=KEY_PASSWORD)
    wrong = Signing.model_validate(
        {
            "type": "PEM",
            "key_file": signing.key_file,
            "cert_file": signing.cert_file,
            "key_password": "not-the-password",
        }
    )
    text = whole_text(refusal_of(wrong))
    assert "datum.pdf.signing.key_file" in text or "datum.pdf.signing.key_password" in text
    assert "not-the-password" not in text
    assert KEY_PASSWORD not in text


@pytest.mark.parametrize(
    ("kind", "foreign"),
    [
        ("PEM", "pkcs12_file"),
        ("PEM", "friendly_name"),
        ("PEM", "pkcs12_password"),
        ("PKCS12", "key_file"),
        ("PKCS12", "cert_file"),
        ("PKCS12", "key_password"),
    ],
)
def test_a_setting_the_chosen_type_cannot_use_is_refused_by_name(
    tmp_path: Path, pki: DocumentPki, kind: str, foreign: str
) -> None:
    base = pdf_signing(tmp_path, pki.signer) if kind == "PKCS12" else pem_signing(tmp_path, pki.signer)
    fields = {name: getattr(base, name) for name in Signing.model_fields}
    fields[foreign] = "secret-pass" if foreign in ("key_password", "pkcs12_password") else "x"
    text = str(refusal_of(Signing.model_validate(fields)))
    assert f"datum.pdf.signing.{foreign}" in text
    assert "secret-pass" not in text


def test_the_foreign_setting_refusal_comes_before_any_file_is_read() -> None:
    text = str(refusal_of(Signing.model_validate({"type": "PEM", "friendly_name": "datum-pdf"})))
    assert "friendly_name" in text
    assert "key_file" not in text


def test_more_than_one_friendly_named_certificate_is_refused(tmp_path: Path, pki: DocumentPki) -> None:
    signing = pdf_signing(tmp_path, pki.signer, key_name="datum-pdf", ca_names=("root-two",))
    text = str(refusal_of(signing))
    assert "datum.pdf.signing.pkcs12_file" in text
    assert "friendly name" in text


def test_a_friendly_name_is_a_check_never_a_selector_and_the_refusal_names_both(
    tmp_path: Path, pki: DocumentPki
) -> None:
    signing = pdf_signing(tmp_path, pki.signer, key_name="datum-pdf", friendly_name="some-other-name")
    text = str(refusal_of(signing))
    assert "some-other-name" in text
    assert "datum-pdf" in text
    assert "datum.pdf.signing.friendly_name" in text
    assert load(pdf_signing(tmp_path, pki.signer, key_name="datum-pdf", friendly_name="datum-pdf")).certificates()


def test_a_friendly_name_carried_by_another_certificate_does_not_select_it(tmp_path: Path, pki: DocumentPki) -> None:
    signing = pdf_signing(tmp_path, pki.signer, key_name=None, ca_names=("the-ca",), friendly_name="the-ca")
    text = str(refusal_of(signing))
    assert "datum.pdf.signing.friendly_name" in text
    assert "'the-ca'" in text
    assert "none" in text


def test_a_chain_whose_first_certificate_is_not_the_keys_is_refused(tmp_path: Path, pki: DocumentPki) -> None:
    key_file = tmp_path / "key.pem"
    chain_file = tmp_path / "chain.pem"
    key_file.write_bytes(pki.signer.key_pem())
    chain_file.write_bytes(pki.email.leaf_pem + pki.signer.root_pem)  # another leaf first
    signing = Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(chain_file)})
    assert "not the certificate of the private key" in str(refusal_of(signing))


def test_a_pem_chain_file_with_no_certificate_is_refused(tmp_path: Path, pki: DocumentPki) -> None:
    key_file, chain_file = tmp_path / "key.pem", tmp_path / "chain.pem"
    key_file.write_bytes(pki.signer.key_pem())
    chain_file.write_bytes(b"not a certificate")
    text = str(
        refusal_of(Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(chain_file)}))
    )
    assert "datum.pdf.signing.cert_file" in text


@pytest.mark.parametrize("kind", ["ed25519", "p521", "secp256k1", "rsa-1024"])
def test_a_key_the_kernel_cannot_sign_with_is_refused(tmp_path: Path, kind: str) -> None:
    if kind == "ed25519":
        key: Any = ed25519.Ed25519PrivateKey.generate()
        certificate = (
            x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "ed")]))
            .issuer_name(x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "ed")]))
            .public_key(key.public_key())
            .serial_number(7)
            .not_valid_before(make_root("x", ec.generate_private_key(ec.SECP256R1())).not_valid_before_utc)
            .not_valid_after(make_root("x", ec.generate_private_key(ec.SECP256R1())).not_valid_after_utc)
            .sign(key, None)
        )
    elif kind == "rsa-1024":
        key = rsa.generate_private_key(65537, 1024)  # noqa: S505 - the point: a key under the floor  # noqa: S505 - the weak key is the point
        certificate = make_root("RSA-1024 signer", key)
    else:
        key = ec.generate_private_key(ec.SECP521R1() if kind == "p521" else ec.SECP256K1())
        certificate = make_root(f"{kind} signer", key)
    key_file, chain_file = tmp_path / "key.pem", tmp_path / "chain.pem"
    key_file.write_bytes(
        key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8, serialization.NoEncryption())
    )
    chain_file.write_bytes(certificate.public_bytes(serialization.Encoding.PEM))
    text = str(
        refusal_of(Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(chain_file)}))
    )
    assert "datum.pdf.signing" in text
    assert "key" in text


def test_a_leaf_on_a_curve_the_library_cannot_read_is_a_named_start_refusal(tmp_path: Path, pki: DocumentPki) -> None:
    key_file, chain_file = tmp_path / "key.pem", tmp_path / "chain.pem"
    key_file.write_bytes(pki.ec.key_pem())
    chain_file.write_bytes(unreadable_curve_chain(pki.ec))
    text = str(
        refusal_of(Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(chain_file)}))
    )
    assert "datum.pdf.signing" in text


@requires_openssl
def test_an_rsa_pss_key_is_a_named_start_refusal_and_has_no_algorithm_word(tmp_path: Path) -> None:
    key_file, cert_file = rsa_pss_files(tmp_path)
    text = str(
        refusal_of(Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file)}))
    )
    assert "datum.pdf.signing" in text
    leaf = x509.load_pem_x509_certificate(cert_file.read_bytes())
    assert pdf_algorithm_of(leaf.public_bytes(serialization.Encoding.DER)) is None


@pytest.mark.filterwarnings("ignore::cryptography.utils.CryptographyDeprecationWarning")
@pytest.mark.parametrize("kind", ["PEM", "PKCS12"])
def test_a_certificate_with_a_negative_serial_is_a_named_start_refusal(
    tmp_path: Path, pki: DocumentPki, kind: str
) -> None:
    identity = pki.signer
    leaf = make_leaf(
        "negative serial", identity.key, identity.root, identity.root_key, serial=0x7F, eku=(), eku_critical=False
    )
    der = leaf.public_bytes(serialization.Encoding.DER)
    assert der.count(bytes.fromhex("02017f")) == 1
    negative = x509.load_der_x509_certificate(der.replace(bytes.fromhex("02017f"), bytes.fromhex("0201ff"), 1))
    assert negative.serial_number < 0
    if kind == "PEM":
        key_file, chain_file = tmp_path / "key.pem", tmp_path / "chain.pem"
        key_file.write_bytes(identity.key_pem())
        chain_file.write_bytes(negative.public_bytes(serialization.Encoding.PEM) + identity.root_pem)
        signing = Signing.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(chain_file)})
    else:
        path = tmp_path / "negative.p12"
        path.write_bytes(
            pkcs12.serialize_key_and_certificates(
                b"datum-pdf",
                identity.key,
                negative,
                [identity.root],
                serialization.BestAvailableEncryption(P12_PASSWORD.encode()),
            )
        )
        signing = Signing.model_validate({"type": "PKCS12", "pkcs12_file": str(path), "pkcs12_password": P12_PASSWORD})
    error = refusal_of(signing)
    assert "serial is negative" in str(error)
    assert "datum.pdf.signing" in str(error)
    assert not leaks(whole_text(error), [P12_PASSWORD])


def test_no_refusal_carries_a_password_a_key_byte_or_a_path_content(tmp_path: Path, pki: DocumentPki) -> None:
    secrets = secrets_of(pki.signer, P12_PASSWORD, PDF_P12_PASSWORD, KEY_PASSWORD)
    cases = [
        Signing.model_validate(
            {"type": "PKCS12", "pkcs12_file": str(tmp_path / "gone.p12"), "pkcs12_password": P12_PASSWORD}
        ),
        pdf_signing(tmp_path, pki.signer, key_name="a", friendly_name="b"),
        pdf_signing(tmp_path, pki.signer, key_name="a", ca_names=("b",)),
        Signing.model_validate({"type": "PEM", "friendly_name": "x", "key_password": KEY_PASSWORD}),
    ]
    for signing in cases:
        error = refusal_of(signing)
        assert not leaks(whole_text(error), secrets)


# -- the test seal -----------------------------------------------------------------------------------------------------
def test_the_test_seal_is_a_self_signed_certificate_named_datum_test_seal_made_at_construction() -> None:
    seal = TestSealSigner()
    (der, *rest) = seal.certificates()
    certificate = x509.load_der_x509_certificate(der)
    assert certificate.subject == certificate.issuer, "self-signed"
    assert certificate.subject.get_attributes_for_oid(x509.NameOID.COMMON_NAME)[0].value == "Datum test seal"
    assert rest == []
    assert seal.algorithm in ALGORITHMS
    if seal.algorithm.startswith("RSA"):
        rsa_verify(certificate.public_key(), seal.sign(b"data"), b"data")
    else:
        ec_verify(certificate.public_key(), seal.sign(b"data"), b"data")


def test_every_test_seal_has_a_key_of_its_own() -> None:
    first, second = TestSealSigner(), TestSealSigner()
    assert first.certificates() != second.certificates()


def test_the_test_seal_certificate_is_valid_around_the_moment_it_is_made() -> None:
    certificate = x509.load_der_x509_certificate(TestSealSigner().certificates()[0])
    now = dt.datetime.now(dt.UTC)
    assert certificate.not_valid_before_utc <= now <= certificate.not_valid_after_utc


def test_the_test_seal_certificate_is_pinned_ca_false_signing_usages_no_eku_on_p256() -> None:
    certificate = x509.load_der_x509_certificate(TestSealSigner().certificates()[0])
    basic = certificate.extensions.get_extension_for_class(x509.BasicConstraints)
    assert basic.critical is True
    assert basic.value.ca is False
    assert basic.value.path_length is None
    usage = certificate.extensions.get_extension_for_class(x509.KeyUsage)
    assert usage.critical is True
    assert usage.value.digital_signature is True
    assert usage.value.content_commitment is True
    assert not any(
        (
            usage.value.key_encipherment,
            usage.value.data_encipherment,
            usage.value.key_agreement,
            usage.value.key_cert_sign,
            usage.value.crl_sign,
        )
    )
    with pytest.raises(x509.ExtensionNotFound):
        certificate.extensions.get_extension_for_class(x509.ExtendedKeyUsage)
    public = certificate.public_key()
    assert isinstance(public, ec.EllipticCurvePublicKey)
    assert isinstance(public.curve, ec.SECP256R1)
    assert certificate.signature_hash_algorithm is not None
    assert certificate.signature_hash_algorithm.name == "sha256"


def test_the_test_seal_certificate_is_valid_from_a_day_before_the_moment_it_is_given_for_a_year() -> None:
    moment = dt.datetime(2030, 3, 4, 5, 6, 7, tzinfo=dt.UTC)
    certificate = x509.load_der_x509_certificate(TestSealSigner(now=moment).certificates()[0])
    assert certificate.not_valid_before_utc == moment - dt.timedelta(days=1)
    assert certificate.not_valid_after_utc == moment + dt.timedelta(days=365)
    local = moment.astimezone(dt.timezone(dt.timedelta(hours=-5)))
    assert x509.load_der_x509_certificate(TestSealSigner(now=local).certificates()[0]).not_valid_before_utc == (
        moment - dt.timedelta(days=1)
    )


def test_the_test_seal_works_out_its_validity_before_it_generates_the_key(monkeypatch: pytest.MonkeyPatch) -> None:
    generated: list[object] = []
    real = ec.generate_private_key

    def spy(curve: ec.EllipticCurve) -> ec.EllipticCurvePrivateKey:
        generated.append(curve)
        return real(curve)

    monkeypatch.setattr(ec, "generate_private_key", spy)  # the one module the signer calls it on
    with pytest.raises(OverflowError):
        TestSealSigner(now=dt.datetime.max.replace(tzinfo=dt.UTC))
    assert generated == [], "a moment that cannot be given a year stops before any key is made"


def test_a_held_key_signer_checks_the_rsa_size_its_refusal_names(pki: DocumentPki) -> None:
    small_key = rsa.generate_private_key(65537, 1024)  # noqa: S505 - a key under the floor is the point
    root = make_root("Test small root", small_key)
    small = make_leaf("Test small leaf", small_key, root, small_key, eku=(), eku_critical=False)
    with pytest.raises(ValueError, match="2048"):
        _HeldKeySigner(TsaSigningKey(pki.signer.key, [small.public_bytes(serialization.Encoding.DER)]))
    _HeldKeySigner(TsaSigningKey(pki.signer.key, [pki.signer.leaf_der]))  # the 2048-bit fixture is fine


def test_the_test_seal_is_never_the_servers_key(tmp_path: Path, pki: DocumentPki) -> None:
    server = load(pdf_signing(tmp_path, pki.signer))
    assert TestSealSigner().certificates()[0] != server.certificates()[0]


# -- the chain for /server/certificate ---------------------------------------------------------------------------------
def test_the_certificate_chain_is_pem_text_with_the_leaf_first_and_no_key(tmp_path: Path, pki: DocumentPki) -> None:
    signer = load(pdf_signing(tmp_path, pki.signer))
    pem = signer.certificate_chain_pem()
    assert isinstance(pem, str)
    blocks = re.findall(r"-----BEGIN CERTIFICATE-----\n[A-Za-z0-9+/=\n]+?-----END CERTIFICATE-----\n", pem)
    assert len(blocks) == 2
    assert x509.load_pem_x509_certificates(pem.encode()) == [pki.signer.leaf, pki.signer.root]
    assert "PRIVATE KEY" not in pem
    assert b64(pki.signer.leaf_der) in pem.replace("\n", "")


# -- one loader, shared with the timestamp key -------------------------------------------------------------------------
def imports_of(path: Path) -> tuple[set[str], list[str]]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    modules = {node.module or "" for node in ast.walk(tree) if isinstance(node, ast.ImportFrom)}
    called = [
        node.func.attr if isinstance(node.func, ast.Attribute) else getattr(node.func, "id", "")
        for node in ast.walk(tree)
        if isinstance(node, ast.Call)
    ]
    return modules, called


def test_the_signer_calls_the_timestamp_packages_loader_and_does_not_parse_key_files_itself() -> None:
    modules, called = imports_of(SRC / "pdf" / "signer.py")
    assert "datum_core.timestamp.keys" in modules
    assert "load_pkcs12" not in called
    assert "load_pem_private_key" not in called
    assert "load_pem_x509_certificates" not in called


def test_the_pdf_package_never_unwraps_a_secret_the_loader_and_the_timestamp_client_do() -> None:
    """Passwords stay `SecretStr` until the loader opens the file; the TSA credentials until the client sends them."""
    sites = [
        path.relative_to(SRC).as_posix()
        for path in (SRC / "pdf").rglob("*.py")
        if "get_secret_value" in path.read_text(encoding="utf-8")
    ]
    assert sites == []


# -- the value a signer answers, before complete -----------------------------------------------------------------------
def p1363(der: bytes, size: int) -> bytes:
    r, s = utils.decode_dss_signature(der)
    return r.to_bytes(size, "big") + s.to_bytes(size, "big")


def p384_identity() -> TsaIdentity:
    root_key = ec.generate_private_key(ec.SECP384R1())
    root = make_root("P-384 root", root_key)
    key = ec.generate_private_key(ec.SECP384R1())
    return TsaIdentity(
        "p384", root_key, root, key, make_leaf("P-384 signer", key, root, root_key, eku=(), eku_critical=False)
    )


def test_the_algorithm_word_is_read_from_the_certificate(pki: DocumentPki) -> None:
    assert pdf_algorithm_of(pki.signer.leaf_der) == "RSASSA-PKCS1-v1_5-SHA256"
    assert pdf_algorithm_of(pki.ec.leaf_der) == "ECDSA-P256-SHA256"
    assert pdf_algorithm_of(p384_identity().leaf_der) == "ECDSA-P384-SHA256"
    assert (
        pdf_algorithm_of(
            make_root("P-521", ec.generate_private_key(ec.SECP521R1())).public_bytes(serialization.Encoding.DER)
        )
        is None
    )
    assert pdf_algorithm_of(b"not a certificate") is None


@pytest.mark.parametrize("curve", ["P-256", "P-384"])
def test_a_raw_p1363_value_becomes_the_der_of_the_same_signature(pki: DocumentPki, curve: str) -> None:
    identity = pki.ec if curve == "P-256" else p384_identity()
    size = 32 if curve == "P-256" else 48
    algorithm: PdfSignatureAlgorithm = "ECDSA-P256-SHA256" if curve == "P-256" else "ECDSA-P384-SHA256"
    der = identity.sign(b"data")
    raw = p1363(der, size)
    assert len(raw) == 2 * size
    converted = wire_signature_value(raw, algorithm=algorithm, certificate=identity.leaf_der)
    assert utils.decode_dss_signature(converted) == utils.decode_dss_signature(der)
    public_key(identity).verify(converted, b"data", ec.ECDSA(hashes.SHA256()))
    assert wire_signature_value(der, algorithm=algorithm, certificate=identity.leaf_der) == der, "DER is kept"


def test_an_rsa_value_of_the_modulus_length_is_kept_and_any_other_length_refused(pki: DocumentPki) -> None:
    value = pki.signer.sign(b"data")
    leaf = pki.signer.leaf_der
    assert wire_signature_value(value, algorithm="RSASSA-PKCS1-v1_5-SHA256", certificate=leaf) == value
    for wrong in (value[:-1], value + b"\x00", b"", p1363(pki.ec.sign(b"data"), 32)):
        with pytest.raises(ValueError, match="modulus length"):
            wire_signature_value(wrong, algorithm="RSASSA-PKCS1-v1_5-SHA256", certificate=leaf)


@pytest.mark.parametrize("length", [0, 1, 50, 63, 65, 96, 97, 200])
def test_an_ecdsa_value_of_no_known_shape_is_refused_naming_no_byte_of_it(pki: DocumentPki, length: int) -> None:
    value = bytes([0x5A]) * length
    with pytest.raises(ValueError, match="neither DER nor") as raised:
        wire_signature_value(value, algorithm="ECDSA-P256-SHA256", certificate=pki.ec.leaf_der)
    assert f"{length} bytes" in str(raised.value)
    if value:
        assert value.hex() not in str(raised.value)
        assert b64(value) not in str(raised.value)


def test_a_raw_value_with_a_zero_half_and_a_der_value_that_is_not_minimal_are_refused(pki: DocumentPki) -> None:
    r, s = utils.decode_dss_signature(pki.ec.sign(b"data"))
    zero_r = bytes(32) + s.to_bytes(32, "big")
    long_form = b"\x30\x81" + utils.encode_dss_signature(r, s)[1:]  # a length octet that DER forbids
    for value in (zero_r, long_form):
        with pytest.raises(ValueError, match="neither DER nor"):
            wire_signature_value(value, algorithm="ECDSA-P256-SHA256", certificate=pki.ec.leaf_der)


def test_a_value_for_another_algorithm_than_the_certificates_is_refused(pki: DocumentPki) -> None:
    raw = p1363(pki.ec.sign(b"data"), 32)
    for algorithm, certificate in (
        ("ECDSA-P384-SHA256", pki.ec.leaf_der),
        ("RSASSA-PKCS1-v1_5-SHA256", pki.ec.leaf_der),
        ("ECDSA-P256-SHA256", pki.signer.leaf_der),
    ):
        with pytest.raises(ValueError, match="does not certify"):
            wire_signature_value(raw, algorithm=algorithm, certificate=certificate)  # type: ignore[arg-type]


def test_a_value_that_is_not_bytes_is_a_value_error_not_a_type_error(pki: DocumentPki) -> None:
    with pytest.raises(ValueError, match="bytes"):
        wire_signature_value("30440220", algorithm="ECDSA-P256-SHA256", certificate=pki.ec.leaf_der)


def test_the_pem_writer_takes_any_signers_certificates_and_refuses_a_non_certificate(pki: DocumentPki) -> None:
    pem = certificate_chain_pem(pki.ec.chain_der)
    assert x509.load_pem_x509_certificates(pem.encode()) == [pki.ec.leaf, pki.ec.root]
    assert certificate_chain_pem(()) == ""
    with pytest.raises(ValueError, match=r"not a DER X\.509 certificate"):
        certificate_chain_pem((pki.ec.leaf_der, b"junk"))


def test_the_test_seal_pem_is_its_one_self_signed_certificate() -> None:
    seal = TestSealSigner()
    assert (
        x509.load_pem_x509_certificates(seal.certificate_chain_pem().encode())[0].public_bytes(
            serialization.Encoding.DER
        )
        == seal.certificates()[0]
    )


# -- through the real program, judged by openssl -----------------------------------------------------------------------
@pytest.fixture(scope="module")
def session() -> Generator[PdfKernelSession]:
    with pdf_session() as started:
        yield started


def exact_der(blob: bytes) -> bytes:
    """Return the first DER element of `blob` (a signature's /Contents is the CMS followed by zero padding)."""
    length = blob[1]
    if length < 0x80:
        return blob[: 2 + length]
    count = length & 0x7F
    return blob[: 2 + count + int.from_bytes(blob[2 : 2 + count], "big")]


def cms_verify(directory: Path, signed: bytes, report: dict[str, Any], anchor_pem: bytes) -> int:
    """Run `openssl cms -verify` over the signature's ByteRange bytes; return its exit code."""
    a, b, c, d = report["byteRange"]
    covered, contents = signed[a : a + b] + signed[c : c + d], signed[a + b : c]
    (directory / "anchor.pem").write_bytes(anchor_pem)
    (directory / "sig.der").write_bytes(exact_der(bytes.fromhex(contents.strip(b"<>").decode("ascii"))))
    (directory / "content.bin").write_bytes(covered)
    return run_openssl(
        "cms", "-verify", "-binary", "-inform", "DER", "-in", str(directory / "sig.der"),
        "-content", str(directory / "content.bin"), "-CAfile", str(directory / "anchor.pem"),
        "-purpose", "any", "-out", str(directory / "out.bin"),
    ).returncode  # fmt: skip


def signed_through_the_program(
    session: PdfKernelSession, pki: DocumentPki, signer: PdfSigner, value: Callable[[bytes], bytes] | None = None
) -> tuple[bytes, dict[str, Any]]:
    signed = session.sign_with(pki.signer, value=value or signer.sign, chain=signer.certificates())
    assert signed.prepared["signing"]["signatureAlgorithm"] == signer.algorithm, "the kernel names the signer's word"
    report = session.first_signature(signed.data)
    assert unb64(report["signature"]) == signed.value, "the program embeds the value the host handed it"
    return signed.data, report


@pytest.mark.runtime
@requires_openssl
@pytest.mark.parametrize("which", ["pkcs12-rsa", "pem-ec", "test-seal", "raw-p1363"])
def test_openssl_accepts_what_each_signer_signed_through_the_programs_complete_and_a_flipped_byte_fails(
    tmp_path: Path, pki: DocumentPki, session: PdfKernelSession, which: str
) -> None:
    value: Callable[[bytes], bytes] | None = None
    signer: PdfSigner
    if which == "pkcs12-rsa":
        signer, anchor = load(pdf_signing(tmp_path, pki.signer)), pki.signer.root_pem
    elif which == "pem-ec":
        signer, anchor = load(pem_signing(tmp_path, pki.ec, key_password=KEY_PASSWORD)), pki.ec.root_pem
    elif which == "test-seal":
        seal = TestSealSigner()
        signer, anchor = seal, seal.certificate_chain_pem().encode()
    else:
        loaded = load(pdf_signing(tmp_path, pki.ec))
        signer, anchor = loaded, pki.ec.root_pem

        def converted(to_be_signed: bytes) -> bytes:
            raw = p1363(loaded.sign(to_be_signed), 32)
            return wire_signature_value(raw, algorithm=loaded.algorithm, certificate=loaded.certificates()[0])

        value = converted

    data, report = signed_through_the_program(session, pki, signer, value)
    assert cms_verify(tmp_path, data, report, anchor) == 0
    a, b, _c, _d = report["byteRange"]
    flipped = bytearray(data)
    flipped[a + b // 2] ^= 1
    assert cms_verify(tmp_path, bytes(flipped), report, anchor) != 0
