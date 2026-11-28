"""The run trace: a line per mode, the field order, no answer or nonce, after the slot, nothing when off."""

import contextlib
import logging
import threading
import time
from pathlib import Path

import pytest
from sandbox_fakes import SECRET, FakeRuntime, context

from datum_sandbox import DatumSandbox, SandboxSettings
from datum_sandbox.diagnostics import FIELDS, TraceRecord, word
from datum_sandbox.protocol import (
    DefinitionTooDeepError,
    RunRecord,
    SandboxError,
    SandboxFailure,
    SandboxService,
    StrayBoundError,
    freeze_snippet,
    is_failed,
    sandbox_program,
)
from datum_sandbox.wasi import (
    EngineBusyError,
    EngineStrayBoundError,
    GuestEnd,
    GuestEndKind,
    GuestEngine,
    GuestInstance,
    GuestIo,
    RunBudget,
    RunHarness,
)


def traced(mode: str, runtime: FakeRuntime | None = None) -> tuple[DatumSandbox, list[TraceRecord], FakeRuntime]:
    records: list[TraceRecord] = []
    fake = runtime or FakeRuntime()
    sandbox = DatumSandbox(
        SandboxSettings.build(trace=mode, warm_up_runs=1, report=False), runtime=fake, trace=records.append
    )
    sandbox.start()
    records.clear()  # the start's own probe and smoke runs
    return sandbox, records, fake


def test_all_traces_a_verdict_with_the_fields_in_their_fixed_order() -> None:
    sandbox, records, _ = traced("all")
    try:
        sandbox.sandbox.validate(context("Ada"), real=False)
    finally:
        sandbox.stop()
    (record,) = records
    assert tuple(record.fields()) == FIELDS
    line = record.line()
    assert line.split(" ")[0].startswith("run=")
    assert [part.split("=", 1)[0] for part in line.split(" ")] == list(FIELDS)
    fields = record.fields()
    assert (fields["program"], fields["op"], fields["outcome"], fields["termination"]) == (
        "sandbox", "validate", "verdict", "clean",
    )  # fmt: skip
    assert fields["engine"] == "fake"
    assert fields["capture"] == "-"
    assert float(fields["slotWaitMs"]) >= 0
    assert float(fields["startMs"]) > 0, "the harness's timings are carried"


def test_failures_skips_a_verdict_and_traces_a_trap() -> None:
    sandbox, records, _ = traced("failures")
    try:
        sandbox.sandbox.validate(context("Ada"), real=False)
        assert records == [], "a normal verdict is not a failed run"
        with pytest.raises(SandboxError):
            sandbox.sandbox.validate(context("TRAP-ME"), real=False)
    finally:
        sandbox.stop()
    (record,) = records
    assert record.outcome == "trap"
    assert record.termination == "trap"


def test_off_holds_no_recorder_and_measures_nothing() -> None:
    sandbox, records, fake = traced("off")
    try:
        service = sandbox.sandbox
        assert isinstance(service, SandboxService)
        assert service.recorder is None
        service.validate(context("Ada"), real=False)
    finally:
        sandbox.stop()
    assert records == []
    assert all(not run.timed for run in fake.runs), "with the trace and the capture off no run is timed"


def test_a_line_never_holds_the_answers_the_definition_or_the_nonce() -> None:
    sandbox, records, fake = traced("all")
    try:
        sandbox.sandbox.validate(context(SECRET), real=False)
    finally:
        sandbox.stop()
    line = records[-1].line()
    nonce = fake.runs[-1].stdin[:32].decode("ascii")
    assert SECRET not in line
    assert nonce not in line
    assert "name" not in line
    assert "root" not in line


def test_word_keeps_a_field_on_one_line() -> None:
    assert word("a b\nc=d\te") == "abcde"
    assert word("") == "-"
    assert word("x" * 100) == "x" * 64
    hostile = TraceRecord("r", "sandbox", "validate\nrun=forged", "1.0.0", "fake engine", "m=x", 0, 0, 0, 0, 0,
                          "clean", None, "verdict", 1, 2, 3)  # fmt: skip
    assert hostile.line().count("run=") == 1
    assert "\n" not in hostile.line()


def test_a_busy_refusal_and_a_refusal_before_the_run_make_no_line() -> None:
    sandbox, records, fake = traced("all", FakeRuntime())
    try:
        service = sandbox.sandbox
        form: dict[str, object] = {"id": "root", "type": "form"}
        node = form
        for _ in range(600):
            child: dict[str, object] = {}
            node["x"] = child
            node = child
        with pytest.raises(DefinitionTooDeepError):
            service.validate({"form": form, "values": {}}, real=False)  # type: ignore[dict-item]
        runs = len(fake.runs)
        fake.fail_with = EngineBusyError("slots")
        with pytest.raises(SandboxError) as busy:
            service.validate(context("Ada"), real=False)
        assert busy.value.reason is SandboxFailure.BUSY
        assert len(fake.runs) == runs + 1, "the busy run was asked of the runtime and refused there"
    finally:
        sandbox.stop()
    assert records == [], "neither a definition refused before any guest started nor a busy refusal made a run"


def test_a_full_stray_bound_is_a_failed_run_with_the_word_unavailable_never_busy() -> None:
    sandbox, records, fake = traced("failures", FakeRuntime())
    try:
        runs = len(fake.runs)
        fake.fail_with = EngineStrayBoundError(1, 1)
        with pytest.raises(StrayBoundError) as full:
            sandbox.sandbox.validate(context("Ada"), real=False)
        assert full.value.code == "server.unavailable"
        assert len(fake.runs) == runs + 1, "the run was asked of the runtime and refused there"
    finally:
        sandbox.stop()
    (record,) = records  # the failures trace: a run the runtime refused at the stray bound is a failed run
    assert (record.op, record.outcome) == ("validate", "unavailable")
    assert is_failed(record.outcome)


def test_a_trace_that_raises_never_changes_the_answer(caplog: pytest.LogCaptureFixture) -> None:
    def broken(record: TraceRecord) -> None:
        raise AssertionError("broken trace")

    sandbox = DatumSandbox(SandboxSettings.build(trace="all", report=False), runtime=FakeRuntime(), trace=broken)
    with caplog.at_level(logging.WARNING, logger="datum.runtime"):
        sandbox.start()
        result = sandbox.sandbox.validate(context("Ada"), real=False)
    sandbox.stop()
    assert result.outcome["errors"] == []
    assert "the run trace failed (AssertionError)" in caplog.text
    assert "broken trace" not in caplog.text


def test_the_default_trace_writes_one_info_line_on_its_logger(caplog: pytest.LogCaptureFixture) -> None:
    sandbox = DatumSandbox(SandboxSettings.build(trace="all", report=False, warm_up_runs=1), runtime=FakeRuntime())
    sandbox.start()
    with caplog.at_level(logging.INFO, logger="datum.sandbox.trace"):
        sandbox.sandbox.validate(context("Ada"), real=False)
    sandbox.stop()
    lines = [r.getMessage() for r in caplog.records if r.name == "datum.sandbox.trace"]
    assert len(lines) == 1
    assert lines[0].startswith("run=")


def test_is_failed_is_every_word_but_verdict_and_refused() -> None:
    assert not is_failed("verdict")
    assert not is_failed("refused")
    for failure in SandboxFailure:
        if failure is not SandboxFailure.REFUSED:
            assert is_failed(failure.value)
    assert is_failed("unavailable")
    assert is_failed("error")


class _Instance:
    def __init__(self) -> None:
        self.stop = threading.Event()

    def start(self) -> None:
        self.stop.wait(0.05)

    def request_stop(self) -> None:
        self.stop.set()

    def classify(self, error: BaseException, /) -> GuestEnd:
        return GuestEnd(GuestEndKind.TRAP)

    def close(self) -> None:
        pass


class _Engine:
    def instantiate(self, io: GuestIo, budget: RunBudget, /) -> GuestInstance:
        return _Instance()


class _HarnessRuntime:
    """One slot over the real harness: the run step's answer comes back only once the slot is released."""

    pools = frozenset({"validation"})

    def __init__(self, work_dir: Path) -> None:
        engine: GuestEngine = _Engine()
        self.harness = RunHarness(engine, slots=1, work_dir=work_dir)

    def run(self, job: object, /) -> object:
        return self.harness.run(job)  # type: ignore[arg-type]

    def engine_info(self) -> object:
        from datum_sandbox.wasi import EngineInfo  # noqa: PLC0415

        return EngineInfo("harness", "1", "test")

    def close(self) -> None:
        self.harness.close(1.0)


def test_a_trace_that_blocks_does_not_hold_the_slot(tmp_path: Path) -> None:
    runtime = _HarnessRuntime(tmp_path)
    blocked = threading.Event()
    release = threading.Event()

    calls: list[RunRecord] = []

    def slow(record: RunRecord) -> None:
        calls.append(record)
        if len(calls) == 1:  # the first run's recorder blocks; the second's returns at once
            blocked.set()
            release.wait(10)

    program = sandbox_program()
    service = SandboxService(runtime, program, freeze_snippet=freeze_snippet(), recorder=slow)  # type: ignore[arg-type]
    first = threading.Thread(target=lambda: _quietly(service))
    first.start()
    assert blocked.wait(10), "the first run reached its recorder"
    try:
        began = time.monotonic()
        _quietly(service)  # a second run takes the one slot while the first's recorder is still blocked
        assert time.monotonic() - began < 5, "the second run got the one slot while the first's recorder blocked"
        assert len(calls) == 2
        assert runtime.harness.stats().slots_in_use == 0
    finally:
        release.set()
        first.join(10)
        runtime.close()


def _quietly(service: SandboxService) -> None:
    with contextlib.suppress(Exception):  # the engine answers nothing; only the slot matters here
        service.prove_abi()
