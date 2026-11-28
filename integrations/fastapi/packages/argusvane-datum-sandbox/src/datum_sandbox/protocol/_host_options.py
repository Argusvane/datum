"""The context keys the host decides (`today` and the two policies): `HostOptions`.

They are set over every validation context, so a submitter cannot relax the formula or pattern policy by sending its own
keys. The policy words are `datum.host.formula_errors` and `datum.host.risky_patterns`; a word the program does not read
is refused when the options are built, never read as the default.
"""

import enum
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Final, Self, cast
from zoneinfo import ZoneInfo

from datum_sandbox.json import JsonValue

HOST_KEYS: Final = ("today", "formulaErrors", "riskyPatterns")
"""The context keys the host decides, in the order they are written."""


class _Word(enum.StrEnum):
    """A closed set of words, matched case-folded; any other word is refused naming the allowed ones."""

    @classmethod
    def _missing_(cls, value: object) -> Self | None:
        if isinstance(value, str):
            folded = value.strip().casefold()
            for member in cls:
                if member.value == folded:
                    return member
        return None


class FormulaErrors(_Word):
    """What a formula that cannot be evaluated does (`datum.host.formula_errors`)."""

    FAIL = "fail"
    WARN = "warn"


class RiskyPatterns(_Word):
    """What a regular expression that repeats a repeat does (`datum.host.risky_patterns`)."""

    REFUSE = "refuse"
    ALLOW = "allow"


def _utc_now() -> datetime:
    return datetime.now(UTC)


@dataclass(frozen=True, slots=True)
class HostOptions:
    """The host's policies and the zone `today` is read in; `now` is the clock (aware datetimes)."""

    formula_errors: FormulaErrors = FormulaErrors.FAIL
    risky_patterns: RiskyPatterns = RiskyPatterns.REFUSE
    time_zone: ZoneInfo = field(default_factory=lambda: ZoneInfo("UTC"))
    now: Callable[[], datetime] = _utc_now

    def __post_init__(self) -> None:
        """Hold each policy to its word set (a plain string is read case-folded; any other word is refused)."""
        object.__setattr__(self, "formula_errors", FormulaErrors(self.formula_errors))
        object.__setattr__(self, "risky_patterns", RiskyPatterns(self.risky_patterns))
        if not isinstance(cast("object", self.time_zone), ZoneInfo):
            raise TypeError("HostOptions.time_zone is a zoneinfo.ZoneInfo")

    def today(self) -> str:
        """Return today's date in the host's zone as ``YYYY-MM-DD``; a naive clock reading is refused."""
        moment = self.now()
        if moment.tzinfo is None or moment.utcoffset() is None:
            raise ValueError("the clock answered a naive datetime; Datum's clock is aware")
        return moment.astimezone(self.time_zone).date().isoformat()

    def context_keys(self) -> dict[str, str]:
        """Return `today`, `formulaErrors` and `riskyPatterns`, in that order."""
        return {
            "today": self.today(),
            "formulaErrors": self.formula_errors.value,
            "riskyPatterns": self.risky_patterns.value,
        }

    def merged(self, context: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        """Return a shallow copy of a validation context with the host's keys set over whatever it carried."""
        merged = dict(context)
        merged.update(self.context_keys())
        return merged
