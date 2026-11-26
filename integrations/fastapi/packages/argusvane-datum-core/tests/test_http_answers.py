"""The error and answer mapping is one table in datum_core.http, held to the shared endpoint catalog."""

import json
from pathlib import Path
from typing import Any

import pytest

from datum_core.forms.outcomes import DataSourceNotFound, DataSourceUnavailable, NotFound, TooDeep, Unavailable
from datum_core.hooks import HookProblem, HookRefusedError
from datum_core.http import (
    ANSWER_ROWS,
    DEFAULT_RESPONSE_DESCRIPTION,
    AnswerRow,
    HttpAnswer,
    bad_request_answer,
    datum_error_answer,
    error_answer,
    error_envelope_schema,
    errors_answer,
    hook_refusal_answer,
    internal_answer,
    outcome_answer,
)
from datum_sandbox.protocol._errors import (
    DatumError,
    DefinitionTooCostlyError,
    DefinitionTooDeepError,
    ProgramUnavailableError,
    SandboxError,
    SandboxFailure,
)
from datum_sandbox.wasi import EngineBusyError

CATALOG_PATH = Path(__file__).resolve().parents[4] / "shared" / "endpoint-catalog.json"

# Answer rows whose codes the catalog does not repeat (kernel verdicts and typed refusals not from a route).
NOT_IN_CATALOG = frozenset(
    {
        (422, "definition.tooDeep"),
        (422, "definition.tooCostly"),
        (503, "pdf_unavailable"),
        (503, "keys_unavailable"),
        # A seal not made: the seal's own refusals and the PDF program's `signature` word. The catalog's 500 response
        # lists `internal` only.
        (500, "signature"),
    }
)


def no_retry_after(pair: tuple[int, str]) -> bool:
    """A 503 other than `server.busy`: it carries no Retry-After (a retry helps nobody, or nobody knows when).

    The catalog lists headers per status, so these codes share the 503 entry with `server.busy`, which carries it.
    """
    return pair[0] == 503 and pair[1] != "server.busy"


def catalog() -> dict[str, Any]:
    return json.loads(CATALOG_PATH.read_text(encoding="utf-8"))  # type: ignore[no-any-return]


def catalog_pairs() -> dict[tuple[int, str], set[str]]:
    """Every (status, code) the catalog names, with the headers listed for it."""
    found: dict[tuple[int, str], set[str]] = {}
    document = catalog()
    for endpoint in document["endpoints"]:
        for item in endpoint["statuses"]:
            for code in item["codes"]:
                found.setdefault((item["status"], code), set()).update(item["headers"])
    for component in document["responses"]:
        for code in component["codes"]:
            headers = {"Retry-After"} if component["retryAfter"] else set()
            found.setdefault((component["status"], code), set()).update(headers)
    return found


def table_pairs() -> dict[tuple[int, str], AnswerRow]:
    return {(row.status, code): row for row in ANSWER_ROWS for code in row.codes}


def body(answer: HttpAnswer) -> Any:
    return json.loads(answer.body)


def test_every_status_and_code_the_catalog_names_has_a_row() -> None:
    # The passkey ceremony's refusals have no row yet; every other status and code has one.
    later = {pair for pair in catalog_pairs() if pair[1].startswith(("passkey.", "signing."))}
    missing = sorted(set(catalog_pairs()) - set(table_pairs()) - later)
    assert missing == []


def test_no_row_names_a_code_the_catalog_lacks_unless_the_table_lists_it_as_an_extra() -> None:
    extra = sorted(set(table_pairs()) - set(catalog_pairs()) - NOT_IN_CATALOG)
    assert extra == []


def test_the_headers_of_a_row_and_the_catalog_agree_in_both_directions() -> None:
    wrong = []
    for pair, listed in catalog_pairs().items():
        row = table_pairs().get(pair)
        if row is None:
            continue
        carried = set(row.headers)
        # The builder-only ETag of a 409 is added by the builder routes, so it is exempt in both directions.
        needed = listed - ({"ETag"} if pair == (409, "form.outdated") else set())
        if no_retry_after(pair):
            needed = set()
        allowed = listed | {"Content-Type", "ETag"} if pair == (409, "form.outdated") else listed | {"Content-Type"}
        if not needed <= carried or not carried <= allowed:
            wrong.append((pair, sorted(listed), sorted(carried)))
    assert wrong == []


def test_the_304_row_carries_etag_and_cache_control_and_no_code() -> None:
    rows = [row for row in ANSWER_ROWS if row.status == 304]
    assert len(rows) == 1
    assert rows[0].codes == ()
    assert set(rows[0].headers) == {"ETag", "Cache-Control"}


def test_a_row_carries_retry_after_exactly_when_the_catalog_lists_it_for_one_of_its_codes() -> None:
    wrong = []
    for row in ANSWER_ROWS:
        for code in row.codes:
            listed = "Retry-After" in catalog_pairs().get((row.status, code), set())
            exempt = no_retry_after((row.status, code)) and "Retry-After" not in row.headers
            if listed != ("Retry-After" in row.headers) and (row.status, code) in catalog_pairs() and not exempt:
                wrong.append((row.status, code))
    assert wrong == []
    for status in (429, 503):
        rows = [row for row in ANSWER_ROWS if row.status == status]
        assert rows
        # a 503 carries Retry-After for `server.busy` alone; every other 503 code is in a row with no header
        assert all(
            ("Retry-After" in row.headers) == (row.codes == ("server.busy",))
            for row in rows
            if status == 503 and not row.open_codes
        )
        assert all("Retry-After" in row.headers for row in rows if status == 429)


def test_405_and_406_and_unmatched_paths_have_no_row() -> None:
    assert not [row for row in ANSWER_ROWS if row.status in {405, 406}]
    assert not [row for row in ANSWER_ROWS if "method_not_allowed" in row.codes or "not_acceptable" in row.codes]


def test_the_default_error_body_is_the_errors_array_in_compact_json_with_a_fixed_key_order() -> None:
    answer = error_answer(404, "form.notFound")
    assert answer.status == 404
    assert answer.headers["Content-Type"] == "application/json"
    assert answer.body == b'{"errors":[{"code":"form.notFound"}]}'
    with_field = error_answer(400, "bad_request", field="public", message="public must be true or false")
    assert with_field.body == (
        b'{"errors":[{"field":"public","code":"bad_request","message":"public must be true or false"}]}'
    )
    schemas = {item["name"]: item for item in catalog()["schemas"]}
    order = [prop["name"] for prop in schemas["ErrorItem"]["properties"]]
    assert list(body(with_field)["errors"][0]) == [name for name in order if name in {"field", "code", "message"}]


def test_a_503_and_a_429_state_retry_after_in_whole_seconds_and_a_row_that_needs_it_refuses_without_it() -> None:
    busy = error_answer(503, "server.busy", retry_after=5)
    assert busy.headers["Retry-After"] == "5"
    assert error_answer(429, "flood", retry_after=60).headers["Retry-After"] == "60"
    with pytest.raises(ValueError, match="Retry-After"):
        error_answer(503, "server.busy")
    with pytest.raises(ValueError, match="does not carry"):
        error_answer(503, "server.unavailable", retry_after=5)


def test_a_pair_outside_the_table_is_refused_and_a_hook_status_takes_the_hooks_code() -> None:
    with pytest.raises(KeyError):
        error_answer(404, "made.up")
    with pytest.raises(KeyError):
        error_answer(405, "method_not_allowed")
    for status in (403, 409, 422):
        assert body(error_answer(status, "app.custom"))["errors"][0]["code"] == "app.custom"


def test_problem_mode_is_rfc_9457_with_the_same_status_and_code() -> None:
    answer = error_answer(404, "form.notFound", problem_details=True, message="No such form.")
    assert answer.headers["Content-Type"] == "application/problem+json"
    document = body(answer)
    assert document["type"] == "about:blank"
    assert document["title"] == "Not Found"
    assert document["status"] == 404
    assert document["detail"] == "No such form."
    assert document["code"] == "form.notFound"
    assert document["errors"] == [{"code": "form.notFound", "message": "No such form."}]


def test_the_correlation_id_reaches_the_client_only_as_correlation_id_in_problem_mode() -> None:
    plain = error_answer(500, "internal", correlation_id="abc123")
    assert b"abc123" not in plain.body
    problem = error_answer(500, "internal", problem_details=True, correlation_id="abc123")
    assert body(problem)["correlationId"] == "abc123"
    assert "correlationId" not in body(error_answer(404, "form.notFound", problem_details=True))


def test_a_500_never_echoes_a_message_it_was_given() -> None:
    for problem_details in (False, True):
        answer = error_answer(
            500, "internal", field="password", message="Traceback: secret", problem_details=problem_details
        )
        assert b"secret" not in answer.body
        assert b"password" not in answer.body
        document = body(answer)
        assert document["errors"] == [{"code": "internal"}]
        if problem_details:
            assert "detail" not in document


def test_the_answer_is_a_frozen_record() -> None:
    answer = error_answer(404, "form.notFound")
    with pytest.raises(AttributeError):
        answer.status = 200  # type: ignore[misc]


def test_the_error_envelope_schema_for_the_default_response_matches_the_catalog_schemas() -> None:
    schemas = {item["name"]: item for item in catalog()["schemas"]}
    plain = error_envelope_schema()
    assert plain["type"] == "object"
    assert plain["required"] == schemas["ErrorsBody"]["required"]
    item = plain["properties"]["errors"]["items"]
    assert set(item["properties"]) == {prop["name"] for prop in schemas["ErrorItem"]["properties"]}
    assert item["required"] == schemas["ErrorItem"]["required"]
    problem = error_envelope_schema(problem_details=True)
    assert set(problem["properties"]) == {prop["name"] for prop in schemas["ProblemDetail"]["properties"]}
    assert "$ref" not in json.dumps([plain, problem])
    assert "$defs" not in json.dumps([plain, problem])
    assert DEFAULT_RESPONSE_DESCRIPTION == "a Datum refusal; the codes are the catalog's"


def test_the_error_envelope_schema_is_a_fresh_copy_each_call() -> None:
    first = error_envelope_schema()
    first["properties"].clear()
    assert error_envelope_schema()["properties"]


def test_a_hook_status_needs_its_own_row_and_a_422_names_the_verdict_codes() -> None:
    assert body(error_answer(422, "definition.tooCostly"))["errors"][0]["code"] == "definition.tooCostly"
    with pytest.raises(KeyError):
        error_answer(500, "made.up")
    with pytest.raises(ValueError, match="Retry-After"):
        error_answer(404, "form.notFound", retry_after=5)


def test_a_form_outdated_answer_carries_the_etag_it_is_given_and_none_otherwise() -> None:
    assert error_answer(409, "form.outdated", etag='"a"').headers["ETag"] == '"a"'
    assert "ETag" not in error_answer(409, "form.outdated").headers
    with pytest.raises(ValueError, match="ETag"):
        error_answer(404, "form.notFound", etag='"a"')


def test_non_ascii_text_stays_valid_json_and_a_lone_surrogate_in_a_message_does_not_raise() -> None:
    assert body(error_answer(400, "bad_request", message="d\u00e9j\u00e0"))["errors"][0]["message"] == "d\u00e9j\u00e0"
    assert error_answer(400, "bad_request", message="\ud800").body


def test_problem_mode_bytes_follow_the_catalog_property_order() -> None:
    order = [p["name"] for p in {s["name"]: s for s in catalog()["schemas"]}["ProblemDetail"]["properties"]]
    answer = error_answer(503, "server.busy", retry_after=5, message="Busy.", problem_details=True, correlation_id="c1")
    assert list(json.loads(answer.body)) == order
    assert answer.body == (
        b'{"type":"about:blank","title":"Service Unavailable","status":503,"detail":"Busy.",'
        b'"code":"server.busy","correlationId":"c1","errors":[{"code":"server.busy","message":"Busy."}]}'
    )
    bare = error_answer(404, "form.notFound", problem_details=True)
    assert bare.body == (
        b'{"type":"about:blank","title":"Not Found","status":404,"code":"form.notFound",'
        b'"errors":[{"code":"form.notFound"}]}'
    )


OUTCOMES = [
    (NotFound(), 404, "form.notFound", False),
    (Unavailable(), 503, "server.unavailable", False),
    (TooDeep(), 422, "definition.tooDeep", False),
    (DataSourceNotFound(), 404, "data_source.notFound", False),
    (DataSourceUnavailable(), 503, "data_source.unavailable", False),
]


@pytest.mark.parametrize(("outcome", "status", "code", "retry"), OUTCOMES)
def test_each_refusing_outcome_maps_to_its_row(outcome: Any, status: int, code: str, retry: bool) -> None:
    answer = outcome_answer(outcome)
    assert answer.status == status
    assert body(answer)["errors"][0]["code"] == code
    assert ("Retry-After" in answer.headers) is retry
    assert outcome_answer(outcome, problem_details=True).headers["Content-Type"] == ("application/problem+json")


def test_a_hook_refusal_answers_every_problem_in_order_in_both_modes() -> None:
    problems = (HookProblem("a", "x.one", "One."), HookProblem(None, "x.two", "Two."), HookProblem("c", "x.three", ""))
    error = HookRefusedError.invalid(problems)
    plain = hook_refusal_answer(error)
    assert plain.status == 422
    assert body(plain)["errors"] == [
        {"field": "a", "code": "x.one", "message": "One."},
        {"code": "x.two", "message": "Two."},
        {"field": "c", "code": "x.three"},
    ]
    problem = body(hook_refusal_answer(error, problem_details=True))
    assert [item["code"] for item in problem["errors"]] == ["x.one", "x.two", "x.three"]
    assert problem["code"] == "x.one"
    assert problem["detail"] == "One."
    assert hook_refusal_answer(HookRefusedError.forbidden("no", "No.")).status == 403
    assert hook_refusal_answer(HookRefusedError.conflict("c", "C.")).status == 409


def test_errors_answer_is_byte_exact_for_three_items_and_refuses_none() -> None:
    items = [("a", "bad_request", "A."), (None, "bad_request", None), ("c", "bad_request", "C.")]
    assert errors_answer(400, items).body == (
        b'{"errors":[{"field":"a","code":"bad_request","message":"A."},{"code":"bad_request"},'
        b'{"field":"c","code":"bad_request","message":"C."}]}'
    )
    assert errors_answer(400, items, problem_details=True, correlation_id="c1").body == (
        b'{"type":"about:blank","title":"Bad Request","status":400,"detail":"A.","code":"bad_request",'
        b'"correlationId":"c1","errors":[{"field":"a","code":"bad_request","message":"A."},{"code":"bad_request"},'
        b'{"field":"c","code":"bad_request","message":"C."}]}'
    )
    with pytest.raises(ValueError, match="at least one"):
        errors_answer(400, [])
    with pytest.raises(KeyError):
        errors_answer(400, [(None, "bad_request", None), (None, "made.up", None)])


def _subclasses(cls: type[DatumError]) -> set[type[DatumError]]:
    found: set[type[DatumError]] = set()
    for sub in cls.__subclasses__():
        found |= {sub} | _subclasses(sub)
    return found


def test_the_cores_own_errors_have_a_row() -> None:
    pairs = table_pairs()
    for failure in SandboxFailure:
        assert (failure.status, failure.code) in pairs, failure
    for cls in _subclasses(DatumError):
        if cls.__module__.startswith("datum_core") and cls.__dict__.get("code") is not None:
            assert (cls.status, cls.code) in pairs, cls
    for error in (
        SandboxError(SandboxFailure.BUDGET, "m"),
        DefinitionTooCostlyError(SandboxError(SandboxFailure.BUDGET, "m")),
        ProgramUnavailableError("m"),
        DefinitionTooDeepError(3, "m"),
    ):
        answer = datum_error_answer(error, retry_after=5)
        assert answer.status == error.status
        assert body(answer)["errors"][0]["code"] == error.code
        assert "Retry-After" not in answer.headers  # only server.busy carries it


def test_a_busy_engine_is_a_503_and_an_unknown_pair_is_the_internal_answer() -> None:
    busy = datum_error_answer(EngineBusyError("slots"), retry_after=5)
    assert (busy.status, busy.headers["Retry-After"]) == (503, "5")
    assert body(busy)["errors"][0]["code"] == "server.busy"

    class LaterError(DatumError):
        code = "later.new"
        status = 418

    assert datum_error_answer(LaterError("secret"), retry_after=5) == internal_answer()
    assert b"secret" not in datum_error_answer(LaterError("secret"), retry_after=5).body


def test_bad_request_answer_carries_only_the_field_name() -> None:
    answer = bad_request_answer("x")
    assert answer.status == 400
    assert body(answer)["errors"] == [{"field": "x", "code": "bad_request", "message": "x is not valid"}]
    assert internal_answer().body == b'{"errors":[{"code":"internal"}]}'


def test_retry_after_refuses_a_negative_and_a_bool() -> None:
    with pytest.raises(ValueError, match="Retry-After"):
        error_answer(503, "server.busy", retry_after=-1)
    with pytest.raises(ValueError, match="Retry-After"):
        error_answer(503, "server.busy", retry_after=True)
