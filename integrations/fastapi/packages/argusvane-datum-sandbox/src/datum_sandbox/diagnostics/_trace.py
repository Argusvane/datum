"""The run trace (`datum.runtime.diagnostics.trace` = `off` | `failures` | `all`): one structured line per run.

A `TraceRecord` holds lengths, times and words, never an answer, a definition, stdout or stderr text, the run's nonce or
a path. Every text value is reduced to ASCII letters, digits, `.`, `_` and `-` (`word`), so nothing in it can split the
line or forge a field. `log_trace`, the default `RunTrace`, writes `record.line()` at INFO on `datum.sandbox.trace`; a
host routes records elsewhere by handing `DatumSandbox(trace=...)` its own callable.
"""

import logging
import re
from collections.abc import Callable
from dataclasses import dataclass
from typing import Final

from datum_sandbox.loggers import TRACE

_logger = logging.getLogger(TRACE)
_UNSAFE: Final = re.compile(r"[^A-Za-z0-9._-]")
_WORD_MAX: Final = 64

FIELDS: Final = (
    "run",
    "program",
    "op",
    "abi",
    "engine",
    "mode",
    "slotWaitMs",
    "prepareMs",
    "instantiateMs",
    "startMs",
    "totalMs",
    "termination",
    "exit",
    "outcome",
    "stdinBytes",
    "stdoutBytes",
    "stderrBytes",
    "capture",
)
"""The fields of a trace line, in their fixed order."""


def word(text: object) -> str:
    """Return `text` reduced to `[A-Za-z0-9._-]`, at most 64 characters; `-` when nothing is left."""
    cleaned = _UNSAFE.sub("", str(text))[:_WORD_MAX]
    return cleaned or "-"


def _millis(seconds: float) -> str:
    return f"{seconds * 1000.0:.1f}"


@dataclass(frozen=True, slots=True)
class TraceRecord:
    """One run's trace: who ran what, how long each part took (seconds), how it ended, how much it read and wrote.

    `capture` is the id the run's capture was queued under, `dropped` when the capture refused it, else `None`.
    """

    run: str
    program: str
    op: str
    abi: str
    engine: str
    mode: str
    slot_wait: float
    prepare: float
    instantiate: float
    start: float
    total: float
    termination: str
    exit: int | None
    outcome: str
    stdin_bytes: int
    stdout_bytes: int
    stderr_bytes: int
    capture: str | None = None

    def fields(self) -> dict[str, str]:
        """Return the fields as text, in the fixed order, every value already reduced to a safe word."""
        return {
            "run": word(self.run),
            "program": word(self.program),
            "op": word(self.op),
            "abi": word(self.abi),
            "engine": word(self.engine),
            "mode": word(self.mode),
            "slotWaitMs": _millis(self.slot_wait),
            "prepareMs": _millis(self.prepare),
            "instantiateMs": _millis(self.instantiate),
            "startMs": _millis(self.start),
            "totalMs": _millis(self.total),
            "termination": word(self.termination),
            "exit": "-" if self.exit is None else str(int(self.exit)),
            "outcome": word(self.outcome),
            "stdinBytes": str(int(self.stdin_bytes)),
            "stdoutBytes": str(int(self.stdout_bytes)),
            "stderrBytes": str(int(self.stderr_bytes)),
            "capture": "-" if self.capture is None else word(self.capture),
        }

    def line(self) -> str:
        """Return the record as one `key=value` line in the fixed field order."""
        return " ".join(f"{key}={value}" for key, value in self.fields().items())


type RunTrace = Callable[[TraceRecord], None]
"""Where trace records go: called on the run's thread after its slot is released; whatever it raises is logged."""


def log_trace(record: TraceRecord) -> None:
    """Write the record's line at INFO on `datum.sandbox.trace`: the default `RunTrace`."""
    _logger.info("%s", record.line())
