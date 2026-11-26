"""Header lookup on a plain mapping (names compare case-insensitively; Starlette's `Headers` already does)."""

from collections.abc import Callable, Mapping
from typing import cast


def header(headers: Mapping[str, str], name: str) -> str | None:
    """Return the first value of header `name`, or `None`; a `Headers` object answers its own way."""
    value = headers.get(name)
    if value is not None:
        return value
    wanted = name.casefold()
    for key, candidate in headers.items():
        if key.casefold() == wanted:
            return candidate
    return None


def header_list(headers: Mapping[str, str], name: str) -> str | None:
    """Return the field lines of a list-valued header `name` combined as RFC 9110 section 5.3 says, or `None`.

    A mapping that offers `getlist` (Starlette's `Headers`, multi-dict types) gives every line, joined with a comma
    and a space; any other mapping gives its value (every spelling of the name it holds, so a plain dict is not
    blind to a second line stored under another case). A single value comes back unchanged.
    """
    getlist = getattr(headers, "getlist", None)
    if callable(getlist):
        lines = cast("Callable[[str], list[str]]", getlist)(name)
        return ", ".join(lines) if lines else None
    wanted = name.casefold()
    found = [value for key, value in headers.items() if key.casefold() == wanted]
    return ", ".join(found) if found else None
