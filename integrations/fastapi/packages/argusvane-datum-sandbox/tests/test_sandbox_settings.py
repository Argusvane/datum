"""`SandboxSettings`: every clamp in one place, the refusals, and `explain()` naming each value's source."""

from typing import cast

import pytest

from datum_sandbox.checks import W008, DatumConfigurationError
from datum_sandbox.diagnostics import Source, scrub
from datum_sandbox.protocol import FormulaErrors, ProgramLimits
from datum_sandbox.runtime import SandboxSettings, TraceMode
from datum_sandbox.wasi import default_stray_bound

MIB = 1024 * 1024


def test_the_defaults_are_the_documented_ones_and_every_source_is_default() -> None:
    settings = SandboxSettings.defaults()
    assert settings.engine.id == "wasmtime"
    assert (settings.engine.stop_grace, settings.engine.max_strays, settings.engine.tick) == (5.0, 0, 0.05)
    assert settings.engine.stray_bound == default_stray_bound()
    assert (settings.lifecycle.fail_fast, settings.lifecycle.warm_up_runs) == (True, 3)
    assert (settings.lifecycle.startup_budget, settings.lifecycle.shutdown_grace) == (30.0, 10.0)
    assert settings.limits == ProgramLimits()
    assert settings.host.formula_errors is FormulaErrors.FAIL
    diagnostics = settings.diagnostics
    assert (diagnostics.trace, diagnostics.report) == (TraceMode.OFF, True)
    capture = diagnostics.capture
    assert (capture.enabled, capture.directory) == (False, None)
    assert (capture.max_runs, capture.max_bytes, capture.queue_bytes) == (20, 64 * MIB, 64 * MIB)
    report = settings.explain()
    assert {entry.source for entry in report.entries} == {Source.DEFAULT}
    assert settings.checks == ()


def test_every_key_is_in_the_report_once_under_its_setting_name() -> None:
    keys = SandboxSettings.defaults().explain().keys()
    assert len(keys) == len(set(keys))
    for key in (
        "datum.runtime.engine",
        "datum.runtime.validation.time_limit",
        "datum.runtime.pdf.concurrency",
        "datum.runtime.verify_max_bytes",
        "datum.runtime.programs.sandbox",
        "datum.host.formula_errors",
        "datum.runtime.diagnostics.trace",
        "datum.runtime.diagnostics.report",
        "datum.runtime.diagnostics.capture.enabled",
        "datum.runtime.diagnostics.capture.directory",
        "datum.runtime.diagnostics.capture.max_runs",
        "datum.runtime.diagnostics.capture.max_bytes",
        "datum.runtime.diagnostics.capture.queue_bytes",
    ):
        assert key in keys


def test_a_configured_value_says_so_and_a_clamped_one_names_the_asked_value_and_the_bound() -> None:
    settings = SandboxSettings.build(validation_wait=3, pdf_time_limit=900)
    report = settings.explain()
    wait = report.get("datum.runtime.validation.wait")
    assert (wait.value, wait.source) == (3.0, Source.CONFIGURED)
    clamped = report.get("datum.runtime.pdf.time_limit")
    assert (clamped.value, clamped.source, clamped.asked, clamped.bound) == (
        300.0,
        Source.CLAMPED,
        900,
        "0.001 s to 300 s",
    )
    assert "clamped from 900 to the bound 0.001 s to 300 s" in clamped.text()
    assert [check.id for check in settings.checks] == [W008]


def test_a_host_default_is_reported_as_a_default() -> None:
    settings = SandboxSettings.build(defaults={"time_zone": "America/Toronto"})
    entry = settings.explain().get("datum.host.time_zone")
    assert (entry.value, entry.source) == ("America/Toronto", Source.DEFAULT)
    assert settings.host.time_zone == "America/Toronto"


def test_the_resolved_slot_counts_print_beside_the_setting() -> None:
    report = SandboxSettings.defaults().explain()
    assert "one per CPU = " in str(report.get("datum.runtime.validation.concurrency").resolved)
    assert "min(2, CPUs) = " in str(report.get("datum.runtime.pdf.concurrency").resolved)
    json_entry = report.get("datum.runtime.validation.concurrency").to_json()
    assert json_entry["value"] == 0, "the JSON value stays numeric; the resolved count sits beside it"
    assert "resolved" in json_entry


def test_the_engine_id_is_normalised() -> None:
    assert SandboxSettings.build(engine="  WasmTime ").engine.id == "wasmtime"


@pytest.mark.parametrize(
    ("values", "match"),
    [
        ({"trace": "verbose"}, "diagnostics.trace"),
        ({"capture_max_runs": 0}, "capture.max_runs"),
        ({"capture_max_bytes": -1}, "capture.max_bytes"),
        ({"capture_queue_bytes": 0}, "capture.queue_bytes"),
        ({"qjs_sha256": "ab" * 32}, "qjs_path"),
        ({"max_strays": -1}, "max_strays"),
        ({"stop_grace": -1}, "stop_grace"),
        ({"warm_up_runs": -2}, "warm_up_runs"),
        ({"formula_errors": "maybe"}, "formula_errors"),
    ],
)
def test_what_cannot_be_clamped_refuses_the_build(values: dict[str, object], match: str) -> None:
    with pytest.raises(DatumConfigurationError, match=match):
        SandboxSettings.build(**values)  # type: ignore[arg-type]


def test_the_trace_word_is_read_case_folded() -> None:
    assert SandboxSettings.build(trace=" Failures ").diagnostics.trace is TraceMode.FAILURES


def test_scrub_masks_user_information_and_query_values() -> None:
    text = scrub("sink https://key:secret@minio.example/b?token=abc&x=1 and s3://u@h/p plain")
    assert "secret" not in text
    assert "abc" not in text
    assert "https://***@minio.example/b?token=***&x=***" in text
    assert "s3://***@h/p" in text


def test_paths_are_left_out_of_the_management_read_but_not_the_log() -> None:
    report = SandboxSettings.build(capture_enabled=True, capture_directory="/srv/private/captures").explain()
    assert "/srv/private/captures" in str(report)
    entries = cast("list[dict[str, object]]", report.to_json(hide_paths=True)["entries"])
    keys = [entry["key"] for entry in entries]
    assert "datum.runtime.diagnostics.capture.directory" not in keys
    assert "datum.runtime.diagnostics.capture.enabled" in keys
