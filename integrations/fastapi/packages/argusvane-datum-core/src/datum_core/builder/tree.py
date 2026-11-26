"""What the builder asks of a tree before it trusts it: its size, whether it is strict JSON, its numbers, its depth.

One iterative walk (a hostile tree costs no stack) answers every stage at once, because the stages are ordered and a
fault found early belongs to a later stage: the size is judged before the hash even for a tree that is not JSON (a lone
surrogate, a key that is not text, a non-finite number), strict JSON before the shape, finite numbers after the language
changes. `json_size` and the canonical writer stop at the first fault with one refusal, so they cannot place it.

The size counted is the one `json_size` counts (the fewest bytes of the compact UTF-8 JSON text, ECMAScript numbers):
the walk writes each scalar with the same primitives. Where the tree has no JSON text, the count is a floor: a lone
surrogate is counted as its UTF-8 bytes and a number JSON cannot write as `null`.

Strict JSON is the tree the bounded JSON reader builds: objects are `dict` with text keys (no NUL in a key), arrays are
`list`,
scalars are text, booleans, `None`, `int` and `float`. A text holding a lone surrogate is not JSON.
"""

import math
import re
from dataclasses import dataclass
from json.encoder import encode_basestring
from typing import Final, cast

from datum_sandbox.json import BadDocumentError, format_double, format_int

__all__ = ["TreeReading", "read_tree"]

_SURROGATE: Final = re.compile("[\ud800-\udfff]")
_NULL_BYTES: Final = 4
_FALSE_BYTES: Final = 5

NOT_TEXT_KEY: Final = "An object key is not text."
LONE_SURROGATE: Final = "A text holds a lone surrogate, which JSON cannot carry."
NUL_KEY: Final = "An object key holds a NUL character."
NO_JSON_FORM: Final = "A value has no JSON form."


@dataclass(frozen=True, slots=True)
class TreeReading:
    """The facts of one tree: its JSON size, the first strict-JSON fault, a non-finite number, its nesting depth.

    `fault` is fixed words naming the kind of fault, never the tree's text. `depth` is `json_depth`'s: a scalar is 1,
    a container one more than its deepest member, an empty container 2.
    """

    size: int
    fault: str | None
    non_finite: bool
    depth: int


def _text_size(text: str) -> int:
    return len(encode_basestring(text).encode("utf-8", "surrogatepass"))


def _number_size(value: int | float) -> int | None:
    """Count the bytes of the number's JSON text; None when JSON cannot write it (non-finite, past a double)."""
    try:
        return len(format_int(value) if isinstance(value, int) else format_double(value))
    except BadDocumentError:
        return None


def read_tree(value: object, limit: int | None = None) -> TreeReading:  # noqa: PLR0912 - one arm per JSON kind, one walk on purpose
    """Read `value` once, iteratively: its size, the first strict-JSON fault, a non-finite number, its depth.

    With a `limit` the walk stops once the size passes it, so a tree that contains itself ends (every container adds
    bytes); the reading is then partial and the caller judges the size first.
    """
    size = 0
    fault: str | None = None
    non_finite = False
    depth = 1
    stack: list[tuple[object, int]] = [(value, 1)]
    while stack:
        if limit is not None and size > limit:
            break
        item, level = stack.pop()
        if item is None or item is True:
            size += _NULL_BYTES
        elif item is False:
            size += _FALSE_BYTES
        elif isinstance(item, str):
            size += _text_size(item)
            if fault is None and _SURROGATE.search(item) is not None:
                fault = LONE_SURROGATE
        elif isinstance(item, int | float):
            counted = _number_size(item)
            if counted is None or (isinstance(item, float) and not math.isfinite(item)):
                non_finite = True
                counted = _NULL_BYTES
            size += counted
        elif isinstance(item, list):
            members = cast("list[object]", item)
            size += 2 + max(len(members) - 1, 0)
            depth = max(depth, level + 1)
            stack.extend((member, level + 1) for member in members)
        elif isinstance(item, dict):
            record = cast("dict[object, object]", item)
            size += 2 + max(len(record) - 1, 0)
            depth = max(depth, level + 1)
            for key, member in record.items():
                if isinstance(key, str):
                    size += _text_size(key) + 1
                    if fault is None and _SURROGATE.search(key) is not None:
                        fault = LONE_SURROGATE
                    if fault is None and "\x00" in key:
                        fault = NUL_KEY
                else:
                    size += 3  # the quotes and the colon of a key that has no text
                    fault = fault or NOT_TEXT_KEY
                stack.append((member, level + 1))
        else:
            fault = fault or NO_JSON_FORM
    return TreeReading(size, fault, non_finite, depth)
