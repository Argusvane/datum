"""`definition_depth`: the depth guard run before any guest starts (suite DEF-06, `definition.tooDeep`).

The program's QuickJS has a fixed WebAssembly shadow stack and no stack check under WASI: its kernel walk, past about
80 levels, corrupts memory rather than trapping (no script catch sees it, and a host's stack-floor guard can only report
it after the run). So a definition is measured here, iteratively (a hostile tree costs no recursion), and refused past
`MAX_COMPONENT_DEPTH` component levels, the root counting as level 1; the form's tree and each object entry a journey
page lists are measured apart. `MAX_DEFINITION_DEPTH` bounds the raw JSON nesting of everything else in a definition
(rules, options, layouts), which the component walk does not see. The walk is the kernel's: an explicit stack, the last
child first, slots in the order ECMAScript lists an object's keys, and the location written `root > slot > id`.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from typing import Final, cast

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol._errors import DefinitionTooDeepError

MAX_COMPONENT_DEPTH: Final = 32
"""The most component levels a definition may be nested, the root's included."""
MAX_DEFINITION_DEPTH: Final = 256
"""The deepest a definition may be nested as JSON, counted by `json_depth` (the innermost value is a level)."""

_ID_LABEL: Final = 64
"""The longest id written into a location; a longer one is named by its position (`#3`)."""
_SLOT_LABEL: Final = 32
"""The longest slot name written into a location; a longer one reads `?`."""
_ARRAY_INDEX_MAX: Final = 2**32 - 2


def _record(value: object) -> Mapping[str, object] | None:
    """Return `value` as a JSON object, or None (keys are strings in anything the JSON reader built)."""
    return cast("Mapping[str, object]", value) if isinstance(value, Mapping) else None


def _items(value: object) -> Sequence[object] | None:
    """Return `value` as a JSON array (a list or tuple), or None."""
    return cast("Sequence[object]", value) if isinstance(value, list | tuple) else None


def json_depth(value: object) -> int:
    """Return a value's nesting depth: a scalar is 1, a container one more than its deepest member, an empty one 2."""
    deepest = 1
    stack: list[tuple[object, int]] = [(value, 1)]
    while stack:
        node, level = stack.pop()
        record = _record(node)
        members = record.values() if record is not None else _items(node)
        if members is None:
            deepest = max(deepest, level)
            continue
        deepest = max(deepest, level + 1)
        stack.extend((child, level + 1) for child in members)
    return deepest


def _js_keys(record: Mapping[str, object]) -> list[str]:
    """List the keys in ECMAScript order: array indexes ascending first, then the rest as inserted."""
    indexes = [
        k for k in record if k.isdecimal() and k.isascii() and (k == "0" or k[0] != "0") and int(k) <= _ARRAY_INDEX_MAX
    ]
    chosen = set(indexes)
    return sorted(indexes, key=int) + [k for k in record if k not in chosen]


@dataclass(frozen=True, slots=True)
class _Node:
    """One node of the walk; its location is a parent link written out only for the node reported."""

    node: Mapping[str, object]
    level: int
    parent: "_Node | None"
    slot: str
    label: str

    def where(self) -> str:
        parts: list[str] = []
        at: _Node | None = self
        while at is not None:
            parts.append(at.label)
            if at.parent is not None:
                parts.append(at.slot)
            at = at.parent
        return " > ".join(reversed(parts))


def _cut(text: str, length: int) -> str:
    return text if len(text) <= length else text[:length]


def _journey_entries(journey: object) -> list[Mapping[str, object]]:
    """List the object entries of journey pages: one journey `{pages}`, the wrapper `{journeys: [...]}` or the list."""
    journeys = _items(journey)
    wrapper = _record(journey)
    if wrapper is not None:
        journeys = _items(wrapper.get("journeys")) or [wrapper]
    entries: list[Mapping[str, object]] = []
    for one in journeys or ():
        one_record = _record(one)
        pages = _items(one_record.get("pages")) if one_record is not None else None
        for page in pages or ():
            page_record = _record(page)
            components = _items(page_record.get("components")) if page_record is not None else None
            entries.extend(entry for entry in map(_record, components or ()) if entry is not None)
    return entries


def component_too_deep(root: object, journey: object = None) -> str | None:
    """Return where components are nested deeper than `MAX_COMPONENT_DEPTH` (the first found, kernel order), or None."""
    starts: list[_Node] = []
    root_record = _record(root)
    if root_record is not None:
        starts.append(_Node(root_record, 1, None, "", "root"))
    for entry in _journey_entries(journey):
        entry_id = entry.get("id")
        label = _cut(entry_id, _ID_LABEL) if isinstance(entry_id, str) else "a journey page entry"
        starts.append(_Node(entry, 1, None, "", label))
    for start in starts:
        stack = [start]
        while stack:
            top = stack.pop()
            if top.level > MAX_COMPONENT_DEPTH:
                return top.where()
            children = _record(top.node.get("children"))
            if children is None:
                continue
            for slot in _js_keys(children):
                items = _items(children[slot])
                if items is None:
                    continue
                slot_label = slot if len(slot) <= _SLOT_LABEL else "?"
                for index, item in enumerate(items):
                    child = _record(item)
                    if child is not None:
                        child_id = child.get("id")
                        label = child_id if isinstance(child_id, str) and len(child_id) <= _ID_LABEL else f"#{index}"
                        stack.append(_Node(child, top.level + 1, top, slot_label, label))
    return None


def assert_raw_depth(value: object, what: str = "definition") -> None:
    """Refuse a value nested deeper than `MAX_DEFINITION_DEPTH` as JSON."""
    if json_depth(value) > MAX_DEFINITION_DEPTH:
        raise DefinitionTooDeepError(
            MAX_DEFINITION_DEPTH, f"The {what} is nested more than {MAX_DEFINITION_DEPTH} levels deep as JSON."
        )


def assert_shallow(definition: Mapping[str, JsonValue]) -> None:
    """Refuse a definition past either limit, before any guest starts: the raw depth, then the component depth."""
    assert_raw_depth(definition, "definition")
    where = component_too_deep(definition.get("root"), definition.get("journey"))
    if where is not None:
        raise DefinitionTooDeepError(
            MAX_COMPONENT_DEPTH, f"The definition has components nested too deeply (at {where})."
        )


def assert_context_shallow(context: Mapping[str, JsonValue]) -> None:
    """Refuse a validation context whose `form` or `journey` is nested past either limit, before any guest starts.

    The journey is measured in every shape the kernel reads: one journey, the wrapper `{journeys}` or the list.
    """
    form = context.get("form")
    journey = context.get("journey")
    for value, what in ((form, "form"), (journey, "journey")):
        if _record(value) is not None or _items(value) is not None:
            assert_raw_depth(value, what)
    where = component_too_deep(form, journey)
    if where is not None:
        raise DefinitionTooDeepError(MAX_COMPONENT_DEPTH, f"The form has components nested too deeply (at {where}).")


def definition_depth(definition: Mapping[str, JsonValue] | Sequence[JsonValue]) -> int:
    """Return a definition's raw JSON depth (`json_depth`): what `MAX_DEFINITION_DEPTH` bounds."""
    return json_depth(definition)
