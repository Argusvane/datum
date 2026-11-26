"""`BuilderOutcome` to the route answer, held to the shared catalog.

The mapping lives once in `datum_core.http`.

The table (`BUILDER_ROWS`) equals the catalog's three builder operations plus the default responses; every answer is
`Cache-Control: no-store`; `ETag` is on 200, 201 and the 409 `form.outdated` and not on `form.exists`; `Location` on
the 201; `X-Datum-Removed-Locales` only when the save removed some; no answer is 412; the 422 bodies carry `errors[]`
and `kernel[]` (and `catalog.invalid` only `errors[]`) in both error modes. The conditional rows for writes are
`if_match_answer` and `if_match_expected`: only `If-Match` is judged. `read_locale_changes` is the bounded parser of
`X-Datum-Locale-Changes`.
"""

import inspect
import json
import logging
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import pytest
from starlette.datastructures import Headers

from datum_core.builder import (
    BuilderOutcome,
    CatalogOutdated,
    CatalogSaved,
    Declined,
    Exists,
    LocaleChanges,
    Malformed,
    NotFound,
    Outdated,
    ReadOnly,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.hooks import HookProblem, HookRefusedError, HookRefusedKind
from datum_core.http import HttpAnswer, builder_answer, evaluate_conditional
from datum_core.http.builder import (
    BUILDER_ROWS,
    BuilderRow,
    if_match_answer,
    if_match_expected,
    read_locale_changes,
)
from datum_sandbox.protocol import DefinitionTooDeepError

CATALOG_PATH = Path(__file__).resolve().parents[4] / "shared" / "endpoint-catalog.json"
OPERATIONS = ("createForm", "saveForm", "saveFormTranslations")
SHA = "a" * 64
OTHER = "b" * 64
ETAG = f'"{SHA}"'
NOW = datetime(2026, 10, 21, 9, 30, 0, tzinfo=UTC)
CATALOG = {"fr": {"components": {"name": {"label": "Nom"}}}}
VARIANTS = (
    Saved,
    CatalogSaved,
    Outdated,
    CatalogOutdated,
    Refused,
    ReadOnly,
    Exists,
    NotFound,
    Malformed,
    TooLarge,
    Unavailable,
    Declined,
)
NO_STORE = "no-store"
PROBLEMS = (
    HookProblem("rules:fx:visibleWhen", "pattern.risky", "A risky pattern."),
    HookProblem("root > content > dup", "component.id.duplicate", "Another component has this id."),
)


def saved(**more: Any) -> Saved:
    fields: dict[str, Any] = {
        "key": "contact",
        "sha256": SHA,
        "version": "2",
        "removed_locales": (),
        "catalog": {},
        "warnings": (),
        "kernel_warnings": (),
        "created": False,
        "saved_at": NOW,
    }
    fields.update(more)
    return Saved(**fields)


def catalog_saved() -> CatalogSaved:
    return CatalogSaved(key="contact", etag=ETAG, catalog=CATALOG, saved_at=NOW)


def one_of_each() -> list[BuilderOutcome]:
    return [
        saved(),
        saved(created=True),
        catalog_saved(),
        Outdated(current_sha256=SHA, current_version="2"),
        CatalogOutdated(current_etag=ETAG),
        Refused("definition.refused", PROBLEMS),
        Refused("definition.tooDeep", (HookProblem("definition", "definition.tooDeep", "Too deep."),)),
        Refused("definition.tooCostly", (HookProblem("definition", "definition.tooCostly", "Too costly."),)),
        Refused("catalog.invalid", (HookProblem("catalog", "catalog.invalid", "A key starts with a letter."),)),
        ReadOnly(cause=RuntimeError("the store is read only")),
        Exists(key="contact", current_sha256=SHA),
        NotFound(key="contact"),
        Malformed(reason="The definition is not JSON."),
        TooLarge(max_bytes=1048576),
        Unavailable(code="server.unavailable", reason="the words", cause=None),
        Declined(HookRefusedError.forbidden("save.notYours", "Not yours.")),
        Declined(HookRefusedError.conflict("save.locked", "Locked.")),
        Declined(HookRefusedError.invalid("title.reserved", "Reserved.")),
    ]


def answer(outcome: BuilderOutcome, **options: Any) -> HttpAnswer:
    reply: HttpAnswer = builder_answer(outcome, **options)
    return reply


def body(reply: HttpAnswer) -> Any:
    return json.loads(reply.body)


def codes(reply: HttpAnswer) -> list[str]:
    return [item["code"] for item in body(reply)["errors"]]


def catalog_rows() -> list[dict[str, Any]]:
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return [entry for entry in document["endpoints"] if entry["operationId"] in OPERATIONS]


def default_statuses(entry: dict[str, Any]) -> set[int]:
    document = json.loads(CATALOG_PATH.read_text(encoding="utf-8"))
    return {
        int(item["status"])
        for item in document["defaultResponses"]
        if item["when"] == "always"
        or (item["when"] == "body" and entry["body"])
        or (item["when"] == "post" and entry["method"] == "POST")
    }


# -- the table held to the catalog -------------------------------------------------------------------------------------
def test_the_table_has_a_row_set_for_each_of_the_twelve_variants() -> None:
    assert set(BUILDER_ROWS) == set(VARIANTS)
    for variant, rows in BUILDER_ROWS.items():
        assert rows, variant
        assert all(isinstance(row, BuilderRow) for row in rows)


ALLOWED_DEVIATIONS: dict[tuple[type, int], str] = {
    (Malformed, 400): "default",  # the catalog's default `BadRequest` response of a body route
    (TooLarge, 413): "default",  # the default `PayloadTooLarge` response of a body route
    (Unavailable, 503): "default",  # the default `Unavailable` response of every route
    (Declined, 403): "hook",  # a hook's own code, where the catalog names the application's `access.denied`
    (Declined, 409): "hook",  # a hook's own code, where the catalog names `form.outdated` / `form.exists`
}
"""The rows allowed beyond the catalog's own status rows; any other row the catalog lacks fails."""


def catalog_lists(entries: list[dict[str, Any]], row: BuilderRow) -> bool:
    """Whether some route lists the row's status, its code (none: a row with no codes) and every header it carries."""
    return any(
        item["status"] == row.status
        and (row.code in item["codes"] if row.code is not None else not item["codes"])
        and set(row.headers) <= set(item["headers"])
        for entry in entries
        for item in entry["statuses"]
    )


def test_every_row_is_listed_by_the_catalog_or_is_an_allowed_deviation() -> None:
    entries = catalog_rows()
    unlisted = {
        (variant, row.status)
        for variant, rows in BUILDER_ROWS.items()
        for row in rows
        if not catalog_lists(entries, row)
    }
    assert unlisted == set(ALLOWED_DEVIATIONS)
    for (variant, status), kind in ALLOWED_DEVIATIONS.items():
        if kind == "default":
            assert any(status in default_statuses(entry) for entry in entries), (variant.__name__, status)


def test_every_status_and_header_the_catalog_lists_is_produced_by_some_row() -> None:
    produced = {(row.status, header) for rows in BUILDER_ROWS.values() for row in rows for header in row.headers}
    statuses = {row.status for rows in BUILDER_ROWS.values() for row in rows}
    for entry in catalog_rows():
        for item in entry["statuses"]:
            if item["status"] == 403:  # the application's security answers the 403 `access.denied`
                continue
            assert item["status"] in statuses, (entry["operationId"], item)
            for header in item["headers"]:
                assert (item["status"], header) in produced, (entry["operationId"], item["status"], header)


def test_the_rows_state_the_builder_statuses() -> None:
    by_name = {variant.__name__: {row.status for row in rows} for variant, rows in BUILDER_ROWS.items()}
    assert by_name["Saved"] == {200, 201}
    assert by_name["CatalogSaved"] == {200}
    assert by_name["Outdated"] == by_name["CatalogOutdated"] == {409}
    assert by_name["Refused"] == {422}
    assert by_name["ReadOnly"] == {501}
    assert by_name["Exists"] == {409}
    assert by_name["NotFound"] == {404}
    assert by_name["Malformed"] == {400}
    assert by_name["TooLarge"] == {413}
    assert by_name["Unavailable"] == {503}
    assert by_name["Declined"] == {403, 409, 422}


def test_no_row_is_a_412() -> None:
    assert all(row.status != 412 for rows in BUILDER_ROWS.values() for row in rows)


def test_the_etag_is_on_the_200_the_201_and_the_outdated_409_and_not_on_form_exists() -> None:
    with_etag = {
        (variant.__name__, row.status)
        for variant, rows in BUILDER_ROWS.items()
        for row in rows
        if "ETag" in row.headers
    }
    assert with_etag == {
        ("Saved", 200),
        ("Saved", 201),
        ("CatalogSaved", 200),
        ("Outdated", 409),
        ("CatalogOutdated", 409),
    }


def test_location_is_on_the_201_alone_and_the_removed_locales_header_on_the_save_200_alone() -> None:
    location = {(v.__name__, r.status) for v, rows in BUILDER_ROWS.items() for r in rows if "Location" in r.headers}
    removed = {
        (v.__name__, r.status)
        for v, rows in BUILDER_ROWS.items()
        for r in rows
        if "X-Datum-Removed-Locales" in r.headers
    }
    assert location == {("Saved", 201)}
    assert removed == {("Saved", 200)}


# -- the success answers -----------------------------------------------------------------------------------------------
def test_a_save_is_200_with_the_etag_of_the_stored_hash_and_the_body_the_page_reads() -> None:
    reply = answer(
        saved(
            warnings=("The form was saved, but its translations were not moved.",),
            kernel_warnings=(HookProblem("root > content > name", "component.type.unknown", "Unknown."),),
            catalog=CATALOG,
        )
    )
    assert reply.status == 200
    assert reply.headers["ETag"] == ETAG
    assert reply.headers["Content-Type"].startswith("application/json")
    document = body(reply)
    assert document["key"] == "contact"
    assert document["version"] == "2"
    assert document["sha256"] == SHA
    assert datetime.fromisoformat(document["savedAt"]) == NOW
    assert document["catalog"] == CATALOG
    assert document["warnings"] == ["The form was saved, but its translations were not moved."]
    assert [(w["code"], w["where"]) for w in document["kernelWarnings"]] == [
        ("component.type.unknown", "root > content > name")
    ]
    assert document["removedLocales"] == []


def test_a_create_is_201_with_the_etag_and_the_location_of_the_author_copy() -> None:
    reply = answer(saved(created=True, key="fresh"), api_base="/api")
    assert reply.status == 201
    assert reply.headers["ETag"] == ETAG
    assert reply.headers["Location"] == "/api/forms/fresh/definition?public=false"


def test_the_location_follows_the_api_base_the_router_was_given() -> None:
    reply = answer(saved(created=True, key="fresh"), api_base="/v2/api")
    assert reply.headers["Location"] == "/v2/api/forms/fresh/definition?public=false"


def test_the_removed_locales_header_is_present_only_when_the_save_removed_some() -> None:
    assert "X-Datum-Removed-Locales" not in answer(saved()).headers
    reply = answer(saved(removed_locales=("fr", "de")))
    assert [part.strip() for part in reply.headers["X-Datum-Removed-Locales"].split(",")] == ["fr", "de"]
    assert body(reply)["removedLocales"] == ["fr", "de"]
    assert "X-Datum-Removed-Locales" not in answer(saved(created=True, removed_locales=())).headers


def test_a_create_never_carries_the_removed_locales_header_the_catalog_gives_it_to_the_save_alone() -> None:
    reply = answer(saved(created=True, removed_locales=("de",)))
    assert reply.status == 201
    assert "X-Datum-Removed-Locales" not in reply.headers


def test_a_catalog_write_is_200_with_the_catalogs_etag_and_the_normalised_catalog() -> None:
    reply = answer(catalog_saved())
    assert reply.status == 200
    assert reply.headers["ETag"] == ETAG
    document = body(reply)
    assert document["catalog"] == CATALOG
    assert datetime.fromisoformat(document["savedAt"]) == NOW
    assert "Location" not in reply.headers


# -- the refusals ------------------------------------------------------------------------------------------------------
def test_outdated_is_409_form_outdated_with_the_current_etag_and_no_hash_in_the_body() -> None:
    reply = answer(Outdated(current_sha256=SHA, current_version="2"))
    assert (reply.status, codes(reply)) == (409, ["form.outdated"])
    assert reply.headers["ETag"] == ETAG
    assert SHA not in reply.body.decode()


def test_a_catalog_outdated_is_409_form_outdated_with_the_current_catalog_etag() -> None:
    reply = answer(CatalogOutdated(current_etag=f'"{OTHER}"'))
    assert (reply.status, codes(reply)) == (409, ["form.outdated"])
    assert reply.headers["ETag"] == f'"{OTHER}"'
    assert OTHER not in reply.body.decode()


def test_exists_is_409_form_exists_with_no_etag_no_hash_and_no_key() -> None:
    reply = answer(Exists(key="evil\nINJECTED", current_sha256=SHA))
    assert (reply.status, codes(reply)) == (409, ["form.exists"])
    assert "ETag" not in reply.headers
    assert SHA not in reply.body.decode()
    assert "INJECTED" not in reply.body.decode()


def test_not_found_is_404_form_not_found_and_never_echoes_the_key() -> None:
    reply = answer(NotFound(key="evil\nINJECTED"))
    assert (reply.status, codes(reply)) == (404, ["form.notFound"])
    assert "INJECTED" not in reply.body.decode()


def test_read_only_is_501_forms_read_only_without_the_causes_words() -> None:
    reply = answer(ReadOnly(cause=RuntimeError("path /srv/forms is read only")))
    assert (reply.status, codes(reply)) == (501, ["forms.readOnly"])
    assert "/srv" not in reply.body.decode()


def test_malformed_is_400_bad_document_without_the_reason_words() -> None:
    reply = answer(Malformed(reason="The definition is not JSON: byte 17 of SECRETTEXT"))
    assert (reply.status, body(reply)) == (400, {"errors": [{"code": "bad_document"}]})


def test_too_large_is_413_bad_document_without_the_cap() -> None:
    reply = answer(TooLarge(max_bytes=1048576))
    assert (reply.status, body(reply)) == (413, {"errors": [{"code": "bad_document"}]})


def test_unavailable_is_503_server_unavailable_with_no_retry_after_and_without_the_reason() -> None:
    reply = answer(Unavailable("server.unavailable", "the words", RuntimeError("cause words")))
    assert (reply.status, codes(reply)) == (503, ["server.unavailable"])
    assert "Retry-After" not in reply.headers
    assert "the words" not in reply.body.decode()
    assert "cause words" not in reply.body.decode()


@pytest.mark.parametrize("code", ["access.denied", "wasm.execution_error", "form.outdated", "made.up"])
def test_an_unavailable_with_a_code_the_503_row_does_not_list_is_the_500_internal(
    code: str, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG, logger="datum"):
        reply = answer(Unavailable(code=code, reason="r", cause=None), correlation_id="cid-9")
    assert (reply.status, codes(reply)) == (500, ["internal"])
    assert "Retry-After" not in reply.headers
    assert [r for r in caplog.records if r.levelno >= logging.ERROR]


@pytest.mark.parametrize("code", ["made.up", "form.outdated", "server.unavailable", "internal"])
def test_a_refused_with_a_code_outside_the_four_the_catalog_gives_is_the_500_internal(code: str) -> None:
    reply = answer(Refused(code, (HookProblem(None, code, "words"),)))
    assert (reply.status, codes(reply)) == (500, ["internal"])


def test_every_answer_is_cache_control_no_store_in_both_error_modes() -> None:
    for outcome in one_of_each():
        for problem_details in (False, True):
            reply = answer(outcome, problem_details=problem_details)
            assert reply.headers.get("Cache-Control") == NO_STORE, (type(outcome).__name__, reply.status)


def test_every_answer_is_one_of_the_rows_the_table_states_for_its_variant() -> None:
    for outcome in one_of_each():
        reply = answer(outcome)
        first = codes(reply)[0] if "errors" in body(reply) and body(reply)["errors"] else None
        shown = {name for name in reply.headers if name.lower() not in {"content-type", "cache-control"}}
        matching = [
            row
            for row in BUILDER_ROWS[type(outcome)]
            if row.status == reply.status
            and (row.code is None or row.code == first)
            and shown <= set(row.headers)
            and set(row.headers) - {"X-Datum-Removed-Locales"} <= shown
        ]
        assert matching, (type(outcome).__name__, reply.status, first, sorted(shown))


def test_no_builder_answer_is_a_412_a_304_or_a_bodiless_one() -> None:
    for outcome in one_of_each():
        reply = answer(outcome)
        assert reply.status not in {304, 412}
        assert reply.body


# -- the 422 bodies ----------------------------------------------------------------------------------------------------
def test_a_refused_definition_lists_errors_and_kernel_findings_in_the_same_order() -> None:
    reply = answer(Refused("definition.refused", PROBLEMS))
    assert reply.status == 422
    document = body(reply)
    assert document["errors"] == [
        {"code": "pattern.risky", "message": "A risky pattern."},
        {"code": "component.id.duplicate", "message": "Another component has this id."},
    ]
    assert document["kernel"] == [
        {"code": "pattern.risky", "where": "rules:fx:visibleWhen"},
        {"code": "component.id.duplicate", "where": "root > content > dup"},
    ]


def test_a_finding_with_no_where_is_located_at_the_definition() -> None:
    reply = answer(Refused("definition.refused", (HookProblem(None, "definition.id.mismatch", "The id must stay."),)))
    assert body(reply)["kernel"] == [{"code": "definition.id.mismatch", "where": "definition"}]


def test_a_refusal_in_problem_mode_has_the_problem_fields_the_errors_and_the_kernel_list() -> None:
    reply = answer(Refused("definition.refused", PROBLEMS), problem_details=True, correlation_id="cid-1")
    assert reply.status == 422
    assert reply.headers["Content-Type"].startswith("application/problem+json")
    document = body(reply)
    assert (document["type"], document["status"], document["code"]) == ("about:blank", 422, "pattern.risky")
    assert [item["code"] for item in document["errors"]] == ["pattern.risky", "component.id.duplicate"]
    assert [item["where"] for item in document["kernel"]] == ["rules:fx:visibleWhen", "root > content > dup"]
    assert document["correlationId"] == "cid-1"


def test_too_deep_and_too_costly_are_422_with_their_own_code_and_one_error() -> None:
    deep = answer(Refused("definition.tooDeep", (HookProblem("definition", "definition.tooDeep", "Too deep."),)))
    costly = answer(
        Refused("definition.tooCostly", (HookProblem("definition", "definition.tooCostly", "Too costly."),), None)
    )
    assert (deep.status, codes(deep)) == (422, ["definition.tooDeep"])
    assert (costly.status, codes(costly)) == (422, ["definition.tooCostly"])


@pytest.mark.parametrize("code", ["definition.tooDeep", "definition.tooCostly"])
@pytest.mark.parametrize("problem_details", [False, True])
def test_the_one_error_body_is_the_code_alone_whatever_message_the_finding_carries(
    code: str, problem_details: bool
) -> None:
    reply = answer(Refused(code, (HookProblem("definition", code, "SECRETWORDS"),)), problem_details=problem_details)
    assert body(reply)["errors"] == [{"code": code}]
    assert "SECRETWORDS" not in reply.body.decode()
    if not problem_details:
        assert body(reply) == {"errors": [{"code": code}]}


def test_too_deep_with_no_findings_still_answers_its_own_code() -> None:
    reply = answer(Refused("definition.tooDeep", (), DefinitionTooDeepError(32, "too deep")))
    assert (reply.status, codes(reply)) == (422, ["definition.tooDeep"])
    assert "too deep" not in reply.body.decode()


def test_a_refused_catalog_is_422_catalog_invalid_with_errors_only() -> None:
    problems = (
        HookProblem("catalog", "catalog.invalid", "A key starts with a letter."),
        HookProblem("catalog", "catalog.invalid", "A text must be text."),
    )
    reply = answer(Refused("catalog.invalid", problems))
    assert reply.status == 422
    document = body(reply)
    assert [item["code"] for item in document["errors"]] == ["catalog.invalid", "catalog.invalid"]
    assert "kernel" not in document


def test_a_refused_catalog_item_code_outside_the_closed_row_answers_the_listed_code() -> None:
    outcome = Refused("catalog.invalid", (HookProblem("catalog", "catalog.keyBad", "A key starts with a letter."),))
    for problem_details in (False, True):
        assert codes(answer(outcome, problem_details=problem_details)) == ["catalog.invalid"]


def test_if_match_expected_is_the_bare_hash_even_for_a_catalog_tag() -> None:
    assert if_match_expected({"If-Match": f'"{SHA}"'}, f'"{SHA}"') == SHA


def test_no_finding_text_beyond_the_hosts_words_reaches_the_body() -> None:
    reply = answer(Refused("definition.refused", (HookProblem("rules:x", "pattern.risky", "A risky pattern."),), None))
    assert "text" not in body(reply)["errors"][0]
    assert set(body(reply)["kernel"][0]) == {"code", "where"}


# -- Declined ----------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("kind", "status"),
    [(HookRefusedKind.FORBIDDEN, 403), (HookRefusedKind.CONFLICT, 409), (HookRefusedKind.INVALID, 422)],
    ids=lambda v: str(getattr(v, "value", v)),
)
def test_a_declined_save_answers_its_kind_with_the_hooks_codes(kind: HookRefusedKind, status: int) -> None:
    refusal = HookRefusedError(
        kind, (HookProblem("title", "title.reserved", "Reserved."), HookProblem(None, "x.y", ""))
    )
    reply = answer(Declined(refusal))
    assert reply.status == status
    assert [item["code"] for item in body(reply)["errors"]] == ["title.reserved", "x.y"]
    assert reply.headers["Cache-Control"] == NO_STORE
    assert "ETag" not in reply.headers


def test_a_declined_invalid_is_the_builders_definition_refused_shape_with_a_kernel_list() -> None:
    refusal = HookRefusedError.invalid(
        [HookProblem("title", "title.reserved", "Reserved."), HookProblem(None, "other.rule", "Other.")]
    )
    document = body(answer(Declined(refusal)))
    assert [item["code"] for item in document["errors"]] == ["title.reserved", "other.rule"]
    assert document["kernel"] == [
        {"code": "title.reserved", "where": "title"},
        {"code": "other.rule", "where": "definition"},
    ]


def test_a_declined_forbidden_or_conflict_has_no_kernel_list() -> None:
    assert "kernel" not in body(answer(Declined(HookRefusedError.forbidden("a.b", "No."))))
    assert "kernel" not in body(answer(Declined(HookRefusedError.conflict("a.b", "No."))))


# -- both error modes, the correlation id ------------------------------------------------------------------------------
@pytest.mark.parametrize("outcome", [o for o in one_of_each() if not isinstance(o, Saved | CatalogSaved)], ids=repr)
def test_every_refusal_has_the_same_status_and_code_in_both_modes(outcome: BuilderOutcome) -> None:
    plain = answer(outcome)
    problem = answer(outcome, problem_details=True, correlation_id="cid-5")
    assert plain.status == problem.status
    assert plain.headers.get("ETag") == problem.headers.get("ETag")
    assert plain.headers["Content-Type"].startswith("application/json")
    assert problem.headers["Content-Type"].startswith("application/problem+json")
    assert body(problem)["errors"] == body(plain)["errors"]
    assert body(problem)["code"] == body(plain)["errors"][0]["code"]
    assert "correlationId" not in body(plain)
    assert "cid-5" not in plain.body.decode()


def test_a_500_never_carries_a_field_or_a_message_and_names_the_correlation_id_only_in_problem_mode() -> None:
    plain = answer(Refused("made.up", (HookProblem("secret", "made.up", "SECRETWORDS"),)))
    problem = answer(
        Refused("made.up", (HookProblem("secret", "made.up", "SECRETWORDS"),)),
        problem_details=True,
        correlation_id="cid-8",
    )
    assert body(plain) == {"errors": [{"code": "internal"}]}
    assert body(problem)["correlationId"] == "cid-8"
    assert "SECRETWORDS" not in plain.body.decode() + problem.body.decode()


# -- the conditional rows for writes -------------------------------------------------------------------
def outdated_409(reply: HttpAnswer | None) -> None:
    assert reply is not None
    assert (reply.status, codes(reply)) == (409, ["form.outdated"])
    assert reply.headers["ETag"] == ETAG
    assert reply.headers["Cache-Control"] == NO_STORE
    assert SHA not in reply.body.decode()


def test_a_star_or_no_if_match_on_a_form_with_no_representation_expects_nothing_and_answers_409_without_an_etag() -> (
    None
):
    assert if_match_expected({"If-Match": "*"}, None) is None
    assert if_match_expected({}, None) is None
    answer = if_match_answer({"If-Match": "*"}, None)
    assert answer is not None
    assert answer.status == 409
    assert not any(name.lower() == "etag" for name in dict(answer.headers))  # only the route's 404 comes first


def test_a_write_with_no_if_match_proceeds_as_sent() -> None:
    assert if_match_answer({}, ETAG) is None
    assert if_match_expected({}, ETAG) is None


def test_a_write_naming_the_current_hash_proceeds_and_expects_that_hash() -> None:
    headers = {"If-Match": ETAG}
    assert if_match_answer(headers, ETAG) is None
    assert if_match_expected(headers, ETAG) == SHA


def test_a_stale_hash_is_409_form_outdated_with_the_current_etag() -> None:
    outdated_409(if_match_answer({"If-Match": f'"{OTHER}"'}, ETAG))


@pytest.mark.parametrize(
    "value",
    ["", "  ", f"W/{ETAG}", SHA, f'"{SHA}', f"'{SHA}'", f'"{SHA}" "{OTHER}"', '"a"x', "W/", "*x", "* , *"],
    ids=[
        "empty",
        "blank",
        "weak",
        "unquoted",
        "unterminated",
        "single quotes",
        "space list",
        "trailing junk",
        "bare weak",
        "star junk",
        "two stars",
    ],
)
def test_an_if_match_that_is_present_but_empty_weak_or_unparseable_is_409(value: str) -> None:
    outdated_409(if_match_answer({"If-Match": value}, ETAG))


def test_star_passes_when_the_form_exists_and_is_the_unconditional_save() -> None:
    # One rule for absent and `*`: `*` expects no hash, like an absent header, so the service
    # saves it under its stripe lock instead of comparing it against the hash the route just read.
    assert if_match_answer({"If-Match": "*"}, ETAG) is None
    assert if_match_expected({"If-Match": "*"}, ETAG) is None


def test_a_list_with_the_current_hash_among_others_passes() -> None:
    headers = {"If-Match": f'"{OTHER}", "{SHA}" , W/"zzz"'}
    assert if_match_answer(headers, ETAG) is None
    assert if_match_expected(headers, ETAG) == SHA


def test_combined_field_lines_are_one_list() -> None:
    headers = Headers(raw=[(b"if-match", f'"{OTHER}"'.encode()), (b"if-match", ETAG.encode())])
    assert if_match_answer(headers, ETAG) is None
    stale = Headers(raw=[(b"if-match", f'"{OTHER}"'.encode()), (b"if-match", b'"c"')])
    outdated_409(if_match_answer(stale, ETAG))


def test_a_tag_with_a_comma_inside_is_one_tag() -> None:
    commas = f'"{SHA[:10]},{SHA[10:]}"'
    outdated_409(if_match_answer({"If-Match": commas}, ETAG))


@pytest.mark.parametrize(
    "extra",
    [
        {"If-None-Match": ETAG},
        {"If-None-Match": "*"},
        {"If-None-Match": f'W/"{SHA}"'},
        {"If-Modified-Since": "Wed, 21 Oct 2099 07:28:00 GMT"},
        {"If-Unmodified-Since": "Wed, 21 Oct 1999 07:28:00 GMT"},
        {"If-Range": ETAG, "Range": "bytes=0-9"},
    ],
    ids=["none-match tag", "none-match star", "none-match weak", "modified since", "unmodified since", "range"],
)
def test_no_other_conditional_header_is_judged_on_a_write(extra: dict[str, str]) -> None:
    assert if_match_answer(dict(extra), ETAG) is None
    assert if_match_expected(dict(extra), ETAG) is None
    outdated_409(if_match_answer({**extra, "If-Match": f'"{OTHER}"'}, ETAG))
    assert if_match_answer({**extra, "If-Match": ETAG}, ETAG) is None


def test_a_failed_if_match_is_never_a_412_even_with_a_true_if_none_match() -> None:
    reply = if_match_answer({"If-Match": f'"{OTHER}"', "If-None-Match": ETAG}, ETAG)
    assert reply is not None
    assert reply.status == 409


def test_the_answer_follows_the_error_mode_and_names_the_correlation_id_only_in_problem_mode() -> None:
    reply = if_match_answer({"If-Match": f'"{OTHER}"'}, ETAG, problem_details=True, correlation_id="cid-3")
    assert reply is not None
    assert reply.headers["Content-Type"].startswith("application/problem+json")
    assert body(reply)["correlationId"] == "cid-3"
    assert body(reply)["code"] == "form.outdated"


def test_the_catalog_etag_is_judged_the_same_way() -> None:
    other = f'"{OTHER}"'
    assert if_match_answer({"If-Match": other}, other) is None
    stale = if_match_answer({"If-Match": ETAG}, other)
    assert stale is not None
    assert stale.headers["ETag"] == other


def test_phase_3_has_no_require_if_match_option_the_builder_decides_by_the_helper_above() -> None:
    assert "require_if_match" not in inspect.signature(evaluate_conditional).parameters


# -- X-Datum-Locale-Changes --------------------------------------------------------------------------------------------
def malformed(value: str | None) -> None:
    parsed = read_locale_changes(value)
    assert isinstance(parsed, Malformed), parsed
    assert parsed.reason
    if value:
        assert value[:40] not in parsed.reason


@pytest.mark.parametrize("value", [None, "", "   ", "\t"])
def test_an_absent_or_blank_header_is_no_change(value: str | None) -> None:
    assert read_locale_changes(value) == LocaleChanges()


def test_the_header_the_page_sends_is_read() -> None:
    value = json.dumps({"removed": ["de"], "renamed": [{"from": "fr", "to": "fr-CA"}, {"from": "en", "to": "en-GB"}]})
    assert read_locale_changes(value) == LocaleChanges(removed=("de",), renamed=(("fr", "fr-CA"), ("en", "en-GB")))


def test_either_list_may_be_absent_or_empty_and_unknown_members_are_ignored() -> None:
    assert read_locale_changes('{"removed":["de"]}') == LocaleChanges(removed=("de",))
    assert read_locale_changes('{"renamed":[{"from":"fr","to":"fr-CA"}]}') == LocaleChanges(renamed=(("fr", "fr-CA"),))
    assert read_locale_changes('{"removed":[],"renamed":[]}') == LocaleChanges()
    assert read_locale_changes('{"removed":["de"],"future":{"a":1}}') == LocaleChanges(removed=("de",))


@pytest.mark.parametrize(
    "value",
    [
        "not json",
        "[]",
        '"de"',
        "7",
        "null",
        '{"removed":"de"}',
        '{"removed":[7]}',
        '{"removed":[null]}',
        '{"removed":[true]}',
        '{"removed":["not a locale"]}',
        '{"removed":["é"]}',
        '{"removed":["de","de"]}',
        '{"renamed":[{"from":"fr"}]}',
        '{"renamed":[{"from":"fr","to":7}]}',
        '{"renamed":[{"from":"fr","to":"fr"}]}',
        '{"renamed":["fr"]}',
        '{"renamed":{"from":"fr","to":"fr-CA"}}',
        '{"removed":["fr"],"renamed":[{"from":"fr","to":"fr-CA"}]}',
        '{"removed":["de"]} trailing',
        '{"removed":["de"]',
        '{"removed":["\\ud800"]}',
        '{"removed":["de"],"n":NaN}',
        '{"removed":["de"],"n":Infinity}',
        '{"removed":["de"],"n":1e999999}',
        "﻿{}",
    ],
)
def test_a_header_that_is_not_the_documented_shape_is_malformed(value: str) -> None:
    malformed(value)


def test_the_nesting_is_bounded() -> None:
    deep = '{"removed":["de"],"x":' + "[" * 40 + "]" * 40 + "}"
    malformed(deep)
    ok = '{"removed":["de"],"x":' + "[" * 10 + "]" * 10 + "}"
    assert read_locale_changes(ok) == LocaleChanges(removed=("de",))


def test_at_most_sixty_four_locales_are_named_in_all() -> None:
    names = [f"x{chr(97 + n // 26)}{chr(97 + n % 26)}" for n in range(65)]
    assert isinstance(read_locale_changes(json.dumps({"removed": names[:64]})), LocaleChanges)
    malformed(json.dumps({"removed": names}))
    half = {"removed": names[:32], "renamed": [{"from": n, "to": f"{n}-x"} for n in names[32:65]]}
    malformed(json.dumps(half))


def test_a_header_over_eight_kib_is_malformed_whatever_it_says() -> None:
    padding = " " * 8192
    just_fits = '{"removed":["de"]}' + padding[: 8192 - len('{"removed":["de"]}')]
    assert len(just_fits) == 8192
    assert read_locale_changes(just_fits) == LocaleChanges(removed=("de",))
    malformed(just_fits + " ")
    malformed("{" + '"a":1,' * 3000 + '"removed":["de"]}')


def test_the_eight_kib_bound_is_measured_in_utf_8_bytes_not_characters() -> None:
    head, tail = '{"removed":["de"],"x":"', '"}'
    fits = head + "e" * (8192 - len(head) - len(tail)) + tail
    assert len(fits.encode()) == 8192
    assert read_locale_changes(fits) == LocaleChanges(removed=("de",))
    wide = head + "\u00e9" * 4100 + tail
    assert len(wide) < 8192 < len(wide.encode("utf-8"))
    malformed(wide)


def test_the_reason_never_quotes_the_header() -> None:
    hostile = '{"removed":["INJECTED\\nTEXT"]}'
    parsed = read_locale_changes(hostile)
    assert isinstance(parsed, Malformed)
    assert "INJECTED" not in parsed.reason
