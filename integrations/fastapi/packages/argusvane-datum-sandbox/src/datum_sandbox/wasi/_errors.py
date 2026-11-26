"""The WASI layer's refusals: one small family, translated once by the layer above into the host's own errors.

`EngineConfigurationError` and its two kinds are refusals of the engine's configuration (limits it cannot honour, an
engine that cannot be selected); `GuestUnavailableError` is an engine that cannot run a guest at all. The harness's
`EngineBusyError`, `EngineStrayBoundError` and `EngineClosedError` are not here: they are a run's admission, not a
configuration.
"""


class WasiError(Exception):
    """The base of the WASI layer's refusals."""


class EngineConfigurationError(WasiError, ValueError):
    """Limits or a selection the engine refuses; `message` says what, `hint` (one line) what to do about it."""

    def __init__(self, message: str, *, hint: str = "") -> None:
        """Keep the message and the hint."""
        super().__init__(message)
        self.message = message
        self.hint = hint


class MemoryFloorError(EngineConfigurationError):
    """A memory below what the guest module needs to start: `setting` names it, `memory_bytes` and `floor_bytes`."""

    def __init__(self, setting: str, memory_bytes: int, floor_bytes: int) -> None:
        """Keep the three facts; the message names them."""
        super().__init__(
            f"{setting} is {memory_bytes} bytes, below the {floor_bytes} bytes the runtime module needs to start",
            hint=f"set {setting} to at least {floor_bytes} bytes",
        )
        self.setting = setting
        self.memory_bytes = memory_bytes
        self.floor_bytes = floor_bytes


class EngineSelectionError(EngineConfigurationError):
    """An unknown id, an unavailable engine, or one id claimed by two distributions."""


class GuestUnavailableError(WasiError):
    """The engine cannot run a guest: it is missing, broken, or the run could not start."""
