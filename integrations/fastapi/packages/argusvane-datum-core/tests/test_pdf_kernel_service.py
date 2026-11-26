"""`PdfKernelService` and the PDF ABI gate.

The PDF program runs on the same engine as the sandbox, one `run()` per call in the PDF pool
(`ProgramLimits.pdf_budget()`, the script `PDF_RUN_SCRIPT`). The service stamps `abi` (the floor, 4.0.0) and `op` onto
the caller's request, so a caller, a customizer or a middleware never chooses either, reads the answer strictly (`ok` is
the boolean `true`) into the records of `datum_sandbox.protocol._pdf`, and raises `PdfKernelError` (the program's `code`
and
`message`) for a refusal of the program. The program accepts any request of its own major, so the GATE reads the
`capabilities` reply: its `abi` at least the floor by semver (numeric, never as strings) in the same major, and the five
features the host needs (`signature`, `verify-detail`, `output-safety`, `render-caps`, `attachment-types`); a program
that fails it is refused with the rebuild hint, a proof is kept per program SHA-256 and a refusal never is. A run that
gives no answer is a `SandboxError` of the sandbox's reasons; a runtime that cannot start one is
`ProgramUnavailableError`. The last section holds the `datum.pdf.run` span (`ObservedPdfKernel`, the innermost layer
Datum composes). The rows marked `runtime` run the real program.
"""

import base64
import contextlib
import hashlib
import json
from collections.abc import Mapping
from typing import Any

import pytest
from observe_support import attrs, telemetry
from opentelemetry import trace
from opentelemetry.trace import StatusCode
from pdf_support import ABI, FEATURES, ScriptedPdfRuntime, b64, fake_pdf

from datum_core.observe import ObservedPdfKernel
from datum_core.testing.pdf_handoff import signing_handoff
from datum_sandbox.protocol import (
    PDF_ABI_MIN,
    PDF_RUN_SCRIPT,
    AbiProbe,
    PdfKernelError,
    PdfKernelService,
    PoolKind,
    Program,
    ProgramKind,
    ProgramLimits,
    ProgramUnavailableError,
    RunRecord,
    SandboxError,
    SandboxFailure,
    StrayBoundError,
    compose_pdf_kernel,
    guest_argv,
    require_pdf_capabilities,
)
from datum_sandbox.protocol._pdf import PdfCapabilities, PdfCompleted, PdfInspected, PdfProduced, PdfSigned, PdfVerified
from datum_sandbox.testing.runtime_support import program_parts
from datum_sandbox.wasi import EngineBusyError, EngineClosedError, EngineStrayBoundError, GuestRun, RunEnd, RunResult

REQUIRED = ("signature", "verify-detail", "output-safety", "render-caps", "attachment-types")
PROGRAM = Program(ProgramKind.PDF, b"scripted pdf program")


def service(runtime: ScriptedPdfRuntime | None = None, **more: Any) -> tuple[PdfKernelService, ScriptedPdfRuntime]:
    scripted = runtime or ScriptedPdfRuntime()
    return PdfKernelService(scripted, PROGRAM, **more), scripted


def reply(**members: Any) -> Any:
    def answer(_request: dict[str, Any]) -> dict[str, Any]:
        return members

    return answer


# -- the request the program gets -------------------------------------------------------------------------------------
@pytest.mark.parametrize("op", ["document", "fill", "sign", "complete", "verify", "inspect"])
def test_each_operation_stamps_the_abi_and_its_own_name_and_keeps_the_callers_members(op: str) -> None:
    kernel, runtime = service()
    request: dict[str, Any] = {
        "pdf": {"data": b64(fake_pdf())},
        "signature": {"certificates": []},
        "signing": {"value": "AA=="},
    }
    original = json.dumps(request, sort_keys=True)
    with contextlib.suppress(PdfKernelError, SandboxError):  # the scripted answer may not suit the op's record
        getattr(kernel, op)(request)
    ops = [call.op for call in runtime.calls if call.op == op]
    assert ops == [op]
    sent = runtime.requests(op)[0]
    assert sent["abi"] == PDF_ABI_MIN
    assert sent["op"] == op
    assert {key: value for key, value in sent.items() if key not in {"abi", "op"}} == request
    assert json.dumps(request, sort_keys=True) == original, "the caller's mapping is not changed"


@pytest.mark.parametrize("key", ["abi", "op"])
def test_a_request_that_names_the_abi_or_the_operation_is_refused_before_any_run(key: str) -> None:
    kernel, runtime = service()
    with pytest.raises(ValueError, match=key):
        kernel.document({key: "x"})
    assert runtime.calls == []


def test_the_run_is_one_pdf_pool_run_with_the_pdf_script_and_the_pdf_budget() -> None:
    limits = ProgramLimits(pdf_time_limit=7, pdf_wait=1.5)
    kernel, runtime = service(limits=limits)
    kernel.document({"values": {}})
    (call,) = [item for item in runtime.calls if item.op == "document"]
    assert call.budget.pool is PoolKind.PDF
    assert call.budget == limits.pdf_budget()
    assert call.budget.wall_seconds == 7


def test_the_script_the_arguments_and_the_program_bytes_are_the_pdf_ones() -> None:
    seen: dict[str, Any] = {}

    class Spy(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            program, run_script, argv, stdin, _ = program_parts(job)
            seen.update(program=program, script=run_script, argv=tuple(argv), stdin=stdin)
            return super().run(job)

    kernel, _ = service(Spy())
    kernel.document({"values": {}})
    assert seen["program"] == PROGRAM.data
    assert seen["script"] == PDF_RUN_SCRIPT.encode()
    assert seen["argv"] == guest_argv()
    assert json.loads(seen["stdin"])["op"] in {"capabilities", "document"}


def test_the_request_is_written_as_strict_json() -> None:
    kernel, runtime = service()
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {"n": float("nan")}})
    assert raised.value.reason is SandboxFailure.INPUT
    assert runtime.requests("document") == []


def test_a_sandbox_program_is_not_a_pdf_program() -> None:
    with pytest.raises(ValueError, match="PDF"):
        PdfKernelService(ScriptedPdfRuntime(), Program(ProgramKind.SANDBOX, b"x"))


def test_the_service_names_the_program_it_runs() -> None:
    kernel, _ = service()
    assert kernel.program is PROGRAM


# -- the gate --------------------------------------------------------------------------------------------------------
def test_the_first_call_proves_the_abi_and_a_proof_is_kept_per_program() -> None:
    probe = AbiProbe()
    kernel, runtime = service(probe=probe)
    kernel.document({"values": {}})
    kernel.document({"values": {}})
    assert runtime.ops() == ["capabilities", "document", "document"]
    assert probe.proved(PROGRAM.sha256, PDF_ABI_MIN, kind="pdf")
    assert not probe.proved(PROGRAM.sha256, PDF_ABI_MIN), (
        "a PDF proof is not a sandbox proof, though the floors are the same version"
    )


def test_a_proof_belongs_to_the_program_that_gave_it_and_is_not_lent_to_another() -> None:
    probe = AbiProbe()
    first_program, second_program = Program(ProgramKind.PDF, b"a"), Program(ProgramKind.PDF, b"b")
    first_runtime, second_runtime = ScriptedPdfRuntime(), ScriptedPdfRuntime()
    first = PdfKernelService(first_runtime, first_program, probe=probe)
    second = PdfKernelService(second_runtime, second_program, probe=probe)
    first.document({"values": {}})
    assert probe.proved(first_program.sha256, PDF_ABI_MIN, kind="pdf")
    assert not probe.proved(second_program.sha256, PDF_ABI_MIN, kind="pdf")
    second.document({"values": {}})
    assert second_runtime.ops()[0] == "capabilities"
    assert probe.proved(second_program.sha256, PDF_ABI_MIN, kind="pdf")


def test_prove_abi_is_the_gate_by_itself_and_costs_one_run_once() -> None:
    kernel, runtime = service()
    kernel.prove_abi()
    kernel.prove_abi()
    assert runtime.ops() == ["capabilities"]


def test_the_reply_is_read_into_a_record() -> None:
    kernel, _ = service()
    answer = kernel.capabilities()
    assert isinstance(answer, PdfCapabilities)
    assert answer.abi == ABI
    assert set(FEATURES) <= set(answer.features)


@pytest.mark.parametrize("abi", ["3.17.0", "3.17.99", "3.9.0", "3.0.0", "2.99.0"])
def test_a_program_older_than_the_floor_is_refused_with_the_rebuild_hint_even_if_it_answers_the_request(
    abi: str,
) -> None:
    kernel, runtime = service(ScriptedPdfRuntime(abi=abi))
    with pytest.raises(ProgramUnavailableError) as raised:
        kernel.document({"values": {}})
    assert abi in str(raised.value)
    assert "Rebuild the program assets" in str(raised.value)
    assert runtime.requests("document") == [], "an older program never runs a request"


@pytest.mark.parametrize("abi", ["4.0.0", "4.0.1", "4.1.0", "4.100.0"])
def test_a_program_at_or_above_the_floor_in_the_same_major_passes_compared_by_number_not_by_text(abi: str) -> None:
    kernel, runtime = service(ScriptedPdfRuntime(abi=abi))
    kernel.document({"values": {}})
    assert runtime.ops() == ["capabilities", "document"]


@pytest.mark.parametrize("feature", REQUIRED)
def test_a_program_missing_a_feature_the_host_needs_is_refused_naming_it(feature: str) -> None:
    features = [item for item in FEATURES if item != feature]
    kernel, runtime = service(ScriptedPdfRuntime(features=features))
    with pytest.raises(ProgramUnavailableError) as raised:
        kernel.document({"values": {}})
    assert feature in str(raised.value)
    assert runtime.requests("document") == []


def test_features_the_host_does_not_need_may_be_missing() -> None:
    kernel, runtime = service(ScriptedPdfRuntime(features=REQUIRED))
    kernel.document({"values": {}})
    assert "document" in runtime.ops()


def test_a_refusal_is_never_kept_so_the_next_call_proves_a_repaired_program() -> None:
    probe = AbiProbe()
    runtime = ScriptedPdfRuntime(abi="3.17.0")
    kernel, _ = service(runtime, probe=probe)
    for _ in range(2):
        with pytest.raises(ProgramUnavailableError):
            kernel.document({"values": {}})
    assert runtime.ops() == ["capabilities", "capabilities"]
    assert not probe.proved(PROGRAM.sha256, PDF_ABI_MIN, kind="pdf")
    runtime.abi = ABI
    kernel.document({"values": {}})
    assert probe.proved(PROGRAM.sha256, PDF_ABI_MIN, kind="pdf")


@pytest.mark.parametrize(
    "answer",
    [
        {"ok": False, "error": {"code": "abi_mismatch", "message": "x"}},
        {"ok": "true", "abi": ABI, "features": list(FEATURES)},
        {"ok": 1, "abi": ABI, "features": list(FEATURES)},
        {"abi": ABI, "features": list(FEATURES)},
        {"ok": True, "features": list(FEATURES)},
        {"ok": True, "abi": ABI},
        {"ok": True, "abi": 3, "features": list(FEATURES)},
        {"ok": True, "abi": ABI, "features": "signature"},
        {"ok": True, "abi": ABI, "features": [1, 2]},
        {"ok": True, "abi": "three", "features": list(FEATURES)},
        {"ok": True, "op": "verify", "abi": ABI, "features": list(FEATURES)},
        {"ok": True, "op": 5, "abi": ABI, "features": list(FEATURES)},
    ],
)
def test_a_reply_that_is_not_strictly_a_capabilities_answer_fails_the_gate(answer: dict[str, Any]) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.raw("capabilities", answer)
    kernel, _ = service(runtime)
    with pytest.raises(ProgramUnavailableError):
        kernel.document({"values": {}})
    assert runtime.requests("document") == []


@pytest.mark.parametrize("raw", [b"", b"not json", b"[1, 2]", b"null", b'"ok"', b"\xff\xfe"])
def test_a_reply_that_is_not_a_json_object_fails_the_gate(raw: bytes) -> None:
    class Odd(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            del job
            return RunResult(RunEnd.CLEAN, raw, b"", 0)

    kernel, runtime = service(Odd())
    with pytest.raises(ProgramUnavailableError) as raised:
        kernel.document({"values": {}})
    assert "Rebuild the program assets" in str(raised.value)
    assert runtime.requests("document") == []


@pytest.mark.parametrize("end", [RunEnd.TRAP, RunEnd.BUDGET])
def test_a_probe_run_that_traps_or_passes_its_budget_fails_the_gate_with_the_rebuild_hint(end: RunEnd) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.end("capabilities", end)
    kernel, _ = service(runtime)
    with pytest.raises(ProgramUnavailableError):
        kernel.document({"values": {}})
    assert runtime.requests("document") == []


@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (EngineBusyError("every slot is taken"), SandboxFailure.BUSY),
        (EngineClosedError("closed"), SandboxFailure.INTERRUPTED),
    ],
)
def test_a_probe_run_that_is_busy_or_interrupted_stays_a_sandbox_error(
    failure: Exception, reason: SandboxFailure
) -> None:
    class Refusing(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            del job
            raise failure

    kernel, _ = service(Refusing())
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is reason


def test_a_run_at_a_full_stray_bound_is_server_unavailable_for_the_probe_and_for_a_request() -> None:
    class Full(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] in self.full:
                raise EngineStrayBoundError(1, 1)
            return super().run(job)

        full: frozenset[str] = frozenset({"capabilities"})

    runtime = Full()
    kernel, _ = service(runtime)
    with pytest.raises(StrayBoundError) as probe:
        kernel.document({"values": {}})
    assert "probe" not in probe.value.message  # not read as a program that failed its gate
    runtime.full = frozenset({"document"})
    with pytest.raises(StrayBoundError) as request:
        kernel.document({"values": {}})
    assert (request.value.code, request.value.status) == ("server.unavailable", 503)
    assert request.value.message == (
        "The PDF runtime is unavailable: runs that would not stop have not ended, so no new run starts until they do."
    )


def test_a_run_refused_at_the_stray_bound_is_recorded_as_the_failed_word_unavailable() -> None:
    class Full(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                raise EngineStrayBoundError(1, 1)
            return super().run(job)

    records: list[RunRecord] = []
    kernel, _ = service(Full(), recorder=records.append)
    kernel.prove_abi()
    with pytest.raises(StrayBoundError):
        kernel.document({"values": {}})
    (_, record) = records  # the probe's run, then the refused one
    assert (record.op, record.outcome, record.result) == ("document", "unavailable", None)


def test_a_full_stray_bound_is_not_counted_busy_and_is_an_error_span() -> None:
    probe = telemetry()

    class Full(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            del job
            raise EngineStrayBoundError(1, 1)

    kernel, _ = observed(Full())
    before = probe.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
    with pytest.raises(StrayBoundError):
        kernel.document({"values": {}})
    assert probe.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == before
    (span,) = probe.spans("datum.pdf.run")
    assert attrs(span)["datum.outcome"] == "failed"
    assert attrs(span)["error.type"] == "StrayBoundError"
    assert span.status.status_code is StatusCode.ERROR


def test_require_pdf_capabilities_is_the_pure_judge_of_a_reply() -> None:
    require_pdf_capabilities({"ok": True, "op": "capabilities", "abi": ABI, "features": list(FEATURES)})
    with pytest.raises(ProgramUnavailableError):
        require_pdf_capabilities({"ok": True, "op": "verify", "abi": ABI, "features": list(FEATURES)})
    with pytest.raises(ProgramUnavailableError):
        require_pdf_capabilities({"ok": True, "abi": "3.17.0", "features": list(FEATURES)})
    with pytest.raises(ProgramUnavailableError):
        require_pdf_capabilities({"ok": True, "abi": ABI, "features": []})
    with pytest.raises(ProgramUnavailableError):
        require_pdf_capabilities(None)


# -- the answers, read strictly --------------------------------------------------------------------------------------
def test_a_document_answer_becomes_a_produced_record() -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on(
        "document",
        reply(
            bytes=b64(fake_pdf("doc")),
            pageCount=3,
            pages=[],
            warnings=[{"code": "component.unknown", "message": "m", "componentId": "rows"}],
            layoutId="default",
            layoutKind="derived",
        ),
    )
    kernel, _ = service(runtime)
    produced = kernel.document({"values": {}})
    assert isinstance(produced, PdfProduced)
    assert produced.pdf == fake_pdf("doc")
    assert produced.page_count == 3
    assert (produced.layout_id, produced.layout_kind) == ("default", "derived")
    (warning,) = produced.warnings
    assert (warning.code, warning.message, warning.component_id) == ("component.unknown", "m", "rows")
    assert produced.signing is None
    assert b64(fake_pdf("doc")) not in repr(produced)
    assert "%PDF" not in repr(produced), "the bytes stay out of repr"


def test_a_prepared_document_carries_the_handoff_decoded() -> None:
    kernel, _ = service()
    produced = kernel.document({"values": {}, "signature": {"certificates": ["AA=="]}})
    handoff = produced.signing
    assert handoff is not None
    sent = signing_handoff(produced.pdf, algorithm="RSASSA-PKCS1-v1_5-SHA256", serial=1)
    assert handoff.field_name == "Signature1"
    assert handoff.to_be_signed == base64.b64decode(sent["toBeSigned"])
    assert handoff.to_be_signed_digest == hashlib.sha256(handoff.to_be_signed).digest()
    assert handoff.digest == base64.b64decode(sent["digest"])
    assert handoff.byte_range == tuple(sent["byteRange"])
    assert handoff.signature_algorithm == "RSASSA-PKCS1-v1_5-SHA256"


@pytest.mark.parametrize(
    "answer",
    [
        {"pageCount": 1},  # no bytes
        {"bytes": "!!!", "pageCount": 1},  # not base64
        {"bytes": b64(b"x"), "pageCount": "1"},  # page count not an integer
        {"bytes": b64(b"x"), "pageCount": True},  # a boolean is not a count
        {"bytes": 5, "pageCount": 1},
        {"bytes": b64(b"x"), "pageCount": 1, "warnings": "none"},
        {"bytes": b64(b"x"), "pageCount": 1, "signing": {"toBeSigned": "AA=="}},  # an incomplete handoff
        {"bytes": b64(b"x"), "pageCount": 1, "ok": "yes"},
    ],
)
def test_a_document_answer_that_is_not_strictly_well_formed_is_refused_never_half_read(answer: dict[str, Any]) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("document", reply(**answer))
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.NO_OUTCOME


def test_the_other_operations_read_into_their_own_records() -> None:
    kernel, _ = service()
    assert isinstance(kernel.fill({"values": {}}), PdfProduced)
    assert isinstance(kernel.sign({"pdf": {"data": ""}, "signature": {"certificates": []}}), PdfSigned)
    completed = kernel.complete({"pdf": {"data": ""}, "signing": {"value": "AA=="}})
    assert isinstance(completed, PdfCompleted)
    assert (completed.field_name, completed.timestamped, completed.pdf.startswith(b"%PDF-")) == (
        "Signature1",
        False,
        True,
    )
    assert isinstance(kernel.verify({"pdf": {"data": ""}}), PdfVerified)
    assert isinstance(kernel.inspect({"template": {"data": ""}}), PdfInspected)


def test_complete_says_timestamped_only_for_the_boolean_true() -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("complete", reply(bytes=b64(b"x"), field="Signature1", cms=b64(b"c"), timestamped="yes"))
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError) as raised:
        kernel.complete({"pdf": {"data": ""}, "signing": {"value": "AA=="}})
    assert raised.value.reason is SandboxFailure.NO_OUTCOME


def test_a_verify_answer_keeps_the_programs_signature_reports_as_sent() -> None:
    runtime = ScriptedPdfRuntime()
    report = {"field": "Signature1", "toBeVerified": "AA==", "signer": {"publicKey": "AA=="}}
    runtime.on(
        "verify",
        reply(signatures=[report], attachments=[], warnings=[{"code": "w", "message": "m"}], documentId="ab" * 16),
    )
    kernel, _ = service(runtime)
    verified = kernel.verify({"pdf": {"data": ""}})
    assert verified.signatures == (report,)
    assert verified.document_id == "ab" * 16
    assert verified.warnings[0].code == "w"


@pytest.mark.parametrize("bad", [{"signatures": "none"}, {"signatures": [1]}, {}, {"signatures": [], "documentId": 5}])
def test_a_verify_answer_without_a_list_of_reports_is_refused_never_read_as_no_signatures(bad: dict[str, Any]) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("verify", reply(**bad))
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError) as raised:
        kernel.verify({"pdf": {"data": ""}})
    assert raised.value.reason is SandboxFailure.NO_OUTCOME


# -- the programs own refusals ----------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    "code", ["signature", "template", "layout", "font", "invalid_request", "render_limit", "internal"]
)
def test_a_refusal_of_the_program_is_raised_with_its_code_and_message_and_never_answered(code: str) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.fail("document", code, f"words of {code}")
    kernel, _ = service(runtime)
    with pytest.raises(PdfKernelError) as raised:
        kernel.document({"values": {}})
    assert raised.value.code == code
    assert raised.value.message == f"words of {code}"
    assert raised.value.status == 500


def test_a_refusal_with_no_code_or_a_foreign_shape_is_still_a_refusal() -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("document", lambda _request: {"ok": False})
    kernel, _ = service(runtime)
    with pytest.raises(PdfKernelError) as raised:
        kernel.document({"values": {}})
    assert raised.value.code == "unknown"


# -- how a run can end ----------------------------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("end", "reason"),
    [
        (RunEnd.BUDGET, SandboxFailure.BUDGET),
        (RunEnd.STUCK, SandboxFailure.BUDGET),
        (RunEnd.MEMORY, SandboxFailure.MEMORY),
        (RunEnd.TRAP, SandboxFailure.TRAP),
        (RunEnd.OUTPUT_CAP, SandboxFailure.OUTPUT_CAP),
        (RunEnd.INTERRUPTED, SandboxFailure.INTERRUPTED),
    ],
)
def test_a_run_that_does_not_end_clean_is_a_sandbox_error_of_the_sandboxs_reasons_and_never_an_answer(
    end: RunEnd, reason: SandboxFailure
) -> None:
    runtime = ScriptedPdfRuntime()
    kernel, _ = service(runtime)
    kernel.prove_abi()
    runtime.end("document", end)
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is reason


def _document_answer() -> bytes:
    return json.dumps({"ok": True, "op": "document", "bytes": b64(b"x"), "pageCount": 1}).encode()


@pytest.mark.parametrize(("exit_code", "answers"), [(1, False), (0, True)])
def test_an_exit_end_is_an_answer_only_with_exit_code_zero(exit_code: int, answers: bool) -> None:
    class Exits(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                return RunResult(RunEnd.EXIT, _document_answer(), b"", exit_code)
            return super().run(job)

    kernel, _ = service(Exits())
    if answers:
        assert isinstance(kernel.document({"values": {}}), PdfProduced)
        return
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.THREW


def test_more_stdout_than_the_cap_is_the_output_cap_even_without_the_capped_flag() -> None:
    cap = ProgramLimits().pdf_budget().stdout_cap

    class Over(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                return RunResult(RunEnd.CLEAN, b"x" * (cap + 1), b"", 0, stdout_capped=False)
            return super().run(job)

    kernel, _ = service(Over())
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.OUTPUT_CAP


def test_an_answer_nested_past_the_depth_limit_is_not_json() -> None:
    deep = b'{"ok":true,"op":"document","x":' + b"[" * 513 + b"]" * 513 + b"}"

    class Deep(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                return RunResult(RunEnd.CLEAN, deep, b"", 0)
            return super().run(job)

    kernel, _ = service(Deep())
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.NOT_JSON


def test_stdout_cut_at_the_cap_is_the_output_cap_even_if_the_run_ended_clean() -> None:
    class Capped(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            result = super().run(job)
            if json.loads(stdin)["op"] == "document":
                return RunResult(RunEnd.CLEAN, result.stdout, b"", 0, stdout_capped=True)
            return result

    kernel, _ = service(Capped())
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.OUTPUT_CAP


def test_a_busy_engine_is_busy_and_a_closing_one_is_interrupted() -> None:
    class Busy(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                raise self.failure
            return super().run(job)

        failure: Exception = EngineBusyError("every slot is taken")

    runtime = Busy()
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError) as busy:
        kernel.document({"values": {}})
    assert busy.value.reason is SandboxFailure.BUSY
    assert busy.value.code == "server.busy"
    runtime.failure = EngineClosedError("closed")
    with pytest.raises(SandboxError) as closed:
        kernel.document({"values": {}})
    assert closed.value.reason is SandboxFailure.INTERRUPTED


def test_a_runtime_that_blows_up_is_the_program_being_unavailable_with_no_cause_text_in_the_message() -> None:
    class Broken(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                raise RuntimeError("wasmtime exploded at /secret/path")
            return super().run(job)

    kernel, _ = service(Broken())
    with pytest.raises(ProgramUnavailableError) as raised:
        kernel.document({"values": {}})
    assert "/secret/path" not in str(raised.value)
    assert isinstance(raised.value.__cause__, RuntimeError)


def test_a_refusal_message_never_carries_the_programs_stderr_or_the_requests_bytes() -> None:
    class Loud(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            if json.loads(stdin)["op"] == "document":
                return RunResult(RunEnd.TRAP, b"", b"stack: SECRET-STDERR " + stdin[:40], None)
            return super().run(job)

    kernel, _ = service(Loud())
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {"name": "REQUEST-BYTES"}})
    assert "SECRET-STDERR" not in raised.value.message
    assert "REQUEST-BYTES" not in raised.value.message


# -- composition ------------------------------------------------------------------------------------------------------
class Tag:
    """A kernel that adds a tag to the log and delegates (the middleware contract)."""

    def __init__(self, name: str, inner: Any, log: list[str]) -> None:
        self.name, self.inner, self.log = name, inner, log

    @property
    def program(self) -> Program:
        return self.inner.program  # type: ignore[no-any-return]

    def document(self, request: Mapping[str, Any]) -> Any:
        self.log.append(self.name)
        return self.inner.document(request)

    def __getattr__(self, name: str) -> Any:
        return getattr(self.inner, name)


def test_the_first_middleware_is_outermost_and_the_observation_is_innermost() -> None:
    log: list[str] = []
    own, _ = service()
    composed = compose_pdf_kernel(
        own,
        middleware=[lambda k: Tag("one", k, log), lambda k: Tag("two", k, log)],
        observation=lambda k: Tag("observe", k, log),
    )
    composed.document({"values": {}})
    assert log == ["one", "two", "observe"]


def test_a_replacement_kernel_goes_through_the_same_chain_once() -> None:
    log: list[str] = []
    own, _ = service()
    replacement, runtime = service()
    composed = compose_pdf_kernel(own, replacement=replacement, middleware=[lambda k: Tag("mw", k, log)])
    composed.document({"values": {}})
    assert log == ["mw"]
    assert runtime.requests("document") != []


def answers_none(_kernel: Any) -> Any:
    return None


def test_a_middleware_that_answers_none_is_refused_naming_the_protocol() -> None:
    own, _ = service()
    with pytest.raises(TypeError, match="PdfKernel"):
        compose_pdf_kernel(own, middleware=[answers_none])


# -- the real program --------------------------------------------------------------------------------------------------
@pytest.mark.runtime
def test_the_real_program_passes_the_gate_and_prints_and_verifies() -> None:
    import pdf_kernel  # noqa: PLC0415 - runtime rows only

    from datum_sandbox.testing.fixtures import pdf_program  # noqa: PLC0415

    with pdf_kernel.pdf_session() as session:
        kernel = PdfKernelService(session.runtime, pdf_program(), limits=ProgramLimits(pdf_time_limit=120))
        capabilities = kernel.capabilities()
        assert capabilities.abi == "4.0.0"
        assert set(REQUIRED) <= set(capabilities.features)
        request = pdf_kernel.document_request()
        del request["abi"], request["op"]
        produced = kernel.document(request)
        assert produced.pdf.startswith(b"%PDF-")
        assert produced.page_count >= 1
        verified = kernel.verify({"pdf": {"data": b64(produced.pdf)}})
        assert verified.signatures == ()
        with pytest.raises(PdfKernelError) as raised:
            kernel.verify({"pdf": {"data": b64(b"hello")}})
        assert raised.value.code == "internal"


@pytest.mark.runtime
def test_the_real_program_accepts_any_request_of_its_major_so_only_the_gate_can_tell_the_two_apart() -> None:
    import pdf_kernel  # noqa: PLC0415 - runtime rows only

    with pdf_kernel.pdf_session() as session:
        answer = session.call({"abi": "4.99.0", "op": "capabilities"})
    assert answer["ok"] is True
    assert PDF_ABI_MIN == "4.0.0"


# -- more of the strict reading and the gate ----------------------------------------------------------------------
@pytest.mark.parametrize(
    "abi", ["5.0.0", "3.18.0", "3.100.0", "4.0", "4.0.0-rc1", "4.0.0.1", "v4.0.0", "4.-1.0", " 4.0.0"]
)
def test_a_reply_that_is_another_major_or_not_exactly_three_numbers_is_refused(abi: str) -> None:
    kernel, runtime = service(ScriptedPdfRuntime(abi=abi))
    with pytest.raises(ProgramUnavailableError):
        kernel.document({"values": {}})
    assert runtime.requests("document") == []


def test_a_reported_abi_that_is_not_a_version_is_not_echoed_into_the_message() -> None:
    hostile = "3.x " + "A" * 5000 + " /secret/path"
    kernel, _ = service(ScriptedPdfRuntime(abi=hostile))
    with pytest.raises(ProgramUnavailableError) as raised:
        kernel.document({"values": {}})
    assert "/secret/path" not in str(raised.value)
    assert len(str(raised.value)) < 600


def test_a_program_error_code_that_is_not_a_plain_word_is_unknown_and_the_message_is_cut() -> None:
    runtime = ScriptedPdfRuntime()
    runtime.fail("document", "bad code/with spaces\n", "x" * 10_000)
    kernel, _ = service(runtime)
    with pytest.raises(PdfKernelError) as raised:
        kernel.document({"values": {}})
    assert raised.value.code == "unknown"
    assert len(raised.value.message) == 2000


def test_a_reply_that_names_another_operation_is_refused() -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("document", lambda request: {"op": "fill", "bytes": b64(b"x"), "pageCount": 1})
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.NO_OUTCOME


@pytest.mark.parametrize("empty", [{"bytes": ""}, {"bytes": b64(b"x") + "\n"}, {"pageCount": 0}, {"pageCount": -1}])
def test_a_file_with_no_bytes_bad_base64_or_no_pages_is_refused(empty: dict[str, Any]) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("document", reply(**{"bytes": b64(b"x"), "pageCount": 1, **empty}))
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError):
        kernel.document({"values": {}})


@pytest.mark.parametrize(
    "mutate",
    [
        {"signatureAlgorithm": "RSASSA-PSS-SHA256"},
        {"byteRange": [0, 1, 2]},
        {"byteRange": [0, 1, 2, True]},
        {"byteRange": [0, 1, 2, -3]},
        {"toBeSigned": ""},
        {"toBeSignedDigest": 5},
        {"subFilter": None},
        {"field": ""},
    ],
)
def test_a_handoff_the_host_could_not_sign_or_complete_is_refused(mutate: dict[str, Any]) -> None:
    kernel, _ = service()
    good = kernel.sign({"pdf": {"data": ""}, "signature": {"certificates": []}}).signing
    assert good.field_name == "Signature1"
    runtime = ScriptedPdfRuntime()
    default = runtime._handoff({"certificates": []}, fake_pdf("prepared"))
    runtime.on("sign", lambda _r: {"bytes": b64(b"x"), "signing": {**default, **mutate}})
    broken, _ = service(runtime)
    with pytest.raises(SandboxError):
        broken.sign({"pdf": {"data": ""}, "signature": {"certificates": []}})


def test_the_records_hide_the_inspection_and_the_attachments_from_repr() -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("inspect", reply(info={"title": "NEEDLE-INFO"}))
    runtime.on("verify", reply(signatures=[], attachments=[{"name": "NEEDLE-ATTACHMENT"}]))
    kernel, _ = service(runtime)
    assert "NEEDLE" not in repr(kernel.inspect({"template": {"data": ""}}))
    assert "NEEDLE" not in repr(kernel.verify({"pdf": {"data": ""}}))


@pytest.mark.parametrize("ok", ["yes", "true", 1, 0, None, [], {}])
def test_an_ok_that_is_not_a_boolean_is_no_answer_and_never_a_refusal_of_the_program(ok: Any) -> None:
    runtime = ScriptedPdfRuntime()
    runtime.on("document", lambda _request: {"ok": ok, "op": "document", "bytes": b64(b"x"), "pageCount": 1})
    kernel, _ = service(runtime)
    with pytest.raises(SandboxError) as raised:
        kernel.document({"values": {}})
    assert raised.value.reason is SandboxFailure.NO_OUTCOME


def test_a_run_reads_the_request_from_stdin_with_no_nonce_frame() -> None:
    seen: list[bytes] = []

    class Spy(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            _, _, _, stdin, _ = program_parts(job)
            seen.append(stdin)
            return super().run(job)

    kernel, _ = service(Spy())
    kernel.document({"values": {"name": "Ada"}})
    assert all(item.startswith(b"{") and item.endswith(b"}") for item in seen)
    assert json.loads(seen[-1])["values"] == {"name": "Ada"}


# -- the span ---------------------------------------------------------------------------------------------------------
def observed(runtime: ScriptedPdfRuntime | None = None, mode: str = "test") -> tuple[Any, ScriptedPdfRuntime]:
    own, scripted = service(runtime)
    return compose_pdf_kernel(own, observation=lambda inner: ObservedPdfKernel(inner, lambda: mode)), scripted


@pytest.mark.parametrize("op", ["document", "fill", "sign", "complete", "verify", "inspect"])
def test_every_operation_is_one_pdf_run_span_with_its_op_and_the_engine_mode_and_nothing_else(op: str) -> None:
    probe = telemetry()
    kernel, _ = observed(mode="wasmtime")
    request: dict[str, Any] = {"pdf": {"data": ""}, "signature": {"certificates": []}, "signing": {"value": "AA=="}}
    getattr(kernel, op)(request)
    (span,) = probe.spans("datum.pdf.run")
    assert attrs(span) == {"datum.op": op, "datum.engine.mode": "wasmtime", "datum.outcome": "completed"}
    assert span.status.status_code is not StatusCode.ERROR
    assert probe.spans("datum.sandbox.run") == []


def test_the_run_span_is_a_child_of_the_open_span_and_the_gate_run_is_inside_it() -> None:
    probe = telemetry()
    kernel, runtime = observed()
    with trace.get_tracer("datum").start_as_current_span("outer"):
        kernel.document({"values": {}})
    (span,) = probe.spans("datum.pdf.run")
    parent = probe.parent_of(span)
    assert parent is not None
    assert parent.name == "outer"
    assert runtime.ops() == ["capabilities", "document"], (
        "the gate's run is part of the first call, not a span of its own"
    )


def test_a_refusal_of_the_program_is_a_normal_outcome_not_an_error_span() -> None:
    probe = telemetry()
    runtime = ScriptedPdfRuntime()
    runtime.fail("document", "template", "no")
    kernel, _ = observed(runtime)
    with pytest.raises(PdfKernelError):
        kernel.document({"values": {}})
    (span,) = probe.spans("datum.pdf.run")
    assert attrs(span)["datum.outcome"] == "refused"
    assert span.status.status_code is not StatusCode.ERROR


def test_a_stopped_run_marks_the_span_with_the_reason_and_the_error_status() -> None:
    probe = telemetry()
    runtime = ScriptedPdfRuntime()
    kernel, _ = observed(runtime)
    kernel.capabilities()
    runtime.end("verify", RunEnd.BUDGET)
    with pytest.raises(SandboxError):
        kernel.verify({"pdf": {"data": ""}})
    span = probe.spans("datum.pdf.run")[-1]
    assert attrs(span)["datum.outcome"] == "budget"
    assert attrs(span)["error.type"] == "SandboxError"
    assert span.status.status_code is StatusCode.ERROR


def test_a_busy_engine_counts_once_on_the_rejection_counter_and_is_not_an_error_span() -> None:
    probe = telemetry()

    class Busy(ScriptedPdfRuntime):
        def run(self, job: GuestRun, /) -> RunResult:
            del job
            raise EngineBusyError("slots")

    kernel, _ = observed(Busy())
    before = probe.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"})
    with pytest.raises(SandboxError):
        kernel.document({"values": {}})
    assert probe.total("datum.sandbox.run.rejected", **{"datum.reason": "busy"}) == before + 1
    (span,) = probe.spans("datum.pdf.run")
    assert attrs(span)["datum.outcome"] == "busy"
    assert span.status.status_code is not StatusCode.ERROR


def test_the_run_histogram_names_the_pdf_program_and_the_active_gauge_returns_to_where_it_was() -> None:
    probe = telemetry()
    kernel, _ = observed()
    before = probe.observations("datum.sandbox.run.duration", **{"datum.program": "pdf"})
    active = probe.total("datum.sandbox.run.active", **{"datum.program": "pdf"})
    kernel.document({"values": {}})
    assert probe.observations("datum.sandbox.run.duration", **{"datum.program": "pdf"}) == before + 1
    assert probe.total("datum.sandbox.run.active", **{"datum.program": "pdf"}) == active


def test_the_span_carries_no_bytes_no_request_and_no_message() -> None:
    probe = telemetry()
    runtime = ScriptedPdfRuntime()
    runtime.fail("verify", "internal", "SECRET-MESSAGE")
    kernel, _ = observed(runtime)
    with pytest.raises(PdfKernelError):
        kernel.verify({"pdf": {"data": b64(b"SECRET-PDF")}})
    text = " ".join(f"{s.name} {dict(s.attributes or {})} {s.status}" for s in probe.spans())
    assert "SECRET" not in text
    assert b64(b"SECRET-PDF") not in text


def test_the_observed_kernel_names_the_program_it_wraps_and_delegates_the_gate_question() -> None:
    kernel, _ = observed()
    assert kernel.program is PROGRAM
    assert kernel.capabilities().abi == ABI
