"""The seal: sign, certify and timestamp what is issued.

`datum.pdf.seal.*` presets what `PdfService` signs: `render` and `fill` of POSTED answers (nothing stored) are sealed
with the throwaway "Datum test seal" unless `posted_answers=true`; `render_submission` (an accepted submission) is
sealed with the server's key, its `documentId` the submission's digest; `sign` keeps its explicit shape and always uses
the server's key. The order is contract: customizers, the kernel, every validator, and only then the signature, the
timestamp, `complete` and the event, so a refused PDF costs no signature, no timestamp, no serial and no event. The
timestamp is the SHA-256 of the signature VALUE asked of the `Timestamper` with channel `seal` (no `timestampRequest`
run); `TimestampClientError` and `TimestampRefusedError` are the `sealing.timestamp` warning, any other raise is not.
`test_pdf_program_facts.py` shows the real program's `complete` accepts such a token.
"""

import base64
import hashlib
import logging
from datetime import datetime
from typing import Any

import pytest
from cryptography.hazmat.primitives.asymmetric.utils import decode_dss_signature, encode_dss_signature
from pdf_support import (
    ABI,
    FORM,
    IdentitySigner,
    accepted_submission,
    b64,
    common_name,
    completion,
    fake_pdf,
    pdf_definition,
    signature_request,
    started_pdf,
    template_layout,
)

from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.pdf.outcomes import Printed
from datum_core.pdf.signer import TestSealSigner
from datum_core.submissions import Unavailable
from datum_core.testing.tsa_pki import INSTANT, DocumentPki, TsaPki, build_document_pki
from datum_core.timestamp.client import TimestampClientError
from datum_core.timestamp.protocols import TimestampRefusedError
from datum_sandbox.protocol import PdfKernelError

SEAL_CN = "Datum test seal"
SECOND = {"enabled": True, "timestamp": True}
TWO_CALLS = {"pdf": {"seal": {"enabled": True, "timestamp": False, "layouts": ["default"]}}}
"""A preset that seals one listed layout: the program chooses `default`, so the layout is known after the first run."""
TWO_CALL_FORM = pdf_definition(template_layout("default"))


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def printed(outcome: Any) -> Printed:
    assert isinstance(outcome, Printed), outcome
    return outcome


def codes(outcome: Printed) -> list[str]:
    return [warning.code for warning in outcome.warnings]


# -- whose key seals what ----------------------------------------------------------------------------------------------
def test_posted_answers_are_sealed_with_the_test_seal_and_never_the_servers_key(pki: DocumentPki) -> None:
    with started_pdf(signer=pki.signer) as rig:
        out = printed(rig.render())
        certificates = signature_request(rig)["certificates"]
    assert common_name(base64.b64decode(certificates[0])) == SEAL_CN
    assert rig.signer is not None
    assert rig.signer.signs == []
    assert SEAL_CN in (out.signed_by or "")
    assert (out.signature_field or "").strip() != ""


def test_posted_answers_use_the_servers_key_when_the_setting_says_so(pki: DocumentPki) -> None:
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}, signer=pki.signer
    ) as rig:
        out = printed(rig.render())
        certificates = signature_request(rig)["certificates"]
    assert certificates[0] == b64(pki.signer.leaf_der)
    assert rig.signer is not None
    assert len(rig.signer.signs) == 1
    assert "Test document signer" in (out.signed_by or "")


def test_an_accepted_submission_is_sealed_with_the_servers_key_and_its_digest_is_the_document_id(
    pki: DocumentPki,
) -> None:
    accepted = accepted_submission(digest="cd" * 32)
    with started_pdf(signer=pki.signer) as rig:
        out = printed(rig.render_submission(accepted))
        request = rig.runtime.requests("document")[0]
    assert request["signature"]["certificates"][0] == b64(pki.signer.leaf_der)
    assert request["env"]["documentId"] == "cd" * 32
    assert rig.signer is not None
    assert len(rig.signer.signs) == 1
    assert "Test document signer" in (out.signed_by or "")


def test_the_explicit_sign_route_always_uses_the_servers_key_even_with_the_seal_off(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, signer=pki.signer) as rig:
        out = printed(rig.sign())
        certificates = signature_request(rig)["certificates"]
    assert certificates[0] == b64(pki.signer.leaf_der)
    assert out.signed_by
    assert SEAL_CN not in out.signed_by


def test_the_explicit_sign_route_never_uses_the_test_seal() -> None:
    with started_pdf({"pdf": {"seal": {"enabled": True}}}) as rig:
        outcome = rig.sign()
    assert not isinstance(outcome, Printed), "no key: sign cannot fall back to the throwaway certificate"
    assert rig.runtime.requests("sign") == [], "the program is never asked to prepare the explicit signature"
    assert rig.runtime.requests("document") == [] or all("signature" not in r for r in rig.runtime.requests("document"))
    assert rig.runtime.requests("complete") == []


def test_render_submission_with_the_seal_on_and_no_key_is_the_500_and_never_falls_back_to_the_test_seal() -> None:
    """An accepted submission is sealed with the server's key or not printed at all: the 500 `signature`."""
    from datum_core.pdf.outcomes import PdfSignatureError  # noqa: PLC0415 - one use

    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}) as rig:
        with pytest.raises(PdfSignatureError) as raised:
            rig.render_submission()
        assert (raised.value.code, raised.value.status) == ("signature", 500)
        assert all("signature" not in call.request for call in rig.runtime.calls)
        assert rig.runtime.requests("sign") == []
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []
        posted = printed(rig.render())  # the same start still seals posted answers with the test seal
        assert SEAL_CN in (posted.signed_by or "")


def test_fill_of_posted_answers_is_sealed_like_render(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("t1"))
    with started_pdf(signer=pki.signer, form=form) as rig:
        out = printed(rig.fill("t1"))
        certificates = signature_request(rig)["certificates"]
    assert common_name(base64.b64decode(certificates[0])) == SEAL_CN
    assert out.layout_id == "t1"


def test_with_the_seal_off_a_pdf_is_unsigned_and_no_key_is_touched(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, signer=pki.signer) as rig:
        out = printed(rig.render())
    assert out.signed_by is None
    assert out.signature_field is None
    assert out.timestamped is False
    assert rig.signer is not None
    assert rig.signer.signs == []
    assert all("signature" not in call.request for call in rig.runtime.calls)
    assert rig.runtime.requests("complete") == []


# -- which layouts, which settings -------------------------------------------------------------------------------------
def test_only_the_listed_layouts_are_sealed_and_an_empty_list_means_all(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("sealed"), template_layout("plain"))
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "layouts": ["sealed"]}}}
    with started_pdf(config, signer=pki.signer, form=form) as rig:
        sealed = printed(rig.fill("sealed"))
        plain = printed(rig.fill("plain"))
    assert sealed.signed_by is not None
    assert plain.signed_by is None
    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer, form=form) as rig:
        assert printed(rig.fill("sealed")).signed_by is not None
        assert printed(rig.fill("plain")).signed_by is not None


def test_the_certification_reason_location_and_visibility_reach_the_kernel(pki: DocumentPki) -> None:
    seal = {
        "enabled": True,
        "timestamp": False,
        "certify": "formFilling",
        "reason": "Filed",
        "location": "Ottawa",
        "visible": False,
    }
    with started_pdf({"pdf": {"seal": seal}}, signer=pki.signer) as rig:
        printed(rig.render())
        settings = signature_request(rig)
    assert settings["certify"] == "formFilling"
    assert settings["reason"] == "Filed"
    assert settings["location"] == "Ottawa"
    assert settings["appearance"] is False


def test_an_approval_seal_asks_the_program_for_no_certification(pki: DocumentPki) -> None:
    seal = {"enabled": True, "timestamp": False, "certify": "none"}
    with started_pdf({"pdf": {"seal": seal}}, signer=pki.signer) as rig:
        printed(rig.render())
        settings = signature_request(rig)
    assert settings["certify"] is False


def test_by_default_a_seal_certifies_with_no_changes_and_leaves_the_appearance_to_the_layout(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer) as rig:
        printed(rig.render())
        settings = signature_request(rig)
    assert settings["certify"] == "noChanges"
    assert "appearance" not in settings
    assert "reason" not in settings
    assert "location" not in settings


def test_the_signature_request_carries_no_key_no_password_and_no_value(pki: DocumentPki) -> None:
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}, signer=pki.signer
    ) as rig:
        printed(rig.render())
        settings = signature_request(rig)
    assert set(settings) <= {
        "certificates",
        "certify",
        "reason",
        "location",
        "appearance",
        "timestamp",
        "name",
        "field",
        "required",
        "commitment",
        "contactInfo",
        "subFilter",
    }
    assert "value" not in settings


# -- the value and the token -------------------------------------------------------------------------------------------
def test_the_signature_value_the_signer_made_is_what_complete_embeds(pki: DocumentPki) -> None:
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}, signer=pki.signer
    ) as rig:
        printed(rig.render())
        signing = completion(rig)
        (to_be_signed,) = rig.signer.signs  # type: ignore[union-attr]
    assert signing["value"] == b64(pki.signer.sign(to_be_signed))
    assert signing["toBeSignedDigest"] == b64(hashlib.sha256(to_be_signed).digest())
    assert "timestamp" not in signing


def test_the_timestamp_is_the_sha256_of_the_signature_value_asked_with_channel_seal_and_no_timestamp_request_run(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        out = printed(rig.render_submission())
        signing = completion(rig)
        assert rig.timestamper is not None
        ((imprint, algorithm, channel, _policy, cert_req),) = rig.timestamper.requests
        (grant,) = rig.timestamper.grants
    value = base64.b64decode(signing["value"])
    assert imprint == hashlib.sha256(value).digest()
    assert algorithm == "sha256"
    assert channel == "seal"
    assert cert_req is True
    assert signing["timestamp"]["token"] == b64(grant.response), "the whole TimeStampResp, not the bare token"
    assert "timestampRequest" not in rig.runtime.ops()
    assert out.timestamped is True


def test_the_kernel_is_told_to_reserve_room_when_a_timestamp_is_wanted(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        printed(rig.render_submission())
        assert signature_request(rig)["timestamp"] is True
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer, tsa=tsa_pki.rsa
    ) as rig:
        printed(rig.render_submission())
        assert signature_request(rig).get("timestamp") in (None, False)
        assert rig.timestamper is not None
        assert rig.timestamper.requests == []


@pytest.mark.parametrize(
    "error",
    [
        TimestampClientError("unreachable"),
        TimestampClientError("rejected", pki_status=2, fail_info=("badAlg",), server_text="no"),
        TimestampRefusedError("systemFailure", "the authority is down"),
    ],
)
def test_a_timestamp_the_authority_or_the_server_refuses_is_a_warning_and_the_seal_goes_on(
    pki: DocumentPki, tsa_pki: TsaPki, error: Exception
) -> None:
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        assert rig.timestamper is not None
        rig.timestamper.error = error
        out = printed(rig.render_submission())
        signing = completion(rig)
    assert "sealing.timestamp" in codes(out)
    assert out.timestamped is False
    assert out.signed_by is not None
    assert "timestamp" not in signing
    assert "PdfRenderedEvent" in rig.kinds()


def test_any_other_error_from_a_timestamper_is_not_swallowed_and_publishes_nothing(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        assert rig.timestamper is not None
        rig.timestamper.error = RuntimeError("a defect in the timestamper")
        with pytest.raises(RuntimeError, match="defect"):
            rig.render_submission()
    assert rig.runtime.requests("complete") == []
    assert rig.kinds() == []


def test_a_seal_that_wants_a_timestamp_with_no_timestamper_is_signed_with_the_sealing_timestamp_warning(
    pki: DocumentPki,
) -> None:
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer) as rig:
        out = printed(rig.render_submission())
    assert "sealing.timestamp" in codes(out)
    assert out.timestamped is False
    assert out.signed_by is not None


def test_a_custom_timestamper_is_asked_the_same_way(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    from pdf_support import RecordingTimestamper  # noqa: PLC0415 - one use

    mine = RecordingTimestamper(tsa_pki.rsa)
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, timestamper=mine) as rig:
        printed(rig.render_submission())
    assert [item[2] for item in mine.requests] == ["seal"]


# -- the order: a refused PDF costs nothing ----------------------------------------------------------------------------
def order_hooks(trail: list[str]) -> dict[str, Any]:
    def customizer(draft: Any) -> None:
        trail.append("pdf.customizer")

    def validator(candidate: Any) -> HookFindings | None:
        trail.append("pdf.validator")
        return None

    return {"pdf_request_customizers": [customizer], "pdf_result_validators": [validator]}


def test_the_order_is_customizer_kernel_validator_signature_timestamp_complete_event(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    trail: list[str] = []
    with started_pdf(
        {"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa, trail=trail, **order_hooks(trail)
    ) as rig:
        printed(rig.render_submission())
        steps = [
            "pdf.customizer",
            "pdf.document",
            "pdf.validator",
            "signer.sign",
            "timestamper.request",
            "pdf.complete",
            "event:PdfRenderedEvent",
        ]
        assert [rig.position(step) for step in steps] == sorted(rig.position(step) for step in steps)
        assert rig.trail.count("pdf.validator") == 1
        assert rig.trail.count("signer.sign") == 1


def test_a_validator_that_refuses_costs_no_signature_no_timestamp_no_complete_and_no_event(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    def refuse(candidate: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem(None, "too.big", "no"),))

    with started_pdf(
        {"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa, pdf_result_validators=[refuse]
    ) as rig:
        rig.render_submission()
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.timestamper is not None
        assert rig.timestamper.requests == []
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []


def test_a_validator_that_raises_a_refusal_costs_the_same_nothing(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    def refuse(candidate: Any) -> None:
        raise HookRefusedError.forbidden("no.way", "not for you")

    with started_pdf(
        {"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa, pdf_result_validators=[refuse]
    ) as rig:
        with pytest.raises(HookRefusedError):
            rig.render_submission()
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.timestamper is not None
        assert rig.timestamper.requests == []
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []


def test_every_validator_sees_the_bytes_before_any_signature_and_complete_embeds_into_those_bytes(
    pki: DocumentPki,
) -> None:
    seen: list[tuple[bytes, int]] = []
    trail: list[str] = []

    def validator(candidate: Any) -> None:
        seen.append((candidate.pdf, len(trail)))
        trail.append("pdf.validator")

    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}
    with started_pdf(config, signer=pki.signer, trail=trail, pdf_result_validators=[validator, validator]) as rig:
        printed(rig.render())
        (request,) = rig.runtime.requests("complete")
    assert len(seen) == 2
    assert all("signer.sign" not in trail[:index] for _data, index in seen)
    assert request["pdf"]["data"] == b64(seen[0][0]), "complete embeds into the bytes the validators let go"


def test_a_kernel_refusal_of_the_seal_is_a_raise_and_no_key_is_used(pki: DocumentPki) -> None:
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}, signer=pki.signer
    ) as rig:
        rig.runtime.fail("document", "signature", "A signature needs at least the signer's certificate")
        with pytest.raises(PdfKernelError) as raised:
            rig.render()
        assert raised.value.code == "signature"
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.kinds() == []


def test_a_handoff_for_another_algorithm_than_the_signers_is_refused_before_signing(pki: DocumentPki) -> None:
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}, signer=pki.signer
    ) as rig:

        def handoff(request: dict[str, Any]) -> dict[str, Any]:
            answer = rig.runtime._default("document", request)
            answer["signing"]["signatureAlgorithm"] = "ECDSA-P256-SHA256"
            return answer

        rig.runtime.on("document", handoff)
        with pytest.raises(Exception) as caught:  # noqa: PT011 - class is the service's choice
            rig.render()
        assert not isinstance(caught.value, (AttributeError, TypeError))
        assert (getattr(caught.value, "code", None), getattr(caught.value, "status", None)) == ("signature", 500)
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.runtime.requests("complete") == []


def test_a_signer_that_raises_is_the_500_signature_publishes_nothing_and_completes_nothing(
    pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    """The application's signer (a key store, a token) failing is a seal the server could not make.

    Its exception stays in the log: the refusal carries Datum's words and no cause or context chain.
    """
    from datum_core.pdf.outcomes import PdfSignatureError  # noqa: PLC0415 - one use

    class Failing(IdentitySigner):
        def sign(self, to_be_signed: bytes) -> bytes:
            raise OSError("the HSM is gone: SECRET-KEY-HANDLE slot 9")

    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}
    with started_pdf(config, pdf_signer=Failing(pki.signer)) as rig:
        with caplog.at_level(logging.DEBUG, logger="datum.pdf"), pytest.raises(PdfSignatureError) as raised:
            rig.render()
        assert (raised.value.code, raised.value.status) == ("signature", 500)
        assert "SECRET" not in str(raised.value)
        assert raised.value.__cause__ is None
        assert raised.value.__suppress_context__
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []
    assert any(
        record.levelno >= logging.ERROR and "OSError" in record.getMessage()
        for record in caplog.records
        if record.name == "datum.pdf"
    )


def test_a_signer_that_answers_unavailable_keeps_that_answer(pki: DocumentPki) -> None:
    """A signer that raises one of Datum's own errors (a stopped key service) is that answer, not a seal refused."""
    from datum_core.pdf.outcomes import PdfUnavailableError  # noqa: PLC0415 - one use

    class Stopped(IdentitySigner):
        def sign(self, to_be_signed: bytes) -> bytes:
            raise PdfUnavailableError("the key service has stopped")

    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}
    with started_pdf(config, pdf_signer=Stopped(pki.signer)) as rig:
        outcome = rig.render()
        assert isinstance(outcome, Unavailable), outcome
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []


# -- what a custom signer may return -----------------------------------------------------------------------------------
class RawEcSigner(IdentitySigner):
    """An ECDSA signer whose value is the raw `r||s` of IEEE P1363 (what a KMS or a token often returns)."""

    def __init__(self, identity: Any, size: int) -> None:
        super().__init__(identity)
        self.size = size

    def sign(self, to_be_signed: bytes) -> bytes:
        r, s = decode_dss_signature(super().sign(to_be_signed))
        return r.to_bytes(self.size // 2, "big") + s.to_bytes(self.size // 2, "big")


def test_a_raw_p1363_value_is_converted_to_der_before_complete(pki: DocumentPki) -> None:
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}
    signer = RawEcSigner(pki.ec, 64)
    with started_pdf(config, pdf_signer=signer) as rig:
        printed(rig.render())
        value = base64.b64decode(completion(rig)["value"])
    r, s = decode_dss_signature(value)  # DER again: this raises on anything else
    assert encode_dss_signature(r, s) == value


@pytest.mark.parametrize("length", [1, 50, 63, 65, 97, 200])
def test_a_value_of_no_known_shape_is_refused_before_complete(pki: DocumentPki, length: int) -> None:
    class Garbage(IdentitySigner):
        def sign(self, to_be_signed: bytes) -> bytes:
            return b"\x01" * length

    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}
    with started_pdf(config, pdf_signer=Garbage(pki.ec)) as rig:
        with pytest.raises(Exception) as caught:  # noqa: PT011 - class is the service's choice
            rig.render()
        assert not isinstance(caught.value, (AttributeError, TypeError))
        assert (getattr(caught.value, "code", None), getattr(caught.value, "status", None)) == ("signature", 500)
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []


# -- the document's identity and time ----------------------------------------------------------------------------------
def test_a_posted_answers_document_id_is_a_fresh_random_token_and_the_time_is_the_datums_clock_in_utc(
    pki: DocumentPki,
) -> None:
    with started_pdf() as rig:
        printed(rig.render())
        printed(rig.render())
        first, second = (call.request["env"] for call in rig.runtime.calls if call.op == "document")
    for env in (first, second):
        assert len(env["documentId"]) == 32
        assert int(env["documentId"], 16) >= 0
        assert datetime.fromisoformat(env["createdAt"]) == INSTANT
    assert first["documentId"] != second["documentId"]


def test_the_kernel_requests_carry_the_current_abi_and_the_fixed_op_names(pki: DocumentPki) -> None:
    with started_pdf(signer=pki.signer) as rig:
        printed(rig.render())
    assert {call.request["abi"] for call in rig.runtime.calls} == {ABI}
    assert set(rig.runtime.ops()) <= {"document", "sign", "complete", "fill"}


def test_validators_are_told_the_form_the_operation_and_the_page_count(pki: DocumentPki) -> None:
    seen: list[tuple[str | None, str, int]] = []

    def validator(candidate: Any) -> None:
        seen.append((candidate.form_key, candidate.op, candidate.page_count))

    with started_pdf({"pdf": {"seal": {"enabled": False}}}, pdf_result_validators=[validator]) as rig:
        printed(rig.render())
        printed(rig.render_submission())
    assert seen == [(FORM, "render", 1), (FORM, "render_submission", 1)]


# -- guards: the seal refuses what it must not sign ---------------------------------------------------------------
def test_a_test_seal_signer_given_as_the_applications_signer_is_never_the_servers_key() -> None:
    from datum_core.pdf.outcomes import PdfSignatureError  # noqa: PLC0415 - one use

    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}}}
    with started_pdf(config, pdf_signer=TestSealSigner()) as rig:
        outcome = rig.sign()
        assert isinstance(outcome, Unavailable), outcome
        assert outcome.code == "server.unavailable"
        assert rig.runtime.requests("sign") == []
        assert rig.runtime.requests("complete") == []
        with pytest.raises(PdfSignatureError) as raised:
            rig.render_submission()
        assert (raised.value.code, raised.value.status) == ("signature", 500)
        assert all("signature" not in call.request for call in rig.runtime.calls)
        assert rig.service.certificate_chain() is None
        assert printed(rig.render()).seal == "test"


def test_on_the_two_call_path_the_validators_see_the_bytes_complete_embeds_into(pki: DocumentPki) -> None:
    seen: list[bytes] = []

    def validator(candidate: Any) -> None:
        seen.append(candidate.pdf)

    with started_pdf(TWO_CALLS, signer=pki.signer, form=TWO_CALL_FORM, pdf_result_validators=[validator]) as rig:
        printed(rig.render())
        (request,) = rig.runtime.requests("complete")
        assert rig.runtime.requests("sign")[0]["env"] == rig.runtime.requests("document")[0]["env"]
    assert seen == [fake_pdf("prepared")], "the sign reply's bytes, not the document reply's"
    assert seen[0] != fake_pdf("document")
    assert request["pdf"]["data"] == b64(seen[0])


def test_a_validator_that_refuses_on_the_two_call_path_costs_no_signature_no_complete_and_no_event(
    pki: DocumentPki,
) -> None:
    def refuse(candidate: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem(None, "too.big", "no"),))

    with started_pdf(TWO_CALLS, signer=pki.signer, form=TWO_CALL_FORM, pdf_result_validators=[refuse]) as rig:
        rig.render()
        assert rig.runtime.requests("sign") != [], "the program chose the layout, so the signature took the second call"
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.runtime.requests("complete") == []
        assert rig.kinds() == []


def test_a_layout_the_program_chooses_is_sealed_when_it_is_listed(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("default"))
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "layouts": ["default"]}}}
    with started_pdf(config, signer=pki.signer, form=form) as rig:
        out = printed(rig.render())
        assert out.seal == "test"
        assert all("signature" not in request for request in rig.runtime.requests("document"))
        assert sum("signature" in request for request in rig.runtime.requests("sign")) == 1


def test_a_layout_the_program_chooses_is_not_sealed_when_it_is_not_listed(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("default"))
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "layouts": ["other"]}}}
    with started_pdf(config, signer=pki.signer, form=form) as rig:
        out = printed(rig.render())
        assert out.signed_by is None
        assert rig.runtime.requests("sign") == []
        assert rig.runtime.requests("complete") == []
        assert rig.signer is not None
        assert rig.signer.signs == []


def test_posted_answers_with_the_servers_key_asked_for_and_no_key_keep_the_test_seal() -> None:
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False, "posted_answers": True}}}
    with started_pdf(config) as rig:
        out = printed(rig.render())
    assert out.seal == "test"
    assert SEAL_CN in (out.signed_by or "")


@pytest.mark.parametrize("op", ["render_submission", "sign"])
def test_a_stop_that_lands_between_the_validators_and_the_seal_answers_unavailable_503(
    pki: DocumentPki, tsa_pki: TsaPki, op: str
) -> None:
    """The module text's rule: after the owner's stop every call is `Unavailable` and no key is used (not a 500)."""
    holder: list[Any] = []

    def stop(candidate: Any) -> None:
        holder[0].datum.stop()

    with started_pdf(
        {"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa, pdf_result_validators=[stop]
    ) as rig:
        holder.append(rig)
        outcome = getattr(rig, op)()
        assert isinstance(outcome, Unavailable), outcome
        assert outcome.code == "server.unavailable"
        assert rig.signer is not None
        assert rig.signer.signs == []
        assert rig.timestamper is not None
        assert rig.timestamper.requests == []
        assert rig.runtime.requests("complete") == []
        assert "PdfRenderedEvent" not in rig.kinds()


# -- one run for sign, the customizer's env, the test seal is not timestamped ----------------------------
def test_sign_makes_one_program_run_and_the_document_call_carries_the_signature(pki: DocumentPki) -> None:
    """`covers("sign")` is known before any run, so the signature rides the document call (no `sign` run)."""
    with started_pdf(signer=pki.signer) as rig:
        out = printed(rig.sign())
        assert rig.runtime.ops() == ["document", "complete"]
        (document,) = rig.runtime.requests("document")
    assert document["signature"]["certificates"][0] == b64(pki.signer.leaf_der)
    assert out.seal == "server"
    assert out.signed_by is not None


def test_sign_with_a_layout_named_is_still_one_run(pki: DocumentPki) -> None:
    form = pdf_definition(template_layout("default"))
    with started_pdf(signer=pki.signer, form=form) as rig:
        printed(rig.sign(layout_id="default"))
        assert rig.runtime.ops() == ["document", "complete"]


def test_the_customizers_env_reaches_the_one_run_of_a_sign_and_its_completion(pki: DocumentPki) -> None:
    """A sign is one run: the customizer's env rides the document call, and `complete` is not given another."""

    def customizer(draft: Any) -> None:
        draft.env["tenant"] = "acme"

    with started_pdf(signer=pki.signer, pdf_request_customizers=[customizer]) as rig:
        printed(rig.sign())
        assert rig.runtime.ops() == ["document", "complete"]
        (document,) = rig.runtime.requests("document")
    assert document["env"]["tenant"] == "acme"
    assert set(document["env"]) >= {"documentId", "createdAt"}
    assert "sign" not in rig.runtime.ops()


def test_the_seal_timestamp_setting_says_the_test_seal_is_never_timestamped() -> None:
    """The setting's words are the contract of the test seal: the schema carries them to the docs."""
    from datum_core.config.models import Seal  # noqa: PLC0415 - one use

    words = Seal.model_fields["timestamp"].description or ""
    assert "test seal" in words
    assert "never timestamped" in words
    assert "datum.W011" in words
    import json  # noqa: PLC0415 - one use
    from pathlib import Path  # noqa: PLC0415

    import datum_core  # noqa: PLC0415

    schema = json.loads((Path(datum_core.__file__).parent / "datum-settings.schema.json").read_text(encoding="utf-8"))
    assert schema["$defs"]["Seal"]["properties"]["timestamp"]["description"] == words


def test_the_customizers_env_reaches_the_second_request_where_there_is_one(pki: DocumentPki) -> None:
    def customizer(draft: Any) -> None:
        draft.env["tenant"] = "acme"

    with started_pdf(TWO_CALLS, signer=pki.signer, form=TWO_CALL_FORM, pdf_request_customizers=[customizer]) as rig:
        printed(rig.render())
        (document,) = rig.runtime.requests("document")
        (second,) = rig.runtime.requests("sign")
    assert document["env"]["tenant"] == "acme"
    assert second["env"] == document["env"]


def test_the_posted_answer_test_seal_is_never_timestamped(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    """A seal that proves nothing burns no serial and makes no TSA request; the server's key keeps its timestamp."""
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        assert rig.timestamper is not None
        posted = printed(rig.render())
        assert posted.seal == "test"
        assert posted.timestamped is False
        assert "sealing.timestamp" not in codes(posted), "nothing was asked, so nothing is missing"
        assert rig.timestamper.requests == []
        assert rig.timestamper.grants == []
        assert "timestamp" not in signature_request(rig)
        assert "timestamp" not in completion(rig)
    with started_pdf({"pdf": {"seal": SECOND}}, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        assert rig.timestamper is not None
        filled = printed(rig.render_submission())
        assert filled.seal == "server"
        assert filled.timestamped is True
        assert len(rig.timestamper.requests) == 1


def test_the_servers_key_on_posted_answers_keeps_its_timestamp_and_the_test_seal_with_no_timestamper_says_nothing(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    config = {"pdf": {"seal": {**SECOND, "posted_answers": True}}}
    with started_pdf(config, signer=pki.signer, tsa=tsa_pki.rsa) as rig:
        out = printed(rig.render())
        assert (out.seal, out.timestamped) == ("server", True)
        assert signature_request(rig)["timestamp"] is True
    with started_pdf({"pdf": {"seal": SECOND}}) as rig:
        out = printed(rig.render())
    assert out.seal == "test"
    assert "sealing.timestamp" not in codes(out)
