"""Channels, the context every hook sees, the two ways to name a form, and the one size cap."""

import dataclasses
from typing import Any

import pytest
from submissions_support import (
    FORM,
    ThreadLoopAwaiter,
    assign,
    attr_of,
    bus,
    definition,
    envelope,
    http_context,
    refused_by_kernel,
    started,
)

from datum_core.hooks import HookFindings, HookProblem
from datum_core.submissions import (
    Accepted,
    AcceptedSubmission,
    Allow,
    FormRef,
    IncomingSubmission,
    Malformed,
    Redelivered,
    Rejected,
    SubmissionContext,
    TooLarge,
    ValidatedSubmission,
)
from datum_sandbox.checks import DatumConfigurationError

GOLDEN = {
    "CTL-01": None,
    "CTL-02": refused_by_kernel("required", "name"),
    "CTL-03": refused_by_kernel("maxLength", "name"),
    "CTL-04": refused_by_kernel("pattern", "code"),
}


# -- the word rule -----------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "channel", ["http", "bus", "sync", "other", "queue.orders", "a", "9lives", "kafka:topic/a-b_c", "x" * 64]
)
def test_a_channel_is_a_word_of_one_to_64_letters_digits_and_the_marks(channel: str) -> None:
    assert SubmissionContext(channel=channel).channel == channel


@pytest.mark.parametrize(
    "channel", ["", " ", "-lead", "_lead", ".lead", "has space", "x" * 65, "new\nline", "tab\t", "é"]
)
def test_a_channel_outside_the_rule_is_refused(channel: str) -> None:
    with pytest.raises(ValueError, match="channel"):
        SubmissionContext(channel=channel)


def test_the_context_is_a_frozen_record_whose_optional_fields_default_to_none() -> None:
    context = SubmissionContext(channel="bus")
    assert dataclasses.is_dataclass(SubmissionContext)
    assert (context.principal, context.remote_address, context.user_agent) == (None, None, None)
    assert (context.headers, context.throttle_key, context.body_digest) == (None, None, None)
    with pytest.raises(dataclasses.FrozenInstanceError):
        assign(context, "channel", "http")


# -- the form reference ------------------------------------------------------------------------------------------------
def test_from_document_judges_the_form_the_document_names() -> None:
    with started() as rig:
        outcome = rig.service.submit(FormRef.from_document(), envelope(form=FORM), bus())
    assert isinstance(outcome, Accepted)


def test_of_accepts_a_document_naming_the_same_form() -> None:
    with started() as rig:
        outcome = rig.service.submit(FormRef.of(FORM), envelope(form=FORM), bus())
    assert isinstance(outcome, Accepted)


def test_of_refuses_a_document_that_names_another_form_and_asks_nothing() -> None:
    with started(full=True) as rig:
        outcome = rig.service.submit(FormRef.of(FORM), envelope(form="claims"), http_context())
    assert isinstance(outcome, Malformed)  # an unknown form answers the 400 outcome, never a 404
    assert rig.trail == []


def test_of_refuses_another_form_even_when_that_form_key_is_invalid() -> None:
    with started(full=True) as rig:
        outcome = rig.service.submit(FormRef.of(FORM), envelope(form="a b"), http_context())
    assert isinstance(outcome, Malformed)
    assert rig.trail == []


def test_of_ignores_nothing_the_document_says_about_its_version() -> None:
    with started() as rig:
        outcome = rig.service.submit(FormRef.of(FORM), envelope(form=FORM, version="0"), bus())
    assert type(outcome).__name__ == "Outdated"


# -- the same verdicts on every channel --------------------------------------------------------------------------------
@pytest.mark.parametrize("control", sorted(GOLDEN))
def test_the_golden_documents_give_the_same_verdict_on_the_http_and_the_bus_channel(control: str) -> None:
    verdict = GOLDEN[control]
    results: dict[str, Any] = {}
    for name, context in (("http", http_context()), ("bus", bus())):
        with started() as rig:
            rig.sandbox.verdict = verdict
            outcome = rig.submit(envelope(), context)
            results[name] = (type(outcome).__name__, _errors(outcome), len(rig.handler.calls))
    assert results["http"] == results["bus"]
    assert results["bus"][2] == (1 if verdict is None else 0)


def _errors(outcome: Any) -> list[tuple[str | None, str]]:
    return sorted((field, code) for field, code, _ in getattr(outcome, "errors", ()))


def test_a_document_accepted_over_http_is_redelivered_with_the_first_receipt_on_the_bus() -> None:
    with started() as rig:
        first = rig.submit(envelope(), http_context(submission_key="attempt-1"))
        again = rig.submit(envelope(), bus(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert again.receipt == first.receipt
    assert len(rig.handler.calls) == 1


def test_a_document_accepted_on_the_bus_is_redelivered_over_http() -> None:
    with started() as rig:
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        again = rig.submit(envelope(), http_context(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert isinstance(again, Redelivered)
    assert len(rig.handler.calls) == 1


def test_the_same_values_in_another_form_are_not_a_redelivery() -> None:
    with started() as rig:
        rig.repository.forms["claims"] = definition("claims")
        first = rig.submit(envelope(form="contact"))
        other = rig.submit(envelope(form="claims"))
    assert isinstance(first, Accepted)
    assert isinstance(other, Accepted)
    assert len(rig.handler.calls) == 2


# -- what a hook sees --------------------------------------------------------------------------------------------------
def test_a_pre_check_and_a_validator_written_for_the_routes_see_the_channel() -> None:
    seen: list[tuple[str, str, str]] = []

    def pre_check(incoming: IncomingSubmission) -> Any:
        seen.append(("pre_check", incoming.context.channel, str(incoming.mode)))
        return Allow()

    def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        seen.append(("validator", context.channel, candidate.form_key))
        return None

    with started(pre_checks=[pre_check], validators=[validator]) as rig:
        rig.submit(envelope(), bus())
        rig.submit(
            envelope(values={"name": "Grace"}), SubmissionContext(channel="queue.orders", submission_key="order-1")
        )
    assert seen == [
        ("pre_check", "bus", "submit"),
        ("validator", "bus", FORM),
        ("pre_check", "queue.orders", "submit"),
        ("validator", "queue.orders", FORM),
    ]


def test_every_hook_kind_is_handed_the_context_last() -> None:
    contexts: dict[str, Any] = {}

    def contributor(context: SubmissionContext) -> None:
        contexts["contributor"] = context

    def customizer(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        contexts["customizer"] = (form_key, context)

    def rules(form_key: str, form: Any, context: SubmissionContext) -> tuple[()]:
        contexts["rules"] = (form_key, context)
        return ()

    given = SubmissionContext(channel="sync", user_agent="batch/1", submission_key="sync-1")
    with started(
        context_contributors=[contributor], host_options_customizers=[customizer], rules_providers=[rules]
    ) as rig:
        rig.submit(envelope(), given)
    assert contexts["contributor"] == given
    assert contexts["customizer"] == (FORM, given)
    assert contexts["rules"] == (FORM, given)


def test_the_handler_is_handed_the_channel_and_none_for_an_address_the_caller_did_not_give() -> None:
    with started() as rig:
        rig.submit(envelope(), bus())
        rig.submit(envelope(values={"name": "Grace"}), http_context(ip="198.51.100.4"))
    queued, routed = rig.handler.calls
    assert isinstance(queued, AcceptedSubmission)
    assert (queued.channel, queued.remote_address, queued.user_agent) == ("bus", None, None)
    assert (routed.channel, routed.remote_address, routed.user_agent) == ("http", "198.51.100.4", "pytest")


def test_a_rejection_event_carries_the_channel_and_the_address() -> None:
    with started() as rig:
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": ""}), http_context(ip="198.51.100.4"))
        rig.submit(envelope(values={"name": ""}), bus())
    rejected = [e for e in rig.events if type(e).__name__ == "SubmissionRejectedEvent"]
    assert [(attr_of(e, "channel"), attr_of(e, "remote_address"), attr_of(e, "form_key")) for e in rejected] == [
        ("http", "198.51.100.4", FORM),
        ("bus", None, FORM),
    ]


# -- the one size cap --------------------------------------------------------------------------------------------------
def test_a_tree_over_the_cap_from_a_bus_caller_is_too_large_before_the_throttle_or_any_hook() -> None:
    big = envelope(values={"name": "x" * 5000})
    with started({"web": {"api": {"max_body_size": "4KiB"}}}, full=True) as rig:
        outcome = rig.submit(big, SubmissionContext(channel="bus", throttle_key=http_context().throttle_key))
    assert isinstance(outcome, TooLarge)
    assert rig.trail == []
    assert rig.throttle.keys == []


def test_a_caller_with_no_throttle_key_is_not_counted() -> None:
    with started() as rig:
        rig.submit(envelope(), bus())
    assert rig.throttle.keys == []


def test_a_caller_with_a_throttle_key_is_counted_once() -> None:
    with started() as rig:
        rig.submit(envelope(), http_context())
    assert len(rig.throttle.keys) == 1


# -- the awaiter -------------------------------------------------------------------------------------------------------
def test_an_async_hook_with_no_awaiter_names_the_missing_bridge() -> None:
    async def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        return None

    with started(validators=[validator]) as rig, pytest.raises(DatumConfigurationError, match=r"awaiter|bridge"):
        rig.submit()  # raised as it is: a configuration fault is neither a 503 nor a refusal


def test_an_async_validator_is_resolved_through_the_awaiter_on_the_worker_thread() -> None:
    async def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        return None

    awaiter = ThreadLoopAwaiter()
    try:
        with started(validators=[validator], awaiter=awaiter) as rig:
            outcome = rig.submit()
    finally:
        awaiter.close()
    assert isinstance(outcome, Accepted)


def test_a_refusing_async_validator_is_a_rejection() -> None:
    async def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        return HookFindings(errors=(HookProblem("name", "taken", "Taken"),))

    awaiter = ThreadLoopAwaiter()
    try:
        with started(validators=[validator], awaiter=awaiter) as rig:
            outcome = rig.submit()
    finally:
        awaiter.close()
    assert isinstance(outcome, Rejected)
