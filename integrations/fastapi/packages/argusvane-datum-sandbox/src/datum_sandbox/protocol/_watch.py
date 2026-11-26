"""The run watch: what the protocol tells the diagnostics about each run it made, after its last check.

A service holds a `RunRecorder` only while the trace or the capture is on; with both off it holds `None` and a call pays
one `is None` test. With a recorder, each public operation opens a `RunWatch` on its thread. The one run the operation
makes is noted in the watch (its `GuestRun`, its `RunResult` or the fact that the runtime raised), and when the
operation ends, after every check of the protocol, the watch hands one `RunRecord` with the outcome word to the
recorder. An operation that made no run (a busy slot, a definition too deep, input that is not JSON, a stopping runtime)
records nothing. A recorder that raises is logged and the operation's answer or refusal stands.

The ABI probe an operation's gate runs first is a run of its own, with its own watch.

Outcome words: `verdict` (the program answered and the protocol took the answer), `refused` (the program answered with
a refusal of its own: an inspect or PDF answer with `ok: false`, a probe it does not answer for), the `SandboxFailure`
words (`budget`, `memory`, `trap`, `threw`, `output_cap`, `outcome_too_large`, `not_json`, `no_outcome`, `frame`,
`interrupted`), `unavailable` (the runtime could not start the run, or refused it at the stray bound) and `error`
(anything else). Every word but `verdict` and `refused` is a failed run.
"""

import logging
import threading
import time
from collections.abc import Callable, Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from typing import Final

from datum_sandbox.loggers import RUNTIME
from datum_sandbox.protocol._errors import DatumError, ProgramUnavailableError, SandboxError, SandboxFailure
from datum_sandbox.wasi import EngineInfo, GuestRun, RunResult

logger = logging.getLogger(RUNTIME)

VERDICT: Final = "verdict"
REFUSED: Final = "refused"
UNAVAILABLE: Final = "unavailable"
ERROR: Final = "error"
ANSWERS: Final = frozenset({VERDICT, REFUSED})
"""The two outcomes that are the program's answers; every other outcome is a failed run."""
_NO_RUN: Final = frozenset({SandboxFailure.BUSY, SandboxFailure.INPUT})


def fatal(error: BaseException) -> bool:
    """Whether an exception out of a diagnostics hook must still end its thread: an interrupt or an exit.

    Everything else a trace, a sink or a recorder raises (an `Exception`, or any other `BaseException` such as a
    library's own cancellation class) is logged by class and the run's answer stands.
    """
    return isinstance(error, KeyboardInterrupt | SystemExit | GeneratorExit)


def is_failed(outcome: str) -> bool:
    """Say whether a run with this outcome word failed (everything but `verdict` and `refused`)."""
    return outcome not in ANSWERS


@dataclass(frozen=True, slots=True)
class RunRecord:
    """One finished run as the diagnostics see it: which program and operation, the run, how it ended, its outcome.

    `result` is `None` when the runtime raised instead of running (`unavailable`). `total` is the wall time of the run
    call in seconds. It carries the run's stdin and files: a recorder that keeps them (the capture) holds personal data.
    """

    program: str
    op: str
    abi: str
    sha256: str
    engine: EngineInfo
    run: GuestRun
    result: RunResult | None
    outcome: str
    total: float


type RunRecorder = Callable[[RunRecord], None]
"""What a service hands each finished run to (the runtime's diagnostics)."""


class _Frame:
    """The run an operation made, noted by the service's run step."""

    __slots__ = ("outcome", "result", "run", "total")

    def __init__(self) -> None:
        self.run: GuestRun | None = None
        self.result: RunResult | None = None
        self.total = 0.0
        self.outcome: str | None = None


_LOCAL: Final = threading.local()


def _stack() -> list[_Frame]:
    stack: list[_Frame] | None = getattr(_LOCAL, "frames", None)
    if stack is None:
        stack = []
        _LOCAL.frames = stack
    return stack


def note_run(run: GuestRun, result: RunResult | None, total: float) -> None:
    """Note the run the current operation made (no-op when no watch is open on this thread)."""
    stack = _stack()
    if stack:
        frame = stack[-1]
        frame.run, frame.result, frame.total = run, result, total


def note_outcome(outcome: str) -> None:
    """Set the current operation's outcome word where the exception alone would not say it (a probe's refusal)."""
    stack = _stack()
    if stack:
        stack[-1].outcome = outcome


def outcome_of(error: BaseException | None) -> str:
    """Return the outcome word an operation that ended with `error` (None: it answered) gets."""
    if error is None:
        return VERDICT
    if isinstance(error, SandboxError):
        return REFUSED if error.reason is SandboxFailure.REFUSED else error.reason.value
    if isinstance(error, ProgramUnavailableError):
        cause = error.__cause__
        if isinstance(cause, SandboxError):
            return cause.reason.value
        return UNAVAILABLE
    if isinstance(error, DatumError):
        return REFUSED  # a refusal of the program's own (PdfKernelError): it answered
    return ERROR


@contextmanager
def watched(
    recorder: RunRecorder,
    *,
    program: str,
    op: str,
    abi: str,
    sha256: str,
    engine: Callable[[], EngineInfo],
) -> Iterator[None]:
    """Watch one operation: on its end, after its last check, hand its run (if it made one) to `recorder`."""
    frame = _Frame()
    stack = _stack()
    stack.append(frame)
    error: BaseException | None = None
    try:
        yield
    except BaseException as caught:
        error = caught
        raise
    finally:
        stack.pop()
        if frame.run is not None and not _made_no_run(error):
            outcome = frame.outcome or outcome_of(error)
            if frame.result is None and frame.outcome is None and outcome == ERROR:
                outcome = UNAVAILABLE
            _hand(recorder, program, op, abi, sha256, engine, frame, outcome)


def _made_no_run(error: BaseException | None) -> bool:
    return isinstance(error, SandboxError) and error.reason in _NO_RUN


def _hand(  # noqa: PLR0917 - one private call site; the record's parts in order
    recorder: RunRecorder,
    program: str,
    op: str,
    abi: str,
    sha256: str,
    engine: Callable[[], EngineInfo],
    frame: _Frame,
    outcome: str,
) -> None:
    """Build the record and hand it over; whatever the recorder raises (an `Exception`) is logged, never propagated."""
    run = frame.run
    if run is None:  # pragma: no cover - the caller checked
        return
    try:
        info = engine()
    except Exception:
        info = EngineInfo(id="unknown", release="", mode="unknown")
    try:
        recorder(RunRecord(program, op, abi, sha256, info, run, frame.result, outcome, frame.total))
    except BaseException as error:  # diagnostics never change a run's answer
        if fatal(error):
            raise
        logger.warning("the run diagnostics failed (%s); the run's answer stands", type(error).__name__)


def clock() -> float:
    """Return the monotonic clock the run step measures with."""
    return time.perf_counter()
