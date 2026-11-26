"""`PdfTrustPolicy`: where a signer's chain stands, in the catalog's five words.

The policy is a frozen dataclass of `anchors`, `revocation`, `archived_crls`, `archived_ocsp` and `validation_time`
(`PdfValidationTime.NOW` or `SIGNING_TIME`), with the server's own certificates (`site_certificates`) and its replaced
ones (`retired_certificates`) beside them. `standard(signing, site_certificates=)` reads
`datum.pdf.signing.trust_anchors` (and `retired_certificates`) through `read_retired_certificates`, with no revocation,
judged now. Paths are built by `cryptography.x509.verification.PolicyBuilder` with Datum's own extension policies: an
end-entity certificate may carry documentSigning, emailProtection or no extended key usage; a timestamping or serverAuth
leaf is not a document signer's.

`policy.judge(chain, now=, proven_time=)` answers a `PdfTrustVerdict` (the word and, for `trusted`, the instant the
chain was judged at). `proven_time` is what a token verified whole from this server or a trusted authority proves; only
a `SIGNING_TIME` policy moves the judging to it, the revocation check with it, and the signature's own `/M` is not an
input at all. `judge_authority(chain, now=)` judges a timestamp authority's chain, always now. An unknown revocation
status is not trusted, a checker that raises is an unknown status, and the policy makes no network call.
"""

import asyncio
import dataclasses
import datetime as dt
import socket
import subprocess
import sys
from pathlib import Path
from typing import Any

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from pdf_support import anchors_file
from submissions_support import assign
from tsa_support import run_openssl

from datum_core.config.models import Signing
from datum_core.pdf import PdfTrustPolicy
from datum_core.pdf.protocols import PdfTrustVerdict, PdfValidationTime
from datum_core.testing.openssl import requires_openssl
from datum_core.testing.tsa_pki import (
    CRL_URI,
    DOCUMENT_SIGNING,
    EXPIRED_LEAF_SIGNED_AT,
    INSTANT,
    DocumentPki,
    TsaPki,
    build_document_pki,
    bytes_to_pem,
    make_crl,
    make_leaf,
    make_root,
)
from datum_sandbox.checks import DatumConfigurationError

NOW = INSTANT
KINDS = {"site", "site_retired", "trusted", "self_signed", "unknown"}


def pem_of(der: bytes) -> bytes:
    return bytes_to_pem(der)


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def policy_for(pki: DocumentPki, **more: Any) -> PdfTrustPolicy:
    fields: dict[str, Any] = {"anchors": (pki.signer.root_der,)}
    fields.update(more)
    return PdfTrustPolicy(**fields)


def word(policy: PdfTrustPolicy, identity: Any, **more: Any) -> PdfTrustVerdict:
    chain = more.pop("chain", identity.chain_der)
    verdict: PdfTrustVerdict = policy.judge(chain, now=more.pop("now", NOW), **more)
    return verdict


class Checker:
    """A revocation checker that answers a fixed status (or raises) and notes what it was asked."""

    def __init__(self, answer: str | BaseException) -> None:
        self.answer = answer
        self.asked: list[tuple[tuple[bytes, ...], dt.datetime]] = []

    def status(self, chain: Any, moment: dt.datetime, *, crls: Any = (), ocsps: Any = ()) -> Any:
        self.asked.append((tuple(chain), moment))
        if isinstance(self.answer, BaseException):
            raise self.answer
        return self.answer


class NarrowChecker:
    """A checker written before the keywords: it takes no archive, so a call that passes one is a TypeError."""

    def status(self, chain: Any, moment: dt.datetime) -> Any:
        return "good"


# -- the record --------------------------------------------------------------------------------------------------------
def test_the_policy_is_a_frozen_dataclass_with_the_planned_fields(pki: DocumentPki) -> None:
    assert dataclasses.is_dataclass(PdfTrustPolicy)
    names = {field.name for field in dataclasses.fields(PdfTrustPolicy)}
    assert {"anchors", "revocation", "archived_crls", "archived_ocsp", "validation_time"} <= names
    policy = policy_for(pki)
    with pytest.raises(dataclasses.FrozenInstanceError):
        assign(policy, "anchors", ())
    assert policy.revocation is None
    assert policy.validation_time is PdfValidationTime.NOW
    assert policy.archived_crls == ()
    assert policy.archived_ocsp == ()


def test_the_default_summary_names_the_default_policy_with_no_revocation_judged_now(pki: DocumentPki) -> None:
    summary = policy_for(pki).summary()
    assert summary.name == "default"
    assert summary.revocation_checking is False
    assert summary.validation_time == "now"


def test_a_policy_with_a_checker_and_signing_time_says_so_in_its_summary(pki: DocumentPki) -> None:
    summary = policy_for(pki, revocation=Checker("good"), validation_time=PdfValidationTime.SIGNING_TIME).summary()
    assert summary.revocation_checking is True
    assert summary.validation_time == "signing-time"


def test_standard_reads_the_anchors_the_setting_names_and_judges_now_without_revocation(
    tmp_path: Path, pki: DocumentPki
) -> None:
    signing = Signing.model_validate({"trust_anchors": [anchors_file(tmp_path, pki.signer.root_der)]})
    policy = PdfTrustPolicy.standard(signing)
    assert policy.anchors == (pki.signer.root_der,)
    assert policy.revocation is None
    assert policy.validation_time is PdfValidationTime.NOW
    assert word(policy, pki.signer).word == "trusted"


def test_standard_with_no_anchors_trusts_nothing_but_the_sites_own_certificates(pki: DocumentPki) -> None:
    policy = PdfTrustPolicy.standard(Signing(), site_certificates=(pki.signer.leaf_der,))
    assert policy.anchors == ()
    assert word(policy, pki.signer).word == "site"
    assert word(policy, pki.email).word == "unknown"


def test_an_unreadable_anchor_stops_with_the_setting_named(tmp_path: Path) -> None:
    signing = Signing.model_validate({"trust_anchors": [str(tmp_path / "gone.pem")]})
    with pytest.raises(DatumConfigurationError) as raised:
        PdfTrustPolicy.standard(signing)
    assert "datum.pdf.signing.trust_anchors" in str(raised.value)


def test_standard_reads_the_retired_certificates_as_the_retired_ones(tmp_path: Path, pki: DocumentPki) -> None:
    signing = Signing.model_validate({"retired_certificates": [anchors_file(tmp_path, pki.email.leaf_der)]})
    policy = PdfTrustPolicy.standard(signing, site_certificates=(pki.signer.leaf_der,))
    assert word(policy, pki.email).word == "site_retired"
    assert word(policy, pki.signer).word == "site"


# -- the five words ----------------------------------------------------------------------------------------------------
def test_the_servers_own_certificate_reads_site_with_no_anchors_and_no_instant(pki: DocumentPki) -> None:
    verdict = word(PdfTrustPolicy(anchors=(), site_certificates=(pki.signer.leaf_der,)), pki.signer)
    assert verdict == PdfTrustVerdict("site")
    assert verdict.trusted_at is None


def test_a_retired_certificate_reads_site_retired_and_never_site(pki: DocumentPki) -> None:
    policy = policy_for(pki, retired_certificates=(pki.email.leaf_der,), site_certificates=(pki.signer.leaf_der,))
    assert word(policy, pki.email) == PdfTrustVerdict("site_retired")
    assert word(policy, pki.signer) == PdfTrustVerdict("site")


def test_a_retired_certificate_that_has_expired_is_still_site_retired(pki: DocumentPki) -> None:
    policy = policy_for(pki, retired_certificates=(pki.expired.leaf_der,))
    assert word(policy, pki.expired).word == "site_retired"


def test_a_chain_to_an_anchor_reads_trusted_with_the_instant_it_was_judged_at(pki: DocumentPki) -> None:
    verdict = word(policy_for(pki), pki.signer)
    assert verdict.word == "trusted"
    assert verdict.trusted_at == NOW
    assert verdict.trusted_at is not None
    assert verdict.trusted_at.tzinfo is not None


def test_a_self_signed_leaf_that_is_no_anchor_and_no_site_certificate_reads_self_signed() -> None:
    key = rsa.generate_private_key(65537, 2048)
    certificate = make_root("Datum test seal", key)
    verdict = PdfTrustPolicy(anchors=()).judge((certificate.public_bytes(serialization.Encoding.DER),), now=NOW)
    assert verdict == PdfTrustVerdict("self_signed")


def test_a_self_signed_certificate_in_the_anchors_is_not_just_self_signed() -> None:
    key = rsa.generate_private_key(65537, 2048)
    der = make_root("Datum anchor", key).public_bytes(serialization.Encoding.DER)
    assert PdfTrustPolicy(anchors=(der,), site_certificates=(der,)).judge((der,), now=NOW).word == "site"


def test_an_issuer_that_is_no_anchor_reads_unknown(pki: DocumentPki) -> None:
    assert word(policy_for(pki), pki.stranger) == PdfTrustVerdict("unknown")


def test_no_anchors_and_no_site_certificate_reads_unknown_for_an_issued_leaf(pki: DocumentPki) -> None:
    assert word(PdfTrustPolicy(anchors=()), pki.signer) == PdfTrustVerdict("unknown")


def test_every_verdict_word_is_one_of_the_five(pki: DocumentPki) -> None:
    policy = policy_for(pki, site_certificates=(pki.ec.leaf_der,))
    for identity in (pki.signer, pki.ec, pki.email, pki.no_eku, pki.expired, pki.stranger, pki.server_auth):
        assert word(policy, identity).word in KINDS


# -- the look-alike and the site ---------------------------------------------------------------------------------------
def test_a_look_alike_of_the_sites_certificate_is_not_site(pki: DocumentPki) -> None:
    twin = pki.look_alike(pki.signer)
    policy = policy_for(pki, site_certificates=(pki.signer.leaf_der,))
    verdict = policy.judge((twin, pki.signer.root_der), now=NOW)
    assert verdict.word != "site"
    assert verdict.word == "trusted", "it is validly issued by the anchor, only not the site's own certificate"


def test_a_look_alike_without_the_anchor_is_unknown_not_site(pki: DocumentPki) -> None:
    twin = pki.look_alike(pki.signer)
    policy = PdfTrustPolicy(anchors=(), site_certificates=(pki.signer.leaf_der,))
    assert policy.judge((twin,), now=NOW).word == "unknown"


def test_the_site_word_compares_the_whole_certificate_not_the_key_or_the_name(pki: DocumentPki) -> None:
    policy = PdfTrustPolicy(anchors=(), site_certificates=(pki.signer.leaf_der,))
    assert policy.judge((pki.look_alike(pki.signer),), now=NOW).word == "unknown"
    assert policy.judge((pki.signer.leaf_der,), now=NOW).word == "site"


# -- extended key usage ------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["signer", "email", "no_eku", "no_crl_point"])
def test_a_document_signing_an_email_or_a_plain_leaf_is_a_document_signers(pki: DocumentPki, name: str) -> None:
    assert word(policy_for(pki), getattr(pki, name)).word == "trusted"


def test_a_server_auth_leaf_is_not_a_document_signers(pki: DocumentPki) -> None:
    assert word(policy_for(pki), pki.server_auth) == PdfTrustVerdict("unknown")


def test_a_timestamping_leaf_is_not_a_document_signers(tsa_pki: TsaPki) -> None:
    policy = PdfTrustPolicy(anchors=(tsa_pki.rsa.root_der,))
    assert policy.judge(tsa_pki.rsa.chain_der, now=NOW) == PdfTrustVerdict("unknown")


def test_an_ec_leaf_under_an_ec_root_is_trusted_when_that_root_is_the_anchor(pki: DocumentPki) -> None:
    assert word(PdfTrustPolicy(anchors=(pki.ec.root_der,)), pki.ec).word == "trusted"
    assert word(policy_for(pki), pki.ec).word == "unknown"


# -- paths with an intermediate ----------------------------------------------------------------------------------------
def intermediate_chain(
    *, ca_flag: bool = True, ca_usage: tuple[x509.ObjectIdentifier, ...] = ()
) -> tuple[bytes, bytes, bytes]:
    """A leaf issued by an intermediate CA issued by a root that allows one; returns (root, leaf, intermediate) DER.

    `ca_usage` gives the intermediate an extended key usage (none by default).
    """
    root_key = rsa.generate_private_key(65537, 3072)
    root = make_root("Test chained root", root_key, path_length=1)
    ca_key = rsa.generate_private_key(65537, 2048)
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test document intermediate")]))
        .issuer_name(root.subject)
        .public_key(ca_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(root.not_valid_before_utc)
        .not_valid_after(root.not_valid_after_utc)
        .add_extension(x509.BasicConstraints(ca=ca_flag, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(True, False, False, False, False, True, True, False, False), critical=True)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(ca_key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(root_key.public_key()), critical=False)
    )
    if ca_usage:
        builder = builder.add_extension(x509.ExtendedKeyUsage(list(ca_usage)), critical=False)
    ca = builder.sign(root_key, hashes.SHA256())
    leaf_key = rsa.generate_private_key(65537, 2048)
    leaf = make_leaf("Test via intermediate", leaf_key, ca, ca_key, eku=(DOCUMENT_SIGNING,), eku_critical=False)
    der = serialization.Encoding.DER
    return root.public_bytes(der), leaf.public_bytes(der), ca.public_bytes(der)


def test_a_leaf_under_an_intermediate_is_trusted_when_the_chain_carries_the_intermediate() -> None:
    root, leaf, ca = intermediate_chain()
    policy = PdfTrustPolicy(anchors=(root,))
    assert policy.judge((leaf, ca), now=NOW).word == "trusted"
    assert policy.judge((leaf, ca, root), now=NOW).word == "trusted"


def test_a_leaf_whose_intermediate_is_missing_is_unknown_and_the_policy_fetches_nothing() -> None:
    root, leaf, _ca = intermediate_chain()
    assert PdfTrustPolicy(anchors=(root,)).judge((leaf,), now=NOW) == PdfTrustVerdict("unknown")


def test_an_intermediate_that_is_not_a_ca_builds_no_path() -> None:
    root, leaf, not_a_ca = intermediate_chain(ca_flag=False)
    assert PdfTrustPolicy(anchors=(root,)).judge((leaf, not_a_ca), now=NOW).word == "unknown"


@pytest.mark.parametrize(
    "usage",
    [(DOCUMENT_SIGNING,), (ExtendedKeyUsageOID.EMAIL_PROTECTION,), (ExtendedKeyUsageOID.ANY_EXTENDED_KEY_USAGE,)],
)
def test_an_intermediate_whose_usage_allows_a_document_signer_builds_the_path(
    usage: tuple[x509.ObjectIdentifier, ...],
) -> None:
    """The WebPKI CA rules would ask an intermediate with a usage for clientAuth; Datum asks for the leaf's."""
    root, leaf, ca = intermediate_chain(ca_usage=usage)
    assert PdfTrustPolicy(anchors=(root,)).judge((leaf, ca), now=NOW).word == "trusted"


def test_an_intermediate_restricted_to_another_usage_builds_no_path() -> None:
    root, leaf, ca = intermediate_chain(ca_usage=(ExtendedKeyUsageOID.SERVER_AUTH,))
    assert PdfTrustPolicy(anchors=(root,)).judge((leaf, ca), now=NOW) == PdfTrustVerdict("unknown")


# -- anchors that are the signer -------------------------------------------------------------------------------------
def self_signed_signer(*, ca: bool) -> bytes:
    """A self-issued certificate: a CA root when `ca`, else a plain document signer (no CA flag, digitalSignature).

    The signer names its own key identifier as its authority's, as the WebPKI end-entity rules ask of every leaf.
    """
    key = rsa.generate_private_key(65537, 2048)
    if ca:
        return make_root("Test self-signed CA", key).public_bytes(serialization.Encoding.DER)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test self-signed signer")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=30))
        .not_valid_after(NOW + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(True, True, False, False, False, False, False, False, False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([DOCUMENT_SIGNING]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.DER)


def test_a_self_signed_signer_listed_as_an_anchor_is_trusted() -> None:
    der = self_signed_signer(ca=False)
    assert PdfTrustPolicy(anchors=(der,)).judge((der,), now=NOW) == PdfTrustVerdict("trusted", NOW)
    assert PdfTrustPolicy(anchors=()).judge((der,), now=NOW) == PdfTrustVerdict("self_signed")


def test_a_ca_certificate_signing_as_the_leaf_is_no_document_signer_even_as_an_anchor() -> None:
    """The end-entity rules refuse a CA flag on the leaf; listing the root as an anchor trusts what it issues."""
    der = self_signed_signer(ca=True)
    assert PdfTrustPolicy(anchors=(der,)).judge((der,), now=NOW) == PdfTrustVerdict("self_signed")


# -- the record refuses what it cannot use ---------------------------------------------------------------------------
@pytest.mark.parametrize("name", ["anchors", "site_certificates", "retired_certificates"])
def test_a_certificate_field_that_is_not_der_is_refused_at_construction(name: str) -> None:
    fields: dict[str, Any] = {"anchors": (), name: (b"not a certificate",)}
    with pytest.raises(ValueError, match=name):
        PdfTrustPolicy(**fields)


def test_archived_status_without_a_checker_is_refused_at_construction(pki: DocumentPki) -> None:
    crl = make_crl(pki.signer.root, pki.signer.root_key, []).public_bytes(serialization.Encoding.DER)
    with pytest.raises(ValueError, match="revocation checker"):
        policy_for(pki, archived_crls=(crl,))
    with pytest.raises(ValueError, match="archived_crls"):
        policy_for(pki, revocation=Checker("good"), archived_crls=(b"not a crl",))
    with pytest.raises(ValueError, match="archived_ocsp"):
        policy_for(pki, revocation=Checker("good"), archived_ocsp=(b"not ocsp",))


def test_the_archived_status_goes_to_the_checker_with_every_call(pki: DocumentPki) -> None:
    crl = make_crl(pki.signer.root, pki.signer.root_key, []).public_bytes(serialization.Encoding.DER)
    seen: list[tuple[tuple[bytes, ...], tuple[bytes, ...]]] = []

    class Archive:
        def status(self, chain: Any, moment: dt.datetime, *, crls: tuple[bytes, ...], ocsps: tuple[bytes, ...]) -> str:
            seen.append((tuple(crls), tuple(ocsps)))
            return "good"

    policy = policy_for(pki, revocation=Archive(), archived_crls=(crl,))
    assert word(policy, pki.signer) == PdfTrustVerdict("trusted", NOW)
    assert seen == [((crl,), ())]


def test_a_checker_that_cannot_take_the_archive_is_unknown_never_trusted(pki: DocumentPki) -> None:
    crl = make_crl(pki.signer.root, pki.signer.root_key, []).public_bytes(serialization.Encoding.DER)
    narrow = policy_for(pki, revocation=NarrowChecker(), archived_crls=(crl,))
    assert word(narrow, pki.signer).word == "unknown"


def test_the_policy_name_is_the_summarys_name(pki: DocumentPki) -> None:
    assert policy_for(pki, name="archive-2026").summary().name == "archive-2026"


# -- validity and the judging time -------------------------------------------------------------------------------------
def test_an_expired_leaf_is_unknown_now(pki: DocumentPki) -> None:
    assert word(policy_for(pki), pki.expired) == PdfTrustVerdict("unknown")


def test_an_expired_leaf_is_trusted_at_a_proven_signing_time_under_a_signing_time_policy(pki: DocumentPki) -> None:
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    verdict = word(policy, pki.expired, proven_time=EXPIRED_LEAF_SIGNED_AT)
    assert verdict == PdfTrustVerdict("trusted", EXPIRED_LEAF_SIGNED_AT)


def test_under_a_signing_time_policy_with_no_proven_time_the_chain_is_judged_now(pki: DocumentPki) -> None:
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    assert word(policy, pki.expired).word == "unknown"
    assert word(policy, pki.signer) == PdfTrustVerdict("trusted", NOW)


def test_under_a_now_policy_a_proven_time_moves_nothing(pki: DocumentPki) -> None:
    policy = policy_for(pki)
    assert word(policy, pki.expired, proven_time=EXPIRED_LEAF_SIGNED_AT) == PdfTrustVerdict("unknown")
    assert word(policy, pki.signer, proven_time=EXPIRED_LEAF_SIGNED_AT) == PdfTrustVerdict("trusted", NOW)


def test_a_proven_time_before_the_leaf_existed_does_not_trust_it(pki: DocumentPki) -> None:
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    before = pki.expired.leaf.not_valid_before_utc - dt.timedelta(days=1)
    assert word(policy, pki.expired, proven_time=before).word == "unknown"


def test_the_signature_s_own_time_is_not_an_input_of_the_judgement(pki: DocumentPki) -> None:
    import inspect  # noqa: PLC0415 - one use

    parameters = set(inspect.signature(PdfTrustPolicy.judge).parameters)
    assert parameters == {"self", "chain", "now", "proven_time"}


def test_a_naive_moment_is_a_programming_error_not_a_guess(pki: DocumentPki) -> None:
    with pytest.raises(ValueError, match="aware"):
        policy_for(pki).judge(pki.signer.chain_der, now=NOW.replace(tzinfo=None))


# -- a timestamp authority's chain is judged now -----------------------------------------------------------------------
def test_an_authority_chain_to_an_anchor_is_trusted_under_the_timestamp_rules(tsa_pki: TsaPki) -> None:
    policy = PdfTrustPolicy(anchors=(tsa_pki.rsa.root_der,))
    assert policy.judge_authority(tsa_pki.rsa.chain_der, now=NOW) == PdfTrustVerdict("trusted", NOW)


def test_an_authority_chain_under_another_root_is_unknown(tsa_pki: TsaPki) -> None:
    policy = PdfTrustPolicy(anchors=(tsa_pki.ec.root_der,))
    assert policy.judge_authority(tsa_pki.rsa.chain_der, now=NOW) == PdfTrustVerdict("unknown")


def test_the_servers_own_authority_certificate_reads_site(tsa_pki: TsaPki) -> None:
    policy = PdfTrustPolicy(anchors=(), site_certificates=(tsa_pki.rsa.leaf_der,))
    assert policy.judge_authority(tsa_pki.rsa.chain_der, now=NOW).word == "site"


def test_a_document_signing_leaf_is_not_a_timestamp_authority(pki: DocumentPki) -> None:
    assert policy_for(pki).judge_authority(pki.signer.chain_der, now=NOW).word == "unknown"


def test_an_authority_leaf_that_breaks_the_timestamp_rules_is_unknown_though_its_path_builds(tsa_pki: TsaPki) -> None:
    """RFC 3161 section 2.3 by `TsaCertificateRules`: the timeStamping usage must be critical (and the only one)."""
    key = rsa.generate_private_key(65537, 2048)
    root = tsa_pki.rsa
    lax = make_leaf("Test lax TSA", key, root.root, root.root_key, eku_critical=False)
    two = make_leaf(
        "Test two-use TSA",
        key,
        root.root,
        root.root_key,
        eku=(ExtendedKeyUsageOID.TIME_STAMPING, ExtendedKeyUsageOID.EMAIL_PROTECTION),
    )
    policy = PdfTrustPolicy(anchors=(root.root_der,))
    for leaf in (lax, two):
        chain = (leaf.public_bytes(serialization.Encoding.DER), root.root_der)
        assert policy.judge_authority(chain, now=NOW) == PdfTrustVerdict("unknown")


def test_an_authority_is_judged_now_even_under_a_signing_time_policy(tsa_pki: TsaPki) -> None:
    policy = PdfTrustPolicy(anchors=(tsa_pki.rsa.root_der,), validation_time=PdfValidationTime.SIGNING_TIME)
    later = tsa_pki.rsa.leaf.not_valid_after_utc + dt.timedelta(days=1)
    assert policy.judge_authority(tsa_pki.rsa.chain_der, now=later).word == "unknown"


# -- revocation --------------------------------------------------------------------------------------------------------
def test_a_good_status_keeps_the_chain_trusted_and_the_checker_is_asked_with_the_chain_and_the_moment(
    pki: DocumentPki,
) -> None:
    checker = Checker("good")
    policy = policy_for(pki, revocation=checker)
    assert word(policy, pki.signer) == PdfTrustVerdict("trusted", NOW)
    ((chain, moment),) = checker.asked
    assert chain[0] == pki.signer.leaf_der
    assert moment == NOW


@pytest.mark.parametrize("status", ["revoked", "unknown"])
def test_a_revoked_or_unknown_status_is_not_trusted(pki: DocumentPki, status: str) -> None:
    assert word(policy_for(pki, revocation=Checker(status)), pki.signer) == PdfTrustVerdict("unknown")


def test_a_checker_that_raises_is_an_unknown_status_never_a_trusted_one(pki: DocumentPki) -> None:
    for error in (RuntimeError("boom"), OSError("network"), ValueError("bad crl")):
        assert word(policy_for(pki, revocation=Checker(error)), pki.signer) == PdfTrustVerdict("unknown")


def test_a_checker_that_answers_a_word_outside_the_three_is_not_trusted(pki: DocumentPki) -> None:
    assert word(policy_for(pki, revocation=Checker("maybe")), pki.signer).word == "unknown"


def test_the_revocation_check_moves_back_with_the_judging_time(pki: DocumentPki) -> None:
    checker = Checker("good")
    policy = policy_for(pki, revocation=checker, validation_time=PdfValidationTime.SIGNING_TIME)
    assert word(policy, pki.expired, proven_time=EXPIRED_LEAF_SIGNED_AT) == PdfTrustVerdict(
        "trusted", EXPIRED_LEAF_SIGNED_AT
    )
    ((_chain, moment),) = checker.asked
    assert moment == EXPIRED_LEAF_SIGNED_AT


def test_a_chain_that_builds_no_path_is_never_sent_to_the_checker(pki: DocumentPki) -> None:
    checker = Checker("good")
    assert word(policy_for(pki, revocation=checker), pki.stranger).word == "unknown"
    assert checker.asked == []


def test_the_site_and_retired_words_do_not_consult_the_checker(pki: DocumentPki) -> None:
    checker = Checker("revoked")
    policy = policy_for(
        pki, revocation=checker, site_certificates=(pki.signer.leaf_der,), retired_certificates=(pki.email.leaf_der,)
    )
    assert word(policy, pki.signer).word == "site"
    assert word(policy, pki.email).word == "site_retired"
    assert checker.asked == []


# -- no network, no cost -----------------------------------------------------------------------------------------------
def test_judging_makes_no_network_call_and_imports_no_certvalidator_stack(
    pki: DocumentPki, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[str] = []

    def refuse(name: str) -> Any:
        def inner(*_a: object, **_k: object) -> None:
            calls.append(name)
            raise OSError("network blocked")

        return inner

    for name in ("connect", "connect_ex"):
        monkeypatch.setattr(socket.socket, name, refuse(name))
    monkeypatch.setattr(socket, "create_connection", refuse("create_connection"))
    monkeypatch.setattr(socket, "getaddrinfo", refuse("getaddrinfo"))
    policy = policy_for(pki)
    answers = {
        name: word(policy, getattr(pki, name)).word
        for name in ("signer", "email", "stranger", "expired", "no_crl_point")
    }
    assert answers == {
        "signer": "trusted",
        "email": "trusted",
        "stranger": "unknown",
        "expired": "unknown",
        "no_crl_point": "trusted",
    }
    assert calls == []
    assert CRL_URI.endswith(".crl")


def test_judging_imports_no_certvalidator_stack(tmp_path: Path, pki: DocumentPki) -> None:
    """A fresh interpreter judges one chain, so test order cannot put aiohttp or oscrypto in sys.modules."""
    root = tmp_path / "root.der"
    leaf = tmp_path / "leaf.der"
    root.write_bytes(pki.signer.root_der)
    leaf.write_bytes(pki.signer.leaf_der)
    code = (
        "import sys, pathlib, datetime as dt\n"
        "from datum_core.pdf import PdfTrustPolicy\n"
        "root, leaf = (pathlib.Path(a).read_bytes() for a in sys.argv[1:3])\n"
        "verdict = PdfTrustPolicy(anchors=(root,)).judge((leaf, root), now=dt.datetime.now(dt.timezone.utc))\n"
        "assert verdict.word == 'trusted', verdict\n"
        "assert 'oscrypto' not in sys.modules and 'aiohttp' not in sys.modules\n"
    )
    argv = [sys.executable, "-I", "-c", code, str(root), str(leaf)]
    done = subprocess.run(argv, capture_output=True, text=True, check=False)  # noqa: S603
    assert done.returncode == 0, done.stderr


# -- openssl agrees ----------------------------------------------------------------------------------------------------
@requires_openssl
@pytest.mark.parametrize(
    ("name", "at", "expected"),
    [
        ("signer", None, True),
        ("email", None, True),
        ("no_eku", None, True),
        ("stranger", None, False),
        ("expired", None, False),
        ("expired", EXPIRED_LEAF_SIGNED_AT, True),
    ],
)
def test_a_path_the_builder_accepts_is_accepted_by_openssl_and_a_refused_one_refused(
    tmp_path: Path, pki: DocumentPki, name: str, at: dt.datetime | None, expected: bool
) -> None:
    identity = getattr(pki, name)
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    judged = policy.judge(identity.chain_der, now=NOW, proven_time=at)
    assert (judged.word == "trusted") is expected
    root = tmp_path / "root.pem"
    leaf = tmp_path / "leaf.pem"
    root.write_bytes(pki.signer.root_pem)
    leaf.write_bytes(identity.leaf_pem)
    args = ["verify", "-purpose", "any", "-CAfile", str(root), str(leaf)]
    if at is not None:
        args[1:1] = ["-attime", str(int(at.timestamp()))]
    assert (run_openssl(*args).returncode == 0) is expected


def test_the_eku_rows_openssl_purpose_any_does_not_judge_are_the_builders_alone(pki: DocumentPki) -> None:
    """`-purpose any` accepts a serverAuth leaf; Datum does not, by its own extension policies (not a bug)."""
    assert word(policy_for(pki), pki.server_auth).word == "unknown"
    assert ExtendedKeyUsageOID.SERVER_AUTH not in {DOCUMENT_SIGNING, ExtendedKeyUsageOID.EMAIL_PROTECTION}


# -- the authority judgement ---------------------------------------------------------------------------------
def test_the_authority_judgement_takes_no_time_but_now() -> None:
    import inspect  # noqa: PLC0415 - one use

    assert set(inspect.signature(PdfTrustPolicy.judge_authority).parameters) == {"self", "chain", "now"}


def test_a_leaf_with_any_extended_key_usage_alone_is_not_a_document_signer(pki: DocumentPki) -> None:
    key = rsa.generate_private_key(65537, 2048)
    leaf = make_leaf(
        "Test any usage",
        key,
        pki.signer.root,
        pki.signer.root_key,
        eku=(ExtendedKeyUsageOID.ANY_EXTENDED_KEY_USAGE,),
        eku_critical=False,
    )
    der = leaf.public_bytes(serialization.Encoding.DER)
    assert PdfTrustPolicy(anchors=(pki.signer.root_der,)).judge((der,), now=NOW) == PdfTrustVerdict("unknown")


def test_a_certificate_with_the_sites_subject_and_issuer_but_another_key_is_not_site(pki: DocumentPki) -> None:
    key = rsa.generate_private_key(65537, 2048)
    leaf = make_leaf(
        "Test document signer", key, pki.signer.root, pki.signer.root_key, eku=(DOCUMENT_SIGNING,), eku_critical=False
    )
    assert leaf.subject == pki.signer.leaf.subject
    policy = PdfTrustPolicy(anchors=(), site_certificates=(pki.signer.leaf_der,))
    assert policy.judge((leaf.public_bytes(serialization.Encoding.DER),), now=NOW).word == "unknown"


def test_a_self_issued_leaf_whose_signature_does_not_verify_is_unknown_not_self_signed() -> None:
    key, other = rsa.generate_private_key(65537, 2048), rsa.generate_private_key(65537, 2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test forged self-issued")])
    forged = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=1))
        .not_valid_after(NOW + dt.timedelta(days=1))
        .sign(other, hashes.SHA256())
    )
    der = forged.public_bytes(serialization.Encoding.DER)
    assert PdfTrustPolicy(anchors=()).judge((der,), now=NOW) == PdfTrustVerdict("unknown")


@pytest.mark.parametrize("shape", ["junk-leaf", "junk-issuer", "empty"])
def test_a_chain_holding_anything_unreadable_is_unknown(pki: DocumentPki, shape: str) -> None:
    chains = {
        "junk-leaf": (b"junk", pki.signer.leaf_der, pki.signer.root_der),
        "junk-issuer": (pki.signer.leaf_der, b"junk"),
        "empty": (),
    }
    policy = PdfTrustPolicy(anchors=(pki.signer.root_der,), site_certificates=(pki.ec.leaf_der,))
    assert policy.judge(chains[shape], now=NOW) == PdfTrustVerdict("unknown")
    assert policy.judge_authority(chains[shape], now=NOW) == PdfTrustVerdict("unknown")


# -- key usage, a future proven time, the built path, anchors, cancellation ----------------------------
def leaf_with_usage(pki: DocumentPki, usage: x509.KeyUsage | None) -> bytes:
    """A document-signing leaf under the signer's root with the given KeyUsage (None leaves the extension out)."""
    key = rsa.generate_private_key(65537, 2048)
    builder = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test key usage signer")]))
        .issuer_name(pki.signer.root.subject)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=30))
        .not_valid_after(NOW + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([DOCUMENT_SIGNING]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(
            x509.AuthorityKeyIdentifier.from_issuer_public_key(pki.signer.root_key.public_key()), critical=False
        )
    )
    if usage is not None:
        builder = builder.add_extension(usage, critical=True)
    return builder.sign(pki.signer.root_key, hashes.SHA256()).public_bytes(serialization.Encoding.DER)


def key_usage(**flags: bool) -> x509.KeyUsage:
    names = (
        "digital_signature",
        "content_commitment",
        "key_encipherment",
        "data_encipherment",
        "key_agreement",
        "key_cert_sign",
        "crl_sign",
        "encipher_only",
        "decipher_only",
    )
    return x509.KeyUsage(**{name: flags.get(name, False) for name in names})


@pytest.mark.parametrize(
    ("usage", "expected"),
    [
        (key_usage(key_encipherment=True), "unknown"),
        (key_usage(key_agreement=True, data_encipherment=True), "unknown"),
        (key_usage(digital_signature=True), "trusted"),
        (key_usage(content_commitment=True), "trusted"),
        (key_usage(digital_signature=True, key_encipherment=True), "trusted"),
        (None, "trusted"),
    ],
    ids=["key-encipherment-only", "agreement-only", "digital-signature", "content-commitment", "mixed", "absent"],
)
def test_a_leaf_with_a_key_usage_must_carry_digital_signature_or_content_commitment(
    pki: DocumentPki, usage: x509.KeyUsage | None, expected: str
) -> None:
    der = leaf_with_usage(pki, usage)
    assert PdfTrustPolicy(anchors=(pki.signer.root_der,)).judge((der,), now=NOW).word == expected


def test_a_proven_time_later_than_now_is_not_usable_the_policy_judges_now_and_says_so(pki: DocumentPki) -> None:
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    verdict = word(policy, pki.signer, proven_time=NOW + dt.timedelta(days=2))
    assert verdict.word == "trusted"
    assert verdict.trusted_at == NOW
    assert verdict.reason is not None
    assert "later than now" in verdict.reason
    assert word(policy, pki.signer, proven_time=NOW - dt.timedelta(days=2)).reason is None
    assert word(policy, pki.signer).reason is None


def test_a_future_proven_time_does_not_trust_what_now_does_not(pki: DocumentPki) -> None:
    """An expired leaf is not rescued by a token dated after now: the judging falls back to now, where it fails."""
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    verdict = word(policy, pki.expired, proven_time=NOW + dt.timedelta(days=1))
    assert verdict.word == "unknown"
    assert verdict.reason is not None
    assert "later than now" in verdict.reason


def test_a_now_policy_has_no_reason_for_a_future_proven_time(pki: DocumentPki) -> None:
    assert word(policy_for(pki), pki.signer, proven_time=NOW + dt.timedelta(days=2)) == PdfTrustVerdict("trusted", NOW)


def test_a_naive_proven_time_is_a_programming_error_not_a_guess(pki: DocumentPki) -> None:
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    with pytest.raises(ValueError, match="aware"):
        policy.judge(pki.signer.chain_der, now=NOW, proven_time=NOW.replace(tzinfo=None))
    with pytest.raises(ValueError, match="proven_time"):
        policy_for(pki).judge(pki.signer.chain_der, now=NOW, proven_time=NOW.replace(tzinfo=None))


def test_the_checker_is_asked_about_the_built_path_not_the_chain_as_handed_in(pki: DocumentPki) -> None:
    checker = Checker("good")
    policy = policy_for(pki, revocation=checker)
    handed = (pki.signer.leaf_der, pki.stranger.root_der, pki.ec.leaf_der, pki.signer.root_der)
    assert policy.judge(handed, now=NOW) == PdfTrustVerdict("trusted", NOW)
    ((asked, _moment),) = checker.asked
    assert asked == (pki.signer.leaf_der, pki.signer.root_der)


def test_a_path_that_is_only_an_anchor_reads_unknown_when_revocation_is_asked(pki: DocumentPki) -> None:
    """A leaf listed as an anchor has no issuer to hold a status: nothing was looked up, so it is never `good`."""
    der = self_signed_signer(ca=False)
    checker = Checker("good")
    assert PdfTrustPolicy(anchors=(der,), revocation=checker).judge((der,), now=NOW) == PdfTrustVerdict("unknown")
    assert checker.asked == []


def test_a_checker_cancelled_inside_is_an_unknown_status(pki: DocumentPki) -> None:
    assert word(policy_for(pki, revocation=Checker(asyncio.CancelledError())), pki.signer) == PdfTrustVerdict("unknown")


def test_an_interrupt_in_the_checker_still_propagates(pki: DocumentPki) -> None:
    with pytest.raises(KeyboardInterrupt):
        word(policy_for(pki, revocation=Checker(KeyboardInterrupt())), pki.signer)


@requires_openssl
@pytest.mark.parametrize(("with_intermediate", "expected"), [(True, True), (False, False)], ids=["present", "missing"])
def test_openssl_agrees_on_a_path_through_an_intermediate_given_as_untrusted(
    tmp_path: Path, with_intermediate: bool, expected: bool
) -> None:
    root, leaf, ca = intermediate_chain()
    judged = PdfTrustPolicy(anchors=(root,)).judge((leaf, ca) if with_intermediate else (leaf,), now=NOW)
    assert (judged.word == "trusted") is expected
    for name, der in (("root", root), ("leaf", leaf), ("ca", ca)):
        (tmp_path / f"{name}.pem").write_bytes(pem_of(der))
    args = ["verify", "-purpose", "any", "-attime", str(int(NOW.timestamp())), "-CAfile", str(tmp_path / "root.pem")]
    if with_intermediate:
        args += ["-untrusted", str(tmp_path / "ca.pem")]
    assert (run_openssl(*args, str(tmp_path / "leaf.pem")).returncode == 0) is expected


# -- the edges of the proven time, the key usage of an anchor, the order of a chain ----------------------
def test_a_proven_time_equal_to_now_is_usable_and_carries_no_reason(pki: DocumentPki) -> None:
    policy = policy_for(pki, validation_time=PdfValidationTime.SIGNING_TIME)
    assert word(policy, pki.signer, proven_time=NOW) == PdfTrustVerdict("trusted", NOW)
    assert word(policy, pki.signer, proven_time=NOW).reason is None


def key_encipherment_only_signer() -> bytes:
    """A self-issued leaf whose key usage is keyEncipherment alone: it may not sign documents."""
    key = rsa.generate_private_key(65537, 2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "Test key-encipherment signer")])
    certificate = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(NOW - dt.timedelta(days=30))
        .not_valid_after(NOW + dt.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.KeyUsage(False, False, True, False, False, False, False, False, False), critical=True)
        .add_extension(x509.ExtendedKeyUsage([DOCUMENT_SIGNING]), critical=False)
        .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
        .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(key.public_key()), critical=False)
        .sign(key, hashes.SHA256())
    )
    return certificate.public_bytes(serialization.Encoding.DER)


def test_a_self_issued_key_encipherment_only_leaf_listed_as_an_anchor_reads_self_signed() -> None:
    der = key_encipherment_only_signer()
    assert PdfTrustPolicy(anchors=(der,)).judge((der,), now=NOW) == PdfTrustVerdict("self_signed")


def test_the_checker_is_asked_about_the_built_path_whatever_order_the_chain_came_in() -> None:
    root, leaf, ca = intermediate_chain()
    unrelated = build_document_pki().stranger.root_der
    checker = Checker("good")
    policy = PdfTrustPolicy(anchors=(root,), revocation=checker)
    assert policy.judge((leaf, unrelated, root, ca), now=NOW) == PdfTrustVerdict("trusted", NOW)
    ((asked, _moment),) = checker.asked
    assert asked == (leaf, ca, root)


@requires_openssl
def test_openssl_agrees_that_an_intermediate_without_the_ca_flag_builds_no_path(tmp_path: Path) -> None:
    root, leaf, not_a_ca = intermediate_chain(ca_flag=False)
    assert PdfTrustPolicy(anchors=(root,)).judge((leaf, not_a_ca), now=NOW).word == "unknown"
    for name, der in (("root", root), ("leaf", leaf), ("ca", not_a_ca)):
        (tmp_path / f"{name}.pem").write_bytes(pem_of(der))
    args = ["verify", "-purpose", "any", "-attime", str(int(NOW.timestamp())), "-CAfile", str(tmp_path / "root.pem")]
    args += ["-untrusted", str(tmp_path / "ca.pem"), str(tmp_path / "leaf.pem")]
    assert run_openssl(*args).returncode != 0
