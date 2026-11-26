"""`Unavailable` and what it names, per cause: the runtime, the slots, the run's own refusals, a raising hook."""

from typing import Any

import pytest
from submissions_support import bus, definition, envelope, http_context, started

from datum_core.hooks import HookRefusedError
from datum_core.submissions import FormRef, Unavailable
from datum_sandbox.protocol import (
    DatumError,
    DefinitionTooDeepError,
    ProgramUnavailableError,
    SandboxError,
    SandboxFailure,
    StrayBoundError,
)
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

RUN_CAUSES = [
    pytest.param(ProgramUnavailableError("down"), "server.unavailable", id="runtime down"),
    pytest.param(EngineBusyError("slots"), "server.busy", id="no slot in the wait"),
    pytest.param(StrayBoundError("full"), "server.unavailable", id="the stray bound"),
    pytest.param(EngineClosedError("closed"), "server.unavailable", id="engine closed"),
    pytest.param(SandboxError(SandboxFailure.BUSY, "busy"), "server.busy", id="a busy sandbox error"),
    pytest.param(SandboxError(SandboxFailure.INTERRUPTED, "stopped"), "server.unavailable", id="interrupted"),
    pytest.param(SandboxError(SandboxFailure.THREW, "threw"), "wasm.execution_error", id="the program threw"),
    pytest.param(SandboxError(SandboxFailure.TRAP, "trap", guest_stopped=True), "wasm.execution_error", id="a trap"),
    pytest.param(SandboxError(SandboxFailure.OUTCOME_TOO_LARGE, "big"), "outcome_too_large", id="outcome too large"),
    pytest.param(DefinitionTooDeepError(32, "deep"), "definition.tooDeep", id="definition too deep"),
]


@pytest.mark.parametrize(("error", "code"), RUN_CAUSES)
def test_a_run_that_gave_no_verdict_is_unavailable_under_its_own_code(error: Exception, code: str) -> None:
    with started() as rig:
        rig.sandbox.error = error
        outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert outcome.code == code
    assert outcome.cause is error
    assert rig.handler.calls == []
    assert rig.idempotency.records == []


def test_a_full_stray_bound_says_runs_would_not_stop_never_try_again_shortly() -> None:
    with started() as rig:
        rig.sandbox.error = StrayBoundError("full")
        outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.unavailable"
    assert outcome.reason == (
        "The server runtime is unavailable: runs that would not stop have not ended, so the answers were not judged."
    )


def test_unavailable_publishes_no_validated_event_and_stores_nothing() -> None:
    with started() as rig:
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit()
    assert rig.events == []


@pytest.mark.parametrize(
    ("keyword", "hook", "code"),
    [
        ("context_contributors", lambda context: _boom(), "validator_unavailable"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        ("host_options_customizers", lambda form_key, form, settings, context: _boom(), "validator_unavailable"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        ("rules_providers", lambda form_key, form, context: _boom(), "server.unavailable"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
        ("validators", lambda candidate, context: _boom(), "validator_unavailable"),  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
    ],
)
def test_a_hook_that_raises_an_ordinary_exception_is_unavailable_never_a_500(
    keyword: str, hook: Any, code: str
) -> None:
    seams: dict[str, Any] = {keyword: [hook]}
    with started(**seams) as rig:
        outcome = rig.service.submit(FormRef.from_document(), envelope(), bus())
    assert isinstance(outcome, Unavailable)
    assert outcome.code == code
    assert isinstance(outcome.cause, RuntimeError)
    assert rig.handler.calls == []


def test_the_reason_of_an_unavailable_never_carries_the_hooks_own_words() -> None:
    def hook(context: Any) -> None:
        raise RuntimeError("password=ZZSECRETZZ")

    with started(context_contributors=[hook]) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert "ZZSECRETZZ" not in outcome.reason


def _boom() -> Any:
    raise RuntimeError("the hook is broken")


def test_a_hook_refusal_is_not_unavailable_it_reaches_the_caller_as_raised() -> None:
    def hook(context: Any) -> None:
        raise HookRefusedError.forbidden("tenant.closed", "Closed")

    with started(context_contributors=[hook]) as rig, pytest.raises(HookRefusedError) as raised:
        rig.submit()
    assert raised.value.problems[0].code == "tenant.closed"


def rules_text(form_key: str, form: Any, context: Any) -> Any:
    return "abc"


def rules_objects(form_key: str, form: Any, context: Any) -> Any:
    return [object()]


def contributor_list(context: Any) -> Any:
    return ["x"]


def validator_dict(candidate: Any, context: Any) -> Any:
    return {"errors": []}


@pytest.mark.parametrize(
    ("keyword", "answer", "code", "ran"),
    [
        pytest.param("rules_providers", rules_text, "server.unavailable", False, id="rules: text"),
        pytest.param("rules_providers", rules_objects, "server.unavailable", False, id="rules: not modules"),
        pytest.param("context_contributors", contributor_list, "validator_unavailable", False, id="contributor"),
        pytest.param("validators", validator_dict, "validator_unavailable", True, id="validator: not findings"),
    ],
)
def test_a_hook_that_answers_the_wrong_type_is_unavailable_never_a_500(
    keyword: str, answer: Any, code: str, *, ran: bool
) -> None:
    seams: dict[str, Any] = {keyword: [answer]}
    with started(**seams) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Unavailable)
    assert outcome.code == code
    assert bool(rig.sandbox.validations) is ran
    assert rig.handler.calls == []


def ask(rig: Any, call: str) -> object:
    if call == "inspect":
        return rig.service.inspect("abi", definition(), http_context())
    return rig.submit()


@pytest.mark.parametrize("call", ["submit", "inspect"])
def test_a_run_error_the_catalog_gives_no_run_answer_reaches_the_caller_as_raised(call: str) -> None:
    with started() as rig:
        rig.sandbox.error = DatumError("internal words")
        with pytest.raises(DatumError, match="internal words"):
            ask(rig, call)
