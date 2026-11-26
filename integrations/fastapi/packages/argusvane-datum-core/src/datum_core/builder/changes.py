"""`LocaleChanges`: the languages a save removes or renames, validated at construction.

Libraries: the standard library `dataclasses` and `re` hold it; a locale tag library
(`langcodes`, `babel`) would accept far more than the catalog's grammar and add a dependency for one regular expression.
"""

import re
from dataclasses import dataclass
from typing import Final

__all__ = ["MAX_LOCALES", "LocaleChanges", "is_locale_code"]

MAX_LOCALES: Final = 64
"""At most this many locales are named by one set of changes (a catalog holds at most 64 locales)."""
_LOCALE: Final = re.compile(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*")


def is_locale_code(code: object) -> bool:
    """Whether `code` is a locale code of the catalog's grammar: two to eight letters, then subtags of one to eight."""
    return isinstance(code, str) and _LOCALE.fullmatch(code) is not None


def _check(code: object) -> None:
    if not is_locale_code(code):
        raise ValueError("a locale code is a language of two to eight letters and optional subtags")


@dataclass(frozen=True, slots=True)
class LocaleChanges:
    """Locales a save removes (`removed`) and renames (`renamed`, pairs of old and new code)."""

    removed: tuple[str, ...] = ()
    renamed: tuple[tuple[str, str], ...] = ()

    def __post_init__(self) -> None:
        """Refuse a code outside the locale grammar and changes that contradict themselves or name too many."""
        named: set[str] = set()
        for code in self.removed:
            _check(code)
            if code in named:
                raise ValueError(f"the locale {code} is named twice")
            named.add(code)
        targets: set[str] = set()
        for old, new in self.renamed:
            _check(old)
            _check(new)
            if old == new:
                raise ValueError(f"the locale {old} is renamed to itself")
            if old in named:
                raise ValueError(f"the locale {old} is named twice")
            if new in targets:
                raise ValueError(f"the locale {new} is the target of two renames")
            named.add(old)
            targets.add(new)
        if len(self.removed) + len(self.renamed) > MAX_LOCALES:
            raise ValueError(f"at most {MAX_LOCALES} locales may be named")

    @classmethod
    def none(cls) -> "LocaleChanges":
        """Return the empty set of changes."""
        return cls()

    @property
    def is_empty(self) -> bool:
        """Say whether nothing is removed or renamed."""
        return not self.removed and not self.renamed
