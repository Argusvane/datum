"""The builder's one walk over a tree (`read_tree`): the size is `json_size`'s, the faults are placed, nothing recurses.

The size is judged before the hash even for a tree that is not JSON, so the walk counts a floor where `json_size`
refuses; for every tree `json_size` measures, the two agree to the byte. The fault is fixed words, never the text.
"""

import math
import threading
from typing import Any

import pytest
from builder_support import FORM, customizer, definition, started_builder
from hypothesis import given
from hypothesis import strategies as st

from datum_core.builder import TooLarge, read_tree
from datum_sandbox.json import json_size
from datum_sandbox.protocol import json_depth

MARKER = "ZZSECRETZZ"

JSON_VALUES = st.recursive(
    st.none()
    | st.booleans()
    | st.integers(min_value=-(2**80), max_value=2**80)
    | st.floats(allow_nan=False, allow_infinity=False)
    | st.text(st.characters(codec="utf-8")),
    lambda inner: (
        st.lists(inner, max_size=5)
        | st.dictionaries(st.text(st.characters(codec="utf-8", exclude_characters="\x00")), inner, max_size=5)
    ),
    max_leaves=40,
)


@given(JSON_VALUES)
def test_the_size_is_json_size_and_a_json_tree_has_no_fault(value: Any) -> None:
    reading = read_tree(value)
    assert reading.size == json_size(value)
    assert reading.fault is None
    assert reading.non_finite is False
    assert reading.depth == json_depth(value)


@pytest.mark.parametrize(
    "value",
    [
        {"a": "x\ud800" + MARKER},
        {"a\udfff": 1},
        {1: "an integer key"},
        {"a\x00b": 1},
        {"a": (1, 2)},
        {"a": {1, 2}},
        [object()],
        b"bytes",
    ],
    ids=["lone surrogate", "surrogate key", "integer key", "nul key", "tuple", "set", "object", "bytes"],
)
def test_a_tree_that_is_not_strict_json_has_a_fault_in_fixed_words(value: object) -> None:
    reading = read_tree(value)
    assert reading.fault
    assert MARKER not in reading.fault


def test_a_nul_inside_a_text_value_is_json() -> None:
    assert read_tree({"a": "ok\x00"}).fault is None


@pytest.mark.parametrize("number", [math.nan, math.inf, -math.inf, 10**400], ids=["nan", "inf", "-inf", "huge int"])
def test_a_number_json_cannot_write_is_non_finite_not_a_fault_and_counts_as_null(number: float) -> None:
    reading = read_tree({"n": number})
    assert reading.fault is None
    assert reading.non_finite is True
    assert reading.size == json_size({"n": None})


def test_a_tree_json_size_refuses_is_still_measured() -> None:
    reading = read_tree({"a": "x" * 5000 + "\ud800", "n": math.nan})
    assert reading.size > 5000
    assert reading.fault is not None
    assert reading.non_finite is True


def test_a_tree_ten_thousand_deep_is_read_without_recursion() -> None:
    value: Any = "leaf"
    for _ in range(10_000):
        value = {"n": [value]}
    reading = read_tree(value)
    assert reading.depth == 20_001
    assert reading.fault is None


def _cycle() -> dict[str, Any]:
    loop: dict[str, Any] = {}
    loop["self"] = loop
    return loop


def test_a_tree_that_contains_itself_ends_at_the_limit() -> None:
    assert read_tree(_cycle(), 1024).size > 1024


def test_a_cyclic_definition_or_a_customizer_that_makes_one_is_too_large_and_nothing_is_stored() -> None:
    def tangle(draft: Any) -> None:
        draft.definition["root"]["self"] = draft.definition["root"]

    answers: list[object] = []

    def run() -> None:
        with started_builder() as rig:
            sent = definition(version="2")
            sent["root"]["self"] = sent["root"]
            answers.append(rig.save(sent))
            assert rig.stored().definition["version"] == "1"
        with started_builder(builder_save_customizers=[customizer("a", [], change=tangle)]) as rig:
            answers.append(rig.save(definition(version="2")))
            assert rig.stored().definition["version"] == "1"
            assert rig.service.save(FORM, definition(version="3"), expected_sha256=None, principal=None) is not None

    worker = threading.Thread(target=run, daemon=True)
    worker.start()
    worker.join(10)
    assert not worker.is_alive()
    assert len(answers) == 2
    assert all(isinstance(answer, TooLarge) for answer in answers)
