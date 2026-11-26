"""`datum.W002` (memory against the container), `datum.W003` (the default handler) and `datum.W004` (per-process
stores, throttle and idempotency too)."""

import logging
import subprocess
from pathlib import Path
from typing import Any

import pytest
from submissions_support import FORM, Repository, envelope, plain_datum

from datum_core import Datum, checks
from datum_core.checks import W002, W003, W004, container_memory_limit, memory_budget_check
from datum_core.loggers import CHECKS, SUBMISSIONS
from datum_core.submissions import Accepted, FormRef, SubmissionContext, SubmissionReceipt
from datum_sandbox.checks import CheckLevel
from datum_sandbox.protocol import ProgramLimits

MIB = 1024 * 1024
SUBMISSIONS_ON = {"web": {"api": {"endpoints": {"submissions": True}}}}


# -- W002: the container's memory limit --------------------------------------------------------------------------------
def cgroup_v2(root: Path, text: str) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "memory.max").write_text(text, encoding="utf-8")


def cgroup_v1(root: Path, text: str) -> None:
    (root / "memory").mkdir(parents=True, exist_ok=True)
    (root / "memory" / "memory.limit_in_bytes").write_text(text, encoding="utf-8")


def test_cgroup_v2_memory_max_is_the_limit(tmp_path: Path) -> None:
    cgroup_v2(tmp_path, "268435456\n")
    assert container_memory_limit(tmp_path) == 256 * MIB


def test_cgroup_v2_max_means_no_limit(tmp_path: Path) -> None:
    cgroup_v2(tmp_path, "max\n")
    assert container_memory_limit(tmp_path) is None


def test_cgroup_v1_is_read_when_there_is_no_v2_file(tmp_path: Path) -> None:
    cgroup_v1(tmp_path, "536870912\n")
    assert container_memory_limit(tmp_path) == 512 * MIB


def test_cgroup_v2_is_read_before_v1(tmp_path: Path) -> None:
    cgroup_v2(tmp_path, "268435456\n")
    cgroup_v1(tmp_path, "536870912\n")
    assert container_memory_limit(tmp_path) == 256 * MIB


@pytest.mark.parametrize(
    "text",
    [
        str(2**63 - 1),  # the unlimited value as the kernel states it
        str(2**63 - 4096),  # page-rounded on 4 KiB pages
        str(2**63 - 16384),  # 16 KiB pages
        str(2**63 - 65536),  # 64 KiB pages
    ],
)
def test_a_page_rounded_2_to_the_63_minus_1_is_no_limit(tmp_path: Path, text: str) -> None:
    cgroup_v1(tmp_path, text + "\n")
    assert container_memory_limit(tmp_path) is None


def test_a_v2_max_with_a_v1_limit_below_it_reads_the_v1_limit(tmp_path: Path) -> None:
    cgroup_v2(tmp_path, "max\n")
    cgroup_v1(tmp_path, "134217728\n")
    assert container_memory_limit(tmp_path) == 128 * MIB


@pytest.mark.parametrize("text", ["", "not a number", "-5", "0x10", "12 34"])
def test_a_file_that_is_no_number_is_no_limit_and_no_error(tmp_path: Path, text: str) -> None:
    cgroup_v2(tmp_path, text)
    assert container_memory_limit(tmp_path) is None


def test_no_cgroup_files_is_no_limit(tmp_path: Path) -> None:
    assert container_memory_limit(tmp_path) is None


def test_the_limit_is_read_with_pathlib_never_a_subprocess(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def forbidden(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("W002 must not run a command")

    monkeypatch.setattr(subprocess, "run", forbidden)
    monkeypatch.setattr(subprocess, "Popen", forbidden)
    cgroup_v2(tmp_path, "268435456\n")
    assert container_memory_limit(tmp_path) == 256 * MIB


def budgets(*, slots: int = 2, pdf_slots: int = 2) -> ProgramLimits:
    return ProgramLimits(
        validation_concurrency=slots, validation_memory=32 * MIB, pdf_concurrency=pdf_slots, pdf_memory=256 * MIB
    )


def test_slots_times_memory_over_the_limit_less_the_rss_is_one_w002_warning() -> None:
    # 2 x 32 MiB + 2 x 256 MiB = 576 MiB against 600 MiB less 100 MiB already resident
    check = memory_budget_check(budgets(), workers=1, limit=600 * MIB, rss=100 * MIB)
    assert check is not None
    assert (check.level, check.id) == (CheckLevel.WARNING, W002)
    assert "workers_expected" in check.hint


def test_the_same_budgets_within_the_limit_raise_nothing() -> None:
    assert memory_budget_check(budgets(), workers=1, limit=600 * MIB, rss=0) is None


def test_the_budget_is_multiplied_by_the_workers_expected() -> None:
    assert memory_budget_check(budgets(), workers=1, limit=1024 * MIB, rss=0) is None
    assert memory_budget_check(budgets(), workers=2, limit=1024 * MIB, rss=0) is not None


def test_the_rss_at_start_is_subtracted_from_the_limit() -> None:
    assert memory_budget_check(budgets(), workers=1, limit=700 * MIB, rss=0) is None
    assert memory_budget_check(budgets(), workers=1, limit=700 * MIB, rss=200 * MIB) is not None


def test_with_no_limit_at_all_there_is_no_warning() -> None:
    assert memory_budget_check(budgets(), workers=8, limit=None, rss=0) is None


def start(sections: dict[str, Any], monkeypatch: pytest.MonkeyPatch, root: Path, **seams: Any) -> Datum:
    monkeypatch.setattr(checks, "CGROUP_ROOT", root)
    monkeypatch.setattr(checks, "resident_set_bytes", lambda: 0)
    running = plain_datum(sections, **seams)
    running.start()
    running.stop()
    return running


def messages(caplog: pytest.LogCaptureFixture, check_id: str) -> list[str]:
    """The check's message lines (its HINT line carries the id too, as the W001 test pins: it is not a second check)."""
    return [
        r.getMessage()
        for r in caplog.records
        if getattr(r, "datum_check_id", "") == check_id and not r.getMessage().startswith("HINT:")
    ]


def test_the_start_logs_w002_on_the_checks_logger_when_the_budgets_exceed_the_cgroup(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    cgroup_v2(tmp_path, str(128 * MIB))
    sections = {"runtime": {"validation": {"concurrency": 2}, "pdf": {"concurrency": 2}}}
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(sections, monkeypatch, tmp_path)
    assert len(messages(caplog, W002)) == 1


def test_the_start_is_quiet_when_the_cgroup_is_roomy(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    cgroup_v2(tmp_path, str(8192 * MIB))
    sections = {"runtime": {"validation": {"concurrency": 2}, "pdf": {"concurrency": 2}}}
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(sections, monkeypatch, tmp_path)
    assert messages(caplog, W002) == []


def test_workers_expected_feeds_the_check(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    cgroup_v2(tmp_path, str(1024 * MIB))
    sections = {"workers_expected": 4, "runtime": {"validation": {"concurrency": 2}, "pdf": {"concurrency": 2}}}
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(sections, monkeypatch, tmp_path)
    assert len(messages(caplog, W002)) == 1


def test_a_silenced_w002_is_not_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    cgroup_v2(tmp_path, str(128 * MIB))
    sections = {"silenced_checks": [W002], "runtime": {"validation": {"concurrency": 2}, "pdf": {"concurrency": 2}}}
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(sections, monkeypatch, tmp_path)
    assert messages(caplog, W002) == []


# -- W003: the default handler -----------------------------------------------------------------------------------------
def test_the_default_logging_handler_is_one_w003_with_the_constructor_keyword_in_the_hint(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(SUBMISSIONS_ON, monkeypatch, tmp_path)
    assert len(messages(caplog, W003)) == 1
    hints = [
        r.getMessage() for r in caplog.records if r.getMessage().startswith("HINT:") and "handler" in r.getMessage()
    ]
    assert any("Datum(handler=" in hint for hint in hints)


def test_an_application_handler_raises_no_w003(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(SUBMISSIONS_ON, monkeypatch, tmp_path, handler=lambda accepted: SubmissionReceipt("1", "R"))
    assert messages(caplog, W003) == []


def test_the_default_handler_answers_a_receipt_and_logs_the_form_and_never_the_answers(
    caplog: pytest.LogCaptureFixture,
) -> None:
    running = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]))
    running.start()
    try:
        with caplog.at_level(logging.DEBUG, logger=SUBMISSIONS):
            outcome = running.submission_service.submit(
                FormRef.from_document(), envelope(), SubmissionContext(channel="bus", submission_key="bus-1")
            )
    finally:
        running.stop()
    assert isinstance(outcome, Accepted)
    assert outcome.receipt.id
    assert outcome.receipt.reference
    logged = " ".join(r.getMessage() for r in caplog.records if r.name == SUBMISSIONS)
    assert FORM in logged
    assert "Ada Lovelace" not in logged


# -- W004: per-process stores ------------------------------------------------------------------------------------------
def test_throttle_and_idempotency_are_each_one_w004_naming_their_health_component(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(SUBMISSIONS_ON, monkeypatch, tmp_path)
    found = messages(caplog, W004)
    assert len([m for m in found if "stores.throttle" in m]) == 1
    assert len([m for m in found if "stores.idempotency" in m]) == 1


def test_a_silenced_w004_hides_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start({"silenced_checks": [W004], **SUBMISSIONS_ON}, monkeypatch, tmp_path)
    assert messages(caplog, W004) == []


def test_the_w004_hint_names_a_sql_engine_or_the_throttle_storage_setting(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        start(SUBMISSIONS_ON, monkeypatch, tmp_path)
    hints = " ".join(r.getMessage() for r in caplog.records if r.getMessage().startswith("HINT:"))
    assert "datum.web.throttle.storage" in hints or "SQL engine" in hints
