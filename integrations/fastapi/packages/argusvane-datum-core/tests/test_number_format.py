"""Hypothesis: the formatter against repr-based parsing."""

import math
import struct

from hypothesis import given, settings
from hypothesis import strategies as st

from datum_core.jcs import format_number


@given(st.floats(allow_nan=False, allow_infinity=False))
@settings(max_examples=3000)
def test_text_parses_back_to_the_same_double(value: float) -> None:
    text = format_number(value)
    assert float(text) == value
    assert "e" not in text or "e+" in text or "e-" in text
    assert not text.startswith("+")
    assert text != "-0"


@given(st.integers(min_value=0, max_value=2**64 - 1).map(lambda bits: struct.unpack(">d", bits.to_bytes(8, "big"))[0]))
@settings(max_examples=3000)
def test_random_bit_patterns(value: float) -> None:
    if math.isfinite(value):
        assert float(format_number(value)) == value


@given(st.integers(min_value=-(2**53), max_value=2**53))
def test_safe_integers_are_their_decimal_text(value: int) -> None:
    assert format_number(value) == str(value)
