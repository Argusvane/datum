"""RFC 8785 against the shared vectors, with rfc8785 as a cross-check where its integer domain allows."""

import json
from pathlib import Path

import pytest

from datum_core.jcs import format_number, jcs_bytes, jcs_digest
from datum_sandbox.json import BadDocumentError, read

FIXTURES = Path(__file__).resolve().parents[3].parent / "shared" / "fixtures"
VECTORS = json.loads((FIXTURES / "jcs-vectors.json").read_text(encoding="utf-8"))


@pytest.mark.parametrize("case", VECTORS, ids=[case["name"] for case in VECTORS])
def test_shared_vectors(case: dict[str, str]) -> None:
    value = read(case["input"].encode(), max_depth=256)
    assert jcs_bytes(value).decode() == case["canonical"]
    assert jcs_digest(value) == __import__("hashlib").sha256(case["canonical"].encode()).hexdigest()


@pytest.mark.parametrize("case", VECTORS, ids=[case["name"] for case in VECTORS])
def test_cross_check_with_rfc8785(case: dict[str, str]) -> None:
    rfc8785 = pytest.importorskip("rfc8785")
    value = json.loads(case["input"])
    try:
        reference = rfc8785.dumps(value).decode()
    except Exception as error:
        pytest.skip(f"outside rfc8785's integer domain: {type(error).__name__}")
    assert jcs_bytes(value).decode() == reference


def test_integer_like_keys_are_plain_code_unit_order() -> None:
    assert jcs_bytes({"b": 1, "10": 2, "2": 3, "a": 4}).decode() == '{"10":2,"2":3,"a":4,"b":1}'


@pytest.mark.parametrize(
    ("value", "expected"),
    [
        (2**53 - 1, "9007199254740991"),
        (2**53, "9007199254740992"),
        (2**53 + 1, "9007199254740992"),
        (-(2**53) - 1, "-9007199254740992"),
        (2**63, "9223372036854776000"),
        (2**64 - 1, "18446744073709552000"),
        (10**21, "1e+21"),
        (10**300, "1e+300"),
        (0.0, "0"),
        (-0.0, "0"),
        (1.0, "1"),
        (1e21, "1e+21"),
        (1e-7, "1e-7"),
        (123456789012345680000.0, "123456789012345680000"),
    ],
)
def test_numbers_beyond_the_safe_range(value: float, expected: str) -> None:
    assert jcs_bytes(value).decode() == expected
    assert format_number(value) == expected


def test_refusals() -> None:
    for value in (float("-inf"), 2**1024 - 2**970, "\udc00"):
        with pytest.raises(BadDocumentError):
            jcs_bytes(value)
