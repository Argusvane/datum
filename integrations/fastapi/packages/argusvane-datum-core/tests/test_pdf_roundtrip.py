"""The round trips through the real program and the real sandbox.

A real `Datum` (wasmtime, the packaged sandbox and PDF programs) renders, fills, seals and timestamps; the same service
verifies what it made and what other keys made. A sealed, timestamped render verifies `timestamped`, `coversDocument`,
`certificateMatches`, `digestMatches`, value `valid`, trust `site`; posted answers carry the throwaway "Datum test seal"
and read `self_signed`; a value that is not the signature over what the kernel handed the signer is `invalid` and never
intact though the kernel calls the structure fine; a revision appended after a `noChanges` certification, a flipped
byte, a foreign signer, a retired key, a revoked chain and a signing-time judgement each read as the rules say.
Independent validators agree: `openssl cms -verify` accepts each sealed signature over its ByteRange bytes and `openssl
ts -verify` each embedded token (a flipped byte fails both); pyHanko, at test scope, finds the same files intact, valid
and trusted. Every row carries `runtime`; the openssl rows also `openssl`.
"""

import contextlib
import hashlib
import io
import shutil
import tempfile
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest
from cryptography.hazmat.primitives import serialization
from pdf_kernel import PdfKernelSession, fillable_template, kernel_skip_reason, pdf_session, unb64
from pdf_support import (
    IdentitySigner,
    RecordingTimestamper,
    accepted_submission,
    anchors_file,
    pdf_definition,
    pdf_signing,
    template_layout,
)
from submissions_support import Handler, Repository, bus, definition, envelope
from tsa_support import make_authority, run_openssl

from datum_core import Datum, DatumConfig
from datum_core.events import DatumEvent
from datum_core.pdf import PdfService, PdfTrustPolicy
from datum_core.pdf.outcomes import Printed, Verified
from datum_core.pdf.protocols import PdfValidationTime
from datum_core.submissions import FormRef
from datum_core.testing.openssl import requires_openssl
from datum_core.testing.tsa_pki import (
    EXPIRED_LEAF_SIGNED_AT,
    INSTANT,
    DocumentPki,
    TsaPki,
    build_document_pki,
    make_crl,
)

pytestmark = pytest.mark.runtime


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


@pytest.fixture(scope="module")
def session() -> Generator[PdfKernelSession]:
    with pdf_session() as started:
        yield started


@contextlib.contextmanager
def real_datum(
    pki: DocumentPki,
    *,
    seal: dict[str, Any] | None = None,
    form: dict[str, Any] | None = None,
    anchors: tuple[bytes, ...] | None = None,
    retired: tuple[bytes, ...] = (),
    sections: dict[str, Any] | None = None,
    **seams: Any,
) -> Generator[tuple[Datum, PdfService, list[DatumEvent]]]:
    reason = kernel_skip_reason()
    if reason is not None:
        pytest.skip(reason)
    directory = Path(tempfile.mkdtemp(prefix="datum-pdf-roundtrip-"))
    try:
        signing = pdf_signing(directory, pki.signer, friendly_name="datum-pdf").model_dump(mode="python")
        signing["trust_anchors"] = [
            anchors_file(directory, *(anchors if anchors is not None else (pki.signer.root_der,)))
        ]
        if retired:
            signing["retired_certificates"] = [anchors_file(directory, *retired, name="retired.pem")]
        config = DatumConfig.model_validate(
            {
                "pdf": {"seal": {"enabled": True, "timestamp": True, **(seal or {})}, "signing": signing},
                **(sections or {}),
            }
        )
        events: list[DatumEvent] = []
        trail: list[str] = []
        datum = Datum(
            config=config,
            form_repository=Repository(trail, form or definition()),
            handler=Handler(trail),
            listeners=[(DatumEvent, events.append)],
            now=lambda: INSTANT,
            **seams,
        )
        datum.start()
        try:
            service = datum.pdf_service
            assert service is not None
            yield datum, service, events
        finally:
            datum.stop()
    finally:
        shutil.rmtree(directory, ignore_errors=True)


def printed(outcome: Any) -> Printed:
    assert isinstance(outcome, Printed), outcome
    return outcome


def verdict_of(outcome: Any) -> Any:
    assert isinstance(outcome, Verified), outcome
    return outcome.report.signatures[0]


def verify(service: PdfService, data: bytes) -> Any:
    return service.verify(data, bus())


# -- the seal, whole ---------------------------------------------------------------------------------------------------
def test_a_sealed_timestamped_render_of_an_accepted_submission_verifies_whole(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    with real_datum(pki, timestamper=RecordingTimestamper(tsa_pki.rsa)) as (_datum, service, events):
        accepted = accepted_submission(digest="ef" * 32)
        out = printed(service.render_submission(accepted))
        report = verify(service, out.data)
    verdict = report.report.signatures[0]
    assert len(report.report.signatures) == 1
    assert (verdict.value, verdict.intact, verdict.trust) == ("valid", True, "site")
    assert verdict.timestamped is True
    assert verdict.covers_document
    assert verdict.certificate_matches
    assert verdict.digest_matches
    assert verdict.field == out.signature_field
    assert report.report.document_id == hashlib.sha256(("ef" * 32).encode()).hexdigest()[:32]
    assert report.report.document_id_source == "signed"
    assert out.timestamped is True
    assert out.signed_by
    assert "Test document signer" in out.signed_by
    assert [type(e).__name__ for e in events if type(e).__name__.startswith("Pdf")] == [
        "PdfRenderedEvent",
        "PdfVerifiedEvent",
    ]


def test_posted_answers_are_sealed_with_the_test_seal_and_read_self_signed(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    with real_datum(pki, timestamper=RecordingTimestamper(tsa_pki.rsa)) as (_datum, service, _events):
        out = printed(service.render(FormRef.from_document(), envelope(), bus()))
        report = verify(service, out.data)
    assert "Datum test seal" in (out.signed_by or "")
    assert len(report.report.signatures) == 1
    verdict = report.report.signatures[0]
    assert (verdict.value, verdict.intact, verdict.trust, verdict.trusted_at) == ("valid", True, "self_signed", None)
    assert out.signature_field == verdict.field


def test_the_in_process_authority_seals_and_verify_reads_the_token(pki: DocumentPki) -> None:
    from tsa_support import POLICY  # noqa: PLC0415 - one use

    tsa = {
        "enabled": True,
        "access": "open",
        "policy": POLICY,
        "allow_memory_stores": True,
        "signer": {"self_signed": True},
    }
    with real_datum(pki, sections={"tsa": tsa}) as (_d, service, _e):
        out = printed(service.render_submission(accepted_submission()))
        verdict = verdict_of(verify(service, out.data))
    assert (verdict.timestamped, verdict.intact, verdict.trust) == (True, True, "site")


def test_a_fill_of_an_inline_template_is_filled_and_sealed(pki: DocumentPki, session: PdfKernelSession) -> None:
    form = pdf_definition(template_layout("t1", data=fillable_template()))
    with real_datum(pki, form=form, seal={"timestamp": False}) as (_datum, service, _events):
        out = printed(service.fill(FormRef.from_document(), envelope(), bus(), layout_id="t1"))
        info = session.inspect(out.data)
        report = verify(service, out.data)
    assert out.layout_id == "t1"
    assert out.page_count == 1
    fields = info["info"]["fields"]
    (field,) = [item for item in fields if item["kind"] != "signature"]  # the seal adds its own signature field
    assert (field["name"], field["value"]) == ("Name", "Ada Lovelace")
    assert [item["name"] for item in fields if item["kind"] == "signature"] == [out.signature_field]
    assert info["info"]["signatures"] == 1
    assert report.report.signatures[0].intact is True


def test_the_explicit_sign_route_seals_a_fill_with_the_servers_key(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("t1", data=fillable_template()))
    with real_datum(pki, form=form, seal={"enabled": False}) as (_datum, service, _events):
        out = printed(service.sign(FormRef.from_document(), envelope(), bus(), layout_id="t1"))
        verdict = verdict_of(verify(service, out.data))
    assert "Test document signer" in (out.signed_by or "")
    assert (verdict.value, verdict.intact, verdict.trust) == ("valid", True, "site")


# -- values and structure ----------------------------------------------------------------------------------------------
def test_a_value_that_is_not_the_signature_over_what_was_handed_is_invalid_though_the_kernel_calls_the_structure_fine(
    pki: DocumentPki,
) -> None:
    class Forger(IdentitySigner):
        def sign(self, to_be_signed: bytes) -> bytes:
            return super().sign(to_be_signed + b"tampered")

    with real_datum(pki, seal={"timestamp": False, "posted_answers": True}, pdf_signer=Forger(pki.signer)) as (
        _d,
        service,
        _e,
    ):
        out = printed(service.render(FormRef.from_document(), envelope(), bus()))
        verdict = verdict_of(verify(service, out.data))
    assert verdict.digest_matches
    assert verdict.certificate_matches
    assert verdict.covers_document
    assert (verdict.value, verdict.intact) == ("invalid", False)


def test_a_flipped_byte_inside_the_signed_range_breaks_the_digest(pki: DocumentPki) -> None:
    with real_datum(pki, seal={"timestamp": False}) as (_d, service, _e):
        out = printed(service.render_submission(accepted_submission()))
        flipped = bytearray(out.data)
        flipped[300] ^= 1
        verdict = verdict_of(verify(service, bytes(flipped)))
    assert verdict.digest_matches is False
    assert verdict.intact is False


def test_a_revision_appended_after_the_certification_reads_not_intact(pki: DocumentPki) -> None:
    pyhanko = pytest.importorskip("pyhanko")
    from pyhanko.pdf_utils import generic  # noqa: PLC0415 - tests only
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter  # noqa: PLC0415

    assert pyhanko is not None
    with real_datum(pki, seal={"timestamp": False, "certify": "noChanges"}) as (_d, service, _e):
        out = printed(service.render_submission(accepted_submission()))
        writer: Any = IncrementalPdfFileWriter(io.BytesIO(out.data))
        writer.root["/Lang"] = generic.TextStringObject("fr")
        writer.update_root()
        changed = io.BytesIO()
        writer.write(changed)
        verdict = verdict_of(verify(service, changed.getvalue()))
    assert verdict.covers_document is False
    assert verdict.digest_matches is True
    assert verdict.intact is False


# -- other people's signatures -----------------------------------------------------------------------------------------
def test_a_foreign_signer_with_a_valid_value_is_intact_and_not_trusted(
    pki: DocumentPki, session: PdfKernelSession
) -> None:
    foreign = session.sign_with(pki.stranger)
    with real_datum(pki) as (_d, service, _e):
        verdict = verdict_of(verify(service, foreign.data))
    assert (verdict.value, verdict.intact, verdict.trust) == ("valid", True, "unknown")


def test_a_retired_certificate_reads_site_retired(pki: DocumentPki, session: PdfKernelSession) -> None:
    old = session.sign_with(pki.email)
    with real_datum(pki, retired=(pki.email.leaf_der,)) as (_d, service, _e):
        verdict = verdict_of(verify(service, old.data))
    assert (verdict.value, verdict.intact, verdict.trust, verdict.trusted_at) == ("valid", True, "site_retired", None)


def test_a_revoked_chain_reads_unknown_and_a_good_one_trusted_through_the_real_adapter(
    pki: DocumentPki, session: PdfKernelSession
) -> None:
    pytest.importorskip("pyhanko_certvalidator")
    from datum_core.pdf import CertvalidatorRevocationChecker  # noqa: PLC0415 - the extra

    foreign = session.sign_with(pki.email)
    revoked = make_crl(pki.signer.root, pki.signer.root_key, [(pki.email.leaf.serial_number, EXPIRED_LEAF_SIGNED_AT)])
    clean = make_crl(pki.signer.root, pki.signer.root_key, [])
    results = {}
    for name, crl in (("revoked", revoked), ("clean", clean)):
        checker = CertvalidatorRevocationChecker(
            roots=(pki.signer.root_der,), crls=(crl.public_bytes(serialization.Encoding.DER),)
        )
        policy = PdfTrustPolicy(anchors=(pki.signer.root_der,), revocation=checker)
        with real_datum(pki, pdf_trust_policy=policy) as (_d, service, _e):
            report = verify(service, foreign.data)
            results[name] = (report.report.signatures[0].trust, report.report.trust_policy.revocation_checking)
    assert results == {"revoked": ("unknown", True), "clean": ("trusted", True)}


def test_an_expired_signer_with_a_trusted_token_is_trusted_at_the_tokens_time_under_signing_time(
    pki: DocumentPki, tsa_pki: TsaPki, session: PdfKernelSession
) -> None:
    authority = make_authority(tsa_pki.rsa, now=lambda: EXPIRED_LEAF_SIGNED_AT)

    def token(value: bytes) -> bytes:
        return bytes(authority.request(hashlib.sha256(value).digest(), "sha256", channel="seal").response)

    old = session.sign_with(pki.expired, token=token)
    now_policy = PdfTrustPolicy(anchors=(pki.signer.root_der, tsa_pki.rsa.root_der))
    then_policy = PdfTrustPolicy(
        anchors=(pki.signer.root_der, tsa_pki.rsa.root_der), validation_time=PdfValidationTime.SIGNING_TIME
    )
    with real_datum(pki, pdf_trust_policy=now_policy) as (_d, service, _e):
        assert verdict_of(verify(service, old.data)).trust == "unknown"
    with real_datum(pki, pdf_trust_policy=then_policy) as (_d, service, _e):
        verdict = verdict_of(verify(service, old.data))
    assert (verdict.trust, verdict.trusted_at, verdict.timestamped) == ("trusted", EXPIRED_LEAF_SIGNED_AT, True)


# -- independent validators --------------------------------------------------------------------------------------------
def sealed_pair(pki: DocumentPki, tsa_pki: TsaPki) -> tuple[bytes, bytes]:
    with real_datum(pki, timestamper=RecordingTimestamper(tsa_pki.rsa)) as (_d, service, _e):
        sealed = printed(service.render_submission(accepted_submission())).data
        posted = printed(service.render(FormRef.from_document(), envelope(), bus())).data
    return sealed, posted


def exact_der(blob: bytes) -> bytes:
    """Return the first DER element of `blob` (the signature's /Contents is the CMS followed by zero padding)."""
    length = blob[1]
    if length < 0x80:
        return blob[: 2 + length]
    count = length & 0x7F
    return blob[: 2 + count + int.from_bytes(blob[2 : 2 + count], "big")]


@requires_openssl
def test_openssl_accepts_each_sealed_signature_and_each_embedded_token_and_a_flipped_byte_fails_both(
    pki: DocumentPki, tsa_pki: TsaPki, session: PdfKernelSession, tmp_path: Path
) -> None:
    sealed, _posted = sealed_pair(pki, tsa_pki)
    report = session.first_signature(sealed, [tsa_pki.rsa.leaf_der, tsa_pki.rsa.root_der])
    a, b, c, d = report["byteRange"]
    covered = sealed[a : a + b] + sealed[c : c + d]
    contents = sealed[a + b : c]
    cms = exact_der(bytes.fromhex(contents.strip(b"<>").decode("ascii")))
    (tmp_path / "root.pem").write_bytes(pki.signer.root_pem)
    (tmp_path / "tsa-root.pem").write_bytes(tsa_pki.rsa.root_pem)
    (tmp_path / "sig.der").write_bytes(cms)

    def cms_verify(content: bytes) -> int:
        (tmp_path / "content.bin").write_bytes(content)
        return run_openssl(
            "cms",
            "-verify",
            "-binary",
            "-inform",
            "DER",
            "-in",
            str(tmp_path / "sig.der"),
            "-content",
            str(tmp_path / "content.bin"),
            "-CAfile",
            str(tmp_path / "root.pem"),
            "-purpose",
            "any",
            "-out",
            str(tmp_path / "out.bin"),
        ).returncode

    def ts_verify(token: bytes, value: bytes) -> int:
        (tmp_path / "token.der").write_bytes(token)
        return run_openssl(
            "ts",
            "-verify",
            "-in",
            str(tmp_path / "token.der"),
            "-token_in",
            "-digest",
            hashlib.sha256(value).hexdigest(),
            "-CAfile",
            str(tmp_path / "tsa-root.pem"),
        ).returncode

    value = unb64(report["signature"])
    token = unb64(report["timestamp"]["token"])
    assert cms_verify(covered) == 0
    assert ts_verify(token, value) == 0
    flipped = bytearray(covered)
    flipped[100] ^= 1
    assert cms_verify(bytes(flipped)) != 0
    assert ts_verify(token, value + b"\x00") != 0


def test_pyhanko_validates_the_same_files_independently(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    pytest.importorskip("pyhanko")
    from asn1crypto import x509 as asn1_x509  # type: ignore[import-untyped]  # noqa: PLC0415
    from pyhanko.pdf_utils.reader import PdfFileReader  # noqa: PLC0415
    from pyhanko.sign.validation import validate_pdf_signature  # noqa: PLC0415
    from pyhanko_certvalidator import ValidationContext  # noqa: PLC0415

    sealed, posted = sealed_pair(pki, tsa_pki)
    context = ValidationContext(
        trust_roots=[asn1_x509.Certificate.load(pki.signer.root_der), asn1_x509.Certificate.load(tsa_pki.rsa.root_der)],
        allow_fetching=False,
        revocation_mode="soft-fail",
    )
    status = validate_pdf_signature(
        PdfFileReader(io.BytesIO(sealed)).embedded_signatures[0], signer_validation_context=context
    )
    assert (status.intact, status.valid, status.trusted) == (True, True, True)
    assert status.timestamp_validity is not None
    assert status.timestamp_validity.valid
    status = validate_pdf_signature(
        PdfFileReader(io.BytesIO(posted)).embedded_signatures[0], signer_validation_context=context
    )
    assert (status.intact, status.valid) == (True, True)
    assert status.trusted is False, "the throwaway test seal is trusted by no one"


# -- a signer known to the host only ---------------------------------------------------------------------
@requires_openssl
def test_a_signature_with_no_certificate_and_no_signing_certificate_attribute_binds_nothing(
    pki: DocumentPki, session: PdfKernelSession, tmp_path: Path
) -> None:
    """The signer's certificate is neither carried nor named by an attribute; the host only KNOWS it.

    openssl signs the file's ByteRange bytes with `-nocerts` (and no `-cades`, so no ESS signing-certificate attribute),
    and the CMS is put into the placeholder of a file the program prepared. The value is genuinely valid under the key
    of a certificate the server holds, but nothing in the file binds that certificate to the signature: knowing is not
    trusting, so the program reports `certificateMatches` false and the signature is not intact and not trusted.
    """
    signed = session.sign_with(pki.signer)
    a, b, c, d = session.first_signature(signed.data)["byteRange"]
    covered = signed.data[a : a + b] + signed.data[c : c + d]
    (tmp_path / "content.bin").write_bytes(covered)
    (tmp_path / "leaf.pem").write_bytes(pki.signer.leaf_pem)
    (tmp_path / "key.pem").write_bytes(pki.signer.key_pem())
    made = run_openssl(
        "cms",
        "-sign",
        "-binary",
        "-nocerts",
        "-md",
        "sha256",
        "-in",
        str(tmp_path / "content.bin"),
        "-signer",
        str(tmp_path / "leaf.pem"),
        "-inkey",
        str(tmp_path / "key.pem"),
        "-outform",
        "DER",
        "-out",
        str(tmp_path / "bare.der"),
    )
    assert made.returncode == 0, made.stderr
    hex_cms = (tmp_path / "bare.der").read_bytes().hex().upper().encode("ascii")
    room = c - (a + b) - 2  # the hex between the angle brackets
    assert len(hex_cms) <= room
    swapped = signed.data[: a + b] + b"<" + hex_cms.ljust(room, b"0") + b">" + signed.data[c:]
    with real_datum(pki) as (_d, service, _e):
        known = service.verify(swapped, bus())
    verdict = verdict_of(known)
    assert verdict.certificate_matches is False
    assert verdict.intact is False
    assert verdict.trust == "unknown"
