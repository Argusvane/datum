"""`WasmtimeProvider`: the `wasmtime` entry in the `datum.guest_runtimes` entry-point group.

Importing this module never imports wasmtime, so discovery lists the provider on every platform; `availability()`
tries the binding and answers `Unavailable` naming the platform where it cannot load.
"""

from importlib import metadata
from pathlib import Path
from typing import Final

from datum_sandbox.wasi import (
    Availability,
    Available,
    EngineConfigurationError,
    EngineLimits,
    EngineSettings,
    GuestRuntime,
    Unavailable,
)
from datum_sandbox_wasmtime._platform import load_wasmtime

ENGINE_ID: Final = "wasmtime"
"""The engine id: the entry-point name, `EngineInfo.id` and `datum.runtime.engine`'s value for this runtime."""


class WasmtimeProvider:
    """Build `WasmtimeGuestRuntime`s; the entry point instantiates it with the defaults (the packaged guest).

    The memory sizes the engine's reservation follows come with the limits (`EngineLimits.memory_bytes` and
    `max_memory_bytes`), not from the provider.
    """

    def __init__(self, *, qjs_path: Path | None = None, qjs_sha256: str | None = None) -> None:
        """Keep the guest location (`datum.runtime.qjs_path` and `qjs_sha256`; the packaged guest by default)."""
        self._qjs_path = qjs_path
        self._qjs_sha256 = qjs_sha256

    @property
    def id(self) -> str:
        """The engine id, equal to the entry-point name."""
        return ENGINE_ID

    def availability(self) -> Availability:
        """`Available` with the wasmtime release where the binding loads, else `Unavailable` naming the platform."""
        try:
            load_wasmtime()
        except EngineConfigurationError as error:
            return Unavailable(error.message)
        return Available(notes=(f"wasmtime {metadata.version('wasmtime')}",))

    def create(self, limits: EngineLimits, engine_settings: EngineSettings, /) -> GuestRuntime:
        """Compile the guest and start the runtime (blocking: call it off the event loop)."""
        load_wasmtime()
        from datum_sandbox_wasmtime._runtime import WasmtimeGuestRuntime  # noqa: PLC0415 - imports wasmtime

        return WasmtimeGuestRuntime(limits, engine_settings, qjs_path=self._qjs_path, qjs_sha256=self._qjs_sha256)
