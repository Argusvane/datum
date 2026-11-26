"""`DatumSandbox` with no framework: start, status, recheck, stop, the context manager, translation and the PDF rule."""

import logging
import threading

import pytest
from sandbox_fakes import FakeRuntime, context

from datum_sandbox import DatumSandbox, SandboxSettings, SandboxState
from datum_sandbox.checks import E003, DatumConfigurationError
from datum_sandbox.diagnostics import Source
from datum_sandbox.protocol import ProgramUnavailableError
from datum_sandbox.runtime import SandboxReady, can_run_pdf, translated
from datum_sandbox.wasi import (
    EngineConfigurationError,
    EngineInfo,
    EngineSelectionError,
    EngineSettings,
    GuestRuntimes,
    MemoryFloorError,
)


def started(**options: object) -> tuple[DatumSandbox, FakeRuntime]:
    runtime = FakeRuntime()
    sandbox = DatumSandbox(SandboxSettings.build(warm_up_runs=1, report=False), runtime=runtime, **options)  # type: ignore[arg-type]
    sandbox.start()
    return sandbox, runtime


def test_a_plain_python_host_starts_validates_and_stops_with_no_framework() -> None:
    ready: list[SandboxReady] = []
    with DatumSandbox(SandboxSettings.build(report=False), runtime=FakeRuntime(), on_ready=ready.append) as sandbox:
        assert sandbox.status().is_up
        good = sandbox.sandbox.validate(context("Ada"), real=False)
        bad = sandbox.sandbox.validate(context(""), real=False)
        assert good.outcome["errors"] == []
        assert bad.outcome["errors"] == [{"code": "required", "componentId": "name"}]
    assert sandbox.state is SandboxState.STOPPED
    assert [item.engine.id for item in ready] == ["fake"]
    with pytest.raises(ProgramUnavailableError):
        _ = sandbox.sandbox


def test_status_details_carry_the_engine_the_abis_and_the_pdf_rule() -> None:
    sandbox, _ = started()
    try:
        status = sandbox.status()
        assert status.is_up
        assert status.details["engine"] == "fake"
        assert status.details["pdfCapable"] is False, "a runtime without the PDF pool never runs the PDF program"
        assert status.details["pdfUnavailable"] == "the fake engine cannot run the PDF program"
        assert "captureDropped" not in status.details, "the capture counters appear only while it is on"
    finally:
        sandbox.stop()


def test_the_pdf_decision_fails_closed() -> None:
    class Throws(FakeRuntime):
        def engine_info(self) -> EngineInfo:
            raise RuntimeError("no report")

    assert not can_run_pdf(None)
    assert not can_run_pdf(FakeRuntime())  # names its pools without the PDF pool
    assert can_run_pdf(FakeRuntime(pools=frozenset({"validation", "pdf"})))
    assert not can_run_pdf(Throws(pools=frozenset({"validation", "pdf"})))


def test_a_smoke_that_fails_stops_the_start_with_fail_fast_and_leaves_nothing() -> None:
    runtime = FakeRuntime(fail_with=RuntimeError("no engine"))
    sandbox = DatumSandbox(SandboxSettings.build(report=False), runtime=runtime)
    with pytest.raises(ProgramUnavailableError):
        sandbox.start()
    assert sandbox.state is SandboxState.FAILED
    assert runtime.closed == 1, "a failed start closes what it took"


def test_without_fail_fast_the_start_stands_down_and_a_recheck_brings_it_up(caplog: pytest.LogCaptureFixture) -> None:
    runtime = FakeRuntime(fail_with=RuntimeError("not yet"))
    sandbox = DatumSandbox(SandboxSettings.build(fail_fast=False, report=False), runtime=runtime)
    with caplog.at_level(logging.ERROR, logger="datum.runtime"):
        sandbox.start()
    assert sandbox.state is SandboxState.DOWN
    assert not sandbox.status().is_up
    assert "until a recheck" in caplog.text
    assert sandbox.recheck().is_up
    sandbox.stop()


def test_engine_layer_refusals_are_translated_once_with_the_same_words() -> None:
    selection = translated(EngineSelectionError("no engine 'x'", hint="install it"))
    assert isinstance(selection, DatumConfigurationError)
    assert (selection.message, selection.hint) == ("no engine 'x'", "install it")
    floor = translated(MemoryFloorError("datum.runtime.validation.memory", 1, 2))
    assert [check.id for check in floor.problems] == [E003]
    assert "datum.runtime.validation.memory is 1 bytes" in floor.message


def test_an_unknown_engine_refuses_the_start_whatever_fail_fast_says() -> None:
    sandbox = DatumSandbox(
        SandboxSettings.build(engine="nope", fail_fast=False, report=False),
        discover=lambda: GuestRuntimes([]),
    )
    with pytest.raises(DatumConfigurationError, match="nope") as raised:
        sandbox.start()
    assert isinstance(raised.value.__cause__, EngineConfigurationError)
    assert sandbox.state is SandboxState.FAILED


def test_explain_shows_replaced_inputs_and_the_resolved_slots() -> None:
    sandbox, _ = started(engine_settings=EngineSettings(stop_grace=1.5, stray_bound=3))
    try:
        report = sandbox.explain()
        assert report.get("datum.runtime.engine").source is Source.REPLACED
        assert report.get("datum.runtime.stop_grace").value == 1.5
        assert report.get("datum.runtime.max_strays").value == 3
        assert "one per CPU" in str(report.get("datum.runtime.validation.concurrency").resolved)
        assert report.engine is not None
        assert report.engine.id == "fake"
        assert [program.kind for program in report.programs] == ["sandbox"]
        assert len(report.programs[0].sha256) == 64
        assert "trace: off" in str(report)
    finally:
        sandbox.stop()


def test_the_settings_report_is_logged_once_at_start_before_the_proof(caplog: pytest.LogCaptureFixture) -> None:
    runtime = FakeRuntime()
    sandbox = DatumSandbox(SandboxSettings.build(validation_time_limit=99), runtime=runtime)
    with caplog.at_level(logging.INFO, logger="datum.sandbox.settings"):
        sandbox.start()
    sandbox.stop()
    blocks = [record.getMessage() for record in caplog.records if record.name == "datum.sandbox.settings"]
    assert len(blocks) == 1
    assert "datum.runtime.validation.time_limit = 60.0 (clamped from 99" in blocks[0]
    assert "program sandbox: sha256" in blocks[0]
    assert "engine: fake 1.0 mode test" in blocks[0]


def test_a_stop_closes_the_runtime_once_and_leaves_no_thread() -> None:
    before = {thread.ident for thread in threading.enumerate()}
    sandbox, runtime = started()
    sandbox.stop()
    sandbox.stop()
    assert runtime.closed == 1
    assert {thread.ident for thread in threading.enumerate()} <= before
