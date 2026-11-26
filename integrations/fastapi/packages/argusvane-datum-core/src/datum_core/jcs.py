"""RFC 8785 JSON Canonicalization, and the writer the digest form shares.

Built on: the standard library `json` writes floats with `repr` and cannot order keys by UTF-16 code unit;
`rfc8785` 0.1.4 refuses integers of 2^53 and above, which the engine writes as doubles, and is several times slower, so
it stays a test-scope cross-check. Pydantic has no canonical form. The number formatter is `datum_sandbox.json`'s.
"""

import hashlib
from collections.abc import Callable, Iterable
from json.encoder import encode_basestring
from typing import cast

from datum_sandbox.json import BadDocumentError, RefusalReason, format_double, format_int

type KeyOrder = Callable[[Iterable[str]], list[str]]

__all__ = ["format_number", "jcs_bytes", "jcs_digest", "render"]


def format_number(value: float) -> str:
    """Write an int or float as ECMAScript does (an integer beyond 2^53 as the double)."""
    if isinstance(value, int) and not isinstance(value, bool):
        return format_int(value)
    return format_double(value)


def _utf16(key: str) -> bytes:
    return key.encode("utf-16-be")  # UnicodeEncodeError on a lone surrogate


def code_unit_order(keys: Iterable[str]) -> list[str]:
    """Sort keys by UTF-16 code unit."""
    return sorted(keys, key=_utf16)


def _write(value: object, out: list[str], order: KeyOrder) -> None:  # noqa: C901, PLR0912
    stack: list[object] = [value]
    while stack:
        item = stack.pop()
        if isinstance(item, _Literal):
            out.append(item.text)
        elif item is None:
            out.append("null")
        elif item is True:
            out.append("true")
        elif item is False:
            out.append("false")
        elif isinstance(item, str):
            out.append(encode_basestring(item))
        elif isinstance(item, int):
            out.append(format_int(item))
        elif isinstance(item, float):
            out.append(format_double(item))
        elif isinstance(item, list | tuple):
            out.append("[")
            stack.append(_Literal("]"))
            items = cast("list[object]", item)
            for index in range(len(items) - 1, -1, -1):
                stack.append(items[index])
                if index:
                    stack.append(_Literal(","))
        elif isinstance(item, dict):
            mapping = cast("dict[object, object]", item)
            if not all(isinstance(key, str) for key in mapping):
                raise BadDocumentError(RefusalReason.NO_JSON_FORM, "an object key is not a string")
            out.append("{")
            stack.append(_Literal("}"))
            strings = cast("dict[str, object]", mapping)
            keys = order(strings.keys())
            for index in range(len(keys) - 1, -1, -1):
                key = keys[index]
                stack.append(strings[key])
                stack.append(_Literal(encode_basestring(key) + ":"))
                if index:
                    stack.append(_Literal(","))
        else:
            raise BadDocumentError(RefusalReason.NO_JSON_FORM, f"{type(item).__name__} has no JSON form")


class _Literal:
    __slots__ = ("text",)

    def __init__(self, text: str) -> None:
        self.text = text


def render(value: object, order: KeyOrder) -> bytes:
    """Write `value` as compact JSON with keys in `order`; the strict UTF-8 encode is the lone-surrogate check."""
    out: list[str] = []
    try:
        _write(value, out, order)
        return "".join(out).encode("utf-8")
    except UnicodeEncodeError as error:
        raise BadDocumentError(RefusalReason.LONE_SURROGATE, "lone surrogate") from error


def jcs_bytes(value: object) -> bytes:
    """RFC 8785 canonical UTF-8 bytes: every key by UTF-16 code unit."""
    return render(value, code_unit_order)


def jcs_digest(value: object) -> str:
    """SHA-256 (hex) over the JCS bytes."""
    return hashlib.sha256(jcs_bytes(value)).hexdigest()
