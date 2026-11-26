"""Wiring details of the observation and the start checks that the other tests do not spell out."""

import logging
from pathlib import Path

import pytest
from observe_support import attrs, telemetry
from submissions_support import definition, http_context, plain_datum, started

from datum_core import checks
from datum_core.checks import W002
from datum_core.loggers import CHECKS

MIB = 1024 * 1024


def test_an_inspect_call_is_a_datum_submission_span_with_mode_inspect() -> None:
    otel = telemetry()
    with started() as rig:
        rig.service.inspect("abi", definition(), http_context())
    (span,) = otel.spans("datum.submission")
    assert attrs(span)["datum.mode"] == "inspect"
    assert attrs(span)["datum.outcome"] == "inspected"


def test_the_start_proof_and_warm_up_runs_are_not_observed() -> None:
    otel = telemetry()
    running = plain_datum()
    running.start()
    running.stop()
    assert otel.spans("datum.sandbox.run") == []


def test_with_no_cgroup_limit_the_hosts_ram_is_the_limit(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(checks, "CGROUP_ROOT", tmp_path)  # no files: no container limit
    monkeypatch.setattr(checks, "physical_memory", lambda: 64 * MIB)
    monkeypatch.setattr(checks, "resident_set_bytes", lambda: 0)
    running = plain_datum()
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        running.start()
    running.stop()
    assert [r for r in caplog.records if getattr(r, "datum_check_id", "") == W002]


def test_with_no_limit_anywhere_nothing_is_said(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.setattr(checks, "CGROUP_ROOT", tmp_path)
    monkeypatch.setattr(checks, "physical_memory", lambda: None)
    running = plain_datum()
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        running.start()
    running.stop()
    assert not [r for r in caplog.records if getattr(r, "datum_check_id", "") == W002]


def test_the_resident_set_is_a_positive_number_of_bytes() -> None:
    assert checks.resident_set_bytes() > 0
