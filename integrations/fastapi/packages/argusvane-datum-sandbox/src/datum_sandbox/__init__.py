"""Datum's programs in a hardened WebAssembly sandbox, for any Python framework or none.

`DatumSandbox` is the lifecycle (start, status, recheck, stop; a context manager) over one engine, and
`SandboxSettings` the one immutable value holding every clamp of `datum.runtime.*` and `datum.host.*`, with `explain()`.
The layers underneath: `datum_sandbox.wasi` (the generic hardened WASI run, standard library only),
`datum_sandbox.protocol` (the Datum run protocol), `datum_sandbox.diagnostics` (the run trace, the failed-run capture,
the settings report), `datum_sandbox.aio` (the async facade, the `aio` extra) and `datum_sandbox.testing` (the kit an
engine's tests bind, the `testing` extra).
"""

from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.diagnostics import RunCaptureSink, RunTrace, SettingsReport, TraceRecord
from datum_sandbox.protocol import (
    PdfKernel,
    ProgramUnavailableError,
    RuleModule,
    Sandbox,
    SandboxError,
    SandboxResult,
)
from datum_sandbox.runtime import DatumSandbox, SandboxReady, SandboxSettings, SandboxState, SandboxStatus, TraceMode

__all__ = [
    "DatumConfigurationError",
    "DatumSandbox",
    "PdfKernel",
    "ProgramUnavailableError",
    "RuleModule",
    "RunCaptureSink",
    "RunTrace",
    "Sandbox",
    "SandboxError",
    "SandboxReady",
    "SandboxResult",
    "SandboxSettings",
    "SandboxState",
    "SandboxStatus",
    "SettingsReport",
    "TraceMode",
    "TraceRecord",
]
