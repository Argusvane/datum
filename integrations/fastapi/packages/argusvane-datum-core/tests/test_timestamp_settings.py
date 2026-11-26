"""The `datum.tsa.*` settings and the key they name: PKCS#12, PEM, `friendly_name` as a check, `self_signed`, the rules.

`KeyFileTsaKeyMaterial.from_settings` reads the key and the chain ONCE (`pkcs12.load_pkcs12`, or a PEM key and chain)
and refuses with a `DatumConfigurationError` that carries no password, no file content and no key byte. `friendly_name`
is a check, never a selector: more than one returned certificate with a friendly name, or a set name that is not the
returned certificate's, stops the start (the message names both). `TsaCertificateRules` holds RFC 3161 section 2.3:
RSA of at least 2048 bits or EC P-256 / P-384, and an extended key usage of exactly `id-kp-timeStamping`, critical.
The accuracy is the `Seconds` type, 0 to 60.
"""

import datetime as dt
import json
import logging
import traceback
from collections.abc import Callable
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, ed25519, padding, rsa
from cryptography.hazmat.primitives.serialization import pkcs12
from cryptography.x509.oid import ExtendedKeyUsageOID
from pdf_support import rsa_pss_files, unreadable_curve_chain
from pydantic import ValidationError
from tsa_support import (
    KEY_PASSWORD,
    P12_PASSWORD,
    leaks,
    pem_signer,
    pkcs12_signer,
    secrets_of,
    with_fields,
)

from datum_core.config.models import Tsa, TsaAccess, TsaClientStore, TsaSigner
from datum_core.testing.openssl import requires_openssl
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity, TsaPki, bytes_to_pem, make_leaf
from datum_core.timestamp import KeyFileTsaKeyMaterial, SelfSignedTsaCertificate, TsaCertificateRules
from datum_core.timestamp.certificate import TsaSigningKey, read_retired_certificates
from datum_sandbox.checks import DatumConfigurationError


def load(signer: TsaSigner) -> KeyFileTsaKeyMaterial:
    return KeyFileTsaKeyMaterial.from_settings(signer)


def refusal_of(signer: TsaSigner) -> DatumConfigurationError:
    with pytest.raises(DatumConfigurationError) as raised:
        load(signer)
    return raised.value


def whole_text(error: BaseException) -> str:
    """The error's message, hint, repr and every exception in its chain."""
    parts: list[str] = []
    current: BaseException | None = error
    seen = 0
    while current is not None and seen < 10:
        parts += [str(current), repr(current), *map(str, current.args)]
        parts.append(getattr(current, "hint", ""))
        current = current.__cause__ or current.__context__
        seen += 1
    return "\n".join(parts)


# -- the defaults and bounds of the section ----------------------------------------------------------------------------
def test_the_section_defaults_are_the_documented_ones() -> None:
    tsa = Tsa()
    assert tsa.enabled is False
    assert tsa.access is TsaAccess.CLIENTS
    assert tsa.accepted_policies == ()
    assert tsa.accuracy == dt.timedelta(seconds=1)
    assert tsa.max_request_size == 16 * 1024
    assert tsa.allow_memory_stores is False
    assert tsa.client_store is TsaClientStore.SETTINGS
    assert tsa.clients == ()
    assert tsa.retired_certificates == ()
    assert (tsa.flood.limit, tsa.flood.window.total_seconds(), tsa.flood.failed_keys) == (1000, 3600, 10)
    assert tsa.signer.self_signed is False


def test_session_cookies_default_to_any_cookie() -> None:
    """The default `["*"]` refuses a request carrying any cookie; a list names the ones that count."""
    assert Tsa().session_cookies == ("*",)
    assert Tsa(session_cookies=("JSESSIONID", "sid")).session_cookies == ("JSESSIONID", "sid")


@pytest.mark.parametrize("accuracy", [0, 1, 0.5, 60, "PT30S", "45", "PT0.25S"])
def test_an_accuracy_from_0_to_60_seconds_is_taken(accuracy: object) -> None:
    assert isinstance(Tsa.model_validate({"accuracy": accuracy}).accuracy, dt.timedelta)


@pytest.mark.parametrize("accuracy", [61, 60.001, -1, "PT61S", "PT-5S", "a minute"])
def test_an_accuracy_outside_0_to_60_seconds_names_the_field(accuracy: object) -> None:
    with pytest.raises(ValidationError, match="accuracy"):
        Tsa.model_validate({"accuracy": accuracy})


@pytest.mark.parametrize("size", [1, "1KiB", "16KiB", "1MiB", 2**20])
def test_a_request_size_from_1_byte_to_1_mib_is_taken(size: object) -> None:
    assert 1 <= Tsa.model_validate({"max_request_size": size}).max_request_size <= 2**20


@pytest.mark.parametrize("size", [0, -1, 2**20 + 1, "2MiB"])
def test_a_request_size_outside_1_byte_to_1_mib_names_the_field(size: object) -> None:
    with pytest.raises(ValidationError, match="max_request_size"):
        Tsa.model_validate({"max_request_size": size})


def test_the_passwords_are_secrets_in_every_dump() -> None:
    signer = TsaSigner.model_validate(
        {"pkcs12_file": "/x.p12", "pkcs12_password": P12_PASSWORD, "key_password": KEY_PASSWORD}
    )
    for text in (repr(signer), str(signer), json.dumps(signer.model_dump(mode="json")), signer.model_dump_json()):
        assert P12_PASSWORD not in text
        assert KEY_PASSWORD not in text
    assert Tsa(signer=signer).model_dump_json().count(P12_PASSWORD) == 0


# -- PKCS#12 -----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("which", ["ec", "rsa"])
def test_a_pkcs12_key_and_its_chain_are_read_once_and_sign_for_the_leaf(
    tmp_path: Path, tsa_pki: TsaPki, which: str
) -> None:
    identity = tsa_pki.ec if which == "ec" else tsa_pki.rsa
    material = load(pkcs12_signer(tmp_path, identity))
    assert material.chain_der == identity.chain_der
    assert material.signature_algorithm == identity.algorithm
    signature = material.sign(b"to be signed")
    public = identity.leaf.public_key()
    if isinstance(public, ec.EllipticCurvePublicKey):
        public.verify(signature, b"to be signed", ec.ECDSA(hashes.SHA256()))
    else:
        assert isinstance(public, rsa.RSAPublicKey)
        public.verify(signature, b"to be signed", padding.PKCS1v15(), hashes.SHA256())


def test_the_key_is_not_read_again_after_the_file_is_gone(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec)
    material = load(signer)
    Path(signer.pkcs12_file or "").unlink()
    assert material.sign(b"still signs")
    assert material.chain_der == tsa_pki.ec.chain_der


def test_a_pkcs12_file_with_no_chain_gives_the_leaf_alone(tmp_path: Path, tsa_pki: TsaPki) -> None:
    path = tmp_path / "leaf-only.p12"
    path.write_bytes(tsa_pki.ec.pkcs12(password=P12_PASSWORD, include_root=False))
    signer = TsaSigner.model_validate({"type": "PKCS12", "pkcs12_file": str(path), "pkcs12_password": P12_PASSWORD})
    assert load(signer).chain_der == (tsa_pki.ec.leaf_der,)


def test_a_pkcs12_file_with_no_password_is_read_when_it_has_none(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, password=None)
    assert load(signer).chain_der == tsa_pki.ec.chain_der


@pytest.mark.parametrize("password", ["not-the-password", None], ids=["wrong", "missing"])
def test_a_wrong_or_missing_pkcs12_password_stops_the_start_and_says_neither(
    tmp_path: Path, tsa_pki: TsaPki, password: str | None
) -> None:
    good = pkcs12_signer(tmp_path, tsa_pki.ec)
    bad = with_fields(good, pkcs12_password=None if password is None else _secret(password))
    error = refusal_of(bad)
    text = whole_text(error)
    assert not leaks(text, secrets_of(tsa_pki.ec, P12_PASSWORD, "not-the-password"))
    assert "pkcs12" in text.lower()


def _secret(value: str) -> object:
    from pydantic import SecretStr  # noqa: PLC0415

    return SecretStr(value)


def test_a_missing_pkcs12_file_stops_the_start_naming_the_setting(tmp_path: Path) -> None:
    signer = TsaSigner.model_validate(
        {"type": "PKCS12", "pkcs12_file": str(tmp_path / "gone.p12"), "pkcs12_password": P12_PASSWORD}
    )
    text = whole_text(refusal_of(signer))
    assert "pkcs12_file" in text
    assert P12_PASSWORD not in text


def test_a_pkcs12_signer_without_a_file_stops_the_start(tmp_path: Path) -> None:
    assert "pkcs12_file" in whole_text(refusal_of(TsaSigner.model_validate({"type": "PKCS12"})))


def test_a_file_that_is_not_pkcs12_says_nothing_of_its_content(tmp_path: Path) -> None:
    path = tmp_path / "junk.p12"
    path.write_bytes(b"ZZ-FILE-CONTENT-MARKER-ZZ" * 4)
    signer = TsaSigner.model_validate({"type": "PKCS12", "pkcs12_file": str(path), "pkcs12_password": P12_PASSWORD})
    assert "ZZ-FILE-CONTENT-MARKER-ZZ" not in whole_text(refusal_of(signer))


# -- friendly_name: a check, never a selector --------------------------------------------------------------------------
def test_a_friendly_name_that_is_the_returned_certificates_is_accepted(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, friendly_name="datum-tsa")
    assert load(signer).chain_der == tsa_pki.ec.chain_der


def test_a_friendly_name_that_is_not_the_returned_certificates_stops_the_start_naming_both(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    text = whole_text(refusal_of(pkcs12_signer(tmp_path, tsa_pki.ec, friendly_name="some-other-key")))
    assert "some-other-key" in text
    assert "datum-tsa" in text


def test_a_friendly_name_does_not_select_among_certificates_it_only_checks(tmp_path: Path, tsa_pki: TsaPki) -> None:
    """The CA carries the set name and the key's certificate none: the name is not used to pick another certificate."""
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, key_name=None, ca_names=("the-ca",), friendly_name="the-ca")
    assert "the-ca" in whole_text(refusal_of(signer))


def test_more_than_one_returned_certificate_with_a_friendly_name_stops_the_start(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, key_name="the-leaf", ca_names=("the-ca",))
    assert "friendly" in whole_text(refusal_of(signer)).lower()


def test_a_friendly_name_set_on_a_certificate_with_none_stops_the_start(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, key_name=None, friendly_name="wanted")
    assert "wanted" in whole_text(refusal_of(signer))


# -- PEM ---------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("which", ["ec", "rsa"])
def test_a_pem_key_and_chain_are_read(tmp_path: Path, tsa_pki: TsaPki, which: str) -> None:
    identity = tsa_pki.ec if which == "ec" else tsa_pki.rsa
    material = load(pem_signer(tmp_path, identity))
    assert material.chain_der == identity.chain_der
    assert material.signature_algorithm == identity.algorithm


def test_an_encrypted_pem_key_needs_the_key_password(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pem_signer(tmp_path, tsa_pki.ec, key_password=KEY_PASSWORD)
    assert load(signer).chain_der == tsa_pki.ec.chain_der
    without = with_fields(signer, key_password=None)
    wrong = with_fields(signer, key_password=_secret("not-it"))
    for bad in (without, wrong):
        text = whole_text(refusal_of(bad))
        assert KEY_PASSWORD not in text
        assert "not-it" not in text
        assert "key" in text.lower()


def test_a_pem_chain_whose_leaf_is_not_the_keys_certificate_stops_the_start(tmp_path: Path, tsa_pki: TsaPki) -> None:
    key_file, cert_file = tsa_pki.ec.write_pem_pair(tmp_path)
    cert_file.write_bytes(tsa_pki.rsa.leaf_pem + tsa_pki.rsa.root_pem)
    signer = TsaSigner.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file)})
    assert "leaf" in whole_text(refusal_of(signer)).lower() or "certificate" in whole_text(refusal_of(signer)).lower()


def test_a_pem_signer_without_both_files_stops_the_start(tmp_path: Path, tsa_pki: TsaPki) -> None:
    key_file, _ = tsa_pki.ec.write_pem_pair(tmp_path)
    assert "cert_file" in whole_text(refusal_of(TsaSigner.model_validate({"type": "PEM", "key_file": str(key_file)})))
    assert "key_file" in whole_text(refusal_of(TsaSigner.model_validate({"type": "PEM"})))


def test_a_pem_key_file_never_has_its_bytes_quoted(tmp_path: Path, tsa_pki: TsaPki) -> None:
    key_file, cert_file = tsa_pki.ec.write_pem_pair(tmp_path)
    key_file.write_bytes(key_file.read_bytes()[:-60])  # a truncated key
    signer = TsaSigner.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file)})
    assert not leaks(whole_text(refusal_of(signer)), secrets_of(tsa_pki.ec))


# -- keys and certificates the signer cannot use -----------------------------------------------------------------------
def odd_identity(tsa_pki: TsaPki, key: Any, **leaf: Any) -> TsaIdentity:
    base = tsa_pki.ec
    certificate = make_leaf("Odd TSA", key, base.root, base.root_key, **leaf)
    return TsaIdentity("odd", base.root_key, base.root, key, certificate)


@pytest.mark.parametrize(
    "make_key",
    [
        ed25519.Ed25519PrivateKey.generate,
        lambda: ec.generate_private_key(ec.SECP521R1()),
        lambda: ec.generate_private_key(ec.SECP256K1()),
        lambda: rsa.generate_private_key(65537, 1024),  # noqa: S505 - the weak key is the point
    ],
    ids=["ed25519", "p521", "secp256k1", "rsa-1024"],
)
def test_a_key_the_signer_cannot_use_stops_the_start(
    tmp_path: Path, tsa_pki: TsaPki, make_key: Callable[[], Any]
) -> None:
    key = make_key()
    try:
        identity = odd_identity(tsa_pki, key)
    except (ValueError, TypeError):
        pytest.skip("cryptography will not even build a certificate for this key")
    text = whole_text(refusal_of(pem_signer(tmp_path, identity)))
    assert "key" in text.lower()


def test_a_certificate_that_is_not_a_timestamp_certificate_stops_the_start(tmp_path: Path, tsa_pki: TsaPki) -> None:
    identity = tsa_pki.wrong_eku
    text = whole_text(refusal_of(pem_signer(tmp_path, identity)))
    assert "timestamp" in text.lower() or "key usage" in text.lower() or "eku" in text.lower()


# -- TsaCertificateRules -----------------------------------------------------------------------------------------------
def problems(tsa_pki: TsaPki, key: Any, **leaf: Any) -> tuple[str, ...]:
    return TsaCertificateRules().problems(odd_identity(tsa_pki, key, **leaf).leaf_der)


def test_a_conforming_ec_or_rsa_leaf_has_no_problems(tsa_pki: TsaPki) -> None:
    rules = TsaCertificateRules()
    assert rules.problems(tsa_pki.ec.leaf_der) == ()
    assert rules.problems(tsa_pki.rsa.leaf_der) == ()


def test_a_server_authentication_certificate_has_the_eku_problem(tsa_pki: TsaPki) -> None:
    assert TsaCertificateRules().problems(tsa_pki.wrong_eku.leaf_der) == ("eku",)


def test_an_extra_key_usage_beside_timestamping_is_the_eku_problem(tsa_pki: TsaPki) -> None:
    both = (ExtendedKeyUsageOID.TIME_STAMPING, ExtendedKeyUsageOID.SERVER_AUTH)
    assert problems(tsa_pki, ec.generate_private_key(ec.SECP256R1()), eku=both) == ("eku",)


def test_a_timestamping_eku_that_is_not_critical_is_the_critical_problem(tsa_pki: TsaPki) -> None:
    assert problems(tsa_pki, ec.generate_private_key(ec.SECP256R1()), eku_critical=False) == ("critical",)


def test_a_certificate_without_an_eku_has_the_eku_problem(tsa_pki: TsaPki) -> None:
    root = tsa_pki.ec
    key = ec.generate_private_key(ec.SECP256R1())
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(x509.oid.NameOID.COMMON_NAME, "No EKU")]))
        .issuer_name(root.root.subject)
        .public_key(key.public_key())
        .serial_number(7)
        .not_valid_before(INSTANT - dt.timedelta(days=1))
        .not_valid_after(INSTANT + dt.timedelta(days=1))
    )
    certificate = builder.sign(root.root_key, hashes.SHA384())
    assert TsaCertificateRules().problems(certificate.public_bytes(serialization.Encoding.DER)) == ("eku",)


@pytest.mark.parametrize(
    ("make_key", "expected"),
    [
        (lambda: rsa.generate_private_key(65537, 1024), ("key",)),  # noqa: S505 - the weak key is the point
        (lambda: rsa.generate_private_key(65537, 2048), ()),
        (lambda: ec.generate_private_key(ec.SECP384R1()), ()),
        (lambda: ec.generate_private_key(ec.SECP521R1()), ("key",)),
        (lambda: ec.generate_private_key(ec.SECP256K1()), ("key",)),
    ],
    ids=["rsa-1024", "rsa-2048", "p384", "p521", "secp256k1"],
)
def test_the_key_rules_are_rsa_2048_up_or_ec_p256_and_p384(
    tsa_pki: TsaPki, make_key: Callable[[], Any], expected: tuple[str, ...]
) -> None:
    assert problems(tsa_pki, make_key()) == expected


def test_unreadable_bytes_are_one_problem_not_an_exception() -> None:
    assert TsaCertificateRules().problems(b"not a certificate") == ("unreadable",)


# -- self-signed (development only) ------------------------------------------------------------------------------------
def test_the_self_signed_certificate_is_one_certificate_that_passes_the_rules_and_signs() -> None:
    material = SelfSignedTsaCertificate.generate(INSTANT)
    assert len(material.chain_der) == 1
    assert TsaCertificateRules().problems(material.chain_der[0]) == ()
    certificate = x509.load_der_x509_certificate(material.chain_der[0])
    assert certificate.issuer == certificate.subject
    assert certificate.not_valid_before_utc <= INSTANT <= certificate.not_valid_after_utc
    signature = material.sign(b"data")
    public = certificate.public_key()
    assert isinstance(public, ec.EllipticCurvePublicKey)
    public.verify(signature, b"data", ec.ECDSA(hashes.SHA256()))


def test_two_self_signed_certificates_are_never_the_same() -> None:
    assert SelfSignedTsaCertificate.generate(INSTANT).chain_der != SelfSignedTsaCertificate.generate(INSTANT).chain_der


def test_the_self_signed_certificate_says_in_its_name_that_it_is_for_development() -> None:
    certificate = x509.load_der_x509_certificate(SelfSignedTsaCertificate.generate(INSTANT).chain_der[0])
    assert "development" in certificate.subject.rfc4514_string().lower()


# -- retired certificates ----------------------------------------------------------------------------------------------
def test_retired_certificates_are_read_from_pem_files(tmp_path: Path, tsa_pki: TsaPki) -> None:
    first = tmp_path / "old-1.pem"
    second = tmp_path / "old-2.pem"
    first.write_bytes(tsa_pki.ec.leaf_pem)
    second.write_bytes(tsa_pki.rsa.leaf_pem + tsa_pki.rsa.root_pem)
    found = read_retired_certificates((str(first), str(second)))
    assert found == (tsa_pki.ec.leaf_der, tsa_pki.rsa.leaf_der, tsa_pki.rsa.root_der)


def test_a_package_location_reads_a_packaged_pem(
    tmp_path: Path, tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "retired_pkg"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (package / "old.pem").write_bytes(bytes_to_pem(tsa_pki.ec.leaf_der))
    monkeypatch.syspath_prepend(str(tmp_path))  # pyright: ignore[reportUnknownMemberType]
    assert read_retired_certificates(("package:retired_pkg/old.pem",)) == (tsa_pki.ec.leaf_der,)


def test_no_locations_read_no_certificates() -> None:
    assert read_retired_certificates(()) == ()


def test_an_unreadable_location_stops_the_start_naming_the_setting(tmp_path: Path) -> None:
    junk = tmp_path / "junk.pem"
    junk.write_text("-----BEGIN CERTIFICATE-----\nnot base64 !!\n-----END CERTIFICATE-----\n")
    for location in (str(tmp_path / "gone.pem"), str(junk), "package:no_such_pkg_zz/x.pem"):
        with pytest.raises(DatumConfigurationError, match="retired_certificates"):
            read_retired_certificates((location,))


# -- every refusal says nothing secret ---------------------------------------------------------------------------------
MARKER = "ZZ-FILE-CONTENT-MARKER-ZZ"


def refusal_cases(directory: Path, tsa_pki: TsaPki) -> dict[str, TsaSigner]:
    """One signer per way the start refuses, each with passwords and file content that must never come back."""
    good = pkcs12_signer(directory, tsa_pki.ec, friendly_name="datum-tsa")
    junk = directory / "junk.bin"
    junk.write_bytes((MARKER * 4).encode())
    pem = pem_signer(directory, tsa_pki.ec, key_password=KEY_PASSWORD)
    for name in ("plain", "weak", "eku"):
        (directory / name).mkdir()
    plain_key, plain_chain = tsa_pki.ec.write_pem_pair(directory / "plain")
    weak = odd_identity(tsa_pki, rsa.generate_private_key(65537, 1024))  # noqa: S505 - the weak key is the point
    foreign = directory / "foreign.pem"
    foreign.write_bytes(tsa_pki.rsa.leaf_pem + tsa_pki.rsa.root_pem)
    unreadable = directory / "unreadable-curve.pem"
    unreadable.write_bytes(unreadable_curve_chain(tsa_pki.ec))
    return {
        "wrong p12 password": with_fields(good, pkcs12_password=_secret("not-the-password")),
        "missing p12 password": with_fields(good, pkcs12_password=None),
        "missing p12 file": with_fields(good, pkcs12_file=str(directory / "gone.p12")),
        "no p12 file set": with_fields(good, pkcs12_file=None),
        "junk p12 file": with_fields(good, pkcs12_file=str(junk)),
        "friendly name mismatch": with_fields(good, friendly_name="some-other-key"),
        "wrong pem key password": with_fields(pem, key_password=_secret("not-the-password")),
        "missing pem key password": with_fields(pem, key_password=None),
        "pem key with a password it does not need": TsaSigner.model_validate(
            {"type": "PEM", "key_file": str(plain_key), "cert_file": str(plain_chain), "key_password": KEY_PASSWORD}
        ),
        "pkcs12 signer given a key_password": with_fields(good, key_password=_secret(KEY_PASSWORD)),
        "pem signer given a friendly_name": with_fields(pem, friendly_name="datum-tsa"),
        "pem signer given a pkcs12_file": with_fields(pem, pkcs12_file=good.pkcs12_file),
        "pem signer given a pkcs12_password": with_fields(pem, pkcs12_password=_secret(P12_PASSWORD)),
        "junk pem key": with_fields(pem, key_file=str(junk)),
        "junk pem chain": with_fields(pem, cert_file=str(junk)),
        "chain of another key": with_fields(pem, cert_file=str(foreign)),
        "weak key": pem_signer(directory / "weak", weak),
        "wrong eku": pem_signer(directory / "eku", tsa_pki.wrong_eku),
        "leaf on a curve the library cannot read": with_fields(pem, cert_file=str(unreadable)),
    }


def test_every_start_refusal_text_carries_no_password_key_byte_or_file_content(
    tmp_path: Path, tsa_pki: TsaPki, caplog: pytest.LogCaptureFixture
) -> None:
    forbidden = [*secrets_of(tsa_pki.ec, P12_PASSWORD, KEY_PASSWORD, "not-the-password"), *secrets_of(tsa_pki.rsa)]
    forbidden.append(MARKER)
    cases = refusal_cases(tmp_path, tsa_pki)
    forbidden.extend(
        key_file.read_bytes()
        for key_file in tmp_path.rglob("*")
        if key_file.is_file() and b"PRIVATE KEY" in key_file.read_bytes()
    )
    assert len(cases) == 19
    with caplog.at_level(logging.DEBUG):
        for name, signer in cases.items():
            error = refusal_of(signer)
            text = whole_text(error)
            assert text.strip(), name
            assert not leaks(text, forbidden), name
            assert str(tmp_path) not in text, f"{name} names a path"
            assert error.__cause__ is None, name
            assert error.__context__ is None, name
            frames = traceback.TracebackException.from_exception(error, capture_locals=True).stack
            local_text = "\n".join(str(frame.locals) for frame in frames if "datum_core" in frame.filename)
            assert not leaks(local_text, forbidden), name
            tb = error.__traceback__
            while tb is not None:
                assert not any(isinstance(v, TsaSigningKey) for v in tb.tb_frame.f_locals.values()), name
                tb = tb.tb_next
    logged = caplog.text + "".join(record.getMessage() for record in caplog.records)
    assert not leaks(logged, forbidden)


@requires_openssl
def test_an_rsa_pss_key_is_a_named_start_refusal(tmp_path: Path) -> None:
    key_file, cert_file = rsa_pss_files(tmp_path)
    signer = TsaSigner.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file)})
    assert "datum.tsa.signer" in whole_text(refusal_of(signer))


def test_a_pem_key_given_a_password_it_does_not_need_is_refused_naming_the_setting(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    signer = with_fields(pem_signer(tmp_path, tsa_pki.ec), key_password=_secret(KEY_PASSWORD))
    assert "key_password" in whole_text(refusal_of(signer))


def test_a_key_file_over_one_mebibyte_is_refused_without_being_parsed(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = pkcs12_signer(tmp_path, tsa_pki.ec)
    Path(signer.pkcs12_file or "").write_bytes(b"\0" * ((1 << 20) + 1))
    assert "pkcs12_file" in whole_text(refusal_of(signer))


def test_the_refusal_is_not_chained_to_the_librarys_error(tmp_path: Path, tsa_pki: TsaPki) -> None:
    bad = with_fields(pkcs12_signer(tmp_path, tsa_pki.ec), pkcs12_password=_secret("not-the-password"))
    error = refusal_of(bad)
    assert error.__cause__ is None
    assert error.__context__ is None


def test_a_p384_leaf_signs_with_ecdsa_sha256(tmp_path: Path, tsa_pki: TsaPki) -> None:
    identity = odd_identity(tsa_pki, ec.generate_private_key(ec.SECP384R1()))
    material = load(pem_signer(tmp_path, identity))
    assert material.signature_algorithm == "ecdsa-sha256"
    public = identity.leaf.public_key()
    assert isinstance(public, ec.EllipticCurvePublicKey)
    public.verify(material.sign(b"x"), b"x", ec.ECDSA(hashes.SHA256()))


def test_the_key_material_names_no_key_in_its_repr_and_cannot_be_pickled_or_copied(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    import copy  # noqa: PLC0415
    import pickle  # noqa: PLC0415

    material = load(pem_signer(tmp_path, tsa_pki.ec))
    assert repr(material) == "KeyFileTsaKeyMaterial(ecdsa-sha256, 2 certificate(s))"
    for attempt in (lambda: pickle.dumps(material), lambda: copy.copy(material), lambda: copy.deepcopy(material)):
        with pytest.raises(TypeError, match="cannot be pickled or copied"):
            attempt()


def test_a_non_critical_certificate_with_a_wrong_usage_has_both_problems(tsa_pki: TsaPki) -> None:
    key = ec.generate_private_key(ec.SECP256R1())
    both = problems(tsa_pki, key, eku=(ExtendedKeyUsageOID.SERVER_AUTH,), eku_critical=False)
    assert both == ("eku", "critical")
    assert TsaCertificateRules().explain(both).count(";") == 1


# -- self-signed and retired: the details ------------------------------------------------------------------------------
def test_making_a_self_signed_certificate_warns_that_it_is_for_development_only(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level("WARNING", logger="datum.tsa"):
        SelfSignedTsaCertificate.generate(INSTANT)
    (record,) = [item for item in caplog.records if item.name == "datum.tsa"]
    assert record.levelname == "WARNING"
    assert "self_signed" in record.getMessage()
    assert "development only" in record.getMessage()


def test_the_self_signed_material_names_no_key_in_its_repr_and_refuses_a_copy() -> None:
    import copy  # noqa: PLC0415

    material = SelfSignedTsaCertificate.generate(INSTANT)
    assert repr(material) == "SelfSignedTsaCertificate(ecdsa-sha256, 1 certificate(s))"
    with pytest.raises(TypeError):
        copy.copy(material)


def test_a_retired_location_that_looks_like_a_windows_drive_path_is_a_file_not_a_package() -> None:
    with pytest.raises(DatumConfigurationError, match="retired_certificates"):
        read_retired_certificates(("C:\\certificates\\old.pem",))


@pytest.mark.parametrize("location", ["package:", "package:retired_pkg", "package:retired_pkg/", "package:/old.pem"])
def test_a_malformed_package_location_stops_the_start(location: str) -> None:
    with pytest.raises(DatumConfigurationError, match="retired_certificates"):
        read_retired_certificates((location,))


def test_a_package_location_cannot_climb_out_of_its_package(
    tmp_path: Path, tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "retired_pkg"
    package.mkdir()
    (package / "__init__.py").write_text("")
    (tmp_path / "outside.pem").write_bytes(tsa_pki.ec.leaf_pem)
    monkeypatch.syspath_prepend(str(tmp_path))  # pyright: ignore[reportUnknownMemberType]
    with pytest.raises(DatumConfigurationError, match="retired_certificates"):
        read_retired_certificates(("package:retired_pkg/../outside.pem",))


def test_the_retired_error_names_the_location_and_the_setting_and_nothing_of_the_file(tmp_path: Path) -> None:
    junk = tmp_path / "old.pem"
    junk.write_text(f"-----BEGIN CERTIFICATE-----\n{MARKER}\n-----END CERTIFICATE-----\n")
    with pytest.raises(DatumConfigurationError) as raised:
        read_retired_certificates((str(junk),))
    text = whole_text(raised.value)
    assert "datum.tsa.retired_certificates" in text
    assert str(junk) in text
    assert MARKER not in text


def test_a_directory_is_not_a_retired_certificate_file(tmp_path: Path) -> None:
    with pytest.raises(DatumConfigurationError, match="retired_certificates"):
        read_retired_certificates((str(tmp_path),))


def test_a_packaged_or_plain_retired_file_over_one_mebibyte_is_refused(
    tmp_path: Path, tsa_pki: TsaPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    package = tmp_path / "big_pkg"
    package.mkdir()
    (package / "__init__.py").write_text("")
    huge = tsa_pki.ec.leaf_pem + b"#" * ((1 << 20) + 1)
    (package / "old.pem").write_bytes(huge)
    plain = tmp_path / "old.pem"
    plain.write_bytes(huge)
    monkeypatch.syspath_prepend(str(tmp_path))  # pyright: ignore[reportUnknownMemberType]
    for location in ("package:big_pkg/old.pem", str(plain)):
        with pytest.raises(DatumConfigurationError, match="retired_certificates"):
            read_retired_certificates((location,))


# -- a setting the chosen signer type cannot use, and the empty password -----------------------------------------------
FOREIGN_SETTINGS = [
    ("PEM", "friendly_name", "datum-tsa"),
    ("PEM", "pkcs12_file", "/etc/datum/tsa.p12"),
    ("PEM", "pkcs12_password", P12_PASSWORD),
    ("PKCS12", "key_password", KEY_PASSWORD),
    ("PKCS12", "key_file", "/etc/datum/tsa-key.pem"),
    ("PKCS12", "cert_file", "/etc/datum/tsa-chain.pem"),
]


@pytest.mark.parametrize(("kind", "name", "value"), FOREIGN_SETTINGS, ids=[f"{k}-{n}" for k, n, _ in FOREIGN_SETTINGS])
def test_a_setting_the_signer_type_cannot_use_stops_the_start_naming_it(
    tmp_path: Path, tsa_pki: TsaPki, kind: str, name: str, value: str
) -> None:
    """Red against the pre-change loader, which ignored the setting and started (each signer is otherwise good)."""
    good = pem_signer(tmp_path, tsa_pki.ec) if kind == "PEM" else pkcs12_signer(tmp_path, tsa_pki.ec)
    assert load(good).chain_der == tsa_pki.ec.chain_der
    signer = with_fields(good, **{name: _secret(value) if name.endswith("password") else value})
    error = refusal_of(signer)
    text = whole_text(error)
    assert f"datum.tsa.signer.{name}" in str(error)
    assert kind in str(error)
    assert not leaks(text, [P12_PASSWORD, KEY_PASSWORD])


@pytest.mark.filterwarnings("ignore::cryptography.utils.CryptographyDeprecationWarning")
@pytest.mark.parametrize("kind", ["PEM", "PKCS12"])
def test_a_signing_certificate_with_a_negative_serial_is_a_named_start_refusal(
    tmp_path: Path, tsa_pki: TsaPki, kind: str
) -> None:
    """Red against the pre-change loader, which started and left a bare ValueError to the authority's construction."""
    identity = tsa_pki.ec
    leaf = make_leaf("negative serial", identity.key, identity.root, identity.root_key, serial=0x7F)
    der = leaf.public_bytes(serialization.Encoding.DER)
    assert der.count(bytes.fromhex("02017f")) == 1
    negative = x509.load_der_x509_certificate(der.replace(bytes.fromhex("02017f"), bytes.fromhex("0201ff"), 1))
    assert negative.serial_number < 0
    if kind == "PEM":
        key_file, cert_file = tmp_path / "key.pem", tmp_path / "chain.pem"
        key_file.write_bytes(identity.key_pem())
        cert_file.write_bytes(negative.public_bytes(serialization.Encoding.PEM) + identity.root_pem)
        signer = TsaSigner.model_validate({"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file)})
    else:
        path = tmp_path / "negative.p12"
        path.write_bytes(
            pkcs12.serialize_key_and_certificates(
                b"datum-tsa",
                identity.key,
                negative,
                [identity.root],
                serialization.BestAvailableEncryption(P12_PASSWORD.encode()),
            )
        )
        signer = TsaSigner.model_validate({"type": "PKCS12", "pkcs12_file": str(path), "pkcs12_password": P12_PASSWORD})
    error = refusal_of(signer)
    assert "the signing certificate's serial is negative, which RFC 5280 forbids" in str(error)
    assert "datum.tsa.signer" in str(error)
    assert not leaks(whole_text(error), [P12_PASSWORD, KEY_PASSWORD])


def test_the_foreign_setting_refusal_comes_before_any_file_is_read(tmp_path: Path) -> None:
    """A PEM signer naming no file at all is refused for its friendly_name, not for the missing key_file."""
    signer = TsaSigner.model_validate({"type": "PEM", "friendly_name": "datum-tsa"})
    text = str(refusal_of(signer))
    assert "friendly_name" in text
    assert "key_file" not in text


@pytest.mark.parametrize("kind", ["PEM", "PKCS12"])
def test_an_empty_password_is_no_password_for_both_kinds(tmp_path: Path, tsa_pki: TsaPki, kind: str) -> None:
    """An empty password of either name is None: it opens an unencrypted key or store and is never a foreign setting.

    Red against a mutant that passes the empty bytes on, or counts an empty password as set.
    """
    if kind == "PEM":
        signer = with_fields(pem_signer(tmp_path, tsa_pki.ec), key_password=_secret(""), pkcs12_password=_secret(""))
    else:
        base = pkcs12_signer(tmp_path, tsa_pki.ec, password=None)
        signer = with_fields(base, pkcs12_password=_secret(""), key_password=_secret(""))
    assert load(signer).chain_der == tsa_pki.ec.chain_der


def test_an_empty_password_does_not_open_an_encrypted_key(tmp_path: Path, tsa_pki: TsaPki) -> None:
    signer = with_fields(pem_signer(tmp_path, tsa_pki.ec, key_password=KEY_PASSWORD), key_password=_secret(""))
    assert "key_password" in str(refusal_of(signer))


def test_the_found_friendly_name_is_quoted_as_a_repr(tmp_path: Path, tsa_pki: TsaPki) -> None:
    """A name read from the file is shown with `!r`, so a quote or a line break in it cannot reshape the message.

    Red against the pre-change message, which wrapped the raw name in double quotes.
    """
    odd = 'tsa"\nforged: yes'
    signer = pkcs12_signer(tmp_path, tsa_pki.ec, key_name=odd, friendly_name="datum-tsa")
    text = str(refusal_of(signer))
    assert repr(odd) in text
    assert "\n" not in text
    assert "'datum-tsa'" in text


def test_only_from_settings_checks_the_constructor_takes_what_it_is_given(tsa_pki: TsaPki) -> None:
    """The constructor never matches the leaf (documented): a key paired with another key's chain is built silently."""
    material = KeyFileTsaKeyMaterial(tsa_pki.ec.key, tsa_pki.rsa.chain_der)
    assert material.chain_der == tsa_pki.rsa.chain_der
    from datum_core.timestamp import keys  # noqa: PLC0415 - the module text is the documentation

    assert "Only `KeyFileTsaKeyMaterial.from_settings` runs these checks" in " ".join((keys.__doc__ or "").split())
    assert "constructor" in (KeyFileTsaKeyMaterial.from_settings.__doc__ or "")


def test_the_friendly_name_description_says_it_is_a_check_never_a_selector() -> None:
    description = TsaSigner.model_fields["friendly_name"].description or ""
    assert "checked against the certificate, never used to choose it" in description
