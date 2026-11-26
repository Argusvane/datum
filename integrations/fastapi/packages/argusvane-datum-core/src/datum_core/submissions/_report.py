"""The dry run's report: one flat object, member for member the one the other hosts answer.

Members, in order: `outcome` (`accepted` or `rejected`), `stage` (null when accepted), `errors` (every finding with its
severity, so a warning or an info item sits beside a blocking error), `sent` (the values as the person sent them),
`values` (what the run kept, null when it kept none), the four component-id lists, `document` (the canonical text) and
`digest` (null when no run happened), `logs`, `sandbox` (the run's words, null when no run happened) and `signature`
(null: no signature check is wired). Nothing here is a secret: the run's own findings and the caller's own answers.
"""

from collections.abc import Mapping, Sequence

from datum_core.hooks import HookProblem
from datum_core.submissions._model import SubmissionError
from datum_core.submissions._outcomes import REPORT_ID_LISTS
from datum_sandbox.json import JsonValue

__all__ = ["assemble", "finding", "refusal", "sandbox_finding", "server_finding", "trace"]


def finding(
    field: str | None,
    code: str,
    message: str | None,
    *,
    severity: str | None = None,
    stage: str | None = None,
    source: str | None = None,
) -> dict[str, JsonValue]:
    """Return one finding as the report lists it: all six members, null where unknown, severity `error` by default."""
    return {
        "field": field,
        "code": code,
        "message": message,
        "severity": severity or "error",
        "stage": stage,
        "source": source,
    }


def server_finding(problem: HookProblem, severity: str) -> dict[str, JsonValue]:
    """Return a validator's finding: its own words, `stage` and `source` both `server`."""
    return finding(
        problem.field, problem.code, problem.message or None, severity=severity, stage="server", source="server"
    )


def _text(item: Mapping[str, JsonValue], key: str) -> str | None:
    value = item.get(key)
    return value if isinstance(value, str) else None


def sandbox_finding(item: JsonValue) -> dict[str, JsonValue]:
    """Read one verdict item of the run as a finding (a record that is not an object reads as a plain `error`)."""
    record = item if isinstance(item, dict) else {}
    field = _text(record, "componentId") or _text(record, "path")
    code = _text(record, "code") or "invalid"
    return finding(
        field,
        code,
        _text(record, "message") or None,
        severity=_text(record, "severity"),
        stage=_text(record, "stage"),
        source=_text(record, "source"),
    )


def trace(
    *,
    sent: Mapping[str, JsonValue],
    outcome: Mapping[str, JsonValue],
    values: Mapping[str, JsonValue] | None,
    findings: Sequence[dict[str, JsonValue]],
    digest: str,
    canonical: str,
    elapsed: float,
    rules: Sequence[str],
    unknown_fields: str,
    log_level: str,
) -> dict[str, JsonValue]:
    """Return what a run that gave a verdict leaves for the report; `assemble` adds the outcome and the stage."""
    logs = outcome.get("logs")
    kept: dict[str, JsonValue] = {
        "errors": list(findings),
        "sent": dict(sent),
        "values": None if values is None else dict(values),
    }
    for key in REPORT_ID_LISTS:
        ids = outcome.get(key)
        kept[key] = [item for item in ids if isinstance(item, str)] if isinstance(ids, list) else []
    kept["document"] = canonical
    kept["digest"] = digest
    kept["logs"] = list(logs) if isinstance(logs, list) else []
    kept["sandbox"] = {
        "elapsedMs": round(elapsed * 1000, 1),
        "rules": list(rules),
        "unknownFields": unknown_fields,
        "logLevel": log_level,
    }
    kept["signature"] = None
    return kept


def refusal(sent: Mapping[str, JsonValue], errors: Sequence[SubmissionError]) -> dict[str, JsonValue]:
    """Return what a refusal before any run leaves: the findings and what was sent, nothing of a run."""
    kept: dict[str, JsonValue] = {
        "errors": [finding(field, code, message) for field, code, message in errors],
        "sent": dict(sent),
        "values": None,
    }
    for key in REPORT_ID_LISTS:
        kept[key] = []
    kept["document"] = None
    kept["digest"] = None
    kept["logs"] = []
    kept["sandbox"] = None
    kept["signature"] = None
    return kept


def assemble(accepted: bool, stage: str | None, kept: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
    """Return the report, its members in the contract's order."""
    report: dict[str, JsonValue] = {"outcome": "accepted" if accepted else "rejected", "stage": stage}
    report.update(kept)
    return report
