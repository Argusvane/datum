"""The submissions hooks run in list order; the first refusal stops the rest; validators all run."""

import json
from typing import Any

import pytest
from submissions_support import FORM, bus, envelope, journey_check, started, wrapped

from datum_core.hooks import HookFindings, HookProblem, HookRefusedError
from datum_core.submissions import (
    Accepted,
    Allow,
    FormRef,
    IncomingSubmission,
    PreCheckStatuses,
    Refused,
    Reject,
    Rejected,
    SubmissionContext,
    ValidatedSubmission,
)
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import RuleModule


def named_pre_check(trail: list[str], name: str, answer: Any = None) -> Any:
    def check(incoming: IncomingSubmission) -> Any:
        trail.append(name)
        return answer if answer is not None else Allow()

    return check


def test_pre_checks_run_in_list_order() -> None:
    trail: list[str] = []
    checks = [named_pre_check(trail, name) for name in ("a", "b", "c")]
    with started(pre_checks=checks) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Accepted)
    assert trail == ["a", "b", "c"]


def test_the_first_reject_stops_the_remaining_pre_checks_and_the_run() -> None:
    trail: list[str] = []
    decision = Reject("closed.today", "Closed")
    checks = [named_pre_check(trail, "a"), named_pre_check(trail, "b", decision), named_pre_check(trail, "c")]
    with started(pre_checks=checks) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Refused)
    assert outcome.decision is decision
    assert trail == ["a", "b"]
    assert rig.sandbox.validations == []


def test_a_pre_check_is_handed_the_form_key_the_mode_and_the_context() -> None:
    seen: list[IncomingSubmission] = []

    def check(incoming: IncomingSubmission) -> Allow:
        seen.append(incoming)
        return Allow()

    given = SubmissionContext(channel="sync", user_agent="batch", submission_key="sync-1")
    with started(pre_checks=[check]) as rig:
        rig.submit(envelope(), given)
    (incoming,) = seen
    assert incoming.form_key == FORM
    assert str(incoming.mode) == "submit"
    assert incoming.context == given


def test_the_mode_of_a_pre_check_is_validate_for_validate_and_test_for_a_dry_run() -> None:
    modes: list[str] = []

    def check(incoming: IncomingSubmission) -> Allow:
        modes.append(str(incoming.mode))
        return Allow()

    with started(pre_checks=[check]) as rig:
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
        rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
    assert modes == ["validate", "test"]


def test_context_contributors_merge_in_list_order_and_a_repeated_key_is_replaced_by_the_later_one() -> None:
    def first(context: SubmissionContext) -> dict[str, JsonValue]:
        return {"tenant": "first-tenant", "plan": "gold"}

    def nothing(context: SubmissionContext) -> None:
        return None

    def second(context: SubmissionContext) -> dict[str, JsonValue]:
        return {"tenant": "second-tenant"}

    with started(context_contributors=[first, nothing, second]) as rig:
        rig.submit()
    (sent, _, _), *_ = rig.sandbox.validations
    text = json.dumps(sent)
    assert "second-tenant" in text
    assert "first-tenant" not in text
    assert "gold" in text


def test_customizers_run_in_list_order_and_the_first_refusal_stops_the_rest() -> None:
    trail: list[str] = []

    def one(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        trail.append("one")

    def stop(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        trail.append("stop")
        raise HookRefusedError.invalid("customizer.no", "No")

    def never(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        trail.append("never")

    with started(host_options_customizers=[one, stop, never]) as rig, pytest.raises(HookRefusedError):
        rig.submit()
    assert trail == ["one", "stop"]
    assert rig.sandbox.validations == []


def test_rules_providers_modules_reach_the_run_in_list_order() -> None:
    def a(form_key: str, form: Any, context: SubmissionContext) -> list[RuleModule]:
        return [RuleModule("a", "1", "({validators: []})")]

    def b(form_key: str, form: Any, context: SubmissionContext) -> list[RuleModule]:
        return [RuleModule("b", "1", "({validators: []})"), RuleModule("c", "1", "({validators: []})")]

    with started(rules_providers=[a, b]) as rig:
        rig.submit()
    ((_, rules, _), *_) = rig.sandbox.validations
    assert [module.id for module in rules] == ["a", "b", "c"]


def test_the_form_the_run_judges_is_the_one_the_rules_provider_was_asked_about() -> None:
    asked: list[str] = []

    def provider(form_key: str, form: Any, context: SubmissionContext) -> list[RuleModule]:
        asked.append(f"{form_key}:{form['id']}")
        return []

    with started(rules_providers=[provider]) as rig:
        rig.submit()
    assert asked == [f"{FORM}:{FORM}"]


def validator_that(trail: list[str], name: str, answer: HookFindings | None = None) -> Any:
    def validate(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        trail.append(name)
        return answer

    return validate


def test_validators_all_run_and_their_errors_and_warnings_are_merged_in_list_order() -> None:
    trail: list[str] = []
    first = HookFindings(errors=(HookProblem("a", "e.one", "1"),), warnings=(HookProblem("a", "w.one", "1"),))
    second = HookFindings(errors=(HookProblem("b", "e.two", "2"),))
    validators = [validator_that(trail, "1", first), validator_that(trail, "2", second), validator_that(trail, "3")]
    with started(validators=validators) as rig:
        outcome = rig.submit()
    assert trail == ["1", "2", "3"]
    assert isinstance(outcome, Rejected)
    assert [code for _, code, _ in outcome.errors] == ["e.one", "e.two"]
    assert rig.handler.calls == []


def test_a_validator_that_raises_a_refusal_stops_the_validators_at_once() -> None:
    trail: list[str] = []

    def refuse(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings:
        trail.append("refuse")
        raise HookRefusedError.conflict("slot.taken", "Taken")

    validators = [validator_that(trail, "before"), refuse, validator_that(trail, "after")]
    with started(validators=validators) as rig, pytest.raises(HookRefusedError) as raised:
        rig.submit()
    assert raised.value.problems[0].code == "slot.taken"
    assert trail == ["before", "refuse"]


def test_the_validators_are_handed_the_submission_the_sandbox_judged() -> None:
    seen: list[ValidatedSubmission] = []

    def look(candidate: ValidatedSubmission, context: SubmissionContext) -> None:
        seen.append(candidate)

    with started(validators=[look]) as rig:
        rig.submit()
    (candidate,) = seen
    assert candidate.form_key == FORM
    assert candidate.values == {"name": "Ada Lovelace"}
    assert len(candidate.digest) == 64


def test_pre_check_statuses_standard_answers_403_for_every_code_and_by_suffix_two_more() -> None:
    standard, by_suffix = PreCheckStatuses.standard(), PreCheckStatuses.by_suffix()
    assert standard(Reject("anything.at.all", "m")) == 403
    assert standard(Reject("access.denied", "m")) == 403
    assert by_suffix(Reject("field.invalid", "m")) == 422
    assert by_suffix(Reject("backend.unavailable", "m")) == 503
    assert by_suffix(Reject("other", "m")) == 403
    assert by_suffix(Reject("access.denied", "m")) == 403


def test_by_suffix_never_maps_to_429() -> None:
    by_suffix = PreCheckStatuses.by_suffix()
    assert all(by_suffix(Reject(f"x.{suffix}", "m")) != 429 for suffix in ("invalid", "unavailable", "flood", "limit"))
