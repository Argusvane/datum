"""The bounded JSON reader: the standard library `json` behind a safety layer.

Steps: strict UTF-8 decode; a linear pre-scan outside strings (three regex passes) for nesting, number length and
integers that are not finite doubles; `json.loads` with `NaN`/`Infinity` and non-finite floats refused; one walk over
the decoded strings for a lone surrogate, run only when a surrogate escape is present. Duplicate keys: with
`unique_keys` (request bodies) an object that repeats a key is refused, since another reader of the same bytes may keep
another of its values; without it the last wins, as `JSON.parse` does, and a non-finite number shadowed by a later
duplicate is still refused (a documented strict superset of `JSON.parse`). The reader holds the GIL: call it on the
worker thread, never on the event loop.
"""

import json
import math
import re
from itertools import accumulate
from typing import NoReturn, cast

from datum_sandbox.json._errors import BadDocumentError, RefusalReason

type JsonValue = bool | int | float | str | list[JsonValue] | dict[str, JsonValue] | None

MAX_NUMBER = 1000  # a number token has at most this many characters (a leading minus counts)

# A string always matches (an unterminated one swallows the rest), which keeps the pass linear on hostile input;
# json.loads refuses such a document afterwards.
_STRING = r'"[^"\\]*(?:\\.?[^"\\]*)*(?:"|\Z)'
_STRINGS = re.compile(_STRING, re.DOTALL)
_LONG_NUMBER_PATTERN = rf"[-+0-9.eE]{{{MAX_NUMBER + 1},}}"
_LONG_NUMBER = re.compile(_LONG_NUMBER_PATTERN)
# An integer token of 309 or more digits may be an infinite double (JSON.parse gives Infinity); checked one by one.
_BIG_INT_PATTERN = r"(?<![0-9.eE+\-])-?[0-9]{309,}(?![0-9.eE])"
_BIG_INT = re.compile(_BIG_INT_PATTERN)
_NOT_BRACKET = re.compile(r"[^\[\]{}]+")
_STEP = {"[": 1, "{": 1, "]": -1, "}": -1}
_LOCATE = re.compile(f"{_STRING}|([\\[\\]{{}}])|({_LONG_NUMBER_PATTERN})|({_BIG_INT_PATTERN})", re.DOTALL)

_SURROGATE = re.compile("[\ud800-\udfff]")
# A lone surrogate can only come from a \uD800-\uDFFF escape: a document without such text skips the walk.
_SURROGATE_ESCAPE = re.compile(r"\\u[dD][89a-fA-F]")


_NUL_MESSAGE = "NUL character (U+0000) in an object key"
# A NUL is refused in object keys only (a string value may hold one). The cheap gate: a document with neither a raw NUL
# nor the spelling \u0000 (which may be an escaped backslash followed by "u0000", a false alarm the decode below
# clears) skips all work.
_AFTER_KEY = re.compile(r"\s*:")


def _locate_nul_key(text: str) -> BadDocumentError | None:
    """Return the refusal for the first object key that holds a NUL (raw or escaped), else `None`."""
    for match in _STRINGS.finditer(text):
        token = match.group()
        if "\x00" not in token and "\\u0000" not in token:
            continue
        if not _AFTER_KEY.match(text, match.end()):
            continue
        if "\x00" in token:
            return BadDocumentError(RefusalReason.NUL_CHARACTER, _NUL_MESSAGE, match.start())
        try:
            decoded = json.loads(token)
        except ValueError:
            continue  # malformed: the parse below reports it
        if "\x00" in decoded:
            return BadDocumentError(RefusalReason.NUL_CHARACTER, _NUL_MESSAGE, match.start())
    return None


def _escape_raw_nul(text: str) -> str:
    """Spell each raw NUL inside a string as an escape, so the strict parser keeps it in the value."""
    return _STRINGS.sub(lambda m: m.group().replace("\x00", "\\u0000"), text)


def _infinite(token: str) -> bool:
    try:
        float(int(token))
    except OverflowError:
        return True
    return False


def _locate(text: str, max_depth: int) -> BadDocumentError:
    """Failure path only: the first offending token in document order, with its position."""
    depth = 0
    for match in _LOCATE.finditer(text):
        bracket, long_number, big_int = match.group(1, 2, 3)
        if bracket:
            depth += _STEP[bracket]
            if depth > max_depth:
                return BadDocumentError(RefusalReason.NESTING, f"nesting deeper than {max_depth}", match.start())
        elif long_number:
            return BadDocumentError(
                RefusalReason.NUMBER_TOO_LONG, f"number token longer than {MAX_NUMBER} characters", match.start()
            )
        elif big_int and _infinite(big_int):
            return BadDocumentError(RefusalReason.NON_FINITE, "number is not finite", match.start())
    return BadDocumentError(RefusalReason.NESTING, f"nesting deeper than {max_depth}")  # pragma: no cover


def _prescan(text: str, max_depth: int) -> None:
    outside = _STRINGS.sub(" ", text)
    if _LONG_NUMBER.search(outside) or any(_infinite(m.group()) for m in _BIG_INT.finditer(outside)):
        raise _locate(text, max_depth)
    if outside.count("[") + outside.count("{") <= max_depth:
        return
    brackets = _NOT_BRACKET.sub("", outside)
    if max(accumulate(map(_STEP.__getitem__, brackets)), default=0) > max_depth:
        raise _locate(text, max_depth)


def _refuse_constant(name: str) -> NoReturn:
    raise BadDocumentError(RefusalReason.NON_FINITE, f"{name} is not a JSON value")


def _parse_float(token: str) -> float:
    value = float(token)
    if not math.isfinite(value):
        raise BadDocumentError(RefusalReason.NON_FINITE, "number is not finite")
    return value


def _scan_surrogates(value: object) -> None:
    stack: list[object] = [value]
    search = _SURROGATE.search
    while stack:
        item = stack.pop()
        if isinstance(item, str):
            if search(item):
                raise BadDocumentError(RefusalReason.LONE_SURROGATE, "lone surrogate")
        elif isinstance(item, dict):
            for key, inner in cast("dict[str, object]", item).items():
                if search(key):
                    raise BadDocumentError(RefusalReason.LONE_SURROGATE, "lone surrogate")
                stack.append(inner)
        elif isinstance(item, list):
            stack.extend(cast("list[object]", item))


def _unique_object(pairs: list[tuple[str, JsonValue]]) -> dict[str, JsonValue]:
    made = dict(pairs)
    if len(made) != len(pairs):
        raise BadDocumentError(RefusalReason.DUPLICATE_KEY, "an object repeats a key")
    return made


def read(body: bytes | bytearray, *, max_depth: int, unique_keys: bool = False) -> JsonValue:
    """Read one untrusted JSON document; every refusal is a `BadDocumentError`.

    `max_depth` is 256 for request bodies, 512 for answer JSON and 8 for passkey client data. `unique_keys` refuses an
    object that repeats a key (`RefusalReason.DUPLICATE_KEY`); request bodies are read with it. The body is `bytes` or
    `bytearray` only: anything else (a `memoryview`, a `str`) is a caller error and raises `TypeError`.
    """
    if not isinstance(cast("object", body), bytes | bytearray):
        raise TypeError(f"read() takes bytes or bytearray, not {type(body).__name__}")
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise BadDocumentError(RefusalReason.NOT_UTF8, "not valid UTF-8", error.start) from None
    has_raw_nul = "\x00" in text
    if (has_raw_nul or "\\u0000" in text) and (refusal := _locate_nul_key(text)) is not None:
        raise refusal
    _prescan(text, max_depth)
    if has_raw_nul:
        text = _escape_raw_nul(text)
    try:
        value: JsonValue = json.loads(
            text,
            parse_constant=_refuse_constant,
            parse_float=_parse_float,
            object_pairs_hook=_unique_object if unique_keys else None,
        )
    except BadDocumentError:
        raise
    except json.JSONDecodeError as error:
        raise BadDocumentError(RefusalReason.SYNTAX, f"not valid JSON: {error.msg}", error.pos) from None
    except (ValueError, RecursionError):
        raise BadDocumentError(RefusalReason.SYNTAX, "not valid JSON") from None
    if _SURROGATE_ESCAPE.search(text):
        _scan_surrogates(value)
    return value
