"""The host context (`hostContext`): the values a form's `host.` paths read, worked out by the host, never sent.

`Datum(host_context=...)` is asked once per judged call, after the definition, the idempotency step and the journey,
with the form key and the call's `SubmissionContext`. Its answer rides the run context as `hostContext` beside `today`
(absent when it answers None, or when no provider is given: the lenient reading). Whatever the delivery holds never
reaches that key. An answer the program cannot take as JSON (not an object, a key that is not text, a number JSON cannot
carry, a value with no JSON form, deeper than 64 levels below a key, more than 1,000,000 values) is the host's own bug
and refused as `Unavailable` `server.unavailable` before any run, as a provider that raises is; a `HookRefusedError` is
raised as it is. A retry of a known submit attempt is answered from the idempotency store and asks nothing.
"""

import logging
import math
from collections.abc import Mapping
from typing import Any

import pytest
from pdf_support import pdf_definition, started_pdf, template_layout
from submissions_support import ThreadLoopAwaiter, bus, envelope, http_context, journey_check, started, wrapped

from datum_core.hooks import HookRefusedError
from datum_core.loggers import SUBMISSIONS
from datum_core.pdf.outcomes import Printed
from datum_core.submissions import (
    Accepted,
    Checked,
    DryRun,
    FormRef,
    Malformed,
    NotFound,
    Redelivered,
    SubmissionContext,
    SubmissionService,
    Unavailable,
)

ROLE = {"role": "admin"}


def provider_of(answer: object, calls: list[tuple[str, SubmissionContext]] | None = None) -> Any:
    def provide(form_key: str, context: SubmissionContext) -> object:
        if calls is not None:
            calls.append((form_key, context))
        return answer

    return provide


def nested(levels: int) -> dict[str, Any]:
    """`{"k": {...}}` whose deepest value sits `levels` levels below the context (the member itself is level 1)."""
    value: Any = "leaf"
    for _ in range(levels - 1):
        value = {"k": value}
    return {"k": value}


def run_context(rig: Any) -> dict[str, Any]:
    assert rig.sandbox.validations, rig.trail
    return rig.sandbox.validations[-1][0]  # type: ignore[no-any-return]


def call(service: SubmissionService, mode: str, document: Mapping[str, Any] | None = None) -> Any:
    given = document or envelope()
    if mode == "submit":
        return service.submit(FormRef.from_document(), given, bus())
    if mode == "validate":
        return service.validate(FormRef.from_document(), journey_check(given), bus())
    if mode == "test":
        return service.test(FormRef.from_document(), wrapped(given), bus())
    return service.pdf_check(FormRef.from_document(), given, bus())


MODES = ["submit", "validate", "test", "pdf"]


# -- absent: today's lenient reading -----------------------------------------------------------------------------------
@pytest.mark.parametrize("mode", MODES)
def test_without_a_provider_the_run_context_has_no_host_context(mode: str) -> None:
    with started() as rig:
        call(rig.service, mode)
        assert "hostContext" not in run_context(rig)


@pytest.mark.parametrize("mode", MODES)
def test_a_provider_that_answers_none_leaves_the_host_context_out(mode: str) -> None:
    with started(host_context=provider_of(None)) as rig:
        call(rig.service, mode)
        assert "hostContext" not in run_context(rig)


# -- present -----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("mode", MODES)
def test_the_providers_answer_rides_the_run_context_as_host_context_in_every_mode(mode: str) -> None:
    with started(host_context=provider_of(ROLE)) as rig:
        call(rig.service, mode)
        assert run_context(rig)["hostContext"] == {"role": "admin"}


def test_an_empty_object_is_a_context_and_is_sent_so_every_host_rule_is_judged() -> None:
    with started(host_context=provider_of({})) as rig:
        call(rig.service, "validate")
        assert run_context(rig)["hostContext"] == {}


def test_the_provider_is_handed_the_form_key_and_the_calls_own_context() -> None:
    calls: list[tuple[str, SubmissionContext]] = []
    context = http_context(principal="ada")
    with started(host_context=provider_of(ROLE, calls)) as rig:
        rig.service.submit(FormRef.from_document(), envelope(), context)
    assert calls == [("contact", context)]


def test_the_run_reads_a_copy_so_a_provider_that_keeps_and_changes_its_object_changes_nothing() -> None:
    kept: dict[str, Any] = {"role": "admin", "teams": ["a"]}
    with started(host_context=provider_of(kept)) as rig:
        call(rig.service, "validate")
        kept["role"] = "user"
        kept["teams"].append("b")
        assert run_context(rig)["hostContext"] == {"role": "admin", "teams": ["a"]}


def test_an_async_provider_is_awaited_through_the_awaiter() -> None:
    async def provide(form_key: str, context: SubmissionContext) -> Mapping[str, Any]:
        return {"role": form_key}

    awaiter = ThreadLoopAwaiter()
    try:
        with started(awaiter=awaiter, host_context=provide) as rig:
            call(rig.service, "validate")
            assert run_context(rig)["hostContext"] == {"role": "contact"}
    finally:
        awaiter.close()


def test_the_stage_follows_the_contributors_in_the_receiver_order() -> None:
    stages = SubmissionService.STAGES
    assert stages.index("host_context") == stages.index("contributors") + 1
    assert stages.index("host_context") < stages.index("run")


def test_the_handler_is_handed_the_host_context_the_answers_were_judged_with() -> None:
    with started(host_context=provider_of(ROLE)) as rig:
        outcome = rig.submit()
    assert isinstance(outcome, Accepted)
    assert rig.handler.calls[0].host_context == {"role": "admin"}


def test_the_handler_sees_no_host_context_when_none_was_supplied() -> None:
    with started() as rig:
        rig.submit()
    assert rig.handler.calls[0].host_context is None


# -- the request body never supplies it --------------------------------------------------------------------------------
def test_a_host_context_forged_in_the_envelope_never_reaches_the_runs_host_context() -> None:
    forged = envelope(values={"name": "Ada", "admin_note": "forged"}, extra={"hostContext": {"role": "admin"}})
    forged["hostContext"] = {"role": "admin"}
    with started(host_context=provider_of({"role": "user"})) as rig:
        call(rig.service, "validate", forged)
        assert run_context(rig)["hostContext"] == {"role": "user"}
    with started() as rig:
        call(rig.service, "validate", forged)
        assert "hostContext" not in run_context(rig)


def test_a_host_context_member_beside_the_document_is_a_malformed_delivery() -> None:
    with started(host_context=provider_of(ROLE)) as rig:
        body = {**journey_check(envelope()), "hostContext": {"role": "admin"}}
        outcome = rig.service.validate(FormRef.from_document(), body, bus())
        assert isinstance(outcome, Malformed)
        assert rig.sandbox.validations == []


# -- when it is not asked ----------------------------------------------------------------------------------------------
def test_a_retry_of_a_known_attempt_is_answered_with_its_first_receipt_and_asks_no_provider() -> None:
    calls: list[tuple[str, SubmissionContext]] = []
    first = bus()
    with started(host_context=provider_of(ROLE, calls)) as rig:
        accepted = rig.submit(context=first)
        retried = rig.submit(context=first)
    assert isinstance(accepted, Accepted)
    assert isinstance(retried, Redelivered)
    assert retried.receipt == accepted.receipt
    assert len(calls) == 1
    assert len(rig.sandbox.validations) == 1
    assert len(rig.handler.calls) == 1


def test_an_unknown_form_asks_no_provider() -> None:
    calls: list[tuple[str, SubmissionContext]] = []
    with started(host_context=provider_of(ROLE, calls)) as rig:
        outcome = rig.submit(envelope(form="nope"))
    assert isinstance(outcome, NotFound)
    assert calls == []


# -- the host's own bug fails closed -----------------------------------------------------------------------------------
BAD_ANSWERS = [
    pytest.param(["admin"], id="a list"),
    pytest.param("admin", id="text"),
    pytest.param(3, id="a number"),
    pytest.param(True, id="a boolean"),
    pytest.param({1: "admin"}, id="a key that is not text"),
    pytest.param({"role": math.nan}, id="NaN"),
    pytest.param({"role": math.inf}, id="an infinity"),
    pytest.param({"role": {"admin"}}, id="a set"),
    pytest.param({"role": object()}, id="an object with no JSON form"),
    pytest.param({"role": "\ud800"}, id="a lone surrogate"),
    pytest.param(nested(65), id="65 levels below a key"),
    pytest.param({"many": [0] * 1_000_000}, id="1,000,001 values"),
]


@pytest.mark.parametrize("answer", BAD_ANSWERS)
@pytest.mark.parametrize("mode", MODES)
def test_an_answer_the_program_cannot_take_is_server_unavailable_and_runs_nothing(
    answer: object, mode: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, SUBMISSIONS), started(host_context=provider_of(answer)) as rig:
        outcome = call(rig.service, mode)
        assert rig.sandbox.validations == []
    assert isinstance(outcome, Unavailable), outcome
    assert outcome.code == "server.unavailable"
    assert any("host context" in record.getMessage() for record in caplog.records)
    assert not rig.handler.calls


@pytest.mark.parametrize(
    "answer",
    [
        pytest.param(nested(64), id="64 levels below a key"),
        pytest.param({"many": [0] * 999_999}, id="1,000,000 values"),
    ],
)
def test_the_bounds_themselves_are_taken(answer: dict[str, Any]) -> None:
    with started(host_context=provider_of(answer)) as rig:
        outcome = call(rig.service, "validate")
        assert isinstance(outcome, Checked)
        assert run_context(rig)["hostContext"] == answer


def test_a_provider_that_raises_is_server_unavailable_and_runs_nothing(caplog: pytest.LogCaptureFixture) -> None:
    def provide(form_key: str, context: SubmissionContext) -> Mapping[str, Any]:
        raise RuntimeError("password=ZZSECRETZZ")

    with caplog.at_level(logging.WARNING, SUBMISSIONS), started(host_context=provide) as rig:
        outcome = call(rig.service, "submit")
        assert rig.sandbox.validations == []
    assert isinstance(outcome, Unavailable)
    assert outcome.code == "server.unavailable"
    assert "ZZSECRETZZ" not in caplog.text
    assert "RuntimeError" in caplog.text


def test_a_provider_refusal_rises_as_it_is() -> None:
    def provide(form_key: str, context: SubmissionContext) -> Mapping[str, Any]:
        raise HookRefusedError.forbidden("access.denied", "no session")

    with started(host_context=provide) as rig, pytest.raises(HookRefusedError):
        call(rig.service, "validate")


def test_the_dry_run_report_is_unchanged_by_a_context() -> None:
    with started(host_context=provider_of(ROLE)) as rig:
        outcome = call(rig.service, "test")
    assert isinstance(outcome, DryRun)
    assert outcome.accepted is True


# -- the PDF is drawn with the same context ----------------------------------------------------------------------------
NO_SEAL = {"pdf": {"seal": {"enabled": False}}}


def document_request(rig: Any) -> dict[str, Any]:
    found = [c.request for c in rig.runtime.calls if c.op in {"document", "fill"}]
    assert found, rig.runtime.ops()
    return found[0]  # type: ignore[no-any-return]


def test_a_posted_print_is_judged_and_drawn_with_the_providers_context() -> None:
    with started_pdf(NO_SEAL, form=pdf_definition(template_layout("t1")), host_context=provider_of(ROLE)) as rig:
        assert isinstance(rig.render(), Printed)
        assert rig.sandbox.validations[-1][0]["hostContext"] == {"role": "admin"}
        assert document_request(rig)["hostContext"] == {"role": "admin"}


def test_an_empty_context_is_still_sent_to_the_pdf_program() -> None:
    with started_pdf(NO_SEAL, host_context=provider_of({})) as rig:
        assert isinstance(rig.render(), Printed)
        assert document_request(rig)["hostContext"] == {}


def test_without_a_context_the_pdf_request_has_none() -> None:
    with started_pdf(NO_SEAL) as rig:
        assert isinstance(rig.render(), Printed)
        assert "hostContext" not in document_request(rig)


def test_a_customizer_sees_the_providers_context_on_the_draft_and_may_add_to_it() -> None:
    seen: list[dict[str, Any]] = []

    def customize(draft: Any) -> None:
        seen.append(dict(draft.host_context))
        draft.host_context["tenant"] = "acme"

    with started_pdf(NO_SEAL, host_context=provider_of(ROLE), pdf_request_customizers=[customize]) as rig:
        assert isinstance(rig.render(), Printed)
        assert document_request(rig)["hostContext"] == {"role": "admin", "tenant": "acme"}
    assert seen == [{"role": "admin"}]


def test_a_submissions_print_is_drawn_with_the_context_it_was_accepted_with() -> None:
    with started_pdf(NO_SEAL, host_context=provider_of(ROLE)) as rig:
        accepted = rig.datum.submission_service.submit(FormRef.from_document(), envelope(), bus())
        assert isinstance(accepted, Accepted)
        rig.runtime.calls.clear()
        assert isinstance(rig.render_submission(accepted.submission), Printed)
        assert document_request(rig)["hostContext"] == {"role": "admin"}
