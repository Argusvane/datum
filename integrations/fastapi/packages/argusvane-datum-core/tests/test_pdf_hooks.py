"""The PDF hooks and the service's order.

`pdf_request_customizers` change a `PdfRequestDraft` in place (env, options, host context, attachments, fonts) before
the program is asked and never the ABI, the operation or the program; `pdf_result_validators` see the produced bytes
before any seal and answer findings (errors refuse with 422 and the first error's code, warnings ride along) or raise
`HookRefusedError` (which reaches the caller as raised, as every hook refusal does); `pdf_middleware` wraps the
`PdfKernel`, first entry outermost, and delegates. The order is held one step at a time: throttle (`pdf`) > PDFs
available > the receiver's dry run in PDF mode (`pdf_check`) > customizers > kernel > validators > seal > event.
"""

import dataclasses
import logging
from collections.abc import Callable, Mapping
from typing import Any, cast

import pytest
from pdf_support import (
    FORM,
    NAME,
    PdfRig,
    bus,
    envelope,
    generated_layout,
    pdf_definition,
    started_pdf,
    template_layout,
)
from submissions_support import ThreadLoopAwaiter, http_context, refused_by_kernel

from datum_core.config.models import ThrottleKind
from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.loggers import ROOT
from datum_core.pdf.outcomes import LayoutNotFound, LayoutNotTemplate, Printed, ResultRejected
from datum_core.pdf.protocols import PdfRequestDraft, PdfResultCandidate
from datum_core.submissions import Malformed, NotFound, Outdated, Refused, Rejected, Throttled, TooLarge, Unavailable
from datum_core.testing.tsa_pki import build_document_pki
from datum_sandbox.protocol import PDF_ABI_MIN, PdfKernel


def kernel_request(rig: PdfRig) -> dict[str, Any]:
    """The request that asked the program for the document (a `document` or a `fill`)."""
    found = [call.request for call in rig.runtime.calls if call.op in {"document", "fill"}]
    assert found, rig.runtime.ops()
    return found[0]


def printed(outcome: Any) -> Printed:
    assert isinstance(outcome, Printed), outcome
    return outcome


NO_SEAL = {"pdf": {"seal": {"enabled": False}}}


# -- the request the program is asked ---------------------------------------------------------------------------------
def test_the_program_is_asked_for_the_form_the_answers_and_the_locale_with_the_current_abi() -> None:
    form = pdf_definition(template_layout("t1"))
    with started_pdf(NO_SEAL, form=form) as rig:
        printed(rig.render())
        request = kernel_request(rig)
    assert request["abi"] == PDF_ABI_MIN
    assert request["form"] == form["root"]
    assert request["values"] == {"name": NAME}
    assert request["locale"] == "en"
    assert request["pdf"] == form["pdf"]
    assert request["env"]["documentId"]
    assert request["env"]["createdAt"]
    assert "layoutId" not in request


def test_a_named_layout_is_sent_as_layout_id() -> None:
    form = pdf_definition(template_layout("t1"), template_layout("t2"))
    with started_pdf(NO_SEAL, form=form) as rig:
        out = printed(rig.render(layout_id="t2"))
        assert kernel_request(rig)["layoutId"] == "t2"
    assert out.layout_id in {"t2", "default"}


def test_a_form_without_a_pdf_block_sends_none_and_the_program_derives_a_layout() -> None:
    with started_pdf(NO_SEAL) as rig:
        printed(rig.render())
        assert "pdf" not in kernel_request(rig) or kernel_request(rig)["pdf"] in ({}, None)


@pytest.mark.parametrize(("fonts", "faces"), [("default", 2), ("standard", 5), ("all", 7)])
def test_the_font_set_setting_decides_how_many_faces_the_request_carries(fonts: str, faces: int) -> None:
    with started_pdf({"pdf": {"fonts": fonts, "seal": {"enabled": False}}}) as rig:
        printed(rig.render())
        sent = kernel_request(rig)["fonts"]
    assert len(sent) == faces
    assert {item["id"] for item in sent} >= {"dejavu-sans", "dejavu-sans-bold"}
    assert all(item["data"] for item in sent)


# -- customizers ------------------------------------------------------------------------------------------------------
def test_a_customizer_changes_the_env_the_options_the_host_context_and_the_fonts_in_place() -> None:
    def customize(draft: PdfRequestDraft) -> None:
        draft.env["producer"] = "My Org"
        draft.options["compact"] = True
        draft.host_context["tenant"] = "acme"
        draft.fonts.clear()
        draft.attachments.append({"name": "terms.txt", "type": "text/plain", "data": "dGVybXM="})

    with started_pdf(NO_SEAL, pdf_request_customizers=[customize]) as rig:
        printed(rig.render())
        request = kernel_request(rig)
    assert request["env"]["producer"] == "My Org"
    assert request["options"]["compact"] is True
    assert request["hostContext"]["tenant"] == "acme"
    assert request["fonts"] == []
    assert request["attachments"] == [{"name": "terms.txt", "type": "text/plain", "data": "dGVybXM="}]


def test_customizers_run_in_list_order_and_each_sees_what_the_one_before_left() -> None:
    seen: list[Any] = []

    def first(draft: PdfRequestDraft) -> None:
        draft.host_context["steps"] = ["first"]

    def second(draft: PdfRequestDraft) -> None:
        steps = cast("list[Any]", draft.host_context["steps"])
        seen.append(list(steps))
        draft.host_context["steps"] = [*steps, "second"]

    with started_pdf(NO_SEAL, pdf_request_customizers=[first, second]) as rig:
        printed(rig.render())
        assert kernel_request(rig)["hostContext"]["steps"] == ["first", "second"]
    assert seen == [["first"]]


def test_the_draft_names_the_operation_the_form_the_layout_and_the_principal_for_each_operation() -> None:
    drafts: list[PdfRequestDraft] = []
    form = pdf_definition(template_layout("t1"))
    with started_pdf({"pdf": {"seal": {"enabled": False}}}, form=form, pdf_request_customizers=[drafts.append]) as rig:
        rig.render(context=bus(principal="ada"))
        rig.fill("t1")
        rig.render_submission()
    assert [(d.op, d.form_key, d.layout_id) for d in drafts] == [
        ("render", FORM, None),
        ("fill", FORM, "t1"),
        ("render_submission", FORM, None),
    ]
    assert drafts[0].principal == "ada"


def test_a_customizer_cannot_change_the_operation_the_abi_or_the_program() -> None:
    def tamper(draft: PdfRequestDraft) -> None:
        for name in ("op", "abi", "program", "form_key"):
            with pytest.raises((AttributeError, TypeError)):
                setattr(draft, name, "x")
        draft.env["abi"] = "9.9.9"
        draft.options["op"] = "verify"
        draft.host_context["program"] = "evil"

    with started_pdf(NO_SEAL, pdf_request_customizers=[tamper]) as rig:
        printed(rig.render())
        request = kernel_request(rig)
    assert request["abi"] == PDF_ABI_MIN
    assert request["op"] == "document"
    assert set(rig.runtime.ops()) <= {"document", "complete", "sign"}


def test_the_draft_has_no_abi_operation_or_program_member_to_change() -> None:
    names = {field.name for field in dataclasses.fields(PdfRequestDraft)}
    assert not names & {"abi", "program", "kernel", "request"}
    assert "op" in names


def test_a_customizers_refusal_reaches_the_caller_as_raised_and_the_program_is_never_asked() -> None:
    ran: list[str] = []

    def refuse(draft: PdfRequestDraft) -> None:
        raise HookRefusedError.forbidden("pdf.not_today", "not today")

    def later(draft: PdfRequestDraft) -> None:
        ran.append("later")

    with started_pdf(NO_SEAL, pdf_request_customizers=[refuse, later]) as rig:
        with pytest.raises(HookRefusedError) as raised:
            rig.render()
        assert raised.value.kind.value == "forbidden"
        assert rig.runtime.ops() == []
        assert rig.kinds() == []
    assert ran == [], "the first refusal stops the rest"


@pytest.mark.parametrize("kind", ["forbidden", "conflict", "invalid"])
def test_every_refusal_kind_passes_through(kind: str) -> None:
    def refuse(draft: PdfRequestDraft) -> None:
        raise getattr(HookRefusedError, kind)("x.y", "words")

    with started_pdf(NO_SEAL, pdf_request_customizers=[refuse]) as rig, pytest.raises(HookRefusedError) as raised:
        rig.render()
    assert raised.value.kind.value == kind


def test_a_customizer_that_raises_anything_else_fails_the_request_and_nothing_is_issued() -> None:
    def broken(draft: PdfRequestDraft) -> None:
        raise ZeroDivisionError

    with started_pdf(NO_SEAL, pdf_request_customizers=[broken]) as rig:
        with pytest.raises(ZeroDivisionError):
            rig.render()
        assert rig.runtime.ops() == []
        assert rig.kinds() == []


def test_async_hooks_are_resolved_through_the_awaiter() -> None:
    async def customize(draft: PdfRequestDraft) -> None:
        draft.host_context["async"] = True

    async def validate(candidate: PdfResultCandidate) -> HookFindings | None:
        return HookFindings(warnings=(HookProblem(None, "async.seen", "seen"),))

    awaiter = ThreadLoopAwaiter()
    try:
        with started_pdf(
            NO_SEAL, awaiter=awaiter, pdf_request_customizers=[customize], pdf_result_validators=[validate]
        ) as rig:
            out = printed(rig.render())
            assert kernel_request(rig)["hostContext"]["async"] is True
        assert [warning.code for warning in out.warnings] == ["async.seen"]
    finally:
        awaiter.close()


# -- validators -------------------------------------------------------------------------------------------------------
def test_a_validator_is_told_the_produced_file_the_form_the_layout_and_who_asked() -> None:
    seen: list[PdfResultCandidate] = []
    with started_pdf(NO_SEAL, pdf_result_validators=[seen.append]) as rig:
        out = printed(rig.render(context=bus(principal="ada")))
    (candidate,) = seen
    assert candidate.pdf == out.data
    assert (candidate.op, candidate.form_key, candidate.principal, candidate.page_count) == ("render", FORM, "ada", 1)
    assert candidate.size == len(out.data)


def test_every_validator_runs_and_warnings_ride_along_in_order() -> None:
    def one(candidate: PdfResultCandidate) -> HookFindings:
        return HookFindings(warnings=(HookProblem(None, "one", "first"),))

    def two(candidate: PdfResultCandidate) -> HookFindings:
        return HookFindings(warnings=(HookProblem(None, "two", "second"),))

    def nothing(candidate: PdfResultCandidate) -> None:
        return None

    with started_pdf(NO_SEAL, pdf_result_validators=[one, nothing, two]) as rig:
        out = printed(rig.render())
    assert [warning.code for warning in out.warnings] == ["one", "two"]


def test_errors_refuse_with_the_first_errors_code_and_every_error_in_order_and_publish_nothing() -> None:
    def one(candidate: PdfResultCandidate) -> HookFindings:
        return HookFindings(errors=(HookProblem("f", "pdf.too_long", "long"), HookProblem(None, "pdf.other", "other")))

    def two(candidate: PdfResultCandidate) -> HookFindings:
        return HookFindings(errors=(HookProblem(None, "pdf.third", "third"),))

    with started_pdf(NO_SEAL, pdf_result_validators=[one, two]) as rig:
        outcome = rig.render()
        assert isinstance(outcome, ResultRejected)
        assert [error.code for error in outcome.errors] == ["pdf.too_long", "pdf.other", "pdf.third"]
        assert rig.kinds() == []


def test_a_validator_that_raises_a_refusal_stops_the_rest_and_reaches_the_caller() -> None:
    ran: list[str] = []

    def refuse(candidate: PdfResultCandidate) -> None:
        raise HookRefusedError.conflict("pdf.clash", "clash")

    def later(candidate: PdfResultCandidate) -> None:
        ran.append("later")

    with started_pdf(NO_SEAL, pdf_result_validators=[refuse, later]) as rig:
        with pytest.raises(HookRefusedError):
            rig.render()
        assert rig.kinds() == []
    assert ran == []


def test_a_validator_that_raises_anything_else_fails_the_request_and_publishes_nothing() -> None:
    def broken(candidate: PdfResultCandidate) -> None:
        raise ZeroDivisionError

    with started_pdf(NO_SEAL, pdf_result_validators=[broken]) as rig:
        with pytest.raises(ZeroDivisionError):
            rig.render()
        assert rig.kinds() == []


def test_the_validators_run_on_every_operation_that_answers_pdf_bytes() -> None:
    ops: list[str] = []
    form = pdf_definition(template_layout("t1"))
    config = {"pdf": {"seal": {"enabled": True, "timestamp": False}}}
    pki = build_document_pki()
    with started_pdf(config, form=form, signer=pki.signer, pdf_result_validators=[lambda c: ops.append(c.op)]) as rig:
        rig.render()
        rig.fill("t1")
        rig.sign()
        rig.render_submission()
    assert ops == ["render", "fill", "sign", "render_submission"]


# -- middleware -------------------------------------------------------------------------------------------------------
class Recording:
    """A kernel middleware that delegates every call and notes it (the contract: delegate, observe, never answer)."""

    def __init__(self, name: str, inner: PdfKernel, log: list[str]) -> None:
        self._name = name
        self._inner = inner
        self._log = log

    @property
    def program(self) -> Any:
        return self._inner.program

    def capabilities(self) -> Any:
        return self._inner.capabilities()

    def document(self, request: Mapping[str, Any]) -> Any:
        self._log.append(f"{self._name}.document")
        return self._inner.document(request)

    def fill(self, request: Mapping[str, Any]) -> Any:
        self._log.append(f"{self._name}.fill")
        return self._inner.fill(request)

    def sign(self, request: Mapping[str, Any]) -> Any:
        self._log.append(f"{self._name}.sign")
        return self._inner.sign(request)

    def complete(self, request: Mapping[str, Any]) -> Any:
        self._log.append(f"{self._name}.complete")
        return self._inner.complete(request)

    def verify(self, request: Mapping[str, Any]) -> Any:
        self._log.append(f"{self._name}.verify")
        return self._inner.verify(request)

    def inspect(self, request: Mapping[str, Any]) -> Any:
        self._log.append(f"{self._name}.inspect")
        return self._inner.inspect(request)


def test_the_first_middleware_is_outermost_and_every_kernel_call_goes_through_both() -> None:
    log: list[str] = []
    middleware = [lambda inner: Recording("outer", inner, log), lambda inner: Recording("inner", inner, log)]
    with started_pdf(NO_SEAL, pdf_middleware=middleware) as rig:
        printed(rig.render())
        rig.verify(b"%PDF-1.7\n")
    assert log == ["outer.document", "inner.document", "outer.verify", "inner.verify"]


def test_a_middleware_that_answers_none_is_refused_at_start() -> None:
    with pytest.raises(TypeError, match="PdfKernel"), started_pdf(NO_SEAL, pdf_middleware=[lambda _inner: None]):
        pass


# -- the order, one step at a time ---------------------------------------------------------------------------------
def test_step_one_the_throttle_comes_first_and_a_denial_asks_nothing_else() -> None:
    with started_pdf(NO_SEAL) as rig:
        rig.throttle.deny = 9
        outcome = rig.render(context=http_context())
        assert isinstance(outcome, Throttled)
        assert outcome.retry_after == 9
        assert outcome.key.kind is ThrottleKind.PDF
        assert rig.trail == ["throttle"]
        assert rig.runtime.ops() == []


def test_step_two_pdfs_must_be_available_and_that_is_judged_after_the_throttle_and_before_the_dry_run() -> None:
    config = {"pdf": {"seal": {"enabled": False}}, "runtime": {"fail_fast": False}}
    with started_pdf(config, abi="3.17.0") as rig:
        outcome = rig.render(context=http_context())
        assert isinstance(outcome, Unavailable)
        assert outcome.code == "server.unavailable"
        assert rig.trail == ["throttle"], "the throttle was asked, then nothing: no pre-check, no definition, no run"
        rig.trail.clear()
        rig.throttle.deny = 3
        assert isinstance(rig.render(context=http_context()), Throttled), "a denial outranks the missing program"


def test_step_three_the_dry_run_in_pdf_mode_refuses_before_any_hook_or_program() -> None:
    hooks: list[str] = []

    def customize(draft: PdfRequestDraft) -> None:
        hooks.append("customizer")

    with started_pdf(NO_SEAL, pdf_request_customizers=[customize]) as rig:
        rig.sandbox.verdict = refused_by_kernel("required", "name")
        outcome = rig.render()
        assert isinstance(outcome, Rejected)
        assert outcome.errors[0][1] == "required"
        assert rig.runtime.ops() == []
        assert rig.kinds() == []
    assert hooks == []


@pytest.mark.parametrize(
    ("document", "expected"),
    [
        ("not an object", Malformed),
        (
            {"versionContext": {"form": {"id": "nope", "version": "1"}}, "submission": {"locale": "en", "values": {}}},
            NotFound,
        ),
        (envelope(version="2"), Outdated),
    ],
)
def test_the_dry_ins_other_refusals_pass_through_and_cost_no_run(document: Any, expected: type) -> None:
    with started_pdf(NO_SEAL) as rig:
        assert isinstance(rig.render(document), expected)
        assert rig.runtime.ops() == []


def test_a_pre_check_refusal_passes_through_and_the_dry_run_counts_no_throttle_of_its_own() -> None:
    from datum_core.submissions import IncomingSubmission, PreCheckDecision, Reject  # noqa: PLC0415

    def deny(incoming: IncomingSubmission) -> PreCheckDecision:
        assert incoming.mode.value == "pdf"
        return Reject("pdf.closed", "closed")

    with started_pdf(NO_SEAL, pre_checks=[deny]) as rig:
        outcome = rig.render(context=http_context())
        assert isinstance(outcome, Refused)
        assert rig.trail.count("throttle") == 1, "one throttle check for the call, none for the dry run inside it"
        assert rig.runtime.ops() == []


def test_a_document_over_the_body_cap_is_too_large_and_cost_nothing() -> None:
    huge = envelope(values={"name": "x" * 3_000_000})
    with started_pdf({"web": {"api": {"max_body_size": "1KiB"}}, **NO_SEAL}) as rig:
        assert isinstance(rig.render(huge), TooLarge)
        assert rig.runtime.ops() == []


def test_step_four_customizers_run_after_the_dry_run_and_before_the_program() -> None:
    trail: list[str] = []

    def customize(draft: PdfRequestDraft) -> None:
        trail.append("pdf.customizer")

    with started_pdf(NO_SEAL, trail=trail, pdf_request_customizers=[customize]) as rig:
        printed(rig.render())
        assert rig.position("sandbox") < rig.position("pdf.customizer") < rig.position("pdf.document")


def test_step_five_a_program_refusal_runs_no_validator() -> None:
    called: list[str] = []
    with started_pdf(NO_SEAL, pdf_result_validators=[lambda c: called.append("validator")]) as rig:
        rig.runtime.fail("document", "internal", "boom")
        with pytest.raises(Exception, match=r"internal|boom"):
            rig.render()
    assert called == []
    assert rig.kinds() == []


def test_the_whole_success_path_in_one_trail() -> None:
    trail: list[str] = []
    form = pdf_definition(template_layout("t1"))
    with started_pdf(
        NO_SEAL,
        trail=trail,
        form=form,
        pdf_request_customizers=[lambda d: trail.append("pdf.customizer")],
        pdf_result_validators=[lambda c: trail.append("pdf.validator")],
    ) as rig:
        printed(rig.render(context=http_context()))
        assert rig.trail == [
            "throttle",
            "definition",
            "sandbox",
            "pdf.customizer",
            "pdf.document",
            "pdf.validator",
            "event:PdfRenderedEvent",
        ]


# -- layouts ---------------------------------------------------------------------------------------------------------
def test_an_unknown_layout_id_is_layout_not_found_and_the_program_is_not_asked() -> None:
    form = pdf_definition(template_layout("t1"))
    with started_pdf(NO_SEAL, form=form) as rig:
        calls: list[Callable[[], Any]] = [
            lambda: rig.render(layout_id="nope"),
            lambda: rig.fill("nope"),
            lambda: rig.sign(layout_id="nope"),
        ]
        for call in calls:
            outcome = call()
            assert isinstance(outcome, LayoutNotFound)
            assert outcome.layout_id == "nope"
        assert rig.runtime.ops() == []
        assert rig.kinds() == []


def test_fill_of_a_generated_layout_is_layout_not_template() -> None:
    form = pdf_definition(generated_layout("g1"), template_layout("t1"))
    with started_pdf(NO_SEAL, form=form) as rig:
        assert isinstance(rig.fill("g1"), LayoutNotTemplate)
        assert isinstance(rig.fill("t1"), Printed)
    assert rig.kinds() == ["PdfRenderedEvent"]


def test_a_template_that_is_not_inline_is_layout_not_found_with_the_reason_logged_and_no_bytes(
    caplog: pytest.LogCaptureFixture,
) -> None:
    form = pdf_definition(template_layout("remote", storage="s3"))
    with started_pdf(NO_SEAL, form=form) as rig, caplog.at_level(logging.DEBUG, logger=ROOT):
        outcome = rig.fill("remote")
        assert isinstance(outcome, LayoutNotFound)
        assert rig.runtime.ops() == []
    text = "\n".join(record.getMessage() for record in caplog.records)
    assert "s3" in text or "inline" in text.lower()
    assert "templates/t.pdf" not in str(outcome)
