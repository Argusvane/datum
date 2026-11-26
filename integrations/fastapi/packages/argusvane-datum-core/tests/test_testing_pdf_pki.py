"""The document-signing half of `datum_core.testing.tsa_pki`: the certificates a PDF trust test needs.

A trust test is only as good as its certificates, so the PKI is checked on its own, against `cryptography` and, where
the binary is present, against `openssl` (`-m openssl`): each kind is the kind its name says, the look-alike is a real
look-alike, and the CRL builder writes a CRL both libraries read. Nothing here needs the PDF host, so these tests run on
their own.
"""

import datetime as dt
import time
from pathlib import Path
from typing import Any, cast

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from tsa_support import run_openssl

from datum_core.testing.openssl import requires_openssl
from datum_core.testing.tsa_pki import (
    CRL_URI,
    DOCUMENT_SIGNING,
    EXPIRED_LEAF_SIGNED_AT,
    INSTANT,
    DocumentPki,
    TsaIdentity,
    build_document_pki,
    build_pki,
    bytes_to_pem,
    make_crl,
)


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def usages(identity: TsaIdentity) -> set[x509.ObjectIdentifier] | None:
    try:
        return set(identity.leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).value)
    except x509.ExtensionNotFound:
        return None


def common_name(certificate: x509.Certificate) -> str:
    return str(certificate.subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value)


def test_the_pki_builds_in_a_few_seconds_with_fresh_keys_each_time() -> None:
    started = time.monotonic()
    first = build_document_pki()
    assert time.monotonic() - started < 3.0, "the 3 s rule"
    second = build_document_pki()
    assert first.signer.leaf_der != second.signer.leaf_der
    assert first.signer.root_der != second.signer.root_der


def test_the_signer_is_an_rsa_2048_leaf_with_the_document_signing_eku_under_an_rsa_3072_root(pki: DocumentPki) -> None:
    assert usages(pki.signer) == {DOCUMENT_SIGNING}
    assert DOCUMENT_SIGNING.dotted_string == "1.3.6.1.5.5.7.3.36"
    assert isinstance(pki.signer.key, rsa.RSAPrivateKey)
    assert pki.signer.key.key_size == 2048
    assert isinstance(pki.signer.root_key, rsa.RSAPrivateKey)
    assert pki.signer.root_key.key_size == 3072
    assert pki.signer.leaf.issuer == pki.signer.root.subject


def test_the_ec_signer_is_a_p256_leaf_under_a_p384_root_of_its_own(pki: DocumentPki) -> None:
    assert isinstance(pki.ec.key, ec.EllipticCurvePrivateKey)
    assert pki.ec.key.curve.name == "secp256r1"
    assert isinstance(pki.ec.root_key, ec.EllipticCurvePrivateKey)
    assert pki.ec.root_key.curve.name == "secp384r1"
    assert pki.ec.root_der != pki.signer.root_der
    assert usages(pki.ec) == {DOCUMENT_SIGNING}


def test_the_other_leaves_are_what_their_names_say(pki: DocumentPki) -> None:
    assert usages(pki.email) == {ExtendedKeyUsageOID.EMAIL_PROTECTION}
    assert usages(pki.no_eku) is None
    assert usages(pki.server_auth) == {ExtendedKeyUsageOID.SERVER_AUTH}
    assert usages(pki.no_crl_point) == {DOCUMENT_SIGNING}
    for sibling in (pki.email, pki.no_eku, pki.server_auth, pki.expired, pki.no_crl_point):
        assert sibling.root_der == pki.signer.root_der, "one anchor trusts them all"
        assert sibling.leaf.issuer == pki.signer.root.subject


def test_the_stranger_is_issued_by_a_root_nobody_trusts(pki: DocumentPki) -> None:
    assert pki.stranger.root_der != pki.signer.root_der
    assert usages(pki.stranger) == {DOCUMENT_SIGNING}
    assert pki.stranger.leaf.issuer == pki.stranger.root.subject != pki.signer.root.subject


def test_the_expired_leaf_is_expired_now_and_valid_at_the_earlier_moment(pki: DocumentPki) -> None:
    leaf = pki.expired.leaf
    assert leaf.not_valid_after_utc < INSTANT
    assert leaf.not_valid_before_utc <= EXPIRED_LEAF_SIGNED_AT <= leaf.not_valid_after_utc
    root = pki.expired.root
    assert root.not_valid_before_utc <= EXPIRED_LEAF_SIGNED_AT, "the root covers the earlier moment too"
    assert pki.signer.leaf.not_valid_before_utc <= INSTANT <= pki.signer.leaf.not_valid_after_utc


def test_the_leaves_name_a_crl_distribution_point_except_the_one_made_without(pki: DocumentPki) -> None:
    def points(identity: TsaIdentity) -> list[str]:
        try:
            ext = identity.leaf.extensions.get_extension_for_class(x509.CRLDistributionPoints).value
        except x509.ExtensionNotFound:
            return []
        return [name.value for point in ext for name in (point.full_name or [])]

    for identity in (pki.signer, pki.ec, pki.email, pki.no_eku, pki.expired, pki.stranger):
        assert points(identity) == [CRL_URI]
    assert points(pki.no_crl_point) == []
    assert CRL_URI.startswith("http://")
    assert ".invalid/" in CRL_URI, "a name that can never be fetched"


def test_the_look_alike_has_the_leafs_key_issuer_and_serial_but_another_subject_and_every_length_the_same(
    pki: DocumentPki,
) -> None:
    twin = x509.load_der_x509_certificate(pki.look_alike(pki.signer))
    leaf = pki.signer.leaf
    twin_key: Any = twin.public_key()
    leaf_key: Any = leaf.public_key()
    assert twin_key.public_numbers() == leaf_key.public_numbers()
    assert twin.issuer == leaf.issuer
    assert twin.serial_number == leaf.serial_number
    assert twin.subject != leaf.subject
    assert len(common_name(twin)) == len(common_name(leaf))
    assert len(twin.public_bytes(serialization.Encoding.DER)) == len(pki.signer.leaf_der)
    assert twin.public_bytes(serialization.Encoding.DER) != pki.signer.leaf_der
    # it is a certificate the root really issued: only its name differs, so only an exact comparison tells them apart
    root_key: Any = pki.signer.root.public_key()
    root_key.verify(twin.signature, twin.tbs_certificate_bytes, padding.PKCS1v15(), twin.signature_hash_algorithm)
    assert usages(TsaIdentity("twin", pki.signer.root_key, pki.signer.root, pki.signer.key, twin)) == {DOCUMENT_SIGNING}


def test_a_crl_lists_the_serials_it_is_given_and_is_signed_by_the_issuer(pki: DocumentPki) -> None:
    when = dt.datetime(2026, 6, 1, tzinfo=dt.UTC)
    crl = make_crl(pki.signer.root, pki.signer.root_key, [(pki.signer.leaf.serial_number, when)])
    assert crl.is_signature_valid(cast("Any", pki.signer.root.public_key()))
    assert crl.issuer == pki.signer.root.subject
    assert crl.last_update_utc == INSTANT
    assert crl.next_update_utc == INSTANT + dt.timedelta(days=7)
    (entry,) = list(crl)
    assert entry.serial_number == pki.signer.leaf.serial_number
    assert entry.revocation_date_utc == when
    assert crl.get_revoked_certificate_by_serial_number(pki.email.leaf.serial_number) is None
    numbers = crl.extensions.get_extension_for_class(x509.CRLNumber).value
    assert numbers.crl_number == 1
    crl.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier)


def test_a_crl_takes_its_own_window_and_number(pki: DocumentPki) -> None:
    start = dt.datetime(2026, 1, 2, tzinfo=dt.UTC)
    crl = make_crl(
        pki.ec.root, pki.ec.root_key, this_update=start, next_update=start + dt.timedelta(days=1), crl_number=7
    )
    assert crl.is_signature_valid(cast("Any", pki.ec.root.public_key()))
    assert list(crl) == []
    assert crl.next_update_utc == start + dt.timedelta(days=1)
    assert crl.extensions.get_extension_for_class(x509.CRLNumber).value.crl_number == 7


def test_the_timestamp_pki_is_unchanged_by_the_extension() -> None:
    old = build_pki()
    assert old.wrong_eku.leaf.extensions.get_extension_for_class(x509.ExtendedKeyUsage).critical is True
    assert usages(old.rsa) == {ExtendedKeyUsageOID.TIME_STAMPING}
    assert [type(e.value).__name__ for e in old.rsa.leaf.extensions][:3] == [
        "BasicConstraints",
        "KeyUsage",
        "ExtendedKeyUsage",
    ]


@requires_openssl
def test_openssl_agrees_with_the_chain_facts(pki: DocumentPki, tmp_path: Path) -> None:
    directory = tmp_path
    root = directory / "root.pem"
    root.write_bytes(pki.signer.root_pem)

    def verdict(identity: TsaIdentity, *more: str) -> int:
        leaf = directory / f"{identity.name}.pem"
        leaf.write_bytes(identity.leaf_pem)
        return run_openssl("verify", "-purpose", "any", *more, "-CAfile", str(root), str(leaf)).returncode

    for accepted in (pki.signer, pki.email, pki.no_eku, pki.no_crl_point):
        assert verdict(accepted) == 0, accepted.name
    assert verdict(pki.stranger) != 0
    assert verdict(pki.expired) != 0, "expired now"
    assert verdict(pki.expired, "-attime", str(int(EXPIRED_LEAF_SIGNED_AT.timestamp()))) == 0, (
        "valid at the earlier moment"
    )


@requires_openssl
def test_openssl_reads_and_verifies_the_crl(pki: DocumentPki, tmp_path: Path) -> None:
    directory = tmp_path
    crl = make_crl(pki.signer.root, pki.signer.root_key, [(pki.signer.leaf.serial_number, INSTANT)])
    (directory / "crl.pem").write_bytes(crl.public_bytes(serialization.Encoding.PEM))
    (directory / "root.pem").write_bytes(pki.signer.root_pem)
    done = run_openssl(
        "crl", "-in", str(directory / "crl.pem"), "-noout", "-CAfile", str(directory / "root.pem"), "-verify"
    )
    assert done.returncode == 0, done.stderr
    text = run_openssl("crl", "-in", str(directory / "crl.pem"), "-noout", "-text").stdout.decode()
    assert format(pki.signer.leaf.serial_number, "X") in text.upper()
    assert bytes_to_pem(pki.signer.root_der).startswith(b"-----BEGIN CERTIFICATE-----")
