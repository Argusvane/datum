"""Cases through a directly built `SubmissionService`.

the kernel's warning and info items ride on the dry-run report and on `Checked`, never on `Accepted`;
a well-formed signed wrapper is refused with the catalog's `signing.not_set_up` while signed submissions are not set
up;
`MemoryError`, `KeyboardInterrupt`, `SystemExit` and cancellation propagate out of every hook, repository and
store wrapper, never `Unavailable`; a stale dry run is the 409 `form.outdated`.
"""

import asyncio
import json
from collections.abc import Callable
from typing import Any, cast

import pytest
from direct_support import Parts
from submissions_support import body_for, bus, envelope, journey_check, wrapped

from datum_core.hooks import HookFindings, HookProblem
from datum_core.http import ANSWER_ROWS, submission_answer
from datum_core.submissions import (
    Accepted,
    Checked,
    DryRun,
    FormRef,
    Malformed,
    Outdated,
    Rejected,
    SubmissionService,
    Unavailable,
)
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import SandboxResult

SIGNING = {"scope": "envelope", "placement": "wrapper", "digest": "sha-256", "canonicalization": "jcs"}
NOTES: list[dict[str, JsonValue]] = [
    {"code": "recommended", "componentId": "name", "severity": "warning"},
    {"code": "hint", "path": "later", "severity": "info"},
]
WIRE_NOTES = [
    {"field": "name", "code": "recommended", "severity": "warning"},
    {"field": "later", "code": "hint", "severity": "info"},
]


def with_notes(*errors: dict[str, JsonValue]) -> SandboxResult:
    return SandboxResult({"errors": [*NOTES, *errors], "values": {"name": "Ada"}}, 0.01)


def findings(outcome: DryRun) -> list[dict[str, Any]]:
    return cast("list[dict[str, Any]]", outcome.report["errors"])


def answer_body(outcome: Any) -> dict[str, Any]:
    reply = submission_answer(outcome, retry_after=5)
    return json.loads(reply.body)  # type: ignore[no-any-return]


# -- the kernel's notes --------------------------------------------------------------------------------------------
def test_a_validate_carries_the_kernels_warning_and_info_items_and_is_still_accepted() -> None:
    parts = Parts()
    parts.sandbox.verdict = with_notes()
    outcome = parts.service().validate(FormRef.from_document(), journey_check(envelope()), bus())
    assert isinstance(outcome, Checked)
    assert outcome.accepted
    assert outcome.errors == ()
    assert outcome.notes == (("name", "recommended", "warning", None), ("later", "hint", "info", None))
    assert answer_body(outcome)["notes"] == WIRE_NOTES


def test_a_validate_with_a_blocking_error_carries_the_notes_beside_the_errors() -> None:
    parts = Parts()
    parts.sandbox.verdict = with_notes({"code": "required", "componentId": "name", "severity": "error"})
    outcome = parts.service().validate(FormRef.from_document(), journey_check(envelope()), bus())
    assert isinstance(outcome, Checked)
    assert not outcome.accepted
    assert [code for _, code, _ in outcome.errors] == ["required"]
    assert [code for _, code, _, _ in outcome.notes] == ["recommended", "hint"]


def test_a_dry_run_keeps_the_notes_among_its_errors_with_their_severity_accepted_or_refused() -> None:
    parts = Parts()
    parts.sandbox.verdict = with_notes()
    accepted = parts.service().test(FormRef.from_document(), wrapped(envelope()), bus())
    parts.sandbox.verdict = with_notes({"code": "required", "componentId": "name", "severity": "error"})
    refused = parts.service().test(FormRef.from_document(), wrapped(envelope()), bus())
    assert isinstance(accepted, DryRun)
    assert isinstance(refused, DryRun)
    assert [(f["code"], f["severity"]) for f in findings(accepted)] == [
        ("recommended", "warning"),
        ("hint", "info"),
    ]
    assert accepted.errors == ()
    assert [(f["code"], f["severity"]) for f in findings(refused)] == [
        ("recommended", "warning"),
        ("hint", "info"),
        ("required", "error"),
    ]
    assert "notes" not in answer_body(accepted)
    assert "report" not in answer_body(accepted)


def test_a_submission_never_carries_the_kernels_notes() -> None:
    parts = Parts()
    parts.sandbox.verdict = with_notes()
    outcome = parts.service().submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Accepted)
    assert outcome.warnings == ()
    assert "warnings" not in answer_body(outcome)
    assert "notes" not in answer_body(outcome)


def test_a_rejected_submission_lists_only_the_blocking_errors() -> None:
    parts = Parts()
    parts.sandbox.verdict = with_notes({"code": "required", "componentId": "name", "severity": "error"})
    outcome = parts.service().submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Rejected)
    assert [code for _, code, _ in outcome.errors] == ["required"]
    assert "notes" not in answer_body(outcome)


def test_no_notes_leave_the_member_out_of_the_answers() -> None:
    parts = Parts()
    checked = parts.service().validate(FormRef.from_document(), journey_check(envelope()), bus())
    dry = parts.service().test(FormRef.from_document(), wrapped(envelope()), bus())
    assert isinstance(checked, Checked)
    assert isinstance(dry, DryRun)
    assert checked.notes == ()
    assert "notes" not in answer_body(checked)
    assert "notes" not in dry.report
    assert dry.report["errors"] == []


def test_a_validators_warning_rides_the_dry_run_errors_after_the_kernels_findings() -> None:
    parts = Parts()
    parts.sandbox.verdict = with_notes()

    def validator(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(warnings=(HookProblem(None, "soft", "Soft"),))

    outcome = parts.service(validators=[validator]).test(FormRef.from_document(), wrapped(envelope()), bus())
    assert isinstance(outcome, DryRun)
    assert [(f["code"], f["severity"], f["stage"]) for f in findings(outcome)] == [
        ("recommended", "warning", None),
        ("hint", "info", None),
        ("soft", "warning", "server"),
    ]


# -- the signed wrapper --------------------------------------------------------------------------------------------
@pytest.mark.parametrize("call", ["submit", "validate", "test"])
def test_a_well_formed_signed_wrapper_is_refused_as_signing_not_set_up_and_costs_nothing(call: str) -> None:
    parts = Parts()
    signed = body_for(call, {"format": SIGNING, "payload": envelope(), "signatures": []})
    if call == "submit":
        signed = wrapped(signed)
    outcome = getattr(parts.service(), call)(FormRef.from_document(), signed, bus())
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "signing.not_set_up"
    assert parts.trail == []
    assert parts.handler.calls == []
    assert parts.events == []


def test_the_signed_wrapper_answers_the_catalogs_503_row_without_retry_after() -> None:
    parts = Parts()
    signed = wrapped({"format": SIGNING, "payload": envelope(), "signatures": []})
    outcome = parts.service().submit(FormRef.from_document(), signed, bus())
    reply = submission_answer(outcome, retry_after=5)
    assert reply.status == 503
    assert "Retry-After" not in reply.headers
    assert json.loads(reply.body) == {"errors": [{"code": "signing.not_set_up"}]}
    assert any(row.status == 503 and "signing.not_set_up" in row.codes and not row.headers for row in ANSWER_ROWS)


def _bad_wrappers() -> list[Any]:
    return [
        {"format": SIGNING, "payload": envelope(), "signatures": {}},
        {"format": "jcs", "payload": envelope(), "signatures": []},
        {"format": SIGNING, "payload": [], "signatures": []},
        {"format": SIGNING, "payload": envelope()},
        {"format": SIGNING, "payload": envelope(), "signatures": [], "smuggled": 1},
    ]


@pytest.mark.parametrize("index", range(5))
def test_an_out_of_shape_signed_wrapper_stays_malformed(index: int) -> None:
    parts = Parts()
    signed = wrapped(_bad_wrappers()[index])
    assert isinstance(parts.service().submit(FormRef.from_document(), signed, bus()), Malformed)


def test_an_out_of_shape_signed_wrapper_stays_malformed_unwrapped() -> None:
    parts = Parts()
    body = json.dumps(_bad_wrappers()[0]).encode()
    assert isinstance(parts.service().submit(FormRef.from_document(), body, bus()), Malformed)


# -- what must never be swallowed ----------------------------------------------------------------------------------
class BoomError(Exception):
    """Stands for the ordinary failure that IS `Unavailable`; the control group of the matrix below."""


PROPAGATING: list[Callable[[], BaseException]] = [MemoryError, KeyboardInterrupt, SystemExit, asyncio.CancelledError]


def fail_with(error: BaseException) -> Callable[..., Any]:
    def hook(*args: Any, **kwargs: Any) -> Any:
        raise error

    return hook


def _contributor(parts: Parts, error: BaseException) -> SubmissionService:
    return parts.service(context_contributors=[fail_with(error)])


def _customizer(parts: Parts, error: BaseException) -> SubmissionService:
    return parts.service(host_options_customizers=[fail_with(error)])


def _rules(parts: Parts, error: BaseException) -> SubmissionService:
    return parts.service(rules_providers=[fail_with(error)])


def _validator(parts: Parts, error: BaseException) -> SubmissionService:
    return parts.service(validators=[fail_with(error)])


def _pre_check(parts: Parts, error: BaseException) -> SubmissionService:
    return parts.service(pre_checks=[fail_with(error)])


def _handler(parts: Parts, error: BaseException) -> SubmissionService:
    return parts.service(handler=fail_with(error))


def _repository(parts: Parts, error: BaseException) -> SubmissionService:
    parts.repository.current = fail_with(error)  # type: ignore[method-assign]
    return parts.service()


def _find(parts: Parts, error: BaseException) -> SubmissionService:
    parts.idempotency.find = fail_with(error)  # type: ignore[method-assign]
    return parts.service()


def _record(parts: Parts, error: BaseException) -> SubmissionService:
    parts.idempotency.record = fail_with(error)  # type: ignore[method-assign]
    return parts.service()


WRAPPERS: list[Callable[[Parts, BaseException], SubmissionService]] = [
    _contributor,
    _customizer,
    _rules,
    _validator,
    _pre_check,
    _handler,
    _repository,
    _find,
    _record,
]


@pytest.mark.parametrize("make_error", PROPAGATING, ids=lambda make: make.__name__)
@pytest.mark.parametrize("wrap", WRAPPERS, ids=lambda wrap: wrap.__name__.removeprefix("_"))
def test_what_must_not_be_swallowed_propagates_out_of_every_hook_repository_and_store(
    wrap: Callable[[Parts, BaseException], SubmissionService], make_error: Callable[[], BaseException]
) -> None:
    error = make_error()
    parts = Parts()
    service = wrap(parts, error)
    with pytest.raises(type(error)) as caught:
        service.submit(FormRef.from_document(), envelope(), bus())
    assert caught.value is error


@pytest.mark.parametrize("wrap", [_contributor, _customizer, _rules, _validator, _repository, _find, _record])
def test_an_ordinary_failure_is_still_unavailable_or_survived(
    wrap: Callable[[Parts, BaseException], SubmissionService],
) -> None:
    """The control group: the matrix above is about the exceptions that are not ordinary."""
    parts = Parts()
    outcome = wrap(parts, BoomError("password=hunter2")).submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Unavailable | Accepted)


# -- a stale dry run ----------------------------------------------------------------------------------------------
def test_a_stale_dry_run_is_outdated_and_answers_409_form_outdated() -> None:
    parts = Parts()
    outcome = parts.service().test(FormRef.from_document(), wrapped(envelope(version="0")), bus())
    assert isinstance(outcome, Outdated)
    reply = submission_answer(outcome, retry_after=5)
    assert reply.status == 409
    assert json.loads(reply.body) == {"errors": [{"code": "form.outdated"}]}
    assert parts.sandbox.validations == []
