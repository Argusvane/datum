"""SandboxService over a fake runtime answering scripted stdout and stderr bytes: the protocol, refusal by refusal."""

# ruff: noqa: PT011

import json
import logging
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field, replace
from datetime import UTC, datetime
from typing import TYPE_CHECKING, cast
from zoneinfo import ZoneInfo

import pytest

if TYPE_CHECKING:
    from datum_sandbox.json import JsonValue

from datum_sandbox.protocol import (
    MAX_OUTCOME_UNITS,
    SANDBOX_ABI_MIN,
    AbiProbe,
    DefinitionTooCostlyError,
    DefinitionTooDeepError,
    Entry,
    FormulaErrors,
    HostOptions,
    Program,
    ProgramKind,
    ProgramLimits,
    ProgramUnavailableError,
    RiskyPatterns,
    RuleModule,
    RunLogEntry,
    SandboxError,
    SandboxFailure,
    SandboxService,
    StrayBoundError,
    guest_argv,
    marker,
    utf16_units,
)
from datum_sandbox.protocol._classify import read_outcome
from datum_sandbox.testing.runtime_support import program_parts
from datum_sandbox.wasi import (
    STDOUT_CAP,
    EngineBusyError,
    EngineClosedError,
    EngineInfo,
    EngineStrayBoundError,
    GuestRun,
    RunBudget,
    RunEnd,
    RunResult,
)

FREEZE = "(function () {\n  /* the freeze snippet */\n})();"
PROGRAM = Program(ProgramKind.SANDBOX, b"/* the sandbox program */")


@dataclass
class Call:
    """One run the fake runtime was asked for."""

    nonce: str
    payload: dict[str, object]
    script: str
    argv: tuple[str, ...]
    budget: RunBudget
    program: bytes

    @property
    def probe(self) -> bool:
        definition = self.payload.get("definition")
        return isinstance(definition, dict) and cast("dict[str, object]", definition).get("id") == "datum-abi-probe"


def honest(answer: bytes, nonce: str) -> bytes:
    return (
        marker(nonce, "started")
        + b"\n"
        + marker(nonce, "begin")
        + b"\n"
        + answer
        + b"\n"
        + marker(nonce, "end")
        + b"\n"
    )


def clean(stdout: bytes, **kw: object) -> RunResult:
    return RunResult(end=RunEnd.CLEAN, stdout=stdout, stderr=kw.pop("stderr", b""), elapsed=0.01, **kw)  # type: ignore[arg-type]


type Behaviour = Callable[[Call], RunResult]


def kernel(call: Call) -> RunResult:
    """An honest program: the probe answers ok, a run answers no errors, an inspect answers ok with its op."""
    if call.probe:
        return clean(honest(b'{"ok":true,"op":"inspect"}', call.nonce))
    if "op" in call.payload:
        body: dict[str, object] = {
            "ok": True,
            "op": call.payload["op"],
            "structure": [],
            "structureWarnings": [],
            "definition": {"id": "p"},
        }
        return clean(honest(json.dumps(body).encode(), call.nonce))
    return clean(honest(b'{"errors":[]}', call.nonce))


@dataclass
class FakeRuntime:
    """A GuestRuntime whose answers are scripted; the probe is answered honestly unless `probe` is set."""

    behaviour: Behaviour = kernel
    probe: Behaviour | None = None
    raises: BaseException | None = None
    calls: list[Call] = field(default_factory=list[Call])

    def run(self, job: GuestRun, /) -> RunResult:
        program, run_script, argv, stdin, budget = program_parts(job)
        nonce, _, rest = stdin.partition(b"\n")
        call = Call(nonce.decode(), json.loads(rest), run_script.decode(), tuple(argv), budget, program)
        self.calls.append(call)
        if self.raises is not None:
            raise self.raises
        if call.probe:
            return (self.probe or kernel)(call)
        return self.behaviour(call)

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo("fake", "0", "test")

    def close(self) -> None:
        pass

    @property
    def runs(self) -> list[Call]:
        return [c for c in self.calls if not c.probe]


def service(runtime: FakeRuntime, **kw: object) -> SandboxService:
    return SandboxService(runtime, PROGRAM, freeze_snippet=FREEZE, **kw)  # type: ignore[arg-type]


CONTEXT: "Mapping[str, JsonValue]" = {
    "formId": "contact",
    "form": {"id": "root", "type": "form", "configuration": {}, "children": {"content": []}},
    "values": {},
    "locale": "en",
}


def failure(runtime: FakeRuntime, **kw: object) -> SandboxError:
    with pytest.raises(SandboxError) as raised:
        service(runtime, **kw).validate(CONTEXT, real=False)
    return raised.value


def answering(stdout: Callable[[str], bytes], **kw: object) -> FakeRuntime:
    return FakeRuntime(lambda call: replace(clean(stdout(call.nonce)), **kw))  # type: ignore[arg-type]


# --- the honest path ---------------------------------------------------------------------------------------------


def test_validate_runs_the_protocol() -> None:
    runtime = FakeRuntime()
    clock = datetime(2026, 1, 1, 3, 0, tzinfo=UTC)
    options = HostOptions(FormulaErrors.FAIL, RiskyPatterns.REFUSE, ZoneInfo("America/Toronto"), lambda: clock)
    result = service(runtime, host_options=options).validate(
        {**CONTEXT, "formulaErrors": "warn", "riskyPatterns": "allow", "today": "2099-01-01"},
        [RuleModule("r", "1", "({ validators: [] })")],
        real=True,
    )
    assert result.outcome == {"errors": []}
    probe, run = runtime.calls
    assert probe.probe
    assert probe.payload["abi"] == SANDBOX_ABI_MIN
    # The host's keys are set over what the context carried.
    assert run.payload["formulaErrors"] == "fail"
    assert run.payload["riskyPatterns"] == "refuse"
    assert run.payload["today"] == "2025-12-31"
    assert run.argv == guest_argv()
    assert run.program == PROGRAM.data
    assert run.budget == ProgramLimits().validation_budget()
    assert "  var entry = globalThis.__datum_run;" in run.script
    assert 'register(evaluate("(\\n({ validators: [] })\\n)"));' in run.script
    assert "/* the freeze snippet */" in run.script


def test_each_run_has_a_fresh_nonce() -> None:
    runtime = FakeRuntime()
    sandbox = service(runtime)
    for _ in range(5):
        sandbox.validate(CONTEXT, real=False)
    nonces = [c.nonce for c in runtime.calls]
    assert len(set(nonces)) == len(nonces) == 6


def test_the_caller_context_is_not_changed() -> None:
    context = dict(CONTEXT)
    service(FakeRuntime()).validate(context, real=False)
    assert context == CONTEXT


def test_program_kind_and_snippet_checked() -> None:
    with pytest.raises(ValueError, match="sandbox program"):
        SandboxService(FakeRuntime(), Program(ProgramKind.PDF, b"x"), freeze_snippet=FREEZE)
    with pytest.raises(ValueError, match="freeze snippet"):
        SandboxService(FakeRuntime(), PROGRAM, freeze_snippet="")


# --- the ABI gate ------------------------------------------------------------------------------------------------


def test_probe_runs_once_per_program() -> None:
    runtime = FakeRuntime()
    probe = AbiProbe()
    first = service(runtime, probe=probe)
    first.validate(CONTEXT, real=False)
    first.validate(CONTEXT, real=False)
    service(runtime, probe=probe).validate(CONTEXT, real=False)
    assert sum(c.probe for c in runtime.calls) == 1
    other = SandboxService(runtime, Program(ProgramKind.SANDBOX, b"another build"), freeze_snippet=FREEZE, probe=probe)
    other.prove_abi()
    assert sum(c.probe for c in runtime.calls) == 2


LYING_PROBES = [
    b'{"ok":"true"}',
    b'{"ok":1}',
    b'{"ok":false,"error":{"code":"abi_mismatch"}}',
    b'{"ok":null}',
    b"[true]",
    b"true",
    b"not json",
    b'{"ok":true,"ok":false}',
    b"",
]


@pytest.mark.parametrize("answer", LYING_PROBES)
def test_probe_answer_must_be_ok_true(answer: bytes) -> None:
    runtime = FakeRuntime(probe=lambda call: clean(honest(answer, call.nonce)))
    with pytest.raises(ProgramUnavailableError, match=r"ABI 4\.1\.0") as raised:
        service(runtime).validate(CONTEXT, real=False)
    assert not runtime.runs  # no submission is judged by an unproved program
    if b"abi_mismatch" in answer:
        assert "(abi_mismatch)" in raised.value.message


def test_probe_refusal_is_never_remembered() -> None:
    answers = iter([b'{"ok":false}', b'{"ok":true}'])
    runtime = FakeRuntime(probe=lambda call: clean(honest(next(answers), call.nonce)))
    sandbox = service(runtime)
    with pytest.raises(ProgramUnavailableError):
        sandbox.validate(CONTEXT, real=False)
    sandbox.validate(CONTEXT, real=False)
    assert sum(c.probe for c in runtime.calls) == 2


def test_probe_that_cannot_run_is_unavailable_but_busy_stays_busy() -> None:
    trapped = FakeRuntime(probe=lambda call: RunResult(end=RunEnd.TRAP, stdout=b"", stderr=b""))
    with pytest.raises(ProgramUnavailableError):
        service(trapped).prove_abi()
    busy = FakeRuntime(raises=EngineBusyError("slots"))
    with pytest.raises(SandboxError) as raised:
        service(busy).prove_abi()
    assert raised.value.reason is SandboxFailure.BUSY


def test_forged_probe_frame_is_refused() -> None:
    runtime = FakeRuntime(probe=lambda call: clean(honest(b'{"ok":true}', "0" * 32)))
    with pytest.raises(ProgramUnavailableError):
        service(runtime).prove_abi()


# --- the depth guard ---------------------------------------------------------------------------------------------


def nested_form(levels: int) -> dict[str, object]:
    node: dict[str, object] = {"id": f"c{levels}", "type": "group"}
    for level in range(levels - 1, 0, -1):
        node = {"id": f"c{level}" if level > 1 else "root", "type": "group", "children": {"content": [node]}}
    return node


def test_depth_guard_runs_before_any_guest() -> None:
    runtime = FakeRuntime()
    with pytest.raises(DefinitionTooDeepError) as raised:
        service(runtime).validate({**CONTEXT, "form": nested_form(33)}, real=False)  # type: ignore[dict-item]
    assert raised.value.code == "definition.tooDeep"
    assert runtime.calls == []
    service(runtime).validate({**CONTEXT, "form": nested_form(32)}, real=False)  # type: ignore[dict-item]
    assert len(runtime.runs) == 1


def test_depth_guard_covers_the_journey_and_raw_depth() -> None:
    runtime = FakeRuntime()
    journey = {"id": "j", "pages": [{"id": "p", "components": [nested_form(33)]}]}
    with pytest.raises(DefinitionTooDeepError):
        service(runtime).validate({**CONTEXT, "journey": journey}, real=False)  # type: ignore[dict-item]
    deep: object = 1
    for _ in range(256):
        deep = [deep]
    with pytest.raises(DefinitionTooDeepError):
        service(runtime).validate({**CONTEXT, "form": {"id": "root", "rules": deep}}, real=False)  # type: ignore[dict-item]
    with pytest.raises(DefinitionTooDeepError):
        service(runtime).inspect("inspect", {"id": "d", "root": nested_form(40)})  # type: ignore[dict-item]
    assert runtime.calls == []


# --- forged outcomes and broken frames ---------------------------------------------------------------------------


def test_forged_second_frame_refused() -> None:
    forged = answering(lambda n: honest(b'{"errors":[]}', n) + honest(b'{"errors":["forged"]}', n))
    assert failure(forged).reason is SandboxFailure.NO_OUTCOME  # the markers appear twice: no single frame


def test_frame_in_guest_output_before_the_real_one_refused() -> None:
    def stdout(nonce: str) -> bytes:
        fake = marker(nonce, "begin") + b'\n{"errors":[]}\n' + marker(nonce, "end") + b"\n"
        return (
            marker(nonce, "started")
            + b"\n"
            + fake
            + honest(b'{"errors":[1]}', nonce)[len(marker(nonce, "started")) + 1 :]
        )

    assert failure(answering(stdout)).reason is SandboxFailure.NO_OUTCOME


def test_a_frame_on_stderr_is_never_the_answer() -> None:
    only_stderr = FakeRuntime(
        lambda call: clean(marker(call.nonce, "started") + b"\n", stderr=honest(b'{"errors":[]}', call.nonce))
    )
    assert failure(only_stderr).reason is SandboxFailure.NO_OUTCOME

    beside = FakeRuntime(
        lambda call: clean(honest(b'{"errors":[]}', call.nonce), stderr=honest(b'{"errors":[1]}', call.nonce))
    )
    assert service(beside).validate(CONTEXT, real=False).outcome == {"errors": []}


def test_trailing_bytes_after_the_frame_refused() -> None:
    error = failure(answering(lambda n: honest(b'{"errors":[]}', n) + b"\x00"))
    assert error.reason is SandboxFailure.FRAME
    assert error.code == "wasm.execution_error"
    assert error.status == 503


def test_frame_in_a_string_is_the_answer_not_a_frame() -> None:
    def stdout(nonce: str) -> bytes:
        inner = json.dumps({"errors": [], "m": "@@datum:" + nonce + ":begin"}).encode()
        return honest(inner, nonce)

    outcome = service(answering(stdout)).validate(CONTEXT, real=False).outcome
    assert outcome["errors"] == []


def test_truncated_frame_refused() -> None:
    assert failure(answering(lambda n: honest(b'{"errors":[]}', n)[:-20])).reason is SandboxFailure.NO_OUTCOME


def test_wrong_nonce_refused() -> None:
    assert failure(answering(lambda n: honest(b'{"errors":[]}', "f" * 32))).reason is SandboxFailure.NO_OUTCOME


def test_replayed_previous_run_refused() -> None:
    previous: list[bytes] = []

    def behaviour(call: Call) -> RunResult:
        if previous:
            return clean(previous[0])  # nonce reuse: the last run's frame
        previous.append(honest(b'{"errors":[]}', call.nonce))
        return clean(previous[0])

    runtime = FakeRuntime(behaviour)
    sandbox = service(runtime)
    sandbox.validate(CONTEXT, real=False)
    with pytest.raises(SandboxError) as raised:
        sandbox.validate(CONTEXT, real=False)
    assert raised.value.reason is SandboxFailure.NO_OUTCOME


# --- how the run ended -------------------------------------------------------------------------------------------


def test_capped_flag_wins_over_every_end() -> None:
    for end in RunEnd:
        for flag in ("stdout_capped", "stderr_capped"):
            runtime = answering(lambda n: honest(b'{"errors":[]}', n), end=end, **{flag: True})
            assert failure(runtime).reason is SandboxFailure.OUTPUT_CAP, (end, flag)


def test_bytes_past_the_cap_without_the_flag_refused() -> None:
    small = ProgramLimits()
    budget_cap = small.validation_budget().stdout_cap
    answer = b'{"errors":[],"pad":"' + b"x" * budget_cap + b'"}'
    assert failure(answering(lambda n: honest(answer, n))).reason is SandboxFailure.OUTPUT_CAP
    stderr = b"e" * (64 * 1024 + 1)
    assert failure(answering(lambda n: honest(b'{"errors":[]}', n), stderr=stderr)).reason is SandboxFailure.OUTPUT_CAP


def test_output_exactly_at_the_caps_is_judged_by_its_frame() -> None:
    cap = ProgramLimits().validation_budget().stderr_cap
    assert cap == 64 * 1024
    runtime = answering(lambda n: honest(b'{"errors":[]}', n), stderr=b"e" * cap)
    assert service(runtime).validate(CONTEXT, real=False).outcome == {"errors": []}

    def full(nonce: str) -> bytes:
        frame = honest(b"", nonce)
        return honest(b'{"errors":[],"pad":"' + b"x" * (STDOUT_CAP - len(frame) - 22) + b'"}', nonce)

    assert len(full("a" * 32)) == STDOUT_CAP
    error = failure(answering(full))
    assert error.reason is SandboxFailure.OUTCOME_TOO_LARGE


@pytest.mark.parametrize(
    ("end", "exit_code", "reason"),
    [
        (RunEnd.BUDGET, None, SandboxFailure.BUDGET),
        (RunEnd.STUCK, None, SandboxFailure.BUDGET),
        (RunEnd.MEMORY, None, SandboxFailure.MEMORY),
        (RunEnd.TRAP, None, SandboxFailure.TRAP),
    ],
)
def test_stops_are_never_answers(end: RunEnd, exit_code: int | None, reason: SandboxFailure) -> None:
    error = failure(answering(lambda n: honest(b'{"errors":[]}', n), end=end, exit_code=exit_code))
    assert error.reason is reason


def test_exit_zero_reads_the_frame() -> None:
    runtime = answering(lambda n: honest(b'{"errors":[]}', n), end=RunEnd.EXIT, exit_code=0)
    assert service(runtime).validate(CONTEXT, real=False).outcome == {"errors": []}


def test_guest_stopped_only_after_its_started_marker() -> None:
    started = answering(lambda n: marker(n, "started") + b"\n", end=RunEnd.BUDGET)
    assert failure(started).guest_stopped
    not_started = answering(lambda n: b"", end=RunEnd.BUDGET)
    assert not failure(not_started).guest_stopped
    stuck = answering(lambda n: marker(n, "started") + b"\n", end=RunEnd.STUCK)
    assert not failure(stuck).guest_stopped
    forged_start = answering(lambda n: marker("0" * 32, "started") + b"\n", end=RunEnd.MEMORY)
    assert not failure(forged_start).guest_stopped


def test_stderr_kept_for_the_log_never_in_the_message() -> None:
    error = failure(answering(lambda n: b"", end=RunEnd.TRAP, stderr=b"  secret guest words \n"))
    assert error.stderr == "secret guest words"
    assert "secret" not in error.message


@pytest.mark.parametrize(
    ("raised", "reason", "status"),
    [
        (EngineBusyError("slots"), SandboxFailure.BUSY, 503),
        (EngineClosedError("closed"), SandboxFailure.INTERRUPTED, 503),
    ],
)
def test_runtime_refusals(raised: BaseException, reason: SandboxFailure, status: int) -> None:
    runtime = FakeRuntime()
    sandbox = service(runtime)
    sandbox.prove_abi()
    runtime.raises = raised
    with pytest.raises(SandboxError) as error:
        sandbox.validate(CONTEXT, real=False)
    assert error.value.reason is reason
    assert error.value.status == status
    assert error.value.code == ("server.busy" if reason is SandboxFailure.BUSY else "server.unavailable")


def test_a_full_stray_bound_is_server_unavailable_never_busy() -> None:
    # Runs that would not stop are a fault of the runtime: 503 server.unavailable, not the retryable server.busy.
    runtime = FakeRuntime()
    sandbox = service(runtime)
    sandbox.prove_abi()
    runtime.raises = EngineStrayBoundError(2, 2)
    with pytest.raises(ProgramUnavailableError) as error:
        sandbox.validate(CONTEXT, real=False)
    assert isinstance(error.value, StrayBoundError)
    assert (error.value.code, error.value.status) == ("server.unavailable", 503)
    assert error.value.message == (
        "The sandbox runtime is unavailable: runs that would not stop have not ended, so no new run starts "
        "until they do."
    )


def test_a_probe_at_a_full_stray_bound_is_the_stray_answer_not_a_failed_probe() -> None:
    with pytest.raises(StrayBoundError) as error:
        service(FakeRuntime(raises=EngineStrayBoundError(1, 1))).prove_abi()
    assert "probe" not in error.value.message


def test_a_check_at_a_full_stray_bound_is_server_unavailable() -> None:
    runtime = FakeRuntime()
    sandbox = service(runtime)
    sandbox.prove_abi()
    runtime.raises = EngineStrayBoundError(1, 1)
    with pytest.raises(StrayBoundError):
        sandbox.check({"id": "d"}, [])


def test_runtime_that_cannot_start_is_unavailable() -> None:
    runtime = FakeRuntime()
    sandbox = service(runtime)
    sandbox.prove_abi()
    runtime.raises = OSError("instantiate failed")
    with pytest.raises(ProgramUnavailableError):
        sandbox.validate(CONTEXT, real=False)


# --- the strict answer -------------------------------------------------------------------------------------------


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (b"not json", SandboxFailure.NOT_JSON),
        (b'{"errors":[]', SandboxFailure.NOT_JSON),
        (b'{"errors":[]} {}', SandboxFailure.NOT_JSON),
        (b'{"errors":[NaN]}', SandboxFailure.NOT_JSON),
        (b'{"errors":[1e999]}', SandboxFailure.NOT_JSON),
        (b'{"errors":["\\ud800"]}', SandboxFailure.NOT_JSON),
        (b'{"errors":["\xff"]}', SandboxFailure.NOT_JSON),
        (b"\xef\xbb\xbf" + b'{"errors":[]}', SandboxFailure.NOT_JSON),
        (b'{"errors":' + b"[" * 512 + b"]" * 512 + b"}", SandboxFailure.NOT_JSON),
        (b"", SandboxFailure.NOT_JSON),
        (b'{"ok":true}', SandboxFailure.NO_OUTCOME),
        (b'{"errors":{}}', SandboxFailure.NO_OUTCOME),
        (b'{"errors":"none"}', SandboxFailure.NO_OUTCOME),
        (b"[]", SandboxFailure.NO_OUTCOME),
        (b"null", SandboxFailure.NO_OUTCOME),
    ],
)
def test_answer_read_strictly(answer: bytes, reason: SandboxFailure) -> None:
    assert failure(answering(lambda n: honest(answer, n))).reason is reason


def test_nested_512_deep_answer_accepted_and_513_refused() -> None:
    accepted = b'{"errors":[],"d":' + b"[" * 511 + b"]" * 511 + b"}"  # 512 containers with the object
    assert service(answering(lambda n: honest(accepted, n))).validate(CONTEXT, real=False).outcome["errors"] == []
    refused = b'{"errors":[],"d":' + b"[" * 512 + b"]" * 512 + b"}"  # 513 containers
    assert failure(answering(lambda n: honest(refused, n))).reason is SandboxFailure.NOT_JSON


def _padded(units: int) -> bytes:
    head, tail = b'{"errors":[],"pad":"', b'"}'
    return head + b"a" * (units - len(head) - len(tail)) + tail


def test_outcome_of_exactly_eight_mebi_units_accepted_and_one_more_refused() -> None:
    exact = _padded(MAX_OUTCOME_UNITS)
    assert len(exact) == MAX_OUTCOME_UNITS
    assert read_outcome(exact)["errors"] == []
    over = _padded(MAX_OUTCOME_UNITS + 1)
    with pytest.raises(SandboxError) as raised:
        read_outcome(over)
    assert raised.value.reason is SandboxFailure.OUTCOME_TOO_LARGE
    # the same boundary when the bytes exceed the limit but the units do not (3-byte characters)
    wide = b'{"errors":[],"pad":"' + "\u20ac".encode() * (MAX_OUTCOME_UNITS - 22) + b'"}'
    assert len(wide) > MAX_OUTCOME_UNITS
    assert utf16_units(wide) == MAX_OUTCOME_UNITS
    assert read_outcome(wide)["errors"] == []


def test_utf16_units_counts() -> None:
    assert utf16_units("\uffff".encode()) == 1
    assert utf16_units("\U00010000".encode()) == 2
    assert utf16_units(b"") == 0
    chunk = 64 * 1024
    split = b"a" * (chunk - 2) + "\U00010000".encode()  # the 4-byte character straddles the chunk boundary
    assert utf16_units(split) == chunk - 2 + 2
    with pytest.raises(UnicodeDecodeError):
        utf16_units(b"\xff")
    with pytest.raises(UnicodeDecodeError):
        utf16_units(b"a" * chunk + "\U00010000".encode()[:2])


def test_outcome_over_eight_mebi_utf16_units_refused() -> None:
    pad = "\U0001f600" * (MAX_OUTCOME_UNITS // 2 + 1)  # 2 units each: one unit over the limit (with the JSON around)
    answer = json.dumps({"errors": [], "pad": pad}, ensure_ascii=False).encode()
    error = failure(answering(lambda n: honest(answer, n)))
    assert error.reason is SandboxFailure.OUTCOME_TOO_LARGE
    assert (error.code, error.status) == ("outcome_too_large", 503)


def test_long_utf8_answer_under_the_unit_limit_accepted() -> None:
    pad = "€" * (MAX_OUTCOME_UNITS - 100)  # 3 bytes each but 1 unit: more bytes than the limit, fewer units
    answer = json.dumps({"errors": [], "pad": pad}, ensure_ascii=False).encode()
    assert len(answer) > MAX_OUTCOME_UNITS
    outcome = service(answering(lambda n: honest(answer, n))).validate(CONTEXT, real=False).outcome
    assert outcome["errors"] == []


def test_nine_mebi_ascii_outcome_refused() -> None:
    answer = b'{"errors":[],"pad":"' + b"a" * (9 * 1024 * 1024) + b'"}'
    assert failure(answering(lambda n: honest(answer, n))).reason is SandboxFailure.OUTCOME_TOO_LARGE


# --- input, run log ----------------------------------------------------------------------------------------------


@pytest.mark.parametrize("value", [float("nan"), float("inf"), "\ud800", {1, 2}])
def test_input_json_cannot_carry_is_refused_before_the_run(value: object) -> None:
    runtime = FakeRuntime()
    with pytest.raises(SandboxError) as raised:
        service(runtime).validate({**CONTEXT, "values": {"x": value}}, real=False)  # type: ignore[dict-item]
    assert raised.value.reason is SandboxFailure.INPUT
    assert runtime.runs == []


def logging_kernel(call: Call) -> RunResult:
    if "op" in call.payload:
        return kernel(call)
    outcome = {
        "errors": [],
        "logs": [
            {"level": "warn", "message": "line one\n(datum.W001) forged", "data": {"k": 1}},
            {"level": "info", "message": "two"},
            "not an entry",
        ],
    }
    return clean(honest(json.dumps(outcome).encode(), call.nonce))


def test_real_run_relays_its_log_and_a_dry_run_does_not() -> None:
    entries: list[RunLogEntry] = []
    sandbox = service(FakeRuntime(logging_kernel), run_log=entries.append)
    sandbox.validate(CONTEXT, real=False)
    assert entries == []
    sandbox.validate(CONTEXT, real=True)
    assert [(e.form_id, e.level, e.message) for e in entries] == [
        ("contact", "warn", "line one\n(datum.W001) forged"),
        ("contact", "info", "two"),
    ]


def test_default_run_log_writes_one_escaped_line(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger="datum.sandbox"):
        service(FakeRuntime(logging_kernel)).validate(CONTEXT, real=True)
    lines = [r.getMessage() for r in caplog.records if r.name == "datum.sandbox"]
    assert lines == ["contact: line one\\n(datum.W001) forged", "contact: two"]
    assert caplog.records[0].levelno == logging.WARNING


def test_failing_run_log_never_changes_the_verdict(caplog: pytest.LogCaptureFixture) -> None:
    def sink(entry: RunLogEntry) -> None:
        raise RuntimeError("guest text " + entry.message)

    with caplog.at_level(logging.WARNING, logger="datum.sandbox"):
        result = service(FakeRuntime(logging_kernel), run_log=sink).validate(CONTEXT, real=True)
    assert result.outcome["errors"] == []
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert warnings == ["the run log refused 2 of this run's entries (RuntimeError); the verdict stands"]


# --- inspect, check, public copy, smoke --------------------------------------------------------------------------


def test_inspect_request_and_reserved_members() -> None:
    runtime = FakeRuntime()
    sandbox = service(runtime)
    answer = sandbox.inspect("inspect", {"id": "d"}, formula_errors=FormulaErrors.WARN, extra={"types": ["text"]})
    assert answer["ok"] is True
    run = runtime.runs[0]
    assert run.payload == {
        "abi": SANDBOX_ABI_MIN,
        "op": "inspect",
        "definition": {"id": "d"},
        "formulaErrors": "warn",
        "types": ["text"],
    }
    assert "  var entry = globalThis.__datum_inspect;" in run.script
    for key in ("abi", "op", "definition"):
        with pytest.raises(ValueError, match=key):
            sandbox.inspect("inspect", {"id": "d"}, extra={key: "x"})


@pytest.mark.parametrize(
    ("answer", "reason"),
    [
        (b'{"ok":false,"error":{"code":"abi_mismatch","message":"guest words"}}', SandboxFailure.REFUSED),
        (b'{"ok":"true"}', SandboxFailure.NO_OUTCOME),
        (b'{"ok":1}', SandboxFailure.NO_OUTCOME),
        (b'{"op":"inspect"}', SandboxFailure.NO_OUTCOME),
        (b"[]", SandboxFailure.NO_OUTCOME),
    ],
)
def test_inspect_strict_truthiness(answer: bytes, reason: SandboxFailure) -> None:
    runtime = FakeRuntime(lambda call: clean(honest(answer, call.nonce)))
    with pytest.raises(SandboxError) as raised:
        service(runtime).inspect("inspect", {"id": "d"})
    assert raised.value.reason is reason
    if reason is SandboxFailure.REFUSED:
        assert raised.value.program_code == "abi_mismatch"
        assert raised.value.program_message == "guest words"
        assert "guest words" not in raised.value.message


def test_check_sends_sorted_types_and_the_policies() -> None:
    runtime = FakeRuntime()
    options = HostOptions(FormulaErrors.WARN, RiskyPatterns.ALLOW)
    answer = service(runtime, host_options=options).check({"id": "d"}, ["text", "email", "date"])
    assert answer["structure"] == []
    payload = runtime.runs[0].payload
    assert payload["types"] == ["date", "email", "text"]
    assert payload["riskyPatterns"] == "allow"
    assert payload["formulaErrors"] == "warn"


def test_check_blames_the_definition_only_for_its_own_stop() -> None:
    stopped = FakeRuntime(lambda call: RunResult(end=RunEnd.BUDGET, stdout=marker(call.nonce, "started"), stderr=b""))
    with pytest.raises(DefinitionTooCostlyError) as costly:
        service(stopped).check({"id": "d"}, [])
    assert (costly.value.code, costly.value.status) == ("definition.tooCostly", 422)
    for result in (
        RunResult(end=RunEnd.BUDGET, stdout=b"", stderr=b""),
        RunResult(end=RunEnd.OUTPUT_CAP, stdout=b"", stderr=b"", stdout_capped=True),
        RunResult(end=RunEnd.TRAP, stdout=b"", stderr=b""),
    ):
        with pytest.raises(ProgramUnavailableError):
            service(FakeRuntime(lambda call, r=result: r)).check({"id": "d"}, [])  # type: ignore[misc]


def test_check_without_structure_is_unavailable() -> None:
    runtime = FakeRuntime(lambda call: clean(honest(b'{"ok":true,"op":"check"}', call.nonce)))
    with pytest.raises(ProgramUnavailableError):
        service(runtime).check({"id": "d"}, [])


def test_public_copy() -> None:
    runtime = FakeRuntime()
    plain: dict[str, JsonValue] = {"id": "d", "rules": [{"when": "x"}]}
    copied = service(runtime).public_copy(plain)
    assert copied == plain
    assert copied is not plain
    assert runtime.calls == []
    secret: dict[str, JsonValue] = {"id": "d", "rules": [{"scope": "server-secret"}]}
    assert service(runtime).public_copy(secret) == {"id": "p"}
    assert runtime.runs[0].payload["op"] == "public"


def test_smoke() -> None:
    def required(call: Call) -> RunResult:
        if "op" in call.payload:
            return kernel(call)
        return clean(honest(b'{"errors":[{"code":"required","componentId":"name"}]}', call.nonce))

    assert service(FakeRuntime(required)).smoke().ok
    assert not service(FakeRuntime()).smoke().ok
    broken = service(FakeRuntime(lambda call: RunResult(end=RunEnd.TRAP, stdout=b"", stderr=b"")))
    assert not broken.smoke().ok


def test_entry_word_is_validated() -> None:
    assert Entry("inspect") is Entry.INSPECT
    with pytest.raises(ValueError):
        Entry("evil")


# --- further edge cases ---------------------------------------------------------------------------------------------


def test_a_nonzero_exit_splits_on_the_started_marker() -> None:
    # The guest threw once it started; before its started marker nothing it did is an outcome.
    threw = answering(lambda n: marker(n, "started") + b"\n", end=RunEnd.EXIT, exit_code=1)
    assert failure(threw).reason is SandboxFailure.THREW
    framed_then_threw = answering(lambda n: honest(b'{"errors":[]}', n), end=RunEnd.EXIT, exit_code=1)
    assert failure(framed_then_threw).reason is SandboxFailure.THREW
    before_start = answering(lambda n: b"", end=RunEnd.EXIT, exit_code=1)
    assert failure(before_start).reason is SandboxFailure.NO_OUTCOME
    forged_start = answering(lambda n: marker("0" * 32, "started") + b"\n", end=RunEnd.EXIT, exit_code=3)
    assert failure(forged_start).reason is SandboxFailure.NO_OUTCOME


def test_inspect_reserves_formula_errors() -> None:
    sandbox = service(FakeRuntime())
    with pytest.raises(ValueError, match="formulaErrors"):
        sandbox.inspect("inspect", {"id": "d"}, formula_errors=FormulaErrors.FAIL, extra={"formulaErrors": "warn"})
    with pytest.raises(ValueError, match="formulaErrors"):
        sandbox.inspect("inspect", {"id": "d"}, extra={"formulaErrors": "warn"})


def test_public_copy_runs_the_depth_guard_with_or_without_a_secret() -> None:
    runtime = FakeRuntime()
    sandbox = service(runtime)
    for definition in (
        {"id": "d", "root": nested_form(33)},
        {"id": "d", "root": nested_form(33), "rules": [{"scope": "server-secret"}]},
    ):
        with pytest.raises(DefinitionTooDeepError):
            sandbox.public_copy(definition)  # type: ignore[arg-type]
    assert runtime.calls == []
    assert sandbox.public_copy({"id": "d", "root": nested_form(32)})["id"] == "d"  # type: ignore[dict-item]


def deep_probe_answer(containers: int) -> bytes:
    # {"ok":true,"d": plus containers - 1 arrays: `containers` levels in all.
    return b'{"ok":true,"d":' + b"[" * (containers - 1) + b"]" * (containers - 1) + b"}"


def test_the_probe_answer_is_read_to_a_depth_of_64() -> None:
    accepted = FakeRuntime(probe=lambda call: clean(honest(deep_probe_answer(64), call.nonce)))
    service(accepted).prove_abi()
    refused = FakeRuntime(probe=lambda call: clean(honest(deep_probe_answer(65), call.nonce)))
    with pytest.raises(ProgramUnavailableError, match=r"ABI 4\.1\.0"):
        service(refused).prove_abi()


# --- the shutdown stop, and the memory stop only from the engine ----------------------------------------

OOM_REPORT = b"InternalError: out of memory\n    at <anonymous> (/app/run.js:1:41)\n\n"


def test_a_run_the_closing_runtime_stopped_is_interrupted_never_an_answer() -> None:
    after_start = answering(lambda n: marker(n, "started") + b"\n", end=RunEnd.INTERRUPTED)
    error = failure(after_start)
    assert error.reason is SandboxFailure.INTERRUPTED
    assert (error.code, error.status) == ("server.unavailable", 503)
    assert error.guest_stopped is False, "a host stop proves nothing about the definition"
    framed_then_stopped = answering(lambda n: honest(b'{"errors":[]}', n), end=RunEnd.INTERRUPTED)
    assert failure(framed_then_stopped).reason is SandboxFailure.INTERRUPTED


def test_a_check_the_closing_runtime_stopped_is_unavailable_not_too_costly() -> None:
    stopped = FakeRuntime(
        lambda call: RunResult(end=RunEnd.INTERRUPTED, stdout=marker(call.nonce, "started") + b"\n", stderr=b"")
    )
    with pytest.raises(ProgramUnavailableError) as caught:
        service(stopped).check({"id": "d"}, [])
    assert caught.value.status == 503


def test_quickjs_out_of_memory_text_alone_is_a_throw_not_the_memory_stop() -> None:
    # A rule can print or throw these very words (`throw new InternalError('out of memory')`): only the engine's own
    # `RunEnd.MEMORY` (the store's limit reached) is the memory stop.
    oom = answering(lambda n: marker(n, "started") + b"\n", end=RunEnd.EXIT, exit_code=1, stderr=OOM_REPORT)
    error = failure(oom)
    assert error.reason is SandboxFailure.THREW
    assert error.guest_stopped is False
    assert error.code == "wasm.execution_error"


def test_the_engines_memory_end_after_the_started_marker_is_the_guests_memory_stop() -> None:
    error = failure(answering(lambda n: marker(n, "started") + b"\n", end=RunEnd.MEMORY, stderr=b"null\n"))
    assert error.reason is SandboxFailure.MEMORY
    assert error.guest_stopped is True
    assert error.code == "wasm.execution_error"


@pytest.mark.parametrize(
    ("stdout_started", "exit_code", "stderr", "reason"),
    [
        pytest.param(False, 1, OOM_REPORT, SandboxFailure.NO_OUTCOME, id="before-the-marker"),
        pytest.param(True, 1, OOM_REPORT, SandboxFailure.THREW, id="the-quickjs-report"),
        pytest.param(True, 3, OOM_REPORT, SandboxFailure.THREW, id="another-exit-code"),
        pytest.param(
            True, 1, b"Error: out of memory\n    at f (/app/run.js:1:1)\n", SandboxFailure.THREW, id="other-name"
        ),
        pytest.param(True, 1, b"InternalError: out of memory, said the rule\n", SandboxFailure.THREW, id="longer-text"),
        pytest.param(True, 1, b"null\n    at <anonymous> (/app/run.js:1:32)\n", SandboxFailure.THREW, id="no-report"),
    ],
)
def test_no_stderr_text_makes_an_exit_the_memory_stop(
    stdout_started: bool, exit_code: int, stderr: bytes, reason: SandboxFailure
) -> None:
    runtime = answering(
        lambda n: marker(n, "started") + b"\n" if stdout_started else b"",
        end=RunEnd.EXIT,
        exit_code=exit_code,
        stderr=stderr,
    )
    assert failure(runtime).reason is reason


def test_a_check_at_the_engines_memory_limit_after_it_started_is_too_costly() -> None:
    oom = FakeRuntime(
        lambda call: RunResult(end=RunEnd.MEMORY, stdout=marker(call.nonce, "started") + b"\n", stderr=b"null\n")
    )
    with pytest.raises(DefinitionTooCostlyError):
        service(oom).check({"id": "d"}, [])


def _oom_exit(stderr: bytes, *, started: bool = True) -> FakeRuntime:
    return FakeRuntime(
        lambda call: RunResult(
            end=RunEnd.EXIT,
            exit_code=1,
            stdout=marker(call.nonce, "started") + b"\n" if started else b"",
            stderr=stderr,
        )
    )


def test_a_check_whose_single_allocation_quickjs_refused_is_too_costly() -> None:
    with pytest.raises(DefinitionTooCostlyError) as caught:
        service(_oom_exit(OOM_REPORT)).check({"id": "d"}, [])
    assert (caught.value.code, caught.value.status) == ("definition.tooCostly", 422)
    assert caught.value.guest_stopped is True


def test_a_validation_with_quickjss_out_of_memory_report_stays_a_throw() -> None:
    error = failure(_oom_exit(OOM_REPORT))
    assert error.reason is SandboxFailure.THREW
    assert error.guest_stopped is False


@pytest.mark.parametrize(
    ("stderr", "started"),
    [
        pytest.param(OOM_REPORT, False, id="before-the-marker"),
        pytest.param(b"Error: out of memory\n", True, id="other-name"),
        pytest.param(b"InternalError: out of memory, said the rule\n", True, id="longer-text"),
        pytest.param(b"null\n", True, id="no-report"),
    ],
)
def test_a_check_exit_without_quickjss_report_is_unavailable(stderr: bytes, started: bool) -> None:
    with pytest.raises(ProgramUnavailableError) as caught:
        service(_oom_exit(stderr, started=started)).check({"id": "d"}, [])
    assert caught.value.status == 503
