"""What the real PDF program does that the PDF host relies on, pinned against the packaged program.

Each fact is one the host's code is written against, and each
fails if a rebuilt program changes it. They run the program through `pdf_kernel.py` and carry the `runtime` marker; they
skip, with a reason, when the engine or the program is absent. They import nothing of the PDF host, so they run on their
own.

- the ABI reply and the feature list the host gate reads: the program answers a request of any 3.x ABI, so
  the gate reads the reply, never the acceptance;
- the kernel verifies NO signature value: a forged value under a valid structure reads the same structure;
- the seal's token: the in-process authority's token over SHA-256 of the signature value, asked
  with channel `seal`, is accepted by `complete`, and `verify` reports it as covering the value, with the digest, the
  content type and the certificate binding holding and `verify_over` empty;
- what a layout name, a non-PDF and a revision do (the codes the host maps).
"""

import hashlib
import io
import json
import os
import time
from typing import Any, cast

import pytest
from pdf_kernel import (
    ENV,
    PdfKernelSession,
    b64,
    long_document,
    padded_pdf,
    pdf_session,
    rsa_verify,
    two_fonts,
    unb64,
)
from tsa_support import make_authority

from datum_core.testing.tsa_pki import DocumentPki, TsaPki, build_document_pki
from datum_core.timestamp import TimestampToken
from datum_sandbox.protocol import PDF_ABI_MIN, ProgramLimits
from datum_sandbox.wasi import RunBudget, RunEnd

pytestmark = pytest.mark.runtime

REQUIRED_FEATURES = {"signature", "verify-detail", "output-safety", "render-caps", "attachment-types"}


@pytest.fixture(scope="module")
def session() -> Any:
    with pdf_session() as started:
        yield started


@pytest.fixture(scope="module")
def document_pki() -> DocumentPki:
    return build_document_pki()


def semver(text: str) -> tuple[int, ...]:
    return tuple(int(part) for part in text.split("."))


def token_over(authority: Any) -> Any:
    def make(value: bytes) -> bytes:
        return bytes(authority.request(hashlib.sha256(value).digest(), "sha256", channel="seal").response)

    return make


# -- the gate: ABI and features ----------------------------------------------------------------------------------------
def test_the_program_reports_an_abi_at_least_the_floor_and_the_features_the_gate_reads(
    session: PdfKernelSession,
) -> None:
    answer = session.capabilities()
    assert semver(answer["abi"]) >= semver(PDF_ABI_MIN)
    assert set(answer["features"]) >= REQUIRED_FEATURES
    assert isinstance(answer["features"], list)


def test_the_built_program_reports_exactly_the_floor_so_the_floor_needs_no_lowering(session: PdfKernelSession) -> None:
    # The floor (4.0.0) is what the packaged program says, so no lower version is used.
    assert session.capabilities()["abi"] == "4.0.0" == PDF_ABI_MIN


def test_the_program_answers_a_request_of_another_minor_of_the_same_major(session: PdfKernelSession) -> None:
    # `pdfAbiCompatible` is major-only: acceptance proves nothing, so the host reads the reply's abi.
    other = session.call({"abi": "4.99.0", "op": "capabilities"})
    assert other["ok"] is True
    assert other["abi"] == "4.0.0"


def test_a_request_of_another_major_is_refused_with_abi_mismatch(session: PdfKernelSession) -> None:
    refused = session.call({"abi": "3.18.0", "op": "capabilities"})
    assert refused["ok"] is False
    assert refused["error"]["code"] == "abi_mismatch"


# -- the kernel verifies structure, never the value --------------------------------------------------------------------
def test_a_forged_value_under_a_valid_structure_reads_exactly_like_a_real_one_to_the_kernel(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    from cryptography.exceptions import InvalidSignature  # noqa: PLC0415 - tests only
    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415

    real = session.sign_with(document_pki.signer)
    forged = session.sign_with(document_pki.signer, value=lambda tbs: document_pki.signer.sign(tbs + b"x"))
    for signed in (real, forged):
        report = session.first_signature(signed.data)
        assert report["digestMatches"] is True
        assert report["certificateMatches"] is True
        assert report["coversDocument"] is True
    forged_report = session.first_signature(forged.data)
    key = serialization.load_der_public_key(unb64(forged_report["signer"]["publicKey"]))
    with pytest.raises(InvalidSignature):
        rsa_verify(key, unb64(forged_report["signature"]), unb64(forged_report["toBeVerified"]))
    real_report = session.first_signature(real.data)
    rsa_verify(key, unb64(real_report["signature"]), unb64(real_report["toBeVerified"]))


def test_the_kernel_accepts_a_raw_p256_value_and_embeds_the_der_of_the_same_numbers(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    """RECORDED, NEVER RELIED ON: `complete` takes the IEEE P1363 ``r||s`` of an ECDSA P-256 signature.

    The host hands the program DER only (`wire_signature_value` converts); that the 4.0.0 program does not refuse the
    raw form, and writes the DER of the same two numbers, is a fact of this build that a rebuilt program may change.
    """
    from cryptography.hazmat.primitives.asymmetric import utils  # noqa: PLC0415 - tests only

    def raw(to_be_signed: bytes) -> bytes:
        r, s = utils.decode_dss_signature(document_pki.ec.sign(to_be_signed))
        return r.to_bytes(32, "big") + s.to_bytes(32, "big")

    signed = session.sign_with(document_pki.ec, value=raw)
    assert len(signed.value) == 64
    report = session.first_signature(signed.data)
    embedded = unb64(report["signature"])
    assert utils.decode_dss_signature(embedded) == (
        int.from_bytes(signed.value[:32], "big"),
        int.from_bytes(signed.value[32:], "big"),
    ), "the program embeds the DER of the same r and s"
    assert report["digestMatches"] is True


def test_the_report_carries_what_the_host_checks_the_value_with(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    report = session.first_signature(session.sign_with(document_pki.signer, reason="Submitted").data)
    assert {"toBeVerified", "signature", "signatureAlgorithm", "byteRange", "signingTime", "signedDocumentId"} <= set(
        report
    )
    assert {"certificate", "publicKey", "subject", "issuer"} <= set(report["signer"])
    assert report["signerSource"] == "signature"
    assert report["reason"] == "Submitted"
    assert report["certification"] is None


# -- the seal's token ------------------------------------------------------------------------------------
def test_complete_accepts_a_token_the_authority_issues_over_the_signature_values_sha256_and_verify_reports_it(
    session: PdfKernelSession, document_pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    authority = make_authority(tsa_pki.rsa)
    signed = session.sign_with(
        document_pki.signer, token=token_over(authority), certify="noChanges", reason="Submitted"
    )
    assert signed.completed["timestamped"] is True
    known = [tsa_pki.rsa.leaf_der, tsa_pki.rsa.root_der]
    report = session.first_signature(signed.data, known=known)
    stamp = report["timestamp"]
    assert stamp["coversSignature"] is True
    assert stamp["messageDigestMatches"] is True
    assert stamp["contentTypeMatches"] is True
    assert stamp["certificateMatches"] is True
    assert stamp["imprintAlgorithm"] == "2.16.840.1.101.3.4.2.1"  # SHA-256
    assert unb64(stamp["imprint"]) == hashlib.sha256(unb64(report["signature"])).digest()
    # the host's own check of the same token over the same value: nothing is left over
    token = TimestampToken.parse(unb64(stamp["token"]))
    assert token.verify_over(unb64(report["signature"]), known) == ()


def test_a_token_over_another_value_is_refused_by_complete_with_the_signature_code(
    session: PdfKernelSession, document_pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    authority = make_authority(tsa_pki.rsa)
    other = authority.request(hashlib.sha256(b"another value").digest(), "sha256", channel="seal").response
    prepared = session.sign(session.unsigned_pdf(), [document_pki.signer.leaf_der], timestamp=True)
    value = document_pki.signer.sign(unb64(prepared["signing"]["toBeSigned"]))
    refused = session.complete(prepared, [document_pki.signer.leaf_der], value, token=bytes(other))
    assert refused["ok"] is False
    assert refused["error"]["code"] == "signature"


def test_without_the_authoritys_certificate_known_the_token_is_still_reported_with_its_own_chain(
    session: PdfKernelSession, document_pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    authority = make_authority(tsa_pki.rsa)
    signed = session.sign_with(document_pki.signer, token=token_over(authority))
    stamp = session.first_signature(signed.data)["timestamp"]
    assert stamp["signerSource"] == "token"  # the request asked certReq, so the token carries the TSA's certificate
    assert stamp["certificateMatches"] is True


def test_a_signature_without_a_token_has_no_timestamp_member(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    assert "timestamp" not in session.first_signature(session.sign_with(document_pki.signer).data)


# -- what the host maps: layouts, non-PDFs, revisions ------------------------------------------------------------------
def test_an_unknown_layout_id_is_not_the_kernels_refusal_so_layout_not_found_is_the_hosts_decision(
    session: PdfKernelSession,
) -> None:
    answer = session.document(layoutId="no-such-layout")
    assert answer["ok"] is True
    assert answer["layoutKind"] == "derived"


def test_a_non_pdf_is_the_kernels_internal_error_on_verify_and_template_on_fill(session: PdfKernelSession) -> None:
    verify = session.verify(b"hello")
    assert verify["ok"] is False
    assert verify["error"]["code"] == "internal"
    filled = session.fill(template={"data": b64(b"hello")})
    assert filled["ok"] is False
    assert filled["error"]["code"] == "template"


def test_an_unsigned_pdf_verifies_with_no_signatures(session: PdfKernelSession) -> None:
    answer = session.verify(session.unsigned_pdf())
    assert answer["ok"] is True
    assert answer["signatures"] == []


def test_a_certification_refuses_a_second_signature_with_the_signature_code(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    certified = session.sign_with(document_pki.signer, certify="noChanges")
    again = session.sign(certified.data, [document_pki.signer.leaf_der], reason="again")
    assert again["ok"] is False
    assert again["error"]["code"] == "signature"


def test_a_revision_appended_after_a_certification_is_reported_with_changes_that_are_not_permitted(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    pytest.importorskip("pyhanko")
    from pyhanko.pdf_utils import generic  # noqa: PLC0415 - tests only
    from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter  # noqa: PLC0415

    certified = session.sign_with(document_pki.signer, certify="noChanges")
    writer: Any = IncrementalPdfFileWriter(io.BytesIO(certified.data))
    writer.root["/Lang"] = generic.TextStringObject("fr")
    writer.update_root()
    out = io.BytesIO()
    writer.write(out)
    report = session.first_signature(out.getvalue())
    assert report["digestMatches"] is True
    assert report["coversDocument"] is False
    assert report["laterRevisions"]["permitted"] is False
    assert report["laterRevisions"]["revisions"] == 1


def test_a_flipped_byte_inside_the_range_breaks_the_digest(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    signed = session.sign_with(document_pki.signer)
    flipped = bytearray(signed.data)
    flipped[200] ^= 1
    assert session.first_signature(bytes(flipped))["digestMatches"] is False


def test_the_documents_id_is_the_first_sixteen_bytes_of_the_sha256_of_the_env_document_id(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    from pdf_kernel import ENV  # noqa: PLC0415 - one name

    signed = session.sign_with(document_pki.signer)
    expected = hashlib.sha256(ENV["documentId"].encode()).hexdigest()[:32]
    assert session.verify(signed.data)["documentId"] == expected
    assert session.first_signature(signed.data)["signedDocumentId"] == expected


# -- limits: what the default PDF budget does with big inputs ---------------------------------------------
MIB = 1024 * 1024
MEASURE = os.environ.get("DATUM_PDF_LIMITS") == "1"
needs_measure = pytest.mark.skipif(
    not MEASURE, reason="a measurement of minutes (set DATUM_PDF_LIMITS=1) that prints the peaks it finds"
)


def budget(session: PdfKernelSession, *, memory: int, seconds: float) -> RunBudget:
    base = session.budget
    return RunBudget(
        wall_seconds=seconds,
        memory_bytes=memory,
        stdout_cap=base.stdout_cap,
        stderr_cap=base.stderr_cap,
        wait=base.wait,
        pool=base.pool,
    )


def answer_of(session: PdfKernelSession, request: dict[str, Any], run_budget: RunBudget) -> dict[str, Any]:
    result = session.run(request, run_budget)
    assert result.end is RunEnd.CLEAN, result.end
    return cast("dict[str, Any]", json.loads(result.stdout))


def test_the_default_pdf_budget_is_the_documented_256_mib_and_60_seconds(session: PdfKernelSession) -> None:
    assert session.budget.memory_bytes == 256 * MIB
    assert ProgramLimits().pdf_budget().memory_bytes == 256 * MIB
    assert ProgramLimits().pdf_budget().wall_seconds == 60


def test_a_document_past_the_page_cap_is_refused_with_render_limit_early(session: PdfKernelSession) -> None:
    request = {"abi": PDF_ABI_MIN, "op": "render", "document": long_document(201), "fonts": two_fonts(), "env": ENV}
    started = time.monotonic()
    answer = answer_of(session, request, budget(session, memory=256 * MIB, seconds=120))
    assert answer["ok"] is False
    assert answer["error"]["code"] == "render_limit"
    assert answer["error"]["message"].startswith("render.pageCap")
    assert time.monotonic() - started < 60


def test_a_one_mib_signed_file_verifies_inside_the_default_memory(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    signed = session.sign_with(document_pki.signer, padded_pdf(MIB), certify="noChanges")
    request = {"abi": PDF_ABI_MIN, "op": "verify", "pdf": {"data": b64(signed.data)}}
    answer = answer_of(session, request, budget(session, memory=256 * MIB, seconds=120))
    assert answer["ok"] is True
    assert len(answer["signatures"]) == 1


@needs_measure
def test_measured_a_200_page_render_passes_the_default_memory_and_the_time_it_takes_is_recorded(
    session: PdfKernelSession,
) -> None:
    """200 pages of short paragraphs: peak under 40 MiB; about 20 s on a laptop, inside the 60 s default."""
    request = {"abi": PDF_ABI_MIN, "op": "render", "document": long_document(200), "fonts": two_fonts(), "env": ENV}
    started = time.monotonic()
    answer = answer_of(session, request, budget(session, memory=256 * MIB, seconds=300))
    elapsed = time.monotonic() - started
    assert answer["ok"] is True
    assert answer["pageCount"] == 200
    print(f"200-page render: {elapsed:.1f} s")  # noqa: T201 - the measurement is the point of this row
    at_default = session.run(request, ProgramLimits().pdf_budget())
    print(f"200-page render at the {ProgramLimits().pdf_time_limit:g} s default: {at_default.end}")  # noqa: T201
    assert at_default.end is RunEnd.CLEAN, "the 60 s default holds the largest render the page cap allows"


@needs_measure
def test_measured_a_20_mib_verify_passes_the_default_memory_and_the_time_it_takes_is_recorded(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    """A 20 MiB signed file: peak between 144 and 151 MiB (under 256); about 80 s, past the 60 s default."""
    big = padded_pdf(int(19.9 * MIB))
    saved = session.budget
    session.budget = budget(session, memory=2048 * MIB, seconds=300)
    try:
        signed = session.sign_with(document_pki.signer, big, certify="noChanges")
    finally:
        session.budget = saved
    request = {"abi": PDF_ABI_MIN, "op": "verify", "pdf": {"data": b64(signed.data)}}
    started = time.monotonic()
    answer = answer_of(session, request, budget(session, memory=256 * MIB, seconds=300))
    elapsed = time.monotonic() - started
    assert answer["ok"] is True
    print(f"20 MiB verify: {elapsed:.1f} s")  # noqa: T201 - the measurement is the point of this row
    at_default = session.run(request, ProgramLimits().pdf_budget())
    assert at_default.end is RunEnd.BUDGET, "at the 60 s default a 20 MiB verify is a budget stop"


@needs_measure
def test_measured_a_file_of_the_default_verify_cap_verifies_inside_the_default_budget(
    session: PdfKernelSession, document_pki: DocumentPki
) -> None:
    """A file of the verify cap's default (20 MiB) is read inside the 60 s and 256 MiB defaults."""
    limits = ProgramLimits()
    assert limits.verify_max_bytes == 20 * MIB
    big = padded_pdf(limits.verify_max_bytes - 256 * 1024)  # the signature adds about 150 KiB to the padded file
    saved = session.budget
    session.budget = budget(session, memory=2048 * MIB, seconds=300)
    try:
        signed = session.sign_with(document_pki.signer, big, certify="noChanges")
    finally:
        session.budget = saved
    assert limits.verify_max_bytes - 256 * 1024 < len(signed.data) <= limits.verify_max_bytes
    request = {"abi": PDF_ABI_MIN, "op": "verify", "pdf": {"data": b64(signed.data)}}
    started = time.monotonic()
    at_default = session.run(request, limits.pdf_budget())
    elapsed = time.monotonic() - started
    print(f"{len(signed.data) / MIB:.2f} MiB verify at the defaults: {at_default.end}, {elapsed:.1f} s")  # noqa: T201
    assert at_default.end is RunEnd.CLEAN, "the default verify cap must be a file the default PDF budget reads"
