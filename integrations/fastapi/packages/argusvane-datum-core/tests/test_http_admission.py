"""Admission takes bytes and a header mapping. Order: 415, then the cap, then the strict parse."""

import json
from collections.abc import Iterator

import pytest

from datum_core.http import (
    BodyBudget,
    BodyTooLargeError,
    Refused,
    admit_body,
    admit_json,
    check_request_headers,
    parse_json_body,
    refuse_too_large,
)

KIB = 1024
MIB = 1024 * KIB
JSON_HEADERS = {"Content-Type": "application/json"}


class Chunks:
    """An iterator of chunks that counts how many it handed out."""

    def __init__(self, *chunks: bytes) -> None:
        self._chunks = iter(chunks)
        self.taken = 0

    def __iter__(self) -> Iterator[bytes]:
        return self

    def __next__(self) -> bytes:
        chunk = next(self._chunks)
        self.taken += 1
        return chunk


def refusal(result: object) -> Refused:
    assert isinstance(result, Refused), result
    return result


def code_of(refused: Refused) -> str:
    return str(json.loads(refused.answer.body)["errors"][0]["code"])


def test_a_content_type_that_is_not_json_is_a_415_before_a_single_byte_is_read() -> None:
    chunks = Chunks(b"NaN")
    headers = {"Content-Type": "text/plain", "Content-Length": str(10 * MIB)}
    refused = refusal(admit_json(headers, chunks, max_bytes=MIB))
    assert refused.answer.status == 415
    assert code_of(refused) == "unsupported_media_type"
    assert chunks.taken == 0


@pytest.mark.parametrize(
    "content_type", [None, "", "text/json", "application/jsonx", "application/x-www-form-urlencoded"]
)
def test_a_missing_or_foreign_content_type_is_a_415(content_type: str | None) -> None:
    headers = {} if content_type is None else {"Content-Type": content_type}
    assert refusal(admit_json(headers, Chunks(b"{}"), max_bytes=MIB)).answer.status == 415


@pytest.mark.parametrize(
    "content_type", ["application/json", "Application/JSON; charset=UTF-8", "application/json;charset=utf-8"]
)
def test_json_with_parameters_and_any_case_is_accepted(content_type: str) -> None:
    assert admit_json({"content-type": content_type}, Chunks(b'{"a":1}'), max_bytes=MIB) == {"a": 1}


def test_a_content_length_over_the_cap_is_a_413_before_the_strict_parse_and_before_reading() -> None:
    chunks = Chunks(b"NaN not even json")
    headers = {**JSON_HEADERS, "Content-Length": str(MIB + 1)}
    refused = refusal(admit_json(headers, chunks, max_bytes=MIB))
    assert refused.answer.status == 413
    assert code_of(refused) == "bad_document"
    assert chunks.taken == 0


def test_the_strict_parse_comes_last_and_every_refusal_is_a_400_bad_document() -> None:
    for text in (b"NaN", b"[1e999]", b'"\\ud800"', b"\xff", b"", b"{", b"[" * 257 + b"]" * 257):
        refused = refusal(admit_json(JSON_HEADERS, Chunks(text), max_bytes=MIB))
        assert refused.answer.status == 400, text
        assert code_of(refused) == "bad_document"


@pytest.mark.parametrize("body", [b'{"a\\u0000":1}', b'{"a\x00":1}'])
def test_a_nul_character_in_a_key_is_a_400_bad_document(body: bytes) -> None:
    refused = refusal(admit_json(JSON_HEADERS, Chunks(body), max_bytes=MIB))
    assert refused.answer.status == 400
    assert code_of(refused) == "bad_document"


def test_a_nul_character_in_a_string_value_is_admitted() -> None:
    assert admit_json(JSON_HEADERS, Chunks(b'{"a":"x\\u0000"}'), max_bytes=MIB) == {"a": "x\x00"}


def test_a_chunked_body_without_a_content_length_is_counted_and_refused_at_the_byte() -> None:
    chunks = Chunks(b" " * (600 * KIB), b" " * (600 * KIB), b" " * (600 * KIB))
    refused = refusal(admit_json(JSON_HEADERS, chunks, max_bytes=MIB))
    assert refused.answer.status == 413
    assert code_of(refused) == "bad_document"
    assert chunks.taken == 2  # the third chunk is never pulled


def test_a_content_length_that_is_not_a_whole_number_is_a_400_bad_document() -> None:
    for value in ("abc", "-1", "1.5", "1 2"):
        refused = refusal(admit_json({**JSON_HEADERS, "Content-Length": value}, Chunks(b"{}"), max_bytes=MIB))
        assert refused.answer.status == 400, value
        assert code_of(refused) == "bad_document"


def padded(size: int) -> bytes:
    """A JSON array of exactly `size` bytes (whitespace padding is valid JSON)."""
    return b"[" + b" " * (size - 2) + b"]"


@pytest.mark.parametrize("via_content_length", [True, False], ids=["content-length", "chunked"])
def test_one_mebibyte_is_accepted_and_one_byte_more_is_refused(via_content_length: bool) -> None:
    def headers(size: int) -> dict[str, str]:
        return {**JSON_HEADERS, **({"Content-Length": str(size)} if via_content_length else {})}

    at_cap = padded(MIB)
    assert admit_json(headers(len(at_cap)), Chunks(at_cap), max_bytes=MIB) == []
    over = padded(MIB + 1)
    refused = refusal(admit_json(headers(len(over)), Chunks(over), max_bytes=MIB))
    assert refused.answer.status == 413


@pytest.mark.parametrize("via_content_length", [True, False], ids=["content-length", "chunked"])
def test_twenty_mebibytes_of_a_pdf_are_accepted_and_one_byte_more_is_refused(via_content_length: bool) -> None:
    cap = 20 * MIB
    pdf = {"Content-Type": "application/pdf"}

    def headers(size: int) -> dict[str, str]:
        return {**pdf, **({"Content-Length": str(size)} if via_content_length else {})}

    def pieces(size: int) -> Chunks:
        whole, rest = divmod(size, MIB)
        return Chunks(*([b"%" * MIB] * whole), b"%" * rest) if rest else Chunks(*([b"%" * MIB] * whole))

    accepted = admit_body(headers(cap), pieces(cap), max_bytes=cap, media_types=("application/pdf",))
    assert isinstance(accepted, bytes)
    assert len(accepted) == cap
    refused = refusal(admit_body(headers(cap + 1), pieces(cap + 1), max_bytes=cap, media_types=("application/pdf",)))
    assert refused.answer.status == 413


def test_admit_body_takes_the_media_types_the_route_allows() -> None:
    refused = refusal(admit_body(JSON_HEADERS, Chunks(b"%PDF"), max_bytes=MIB, media_types=("application/pdf",)))
    assert refused.answer.status == 415


def test_the_body_budget_counts_bytes_across_chunks() -> None:
    budget = BodyBudget(5)
    budget.add(b"abc")
    budget.add(b"de")
    assert budget.size == 5
    with pytest.raises(BodyTooLargeError):
        budget.add(b"f")


def test_a_budget_of_zero_bytes_refuses_the_first_byte_only() -> None:
    budget = BodyBudget(0)
    budget.add(b"")
    with pytest.raises(BodyTooLargeError):
        budget.add(b"x")


def test_the_streaming_pieces_compose_the_same_order_for_a_binding_that_reads_chunks_itself() -> None:
    assert check_request_headers(JSON_HEADERS, max_bytes=MIB) is None
    assert refusal(check_request_headers({"Content-Type": "text/plain"}, max_bytes=MIB)).answer.status == 415
    too_long = {**JSON_HEADERS, "Content-Length": str(MIB + 1)}
    assert refusal(check_request_headers(too_long, max_bytes=MIB)).answer.status == 413
    assert refuse_too_large().answer.status == 413
    assert parse_json_body(b'{"a":[1,2]}') == {"a": [1, 2]}
    assert refusal(parse_json_body(b"[1e999]")).answer.status == 400


def test_problem_mode_reaches_every_admission_refusal() -> None:
    refused = refusal(admit_json({}, Chunks(b"{}"), max_bytes=MIB, problem_details=True))
    assert refused.answer.headers["Content-Type"] == "application/problem+json"
    body = json.loads(refused.answer.body)
    assert (body["status"], body["code"]) == (415, "unsupported_media_type")
    assert refusal(refuse_too_large(problem_details=True)).answer.headers["Content-Type"] == "application/problem+json"
    assert refusal(parse_json_body(b"{", problem_details=True)).answer.status == 400


def test_a_refusal_never_echoes_the_body() -> None:
    refused = refusal(admit_json(JSON_HEADERS, Chunks(b'{"secret": NaN}'), max_bytes=MIB))
    assert b"secret" not in refused.answer.body


def test_the_depth_limit_is_a_keyword_and_a_json_null_body_is_a_value_not_a_refusal() -> None:
    assert admit_json(JSON_HEADERS, Chunks(b"null"), max_bytes=MIB) is None
    deep = b"[" * 9 + b"]" * 9
    assert refusal(admit_json(JSON_HEADERS, Chunks(deep), max_bytes=MIB, max_depth=8)).answer.status == 400
    assert admit_json(JSON_HEADERS, Chunks(b"[" * 8 + b"]" * 8), max_bytes=MIB, max_depth=8)
