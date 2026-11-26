"""Refusal kinds, a raising hook, and what a refused request costs."""

from collections.abc import Callable
from typing import Any

import pytest
from submissions_support import bus, envelope, http_context, journey_check, started, wrapped

from datum_core.hooks import HookRefusedError, HookRefusedKind
from datum_core.submissions import Allow, FormRef, Reject, SubmissionContext, ValidatedSubmission
from datum_sandbox.protocol import DefinitionTooDeepError


def seam(keyword: str, hook: Callable[..., Any]) -> dict[str, Any]:
    return {keyword: [hook]}


def pre_check_raising(error: Exception) -> Callable[..., Any]:
    def check(incoming: Any) -> Allow:
        raise error

    return check


def contributor_raising(error: Exception) -> Callable[..., Any]:
    def contribute(context: SubmissionContext) -> None:
        raise error

    return contribute


def customizer_raising(error: Exception) -> Callable[..., Any]:
    def customize(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        raise error

    return customize


def rules_raising(error: Exception) -> Callable[..., Any]:
    def provide(form_key: str, form: Any, context: SubmissionContext) -> None:
        raise error

    return provide


def validator_raising(error: Exception) -> Callable[..., Any]:
    def validate(candidate: ValidatedSubmission, context: SubmissionContext) -> None:
        raise error

    return validate


def handler_raising(error: Exception) -> Callable[..., Any]:
    def handle(accepted: Any) -> None:
        raise error

    return handle


HOOKS = {
    "pre_check": ("pre_checks", pre_check_raising),
    "contributor": ("context_contributors", contributor_raising),
    "customizer": ("host_options_customizers", customizer_raising),
    "rules provider": ("rules_providers", rules_raising),
    "validator": ("validators", validator_raising),
    "handler": ("handler", handler_raising),
}


def build(name: str, error: Exception) -> dict[str, Any]:
    keyword, factory = HOOKS[name]
    hook = factory(error)
    return {keyword: hook if keyword == "handler" else [hook]}


@pytest.mark.parametrize("name", HOOKS)
@pytest.mark.parametrize(
    ("factory", "kind"),
    [
        (HookRefusedError.forbidden, HookRefusedKind.FORBIDDEN),
        (HookRefusedError.conflict, HookRefusedKind.CONFLICT),
        (HookRefusedError.invalid, HookRefusedKind.INVALID),
    ],
    ids=["forbidden", "conflict", "invalid"],
)
def test_a_hooks_refusal_reaches_the_caller_as_raised_with_its_kind_and_codes(
    name: str, factory: Callable[[str, str], HookRefusedError], kind: HookRefusedKind
) -> None:
    refusal = factory("tenant.closed", "The tenant is closed")
    with started(**build(name, refusal)) as rig, pytest.raises(HookRefusedError) as raised:
        rig.submit()
    assert raised.value is refusal
    assert raised.value.kind is kind
    assert [p.code for p in raised.value.problems] == ["tenant.closed"]
    assert rig.idempotency.records == []
    assert not [n for n in rig.trail if n.startswith("event:SubmissionValidated")]


@pytest.mark.parametrize("name", HOOKS)
def test_a_datum_error_from_a_hook_reaches_the_caller_with_its_own_code(name: str) -> None:
    error = DefinitionTooDeepError(32, "too deep")
    with started(**build(name, error)) as rig, pytest.raises(DefinitionTooDeepError) as raised:
        rig.submit()
    assert raised.value is error
    assert raised.value.code == "definition.tooDeep"


@pytest.mark.parametrize("name", ["pre_check", "handler"])
def test_an_ordinary_exception_from_a_pre_check_or_the_handler_reaches_the_caller_as_raised(name: str) -> None:
    error = RuntimeError("not mine to handle")
    with started(**build(name, error)) as rig, pytest.raises(RuntimeError, match="not mine to handle") as raised:
        rig.submit()
    assert raised.value is error


def test_the_first_refusal_of_a_pre_check_chain_costs_no_run_no_definition_read_and_no_store() -> None:
    with started(pre_checks=[lambda incoming: Reject("closed", "Closed")]) as rig:  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        rig.submit(envelope(), http_context())
    assert rig.trail == ["throttle"]
    assert rig.sandbox.validations == []
    assert rig.idempotency.finds == []


@pytest.mark.parametrize("name", ["contributor", "customizer", "rules provider"])
def test_a_refusal_before_the_run_costs_no_run(name: str) -> None:
    with started(**build(name, HookRefusedError.forbidden("no", "No"))) as rig, pytest.raises(HookRefusedError):
        rig.submit()
    assert rig.sandbox.validations == []


def test_a_refused_validate_and_a_refused_test_cost_no_run_either() -> None:
    with started(pre_checks=[lambda incoming: Reject("closed", "Closed")]) as rig:  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        rig.service.validate(FormRef.from_document(), journey_check(envelope()), bus())
        rig.service.test(FormRef.from_document(), wrapped(envelope()), bus())
    assert rig.sandbox.validations == []


def test_a_validator_refusal_costs_no_handler_call_no_receipt_and_no_validated_event() -> None:
    refusal = HookRefusedError.invalid("late.no", "No")
    with started(**build("validator", refusal)) as rig, pytest.raises(HookRefusedError):
        rig.submit()
    assert rig.handler.calls == []
    assert rig.idempotency.records == []
