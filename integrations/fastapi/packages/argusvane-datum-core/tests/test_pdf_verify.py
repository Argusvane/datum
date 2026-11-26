"""`PdfService.verify`.

The kernel is the authority on a file's structure; the host checks the VALUES and decides TRUST, and fails closed. For
each signature the report holds `value` (`valid`, `invalid` or `unchecked`: `toBeVerified` under `signer.publicKey` with
`cryptography`, SHA-256, SHA-384 or SHA-512 on RSA PKCS#1 v1.5 or ECDSA), the kernel's `digest_matches`,
`certificate_matches` and `covers_document`, `intact` (digest, binding and value all hold, and either nothing follows
the signature or the changes that follow are permitted by a certification whose every relied-on signature is itself
intact), `trust` (a word of the trust policy) and `trusted_at`. A signature is NEVER intact when: its value is not
`valid`; the kernel's digest or binding fact is false; it does not cover the document and the kernel gave no
`laterRevisions`, or `permitted` is not true; the `reliedOnSignatures` list is missing or unreadable;
a signature it relies on is not itself intact (every `reliedOnSignatures`
entry is matched by field AND byte range; an empty field or an unmatched entry counts as invalid). A timestamp is
`timestamped` only when every fact the kernel reports holds AND `TimestampToken.verify_over(value, known_certificates)`
finds nothing wrong; any disagreement reads not timestamped, with a warning. `SIGNING_TIME` moves the judging of the
chain to the time a timestamp proved, never to the signature's `/M`.

The scripted program here answers `verify` with reports whose values are really valid (or, with `forge`, really not), so
the value check is not something the double does for the code under test.
"""

import hashlib
from datetime import UTC, datetime, timedelta
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID
from pdf_kernel import ec_sign, rsa_sign
from pdf_support import (
    ABI,
    PdfRig,
    anchors_file,
    b64,
    fake_pdf,
    later_revisions,
    signature_report,
    started_pdf,
    timestamp_report,
    verify_reply,
)
from tsa_support import make_authority

from datum_core.pdf import PdfTrustPolicy, PdfVerifyReport
from datum_core.pdf.outcomes import NotAPdf, Unreadable, Verified
from datum_core.pdf.protocols import PdfValidationTime
from datum_core.submissions import Throttled, TooLarge, Unavailable
from datum_core.testing.tsa_pki import (
    EXPIRED_LEAF_SIGNED_AT,
    INSTANT,
    DocumentPki,
    TsaIdentity,
    TsaPki,
    build_document_pki,
    make_root,
)

DATA = fake_pdf("signed file") + b"x" * 64


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def policy(pki: DocumentPki, tsa: TsaPki | None = None, **more: Any) -> PdfTrustPolicy:
    anchors = (pki.signer.root_der, *((tsa.rsa.root_der,) if tsa is not None else ()))
    fields: dict[str, Any] = {"anchors": anchors, **more}
    return PdfTrustPolicy(**fields)


def verified(rig: PdfRig, *reports: dict[str, Any], data: bytes = DATA, **more: Any) -> Any:
    rig.runtime.on("verify", lambda _request: verify_reply(*reports, **more))
    outcome = rig.verify(data)
    assert isinstance(outcome, Verified), outcome
    return outcome.report


def first(rig: PdfRig, report: dict[str, Any], **more: Any) -> Any:
    return verified(rig, report, **more).signatures[0]


# -- the report -------------------------------------------------------------------------------------------------------
def test_the_report_names_the_file_by_its_hash_and_size_and_each_signature_by_its_verdict(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, signature_report(pki.signer))
    assert isinstance(report, PdfVerifyReport)
    assert report.sha256 == hashlib.sha256(DATA).hexdigest()
    assert report.size == len(DATA)
    (verdict,) = report.signatures
    assert (verdict.field, verdict.value, verdict.intact, verdict.trust) == ("Signature1", "valid", True, "trusted")
    assert verdict.digest_matches
    assert verdict.certificate_matches
    assert verdict.covers_document
    assert verdict.signing_time == "2026-10-20T12:00:00Z"
    assert verdict.trusted_at == INSTANT


def test_the_program_is_asked_with_the_file_and_the_known_certificates(pki: DocumentPki) -> None:
    with started_pdf(signer=pki.signer, pdf_trust_policy=policy(pki)) as rig:
        verified(rig, signature_report(pki.signer))
        (request,) = rig.runtime.requests("verify")
    assert request["pdf"]["data"] == b64(DATA)
    assert request["abi"] == ABI
    assert b64(pki.signer.leaf_der) in request["knownCertificates"]
    assert b64(pki.signer.root_der) in request["knownCertificates"]


def test_the_known_certificates_never_pass_the_kernels_caps(pki: DocumentPki, tmp_path: Path) -> None:
    """The kernel refuses more than 64 known certificates (`invalid_request`): the host sends at most that many."""
    many = [
        make_root(f"Retired {index}", ec.generate_private_key(ec.SECP256R1())).public_bytes(serialization.Encoding.DER)
        for index in range(70)
    ]
    retired = anchors_file(tmp_path, *many, name="retired.pem")
    config = {"pdf": {"signing": {"retired_certificates": [retired]}}}
    with started_pdf(config, signer=pki.signer) as rig:
        verified(rig, signature_report(pki.signer))
        (request,) = rig.runtime.requests("verify")
    known = request["knownCertificates"]
    assert 1 <= len(known) <= 64
    assert b64(pki.signer.leaf_der) in known, "the server's own certificate is the one that must not be cut"
    assert all(len(item) <= (16 * 1024 * 4) // 3 + 4 for item in known)


def test_the_documents_id_is_the_signed_one_when_a_signature_is_intact_and_the_current_claim_otherwise(
    pki: DocumentPki,
) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        intact = verified(rig, signature_report(pki.signer, signed_document_id="11" * 16), document_id="22" * 16)
        broken = verified(
            rig, signature_report(pki.signer, forge=True, signed_document_id="11" * 16), document_id="22" * 16
        )
        none = verified(rig, document_id=None)
    assert (intact.document_id, intact.document_id_source) == ("11" * 16, "signed")
    assert (broken.document_id, broken.document_id_source) == ("22" * 16, "current")
    assert (none.document_id, none.document_id_source) == (None, None)


def test_the_programs_warnings_ride_along_as_text(pki: DocumentPki) -> None:
    warnings = [{"code": "signature.revision", "message": "The signed revision could not be read"}]
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, signature_report(pki.signer), warnings=warnings)
    assert "The signed revision could not be read" in report.warnings


def test_the_default_policy_is_summarised_as_the_default_with_no_revocation_judged_now(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        summary = verified(rig).trust_policy
    assert (summary.name, summary.revocation_checking, summary.validation_time) == ("default", False, "now")


def test_a_file_with_no_signature_has_an_empty_list_not_a_refusal(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert verified(rig).signatures == ()


# -- the value check ---------------------------------------------------------------------------------------
def test_a_valid_rsa_value_is_valid_and_a_forged_one_under_a_valid_structure_is_never_intact(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        real = first(rig, signature_report(pki.signer))
        forged = first(rig, signature_report(pki.signer, forge=True))
    assert (real.value, real.intact) == ("valid", True)
    assert (forged.value, forged.intact) == ("invalid", False)
    assert forged.digest_matches, "structure alone is not enough"
    assert forged.certificate_matches
    assert forged.covers_document


def test_a_valid_and_a_forged_ecdsa_value(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=PdfTrustPolicy(anchors=(pki.ec.root_der,))) as rig:
        real = first(rig, signature_report(pki.ec))
        forged = first(rig, signature_report(pki.ec, forge=True))
    assert (real.value, real.intact, real.trust) == ("valid", True, "trusted")
    assert (forged.value, forged.intact) == ("invalid", False)


@pytest.mark.parametrize(
    ("hash_name", "oid"), [("sha384", "1.2.840.113549.1.1.12"), ("sha512", "1.2.840.113549.1.1.13")]
)
def test_rsa_values_over_sha384_and_sha512_are_checked_too(pki: DocumentPki, hash_name: str, oid: str) -> None:
    tbv = b"signed attributes " + hash_name.encode()
    value = rsa_sign(pki.signer.key, tbv, hash_name)
    other = rsa_sign(pki.signer.key, tbv + b"!", hash_name)
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        good = first(rig, signature_report(pki.signer, to_be_verified=tbv, signature=value, algorithm_oid=oid))
        bad = first(rig, signature_report(pki.signer, to_be_verified=tbv, signature=other, algorithm_oid=oid))
    assert (good.value, bad.value) == ("valid", "invalid")


@pytest.mark.parametrize(("hash_name", "oid"), [("sha384", "1.2.840.10045.4.3.3"), ("sha512", "1.2.840.10045.4.3.4")])
def test_ecdsa_values_over_sha384_and_sha512_are_checked_too(pki: DocumentPki, hash_name: str, oid: str) -> None:
    tbv = b"signed attributes " + hash_name.encode()
    value = ec_sign(pki.ec.key, tbv, hash_name)
    other = ec_sign(pki.ec.key, tbv + b"!", hash_name)
    with started_pdf(pdf_trust_policy=PdfTrustPolicy(anchors=(pki.ec.root_der,))) as rig:
        good = first(rig, signature_report(pki.ec, to_be_verified=tbv, signature=value, algorithm_oid=oid))
        bad = first(rig, signature_report(pki.ec, to_be_verified=tbv, signature=other, algorithm_oid=oid))
    assert (good.value, bad.value) == ("valid", "invalid")


def test_a_value_the_host_cannot_check_is_unchecked_and_never_intact(pki: DocumentPki) -> None:
    pss = "1.2.840.113549.1.1.10"  # RSASSA-PSS: not in the list the host verifies
    sha1_rsa = "1.2.840.113549.1.1.5"
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        no_signer = first(rig, signature_report(pki.signer, signer=False))
        unsupported = first(rig, signature_report(pki.signer, algorithm_oid=pss))
        weak_hash = first(rig, signature_report(pki.signer, algorithm_oid=sha1_rsa))
        broken_key = first(
            rig,
            signature_report(
                pki.signer,
                signer={
                    "certificate": b64(pki.signer.leaf_der),
                    "publicKey": "!!!",
                    "subject": "s",
                    "issuer": "i",
                    "serialNumber": "1",
                    "notBefore": "x",
                    "notAfter": "y",
                },
            ),
        )
        no_attributes = signature_report(pki.signer)
        del no_attributes["toBeVerified"]
        missing = first(rig, no_attributes)
    for verdict in (no_signer, unsupported, weak_hash, broken_key, missing):
        assert verdict.value == "unchecked"
        assert verdict.intact is False


def test_garbage_in_a_report_is_unchecked_not_a_crash(pki: DocumentPki) -> None:
    broken = signature_report(pki.signer)
    broken["signature"] = "%%%not base64%%%"
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert first(rig, broken).value in {"unchecked", "invalid"}
        assert first(rig, broken).intact is False


# -- fail closed ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("fact", ["digest_matches", "certificate_matches"])
def test_a_false_kernel_fact_is_never_intact_whatever_the_value_says(pki: DocumentPki, fact: str) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        flags: dict[str, Any] = {fact: False}
        verdict = first(rig, signature_report(pki.signer, **flags))
    assert verdict.value == "valid"
    assert verdict.intact is False


def test_a_signature_that_does_not_cover_the_document_and_has_no_later_revisions_is_never_intact(
    pki: DocumentPki,
) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        verdict = first(rig, signature_report(pki.signer, covers_document=False))
    assert verdict.covers_document is False
    assert verdict.intact is False


@pytest.mark.parametrize(
    ("permitted", "intact"),
    [
        (True, True),
        (False, False),
        (None, False),
        ("true", False),
        ("yes", False),
        (1, False),
        ({}, False),
        ([], False),
    ],
)
def test_later_revisions_decide_through_permitted_and_only_true_is_a_pass(
    pki: DocumentPki, permitted: object, intact: bool
) -> None:
    report = signature_report(
        pki.signer,
        covers_document=False,
        certification="formFilling",
        later_revisions=later_revisions(permitted=permitted),
    )
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert first(rig, report).intact is intact


def relied(
    rig_pki: DocumentPki,
    *,
    second_forged: bool = False,
    second_digest: bool = True,
    entry: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """A certifying signature that relies on a later one, and that later one."""
    second_range = [0, 10, 40, 50]
    certifying = signature_report(
        rig_pki.signer,
        covers_document=False,
        certification="formFilling",
        later_revisions=later_revisions(
            permitted=True,
            relied_on=[entry if entry is not None else {"field": "Signature2", "byteRange": second_range}],
        ),
    )
    later = signature_report(
        rig_pki.email,
        field_name="Signature2",
        byte_range=second_range,
        forge=second_forged,
        digest_matches=second_digest,
    )
    return [certifying, later]


def test_a_certification_stays_intact_when_the_signature_it_relies_on_is_itself_intact(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, *relied(pki))
    assert [v.intact for v in report.signatures] == [True, True]


def test_a_certification_is_not_intact_when_the_signature_it_relies_on_has_a_bad_value(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, *relied(pki, second_forged=True))
    assert [v.intact for v in report.signatures] == [False, False]
    assert [v.value for v in report.signatures] == ["valid", "invalid"]


def test_a_certification_is_not_intact_when_the_signature_it_relies_on_fails_a_kernel_fact(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, *relied(pki, second_digest=False))
    assert report.signatures[0].intact is False


@pytest.mark.parametrize(
    "entry",
    [
        {"field": "", "byteRange": [0, 10, 40, 50]},  # no report matched in the kernel: the host reads it as invalid
        {"field": "Signature9", "byteRange": [0, 10, 40, 50]},  # no report of that field
        {"field": "Signature2", "byteRange": [0, 10, 40, 51]},  # the field's range differs
    ],
)
def test_a_relied_on_entry_that_no_report_matches_by_field_and_byte_range_fails_the_certification(
    pki: DocumentPki, entry: dict[str, Any]
) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, *relied(pki, entry=entry))
    assert report.signatures[0].intact is False


def test_every_relied_on_entry_is_checked_not_just_the_first(pki: DocumentPki) -> None:
    ranges = ([0, 10, 40, 50], [0, 10, 60, 70])
    certifying = signature_report(
        pki.signer,
        covers_document=False,
        certification="formFilling",
        later_revisions=later_revisions(
            permitted=True,
            relied_on=[
                {"field": "Signature2", "byteRange": ranges[0]},
                {"field": "Signature3", "byteRange": ranges[1]},
            ],
        ),
    )
    good = signature_report(pki.email, field_name="Signature2", byte_range=ranges[0])
    bad = signature_report(pki.no_eku, field_name="Signature3", byte_range=ranges[1], forge=True)
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, certifying, good, bad)
    assert report.signatures[0].intact is False
    assert report.signatures[1].intact is True


def test_a_kernel_refusal_of_a_readable_file_is_unreadable_and_nothing_is_reported(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        rig.runtime.fail("verify", "internal", "Error: Failed to parse PDF document")
        outcome = rig.verify(DATA)
    assert isinstance(outcome, Unreadable)


def test_a_runtime_that_cannot_run_the_program_is_unavailable_never_a_clean_report(pki: DocumentPki) -> None:
    from datum_sandbox.wasi import RunEnd  # noqa: PLC0415 - one use

    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        rig.runtime.end("verify", RunEnd.BUDGET)
        outcome = rig.verify(DATA)
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "wasm.execution_error"  # a run that was stopped keeps its own code, as on a validation run


def test_a_program_that_answers_a_report_without_signatures_member_is_not_a_clean_report(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        rig.runtime.on("verify", lambda _request: {"attachments": [], "warnings": []})
        outcome = rig.verify(DATA)
    assert not isinstance(outcome, Verified)


# -- what is refused before the program --------------------------------------------------------------------------------
def test_bytes_that_are_not_a_pdf_are_not_a_pdf_and_cost_no_run_no_slot_and_no_throttle_check(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        outcome = rig.verify(b"hello")
        assert isinstance(outcome, NotAPdf)
        assert rig.runtime.requests("verify") == []
        assert rig.throttle.keys == []
        assert rig.verify(b"") is not None


def test_a_file_over_the_verify_cap_is_too_large_before_the_throttle_and_before_the_program(pki: DocumentPki) -> None:
    config = {"runtime": {"verify_max_bytes": "1MiB"}}
    with started_pdf(config, pdf_trust_policy=policy(pki)) as rig:
        outcome = rig.verify(b"%PDF-" + b"x" * (1024 * 1024))
        assert isinstance(outcome, TooLarge)
        assert outcome.max_bytes == 1024 * 1024
        assert rig.runtime.requests("verify") == []
        assert rig.throttle.keys == []
        assert isinstance(rig.verify(b"%PDF-" + b"x" * (1024 * 1024 - 5)), Verified)


def test_verify_is_counted_by_the_pdf_throttle_and_a_denial_costs_no_run(pki: DocumentPki) -> None:
    from submissions_support import http_context  # noqa: PLC0415 - one use

    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        rig.throttle.deny = 7
        outcome = rig.verify(DATA, http_context())
        assert isinstance(outcome, Throttled)
        assert outcome.retry_after == 7
        assert outcome.key.kind is not None
        assert outcome.key.kind.value == "pdf"
        assert rig.runtime.requests("verify") == []


def test_verify_needs_no_key_and_no_seal_only_the_capability(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, pdf_trust_policy=policy(pki)) as rig:
        assert rig.runtime.requests("verify") == []
        report = verified(rig, signature_report(pki.signer))
    assert report.signatures[0].intact is True


# -- the timestamp ----------------------------------------------------------------------------------------
def stamped(
    pki: DocumentPki, tsa: TsaPki, *, clock: Any = None, cert_req: bool = True, **flags: Any
) -> tuple[dict[str, Any], Any]:
    tbv = b"signed-attributes"
    value = pki.signer.sign(tbv)
    authority = make_authority(tsa.rsa, now=clock) if clock is not None else make_authority(tsa.rsa)
    grant = authority.request(hashlib.sha256(value).digest(), "sha256", cert_req=cert_req, channel="seal")
    return signature_report(
        pki.signer, to_be_verified=tbv, signature=value, timestamp=timestamp_report(grant, tsa.rsa, **flags)
    ), grant


def test_a_token_the_kernel_and_the_host_both_accept_makes_the_signature_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    report, grant = stamped(pki, tsa_pki)
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        verdict = first(rig, report)
    assert verdict.timestamped is True
    assert verdict.timestamp_time == grant.gen_time
    assert verdict.intact is True


@pytest.mark.parametrize(
    "fact", ["covers_signature", "message_digest_matches", "certificate_matches", "content_type_matches"]
)
def test_any_false_kernel_fact_about_the_token_reads_not_timestamped_with_a_warning(
    pki: DocumentPki, tsa_pki: TsaPki, fact: str
) -> None:
    report, _grant = stamped(pki, tsa_pki, **{fact: False})
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        outcome = verified(rig, report)
    assert outcome.signatures[0].timestamped is False
    assert outcome.signatures[0].intact is True, "an untrusted timestamp does not break the signature itself"
    assert any("timestamp" in warning.lower() for warning in outcome.warnings)


def test_a_token_over_another_value_that_the_kernel_calls_covering_is_caught_by_the_hosts_own_check(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    value = pki.signer.sign(b"signed-attributes")
    authority = make_authority(tsa_pki.rsa)
    grant = authority.request(hashlib.sha256(b"another value").digest(), "sha256", channel="seal")
    report = signature_report(
        pki.signer,
        signature=value,
        timestamp=timestamp_report(grant, tsa_pki.rsa),  # every kernel fact says true
    )
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        outcome = verified(rig, report)
    assert outcome.signatures[0].timestamped is False
    assert any("timestamp" in warning.lower() for warning in outcome.warnings)


def test_a_token_whose_authority_certificate_cannot_be_found_is_not_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    """The token was asked without `certReq` and the report carries none: nobody holds the authority's certificate."""
    report, _grant = stamped(pki, tsa_pki, cert_req=False, include_certificates=False)
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        outcome = verified(rig, report)
    assert outcome.signatures[0].timestamped is False
    assert any("timestamp" in warning.lower() for warning in outcome.warnings)


def test_a_signature_with_no_timestamp_member_is_not_timestamped_and_says_nothing_about_it(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        outcome = verified(rig, signature_report(pki.signer))
    assert outcome.signatures[0].timestamped is False
    assert outcome.signatures[0].timestamp_time is None
    assert not [w for w in outcome.warnings if "timestamp" in w.lower()]


def test_the_in_process_authoritys_chain_is_among_the_known_certificates_the_program_is_given(pki: DocumentPki) -> None:
    from tsa_support import POLICY  # noqa: PLC0415 - one use

    tsa = {
        "enabled": True,
        "access": "open",
        "policy": POLICY,
        "allow_memory_stores": True,
        "signer": {"self_signed": True},
    }
    with started_pdf({"tsa": tsa}, signer=pki.signer, pdf_trust_policy=policy(pki)) as rig:
        authority = rig.datum.timestamp_authority
        assert authority is not None
        verified(rig, signature_report(pki.signer))
        (request,) = rig.runtime.requests("verify")
    assert b64(authority.certificate_chain_der[0]) in request["knownCertificates"]


# -- SIGNING_TIME ----------------------------------------------------------------------------------------------------
def expired_stamped(pki: DocumentPki, tsa: TsaPki, **flags: Any) -> tuple[dict[str, Any], Any]:
    tbv = b"signed-attributes"
    value = pki.expired.sign(tbv)
    authority = make_authority(tsa.rsa, now=lambda: EXPIRED_LEAF_SIGNED_AT)
    grant = authority.request(hashlib.sha256(value).digest(), "sha256", channel="seal")
    report = signature_report(
        pki.expired,
        to_be_verified=tbv,
        signature=value,
        timestamp=timestamp_report(grant, tsa.rsa, **flags),
        signing_time="2020-01-01T00:00:00Z",
    )
    return report, grant


def test_an_expired_signer_is_trusted_at_the_time_a_verified_trusted_token_proves(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    report, grant = expired_stamped(pki, tsa_pki)
    signing_time = policy(pki, tsa_pki, validation_time=PdfValidationTime.SIGNING_TIME)
    with started_pdf(pdf_trust_policy=signing_time) as rig:
        verdict = first(rig, report)
    assert (verdict.trust, verdict.trusted_at) == ("trusted", grant.gen_time)
    assert verdict.signing_time == "2020-01-01T00:00:00Z", "the signer's own claim is reported, never used"


def test_the_same_expired_signer_is_unknown_under_a_now_policy(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    report, _grant = expired_stamped(pki, tsa_pki)
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        assert first(rig, report).trust == "unknown"


@pytest.mark.parametrize("fact", ["covers_signature", "message_digest_matches", "certificate_matches"])
def test_a_token_that_is_not_verified_whole_moves_nothing(pki: DocumentPki, tsa_pki: TsaPki, fact: str) -> None:
    report, _grant = expired_stamped(pki, tsa_pki, **{fact: False})
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki, validation_time=PdfValidationTime.SIGNING_TIME)) as rig:
        assert first(rig, report).trust == "unknown"


def test_a_token_from_an_authority_nobody_trusts_moves_nothing(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    report, _grant = expired_stamped(pki, tsa_pki)
    only_documents = PdfTrustPolicy(anchors=(pki.signer.root_der,), validation_time=PdfValidationTime.SIGNING_TIME)
    with started_pdf(pdf_trust_policy=only_documents) as rig:
        assert first(rig, report).trust == "unknown"


def test_a_token_from_this_servers_own_authority_moves_the_judging_time(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    report, grant = expired_stamped(pki, tsa_pki)
    own = PdfTrustPolicy(
        anchors=(pki.signer.root_der,),
        site_certificates=(tsa_pki.rsa.leaf_der,),
        validation_time=PdfValidationTime.SIGNING_TIME,
    )
    with started_pdf(pdf_trust_policy=own) as rig:
        verdict = first(rig, report)
    assert (verdict.trust, verdict.trusted_at) == ("trusted", grant.gen_time)


def test_the_signatures_own_time_never_moves_anything(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    """A /M inside the expired leaf's validity does not make an unstamped expired signer trusted."""
    plain = signature_report(pki.expired, signing_time="2026-03-01T12:00:00Z")
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki, validation_time=PdfValidationTime.SIGNING_TIME)) as rig:
        assert first(rig, plain).trust == "unknown"
    moved_late = signature_report(pki.signer, signing_time="2099-01-01T00:00:00Z")
    moved_early = signature_report(pki.signer, signing_time="1999-01-01T00:00:00Z")
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert first(rig, moved_late).trust == first(rig, moved_early).trust == "trusted"
        assert first(rig, moved_late).trusted_at == first(rig, moved_early).trusted_at == INSTANT


# -- the trust words in a report ---------------------------------------------------------------------------------------
def test_the_servers_own_certificate_reads_site_and_carries_no_instant(pki: DocumentPki) -> None:
    with started_pdf(signer=pki.signer, pdf_trust_policy=None) as rig:
        verdict = first(rig, signature_report(pki.signer))
    assert (verdict.trust, verdict.trusted_at) == ("site", None)


def test_a_retired_certificate_reads_site_retired(pki: DocumentPki, tmp_path: Path) -> None:
    config = {"pdf": {"signing": {"retired_certificates": [anchors_file(tmp_path, pki.email.leaf_der)]}}}
    with started_pdf(config, signer=pki.signer) as rig:
        verdict = first(rig, signature_report(pki.email))
    assert verdict.trust == "site_retired"


def test_a_self_signed_signer_reads_self_signed_and_a_stranger_unknown(pki: DocumentPki) -> None:
    key = rsa.generate_private_key(65537, 2048)
    certificate = make_root("Datum test seal", key)
    own = TsaIdentity("self", key, certificate, key, certificate)
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert first(rig, signature_report(own)).trust == "self_signed"
        assert first(rig, signature_report(pki.stranger)).trust == "unknown"


def test_a_signer_with_a_look_alike_certificate_is_not_site(pki: DocumentPki) -> None:
    with started_pdf(signer=pki.signer) as rig:
        report = signature_report(pki.signer, carried=[pki.look_alike(pki.signer)])
        report["signer"] = {**report["signer"], "certificate": b64(pki.look_alike(pki.signer))}
        verdict = first(rig, report)
    assert verdict.trust != "site"


def test_trust_does_not_change_whether_a_signature_is_intact(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        stranger = first(rig, signature_report(pki.stranger))
    assert (stranger.trust, stranger.intact) == ("unknown", True)


@pytest.mark.parametrize(
    "broken",
    [
        {"forge": True},
        {"digest_matches": False},
        {"certificate_matches": False},
        {"covers_document": False},
        {"covers_document": False, "later_revisions": {"revisions": 1, "changes": [], "permitted": None}},
    ],
)
def test_a_signature_that_is_not_intact_vouches_for_no_one(pki: DocumentPki, broken: dict[str, Any]) -> None:
    """Fail closed: a trusted signer's certificate on a signature that does not hold never reads trusted or site."""
    with started_pdf(signer=pki.signer, pdf_trust_policy=policy(pki, site_certificates=(pki.email.leaf_der,))) as rig:
        trusted = first(rig, signature_report(pki.signer, **broken))
        site = first(rig, signature_report(pki.email, **broken))
    for verdict in (trusted, site):
        assert verdict.intact is False
        assert (verdict.trust, verdict.trusted_at) == ("unknown", None)


def test_an_eku_that_is_no_document_signers_reads_unknown(pki: DocumentPki) -> None:
    server = ExtendedKeyUsageOID.SERVER_AUTH
    assert server != ExtendedKeyUsageOID.EMAIL_PROTECTION
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert first(rig, signature_report(pki.server_auth)).trust == "unknown"
        assert first(rig, signature_report(pki.email)).trust == "trusted"


def test_a_revocation_status_that_cannot_be_learnt_is_not_trusted_and_is_reported_in_the_summary(
    pki: DocumentPki,
) -> None:
    class Unknown:
        def status(self, chain: Any, moment: datetime) -> str:
            return "unknown"

    checked = policy(pki, revocation=Unknown())
    with started_pdf(pdf_trust_policy=checked) as rig:
        outcome = verified(rig, signature_report(pki.signer))
    assert outcome.signatures[0].trust == "unknown"
    assert outcome.trust_policy.revocation_checking is True


def test_the_verdicts_keep_the_programs_order(pki: DocumentPki) -> None:
    reports = [
        signature_report(identity, field_name=f"Signature{index}")
        for index, identity in enumerate((pki.signer, pki.email, pki.no_eku), 1)
    ]
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, *reports)
    assert [v.field for v in report.signatures] == ["Signature1", "Signature2", "Signature3"]


def test_a_second_run_of_the_same_file_gives_the_same_report(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        one = verified(rig, signature_report(pki.signer))
        two = verified(rig, signature_report(pki.signer))
    assert one == two


# -- fail closed: what the host cannot read or judge -------------------------------------------------------
@pytest.mark.parametrize("relied_on", ["missing", "not-a-list", "not-an-object"])
def test_a_relied_on_list_the_host_cannot_read_is_never_intact(pki: DocumentPki, relied_on: str) -> None:
    later = later_revisions(permitted=True)
    if relied_on == "missing":
        del later["reliedOnSignatures"]
    elif relied_on == "not-a-list":
        later["reliedOnSignatures"] = {"field": "Signature2"}
    else:
        later["reliedOnSignatures"] = ["Signature2"]
    report = signature_report(pki.signer, covers_document=False, certification="formFilling", later_revisions=later)
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        assert first(rig, report).intact is False


@pytest.mark.parametrize(("identity", "oid"), [("signer", "1.2.840.10045.4.3.2"), ("ec", "1.2.840.113549.1.1.11")])
def test_an_algorithm_for_the_other_key_type_is_unchecked_and_never_intact(
    pki: DocumentPki, identity: str, oid: str
) -> None:
    report = signature_report(getattr(pki, identity), algorithm_oid=oid)
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        verdict = first(rig, report)
    assert (verdict.value, verdict.intact, verdict.trust) == ("unchecked", False, "unknown")


@pytest.mark.parametrize("key", ["digestMatches", "certificateMatches", "coversDocument"])
@pytest.mark.parametrize("value", ["true", 1, {}, [True]])
def test_a_kernel_fact_that_is_not_the_boolean_true_reads_false(pki: DocumentPki, key: str, value: object) -> None:
    report = signature_report(pki.signer)
    report[key] = value
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        verdict = first(rig, report)
    assert (verdict.intact, verdict.trust) == (False, "unknown")


@pytest.mark.parametrize(
    "fact", ["coversSignature", "messageDigestMatches", "certificateMatches", "contentTypeMatches"]
)
@pytest.mark.parametrize("value", ["true", 1])
def test_a_token_fact_that_is_not_the_boolean_true_reads_not_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki, fact: str, value: object
) -> None:
    report, _grant = stamped(pki, tsa_pki)
    report["timestamp"][fact] = value
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        assert first(rig, report).timestamped is False


def test_a_token_signer_found_only_among_the_known_certificates_is_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    report, grant = stamped(pki, tsa_pki, cert_req=False, include_certificates=False)
    known = PdfTrustPolicy(
        anchors=(pki.signer.root_der, tsa_pki.rsa.root_der), site_certificates=(tsa_pki.rsa.leaf_der,)
    )
    with started_pdf(pdf_trust_policy=known) as rig:
        verdict = first(rig, report)
    assert (verdict.timestamped, verdict.timestamp_time) == (True, grant.gen_time)


def test_a_known_look_alike_the_token_does_not_name_is_never_its_signer(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    """Only a look-alike (same key, issuer and serial; another subject) is known: the ESSCertIDv2 does not name it."""
    report, _grant = stamped(pki, tsa_pki, cert_req=False, include_certificates=False)
    known = PdfTrustPolicy(
        anchors=(pki.signer.root_der, tsa_pki.rsa.root_der),
        site_certificates=(tsa_pki.look_alike(tsa_pki.rsa),),
        validation_time=PdfValidationTime.SIGNING_TIME,
    )
    with started_pdf(pdf_trust_policy=known) as rig:
        outcome = verified(rig, report)
    assert outcome.signatures[0].timestamped is False
    assert any("binding" in warning for warning in outcome.warnings)


def test_a_token_dated_outside_its_authoritys_certificate_is_not_timestamped(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    report, _grant = stamped(pki, tsa_pki, clock=lambda: datetime(2040, 6, 1, tzinfo=UTC))
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        outcome = verified(rig, report)
    assert outcome.signatures[0].timestamped is False
    assert any("time" in warning for warning in outcome.warnings)


def test_an_unlinked_signature_a_certification_relies_on_counts_as_invalid(pki: DocumentPki) -> None:
    certifying, later = relied(pki, entry={"field": "", "byteRange": [0, 10, 40, 50]})
    later["field"] = ""  # the kernel's word for a signature no field links any more
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, certifying, later)
    assert report.signatures[0].intact is False


def test_certifications_that_rely_on_each_other_are_not_intact_and_do_not_crash(pki: DocumentPki) -> None:
    first_range, second_range = [0, 10, 20, 30], [0, 10, 40, 50]
    a = signature_report(
        pki.signer,
        field_name="A",
        byte_range=first_range,
        covers_document=False,
        certification="formFilling",
        later_revisions=later_revisions(permitted=True, relied_on=[{"field": "B", "byteRange": second_range}]),
    )
    b = signature_report(
        pki.email,
        field_name="B",
        byte_range=second_range,
        covers_document=False,
        certification="formFilling",
        later_revisions=later_revisions(permitted=True, relied_on=[{"field": "A", "byteRange": first_range}]),
    )
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        report = verified(rig, a, b)
    assert [verdict.intact for verdict in report.signatures] == [False, False]


# -- the key the value is checked under, the token gated on the signature, the authority chain ----------
def test_a_signer_with_no_public_key_member_reads_unchecked_and_never_intact(pki: DocumentPki) -> None:
    """`signer.publicKey` is required by the ABI: without it there is no key the program vouches for."""
    report = signature_report(pki.signer)
    del report["signer"]["publicKey"]
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        verdict = first(rig, report)
    assert (verdict.value, verdict.intact, verdict.trust) == ("unchecked", False, "unknown")


def test_a_public_key_that_is_not_strict_base64_reads_unchecked(pki: DocumentPki) -> None:
    """A stray '!' in front of the right key must not be skipped over as padding noise."""
    report = signature_report(pki.signer)
    report["signer"]["publicKey"] = "!" + report["signer"]["publicKey"]
    with started_pdf(pdf_trust_policy=policy(pki)) as rig:
        verdict = first(rig, report)
    assert (verdict.value, verdict.intact) == ("unchecked", False)


def test_a_token_over_a_broken_signature_is_not_timestamped(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    """The token covers the signature bytes, which prove nothing when the value is not valid under the key."""
    report, _grant = stamped(pki, tsa_pki)
    report["toBeVerified"] = b64(b"another message than the one signed")
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        verdict = first(rig, report)
    assert (verdict.value, verdict.intact) == ("invalid", False)
    assert (verdict.timestamped, verdict.timestamp_time) == (False, None)


def test_a_token_signer_the_program_names_but_the_hosts_check_did_not_find_reads_not_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    """The authority chain is built from the program's signer; it must be the certificate `verify_over` found."""
    report, _grant = expired_stamped(pki, tsa_pki)
    report["timestamp"]["signer"]["certificate"] = b64(tsa_pki.look_alike(tsa_pki.rsa))
    signing_time = policy(pki, tsa_pki, validation_time=PdfValidationTime.SIGNING_TIME)
    with started_pdf(pdf_trust_policy=signing_time) as rig:
        outcome = verified(rig, report)
    verdict = outcome.signatures[0]
    assert verdict.timestamped is False
    assert verdict.trust == "unknown", "the expired signer is not judged at a time the look-alike authority 'proved'"
    assert any("timestamp" in warning.lower() for warning in outcome.warnings)


def test_a_token_signer_the_program_names_that_is_the_one_found_still_moves_the_judging_time(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    report, grant = expired_stamped(pki, tsa_pki, include_certificates=False)
    known = policy(
        pki, tsa_pki, validation_time=PdfValidationTime.SIGNING_TIME, site_certificates=(tsa_pki.rsa.leaf_der,)
    )
    with started_pdf(pdf_trust_policy=known) as rig:
        verdict = first(rig, report)
    assert (verdict.timestamped, verdict.trust, verdict.trusted_at) == (True, "trusted", grant.gen_time)


def test_the_trust_reason_is_in_the_signature_verdict_and_in_no_event(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    """A proven time later than now is not used: the chain is judged now, and the verdict says why."""
    ahead = INSTANT + timedelta(hours=1)
    report, grant = stamped(pki, tsa_pki, clock=lambda: ahead)
    assert grant.gen_time > INSTANT
    signing_time = policy(pki, tsa_pki, validation_time=PdfValidationTime.SIGNING_TIME)
    with started_pdf(pdf_trust_policy=signing_time) as rig:
        verdict = first(rig, report)
        plain = first(rig, signature_report(pki.signer))
        events = [event for event in rig.events if type(event).__name__ == "PdfVerifiedEvent"]
    assert (verdict.trust, verdict.trusted_at) == ("trusted", INSTANT)
    assert verdict.trust_reason is not None
    assert "later than now" in verdict.trust_reason
    assert plain.trust_reason is None
    assert len(events) == 2
    assert not any(hasattr(event, "reason") or hasattr(event, "trust_reason") for event in events)


def test_the_report_is_judged_on_the_same_capped_known_set_the_program_got(
    pki: DocumentPki, tsa_pki: TsaPki, tmp_path: Path
) -> None:
    """A token signer cut by the 64-certificate cap was never given to the program: the host does not find it either."""
    report, _grant = stamped(pki, tsa_pki, cert_req=False, include_certificates=False)
    fillers = tuple(
        make_root(f"Filler {index}", ec.generate_private_key(ec.SECP256R1())).public_bytes(serialization.Encoding.DER)
        for index in range(64)
    )
    cut = PdfTrustPolicy(
        anchors=(pki.signer.root_der, tsa_pki.rsa.root_der), retired_certificates=(*fillers, tsa_pki.rsa.leaf_der)
    )
    kept = PdfTrustPolicy(
        anchors=(pki.signer.root_der, tsa_pki.rsa.root_der), retired_certificates=(tsa_pki.rsa.leaf_der, *fillers)
    )
    with started_pdf(pdf_trust_policy=cut) as rig:
        outcome = verified(rig, report)
        (request,) = rig.runtime.requests("verify")
    assert len(request["knownCertificates"]) == 64
    assert b64(tsa_pki.rsa.leaf_der) not in request["knownCertificates"]
    assert outcome.signatures[0].timestamped is False
    with started_pdf(pdf_trust_policy=kept) as rig:
        assert first(rig, report).timestamped is True


def _drop_signer(report: dict[str, Any]) -> None:
    del report["timestamp"]["signer"]


def _null_signer(report: dict[str, Any]) -> None:
    report["timestamp"]["signer"] = None


def _unreadable_signer(report: dict[str, Any]) -> None:
    report["timestamp"]["signer"]["certificate"] = "!" + report["timestamp"]["signer"]["certificate"]


@pytest.mark.parametrize("damage", [_drop_signer, _null_signer, _unreadable_signer])
def test_a_token_whose_signer_the_program_does_not_name_is_not_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki, damage: Any
) -> None:
    """A report naming no readable token signer cannot be compared with the one the host found: not counted."""
    report, _grant = stamped(pki, tsa_pki)
    damage(report)
    with started_pdf(pdf_trust_policy=policy(pki, tsa_pki)) as rig:
        outcome = verified(rig, report)
    verdict = outcome.signatures[0]
    assert verdict.timestamped is False
    assert verdict.timestamp_time is None
    assert any("timestamp" in warning.lower() for warning in outcome.warnings)
