"""The dry run's report is one flat object, member for member the one the other hosts answer."""

import json
from typing import Any

from direct_support import Parts
from submissions_support import bus, envelope, wrapped

from datum_core.canonical import canonical_bytes, canonical_digest
from datum_core.hooks import HookFindings, HookProblem
from datum_core.http import submission_answer
from datum_core.submissions import DryRun, FormRef
from datum_sandbox.protocol import SandboxResult

MEMBERS = [
    "outcome",
    "stage",
    "errors",
    "sent",
    "values",
    "clientDerived",
    "clockDependent",
    "serverRules",
    "visibilitySkipped",
    "document",
    "digest",
    "logs",
    "sandbox",
    "signature",
]
FINDING = ["field", "code", "message", "severity", "stage", "source"]


def dry(parts: Parts, document: Any | None = None) -> DryRun:
    outcome = parts.service().test(FormRef.from_document(), wrapped(document or envelope()), bus())
    assert isinstance(outcome, DryRun)
    return outcome


def wire(outcome: DryRun) -> dict[str, Any]:
    return json.loads(submission_answer(outcome, retry_after=5).body)  # type: ignore[no-any-return]


def test_an_accepted_report_has_the_fourteen_members_in_order_and_no_accepted_or_nested_report() -> None:
    parts = Parts()
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [],
            "values": {"name": "Ada"},
            "logs": [{"level": "warn", "message": "m"}],
            "visibilitySkipped": ["admin_note"],
            "serverRules": ["a", 3],
        },
        0.0123,
    )
    document = envelope()
    body = wire(dry(parts, document))
    assert list(body) == MEMBERS
    assert body["outcome"] == "accepted"
    assert body["stage"] is None
    assert body["errors"] == []
    assert body["values"] == {"name": "Ada"}
    assert body["sent"] == document["submission"]["values"]
    assert (body["clientDerived"], body["clockDependent"]) == ([], [])
    assert (body["serverRules"], body["visibilitySkipped"]) == (["a"], ["admin_note"])
    assert body["logs"] == [{"level": "warn", "message": "m"}]
    assert body["digest"] == canonical_digest(document)
    assert body["document"] == canonical_bytes(document).decode("utf-8")
    assert body["signature"] is None
    assert list(body["sandbox"]) == ["elapsedMs", "rules", "unknownFields", "logLevel"]
    assert body["sandbox"]["elapsedMs"] == 12.3
    assert body["sandbox"]["rules"] == []
    assert body["sandbox"]["unknownFields"] == "strip"
    assert body["sandbox"]["logLevel"] == "warn"


def test_the_findings_keep_every_severity_in_order_with_all_six_members() -> None:
    parts = Parts()
    parts.sandbox.verdict = SandboxResult(
        {
            "errors": [
                {"code": "recommended", "componentId": "name", "severity": "warning", "stage": "run", "source": "wasm"},
                {"code": "required", "componentId": "mail", "message": "Enter it"},
            ],
            "values": {},
        },
        0.0,
    )
    outcome = dry(parts)
    body = wire(outcome)
    assert body["outcome"] == "rejected"
    assert body["stage"] == "sandbox"
    assert [list(item) for item in body["errors"]] == [FINDING, FINDING]
    assert body["errors"][0] == {
        "field": "name",
        "code": "recommended",
        "message": None,
        "severity": "warning",
        "stage": "run",
        "source": "wasm",
    }
    assert body["errors"][1]["severity"] == "error"
    assert body["errors"][1]["message"] == "Enter it"
    assert len(outcome.errors) == 1  # the outcome's own errors are the blocking ones


def test_a_validators_findings_follow_the_runs_and_are_stage_server() -> None:
    parts = Parts()
    parts.sandbox.verdict = SandboxResult({"errors": [], "values": {"name": "Ada"}}, 0.0)

    def validator(candidate: Any, context: Any) -> HookFindings:
        return HookFindings(
            errors=(HookProblem("name", "name.taken", "Taken"),), warnings=(HookProblem(None, "soft", ""),)
        )

    outcome = parts.service(validators=[validator]).test(FormRef.from_document(), wrapped(envelope()), bus())
    assert isinstance(outcome, DryRun)
    body = wire(outcome)
    assert (body["outcome"], body["stage"]) == ("rejected", "server")
    assert body["errors"] == [
        {
            "field": "name",
            "code": "name.taken",
            "message": "Taken",
            "severity": "error",
            "stage": "server",
            "source": "server",
        },
        {"field": None, "code": "soft", "message": None, "severity": "warning", "stage": "server", "source": "server"},
    ]
    assert body["values"] == {"name": "Ada"}
    assert body["digest"] is not None


def test_a_refusal_before_any_run_has_null_values_document_digest_sandbox_and_signature() -> None:
    parts = Parts()
    document = envelope()
    document["submission"]["journey"] = "nope"
    body = wire(dry(parts, document))
    assert list(body) == MEMBERS
    assert (body["outcome"], body["stage"]) == ("rejected", "journey")
    assert body["errors"] == [
        {"field": None, "code": "journey.unknown", "message": None, "severity": "error", "stage": None, "source": None}
    ]
    assert body["sent"] == document["submission"]["values"]
    for key in ("values", "document", "digest", "sandbox", "signature"):
        assert body[key] is None, key
    assert body["logs"] == []
    for key in ("clientDerived", "clockDependent", "serverRules", "visibilitySkipped"):
        assert body[key] == [], key


def test_values_are_null_when_the_run_kept_none() -> None:
    parts = Parts()
    parts.sandbox.verdict = SandboxResult({"errors": [{"code": "x", "severity": "error"}]}, 0.0)
    body = wire(dry(parts))
    assert body["values"] is None
    outcome = body["sandbox"]["rules"]
    assert outcome == []
