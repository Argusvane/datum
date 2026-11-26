"""`json_size`: the fewest bytes the compact UTF-8 JSON text of a tree can take, without building it."""

from json.encoder import encode_basestring
from typing import cast

from datum_sandbox.json._errors import BadDocumentError, RefusalReason
from datum_sandbox.json._number import format_double, format_int


def _string_size(text: str) -> int:
    try:
        return len(encode_basestring(text).encode("utf-8"))
    except UnicodeEncodeError as error:
        raise BadDocumentError(RefusalReason.LONE_SURROGATE, "lone surrogate") from error


def json_size(value: object) -> int:
    """Count the bytes of the shortest JSON text of `value` (no whitespace, minimal escapes, ECMAScript numbers).

    Iterative, so a deep tree cannot exhaust the stack. A value with no JSON form raises `BadDocumentError`.
    """
    total = 0
    stack: list[object] = [value]
    while stack:
        item = stack.pop()
        if item is None or item is True:
            total += 4
        elif item is False:
            total += 5
        elif isinstance(item, str):
            total += _string_size(item)
        elif isinstance(item, int):
            total += len(format_int(item))
        elif isinstance(item, float):
            total += len(format_double(item))
        elif isinstance(item, list | tuple):
            items = cast("list[object]", item)
            total += 2 + max(len(items) - 1, 0)
            stack.extend(items)
        elif isinstance(item, dict):
            mapping = cast("dict[object, object]", item)
            total += 2 + max(len(mapping) - 1, 0)
            for key, inner in mapping.items():
                if not isinstance(key, str):
                    raise BadDocumentError(RefusalReason.NO_JSON_FORM, "an object key is not a string")
                total += _string_size(key) + 1
                stack.append(inner)
        else:
            raise BadDocumentError(RefusalReason.NO_JSON_FORM, f"{type(item).__name__} has no JSON form")
    return total
