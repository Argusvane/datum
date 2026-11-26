"""A delivery is one submission by its submit attempt's key, not by its answers.

The browser mints a `submission_key` once per submit attempt and sends it again on a retry: the same key and digest
is answered with the first receipt; two people who give the same answers send two keys and are two records; a known
key with another document is refused (`KeyConflict`, 409 `submission.keyConflict`); a delivery without a key is
`Malformed` before anything runs.
"""

import pytest
from submissions_support import bus, envelope, http_context, refused_by_kernel, started

from datum_core.canonical import canonical_digest
from datum_core.submissions import Accepted, KeyConflict, Malformed, Redelivered, SubmissionContext


def test_two_attempts_with_the_same_answers_are_two_records() -> None:
    with started() as rig:
        first = rig.submit(envelope(), bus())
        other = rig.submit(envelope(), http_context())
    assert isinstance(first, Accepted)
    assert isinstance(other, Accepted)
    assert first.receipt != other.receipt
    assert len(rig.handler.calls) == 2


def test_a_known_key_with_another_document_is_a_conflict_and_never_the_first_receipt() -> None:
    other = envelope(values={"name": "Grace Hopper"})
    with started() as rig:
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        conflict = rig.submit(other, http_context(submission_key="attempt-1"))
        again = rig.submit(envelope(), http_context(submission_key="attempt-1"))
    assert isinstance(first, Accepted)
    assert conflict == KeyConflict(canonical_digest(other))
    assert isinstance(again, Redelivered)
    assert again.receipt == first.receipt
    assert len(rig.handler.calls) == 1


def test_a_known_key_with_another_document_that_fails_a_rule_is_the_conflict_and_costs_no_run() -> None:
    failing = envelope(values={"name": ""})
    with started() as rig:
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        rig.sandbox.verdict = refused_by_kernel()
        rig.trail.clear()
        conflict = rig.submit(failing, http_context(submission_key="attempt-1"))
        trail = list(rig.trail)
    assert isinstance(first, Accepted)
    assert conflict == KeyConflict(canonical_digest(failing))
    assert "sandbox" not in trail
    assert not [name for name in trail if name.startswith("event:SubmissionRejected")]


def test_a_retry_is_answered_with_the_first_receipt_before_the_sandbox_runs() -> None:
    with started() as rig:
        first = rig.submit(envelope(), bus(submission_key="attempt-1"))
        rig.sandbox.verdict = refused_by_kernel()  # a run now would refuse it: the retry is never judged again
        rig.trail.clear()
        again = rig.submit(envelope(), http_context(submission_key="attempt-1"))
        trail = list(rig.trail)
    assert isinstance(first, Accepted)
    assert again == Redelivered(first.receipt, canonical_digest(envelope()))
    assert "sandbox" not in trail
    assert len(rig.handler.calls) == 1


def test_the_handler_is_handed_the_attempts_key_so_it_can_be_idempotent_on_it() -> None:
    with started() as rig:
        rig.submit(envelope(), bus(submission_key="attempt-1"))
        rig.submit(envelope(), http_context(submission_key="attempt-2"))
    assert [call.submission_key for call in rig.handler.calls] == ["attempt-1", "attempt-2"]


def test_a_delivery_without_a_key_is_malformed_before_anything_runs_and_a_check_needs_none() -> None:
    with started() as rig:
        outcome = rig.submit(envelope(), SubmissionContext(channel="bus"))
        trail = list(rig.trail)
    assert isinstance(outcome, Malformed)
    assert rig.handler.calls == []
    assert "sandbox" not in trail


@pytest.mark.parametrize("key", ["", " lead", "has space", "x" * 129, "line\nbreak"])
def test_a_key_outside_the_rule_is_refused_by_the_context(key: str) -> None:
    with pytest.raises(ValueError, match="submission key"):
        SubmissionContext(channel="bus", submission_key=key)
    assert SubmissionContext(channel="bus", submission_key="k" * 128).submission_key == "k" * 128
