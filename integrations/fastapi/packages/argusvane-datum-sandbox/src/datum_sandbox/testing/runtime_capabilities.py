"""What an engine under the runtime contracts declares it cannot do, and how a contract test reads the declaration.

An engine's test module subclasses the contract classes and sets `capabilities` (the same idea as SQLAlchemy's
`exclusions`): nothing declared means the engine is held to every contract. A capability the engine lacks is declared
with its reason, and every test that needs it becomes `xfail(strict=True)`, so a limit that gets fixed turns the
test red until the declaration is removed. An engine that is not registered at all (`registered=False`) has its
tests skipped, not failed: the contract binding can exist before the engine does.
"""

import enum
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Final, TypeVar

_REQUIRES: Final = "__datum_requires__"
_F = TypeVar("_F", bound=Callable[..., object])


class Capability(enum.StrEnum):
    """One thing a contract test needs from the engine; the tests that need it name it with `requires`."""

    PDF = "pdf"
    """The engine runs the PDF program (it serves the `pdf` pool and its report answers: `can_run_pdf`)."""
    READ_ONLY_APP = "read-only-app"
    """The guest's `/app` is read-only and nothing outside it is reachable."""
    BUDGET_STOP = "budget-stop"
    """A looping guest is stopped at its wall budget and the next run answers."""
    OUTPUT_CAP = "output-cap"
    """Output past a cap is dropped (never stored), flagged, and the run ends within its budget."""
    MEMORY_STOP = "memory-stop"
    """A guest that allocates without end stops at the memory budget with its output kept."""
    STACK_TRAP = "stack-trap"
    """Runaway recursion ends as a trap with its output kept."""
    SHUTDOWN_STOP = "shutdown-stop"
    """Closing the runtime stops runs in flight, classified as interrupted."""
    SETTLED_RUNS = "settled-runs"
    """A hundred settled runs add no thread and only bounded memory."""


@dataclass(frozen=True, slots=True)
class RuntimeCapabilities:
    """The declaration an engine's test class makes: which capabilities it lacks (with reasons) and whether it exists.

    `lacks` maps a `Capability` to the reason it is missing; an empty mapping (the default) holds the engine to every
    contract. `registered=False` says the engine is not installed or not registered yet: its tests are skipped.
    """

    lacks: Mapping[Capability, str] = field(default_factory=dict[Capability, str])
    registered: bool = True
    unregistered_reason: str = "the engine is not registered"

    def __post_init__(self) -> None:
        """Freeze the mapping and refuse a declaration without a reason."""
        frozen: Mapping[Capability, str] = MappingProxyType(
            {Capability(key): value for key, value in self.lacks.items()}
        )
        for key, reason in frozen.items():
            if not reason.strip():
                raise ValueError(f"the declared limit {key.value!r} needs a reason")
        object.__setattr__(self, "lacks", frozen)

    def missing(self, needed: Iterable[Capability]) -> dict[Capability, str]:
        """Return the needed capabilities this declaration lacks, with their reasons."""
        return {cap: self.lacks[cap] for cap in needed if cap in self.lacks}


def requires(*needed: Capability) -> Callable[[_F], _F]:
    """Mark a contract test as needing these capabilities: the engine's declaration decides xfail or not."""

    def mark(function: _F) -> _F:
        setattr(function, _REQUIRES, (*required_by(function), *needed))
        return function

    return mark


def required_by(function: object) -> tuple[Capability, ...]:
    """Return the capabilities a test function was marked with by `requires`."""
    marked: tuple[Capability, ...] = getattr(function, _REQUIRES, ())
    return marked
