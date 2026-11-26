"""The spans `datum.submission` and `datum.sandbox.run`, their attributes and their parents."""

from typing import Any

import pytest
from observe_support import Telemetry, attribute_text, attrs, telemetry
from opentelemetry import trace
from submissions_support import (
    FORM,
    NAME,
    Repository,
    bus,
    definition,
    envelope,
    http_context,
    refused_by_kernel,
    started,
)

from datum_core.canonical import canonical_digest
from datum_core.datum import core_version
from datum_core.submissions import FormRef, Reject
from datum_sandbox.protocol import ProgramUnavailableError


@pytest.fixture
def otel() -> Telemetry:
    return telemetry()


def only(otel: Telemetry, name: str) -> Any:
    (found,) = otel.spans(name)
    return found


def test_a_submission_makes_one_datum_submission_span_with_the_sandbox_run_below_it(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit(envelope(), bus())
    submission, run = only(otel, "datum.submission"), only(otel, "datum.sandbox.run")
    assert run.context.trace_id == submission.context.trace_id
    parent = otel.parent_of(run)
    assert parent is not None
    assert parent.context.span_id == submission.context.span_id


def test_the_tracer_is_named_datum_and_carries_the_core_version(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit()
    scope = only(otel, "datum.submission").instrumentation_scope
    assert scope is not None
    assert (scope.name, scope.version) == ("datum", core_version())


def test_the_submission_span_attributes_for_an_accepted_document(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit(envelope(), http_context())
    attributes = dict(only(otel, "datum.submission").attributes or {})
    assert attributes["datum.mode"] == "submit"
    assert attributes["datum.channel"] == "http"
    assert attributes["datum.outcome"] == "accepted"
    assert attributes["datum.form"] == FORM


@pytest.mark.parametrize(("method", "mode"), [("validate", "validate"), ("test", "test")])
def test_the_mode_names_the_service_call(otel: Telemetry, method: str, mode: str) -> None:
    with started() as rig:
        getattr(rig.service, method)(FormRef.from_document(), envelope(), bus())
    assert attrs(only(otel, "datum.submission"))["datum.mode"] == mode


def test_a_rejected_submission_is_a_normal_outcome_with_the_stage_and_an_unset_status(otel: Telemetry) -> None:
    with started() as rig:
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": ""}))
    span = only(otel, "datum.submission")
    assert span.attributes["datum.outcome"] == "rejected"
    assert span.attributes["datum.stage"] == "sandbox"
    assert span.status.status_code == trace.StatusCode.UNSET


@pytest.mark.parametrize(
    "document",
    [
        pytest.param(envelope(form="missing"), id="form not found"),
        pytest.param(["not", "an", "object"], id="malformed"),
    ],
)
def test_datum_form_is_set_only_once_the_form_was_found(otel: Telemetry, document: Any) -> None:
    with started() as rig:
        rig.submit(document)
    assert "datum.form" not in attrs(only(otel, "datum.submission"))


def test_datum_form_is_set_for_a_form_that_exists_even_when_the_document_is_stale(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit(envelope(version="0"))
    assert attrs(only(otel, "datum.submission"))["datum.form"] == FORM


def test_a_refusal_is_not_an_error_span(otel: Telemetry) -> None:
    with started(pre_checks=[lambda incoming: Reject("closed", "Closed")]) as rig:
        rig.submit()
    span = only(otel, "datum.submission")
    assert span.status.status_code == trace.StatusCode.UNSET
    assert "error.type" not in attrs(span)


def test_an_infrastructure_failure_sets_the_error_status_and_the_error_type(otel: Telemetry) -> None:
    with started() as rig:
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit()
    span = only(otel, "datum.submission")
    assert span.status.status_code == trace.StatusCode.ERROR
    assert attrs(span)["error.type"] == "ProgramUnavailableError"


def test_a_handler_that_raises_marks_the_span_and_the_error_still_reaches_the_caller(otel: Telemetry) -> None:
    with started() as rig:
        rig.handler.fail = RuntimeError("queue down")
        with pytest.raises(RuntimeError, match="queue down"):
            rig.submit()
    span = only(otel, "datum.submission")
    assert span.status.status_code == trace.StatusCode.ERROR
    assert attrs(span)["error.type"] == "RuntimeError"


def test_the_sandbox_run_span_names_the_op_the_outcome_and_the_engine_mode(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit()
        rig.service.inspect("abi", definition(), http_context())
    ops = {attrs(s)["datum.op"]: s for s in otel.spans("datum.sandbox.run")}
    assert {"validate", "inspect"} <= set(ops)
    for run in ops.values():
        assert "datum.outcome" in attrs(run)
        assert "datum.engine.mode" in attrs(run)


def test_a_failing_run_marks_the_run_span_with_the_error_type(otel: Telemetry) -> None:
    with started() as rig:
        rig.sandbox.error = ProgramUnavailableError("down")
        rig.submit()
    run = only(otel, "datum.sandbox.run")
    assert run.status.status_code == trace.StatusCode.ERROR
    assert attrs(run)["error.type"] == "ProgramUnavailableError"


def test_every_attribute_key_is_datum_prefixed_except_error_type(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit()
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": ""}))
    for span in otel.spans():
        if span.name.startswith("datum."):
            assert all(key.startswith("datum.") or key == "error.type" for key in span.attributes or {}), span.name


def test_no_attribute_carries_an_answer_the_bytes_a_digest_or_a_secret(otel: Telemetry) -> None:
    document = envelope(extra={"note": "ZZSECRETZZ-note"})
    with started() as rig:
        rig.submit(document, http_context(ip="198.51.100.77", principal="alice@example.org"))
        rig.sandbox.verdict = refused_by_kernel()
        rig.submit(envelope(values={"name": "Grace Hopper"}), bus())
    digest = canonical_digest(document)
    for span in otel.spans():
        text = attribute_text(span)
        for forbidden in (NAME, "Grace Hopper", "ZZSECRETZZ", digest, "198.51.100.77", "alice"):
            assert forbidden not in text, (span.name, forbidden)


def test_a_repeat_of_the_same_document_is_one_more_span_with_no_new_form_data(otel: Telemetry) -> None:
    with started() as rig:
        rig.submit(envelope(), bus(submission_key="attempt-1"))
        rig.submit(envelope(), bus(submission_key="attempt-1"))
    assert len(otel.spans("datum.submission")) == 2
    outcomes = [attrs(s)["datum.outcome"] for s in otel.spans("datum.submission")]
    assert outcomes == ["accepted", "redelivered"]


def test_a_submission_opens_exactly_the_two_datum_spans_and_none_for_its_store_or_hook_calls(otel: Telemetry) -> None:
    with started(form_repository=Repository([], definition(), definition("claims"))) as rig:
        rig.submit(envelope(form="claims"))
    assert [s.name for s in otel.spans() if s.name.startswith("datum.")] == ["datum.sandbox.run", "datum.submission"]


def test_a_busy_refusal_is_not_an_error_span(otel: Telemetry) -> None:
    from datum_sandbox.wasi import EngineBusyError  # noqa: PLC0415

    with started() as rig:
        rig.sandbox.error = EngineBusyError("slots")
        rig.submit(envelope(), bus())
    submission, run = only(otel, "datum.submission"), only(otel, "datum.sandbox.run")
    assert submission.status.status_code == trace.StatusCode.UNSET
    assert "error.type" not in attrs(submission)
    assert attrs(submission)["datum.outcome"] == "unavailable"
    assert run.status.status_code == trace.StatusCode.UNSET
    assert "error.type" not in attrs(run)
    assert attrs(run)["datum.outcome"] == "busy"


def test_a_full_stray_bound_is_an_error_span_never_a_busy_one(otel: Telemetry) -> None:
    from datum_sandbox.protocol import StrayBoundError  # noqa: PLC0415

    before = otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
    with started() as rig:
        rig.sandbox.error = StrayBoundError("runs that would not stop")
        rig.submit(envelope(), bus())
    submission, run = only(otel, "datum.submission"), only(otel, "datum.sandbox.run")
    assert submission.status.status_code == trace.StatusCode.ERROR
    assert attrs(submission)["error.type"] == "StrayBoundError"
    assert attrs(run)["datum.outcome"] == "failed"
    assert run.status.status_code == trace.StatusCode.ERROR
    assert attrs(run)["error.type"] == "StrayBoundError"
    assert otel.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == before
