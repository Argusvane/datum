"""One test per `SubmissionOutcome` variant, through `SubmissionService` (no HTTP).

Each variant is produced by its own cause: a delivery that is accepted, delivered again,
refused by the kernel, checked, dry-run, stale, unknown, malformed, over the cap, refused by a pre-check, throttled,
or answered while a seam is down. The outcomes are frozen, slotted records with no header and no status.
"""

import dataclasses
import typing
from collections.abc import Iterator
from typing import Any

import pytest
from submissions_support import (
    FORM,
    VERSION,
    Rig,
    bus,
    envelope,
    http_context,
    journey_check,
    refused_by_kernel,
    started,
    wrapped,
)

from datum_core.canonical import canonical_digest
from datum_core.config.models import ThrottleKind
from datum_core.hooks import HookFindings, HookProblem
from datum_core.submissions import (
    Accepted,
    AcceptedSubmission,
    Checked,
    DryRun,
    FormRef,
    KeyConflict,
    Malformed,
    NotFound,
    Outdated,
    Redelivered,
    Refused,
    Reject,
    Rejected,
    SubmissionOutcome,
    SubmissionReceipt,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_sandbox.protocol import ProgramUnavailableError, json_depth
from datum_sandbox.wasi import EngineBusyError

VARIANTS = (
    Accepted,
    Redelivered,
    KeyConflict,
    Rejected,
    Checked,
    DryRun,
    Outdated,
    NotFound,
    Malformed,
    TooLarge,
    Refused,
    Throttled,
    Unavailable,
)


@pytest.fixture
def rig() -> Iterator[Rig]:
    with started() as running:
        yield running


def test_the_outcome_union_is_exactly_the_thirteen_variants() -> None:
    assert set(typing.get_args(SubmissionOutcome.__value__)) == set(VARIANTS)


@pytest.mark.parametrize("variant", VARIANTS, ids=[v.__name__ for v in VARIANTS])
def test_every_variant_is_a_frozen_slotted_record_with_no_header_and_no_status(variant: type) -> None:
    assert dataclasses.is_dataclass(variant)
    assert variant.__dataclass_params__.frozen  # type: ignore[attr-defined]
    assert hasattr(variant, "__slots__")
    names = {field.name for field in dataclasses.fields(variant)}
    assert not {"status", "status_code", "headers", "header", "response"} & names


def test_accepted_carries_the_handlers_receipt_the_submission_and_no_warnings(rig: Rig) -> None:
    document = envelope()
    outcome = rig.submit(document, bus())
    assert isinstance(outcome, Accepted)
    assert outcome.receipt == SubmissionReceipt(id="id-1", reference="REF-1")
    assert outcome.warnings == ()
    assert isinstance(outcome.submission, AcceptedSubmission)
    assert outcome.submission.digest == canonical_digest(document)
    assert outcome.submission.form_key == FORM
    assert len(rig.handler.calls) == 1


def test_accepted_carries_a_validators_warnings() -> None:
    warning = HookProblem("name", "name.short", "That is a short name")

    def advise(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(warnings=(warning,))

    with started(validators=[advise]) as running:
        outcome = running.submit()
    assert isinstance(outcome, Accepted)
    assert warning in outcome.warnings
    assert warning in outcome.submission.warnings


def test_redelivered_answers_the_first_receipt_and_never_calls_the_handler_again(rig: Rig) -> None:
    first = rig.submit(envelope(), bus(submission_key="attempt-1"))
    again = rig.submit(envelope(), bus(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert again.receipt == first.receipt
    assert again.digest == first.submission.digest
    assert len(rig.handler.calls) == 1


def test_rejected_carries_the_kernels_errors_and_the_stage_that_refused(rig: Rig) -> None:
    rig.sandbox.verdict = refused_by_kernel("required", "name")
    outcome = rig.submit(envelope(values={"name": ""}))
    assert isinstance(outcome, Rejected)
    assert {(field, code) for field, code, _ in outcome.errors} == {("name", "required")}
    assert outcome.stage == "sandbox"
    assert rig.handler.calls == []
    assert rig.idempotency.records == []


def test_a_validators_error_is_rejected_at_the_server_stage() -> None:
    def refuse(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(errors=(HookProblem("name", "name.taken", "Taken"),))

    with started(validators=[refuse]) as running:
        outcome = running.submit()
    assert isinstance(outcome, Rejected)
    assert outcome.stage == "server"
    assert {(field, code) for field, code, _ in outcome.errors} == {("name", "name.taken")}
    assert running.handler.calls == []


def test_checked_is_the_validate_verdict_and_stores_nothing(rig: Rig) -> None:
    outcome = rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
    assert isinstance(outcome, Checked)
    assert outcome.accepted is True
    assert outcome.errors == ()
    assert rig.handler.calls == []
    assert rig.idempotency.records == []
    assert [type(event).__name__ for event in rig.events] == ["JourneyCheckedEvent"]


def test_checked_for_a_refused_document_is_accepted_false_with_the_errors(rig: Rig) -> None:
    rig.sandbox.verdict = refused_by_kernel("required", "name")
    outcome = rig.service.validate(FormRef.from_document(), journey_check(envelope(values={"name": ""})), bus())
    assert isinstance(outcome, Checked)
    assert outcome.accepted is False
    assert {(field, code) for field, code, _ in outcome.errors} == {("name", "required")}


def test_dry_run_reports_every_check_without_the_handler_or_a_receipt(rig: Rig) -> None:
    outcome = rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
    assert isinstance(outcome, DryRun)
    assert outcome.accepted is True
    assert outcome.errors == ()
    assert outcome.report is not None
    assert rig.handler.calls == []
    assert rig.idempotency.records == []
    assert rig.events == []


def test_outdated_names_the_current_version_and_nothing_secret(rig: Rig) -> None:
    outcome = rig.submit(envelope(version="0"))
    assert isinstance(outcome, Outdated)
    assert outcome.current_version == VERSION
    assert len(outcome.current_sha256) == 64
    assert rig.sandbox.validations == []


def test_not_found_for_a_form_the_repository_does_not_have(rig: Rig) -> None:
    outcome = rig.submit(envelope(form="datum-tck-no-such-form"))
    assert isinstance(outcome, NotFound)
    assert outcome.form_key == "datum-tck-no-such-form"
    assert rig.sandbox.validations == []


@pytest.mark.parametrize("bad", ["a b", "x" * 129, "", "../etc", "a/b"])
def test_not_found_for_a_form_key_that_is_no_form_key_without_asking_the_repository(rig: Rig, bad: str) -> None:
    outcome = rig.submit(envelope(form=bad))
    assert isinstance(outcome, NotFound)
    assert "definition" not in rig.trail


def nested_to(depth: int) -> dict[str, Any]:
    """An envelope whose JSON depth (a scalar is 1, a container one more than its deepest member) is `depth`."""
    value: Any = 1
    for _ in range(depth - json_depth(envelope())):
        value = {"n": value}
    document = envelope(values={"name": value})
    assert json_depth(document) == depth
    return document


@pytest.mark.parametrize(
    "document",
    [
        pytest.param(["not", "an", "object"], id="not an object"),
        pytest.param("text", id="a string"),
        pytest.param(nested_to(65), id="nested 65 deep"),
        pytest.param(envelope(values={"name": float("nan")}), id="a non-finite number"),
        pytest.param(envelope(values={"name": float("inf")}), id="infinity"),
        pytest.param({"versionContext": {}, "submission": {"values": {}}}, id="no form id"),
        pytest.param(envelope(extra={"values": "a string"}), id="values that are no object"),
    ],
)
def test_malformed_gives_a_reason_and_costs_no_throttle_no_pre_check_and_no_run(rig: Rig, document: Any) -> None:
    outcome = rig.service.submit(FormRef.from_document(), document, http_context())
    assert isinstance(outcome, Malformed)
    assert outcome.reason
    assert rig.trail == []
    assert rig.throttle.keys == []


def test_a_document_nested_exactly_64_deep_is_not_malformed(rig: Rig) -> None:
    outcome = rig.submit(nested_to(64))
    assert not isinstance(outcome, Malformed)


def test_too_large_names_the_cap_and_comes_before_everything_else() -> None:
    with started({"web": {"api": {"max_body_size": "4KiB"}}}, full=True) as running:
        outcome = running.submit(envelope(values={"name": "x" * 5000}))
    assert isinstance(outcome, TooLarge)
    assert outcome.max_bytes == 4096
    assert running.trail == []


def test_the_cap_is_measured_on_the_tree_not_on_a_pretty_print() -> None:
    with started({"web": {"api": {"max_body_size": "4KiB"}}}) as running:
        within = running.submit(envelope(values={"name": "x" * 3000}))
    assert isinstance(within, Accepted)


def test_refused_keeps_the_pre_checks_code_and_words_and_carries_no_status() -> None:
    decision = Reject("quota.exceeded", "Come back tomorrow")

    def pre_check(incoming: Any) -> Reject:
        return decision

    with started(pre_checks=[pre_check]) as running:
        outcome = running.submit()
    assert isinstance(outcome, Refused)
    assert outcome.decision == decision
    assert outcome.decision.code == "quota.exceeded"
    assert outcome.decision.message == "Come back tomorrow"
    assert not hasattr(outcome.decision, "status")
    assert running.sandbox.validations == []


def test_throttled_carries_the_retry_after_and_the_completed_key() -> None:
    with started() as running:
        running.throttle.deny = 7
        outcome = running.submit(envelope(), http_context(ip="203.0.113.9", principal="alice"))
    assert isinstance(outcome, Throttled)
    assert outcome.retry_after == 7
    assert outcome.key.ip == "203.0.113.9"
    assert outcome.key.principal == "alice"
    assert outcome.key.form_key == FORM
    assert outcome.key.kind == ThrottleKind.SUBMIT
    assert outcome.key.channel == "http"
    assert running.sandbox.validations == []


def test_unavailable_when_the_runtime_is_down_names_server_unavailable(rig: Rig) -> None:
    cause = ProgramUnavailableError("The Datum runtime is not running.")
    rig.sandbox.error = cause
    outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.unavailable"
    assert outcome.cause is cause
    assert rig.handler.calls == []


def test_unavailable_when_the_slots_are_busy_names_server_busy(rig: Rig) -> None:
    rig.sandbox.error = EngineBusyError("slots")
    outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.busy"


def test_unavailable_reason_is_never_the_causes_text(rig: Rig) -> None:
    rig.sandbox.error = ProgramUnavailableError("secret path /var/run/ZZSECRETZZ")
    outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert "ZZSECRETZZ" not in outcome.reason


def test_a_wrapped_and_a_bare_document_are_the_same_submission_with_one_digest(rig: Rig) -> None:
    document = envelope()
    first = rig.submit(wrapped(document), bus(submission_key="attempt-1"))
    second = rig.submit(document, bus(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(second, Redelivered)
    assert second.digest == first.submission.digest == canonical_digest(document)


def test_the_closing_match_over_the_union_is_exhaustive() -> None:
    def label(outcome: SubmissionOutcome) -> str:
        match outcome:
            case Accepted() | Redelivered():
                return "receipt"
            case Rejected() | Checked() | DryRun():
                return "verdict"
            case (
                Outdated()
                | NotFound()
                | Malformed()
                | TooLarge()
                | Refused()
                | Throttled()
                | Unavailable()
                | KeyConflict()
            ):
                return "refusal"
            case _ as unreachable:
                typing.assert_never(unreachable)

    assert label(Malformed("x")) == "refusal"
