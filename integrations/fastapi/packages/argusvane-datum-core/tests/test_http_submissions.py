"""`SubmissionOutcome` to the route answer, once in `datum_core.http`, held to the shared catalog."""

import json
import logging
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

import pytest

from datum_core.config.models import ThrottleKind
from datum_core.hooks import HookProblem
from datum_core.http import HttpAnswer, inspect_answer, submission_answer
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
    Rejected,
    SubmissionOutcome,
    SubmissionReceipt,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_core.throttle import ThrottleKey
from datum_sandbox.protocol import ProgramUnavailableError
from datum_sandbox.wasi import EngineBusyError

if TYPE_CHECKING:
    from datum_sandbox.json import JsonValue

CATALOG_PATH = Path(__file__).resolve().parents[4] / "shared" / "endpoint-catalog.json"
SUBMISSION_OPERATIONS = ("submitSubmission", "validateSubmission", "testSubmission")
DIGEST = "d" * 64
RECEIPT = SubmissionReceipt(id="id-1", reference="REF-1")
ERRORS = (("name", "required", None), (None, "form.invalid", "Fix the form"))


def accepted_submission(warnings: tuple[Any, ...] = ()) -> AcceptedSubmission:
    return AcceptedSubmission(
        form_key="contact",
        digest=DIGEST,
        values={"name": "Ada"},
        warnings=warnings,
        channel="http",
        remote_address=None,
        user_agent=None,
    )


def answer(outcome: SubmissionOutcome, **options: Any) -> HttpAnswer:
    options.setdefault("retry_after", 5)
    reply: HttpAnswer = submission_answer(outcome, **options)
    return reply


def body(reply: HttpAnswer) -> Any:
    return json.loads(reply.body)


def codes(reply: HttpAnswer) -> list[str]:
    return [item["code"] for item in body(reply)["errors"]]


# -- success rows ------------------------------------------------------------------------------------------------------
def test_accepted_is_200_with_the_receipt_the_digest_and_handled_false() -> None:
    reply = answer(Accepted(RECEIPT, accepted_submission(), ()))
    assert reply.status == 200
    assert reply.headers["Content-Type"].startswith("application/json")
    assert body(reply) == {
        "id": "id-1",
        "reference": "REF-1",
        "status": "accepted",
        "digest": DIGEST,
        "handled": False,
    }


def test_accepted_adds_the_handlers_receipt_data_and_the_warnings_only_when_there_are_some() -> None:
    receipt = SubmissionReceipt(id="id-1", reference="REF-1", receipt={"queue": "q1"})
    warning = HookProblem("name", "name.short", "Short")
    reply = answer(Accepted(receipt, accepted_submission((warning,)), (warning,)))
    document = body(reply)
    assert document["receipt"] == {"queue": "q1"}
    assert document["warnings"] == [{"field": "name", "code": "name.short", "message": "Short"}]


def test_redelivered_is_200_with_the_first_receipt_and_handled_true() -> None:
    document = body(answer(Redelivered(RECEIPT, DIGEST)))
    assert document["handled"] is True
    assert (document["id"], document["reference"], document["digest"]) == ("id-1", "REF-1", DIGEST)


def test_checked_is_200_with_accepted_and_the_errors() -> None:
    reply = answer(Checked(accepted=False, errors=ERRORS, journey_id="main", page_id="p1"))
    assert reply.status == 200
    document = body(reply)
    assert document["accepted"] is False
    assert document["errors"] == [
        {"field": "name", "code": "required"},
        {"code": "form.invalid", "message": "Fix the form"},
    ]


def test_dry_run_is_200_and_answers_the_report_as_it_is_flat() -> None:
    report: dict[str, JsonValue] = {
        "outcome": "accepted",
        "stage": None,
        "errors": [],
        "visibilitySkipped": ["admin_note"],
    }
    reply = answer(DryRun(accepted=True, stage=None, errors=(), values={"name": "Ada"}, report=report))
    assert reply.status == 200
    document = body(reply)
    assert document == report
    assert list(document) == list(report)
    assert "accepted" not in document
    assert "report" not in document


# -- refusal rows ------------------------------------------------------------------------------------------------------
def test_rejected_is_422_with_the_kernels_errors_in_order() -> None:
    reply = answer(Rejected(errors=ERRORS, stage="sandbox"))
    assert reply.status == 422
    assert body(reply)["errors"] == [
        {"field": "name", "code": "required"},
        {"code": "form.invalid", "message": "Fix the form"},
    ]


def test_outdated_is_409_form_outdated_with_no_hash_and_no_etag() -> None:
    reply = answer(Outdated(current_version="2", current_sha256="a" * 64))
    assert (reply.status, codes(reply)) == (409, ["form.outdated"])
    assert "a" * 64 not in reply.body.decode()
    assert "ETag" not in reply.headers


def test_a_key_conflict_is_409_submission_key_conflict_and_never_the_first_receipt() -> None:
    reply = answer(KeyConflict("a" * 64))
    assert (reply.status, codes(reply)) == (409, ["submission.keyConflict"])
    assert "a" * 64 not in reply.body.decode()


def test_not_found_is_404_form_not_found_and_never_echoes_the_key() -> None:
    reply = answer(NotFound(form_key="datum-tck-no-such-form"))
    assert (reply.status, codes(reply)) == (404, ["form.notFound"])
    assert "datum-tck-no-such-form" not in reply.body.decode()


def test_malformed_is_400_bad_document_without_the_reason_words() -> None:
    reply = answer(Malformed(reason="depth 65 at submission.values.name"))
    assert (reply.status, codes(reply)) == (400, ["bad_document"])
    assert "submission.values" not in reply.body.decode()


def test_too_large_is_413_bad_document() -> None:
    reply = answer(TooLarge(max_bytes=1048576))
    assert (reply.status, codes(reply)) == (413, ["bad_document"])


def test_throttled_is_429_flood_with_retry_after_in_whole_seconds() -> None:
    reply = answer(Throttled(retry_after=17, key=ThrottleKey(ip="203.0.113.7", kind=ThrottleKind.SUBMIT)))
    assert (reply.status, codes(reply)) == (429, ["flood"])
    assert reply.headers["Retry-After"] == "17"
    assert "203.0.113.7" not in reply.body.decode()


@pytest.mark.parametrize(
    ("code", "status", "retry"),
    [
        ("server.unavailable", 503, False),
        ("server.busy", 503, True),
        ("validator_unavailable", 503, False),
        ("data_source.unavailable", 503, False),
        ("wasm.execution_error", 503, False),
        ("outcome_too_large", 503, False),
        ("definition.tooDeep", 503, False),
    ],
)
def test_unavailable_answers_its_own_code_and_status_and_retry_after_only_where_a_retry_can_help(
    code: str, status: int, retry: bool
) -> None:
    reply = answer(
        Unavailable(code=code, reason="the words", cause=ProgramUnavailableError("secret path /srv/x")), retry_after=9
    )
    assert (reply.status, codes(reply)) == (status, [code])
    assert reply.headers.get("Retry-After") == ("9" if retry else None)
    assert "secret path" not in reply.body.decode()


@pytest.mark.parametrize("problem_details", [False, True])
@pytest.mark.parametrize("code", ["wasm.execution_error", "outcome_too_large", "definition.tooDeep"])
def test_a_failed_run_is_503_with_the_runs_code_and_no_retry_after_in_both_formats(
    code: str, *, problem_details: bool
) -> None:
    # A run that gave no verdict is no verdict on receive, validate and test alike (never a 422
    # that reads as one, never a 500); retrying a deterministic failure helps nobody, so no Retry-After.
    reply = answer(Unavailable(code=code, reason="the words", cause=None), problem_details=problem_details)
    assert (reply.status, reply.headers.get("Retry-After")) == (503, None)
    document = body(reply)
    assert (document["code"] if problem_details else codes(reply)) == (code if problem_details else [code])
    if problem_details:
        assert document["status"] == 503
        assert reply.headers["Content-Type"].startswith("application/problem+json")


@pytest.mark.parametrize("code", ["wasm.execution_error", "outcome_too_large", "definition.tooDeep"])
def test_an_inspect_run_failure_is_503_with_the_runs_code_and_no_retry_after(code: str) -> None:
    reply = inspect_answer(Unavailable(code=code, reason="r", cause=None), retry_after=5)
    if code == "definition.tooDeep":  # the posted definition is the caller's own, refused before any run
        assert (reply.status, codes(reply), reply.headers.get("Retry-After")) == (422, [code], None)
    else:
        assert (reply.status, codes(reply), reply.headers.get("Retry-After")) == (503, [code], None)


def test_a_busy_sandbox_is_503_with_retry_after() -> None:
    reply = answer(Unavailable(code="server.busy", reason="r", cause=None))
    assert (reply.status, codes(reply), reply.headers["Retry-After"]) == (503, ["server.busy"], "5")


@pytest.mark.parametrize("code", ["server.unavailable", "validator_unavailable", "data_source.unavailable"])
def test_an_unavailable_sandbox_is_503_with_no_retry_after(code: str) -> None:
    reply = answer(Unavailable(code=code, reason="r", cause=None))
    assert (reply.status, codes(reply), reply.headers.get("Retry-After")) == (503, [code], None)


def test_a_check_answer_holds_notes_only_when_there_are_some_and_never_an_empty_list() -> None:
    plain = body(answer(Checked(True, (), None, None)))
    assert plain == {"accepted": True, "errors": []}
    noted = body(
        answer(
            Checked(
                True,
                (),
                None,
                None,
                (("name", "soft", "warning", None), (None, "heads_up", "info", "Check the date")),
            )
        )
    )
    assert noted["notes"] == [
        {"field": "name", "code": "soft", "severity": "warning"},
        {"code": "heads_up", "severity": "info", "message": "Check the date"},
    ]
    refused = body(answer(Checked(False, ((None, "journey.required", None),), None, None)))
    assert refused == {"accepted": False, "errors": [{"code": "journey.required"}]}


@pytest.mark.parametrize("problem_details", [False, True])
@pytest.mark.parametrize("code", ["server.unavailable", "server.busy", "validator_unavailable", "wasm.execution_error"])
def test_an_unavailable_answer_carries_no_reason(code: str, *, problem_details: bool) -> None:
    reply = answer(Unavailable(code=code, reason="the words", cause=None), problem_details=problem_details)
    assert "the words" not in reply.body.decode()


def test_an_unavailable_with_a_code_outside_the_catalog_is_the_500_internal() -> None:
    reply = answer(Unavailable(code="access.denied", reason="r"))
    assert (reply.status, codes(reply)) == (500, ["internal"])


def test_the_reprs_of_the_outcomes_hold_no_cause_words_no_form_key_and_no_hash() -> None:
    outcomes: list[SubmissionOutcome] = [
        Unavailable("server.unavailable", "r", RuntimeError("password=ZZSECRETZZ")),
        NotFound("evil\nINJECTED"),
        Outdated("2", "a" * 64),
    ]
    for outcome in outcomes:
        for text in (repr(outcome), str(outcome)):
            assert "ZZSECRETZZ" not in text
            assert "INJECTED" not in text
            assert "a" * 64 not in text


def test_busy_uses_the_configured_busy_retry_after() -> None:
    reply = answer(Unavailable(code="server.busy", reason="slots", cause=EngineBusyError("slots")), retry_after=5)
    assert reply.headers["Retry-After"] == "5"


# -- refused by a pre-check --------------------------------------------------------------------------------------------
def refused(code: str) -> Refused:
    return Refused(Reject(code, "Words for a person"))


def test_a_pre_check_refusal_keeps_its_code_and_words_and_is_403_by_default() -> None:
    reply = answer(refused("quota.exceeded"))
    assert (reply.status, codes(reply)) == (403, ["quota.exceeded"])
    assert body(reply)["errors"][0]["message"] == "Words for a person"
    assert codes(answer(refused("access.denied"))) == ["access.denied"]


@pytest.mark.parametrize(("code", "status"), [("field.invalid", 422), ("backend.unavailable", 503), ("other", 403)])
def test_by_suffix_maps_invalid_to_422_and_unavailable_to_503(code: str, status: int) -> None:
    reply = answer(refused(code), pre_check_statuses=PreCheckStatuses.by_suffix())
    assert reply.status == status
    assert codes(reply) == [code]


def test_a_503_from_a_pre_check_carries_no_retry_after() -> None:
    reply = answer(refused("backend.unavailable"), pre_check_statuses=PreCheckStatuses.by_suffix(), retry_after=7)
    assert (reply.status, "Retry-After" in reply.headers) == (503, False)


def test_an_application_mapping_may_answer_429_without_retry_after() -> None:
    reply = answer(refused("slow.down"), pre_check_statuses=lambda reject: 429)  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
    assert reply.status == 429
    assert codes(reply) == ["slow.down"]
    assert "Retry-After" not in reply.headers


def raising(reject: Reject) -> int:
    raise RuntimeError("the mapping is broken")


@pytest.mark.parametrize(
    "mapping",
    [raising, lambda reject: 399, lambda reject: 600, lambda reject: 0, lambda reject: "403"],  # pyright: ignore[reportUnknownLambdaType, reportUnknownMemberType, reportUnknownArgumentType]
)
def test_a_mapping_that_raises_or_answers_outside_400_to_599_is_a_500_internal(
    mapping: Any, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="datum"):
        reply = answer(refused("quota.exceeded"), pre_check_statuses=mapping, correlation_id="cid-77")
    assert (reply.status, codes(reply)) == (500, ["internal"])
    assert "quota.exceeded" not in reply.body.decode()
    (record,) = [r for r in caplog.records if r.levelno == logging.ERROR]
    assert record.__dict__["datum_correlation_id"] == "cid-77"
    assert "quota.exceeded" not in record.getMessage()
    assert "Words for a person" not in record.getMessage()


# -- the modes and the catalog -----------------------------------------------------------------------------------------
def test_problem_details_mode_answers_application_problem_json_with_the_same_status_and_code() -> None:
    reply = answer(NotFound(form_key="x"), problem_details=True, correlation_id="abc-123")
    document = body(reply)
    assert reply.status == 404
    assert reply.headers["Content-Type"] == "application/problem+json"
    assert (document["status"], document["code"]) == (404, "form.notFound")
    assert document["correlationId"] == "abc-123"


def samples() -> list[SubmissionOutcome]:
    return [
        Accepted(RECEIPT, accepted_submission(), ()),
        Redelivered(RECEIPT, DIGEST),
        Checked(accepted=True, errors=(), journey_id=None, page_id=None),
        DryRun(accepted=True, stage=None, errors=(), values={}, report={}),
        KeyConflict(DIGEST),
        Rejected(errors=ERRORS, stage="sandbox"),
        Outdated("2", "a" * 64),
        NotFound("x"),
        Malformed("m"),
        TooLarge(10),
        refused("quota.exceeded"),
        Throttled(3, ThrottleKey()),
        *(
            Unavailable(code=code, reason="r", cause=None)
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


def catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def allowed_pairs() -> set[tuple[int, str]]:
    """Every (status, code) a submission route may answer: its own rows plus the catalog's default responses."""
    document = catalog()
    found: set[tuple[int, str]] = set()
    for endpoint in document["endpoints"]:
        if endpoint["operationId"] in SUBMISSION_OPERATIONS:
            found |= {(item["status"], code) for item in endpoint["statuses"] for code in item["codes"]}
    components = {item["component"]: item for item in document["responses"]}
    for default in document["defaultResponses"]:
        found |= {(default["status"], code) for code in components[default["component"]]["codes"]}
    return found


def test_every_status_and_code_the_table_produces_is_one_the_catalog_gives_a_submission_route() -> None:
    allowed = allowed_pairs()
    for outcome in samples():
        if isinstance(outcome, Rejected | Refused):  # the kernel's and the pre-check's own codes are open
            continue
        reply = answer(outcome)
        if reply.status == 200:
            continue
        assert (reply.status, codes(reply)[0]) in allowed, (type(outcome).__name__, reply.status)


def test_every_code_the_catalog_lists_for_the_submission_routes_has_an_outcome_that_answers_it() -> None:
    produced = {(reply.status, c) for reply in map(answer, samples()) if reply.status != 200 for c in codes(reply)}
    produced |= {(500, "internal")} if answer(Unavailable("internal", "r")).status == 500 else set()
    wanted = {
        (item["status"], code)
        for endpoint in catalog()["endpoints"]
        if endpoint["operationId"] in SUBMISSION_OPERATIONS
        for item in endpoint["statuses"]
        for code in item["codes"]
        if code != "access.denied"  # the application's security answers it, not Datum
    } | {(400, "bad_document"), (413, "bad_document"), (429, "flood")}
    assert wanted <= produced, sorted(wanted - produced)


def test_the_retry_after_header_appears_exactly_on_the_429_and_on_server_busy() -> None:
    for outcome in samples():
        reply = answer(outcome)
        busy = isinstance(outcome, Unavailable) and outcome.code == "server.busy"  # the one 503 a retry can help
        wanted = reply.status == 429 or busy
        assert ("Retry-After" in reply.headers) == wanted, type(outcome).__name__


def test_a_success_never_carries_retry_after_or_an_etag() -> None:
    for outcome in samples()[:4]:
        reply = answer(outcome)
        assert reply.status == 200
        assert not {"Retry-After", "ETag"} & set(reply.headers)


def always(status: int) -> Callable[[Reject], int]:
    def mapping(reject: Reject) -> int:
        return status

    return mapping


def test_an_application_429_never_borrows_the_flood_rows_retry_after_even_for_the_code_flood() -> None:
    reply = answer(refused("flood"), pre_check_statuses=always(429))
    assert (reply.status, codes(reply)) == (429, ["flood"])
    assert "Retry-After" not in reply.headers


@pytest.mark.parametrize("status", [401, 418, 502])
def test_an_application_status_with_no_open_row_is_answered_outside_the_table_with_the_pre_checks_words(
    status: int,
) -> None:
    for problem in (False, True):
        reply = answer(refused("tenant.closed"), pre_check_statuses=always(status), problem_details=problem)
        assert reply.status == status
        assert not {"Retry-After", "ETag"} & set(reply.headers)
        assert body(reply)["errors"] == [{"code": "tenant.closed", "message": "Words for a person"}]
