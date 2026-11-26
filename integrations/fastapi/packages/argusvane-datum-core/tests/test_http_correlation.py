"""One correlation-id resolver, no middleware: header when it matches, else the trace id, else 12 hex."""

import re

import pytest
from opentelemetry import trace

from datum_core.http import resolve_correlation_id

TRACE = 0x0AF7651916CD43DD8448EB211C80319C


def test_a_header_that_matches_the_pattern_is_used_as_it_is() -> None:
    assert resolve_correlation_id({"X-Request-ID": "req-1.A_b"}) == "req-1.A_b"


def test_the_header_name_comes_from_the_setting_and_is_matched_case_insensitively() -> None:
    assert resolve_correlation_id({"x-request-id": "abc"}) == "abc"
    assert resolve_correlation_id({"X-Correlation": "xyz"}, header_name="x-correlation") == "xyz"
    assert (
        resolve_correlation_id({"X-Request-ID": "abc"}, header_name="X-Correlation", trace_id=TRACE) == f"{TRACE:032x}"
    )


@pytest.mark.parametrize("value", ["has space", "semi;colon", "slash/", "é", "a\nb", "abc\n", "", "x" * 65, "a,b"])
def test_a_header_outside_the_pattern_is_ignored(value: str) -> None:
    resolved = resolve_correlation_id({"X-Request-ID": value}, trace_id=TRACE)
    assert resolved == f"{TRACE:032x}"


def test_the_pattern_allows_one_to_sixty_four_characters() -> None:
    assert resolve_correlation_id({"X-Request-ID": "x" * 64}) == "x" * 64
    assert resolve_correlation_id({"X-Request-ID": "x"}) == "x"


def test_without_a_usable_header_a_valid_trace_id_is_used_as_32_hex_digits() -> None:
    assert resolve_correlation_id({}, trace_id=TRACE) == "0af7651916cd43dd8448eb211c80319c"


def test_an_invalid_trace_id_of_zero_falls_through_to_a_generated_id() -> None:
    resolved = resolve_correlation_id({}, trace_id=0)
    assert re.fullmatch(r"[0-9a-f]{12}", resolved)


def test_with_neither_a_generated_12_hex_id_is_made_and_differs_between_calls() -> None:
    first = resolve_correlation_id({})
    second = resolve_correlation_id({})
    assert re.fullmatch(r"[0-9a-f]{12}", first)
    assert re.fullmatch(r"[0-9a-f]{12}", second)
    assert first != second


def test_an_active_valid_span_supplies_the_trace_id() -> None:
    span = trace.NonRecordingSpan(trace.SpanContext(TRACE, 0x00F067AA0BA902B7, is_remote=False))
    with trace.use_span(span):
        assert resolve_correlation_id({}) == f"{TRACE:032x}"


def test_an_invalid_span_context_is_not_used() -> None:
    span = trace.NonRecordingSpan(trace.SpanContext(TRACE, 0, is_remote=False))  # span id 0: not valid
    with trace.use_span(span):
        resolved = resolve_correlation_id({})
    assert resolved != f"{TRACE:032x}"
    assert len(resolved) == 12


def test_a_well_formed_header_wins_over_an_active_valid_span() -> None:
    span = trace.NonRecordingSpan(trace.SpanContext(TRACE, 0x00F067AA0BA902B7, is_remote=False))
    with trace.use_span(span):
        assert resolve_correlation_id({"X-Request-ID": "abc"}) == "abc"
