"""`PdfRenderedEvent` and `PdfVerifiedEvent`, and the span `datum.pdf`.

Both are frozen slotted dataclasses of scalars in `datum_core.events`: `PdfRenderedEvent(form_key, op, bytes, layout_id,
signed, timestamped)` (`bytes` is the size of the answered file) after the seal, and `PdfVerifiedEvent(sha256, size,
document_id, signatures, trust_policy)` after a verify (`signatures` the COUNT and `trust_policy` the summary's name).
They are published after the effect, from the scoped dispatcher, never on a refusal (throttle, availability, dry run,
customizer, kernel, validator, unknown layout, a file that is not a PDF), once per success; a listener that raises
changes no answer. The spans `datum.pdf` (`datum.pdf.op`, `datum.outcome`, `datum.pdf.seal` server, test or none,
`datum.pdf.timestamp` site, custom, server or none, `datum.form`) and `datum.pdf.run`, and the histogram
`datum.pdf.output.size` (`By`, per `datum.pdf.op`) carry no answers, bytes, digests or keys.
"""

import dataclasses
import hashlib
import logging
from datetime import datetime
from typing import Any

import pytest
from observe_support import telemetry
from pdf_support import (
    FORM,
    anchors_file,
    b64,
    fake_pdf,
    pdf_definition,
    signature_report,
    started_pdf,
    template_layout,
    verify_reply,
)
from submissions_support import assign

from datum_core.events import DatumEvent, PdfRenderedEvent, PdfVerifiedEvent, listener
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.loggers import EVENTS
from datum_core.pdf import PdfTrustPolicy
from datum_core.testing.tsa_pki import DocumentPki, TsaPki, build_document_pki
from datum_sandbox.protocol import PdfKernelError
from datum_sandbox.wasi import EngineBusyError, EngineStrayBoundError, RunEnd

SCALARS = (int, float, str, bool, type(None))


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def test_the_rendered_event_is_a_frozen_slotted_record_of_the_six_fields() -> None:
    assert [f.name for f in dataclasses.fields(PdfRenderedEvent)] == [
        "form_key",
        "op",
        "bytes",
        "layout_id",
        "signed",
        "timestamped",
    ]
    event = PdfRenderedEvent("contact", "render", 10, None, False, False)
    assert isinstance(event, DatumEvent)
    assert not hasattr(event, "__dict__")
    with pytest.raises(dataclasses.FrozenInstanceError):
        assign(event, "bytes", 11)


def test_the_verified_event_is_a_frozen_slotted_record_of_the_five_fields() -> None:
    assert [f.name for f in dataclasses.fields(PdfVerifiedEvent)] == [
        "sha256",
        "size",
        "document_id",
        "signatures",
        "trust_policy",
    ]
    event = PdfVerifiedEvent("ab" * 32, 10, None, 1, "default")
    assert isinstance(event, DatumEvent)
    assert not hasattr(event, "__dict__")
    with pytest.raises(dataclasses.FrozenInstanceError):
        assign(event, "signatures", 2)


def test_both_events_hold_scalars_only() -> None:
    for event in (PdfRenderedEvent("c", "render", 1, "l", True, False), PdfVerifiedEvent("ab", 1, "id", 2, "default")):
        for value in dataclasses.astuple(event):
            assert isinstance(value, SCALARS)
    assert not any(isinstance(v, datetime) for v in dataclasses.astuple(PdfVerifiedEvent("a", 1, None, 0, "default")))


def test_a_listener_typed_for_each_event_is_accepted() -> None:
    def on_rendered(event: PdfRenderedEvent) -> None:
        assert event.bytes >= 0

    def on_verified(event: PdfVerifiedEvent) -> None:
        assert event.signatures >= 0

    listener(PdfRenderedEvent, on_rendered)
    listener(PdfVerifiedEvent, on_verified)


# -- when the rendered event is published ------------------------------------------------------------------------------
def test_each_answered_operation_publishes_one_rendered_event_with_its_op_the_size_and_the_layout(
    pki: DocumentPki,
) -> None:
    form = pdf_definition(template_layout("t1"))
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, form=form, signer=pki.signer) as rig:
        printed = [rig.render(), rig.fill("t1"), rig.sign(), rig.render_submission()]
        events = [e for e in rig.events if isinstance(e, PdfRenderedEvent)]
    assert [e.op for e in events] == ["render", "fill", "sign", "render_submission"]
    assert [e.bytes for e in events] == [len(p.data) for p in printed]
    assert all(e.form_key == FORM for e in events)
    assert events[1].layout_id == "t1"
    assert [e.signed for e in events] == [False, False, True, False]


def test_a_sealed_timestamped_pdf_says_so(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": True}}}, signer=pki.signer, tsa=tsa_pki.rsa
    ) as rig:
        rig.render_submission()
        (event,) = [e for e in rig.events if isinstance(e, PdfRenderedEvent)]
    assert (event.signed, event.timestamped) == (True, True)


def test_a_sealed_pdf_whose_timestamp_was_refused_is_signed_and_not_timestamped(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    from datum_core.timestamp import TimestampRefusedError  # noqa: PLC0415 - one use

    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": True}}}, signer=pki.signer, tsa=tsa_pki.rsa
    ) as rig:
        assert rig.timestamper is not None
        rig.timestamper.error = TimestampRefusedError("systemFailure")
        rig.render_submission()
        (event,) = [e for e in rig.events if isinstance(e, PdfRenderedEvent)]
    assert (event.signed, event.timestamped) == (True, False)


def test_the_event_comes_after_the_seal_and_before_the_answer_returns(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer) as rig:
        rig.render_submission()
        assert rig.position("pdf.complete") < rig.position("event:PdfRenderedEvent")
        assert rig.trail[-1] == "event:PdfRenderedEvent"


def test_no_event_is_published_for_a_refusal_of_any_step(pki: DocumentPki) -> None:
    from submissions_support import http_context, refused_by_kernel  # noqa: PLC0415 - one use

    def refuse_customizer(draft: Any) -> None:
        raise HookRefusedError.forbidden("a.b", "no")

    def errors(candidate: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem(None, "pdf.bad", "bad"),))

    form = pdf_definition(template_layout("t1"))
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, form=form) as rig:
        rig.throttle.deny = 3
        rig.render(context=http_context())  # throttled
        rig.throttle.deny = None
        rig.sandbox.verdict = refused_by_kernel()
        rig.render()  # the dry run refuses
        rig.sandbox.verdict = None
        rig.render(layout_id="nope")  # unknown layout
        rig.fill("nope")
        rig.verify(b"not a pdf")
        assert rig.kinds() == []
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, pdf_request_customizers=[refuse_customizer]) as rig:
        with pytest.raises(HookRefusedError):
            rig.render()
        assert rig.kinds() == []
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, pdf_result_validators=[errors]) as rig:
        rig.render()
        assert rig.kinds() == []
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        rig.runtime.fail("document", "internal", "boom")
        with pytest.raises(PdfKernelError):
            rig.render()
        assert rig.kinds() == []


def test_a_listener_that_raises_changes_no_answer_is_logged_and_the_next_listener_still_runs(
    caplog: pytest.LogCaptureFixture,
) -> None:
    seen: list[DatumEvent] = []

    def boom(event: PdfRenderedEvent) -> None:
        raise RuntimeError("a listener defect")

    with (
        started_pdf(
            {"pdf": {"seal": {"enabled": False}}},
            listeners=[listener(PdfRenderedEvent, boom), (DatumEvent, seen.append)],
        ) as rig,
        caplog.at_level(logging.ERROR, logger=EVENTS),
    ):
        outcome = rig.render()
    assert outcome.data
    assert any(isinstance(event, PdfRenderedEvent) for event in seen)
    assert any("a listener defect" in (r.exc_text or r.getMessage()) or r.exc_info for r in caplog.records)


def test_a_listener_that_raises_on_the_verified_event_changes_no_answer_and_the_next_listener_still_runs(
    pki: DocumentPki, caplog: pytest.LogCaptureFixture
) -> None:
    seen: list[DatumEvent] = []

    def boom(event: PdfVerifiedEvent) -> None:
        raise RuntimeError("a verify listener defect")

    with (
        started_pdf(
            pdf_trust_policy=PdfTrustPolicy(anchors=(pki.signer.root_der,)),
            listeners=[listener(PdfVerifiedEvent, boom), (DatumEvent, seen.append)],
        ) as rig,
        caplog.at_level(logging.ERROR, logger=EVENTS),
    ):
        outcome = rig.verify(fake_pdf("plain"))
    assert type(outcome).__name__ == "Verified"
    assert any(isinstance(event, PdfVerifiedEvent) for event in seen)
    assert any("a verify listener defect" in (r.exc_text or r.getMessage()) or r.exc_info for r in caplog.records)


def test_the_events_carry_no_bytes_digest_key_or_certificate(pki: DocumentPki) -> None:
    with started_pdf({"pdf": {"seal": {"enabled": True, "timestamp": False}}}, signer=pki.signer) as rig:
        out = rig.render_submission()
        text = " ".join(repr(event) + str(dataclasses.astuple(event)) for event in rig.events)
    assert b64(out.data) not in text
    assert out.data.decode("latin-1") not in text
    assert pki.signer.leaf_der.hex() not in text
    assert "PRIVATE" not in text


# -- the verified event ------------------------------------------------------------------------------------------------
def test_a_verify_publishes_one_event_with_the_files_hash_size_document_id_count_and_policy_name(
    pki: DocumentPki,
) -> None:
    data = fake_pdf("signed") + b"x" * 40
    with started_pdf(pdf_trust_policy=PdfTrustPolicy(anchors=(pki.signer.root_der,))) as rig:
        rig.runtime.on(
            "verify",
            lambda _r: verify_reply(
                signature_report(pki.signer, signed_document_id="11" * 16),
                signature_report(pki.email, field_name="Signature2"),
                document_id="22" * 16,
            ),
        )
        outcome = rig.verify(data)
        (event,) = rig.events
    import hashlib  # noqa: PLC0415 - one use

    assert isinstance(event, PdfVerifiedEvent)
    assert event.sha256 == hashlib.sha256(data).hexdigest() == outcome.report.sha256
    assert event.size == len(data)
    assert event.document_id == "11" * 16
    assert event.signatures == 2
    assert event.trust_policy == "default"


def test_a_file_with_no_signature_still_announces_the_check_with_zero(pki: DocumentPki) -> None:
    with started_pdf(pdf_trust_policy=PdfTrustPolicy(anchors=(pki.signer.root_der,))) as rig:
        rig.verify(fake_pdf("plain"))
        (event,) = rig.events
    assert isinstance(event, PdfVerifiedEvent)
    assert (event.signatures, event.document_id) == (0, None)


def test_no_verified_event_for_a_file_that_is_not_a_pdf_unreadable_too_large_throttled_or_unavailable(
    pki: DocumentPki,
) -> None:
    from submissions_support import http_context  # noqa: PLC0415 - one use

    config = {"runtime": {"verify_max_bytes": "1MiB"}}
    with started_pdf(config, pdf_trust_policy=PdfTrustPolicy(anchors=())) as rig:
        rig.verify(b"hello")
        rig.verify(b"%PDF-" + b"x" * (1024 * 1024))
        rig.runtime.fail("verify", "internal", "Error: Failed to parse PDF document")
        rig.verify(fake_pdf("x"))
        rig.runtime.answers.pop("verify")
        rig.throttle.deny = 5
        rig.verify(fake_pdf("x"), http_context())
        assert rig.kinds() == []


# -- spans and the histogram -------------------------------------------------------------------------------------------
def test_the_pdf_span_names_the_op_the_outcome_the_seal_the_timestamp_and_the_form_and_nothing_else(
    pki: DocumentPki, tsa_pki: TsaPki
) -> None:
    probe = telemetry()
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": True}}}, signer=pki.signer, tsa=tsa_pki.rsa
    ) as rig:
        probe.exporter.clear()
        rig.render()
        rig.render_submission()
    spans = probe.spans("datum.pdf")
    assert len(spans) == 2
    first, second = (dict(s.attributes or {}) for s in spans)
    assert first["datum.pdf.op"] == "render"
    assert first["datum.pdf.seal"] == "test"
    assert first["datum.form"] == FORM
    assert second["datum.pdf.op"] == "render_submission"
    assert second["datum.pdf.seal"] == "server"
    assert first["datum.pdf.timestamp"] == "none"  # the posted-answer test seal is never timestamped
    assert second["datum.pdf.timestamp"] == "custom"  # the rig seals with its own timestamper
    assert first["datum.outcome"] == second["datum.outcome"] == "printed"
    for attributes in (first, second):
        assert set(attributes) <= {
            "datum.pdf.op",
            "datum.outcome",
            "datum.pdf.seal",
            "datum.pdf.timestamp",
            "datum.form",
        }
    assert len(probe.spans("datum.pdf.run")) >= 2
    run_parent = probe.parent_of(probe.spans("datum.pdf.run")[0])
    assert run_parent is not None
    assert run_parent.name == "datum.pdf"


def test_an_unsealed_pdf_says_none_for_both(pki: DocumentPki) -> None:
    probe = telemetry()
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        probe.exporter.clear()
        rig.render()
    (span,) = probe.spans("datum.pdf")
    attributes = dict(span.attributes or {})
    assert (attributes["datum.pdf.seal"], attributes["datum.pdf.timestamp"]) == ("none", "none")
    assert attributes["datum.outcome"]


def test_a_custom_timestamper_is_named_custom(pki: DocumentPki, tsa_pki: TsaPki) -> None:
    from pdf_support import RecordingTimestamper  # noqa: PLC0415 - one use

    probe = telemetry()
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": True}}},
        signer=pki.signer,
        timestamper=RecordingTimestamper(tsa_pki.rsa),
    ) as rig:
        probe.exporter.clear()
        rig.render_submission()
    assert dict(probe.spans("datum.pdf")[0].attributes or {})["datum.pdf.timestamp"] == "custom"


def test_the_output_size_histogram_records_the_file_size_per_op_in_bytes_and_never_the_form() -> None:
    probe = telemetry()
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        before = probe.observations("datum.pdf.output.size", **{"datum.pdf.op": "render"})
        out = rig.render()
        after = probe.observations("datum.pdf.output.size", **{"datum.pdf.op": "render"})
    assert after == before + 1
    points = probe.points("datum.pdf.output.size")
    assert all(set(point.attributes) == {"datum.pdf.op"} for point in points)
    assert any(point.sum >= len(out.data) for point in points)


def test_the_spans_carry_no_bytes_digest_key_or_certificate(pki: DocumentPki, tmp_path: Any) -> None:
    probe = telemetry()
    anchors = anchors_file(tmp_path, pki.signer.root_der)
    with started_pdf(
        {"pdf": {"seal": {"enabled": True, "timestamp": False}, "signing": {"trust_anchors": [anchors]}}},
        signer=pki.signer,
    ) as rig:
        probe.exporter.clear()
        out = rig.render_submission()
        rig.runtime.on("verify", lambda _r: verify_reply(signature_report(pki.signer)))
        data = b"%PDF-1.7\nsigned" + b"x" * 32
        rig.verify(data)
    pdf_spans = [s for s in probe.spans() if s.name.startswith("datum.pdf")]
    text = " ".join(f"{s.name} {dict(s.attributes or {})}" for s in pdf_spans)
    (verify_span,) = [s for s in probe.spans("datum.pdf") if dict(s.attributes or {}).get("datum.pdf.op") == "verify"]
    assert set(dict(verify_span.attributes or {})) <= {"datum.pdf.op", "datum.outcome", "datum.form"}
    assert hashlib.sha256(data).hexdigest() not in text
    assert hashlib.sha256(out.data).hexdigest() not in text
    assert b64(data) not in text
    assert b64(out.data) not in text
    assert pki.signer.leaf_der.hex() not in text
    assert b64(pki.signer.leaf_der) not in text


# -- 7P-core: the span's error, the histogram, the start's proof ------------------------------------------------------
def test_a_service_that_could_not_run_marks_the_span_error_and_a_busy_one_does_not() -> None:
    from opentelemetry.trace import StatusCode  # noqa: PLC0415 - one use

    probe = telemetry()
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        probe.exporter.clear()
        rig.runtime.end("document", RunEnd.BUDGET)
        stopped = rig.render()
        rig.runtime.ends.clear()

        def busy(_request: dict[str, Any]) -> dict[str, Any]:
            raise EngineBusyError("slots")

        rig.runtime.on("document", busy)
        waited = rig.render()
    assert (stopped.code, waited.code) == ("wasm.execution_error", "server.busy")
    failed, queued = probe.spans("datum.pdf")
    assert failed.status.status_code == StatusCode.ERROR
    assert dict(failed.attributes or {})["error.type"]
    assert dict(failed.attributes or {})["datum.outcome"] == "unavailable"
    assert queued.status.status_code != StatusCode.ERROR
    assert "error.type" not in dict(queued.attributes or {})
    assert dict(queued.attributes or {})["datum.outcome"] == "unavailable"


def test_a_full_stray_bound_is_server_unavailable_in_its_own_words_and_an_error_span() -> None:
    from opentelemetry.trace import StatusCode  # noqa: PLC0415 - one use

    probe = telemetry()
    with started_pdf({"pdf": {"seal": {"enabled": False}}}) as rig:
        probe.exporter.clear()

        def full(_request: dict[str, Any]) -> dict[str, Any]:
            raise EngineStrayBoundError(2, 2)

        rig.runtime.on("document", full)
        refused = rig.render()
    assert refused.code == "server.unavailable"
    assert refused.reason == "PDFs cannot be made now: runs that would not stop have not ended."
    (span,) = probe.spans("datum.pdf")
    assert span.status.status_code == StatusCode.ERROR
    assert dict(span.attributes or {})["error.type"] == "StrayBoundError"


def test_the_output_size_histogram_records_a_printed_pdf_only() -> None:
    from submissions_support import http_context  # noqa: PLC0415 - one use

    probe = telemetry()
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, pdf_trust_policy=PdfTrustPolicy(anchors=())) as rig:
        count = {
            op: probe.observations("datum.pdf.output.size", **{"datum.pdf.op": op})
            for op in ("render", "verify", "fill")
        }
        rig.verify(fake_pdf("plain"))  # a verified file: a report, no PDF made
        rig.render(layout_id="nope")  # a refused render
        rig.fill("nope")
        rig.throttle.deny = 3
        rig.render(context=http_context())  # throttled
        rig.throttle.deny = None
        for op in ("render", "verify", "fill"):
            assert probe.observations("datum.pdf.output.size", **{"datum.pdf.op": op}) == count[op]
        rig.render()
        assert probe.observations("datum.pdf.output.size", **{"datum.pdf.op": "render"}) == count["render"] + 1


def test_a_start_opens_no_pdf_run_span_because_its_proof_is_not_a_request() -> None:
    probe = telemetry()
    with started_pdf() as rig:
        assert probe.spans("datum.pdf.run") == []
        assert probe.spans("datum.pdf") == []
        rig.render()
        assert probe.spans("datum.pdf.run") != []
