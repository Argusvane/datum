"""The run watch: a run's outcome word is read after the protocol's last check, on every path."""

import json

import pytest
from sandbox_fakes import FakeRuntime

from datum_sandbox.protocol import (
    PdfKernelError,
    PdfKernelService,
    ProgramUnavailableError,
    RunRecord,
    SandboxError,
    SandboxService,
    freeze_snippet,
    pdf_program,
    sandbox_program,
)
from datum_sandbox.wasi import GuestRun, RunEnd, RunResult


class Answering(FakeRuntime):
    """Answers every inspect run with `reply` (framed), and every PDF run with `pdf` (unframed)."""

    def __init__(self, reply: dict[str, object] | None = None, pdf: dict[str, object] | None = None) -> None:
        super().__init__(pools=frozenset({"validation", "pdf"}))
        self.reply = reply
        self.pdf = pdf

    def run(self, job: GuestRun, /) -> RunResult:
        script = job.app_files["run.js"].decode("utf-8")
        if "__datum_pdf" in script:
            return RunResult(RunEnd.CLEAN, json.dumps(self.pdf).encode(), b"")
        body = json.loads(job.stdin[33:])
        if self.reply is not None and body.get("op") != "inspect":
            from datum_sandbox.protocol import marker  # noqa: PLC0415

            nonce = job.stdin[:32].decode("ascii")
            frame = b"\n".join(
                [
                    marker(nonce, "started"),
                    marker(nonce, "begin"),
                    json.dumps(self.reply).encode(),
                    marker(nonce, "end"),
                ]
            )
            return RunResult(RunEnd.CLEAN, frame + b"\n", b"")
        return super().run(job)


def service(runtime: FakeRuntime, records: list[RunRecord]) -> SandboxService:
    return SandboxService(runtime, sandbox_program(), freeze_snippet=freeze_snippet(), recorder=records.append)


def test_a_check_with_no_structure_is_traced_as_no_outcome() -> None:
    records: list[RunRecord] = []
    sandbox = service(Answering(reply={"ok": True, "op": "check"}), records)
    sandbox.prove_abi()
    records.clear()
    with pytest.raises(ProgramUnavailableError):
        sandbox.check({"id": "f", "root": {"id": "root", "type": "form"}}, ["text"])
    assert [(record.op, record.outcome) for record in records] == [("check", "no_outcome")]


def test_an_inspect_refusal_is_the_programs_answer() -> None:
    records: list[RunRecord] = []
    refusing = {"ok": False, "error": {"code": "bad", "message": "no"}}
    sandbox = service(Answering(reply=refusing), records)
    sandbox.prove_abi()
    records.clear()
    with pytest.raises(SandboxError):
        sandbox.inspect("public", {"id": "f"})
    assert [record.outcome for record in records] == ["refused"]


def test_a_probe_the_program_does_not_answer_for_is_refused_and_a_proof_is_a_verdict() -> None:
    records: list[RunRecord] = []
    service(FakeRuntime(), records).prove_abi()
    assert [(record.op, record.outcome) for record in records] == [("probe", "verdict")]


def test_a_pdf_answer_with_no_boolean_ok_is_no_outcome_and_a_refusal_is_refused() -> None:
    capabilities = {
        "ok": True,
        "op": "capabilities",
        "abi": "4.0.0",
        "features": ["signature", "verify-detail", "output-safety", "render-caps", "attachment-types"],
    }
    records: list[RunRecord] = []
    runtime = Answering(pdf=capabilities)
    kernel = PdfKernelService(runtime, pdf_program(), recorder=records.append)
    kernel.prove_abi()
    runtime.pdf = {}
    with pytest.raises(SandboxError):
        kernel.document({})
    runtime.pdf = {"ok": False, "error": {"code": "layout", "message": "no layout"}}
    with pytest.raises(PdfKernelError):
        kernel.document({})
    assert [(record.op, record.outcome) for record in records] == [
        ("probe", "verdict"), ("document", "no_outcome"), ("document", "refused"),
    ]  # fmt: skip


def test_a_stale_pdf_abi_is_refused_not_a_verdict() -> None:
    records: list[RunRecord] = []
    stale = {"ok": True, "op": "capabilities", "abi": "3.0.0", "features": []}
    kernel = PdfKernelService(Answering(pdf=stale), pdf_program(), recorder=records.append)
    with pytest.raises(ProgramUnavailableError):
        kernel.prove_abi()
    assert [(record.op, record.outcome) for record in records] == [("probe", "refused")]


def test_a_runtime_that_raises_is_unavailable() -> None:
    records: list[RunRecord] = []
    sandbox = service(FakeRuntime(fail_with=RuntimeError("gone")), records)
    with pytest.raises(ProgramUnavailableError):
        sandbox.prove_abi()
    assert [(record.outcome, record.result) for record in records] == [("unavailable", None)]
