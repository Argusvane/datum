"""The sandbox's refusals: why a run gave no answer, a program that cannot be used, a definition nested too deep.

A message is the host's own words: it never carries the guest's stdout or stderr, which travel on the exception for the
log only (`stderr`, `program_message`).
"""

import enum
from typing import Final

#: The most stderr an exception keeps, in bytes: the run's stderr cap.
STDERR_KEPT: Final = 64 * 1024


class SandboxFailure(enum.StrEnum):
    """Why a run gave no verdict; each reason answers one wire code and status (`code`, `status`)."""

    BUDGET = "budget"
    """The run passed its time budget."""
    MEMORY = "memory"
    """The run passed its memory budget."""
    TRAP = "trap"
    """The module trapped."""
    THREW = "threw"
    """The program threw: a non-zero exit that is not a limit."""
    OUTPUT_CAP = "output_cap"
    """The run wrote past an output cap; whatever ended it, a capped run is never an answer."""
    OUTCOME_TOO_LARGE = "outcome_too_large"
    """The outcome was longer than 8 Mi UTF-16 code units; nothing of it is kept."""
    NOT_JSON = "not_json"
    """The framed answer is not strict JSON."""
    NO_OUTCOME = "no_outcome"
    """A clean end with no frame, or a frame without an outcome (an object with an `errors` list) in it."""
    FRAME = "frame"
    """A clean end with this run's whole frame but bytes outside it."""
    REFUSED = "refused"
    """The program refused the request (`ok` is not `true`); `program_code` says why."""
    INPUT = "input"
    """The run's input could not be written as JSON (a non-finite number, a lone surrogate)."""
    BUSY = "busy"
    """Every run slot stayed taken for the wait: nothing was judged (a full stray bound is `StrayBoundError`)."""
    INTERRUPTED = "interrupted"
    """The host closed the runtime before the run answered: nothing was judged."""

    @property
    def code(self) -> str:
        """The wire code a failure of this reason answers."""
        return _WIRE[self][0]

    @property
    def status(self) -> int:
        """The HTTP status a failure of this reason answers."""
        return _WIRE[self][1]


_EXECUTION: Final = ("wasm.execution_error", 503)
_WIRE: Final[dict[SandboxFailure, tuple[str, int]]] = {
    SandboxFailure.BUDGET: _EXECUTION,
    SandboxFailure.MEMORY: _EXECUTION,
    SandboxFailure.TRAP: _EXECUTION,
    SandboxFailure.THREW: _EXECUTION,
    SandboxFailure.OUTPUT_CAP: _EXECUTION,
    SandboxFailure.OUTCOME_TOO_LARGE: ("outcome_too_large", 503),
    SandboxFailure.NOT_JSON: _EXECUTION,
    SandboxFailure.NO_OUTCOME: _EXECUTION,
    SandboxFailure.FRAME: _EXECUTION,
    SandboxFailure.REFUSED: _EXECUTION,
    SandboxFailure.INPUT: _EXECUTION,
    SandboxFailure.BUSY: ("server.busy", 503),
    SandboxFailure.INTERRUPTED: ("server.unavailable", 503),
}


class DatumError(Exception):
    """A Datum refusal with a stable wire `code` and an HTTP `status`; the message is safe to show."""

    code: str = "internal"
    status: int = 500

    def __init__(self, message: str) -> None:
        """Keep the host's message."""
        super().__init__(message)
        self.message = message


class SandboxError(DatumError):
    """A sandbox or PDF run that produced no usable answer.

    `guest_stopped` is true only for a time or memory stop the guest ran into after its started marker: the output cap,
    a host stop or a failure before the guest started prove nothing about the definition.
    """

    def __init__(
        self,
        reason: SandboxFailure,
        message: str,
        *,
        stderr: str = "",
        guest_stopped: bool = False,
        program_code: str | None = None,
        program_message: str | None = None,
    ) -> None:
        """Record the reason and the log-only details; the wire code and status follow the reason."""
        super().__init__(message)
        self.reason = reason
        self.code = reason.code
        self.status = reason.status
        self.stderr = clip(stderr)
        self.guest_stopped = guest_stopped
        self.program_code = program_code
        self.program_message = program_message


class DefinitionTooCostlyError(SandboxError):
    """A check that ran into its own time or memory limit after the program started: 422 `definition.tooCostly`."""

    def __init__(self, cause: SandboxError) -> None:
        """Keep the stop that caused it."""
        super().__init__(
            cause.reason,
            "The definition is too large or too complex to check within the time or memory the sandbox allows.",
            stderr=cause.stderr,
            guest_stopped=True,
        )
        self.code = "definition.tooCostly"
        self.status = 422


class ProgramUnavailableError(DatumError):
    """A program or runtime that cannot be used (an older ABI, no answer to the probe): 503 `server.unavailable`."""

    code = "server.unavailable"
    status = 503


class StrayBoundError(ProgramUnavailableError):
    """A run refused because runs that would not stop fill the stray bound: 503 `server.unavailable`, no `Retry-After`.

    A fault of the runtime (guests it asked to stop are still running), not a queue to wait in, so never `server.busy`.
    """


class DefinitionTooDeepError(DatumError):
    """A definition nested past a depth limit, refused before any guest starts: 422 `definition.tooDeep`."""

    code = "definition.tooDeep"
    status = 422

    def __init__(self, limit: int, message: str) -> None:
        """Keep the limit that was passed."""
        super().__init__(message)
        self.limit = limit


def clip(text: str) -> str:
    """Return `text` cut to at most `STDERR_KEPT` bytes of UTF-8, never splitting a character."""
    data = text.encode("utf-8", "replace")
    if len(data) <= STDERR_KEPT:
        return text
    return data[:STDERR_KEPT].decode("utf-8", "ignore")
