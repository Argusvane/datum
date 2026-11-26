"""Diagnostics: the run trace, the failed-run capture and the effective-settings report.

None of them can change a run's answer, and with the trace and the capture off a run pays one `is None` test.
"""

from datum_sandbox.diagnostics._capture import (
    CAPTURE_ID,
    CaptureListing,
    DirectoryCaptureSink,
    FailedRunCapture,
    PartlyRemovedError,
    RunCapture,
    RunCaptureSink,
    acl_problem,
)
from datum_sandbox.diagnostics._diagnostics import RunDiagnostics, capture_id, new_run_id, trace_record
from datum_sandbox.diagnostics._report import ProgramFacts, ReportEntry, SettingsReport, Source, scrub, without_paths
from datum_sandbox.diagnostics._trace import FIELDS, RunTrace, TraceRecord, log_trace, word

__all__ = [
    "CAPTURE_ID",
    "FIELDS",
    "CaptureListing",
    "DirectoryCaptureSink",
    "FailedRunCapture",
    "PartlyRemovedError",
    "ProgramFacts",
    "ReportEntry",
    "RunCapture",
    "RunCaptureSink",
    "RunDiagnostics",
    "RunTrace",
    "SettingsReport",
    "Source",
    "TraceRecord",
    "acl_problem",
    "capture_id",
    "log_trace",
    "new_run_id",
    "scrub",
    "trace_record",
    "without_paths",
    "word",
]
