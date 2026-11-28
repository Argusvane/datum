"""HostOptions (the host's context keys, words refused when unknown) and the ABI gate's memory."""

from datetime import UTC, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

import pytest

from datum_core.config import DatumConfig
from datum_core.config.sandbox import sandbox_settings
from datum_sandbox.protocol import (
    HOST_KEYS,
    PDF_ABI_MIN,
    SANDBOX_ABI_MIN,
    AbiProbe,
    FormulaErrors,
    HostOptions,
    ProgramUnavailableError,
    RiskyPatterns,
    require_probe_answer,
    sandbox_probe_request,
)


def test_defaults_are_fail_and_refuse() -> None:
    options = HostOptions(now=lambda: datetime(2026, 10, 19, 12, tzinfo=UTC))
    assert options.context_keys() == {"today": "2026-10-19", "formulaErrors": "fail", "riskyPatterns": "refuse"}
    assert tuple(options.context_keys()) == HOST_KEYS


def test_today_in_the_host_zone() -> None:
    late = datetime(2026, 1, 1, 2, 30, tzinfo=UTC)
    assert HostOptions(time_zone=ZoneInfo("America/Vancouver"), now=lambda: late).today() == "2025-12-31"
    assert HostOptions(time_zone=ZoneInfo("Pacific/Kiritimati"), now=lambda: late).today() == "2026-01-01"
    offset = datetime(2026, 1, 1, 23, tzinfo=timezone(timedelta(hours=-5)))
    assert HostOptions(now=lambda: offset).today() == "2026-01-02"


def test_naive_clock_refused() -> None:
    with pytest.raises(ValueError, match="naive"):
        HostOptions(now=lambda: datetime(2026, 1, 1)).today()


def test_words_folded_and_unknown_words_refused() -> None:
    options = HostOptions("WARN", "Allow")  # type: ignore[arg-type]
    assert options.formula_errors is FormulaErrors.WARN
    assert options.risky_patterns is RiskyPatterns.ALLOW
    for formula, risky in (("ignore", "refuse"), ("fail", "maybe"), ("", "refuse")):
        with pytest.raises(ValueError):  # noqa: PT011
            HostOptions(formula, risky)  # type: ignore[arg-type]
    with pytest.raises(TypeError):
        HostOptions(time_zone="UTC")  # type: ignore[arg-type]


def test_host_keys_are_set_over_the_context() -> None:
    options = HostOptions(now=lambda: datetime(2026, 5, 5, tzinfo=UTC))
    context = {"formId": "f", "formulaErrors": "warn", "riskyPatterns": "allow", "today": "1999-01-01"}
    merged = options.merged(context)
    assert merged == {"formId": "f", "formulaErrors": "fail", "riskyPatterns": "refuse", "today": "2026-05-05"}
    assert context["formulaErrors"] == "warn"


def test_from_config() -> None:
    config = DatumConfig.model_validate(
        {"host": {"formula_errors": "warn", "risky_patterns": "allow", "time_zone": "Asia/Tokyo"}}
    )
    host = sandbox_settings(config).host
    options = HostOptions(
        host.formula_errors, host.risky_patterns, ZoneInfo(host.time_zone), lambda: datetime(2026, 1, 1, 16, tzinfo=UTC)
    )
    assert options.context_keys() == {"today": "2026-01-02", "formulaErrors": "warn", "riskyPatterns": "allow"}


def test_abi_floors() -> None:
    assert SANDBOX_ABI_MIN == "1.0.0"
    assert PDF_ABI_MIN == "1.0.0"


def test_probe_request() -> None:
    request = sandbox_probe_request()
    assert request["abi"] == SANDBOX_ABI_MIN
    assert request["op"] == "inspect"
    assert request["definition"] == {
        "id": "datum-abi-probe",
        "root": {"id": "root", "type": "form", "configuration": {}, "children": {"content": []}},
    }
    assert sandbox_probe_request() is not sandbox_probe_request()


@pytest.mark.parametrize(
    "answer",
    [{"ok": "true"}, {"ok": 1}, {"ok": False}, {}, [], None, True, "ok", {"ok": [True]}, {"result": {"ok": True}}],
)
def test_probe_strict_truthiness(answer: object) -> None:
    with pytest.raises(ProgramUnavailableError, match=r"\(unknown\)"):
        require_probe_answer(answer)  # type: ignore[arg-type]


def test_probe_answer_names_the_program_code() -> None:
    require_probe_answer({"ok": True, "op": "inspect"})
    with pytest.raises(ProgramUnavailableError, match=r"\(abi_mismatch\)") as raised:
        require_probe_answer({"ok": False, "error": {"code": "abi_mismatch"}})
    assert (raised.value.code, raised.value.status) == ("server.unavailable", 503)


def test_probe_memory_by_sha_and_floor() -> None:
    probe = AbiProbe()
    assert not probe.proved("a")
    probe.remember("a")
    assert probe.proved("a")
    assert probe.proved("a", SANDBOX_ABI_MIN)
    assert not probe.proved("a", "0.15.0")
    assert not probe.proved("b")
    probe.remember("b")
    probe.forget("a")
    assert not probe.proved("a")
    assert probe.proved("b")
    probe.forget()
    assert not probe.proved("b")
