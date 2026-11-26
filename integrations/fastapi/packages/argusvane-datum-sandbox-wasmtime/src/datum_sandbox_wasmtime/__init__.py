"""Datum's program runtime on wasmtime: the pinned QuickJS guest under argusvane-datum-core's run harness.

`WasmtimeProvider` is the `wasmtime` entry of the `datum.guest_runtimes` group and imports no wasmtime;
`WasmtimeGuestRuntime` (loaded on first access) does, and refuses an unsupported platform by name.
"""

from typing import TYPE_CHECKING

from datum_sandbox_wasmtime._provider import ENGINE_ID, WasmtimeProvider

if TYPE_CHECKING:
    from datum_sandbox_wasmtime._runtime import StartupTimings, WasmtimeGuestRuntime, WasmtimeInstance

__all__ = ["ENGINE_ID", "StartupTimings", "WasmtimeGuestRuntime", "WasmtimeInstance", "WasmtimeProvider"]

_LAZY = frozenset({"StartupTimings", "WasmtimeInstance", "WasmtimeGuestRuntime"})


def __getattr__(name: str) -> object:
    """Load the wasmtime-backed names on first access, so importing the package never imports wasmtime."""
    if name in _LAZY:
        from datum_sandbox_wasmtime import _runtime  # noqa: PLC0415 - imports wasmtime on purpose, late

        return getattr(_runtime, name)
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
