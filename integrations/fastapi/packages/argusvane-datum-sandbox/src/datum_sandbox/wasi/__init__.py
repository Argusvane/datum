"""The generic hardened WASI run: what an engine implements, how one is found, and the thread-per-run harness.

Nothing here knows a Datum program. A run is a `GuestRun`: the files that become the guest's read-only `/app`, its
arguments, its stdin and its `RunBudget`. A `GuestRuntime` runs it and answers a `RunResult` (how it ended, every byte
written up to the caps). `RunHarness` is the engine-neutral half of a run (a worker thread per run, the slots, a private
read-only directory, bounded streams, the stop grace, the stray bound); an engine implements `GuestEngine` and registers
a `GuestRuntimeProvider` in the `datum.guest_runtimes` entry-point group, which `GuestRuntimes` discovers and selects
from. The layer's refusals are `WasiError`s; the layer above translates them once.

This package imports only the standard library (an import-linter contract holds it to that).
"""

from datum_sandbox.wasi._discovery import GROUP, DiscoveredRuntime, GuestRuntimes
from datum_sandbox.wasi._errors import (
    EngineConfigurationError,
    EngineSelectionError,
    GuestUnavailableError,
    MemoryFloorError,
    WasiError,
)
from datum_sandbox.wasi._harness import (
    EngineBusyError,
    EngineClosedError,
    EngineStrayBoundError,
    HarnessStats,
    RunHarness,
)
from datum_sandbox.wasi._protocols import (
    GuestEngine,
    GuestInstance,
    GuestIo,
    GuestRuntime,
    GuestRuntimeProvider,
    served_pools,
)
from datum_sandbox.wasi._records import (
    DEFAULT_POOL,
    LOGGER_NAME,
    STDERR_CAP,
    STDOUT_CAP,
    Availability,
    Available,
    EngineInfo,
    EngineLimits,
    EngineSettings,
    Entropy,
    GuestEnd,
    GuestEndKind,
    GuestRun,
    RunBudget,
    RunEnd,
    RunResult,
    RunTimings,
    Unavailable,
    default_stray_bound,
)
from datum_sandbox.wasi._streams import OutputSink

__all__ = [
    "DEFAULT_POOL",
    "GROUP",
    "LOGGER_NAME",
    "STDERR_CAP",
    "STDOUT_CAP",
    "Availability",
    "Available",
    "DiscoveredRuntime",
    "EngineBusyError",
    "EngineClosedError",
    "EngineConfigurationError",
    "EngineInfo",
    "EngineLimits",
    "EngineSelectionError",
    "EngineSettings",
    "EngineStrayBoundError",
    "Entropy",
    "GuestEnd",
    "GuestEndKind",
    "GuestEngine",
    "GuestInstance",
    "GuestIo",
    "GuestRun",
    "GuestRuntime",
    "GuestRuntimeProvider",
    "GuestRuntimes",
    "GuestUnavailableError",
    "HarnessStats",
    "MemoryFloorError",
    "OutputSink",
    "RunBudget",
    "RunEnd",
    "RunHarness",
    "RunResult",
    "RunTimings",
    "Unavailable",
    "WasiError",
    "default_stray_bound",
    "served_pools",
]
