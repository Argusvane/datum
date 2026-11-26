"""`SubmissionMode.PDF` and `SubmissionService.pdf_check`.

The PDF routes judge posted answers with the receiver's own pipeline in a mode of their own: the order of `submit` with
no throttle step (the PDF service has its own `pdf` throttle, and "throttle (not the PDF dry run)" says the dry run is
never counted), no idempotency, no handler, no event of any kind and no `record_use`; pre-checks (which see the mode
`pdf`), contributors, customizers, the option snapshot, rules, the sandbox and the validators all run. It answers the
checked values for the print (`PdfChecked`) or the same refusals as `submit` (`Rejected` with the errors, `Refused`,
`NotFound`, `Outdated`, `Malformed`, `TooLarge`, `Unavailable`). A signed wrapper is `signing.not_set_up`, the PDF mode
included, while signed submissions are not set up.
"""

from typing import Any

import pytest
from submissions_support import (
    NAME,
    Repository,
    bus,
    definition,
    envelope,
    http_context,
    refused_by_kernel,
    started,
    wrapped,
)

from datum_core.hooks import HookFindings, HookProblem
from datum_core.submissions import (
    FormRef,
    Malformed,
    NotFound,
    Outdated,
    PdfChecked,
    PreCheckDecision,
    Refused,
    Reject,
    Rejected,
    SubmissionMode,
    Throttled,
    TooLarge,
    Unavailable,
)

SIGNING = {"scope": "envelope", "placement": "wrapper", "digest": "sha-256", "canonicalization": "jcs"}
PDF_PATH = ["pre_check", "definition", "contributor", "customizer", "option_snapshot", "rules", "sandbox", "validator"]
"""`FULL_PATH` without the throttle, the idempotency store, the handler and the event: the dry run's own steps."""


def check(rig: Any, document: Any = None, context: Any = None) -> Any:
    return rig.service.pdf_check(
        FormRef.from_document(), document if document is not None else envelope(), context or bus()
    )


def test_the_mode_exists_and_is_the_word_pdf() -> None:
    assert SubmissionMode.PDF.value == "pdf"
    assert {mode.value for mode in SubmissionMode} == {"submit", "validate", "test", "pdf"}


def test_a_good_document_answers_the_checked_values_the_digest_and_the_definition_for_the_print() -> None:
    with started() as rig:
        outcome = check(rig)
        stored = rig.repository.forms["contact"]
    assert isinstance(outcome, PdfChecked)
    assert outcome.values == {"name": NAME}
    assert outcome.form_key == "contact"
    assert outcome.version == "1"
    assert outcome.locale == "en"
    assert len(outcome.digest) == 64
    assert outcome.definition == stored


def test_the_digest_is_the_submissions_canonical_digest() -> None:
    with started() as rig:
        dry = check(rig)
        rig.service.submit(FormRef.from_document(), envelope(), bus())
        accepted = rig.handler.calls[0]
    assert dry.digest == accepted.digest


def test_the_dry_run_takes_every_step_of_the_receiver_except_the_throttle_idempotency_handler_and_events() -> None:
    with started(full=True) as rig:
        outcome = check(rig, context=http_context())
        assert isinstance(outcome, PdfChecked)
        assert rig.trail == PDF_PATH
        assert rig.events == []
        assert rig.handler.calls == []
        assert rig.idempotency.finds == []
        assert rig.idempotency.records == []


def test_the_dry_run_is_not_counted() -> None:
    """The text of the placeholder in `test_throttle_service.py`: the PDF dry run asks the throttle nothing."""
    with started() as rig:
        rig.throttle.deny = 4
        outcome = check(rig, context=http_context())
        assert isinstance(outcome, PdfChecked), "a throttle that would deny is never asked"
        assert rig.throttle.keys == []
        assert "throttle" not in rig.trail


def test_a_pre_check_sees_the_pdf_mode_and_may_refuse() -> None:
    modes: list[SubmissionMode] = []

    def pre_check(incoming: Any) -> PreCheckDecision:
        modes.append(incoming.mode)
        return Reject("pdf.closed", "closed")

    with started(pre_checks=[pre_check]) as rig:
        outcome = check(rig)
    assert modes == [SubmissionMode.PDF]
    assert isinstance(outcome, Refused)
    assert outcome.decision.code == "pdf.closed"


def test_the_sandbox_is_not_asked_as_a_real_delivery_so_no_log_is_relayed() -> None:
    with started() as rig:
        check(rig)
        ((_context, _rules, real),) = rig.sandbox.validations
    assert real is False, "a dry run relays no run log (validate and test do not either)"


def test_a_sandbox_refusal_is_rejected_with_the_errors_and_publishes_no_event() -> None:
    with started() as rig:
        rig.sandbox.verdict = refused_by_kernel("required", "name")
        outcome = check(rig)
        assert isinstance(outcome, Rejected)
        assert [code for _field, code, _words in outcome.errors] == ["required"]
        assert outcome.stage == "sandbox"
        assert rig.events == [], "unlike a submission, a refused print is not announced"


def test_the_validators_run_in_pdf_mode_and_an_error_finding_refuses() -> None:
    def validator(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem("name", "name.taken", "taken"),))

    with started(validators=[validator]) as rig:
        outcome = check(rig)
        assert isinstance(outcome, Rejected)
        assert outcome.stage == "server"
        assert [code for _field, code, _words in outcome.errors] == ["name.taken"]
        assert rig.events == []
        assert rig.handler.calls == []


def test_a_warning_finding_does_not_refuse() -> None:
    def validator(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(warnings=(HookProblem(None, "soft", "soft"),))

    with started(validators=[validator]) as rig:
        outcome = check(rig)
        assert isinstance(outcome, PdfChecked)
        assert outcome.warnings == (HookProblem(None, "soft", "soft"),)


@pytest.mark.parametrize(
    ("document", "expected"),
    [
        ("not an object", Malformed),
        (
            {"versionContext": {"form": {"id": "nope", "version": "1"}}, "submission": {"locale": "en", "values": {}}},
            NotFound,
        ),
        (envelope(version="2"), Outdated),
        ({**envelope(), "scope": "page", "pageId": "p1"}, Malformed),
    ],
)
def test_the_other_refusals_are_the_submissions_own(document: Any, expected: type) -> None:
    with started() as rig:
        assert isinstance(check(rig, document), expected)
        assert rig.sandbox.validations == []
        assert rig.events == []


def test_a_document_over_the_cap_is_too_large_before_anything_else() -> None:
    with started({"web": {"api": {"max_body_size": "1KiB"}}}) as rig:
        outcome = check(rig, envelope(values={"name": "x" * 5000}))
        assert isinstance(outcome, TooLarge)
        assert rig.trail == []


def test_a_sandbox_that_cannot_judge_is_unavailable_and_nothing_is_printed() -> None:
    with started() as rig:
        from datum_sandbox.protocol import SandboxError, SandboxFailure  # noqa: PLC0415 - one use

        rig.sandbox.error = SandboxError(SandboxFailure.BUSY, "busy")
        outcome = check(rig)
        assert isinstance(outcome, Unavailable)
        assert outcome.code == "server.busy"


def test_a_signed_wrapper_is_signing_not_set_up_and_costs_nothing() -> None:
    with started() as rig:
        outcome = check(rig, wrapped({"format": SIGNING, "payload": envelope(), "signatures": []}))
        assert isinstance(outcome, Unavailable)
        assert outcome.code == "signing.not_set_up"
        assert rig.trail == []
        assert rig.events == []


def test_a_journey_form_is_judged_whole_not_by_page() -> None:
    form = definition()
    form["journey"] = {
        "journeys": [{"id": "main", "pages": [{"id": "p1", "components": ["name"], "routes": [{"to": "$end"}]}]}]
    }
    trail: list[str] = []
    with started(form_repository=Repository(trail, form)) as rig:
        outcome = check(rig)
    assert isinstance(outcome, PdfChecked)
    assert outcome.definition["journey"] == form["journey"]


def test_the_other_calls_are_unchanged_by_the_new_mode() -> None:
    with started() as rig:
        rig.throttle.deny = 5
        assert isinstance(rig.service.submit(FormRef.from_document(), envelope(), http_context()), Throttled)
        kind = rig.throttle.keys[-1].kind
        assert kind is not None
        assert kind.value == "submit"
