"""definition_depth: component depth 32 (root is level 1), raw definition depth 256, the kernel's walk order."""

import pytest

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    MAX_COMPONENT_DEPTH,
    MAX_DEFINITION_DEPTH,
    DefinitionTooDeepError,
    assert_context_shallow,
    assert_shallow,
    component_too_deep,
    definition_depth,
    json_depth,
)


def chain(levels: int, slot: str = "content") -> dict[str, JsonValue]:
    node: dict[str, JsonValue] = {"id": f"c{levels}"}
    for level in range(levels - 1, 0, -1):
        node = {"id": "root" if level == 1 else f"c{level}", "children": {slot: [node]}}
    return node


def nest(levels: int) -> JsonValue:
    value: JsonValue = 1
    for _ in range(levels - 1):
        value = [value]
    return value


def test_limits() -> None:
    assert MAX_COMPONENT_DEPTH == 32
    assert MAX_DEFINITION_DEPTH == 256


def test_json_depth_counts_the_innermost_value() -> None:
    assert json_depth(1) == 1
    assert json_depth([]) == 2
    assert json_depth({}) == 2
    assert json_depth([1]) == 2
    mixed: JsonValue = {"a": [1, {"b": []}]}
    assert json_depth(mixed) == 5
    assert json_depth(nest(256)) == 256
    assert definition_depth({"a": 1}) == 2


def test_json_depth_is_iterative() -> None:
    assert json_depth(nest(100_000)) == 100_000


def test_component_depth_boundary() -> None:
    assert component_too_deep(chain(32)) is None
    where = component_too_deep(chain(33))
    assert where is not None
    assert where.startswith("root > content > c2 > content > c3")
    assert where.endswith("c32 > content > c33")


def test_raw_depth_boundary() -> None:
    assert_shallow({"id": "d", "rules": nest(MAX_DEFINITION_DEPTH - 1)})
    with pytest.raises(DefinitionTooDeepError) as raised:
        assert_shallow({"id": "d", "rules": nest(MAX_DEFINITION_DEPTH)})
    assert raised.value.limit == 256
    assert raised.value.code == "definition.tooDeep"
    assert raised.value.status == 422


def test_assert_shallow_names_the_location() -> None:
    with pytest.raises(DefinitionTooDeepError, match=r"at root > content > c2") as raised:
        assert_shallow({"id": "d", "root": chain(33)})
    assert raised.value.limit == 32


def test_journey_entries_are_measured_apart_in_every_shape() -> None:
    entry = chain(33)
    entry["id"] = "page-node"
    page = {"id": "p", "components": ["a-form-component", entry]}
    one = {"id": "j", "pages": [page]}
    for journey in (one, {"journeys": [one]}, [one]):
        where = component_too_deep(None, journey)
        assert str(where).startswith("page-node > content > c2")
    assert component_too_deep(None, {"journeys": [{"pages": [{"components": [chain(32)]}]}]}) is None
    unnamed = chain(33)
    del unnamed["id"]
    assert str(component_too_deep(None, {"pages": [{"components": [unnamed]}]})).startswith("a journey page entry")


def test_last_child_first_and_javascript_key_order() -> None:
    deep_a = chain(32)
    deep_a["id"] = "a"
    deep_b = chain(32)
    deep_b["id"] = "b"
    root = {"id": "root", "children": {"content": [deep_a, deep_b]}}
    where = component_too_deep(root)
    assert str(where).startswith("root > content > b")  # the last child is visited first
    # Integer-like slot names come first in ascending order; the walk pops the last-pushed slot first.
    slots = {"z": [dict(deep_a)], "10": [dict(deep_b)], "2": [{"id": "x"}]}
    where = component_too_deep({"id": "root", "children": slots})
    assert str(where).startswith("root > z > a")


def test_long_ids_and_slots_are_named_by_position() -> None:
    node = chain(33, slot="s" * 40)
    children = node["children"]
    assert isinstance(children, dict)
    slot = children["s" * 40]
    assert isinstance(slot, list)
    child = slot[0]
    assert isinstance(child, dict)
    child["id"] = "x" * 65
    where = str(component_too_deep(node))
    assert where.startswith("root > ? > #0 > ? > c3")


def test_non_objects_are_skipped() -> None:
    assert component_too_deep([chain(40)]) is None
    assert component_too_deep({"id": "root", "children": [chain(40)]}) is None
    assert component_too_deep({"id": "root", "children": {"content": "x"}}) is None
    assert component_too_deep(None, "journey") is None


def test_validation_context_guard() -> None:
    assert_context_shallow({"form": chain(32), "values": {"deep": nest(1000)}})
    with pytest.raises(DefinitionTooDeepError, match="form has components nested"):
        assert_context_shallow({"form": chain(33)})
    with pytest.raises(DefinitionTooDeepError, match="journey is nested more than 256"):
        assert_context_shallow({"form": chain(2), "journey": {"pages": nest(300)}})
    with pytest.raises(DefinitionTooDeepError, match="form is nested more than 256"):
        assert_context_shallow({"form": {"id": "root", "x": nest(300)}})


def test_validation_context_guard_reads_every_journey_shape() -> None:
    page: JsonValue = {"pages": [{"components": [chain(33)]}]}
    shapes: list[JsonValue] = [[page], {"journeys": [page]}, page]
    for journey in shapes:
        with pytest.raises(DefinitionTooDeepError):
            assert_context_shallow({"form": chain(2), "journey": journey})
    with pytest.raises(DefinitionTooDeepError, match="journey is nested more than 256"):
        assert_context_shallow({"form": chain(2), "journey": [nest(300)]})
