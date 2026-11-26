"""Plain records the WASI layer hands around: what an engine is, what a run is, how it is budgeted and how it ended."""

import enum
import os
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from types import MappingProxyType
from typing import Final, cast

#: The output caps a budget has unless it says otherwise: what a guest may write before the run is ended as capped.
STDOUT_CAP: Final = 32 * 1024 * 1024
STDERR_CAP: Final = 64 * 1024

LOGGER_NAME: Final = "datum.runtime"
"""The logger the harness and discovery write on."""

DEFAULT_POOL: Final = "default"
"""The pool a budget runs in when it names none."""

_FORBIDDEN_IN_NAME: Final = frozenset("/\\\x00")


def default_stray_bound() -> int:
    """Return the default bound on guest threads that outlive their run: one per CPU this process may use, at least two.

    `os.process_cpu_count` (3.13, affinity-aware) when there is one, else `os.cpu_count`.
    """
    counter: Callable[[], int | None] = getattr(os, "process_cpu_count", os.cpu_count)
    return max(2, counter() or 1)


@dataclass(frozen=True, slots=True)
class EngineInfo:
    """What an engine says about itself: its id, its release, how it runs the guest, and free notes."""

    id: str
    release: str
    mode: str
    notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class EngineSettings:
    """Engine-independent settings: the stop grace in seconds and the stray bound."""

    stop_grace: float = 5.0
    stray_bound: int = field(default_factory=default_stray_bound)

    def __post_init__(self) -> None:
        """Refuse a grace below zero and a stray bound below one."""
        if self.stop_grace < 0:
            raise ValueError("EngineSettings.stop_grace must not be negative")
        if self.stray_bound < 1:
            raise ValueError("EngineSettings.stray_bound must be at least 1")


@dataclass(frozen=True, slots=True)
class EngineLimits:
    """What a provider needs to build a runtime: the slot pools, the work directory, the clock tick, the memory sizes.

    `pools` maps each pool's name to its slots (a run names its pool in `RunBudget.pool`). `memory_bytes` is the memory
    most runs are given and `max_memory_bytes` the largest any run is given: an engine sizes itself for them at start
    (wasmtime reserves address space from them); a run's own budget is still its limit. `module_path` and
    `module_sha256` name an own copy of the engine's guest module and its digest; both unset means the engine's own
    packaged module, and a digest names a copy, so it needs the path.
    """

    pools: Mapping[str, int]
    work_dir: Path
    tick_seconds: float = 0.05
    memory_bytes: int = 32 * 1024 * 1024
    max_memory_bytes: int = 256 * 1024 * 1024
    module_path: Path | None = None
    module_sha256: str | None = None

    def __post_init__(self) -> None:
        """Hold the pools to names and positive slots, the memories to positive bytes, a digest to a path."""
        pools = dict(self.pools)
        if not pools:
            raise ValueError("EngineLimits.pools names at least one pool")
        for name, slots in pools.items():
            if not isinstance(cast("object", name), str) or not name:
                raise ValueError("EngineLimits.pools are named by non-empty text")
            if isinstance(slots, bool) or not isinstance(cast("object", slots), int) or slots < 1:
                raise ValueError(f"EngineLimits.pools[{name!r}] must be at least one slot, not {slots!r}")
        object.__setattr__(self, "pools", MappingProxyType(pools))
        if self.module_sha256 is not None and self.module_path is None:
            raise ValueError("EngineLimits.module_sha256 names the digest of an own copy: give module_path as well")
        for name in ("memory_bytes", "max_memory_bytes"):
            value = getattr(self, name)
            if isinstance(value, bool) or not isinstance(value, int) or value <= 0:
                raise ValueError(f"EngineLimits.{name} must be a positive number of bytes, not {value!r}")


@dataclass(frozen=True, slots=True)
class RunBudget:
    """The budget of one run: wall time, guest memory, output caps, how long to wait for a slot (seconds), its pool."""

    wall_seconds: float
    memory_bytes: int
    stdout_cap: int = STDOUT_CAP
    stderr_cap: int = STDERR_CAP
    wait: float = 0.0
    pool: str = DEFAULT_POOL


def _checked_name(name: object) -> str:
    if not isinstance(name, str) or not name or name in {".", ".."} or _FORBIDDEN_IN_NAME.intersection(name):
        raise ValueError(f"a GuestRun file name is one plain name (no separator, not . or ..), not {name!r}")
    return name


@dataclass(frozen=True, slots=True)
class GuestRun:
    """One run: the files under the guest's read-only `/app` (name to bytes, in order), its arguments, stdin, budget.

    `app_files` are the only files the guest can open; each name is one plain file name. `argv` is a sequence of
    arguments (a bare `str` would become one argument per character, so it is refused). `timed` asks the harness for
    the run's `RunTimings`; a run that does not ask is not measured.
    """

    app_files: Mapping[str, bytes]
    argv: Sequence[str]
    stdin: bytes
    budget: RunBudget
    timed: bool = False

    def __post_init__(self) -> None:
        """Freeze the files in order, check every name and value, and refuse a bare string for `argv`."""
        files: dict[str, bytes] = {}
        for name, data in dict(self.app_files).items():
            if not isinstance(cast("object", data), bytes | bytearray | memoryview):
                raise TypeError(f"the GuestRun file {name!r} holds bytes, not {type(data).__name__}")
            files[_checked_name(name)] = bytes(data)
        object.__setattr__(self, "app_files", MappingProxyType(files))
        argv: object = self.argv
        if isinstance(argv, str | bytes):
            raise TypeError("argv must be a sequence of arguments, not a single string")
        object.__setattr__(self, "argv", tuple(cast("Sequence[str]", argv)))
        if not isinstance(cast("object", self.stdin), bytes):
            object.__setattr__(self, "stdin", bytes(self.stdin))


class RunEnd(enum.StrEnum):
    """How a run ended, in the harness's words."""

    CLEAN = "clean"
    EXIT = "exit"
    TRAP = "trap"
    BUDGET = "budget"
    MEMORY = "memory"
    OUTPUT_CAP = "output-cap"
    STUCK = "stuck"
    INTERRUPTED = "interrupted"
    """Stopped because the runtime was closed (the shutdown stop), not by anything the guest did."""


class GuestEndKind(enum.StrEnum):
    """The classes of end an engine reports for an exception out of the guest's start."""

    EXIT = "exit"
    TRAP = "trap"
    INTERRUPT = "interrupt"
    MEMORY = "memory"


@dataclass(frozen=True, slots=True)
class GuestEnd:
    """An engine's classification of an exception: `exit_code` is set for an exit, `detail` is for logs only."""

    kind: GuestEndKind
    exit_code: int | None = None
    detail: str = ""


@dataclass(frozen=True, slots=True)
class RunTimings:
    """Where a timed run's time went, in seconds: the slot wait, writing `/app`, instantiating, the guest's start."""

    slot_wait: float = 0.0
    prepare: float = 0.0
    instantiate: float = 0.0
    start: float = 0.0


@dataclass(frozen=True, slots=True)
class RunResult:
    """What a run produced: how it ended, the bounded streams, whether a cap cut either, its timings when asked."""

    end: RunEnd
    stdout: bytes
    stderr: bytes
    exit_code: int | None = None
    stdout_capped: bool = False
    stderr_capped: bool = False
    elapsed: float = 0.0
    detail: str = ""
    timings: RunTimings | None = None


@dataclass(frozen=True, slots=True)
class Available:
    """An engine that can run here; `notes` are for health and the docs."""

    notes: tuple[str, ...] = ()


@dataclass(frozen=True, slots=True)
class Unavailable:
    """An engine that cannot run here, with the reason it gives."""

    reason: str


type Availability = Available | Unavailable
type Entropy = Callable[[int], bytes]
