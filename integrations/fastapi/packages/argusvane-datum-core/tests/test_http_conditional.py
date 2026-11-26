"""The conditional-request helper, one test per row (RFC 9110 grammar; no framework import)."""

import json
from datetime import UTC, datetime

import pytest

from datum_core.http import Conditional, HttpAnswer, conditional_answer, evaluate_conditional, if_range_matches

CACHE = "no-store"


def verdict(method: str, headers: dict[str, str], etag: str | None = '"a"') -> Conditional:
    return evaluate_conditional(method, headers, etag)


def test_if_none_match_strong_hit_on_get_is_a_304_with_etag_and_cache_control_and_no_body() -> None:
    assert verdict("GET", {"If-None-Match": '"a"'}) is Conditional.NOT_MODIFIED
    answer = conditional_answer(Conditional.NOT_MODIFIED, etag='"a"', cache_control=CACHE)
    assert isinstance(answer, HttpAnswer)
    assert answer.status == 304
    assert answer.headers["ETag"] == '"a"'
    assert answer.headers["Cache-Control"] == CACHE
    assert answer.body == b""


def test_if_none_match_weak_tag_against_a_strong_current_is_a_304() -> None:
    assert verdict("GET", {"If-None-Match": 'W/"a"'}) is Conditional.NOT_MODIFIED


def test_if_none_match_lists_ignore_empty_elements() -> None:
    assert verdict("GET", {"If-None-Match": '"a", "b"'}, '"b"') is Conditional.NOT_MODIFIED
    assert verdict("GET", {"If-None-Match": '"a",,"b"'}, '"b"') is Conditional.NOT_MODIFIED
    assert verdict("GET", {"If-None-Match": '"a" , , "b"'}, '"a"') is Conditional.NOT_MODIFIED
    assert verdict("GET", {"If-None-Match": '"a","b"'}, '"c"') is Conditional.PROCEED


def test_if_none_match_star_hits_when_a_representation_exists() -> None:
    assert verdict("GET", {"If-None-Match": "*"}) is Conditional.NOT_MODIFIED
    assert verdict("GET", {"If-None-Match": "*"}, None) is Conditional.PROCEED


def test_if_none_match_that_is_true_on_a_put_is_a_412() -> None:
    assert verdict("PUT", {"If-None-Match": '"a"'}) is Conditional.PRECONDITION_FAILED
    assert verdict("PUT", {"If-None-Match": "*"}) is Conditional.PRECONDITION_FAILED
    assert verdict("PUT", {"If-None-Match": '"zz"'}) is Conditional.PROCEED
    answer = conditional_answer(Conditional.PRECONDITION_FAILED, etag='"a"', cache_control=CACHE)
    assert answer is not None
    assert answer.status == 412
    assert answer.body == b""
    assert answer.headers["ETag"] == '"a"'
    assert "Content-Type" not in answer.headers


def test_an_unparseable_if_none_match_is_no_hit_and_the_request_goes_on() -> None:
    for bad in ("a", '"a', "W/", '"a" "b"', "W/a", '"a"x', '"a\nb"', "", '"a", b', '"a", W/', 'w/"a"'):
        assert verdict("GET", {"If-None-Match": bad}) is Conditional.PROCEED, bad
    assert conditional_answer(Conditional.PROCEED, etag='"a"', cache_control=CACHE) is None


def test_if_match_with_the_current_strong_tag_proceeds() -> None:
    assert verdict("PUT", {"If-Match": '"a"'}) is Conditional.PROCEED
    assert verdict("PUT", {"If-Match": '"x", "a"'}) is Conditional.PROCEED
    assert verdict("PUT", {"If-Match": "*"}) is Conditional.PROCEED


def test_if_match_with_a_weak_tag_fails_by_strong_comparison_and_answers_409_form_outdated_with_the_current_etag() -> (
    None
):
    assert verdict("PUT", {"If-Match": 'W/"a"'}) is Conditional.IF_MATCH_FAILED
    answer = conditional_answer(Conditional.IF_MATCH_FAILED, etag='"a"', cache_control=CACHE)
    assert answer is not None
    assert answer.status == 409
    assert answer.headers["ETag"] == '"a"'
    assert json.loads(answer.body)["errors"][0]["code"] == "form.outdated"


def test_an_unparseable_if_match_fails() -> None:
    for bad in ("a", '"a', "", "W/", '"a" "b"', '"a", b', '"a", W/', 'w/"a"'):
        assert verdict("PUT", {"If-Match": bad}) is Conditional.IF_MATCH_FAILED, bad
    assert conditional_answer(Conditional.IF_MATCH_FAILED, etag='"a"', cache_control=CACHE) is not None


def test_a_tag_containing_a_comma_is_one_tag() -> None:
    assert verdict("GET", {"If-None-Match": '"a,b"'}, '"a,b"') is Conditional.NOT_MODIFIED
    assert verdict("GET", {"If-None-Match": '"a,b"'}, '"a"') is Conditional.PROCEED
    assert verdict("GET", {"If-None-Match": '"a,b", "c"'}, '"b"') is Conditional.PROCEED
    assert verdict("PUT", {"If-Match": '"a,b"'}, '"a,b"') is Conditional.PROCEED


def test_precedence_is_if_match_then_if_unmodified_since_then_if_none_match_then_if_modified_since_then_range() -> None:
    old = "Mon, 01 Jan 2024 00:00:00 GMT"
    modified = datetime(2025, 1, 1, tzinfo=UTC)
    # If-Match fails first, whatever If-None-Match says.
    assert verdict("GET", {"If-Match": '"zz"', "If-None-Match": '"a"'}) is Conditional.IF_MATCH_FAILED
    # If-Match passes, then If-None-Match decides.
    assert verdict("GET", {"If-Match": '"a"', "If-None-Match": '"a"'}) is Conditional.NOT_MODIFIED
    # If-Unmodified-Since is ignored when If-Match is present.
    both = evaluate_conditional("PUT", {"If-Match": '"a"', "If-Unmodified-Since": old}, '"a"', last_modified=modified)
    assert both is Conditional.PROCEED
    alone = evaluate_conditional("PUT", {"If-Unmodified-Since": old}, '"a"', last_modified=modified)
    assert alone is Conditional.IF_MATCH_FAILED
    # If-Modified-Since is ignored when If-None-Match is present.
    ims = {"If-None-Match": '"zz"', "If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT"}
    assert evaluate_conditional("GET", ims, '"a"', last_modified=modified) is Conditional.PROCEED
    lone = evaluate_conditional(
        "GET", {"If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT"}, '"a"', last_modified=modified
    )
    assert lone is Conditional.NOT_MODIFIED
    # A 304 precedes Range.
    assert verdict("GET", {"If-None-Match": '"a"', "Range": "bytes=0-3"}) is Conditional.NOT_MODIFIED


def test_head_is_judged_like_get_and_header_names_are_case_insensitive() -> None:
    assert verdict("HEAD", {"If-None-Match": '"a"'}) is Conditional.NOT_MODIFIED
    assert verdict("GET", {"if-none-match": '"a"'}) is Conditional.NOT_MODIFIED
    assert verdict("PUT", {"IF-MATCH": '"zz"'}) is Conditional.IF_MATCH_FAILED
    assert verdict("GET", {}) is Conditional.PROCEED


def test_if_match_star_needs_a_representation() -> None:
    assert verdict("PUT", {"If-Match": "*"}, None) is Conditional.IF_MATCH_FAILED
    assert verdict("PUT", {"If-Match": '"a"'}, None) is Conditional.IF_MATCH_FAILED


def test_if_none_match_star_on_a_put_with_no_representation_proceeds() -> None:
    assert verdict("PUT", {"If-None-Match": "*"}, None) is Conditional.PROCEED
    assert verdict("PUT", {"If-None-Match": "*"}) is Conditional.PRECONDITION_FAILED


def test_if_unmodified_since_that_holds_and_if_none_match_that_hits_gives_the_if_none_match_verdict() -> None:
    modified = datetime(2024, 1, 1, tzinfo=UTC)
    headers = {"If-Unmodified-Since": "Wed, 01 Jan 2025 00:00:00 GMT", "If-None-Match": '"a"'}
    assert evaluate_conditional("GET", headers, '"a"', last_modified=modified) is Conditional.NOT_MODIFIED
    assert evaluate_conditional("PUT", headers, '"a"', last_modified=modified) is Conditional.PRECONDITION_FAILED


def test_if_unmodified_since_that_fails_wins_over_if_none_match() -> None:
    modified = datetime(2025, 1, 1, tzinfo=UTC)
    headers = {"If-Unmodified-Since": "Mon, 01 Jan 2024 00:00:00 GMT", "If-None-Match": '"a"'}
    assert evaluate_conditional("GET", headers, '"a"', last_modified=modified) is Conditional.IF_MATCH_FAILED


def test_an_unreadable_date_is_ignored_and_a_date_header_needs_a_last_modified() -> None:
    modified = datetime(2025, 1, 1, tzinfo=UTC)
    assert evaluate_conditional("GET", {"If-Modified-Since": "yesterday"}, '"a"', last_modified=modified) is (
        Conditional.PROCEED
    )
    assert evaluate_conditional("GET", {"If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT"}, '"a"') is (
        Conditional.PROCEED
    )
    assert evaluate_conditional("PUT", {"If-Unmodified-Since": "Mon, 01 Jan 2024 00:00:00 GMT"}, '"a"') is (
        Conditional.PROCEED
    )


def test_if_modified_since_is_ignored_off_get_and_head_and_sub_second_times_are_truncated() -> None:
    modified = datetime(2025, 1, 1, 0, 0, 0, 900_000, tzinfo=UTC)
    ims = {"If-Modified-Since": "Wed, 01 Jan 2025 00:00:00 GMT"}
    assert evaluate_conditional("GET", ims, '"a"', last_modified=modified) is Conditional.NOT_MODIFIED
    assert evaluate_conditional("PUT", ims, '"a"', last_modified=modified) is Conditional.PROCEED


def test_if_range_honours_a_range_only_for_a_strong_match_or_the_exact_date() -> None:
    modified = datetime(2025, 1, 1, tzinfo=UTC)
    assert if_range_matches({}, '"a"') is True
    assert if_range_matches({"If-Range": '"a"'}, '"a"') is True
    assert if_range_matches({"If-Range": '"b"'}, '"a"') is False
    assert if_range_matches({"If-Range": 'W/"a"'}, '"a"') is False
    assert if_range_matches({"If-Range": "garbage"}, '"a"') is False
    assert if_range_matches({"If-Range": "Wed, 01 Jan 2025 00:00:00 GMT"}, '"a"', last_modified=modified) is True
    assert if_range_matches({"If-Range": "Tue, 31 Dec 2024 00:00:00 GMT"}, '"a"', last_modified=modified) is False
    assert if_range_matches({"If-Range": "Thu, 02 Jan 2025 00:00:00 GMT"}, '"a"', last_modified=modified) is False
    assert if_range_matches({"If-Range": '"a"'}, 'W/"a"') is False
    assert if_range_matches({"If-Range": "Wed, 01 Jan 2025 00:00:00 GMT"}, '"a"') is False


def test_the_412_and_304_answers_carry_no_body_and_a_missing_etag_is_left_out() -> None:
    assert conditional_answer(Conditional.NOT_MODIFIED, etag=None, cache_control=CACHE) == HttpAnswer(
        304, {"Cache-Control": CACHE}, b""
    )
    answer = conditional_answer(Conditional.IF_MATCH_FAILED, etag=None, cache_control=CACHE, problem_details=True)
    assert answer is not None
    assert answer.headers["Content-Type"] == "application/problem+json"
    assert "ETag" not in answer.headers


def test_a_current_etag_that_is_not_an_entity_tag_is_a_caller_error() -> None:
    with pytest.raises(ValueError, match="entity-tag"):
        evaluate_conditional("GET", {}, "not-a-tag")


def test_if_modified_since_before_the_last_modification_proceeds() -> None:
    since = {"If-Modified-Since": "Mon, 01 Jan 2024 00:00:00 GMT"}
    assert evaluate_conditional("GET", since, '"a"', last_modified=datetime(2025, 1, 1, tzinfo=UTC)) is (
        Conditional.PROCEED
    )


def test_strong_comparison_needs_both_tags_strong() -> None:
    assert verdict("PUT", {"If-Match": '"a"'}, 'W/"a"') is Conditional.IF_MATCH_FAILED
    assert verdict("PUT", {"If-Match": 'W/"a"'}, 'W/"a"') is Conditional.IF_MATCH_FAILED
    assert verdict("GET", {"If-None-Match": '"a"'}, 'W/"a"') is Conditional.NOT_MODIFIED


def test_if_unmodified_since_equal_to_the_modification_time_proceeds() -> None:
    headers = {"If-Unmodified-Since": "Wed, 01 Jan 2025 00:00:00 GMT"}
    for microsecond in (0, 900_000):
        modified = datetime(2025, 1, 1, microsecond=microsecond, tzinfo=UTC)
        assert evaluate_conditional("PUT", headers, '"a"', last_modified=modified) is Conditional.PROCEED


@pytest.mark.parametrize(
    "date", ["Sun, 06 Nov 1994 08:49:37 GMT", "Sunday, 06-Nov-94 08:49:37 GMT", "Sun Nov  6 08:49:37 1994"]
)
def test_all_three_http_date_forms_are_accepted(date: str) -> None:
    modified = datetime(1994, 11, 6, 8, 49, 37, tzinfo=UTC)
    assert evaluate_conditional("GET", {"If-Modified-Since": date}, '"a"', last_modified=modified) is (
        Conditional.NOT_MODIFIED
    )
    assert if_range_matches({"If-Range": date}, '"a"', last_modified=modified) is True


def test_grammar_corners_of_the_entity_tag_and_ows() -> None:
    assert verdict("GET", {"If-None-Match": '""'}, '""') is Conditional.NOT_MODIFIED
    assert verdict("GET", {"If-None-Match": '"x",\t"a"'}) is Conditional.NOT_MODIFIED
    assert verdict("PUT", {"If-Match": " * "}) is Conditional.PROCEED
