"""`RunDiagnostics`: the recorder a service hands every run to; it writes the trace line and offers the capture.

Under `failures` only a failed run is traced (`is_failed`: every outcome but `verdict` and `refused`); under `all` every
run. A failed run is captured while the capture is on, whatever the trace says. Both happen on the run's thread after
the run's slot was released, and nothing either raises (an `Exception`) reaches the run: each part is guarded on its
own, so a trace that fails still lets the capture be offered and the other way round.
"""

import json
import logging
import secrets
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Final

from datum_sandbox.diagnostics._capture import FailedRunCapture, RunCapture
from datum_sandbox.diagnostics._report import scrub
from datum_sandbox.diagnostics._trace import RunTrace, TraceRecord, word
from datum_sandbox.loggers import RUNTIME
from datum_sandbox.protocol import APP_RUN_SCRIPT, RunRecord, is_failed
from datum_sandbox.protocol._watch import fatal

logger = logging.getLogger(RUNTIME)

_DROPPED: Final = "dropped"


def new_run_id() -> str:
    """Return a random 12-hex run id (never the run's nonce)."""
    return secrets.token_hex(6)


def capture_id(run_id: str, moment: datetime | None = None) -> str:
    """Return the capture id of a run: `<UTC yyyymmdd>-<hhmmss>-<run id>`."""
    at = (moment or datetime.now(UTC)).astimezone(UTC)
    return f"{at:%Y%m%d-%H%M%S}-{run_id}"


def trace_record(record: RunRecord, run_id: str, capture: str | None) -> TraceRecord:
    """Return the trace of one run record: lengths, times and words only."""
    result = record.result
    timings = result.timings if result is not None else None
    return TraceRecord(
        run=run_id,
        program=record.program,
        op=record.op,
        abi=record.abi or "-",
        engine=record.engine.id,
        mode=record.engine.mode,
        slot_wait=timings.slot_wait if timings is not None else 0.0,
        prepare=timings.prepare if timings is not None else 0.0,
        instantiate=timings.instantiate if timings is not None else 0.0,
        start=timings.start if timings is not None else 0.0,
        total=record.total,
        termination=result.end.value if result is not None else "none",
        exit=result.exit_code if result is not None else None,
        outcome=record.outcome,
        stdin_bytes=len(record.run.stdin),
        stdout_bytes=len(result.stdout) if result is not None else 0,
        stderr_bytes=len(result.stderr) if result is not None else 0,
        capture=capture,
    )


class RunDiagnostics:
    """The `RunRecorder` of a started sandbox: the trace (`mode`, `trace`) and the capture (`capture`, or `None`)."""

    def __init__(
        self,
        *,
        mode: str,
        trace: RunTrace,
        capture: FailedRunCapture | None,
        report: Callable[[], dict[str, object]],
    ) -> None:
        """Keep the trace mode and sink, the capture, and the settings report that goes into each `meta.json`."""
        self._mode = str(mode)
        self._trace = trace
        self._capture = capture
        self._report = report

    def __call__(self, record: RunRecord) -> None:
        """Offer a failed run to the capture, then write its trace line when the mode asks for it."""
        failed = is_failed(record.outcome)
        traced = self._mode == "all" or (self._mode == "failures" and failed)
        if not traced and (self._capture is None or not failed):
            return
        run_id = new_run_id()
        queued: str | None = None
        if self._capture is not None and failed:
            try:
                queued = self._capture.offer(self._assemble(record, run_id))
            except BaseException as error:  # an assembly that fails drops the capture, never the answer
                if fatal(error):
                    raise
                queued = _DROPPED
                logger.warning("the failed-run capture could not assemble a capture (%s)", type(error).__name__)
        if traced:
            try:
                self._trace(trace_record(record, run_id, queued))
            except BaseException as error:  # a trace never changes a run's answer
                if fatal(error):
                    raise
                logger.warning("the run trace failed (%s); the run's answer stands", type(error).__name__)

    def _assemble(self, record: RunRecord, run_id: str) -> RunCapture:
        identifier = capture_id(run_id)
        trace = trace_record(record, run_id, identifier)
        try:
            report: object = self._report()
        except Exception as error:
            report = {"unavailable": type(error).__name__}
        info = record.engine
        meta = {
            "id": identifier,
            "trace": trace.fields(),
            "program": {"kind": word(record.program), "sha256": record.sha256, "abi": record.abi},
            "engine": {
                "id": scrub(info.id),
                "release": scrub(info.release),
                "mode": scrub(info.mode),
                "notes": [scrub(note) for note in info.notes],
            },
            "settings": report,
        }
        result = record.result
        return RunCapture(
            id=identifier,
            stdin=record.run.stdin,
            stdout=result.stdout if result is not None else b"",
            stderr=result.stderr if result is not None else b"",
            run_js=record.run.app_files.get(APP_RUN_SCRIPT, b""),
            meta=json.dumps(meta, indent=2, sort_keys=False, default=str).encode("utf-8"),
        )
