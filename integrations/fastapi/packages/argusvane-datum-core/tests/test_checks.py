import logging

import pytest

from datum_core import checks, loggers
from datum_sandbox import checks as sandbox_checks
from datum_sandbox.checks import CheckLevel, DatumCheck, DatumConfigurationError


def test_every_id_is_a_constant_in_the_table() -> None:
    ids = {getattr(checks, name) for name in dir(checks) if len(name) == 4 and name[0] in "IWE" and name[1:].isdigit()}
    assert ids | set(sandbox_checks.SANDBOX_CHECK_LEVELS) == set(checks.CHECK_LEVELS)
    assert not ids & set(sandbox_checks.SANDBOX_CHECK_LEVELS), "no id is spelt twice"
    assert checks.W007 == "datum.W007"
    assert checks.CHECK_LEVELS[sandbox_checks.E003] is CheckLevel.ERROR
    assert checks.CHECK_LEVELS[checks.I001] is CheckLevel.INFO


def test_check_is_frozen_slotted_and_renders() -> None:
    check = DatumCheck(CheckLevel.WARNING, checks.W001, "msg", "hint")
    assert str(check) == "(datum.W001) msg\nHINT: hint"
    assert str(DatumCheck(CheckLevel.INFO, checks.I001, "m")) == "(datum.I001) m"
    assert not hasattr(check, "__dict__")
    with pytest.raises(AttributeError):
        check.msg = "other"  # type: ignore[misc]


def test_errors_are_raised_together() -> None:
    error_a = sandbox_checks.memory_below_floor("a", 1, 2)
    error_b = sandbox_checks.memory_below_floor("b", 1, 2)
    with pytest.raises(DatumConfigurationError) as caught:
        sandbox_checks.raise_errors([checks.process_zone_unresolved(), error_a, error_b])
    assert caught.value.problems == (error_a, error_b)
    assert isinstance(caught.value, ValueError)
    assert "a is 1 bytes" in str(caught.value)
    sandbox_checks.raise_errors([checks.process_zone_unresolved()])  # warnings alone do not raise


def test_silence_drops_info_and_warning_never_error() -> None:
    warn = checks.process_zone_unresolved()
    error = sandbox_checks.memory_below_floor("a", 1, 2)
    assert checks.silence([warn, error], {warn.id, error.id}) == (error,)


def test_logging_goes_to_datum_checks_with_no_handler(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.INFO, logger=loggers.CHECKS):
        checks.log_checks([checks.process_zone_unresolved()])
    assert next(r.getMessage() for r in caplog.records).startswith("(datum.W010)")
    assert caplog.records[0].datum_check_id == "datum.W010"  # type: ignore[attr-defined]
    assert caplog.records[0].name == "datum.checks"


def test_logger_names_and_no_handler_installed() -> None:
    assert loggers.LOGGER_NAMES == (
        "datum.sandbox", "datum.events", "datum.checks", "datum.runtime", "datum.submissions",
        "datum.forms", "datum.builder", "datum.pdf", "datum.tsa", "datum.assets", "datum.sandbox.trace",
        "datum.sandbox.settings",
    )  # fmt: skip
    for name in (loggers.ROOT, *loggers.LOGGER_NAMES):
        assert logging.getLogger(name).handlers == []


def test_e004_is_an_error_naming_the_setting_and_the_phases() -> None:
    assert checks.CHECK_LEVELS[sandbox_checks.E004] is CheckLevel.ERROR
    check = sandbox_checks.startup_over_budget(30.0, [("build ids", 0.01), ("runtime", 29.9)])
    assert check.id == sandbox_checks.E004
    assert check.level is CheckLevel.ERROR
    assert "datum.runtime.startup_budget" in check.msg
    assert "30 s" in check.msg
    assert "build ids 0.01 s" in check.msg
    assert "runtime 29.9 s" in check.msg
    assert "\n" not in check.msg


def test_a_multi_problem_error_keeps_one_problem_per_line() -> None:
    found = [sandbox_checks.memory_below_floor("a", 1, 2), sandbox_checks.startup_over_budget(1.0, [("runtime", 2.0)]),
             sandbox_checks.memory_below_floor("b", 3, 4)]  # fmt: skip
    with pytest.raises(DatumConfigurationError) as caught:
        sandbox_checks.raise_errors(found)
    lines = str(caught.value).splitlines()
    problems = [line for line in lines if line.startswith("(datum.")]
    assert len(problems) == 3, "one line per problem, none wrapped"
    assert [line.split(")")[0] for line in problems] == ["(datum.E003", "(datum.E004", "(datum.E003"]
    assert all(line.startswith(("(datum.", "HINT: ")) for line in lines), "nothing else is in the message"
