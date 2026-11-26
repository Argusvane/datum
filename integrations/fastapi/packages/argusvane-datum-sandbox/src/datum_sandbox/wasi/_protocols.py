"""The engine SPI: what an engine supplies (`GuestEngine`, `GuestRuntimeProvider`) and what callers see.

Nothing here imports an engine, a framework or a Datum type.
"""

from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from datum_sandbox.wasi._records import (
    Availability,
    EngineInfo,
    EngineLimits,
    EngineSettings,
    Entropy,
    GuestEnd,
    GuestRun,
    RunBudget,
    RunResult,
)
from datum_sandbox.wasi._streams import OutputSink


@dataclass(frozen=True, slots=True)
class GuestIo:
    """The streams and directory the harness hands the guest engine for one run.

    `app_dir` is the private read-only application directory (exactly the run's `GuestRun.app_files`); `stdin_path`
    is a sibling file outside it. The sinks are bounded and never raise.
    """

    app_dir: Path
    stdin_path: Path
    stdout: OutputSink
    stderr: OutputSink
    argv: tuple[str, ...]
    entropy: Entropy


class GuestInstance(Protocol):
    """One instantiated guest, created without being started. Owned by one run; closed by the harness."""

    def start(self) -> None:
        """Call the guest's `_start`; return on a plain return, raise whatever the engine raises otherwise."""
        ...

    def request_stop(self) -> None:
        """Note that the run must stop; callable from any thread, never raises, returns at once.

        It need not touch the running guest: the engine ends it at its own stop (a deadline it armed from the budget,
        or the shutdown stop) or at its next check, and a guest not yet started ends at its first check. An engine
        whose guest can wait inside a host call wakes that wait here.
        """
        ...

    def classify(self, error: BaseException, /) -> GuestEnd:
        """Classify an exception out of `start` as an exit with code, a trap, an interrupt or a memory end."""
        ...

    def close(self) -> None:
        """Release the instance; called once, after the guest has ended, on the worker thread."""
        ...


class GuestEngine(Protocol):
    """What an engine supplies to `RunHarness`: wire WASI, instantiate under the run's budget, without starting."""

    def instantiate(self, io: GuestIo, budget: RunBudget, /) -> GuestInstance:
        """Wire the streams, argv, entropy and directory and instantiate under the budget; do not start.

        The budget is the whole record of the run: the engine limits guest memory to `budget.memory_bytes` and may arm
        its own stop from `budget.wall_seconds` (the harness asks for a stop at the wall budget either way).
        """
        ...


class GuestRuntime(Protocol):
    """A runtime a caller runs guests on.

    A wrapper around another runtime forwards `engine_info()`: the layer above reads it to decide what may run. A
    runtime may also say which pools it serves with a `pools` attribute (a set of pool names, see `served_pools`); one
    that does not say serves every pool its runs name.
    """

    def run(self, run: GuestRun, /) -> RunResult:
        """Run `run` in the slots of the pool its budget names; return how it ended and what it wrote.

        Raises `EngineBusyError` when no slot came within the wait, `EngineStrayBoundError` while runs that would not
        stop fill the stray bound, `EngineClosedError` once the runtime is closed, and whatever the engine raises while
        instantiating.
        """
        ...

    def engine_info(self) -> EngineInfo:
        """Describe the engine behind this runtime."""
        ...

    def close(self) -> None:
        """Stop the runtime's clock and release what it holds."""
        ...


class GuestRuntimeProvider(Protocol):
    """What an engine registers in the `datum.guest_runtimes` entry-point group.

    `create` raises `EngineConfigurationError` (or its `MemoryFloorError`) for limits the engine cannot honour.
    """

    @property
    def id(self) -> str:
        """The engine id the provider answers to, equal to its entry-point name."""
        ...

    def availability(self) -> Availability:
        """Say whether the engine can run here: `Available(notes)` or `Unavailable(reason)`."""
        ...

    def create(self, limits: EngineLimits, engine_settings: EngineSettings, /) -> GuestRuntime:
        """Build a runtime for these limits."""
        ...


def served_pools(runtime: object) -> frozenset[str] | None:
    """Return the pool names `runtime` says it serves (its `pools` attribute), or `None` when it does not say.

    An attribute that is not a set of names counts as saying nothing it serves (an empty set): a runtime that answers
    something else cannot vouch for a pool.
    """
    pools: object = getattr(runtime, "pools", None)
    if pools is None:
        return None
    if isinstance(pools, frozenset | set) and all(isinstance(name, str) for name in pools):  # pyright: ignore[reportUnknownVariableType]
        return frozenset(str(name) for name in pools)  # pyright: ignore[reportUnknownVariableType, reportUnknownArgumentType]
    return frozenset()
