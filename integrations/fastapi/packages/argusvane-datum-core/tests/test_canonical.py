"""Canonical JSON (the digest contract) against the shared fixture's engine text and digests."""

import hashlib
import json
from pathlib import Path

import pytest

from datum_core.canonical import canonical_bytes, canonical_digest
from datum_sandbox.json import BadDocumentError, read

FIXTURES = Path(__file__).resolve().parents[3].parent / "shared" / "fixtures"
CASES = json.loads((FIXTURES / "canonical.json").read_text(encoding="utf-8"))


def _canonical(text: str) -> bytes:
    return canonical_bytes(read(text.encode(), max_depth=256))


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_fixture_text_and_digest_equal_the_engine(case: dict[str, object]) -> None:
    expected = str(case["engine"])
    assert _canonical(str(case["input"])).decode() == expected
    assert (
        canonical_digest(read(str(case["input"]).encode(), max_depth=256))
        == hashlib.sha256(expected.encode()).hexdigest()
    )


def test_fixture_directory_is_where_the_tests_think() -> None:
    assert (FIXTURES / "canonical.json").is_file()
    assert CASES


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        ("9007199254740993", "9007199254740992"),
        ("-9007199254740993", "-9007199254740992"),
        ("9223372036854775808", "9223372036854776000"),
        ("18446744073709551615", "18446744073709552000"),
        ("18446744073709551616", "18446744073709552000"),
        ("1" + "0" * 300, "1e+300"),
        ("-0", "0"),
        ("1.0", "1"),
        ("1e21", "1e+21"),
        ("1e-7", "1e-7"),
        ("0.000001", "0.000001"),
        ("5e-324", "5e-324"),
        ("1.5e300", "1.5e+300"),
    ],
)
def test_numbers(text: str, expected: str) -> None:
    assert _canonical(text).decode() == expected


def test_integer_like_keys_come_first_in_numeric_order() -> None:
    text = '{"b":1,"10":2,"2":3,"01":4,"a":5,"4294967294":6,"4294967295":7,"4294967296":8,"-1":9,"0":12}'
    assert _canonical(text).decode() == (
        '{"0":12,"2":3,"10":2,"4294967294":6,"-1":9,"01":4,"4294967295":7,"4294967296":8,"a":5,"b":1}'
    )


def test_astral_keys_sort_by_utf16_code_unit() -> None:
    assert _canonical('{"\\ud83d\\ude00":1,"\\uffff":2,"\\ue000":3,"z":5}').decode() == (
        '{"z":5,"\U0001f600":1,"\ue000":3,"\uffff":2}'
    )


@pytest.mark.parametrize(
    "value",
    [float("nan"), float("inf"), "\ud800", {1: 2}, {"a": object()}, 2**1024, {"\ud800": 1}, {1, 2}],
)
def test_refusals(value: object) -> None:
    with pytest.raises(BadDocumentError):
        canonical_bytes(value)


def test_tuples_write_as_arrays() -> None:
    assert canonical_bytes((1, "a")) == b'[1,"a"]'
