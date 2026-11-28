"""The host's own reading of a definition's shape (`DefinitionShape`): what the kernel would never be asked.

Run before any hook or guest, and again on what the customizers left. A value that is not an object is refused; then
the raw and component depth (`assert_shallow`, iterative); then the version's length, the root, every component's id and
type, and the sandbox ABI's floors: 10,000 components, 2000 options a component and 50,000 in all. At most 200 problems
are reported. The walk is iterative and stops once a floor is passed, so a hostile tree costs one bounded pass.

A problem's message is fixed words; its field is where it is (`definition`, `root`, or `root > slot > id` as the kernel
writes a location, an id longer than 64 characters named by its position).
"""

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final, cast

from datum_core.builder.outcomes import Refused
from datum_core.hooks import HookProblem
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import DefinitionTooDeepError, assert_shallow

__all__ = [
    "MAX_COMPONENTS",
    "MAX_OPTIONS",
    "MAX_OPTIONS_IN_ALL",
    "MAX_PROBLEMS",
    "MAX_VERSION_LENGTH",
    "read_shape",
    "version_of",
]

MAX_COMPONENTS: Final = 10_000
"""The most components a definition holds, the root's included."""
MAX_OPTIONS: Final = 2000
"""The most options one component lists."""
MAX_OPTIONS_IN_ALL: Final = 50_000
"""The most options a definition lists in all."""
MAX_PROBLEMS: Final = 200
"""The most problems one refusal reports."""
MAX_VERSION_LENGTH: Final = 64
"""The longest version a definition carries."""

REFUSED: Final = "definition.refused"
TOO_DEEP: Final = "definition.tooDeep"
_WHOLE: Final = "definition"
_ID_LABEL: Final = 64
_SLOT_LABEL: Final = 32


def version_of(definition: Mapping[str, JsonValue] | object) -> str:
    """Return the version as text: a string as is, an integer written out, anything else (or none) empty."""
    held = cast("Mapping[str, object]", definition).get("version") if isinstance(definition, Mapping) else None
    if isinstance(held, str):
        return held
    if isinstance(held, int) and not isinstance(held, bool):
        return str(held)
    return ""


@dataclass(frozen=True, slots=True)
class _Component:
    """One component of the walk; its location is a parent link written out only for a component reported."""

    node: Mapping[str, object]
    level: int
    parent: "_Component | None"
    slot: str
    label: str

    def where(self) -> str:
        parts: list[str] = []
        at: _Component | None = self
        while at is not None:
            parts.append(at.label)
            if at.parent is not None:
                parts.append(at.slot)
            at = at.parent
        return " > ".join(reversed(parts))


def _refused(*problems: HookProblem) -> Refused:
    return Refused(REFUSED, problems[:MAX_PROBLEMS])


def read_shape(value: object) -> Refused | None:
    """Refuse a definition whose shape the host reads as wrong, or answer None (the kernel judges the rest).

    `value` is strict JSON (`read_tree` found no fault). A tree nested too deep is `definition.tooDeep` with the depth
    guard's error as its cause; every other problem is one error of a `definition.refused`.
    """
    if not isinstance(value, dict):
        return _refused(HookProblem(_WHOLE, "definition.notRecord", "A form definition is a JSON object."))
    definition = cast("dict[str, JsonValue]", value)
    try:
        assert_shallow(definition)
    except DefinitionTooDeepError as error:
        problem = HookProblem(_WHOLE, TOO_DEEP, "The definition is nested too deeply.")
        return Refused(TOO_DEEP, (problem,), error)
    problems: list[HookProblem] = []
    version = definition.get("version")
    if isinstance(version, str) and len(version) > MAX_VERSION_LENGTH:
        problems.append(
            HookProblem(_WHOLE, "definition.version.tooLong", f"A version is at most {MAX_VERSION_LENGTH} characters.")
        )
    root = definition.get("root")
    if not isinstance(root, dict):
        problems.append(HookProblem(_WHOLE, "definition.root.missing", "A form definition has a root component."))
        return _refused(*problems)
    if root.get("type") != "form":
        problems.append(HookProblem("root", "definition.root.type", "The root component is a form."))
    problems.extend(_components(cast("Mapping[str, object]", root)))
    return _refused(*problems) if problems else None


def _components(root: Mapping[str, object]) -> list[HookProblem]:
    """Walk the component tree from the root: ids, types, the component and option floors."""
    problems: list[HookProblem] = []
    count = 0
    options_in_all = 0
    stack = [_Component(root, 1, None, "", "root")]
    while stack and len(problems) < MAX_PROBLEMS:
        top = stack.pop()
        count += 1
        if count > MAX_COMPONENTS:
            problems.append(
                HookProblem(
                    _WHOLE, "definition.tooManyComponents", f"A form holds at most {MAX_COMPONENTS} components."
                )
            )
            break
        node = top.node
        component_id, component_type = node.get("id"), node.get("type")
        if not isinstance(component_id, str) or not component_id:
            problems.append(HookProblem(top.where(), "component.id.invalid", "A component has an id of text."))
        if not isinstance(component_type, str) or not component_type:
            problems.append(HookProblem(top.where(), "component.type.invalid", "A component has a type of text."))
        configuration = node.get("configuration")
        options = cast("dict[str, object]", configuration).get("options") if isinstance(configuration, dict) else None
        if isinstance(options, list):
            listed = len(cast("list[object]", options))
            options_in_all += listed
            if listed > MAX_OPTIONS:
                problems.append(
                    HookProblem(top.where(), "option.tooMany", f"A component lists at most {MAX_OPTIONS} options.")
                )
            if options_in_all > MAX_OPTIONS_IN_ALL:
                problems.append(
                    HookProblem(_WHOLE, "option.tooMany", f"A form lists at most {MAX_OPTIONS_IN_ALL} options in all.")
                )
                break
        stack.extend(_children(top))
    return problems


def _children(parent: _Component) -> list[_Component]:
    """List the object members of each list slot of `children`, the last first so the walk reads them in order."""
    slots = parent.node.get("children")
    if not isinstance(slots, dict):
        return []
    found: list[_Component] = []
    for slot, members in cast("dict[str, object]", slots).items():
        if not isinstance(members, list):
            continue
        slot_label = slot if len(slot) <= _SLOT_LABEL else "?"
        for index, member in enumerate(cast("list[object]", members)):
            if isinstance(member, dict):
                child = cast("dict[str, object]", member)
                child_id = child.get("id")
                label = child_id if isinstance(child_id, str) and 0 < len(child_id) <= _ID_LABEL else f"#{index}"
                found.append(_Component(child, parent.level + 1, parent, slot_label, label))
    found.reverse()
    return found
