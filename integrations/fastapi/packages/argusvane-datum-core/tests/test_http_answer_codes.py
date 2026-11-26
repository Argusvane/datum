"""Which codes an answer may carry, and the catalog held per operation."""

import json
import logging
from pathlib import Path
from typing import Any

import pytest

from datum_core.hooks import HookProblem, HookRefusedError, HookRefusedKind
from datum_core.http import ANSWER_ROWS, HttpAnswer, datum_error_answer, hook_refusal_answer, submission_answer
from datum_core.loggers import ROOT
from datum_core.submissions import (
    Accepted,
    AcceptedSubmission,
    Checked,
    DryRun,
    KeyConflict,
    Malformed,
    NotFound,
    Outdated,
    PreCheckStatuses,
    Redelivered,
    Refused,
    Reject,
    SubmissionOutcome,
    SubmissionReceipt,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_core.throttle import ThrottleKey
from datum_sandbox.protocol import DatumError, SandboxError, SandboxFailure, StrayBoundError
from datum_sandbox.wasi import EngineBusyError

CATALOG = json.loads((Path(__file__).resolve().parents[4] / "shared" / "endpoint-catalog.json").read_text("utf-8"))
DIGEST = "d" * 64
RECEIPT = SubmissionReceipt(id="id-1", reference="REF-1")


def codes(reply: HttpAnswer) -> list[str]:
    return [item["code"] for item in json.loads(reply.body)["errors"]]


# -- open rows take only what the catalog lists or a hook registered -----------------------------------------------
def error_with(status: int, code: str) -> DatumError:
    class LaterError(DatumError):
        pass

    LaterError.status = status
    LaterError.code = code
    return LaterError("secret words")


@pytest.mark.parametrize("status", [403, 409, 422, 503])
def test_a_datum_error_with_a_code_no_row_lists_is_the_500_internal_and_the_code_is_logged(
    status: int, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.ERROR, logger=ROOT):
        reply = datum_error_answer(error_with(status, "made.up"), retry_after=5, correlation_id="abc")
    assert (reply.status, codes(reply)) == (500, ["internal"])
    assert b"made.up" not in reply.body
    assert b"secret" not in reply.body
    assert any("made.up" in record.getMessage() for record in caplog.records)
    assert all("secret words" not in record.getMessage() for record in caplog.records)


def test_a_datum_error_with_a_listed_code_still_answers_its_row() -> None:
    reply = datum_error_answer(SandboxError(SandboxFailure.BUSY, "m"), retry_after=5)
    assert (reply.status, codes(reply), reply.headers["Retry-After"]) == (503, ["server.busy"], "5")
    assert datum_error_answer(EngineBusyError("slots"), retry_after=5).status == 503


@pytest.mark.parametrize("problem_details", [False, True])
def test_a_full_stray_bound_is_503_server_unavailable_in_its_own_words_and_no_retry_after(
    problem_details: bool,
) -> None:
    message = "The sandbox runtime is unavailable: runs that would not stop have not ended."
    reply = datum_error_answer(StrayBoundError(message), retry_after=5, problem_details=problem_details)
    assert (reply.status, codes(reply)) == (503, ["server.unavailable"])
    assert "Retry-After" not in reply.headers
    assert message.encode() in reply.body


@pytest.mark.parametrize("problem_details", [False, True])
def test_a_signing_refusal_is_the_500_signature_and_its_words_stay_off_the_wire(problem_details: bool) -> None:
    reply = datum_error_answer(error_with(500, "signature"), retry_after=5, problem_details=problem_details)
    assert (reply.status, codes(reply)) == (500, ["signature"])
    assert b"secret" not in reply.body
    assert "Retry-After" not in reply.headers


def test_an_unavailable_with_an_unlisted_code_is_the_500_internal_and_the_code_is_logged(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with caplog.at_level(logging.ERROR, logger=ROOT):
        reply = submission_answer(Unavailable("made.up", "r"), retry_after=5)
    assert (reply.status, codes(reply)) == (500, ["internal"])
    assert any("made.up" in record.getMessage() for record in caplog.records)


def test_a_hooks_own_codes_still_use_the_open_rows() -> None:
    for kind, status in (
        (HookRefusedKind.FORBIDDEN, 403),
        (HookRefusedKind.CONFLICT, 409),
        (HookRefusedKind.INVALID, 422),
    ):
        reply = hook_refusal_answer(HookRefusedError(kind, (HookProblem(None, "my.code", "Words"),)))
        assert (reply.status, codes(reply)) == (status, ["my.code"])


@pytest.mark.parametrize(
    ("code", "status"), [("quota.invalid", 422), ("quota.unavailable", 503), ("quota.closed", 403)]
)
def test_a_pre_check_code_registered_through_by_suffix_uses_the_open_row(code: str, status: int) -> None:
    reply = submission_answer(
        Refused(Reject(code, "Words")), retry_after=5, pre_check_statuses=PreCheckStatuses.by_suffix()
    )
    assert (reply.status, codes(reply)) == (status, [code])
    assert "Retry-After" not in reply.headers  # only server.busy carries it


# -- the catalog, per operation -----------------------------------------------------------------------------------
# The one documented deviation: a dry run's version check is never skipped, so a stale dry run answers 409
# `form.outdated`, a row the catalog's `testSubmission` lacks. The deviation goes when the catalog and the kit gain
# the row.
DEVIATIONS: dict[str, set[tuple[int, str]]] = {"testSubmission": {(409, "form.outdated")}}
# A failed run is 503 with the run's own code on all three routes (by design); the catalog lists the three
# codes on submit and validate, and the dry run's row gains them when the catalog does.
RUN_CODES = {(503, "wasm.execution_error"), (503, "outcome_too_large"), (503, "definition.tooDeep")}


def accepted_submission() -> AcceptedSubmission:
    return AcceptedSubmission(
        form_key="contact",
        digest=DIGEST,
        values={},
        warnings=(),
        channel="http",
        remote_address=None,
        user_agent=None,
    )


def outcomes_of(operation: str) -> list[SubmissionOutcome]:
    """What the service can answer for an operation; the kernel's own and the pre-check's codes are open."""
    common: list[SubmissionOutcome] = [
        Outdated("2", "a" * 64),
        NotFound("x"),
        Malformed("m"),
        TooLarge(10),
        Throttled(3, ThrottleKey()),
        *(
            Unavailable(code, "r")
            for code in (
                "server.unavailable",
                "server.busy",
                "validator_unavailable",
                "data_source.unavailable",
                "wasm.execution_error",
                "outcome_too_large",
                "definition.tooDeep",
            )
        ),
    ]
    own: dict[str, list[SubmissionOutcome]] = {
        "submitSubmission": [
            Accepted(RECEIPT, accepted_submission(), ()),
            Redelivered(RECEIPT, DIGEST),
            KeyConflict(DIGEST),
        ],
        "validateSubmission": [Checked(accepted=True, errors=(), journey_id=None, page_id=None)],
        "testSubmission": [DryRun(accepted=True, stage=None, errors=(), values={}, report={})],
    }
    return [*own[operation], *common]


def pairs_of(operation: str) -> set[tuple[int, str]]:
    found: set[tuple[int, str]] = set()
    for endpoint in CATALOG["endpoints"]:
        if endpoint["operationId"] == operation:
            found |= {(row["status"], code) for row in endpoint["statuses"] for code in row["codes"]}
    components = {item["component"]: item for item in CATALOG["responses"]}
    for default in CATALOG["defaultResponses"]:
        found |= {(default["status"], code) for code in components[default["component"]]["codes"]}
    return found | RUN_CODES | DEVIATIONS.get(operation, set())


@pytest.mark.parametrize("operation", ["submitSubmission", "validateSubmission", "testSubmission"])
def test_every_answer_of_an_operation_is_a_row_the_catalog_gives_that_operation(operation: str) -> None:
    allowed = pairs_of(operation)
    for outcome in outcomes_of(operation):
        reply = submission_answer(outcome, retry_after=5)
        if reply.status == 200:
            continue
        assert (reply.status, codes(reply)[0]) in allowed, (operation, type(outcome).__name__, reply.status)


def test_the_one_deviation_is_the_dry_runs_409_and_nothing_else() -> None:
    assert {"testSubmission": {(409, "form.outdated")}} == DEVIATIONS
    listed = {
        (row["status"], code)
        for endpoint in CATALOG["endpoints"]
        if endpoint["operationId"] == "testSubmission"
        for row in endpoint["statuses"]
        for code in row["codes"]
    }
    assert (409, "form.outdated") not in listed
    assert any(row.status == 409 and "form.outdated" in row.codes for row in ANSWER_ROWS)


def test_every_listed_row_of_an_operation_is_answered_by_one_of_its_outcomes() -> None:
    for operation in ("submitSubmission", "validateSubmission", "testSubmission"):
        produced: set[tuple[int, str]] = set()
        for outcome in outcomes_of(operation):
            reply = submission_answer(outcome, retry_after=5)
            if reply.status != 200:
                produced.add((reply.status, codes(reply)[0]))
        wanted: Any = {
            (row["status"], code)
            for endpoint in CATALOG["endpoints"]
            if endpoint["operationId"] == operation
            for row in endpoint["statuses"]
            for code in row["codes"]
            if code != "access.denied"
        }
        assert wanted <= produced, (operation, sorted(wanted - produced))
