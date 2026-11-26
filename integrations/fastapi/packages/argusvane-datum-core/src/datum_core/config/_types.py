"""Value types of the settings tree: Seconds, Size, the word enum and the did-you-mean helper."""

import difflib
from collections.abc import Callable, Iterable
from datetime import timedelta
from enum import StrEnum
from typing import Annotated, Any, Self

from pydantic import BeforeValidator, ByteSize, GetCoreSchemaHandler
from pydantic.json_schema import WithJsonSchema
from pydantic_core import CoreSchema, PydanticCustomError, core_schema

WORD_CUTOFF = 0.6
"""Short words ("fial" for "fail") need a lenient cutoff."""
NAME_CUTOFF = 0.85
"""Environment names are long; 0.85 keeps DATUM_PORT from being offered DATUM_RUNTIME (0.70) or DATUM_HOST (0.80)."""


def closest(word: str, candidates: Iterable[str], *, cutoff: float) -> str | None:
    """Return the one candidate closest to ``word`` at or above ``cutoff``, compared case-folded, else None."""
    pool = {c.casefold(): c for c in candidates}
    found = difflib.get_close_matches(word.casefold(), list(pool), n=1, cutoff=cutoff)
    return pool[found[0]] if found else None


class DatumWord(StrEnum):
    """A closed set of words, matched case-folded; a bad word names the allowed ones and the closest."""

    @classmethod
    def _missing_(cls, value: object) -> Self | None:
        if not isinstance(value, str):
            return None
        folded = value.casefold()
        for member in cls:
            if member.value.casefold() == folded:
                return member
        raise ValueError(_refusal(cls, value))

    @classmethod
    def __get_pydantic_core_schema__(cls, source: type[Any], handler: GetCoreSchemaHandler) -> CoreSchema:
        inner = handler(source)

        def wrap(value: Any, validate: Callable[[Any], Any]) -> Any:  # noqa: ANN401 - pydantic's wrap signature
            if isinstance(value, str) and not isinstance(value, cls):
                try:
                    return cls(value)
                except ValueError as error:
                    raise PydanticCustomError("datum_word", "{message}", {"message": str(error)}) from None
            return validate(value)

        return core_schema.no_info_wrap_validator_function(wrap, inner)


def _refusal(word_type: type[StrEnum], value: str) -> str:
    allowed = [m.value for m in word_type]
    message = "Input should be " + ", ".join(repr(a) for a in allowed)
    near = closest(value, allowed, cutoff=WORD_CUTOFF)
    return f"{message}; did you mean {near!r}?" if near else message


def _not_bool(value: Any) -> Any:  # noqa: ANN401 - a before-validator sees anything
    """Refuse a bool: pydantic reads True as 1 (one second, one byte), which no setting means."""
    if isinstance(value, bool):
        raise PydanticCustomError("datum_not_bool", "Input should be a number, not a boolean")
    return value


def _to_seconds(value: Any) -> Any:  # noqa: ANN401 - a before-validator sees anything
    """Plain numeric strings become numbers ("5", "5.5"); ISO 8601 ("PT5S") and numbers pass to pydantic."""
    value = _not_bool(value)
    if isinstance(value, str):
        try:
            return float(value)
        except ValueError:
            return value
    return value


_SECONDS_SCHEMA = {
    "anyOf": [
        {"type": "number", "minimum": 0},
        {"type": "string", "format": "duration"},
    ],
    "description": "A number of seconds, or an ISO 8601 duration such as PT5S.",
}
_SIZE_SCHEMA = {
    "anyOf": [
        {"type": "integer", "minimum": 0},
        {"type": "string", "pattern": r"^\s*[0-9.]+\s*[KMGTPE]?i?B?\s*$"},
    ],
    "description": "Bytes as an integer, or a size such as 32MiB (binary) or 32MB (decimal).",
}

# Plain aliases, not PEP 695 `type`: Field constraints apply to the inline schema, not to a named definition.
Seconds = Annotated[timedelta, BeforeValidator(_to_seconds), WithJsonSchema(_SECONDS_SCHEMA)]
"""A duration: ``5``, ``"5.5"`` or ``"PT5S"``; a bool is refused. The schema carries a number alternative."""

Size = Annotated[ByteSize, BeforeValidator(_not_bool), WithJsonSchema(_SIZE_SCHEMA)]
Count = Annotated[int, BeforeValidator(_not_bool)]
"""A byte count: ``32MiB`` is 33,554,432 and ``32MB`` is 32,000,000 (pydantic's ByteSize); a bool is refused."""

OFF = "off"
"""The word that turns a limit off where a file or the environment cannot write None (TOML has no null, and an empty
environment value means unset)."""


def _off_or_count(value: Any) -> Any:  # noqa: ANN401 - a before-validator sees anything
    """Turn the word `off` (any case, spaces around ignored) into None; refuse a bool; pass anything else on."""
    value = _not_bool(value)
    if isinstance(value, str) and value.strip().casefold() == OFF:
        return None
    return value


_LIMIT_OR_OFF_SCHEMA = {
    "anyOf": [{"type": "integer", "minimum": 1}, {"type": "null"}, {"const": OFF}],
}

LimitOrOff = Annotated[int | None, BeforeValidator(_off_or_count), WithJsonSchema(_LIMIT_OR_OFF_SCHEMA)]
"""A whole number of at least 1 (the field states `ge=1`), or off: None, or the word ``off`` from a file or the
environment. A bool is refused."""
