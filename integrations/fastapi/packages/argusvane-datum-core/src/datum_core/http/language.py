"""The `Accept-Language` reader (RFC 9110 12.5.4): the language a request prefers, framework-free.

Libraries: no parser of quality lists exists in the standard library (`locale`
reads the process, `email` and `http` do not parse this header), Starlette's `Headers` only splits a value into fields,
and `babel.Locale.negotiate` would be a new dependency that also needs the available locales up front. The parser
here is a few lines over a regular expression; a binding falls back to the process locale when it answers `None`.
"""

import re
from typing import Final

__all__ = ["preferred_language"]

_LANGUAGE_TAG: Final = re.compile(r"[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*")
_QUALITY: Final = re.compile(r"0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?")
_MAX_RANGES: Final = 64
"""A browser sends a handful of ranges; a longer list is read no further."""


def preferred_language(header: str | None) -> str | None:
    """Return the language with the highest weight in an `Accept-Language` value, first on a tie.

    `*`, a weight of 0, a malformed range and a malformed weight are skipped; `None` when nothing is left.
    """
    best: str | None = None
    best_weight = 0.0
    for item in (header or "").split(",", _MAX_RANGES)[:_MAX_RANGES]:
        tag, *parameters = (part.strip() for part in item.split(";"))
        if not _LANGUAGE_TAG.fullmatch(tag):
            continue
        weight = 1.0
        for parameter in parameters:
            name, _, value = parameter.partition("=")
            if name.strip().lower() == "q":
                value = value.strip()
                weight = float(value) if _QUALITY.fullmatch(value) else 0.0
        if weight > best_weight:
            best, best_weight = tag, weight
    return best
