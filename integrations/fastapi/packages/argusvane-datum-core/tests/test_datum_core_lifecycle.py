"""The framework-free composition root: keyword-only, synchronous start and stop, checks, health, info."""

import logging
import threading
from collections.abc import Mapping, Sequence
from typing import Any, cast

import pytest

from datum_core import Datum, DatumConfig, DatumNotStartedError
from datum_core.events import DatumRuntimeReadyEvent, listener
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError, Sandbox, Smoke
from datum_sandbox.wasi import EngineInfo, GuestRuntime


class StubRuntime:
    def __init__(self) -> None:
        self.closed = 0

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test", notes=("a note",))

    def close(self) -> None:
        self.closed += 1


class StubSandbox:
    def __init__(self, *, abi_error: Exception | None = None) -> None:
        self.abi_error = abi_error
        self.abi_proofs = 0
        self.smokes = 0

    def prove_abi(self) -> None:
        self.abi_proofs += 1
        if self.abi_error is not None:
            raise self.abi_error

    def smoke(self) -> Smoke:
        self.smokes += 1
        return Smoke(ok=True, elapsed=0.0, message="")

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        return dict(definition)


def is_started(datum: Datum) -> bool:
    """Read `started` without mypy narrowing it across the calls in between."""
    return datum.started


def make(
    config: DatumConfig | None = None,
    *,
    sandbox: StubSandbox | None = None,
    listeners: Sequence[Any] = (),
) -> tuple[Datum, StubRuntime, StubSandbox]:
    runtime, stub = StubRuntime(), sandbox or StubSandbox()
    datum = Datum(
        config=config or DatumConfig(),
        runtime=cast("GuestRuntime", runtime),
        sandbox=cast("Sandbox", stub),
        listeners=listeners,
    )
    return datum, runtime, stub


def test_the_object_is_keyword_only_so_a_positional_argument_or_a_typo_is_a_type_error() -> None:
    with pytest.raises(TypeError):
        Datum(DatumConfig())  # type: ignore[call-arg]
    with pytest.raises(TypeError):
        Datum(confg=DatumConfig())  # type: ignore[call-arg]


def test_start_proves_the_abi_once_runs_a_smoke_and_publishes_the_runtime_ready_event_once() -> None:
    events: list[DatumRuntimeReadyEvent] = []
    datum, _runtime, sandbox = make(listeners=[listener(DatumRuntimeReadyEvent, events.append)])
    assert not is_started(datum)
    datum.start()
    assert is_started(datum)
    assert sandbox.abi_proofs == 1
    assert sandbox.smokes >= 1
    assert len(events) == 1
    assert events[0].engine.id == "stub"
    datum.stop()


def test_stop_closes_the_runtime_once_and_a_second_stop_is_a_no_op() -> None:
    datum, runtime, _sandbox = make()
    datum.start()
    datum.stop()
    datum.stop()
    assert not is_started(datum)
    assert runtime.closed == 1


def test_a_failed_start_is_undone_before_it_raises_and_leaves_no_thread() -> None:
    before = {t.ident for t in threading.enumerate()}
    datum, runtime, _sandbox = make(sandbox=StubSandbox(abi_error=ProgramUnavailableError("abi too old")))
    with pytest.raises((ProgramUnavailableError, DatumConfigurationError)):
        datum.start()
    assert not is_started(datum)
    assert runtime.closed == 1
    assert {t.ident for t in threading.enumerate()} <= before
    for service in ("definition_service", "translation_service", "data_source_service"):
        with pytest.raises(DatumNotStartedError):
            getattr(datum, service)
    datum.stop()  # nothing to stop; no error


def test_with_fail_fast_off_a_failed_start_returns_and_health_is_down_with_the_reason() -> None:
    config = DatumConfig.model_validate({"runtime": {"fail_fast": False}})
    datum, _runtime, _sandbox = make(config, sandbox=StubSandbox(abi_error=ProgramUnavailableError("abi too old")))
    datum.start()
    report = datum.health()
    assert report.status == "down"
    assert report.components["runtime"].status == "down"
    assert "abi too old" in str(report.components["runtime"].details["reason"])
    assert report.is_ready is False


def test_health_before_the_start_is_down_with_lifespan_not_run_and_after_it_up_with_the_engine() -> None:
    datum, _runtime, _sandbox = make()
    before = datum.health()
    assert before.components["runtime"].status == "down"
    assert before.components["runtime"].details["reason"] == "lifespan not run"
    datum.start()
    after = datum.health()
    assert after.is_ready is True
    assert after.components["runtime"].details["engine"] == "stub"
    datum.stop()


def test_the_start_refuses_the_builder_over_an_in_memory_store_with_more_than_one_worker() -> None:
    config = DatumConfig.model_validate({"builder": {"enabled": True}, "workers_expected": 2})
    datum, _runtime, _sandbox = make(config)
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [p.id for p in raised.value.problems] == ["datum.E002"]
    assert not is_started(datum)


def test_the_start_logs_one_i001_line_naming_the_routes_that_are_on(caplog: pytest.LogCaptureFixture) -> None:
    config = DatumConfig.model_validate({"web": {"api": {"endpoints": {"definition": True}}}})
    datum, _runtime, _sandbox = make(config)
    with caplog.at_level(logging.INFO, logger="datum.checks"):
        datum.start()
    lines = [r for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.I001"]
    assert len(lines) == 1
    assert lines[0].levelno == logging.INFO
    assert "definition" in lines[0].getMessage()
    datum.stop()


def test_with_every_switch_off_the_i001_line_says_none(caplog: pytest.LogCaptureFixture) -> None:
    datum, _runtime, _sandbox = make()
    with caplog.at_level(logging.INFO, logger="datum.checks"):
        datum.start()
    lines = [r for r in caplog.records if getattr(r, "datum_check_id", None) == "datum.I001"]
    assert len(lines) == 1
    assert "none" in lines[0].getMessage()
    datum.stop()


def test_info_is_flat_and_names_the_engine_and_the_abis() -> None:
    datum, _runtime, _sandbox = make()
    datum.start()
    info = datum.info()
    for key in ("engineVersion", "sandboxAbi", "pdfAbi", "buildId", "engine", "engineRelease", "engineMode"):
        assert key in info, key
    assert info["engine"] == "stub"
    assert info["pdfCapable"] is False
    assert "capabilities" in info
    datum.stop()
