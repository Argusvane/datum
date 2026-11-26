"""Start-up checks: the record, its levels, the configuration refusal, and the checks the sandbox itself raises.

A host keeps its own ids and constructors beside these (`datum_core.checks`); the record, the levels and the refusal are
one type for every Datum distribution, so a refusal raised here is the refusal a host catches.
"""

from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from enum import StrEnum
from typing import Final


class CheckLevel(StrEnum):
    """How serious a check is; only ERROR stops the start."""

    INFO = "INFO"
    WARNING = "WARNING"
    ERROR = "ERROR"


W008: Final = "datum.W008"  # a runtime budget clamped to its bound
E003: Final = "datum.E003"  # runtime memory below the module's initial pages
E004: Final = "datum.E004"  # the runtime did not start within datum.runtime.startup_budget

SANDBOX_CHECK_LEVELS: Final[dict[str, CheckLevel]] = {
    W008: CheckLevel.WARNING,
    E003: CheckLevel.ERROR,
    E004: CheckLevel.ERROR,
}
"""The ids this library raises and their levels (a host's registry lists them with its own)."""


@dataclass(frozen=True, slots=True)
class DatumCheck:
    """One start-up finding: a level, a stable id, a message and a one-line hint."""

    level: CheckLevel
    id: str
    msg: str
    hint: str = ""

    def __str__(self) -> str:
        """Render as ``(datum.W001) msg`` and, when there is a hint, ``HINT: hint`` on the next line."""
        text = f"({self.id}) {self.msg}"
        return f"{text}\nHINT: {self.hint}" if self.hint else text


class DatumConfigurationError(ValueError):
    """A configuration the start refuses; carries the ERROR checks (or a message and a hint) that explain why."""

    def __init__(self, message: str, *, hint: str = "", problems: Sequence[DatumCheck] = ()) -> None:
        """Keep the message, the one-line hint and the problems (checks) that caused the refusal."""
        super().__init__(message)
        self.message = message
        self.hint = hint
        self.problems: tuple[DatumCheck, ...] = tuple(problems)

    @classmethod
    def from_checks(cls, checks: Iterable[DatumCheck]) -> "DatumConfigurationError":
        """Gather ERROR checks into one error whose message lists them all."""
        found = tuple(checks)
        return cls("\n".join(str(check) for check in found), problems=found)


def raise_errors(checks: Iterable[DatumCheck]) -> None:
    """Raise every ERROR check together as one DatumConfigurationError; do nothing when there is none."""
    errors = [c for c in checks if c.level is CheckLevel.ERROR]
    if errors:
        raise DatumConfigurationError.from_checks(errors)


def budget_clamped(setting: str, asked: str, used: str, bound: str) -> DatumCheck:
    """``datum.W008``: a ``datum.runtime.*`` budget clamped to its bound."""
    return DatumCheck(CheckLevel.WARNING, W008, f"{setting} is {asked}; {used} is used", f"the bound is {bound}")


def memory_below_floor(setting: str, memory_bytes: int, floor_bytes: int) -> DatumCheck:
    """``datum.E003``: runtime memory below the module's initial pages times 64 KiB."""
    return DatumCheck(
        CheckLevel.ERROR,
        E003,
        f"{setting} is {memory_bytes} bytes, below the {floor_bytes} bytes the runtime module needs to start",
        f"set {setting} to at least {floor_bytes} bytes",
    )


def startup_over_budget(budget_seconds: float, phases: Sequence[tuple[str, float]]) -> DatumCheck:
    """``datum.E004``: the runtime did not start within ``datum.runtime.startup_budget``; names the phases so far."""
    measured = ", ".join(f"{name} {round(seconds, 2):g} s" for name, seconds in phases) or "none finished"
    return DatumCheck(
        CheckLevel.ERROR,
        E004,
        f"the Datum runtime did not start within datum.runtime.startup_budget ({budget_seconds:g} s); phases so far:"
        f" {measured}",
        "raise datum.runtime.startup_budget, or give the host more CPU: compiling the guest takes seconds on a VM",
    )
