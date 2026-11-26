"""`datum_core.Datum` beyond the basic pins: the startup checks, the build-id agreement, fail_fast, recheck, events."""

import inspect
import json
import logging
import threading
import time
from collections.abc import Mapping
from pathlib import Path
from typing import Any, cast

import pytest

import datum_core.datum as datum_module
from datum_core import Datum, DatumConfig, DatumNotStartedError
from datum_core.config._zone import ProcessZone
from datum_core.datum import DatumOptions
from datum_core.events import DatumRuntimeReadyEvent, SandboxRunInterruptedEvent, listener
from datum_core.forms import DataSourceRequest, NotFound, Served, StoredDefinition, Unavailable
from datum_core.stores.memory import MemoryDefinitionSnapshotStore, MemoryTranslationCatalogStore
from datum_sandbox.checks import CheckLevel, DatumCheck, DatumConfigurationError
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError, Sandbox, SandboxError, SandboxFailure, Smoke
from datum_sandbox.wasi import (
    Available,
    DiscoveredRuntime,
    EngineInfo,
    EngineLimits,
    EngineSelectionError,
    EngineSettings,
    GuestRuntime,
    GuestRuntimes,
)

CHECKS = "datum.checks"
DEFINITION_ON: dict[str, Any] = {"web": {"api": {"endpoints": {"definition": True}}}}


class StubRuntime:
    def __init__(self) -> None:
        self.closed = 0

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        self.closed += 1


class StubSandbox:
    """The sandbox calls a start and the definition read make; `public_error` makes the public copy raise."""

    def __init__(self, *, abi_error: Exception | None = None, smoke_ok: bool = True) -> None:
        self.abi_error = abi_error
        self.smoke_ok = smoke_ok
        self.public_error: Exception | None = None
        self.calls: list[str] = []

    def prove_abi(self) -> None:
        self.calls.append("prove_abi")
        if self.abi_error is not None:
            raise self.abi_error

    def smoke(self) -> Smoke:
        self.calls.append("smoke")
        return Smoke(ok=self.smoke_ok, elapsed=0.0, message="" if self.smoke_ok else "the verdict was wrong")

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.calls.append("public_copy")
        if self.public_error is not None:
            raise self.public_error
        public = json.dumps(definition).replace('"run": "server-secret"', '"run": "x"')
        return cast("dict[str, JsonValue]", json.loads(public))


SECRET_RULE: dict[str, JsonValue] = {"requiredWhen": {"run": "server-secret", "formula": 'name = "x"'}}


class Repository:
    """One form, `contact`, with a server-secret rule (so its public copy needs the sandbox)."""

    def current(self, key: str) -> StoredDefinition | None:
        if key != "contact":
            return None
        name: dict[str, JsonValue] = {"id": "name", "type": "text", "configuration": {}, "rules": SECRET_RULE}
        root: dict[str, JsonValue] = {"id": "form", "type": "form", "children": {"content": [name]}}
        form: dict[str, JsonValue] = {"id": "contact", "version": "1", "root": root}
        return StoredDefinition(key, form, "0" * 64)


class Countries:
    """A data-source provider that keeps the default `exists` (no method of its own)."""

    def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        return [{"value": "ca"}]


class Cities:
    """A data-source provider with its own `exists`."""

    def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        return [{"value": "ottawa"}]

    def exists(self, source_id: str) -> bool:
        return source_id == "cities"


def make(
    sections: Mapping[str, Any] | None = None, *, sandbox: StubSandbox | None = None, **seams: Any
) -> tuple[Datum, StubRuntime, StubSandbox]:
    runtime, stub = StubRuntime(), sandbox or StubSandbox()
    seams.setdefault("form_repository", Repository())
    datum = Datum(
        config=DatumConfig.model_validate(dict(sections or {})),
        runtime=cast("GuestRuntime", runtime),
        sandbox=cast("Sandbox", stub),
        **seams,
    )
    return datum, runtime, stub


def is_ready(datum: Datum) -> bool:
    """Read `ready` without mypy narrowing it across the calls in between."""
    return datum.ready


def ids(caplog: pytest.LogCaptureFixture, check_id: str) -> list[logging.LogRecord]:
    return [r for r in caplog.records if r.name == CHECKS and getattr(r, "datum_check_id", None) == check_id]


# ---- the signature -----------------------------------------------------------------------------------------------
def test_the_options_a_binding_passes_on_are_exactly_the_keyword_seams() -> None:
    parameters = inspect.signature(Datum.__init__).parameters
    keywords = {name for name, p in parameters.items() if p.kind is inspect.Parameter.KEYWORD_ONLY}
    assert all(p.kind is not inspect.Parameter.POSITIONAL_OR_KEYWORD for n, p in parameters.items() if n != "self")
    assert keywords == set(DatumOptions.__annotations__)


# ---- the startup checks ----------------------------------------------------------------------------------------------
def test_a_data_source_provider_keeping_the_default_exists_is_one_w006(caplog: pytest.LogCaptureFixture) -> None:
    datum, _, _ = make(data_sources=[Countries(), Cities()])
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    found = [r for r in ids(caplog, "datum.W006") if r.getMessage().startswith("(datum.W006)")]
    assert len(found) == 1
    assert "Countries" in found[0].getMessage()
    datum.stop()


def test_providers_with_their_own_exists_raise_no_w006(caplog: pytest.LogCaptureFixture) -> None:
    datum, _, _ = make(data_sources=[Cities()])
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    assert ids(caplog, "datum.W006") == []
    datum.stop()


def test_a_router_built_with_every_switch_off_is_one_w001_naming_the_switches(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum, _, _ = make()
    datum.register_router("forms", {"datum.web.api.endpoints.definition": False, "datum.web.api.endpoints.x": False})
    datum.register_router("assets", {"datum.web.assets.enabled": True})
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    found = [r.getMessage() for r in ids(caplog, "datum.W001")]
    assert len(found) == 2  # the message line and its HINT line
    assert "forms" in found[0]
    assert "assets" not in found[0]
    assert "datum.web.api.endpoints.definition" in found[1]
    datum.stop()


def test_with_datum_disabled_a_built_router_is_a_w001_naming_datum_enabled(caplog: pytest.LogCaptureFixture) -> None:
    datum, _, _ = make({"enabled": False, **DEFINITION_ON})
    datum.register_router("forms", {"datum.web.api.endpoints.definition": True})
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    hints = [r.getMessage() for r in ids(caplog, "datum.W001") if r.getMessage().startswith("HINT")]
    assert hints == ["HINT: set datum.enabled to true, or do not include the router"]
    datum.stop()


def test_a_silenced_w001_is_not_logged(caplog: pytest.LogCaptureFixture) -> None:
    datum, _, _ = make({"silenced_checks": ["datum.W001"]})
    datum.register_router("forms", {"datum.web.api.endpoints.definition": False})
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    assert ids(caplog, "datum.W001") == []
    datum.stop()


def test_the_memory_stores_warn_w004_only_when_forms_are_served(caplog: pytest.LogCaptureFixture) -> None:
    quiet, _, _ = make()
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        quiet.start()
    assert ids(caplog, "datum.W004") == []
    quiet.stop()
    caplog.clear()
    served, _, _ = make(DEFINITION_ON)
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        served.start()
    messages = [r.getMessage() for r in ids(caplog, "datum.W004") if r.getMessage().startswith("(")]
    assert len(messages) == 2
    assert any("stores.snapshots" in m for m in messages)
    assert any("stores.translations" in m for m in messages)
    served.stop()


def test_an_application_store_is_not_warned_about(caplog: pytest.LogCaptureFixture) -> None:
    class Snapshots:
        def record(self, key: str, sha256: str, definition: Mapping[str, JsonValue]) -> None: ...

        def find(self, key: str, sha256: str) -> dict[str, JsonValue] | None:
            return None

    datum, _, _ = make(DEFINITION_ON, snapshot_store=Snapshots())
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    messages = [r.getMessage() for r in ids(caplog, "datum.W004") if r.getMessage().startswith("(")]
    assert len(messages) == 1
    assert "stores.translations" in messages[0]
    assert datum.health().components["stores.snapshots"].details == {"store": "custom"}
    datum.stop()


def test_web_concurrency_is_the_workers_hint_for_e002_when_workers_expected_is_unset(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("WEB_CONCURRENCY", "3")
    datum, runtime, sandbox = make({"builder": {"enabled": True}})
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [p.id for p in raised.value.problems] == ["datum.E002"]
    assert "3 workers" in raised.value.problems[0].msg
    assert sandbox.calls == []  # refused before the runtime was asked anything
    assert runtime.closed == 0  # never brought up, so nothing to close


def test_one_worker_by_hint_raises_no_e002(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_CONCURRENCY", "1")
    datum, _, _ = make({"builder": {"enabled": True}})
    datum.start()
    assert datum.ready
    datum.stop()


def test_a_configuration_refusal_stops_the_start_whatever_fail_fast_says() -> None:
    datum, _, _ = make({"builder": {"enabled": True}, "workers_expected": 2, "runtime": {"fail_fast": False}})
    with pytest.raises(DatumConfigurationError):
        datum.start()
    assert not datum.started


def test_an_unknown_engine_stops_the_start_whatever_fail_fast_says() -> None:
    datum = Datum(config=DatumConfig.model_validate({"runtime": {"engine": "nope", "fail_fast": False}}))
    with pytest.raises(DatumConfigurationError, match="nope") as raised:
        datum.start()
    assert isinstance(raised.value.__cause__, EngineSelectionError), "the engine layer's refusal, translated once"
    assert not datum.started
    assert datum.health().components["runtime"].status == "down"


def test_the_process_zone_fallback_is_one_w010(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    check = DatumCheck(CheckLevel.WARNING, "datum.W010", "the process time zone could not be read", "set it")
    monkeypatch.setattr(datum_module, "process_zone", lambda: ProcessZone("UTC", check))
    datum, _, _ = make({"host": {"time_zone": "UTC"}})
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    assert len([r for r in ids(caplog, "datum.W010") if r.getMessage().startswith("(")]) == 1
    datum.stop()


# ---- the build-id agreement --------------------------------------------------------------------------------------
def other_build(tmp_path: Path, monkeypatch: pytest.MonkeyPatch, build_id: str = "ffffffffffff") -> None:
    package = tmp_path / "datum_other_build"
    package.mkdir()
    (package / "__init__.py").write_text("", encoding="utf-8")
    (package / "datum-build.json").write_text(json.dumps({"buildId": build_id}), encoding="utf-8")
    monkeypatch.syspath_prepend(str(tmp_path))
    monkeypatch.setattr(
        datum_module,
        "RESOURCE_PACKAGES",
        (*datum_module.RESOURCE_PACKAGES, ("datum_other_build", "datum-other-build")),
    )


def test_installed_distributions_on_another_build_stop_the_start_naming_both(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    other_build(tmp_path, monkeypatch)
    datum, runtime, sandbox = make({"runtime": {"fail_fast": False}})  # assets off, fail_fast off: still refused
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    message = str(raised.value)
    assert "datum-other-build is build ffffffffffff" in message
    assert "argusvane-datum-core is build" in message
    assert sandbox.calls == []
    assert runtime.closed == 0
    assert not datum.started


def test_the_agreed_build_id_is_datum_cores_own_and_info_carries_it() -> None:
    datum, _, _ = make()
    assert datum.info()["buildId"] is None
    datum.start()
    core_build = json.loads((Path(datum_module.__file__).parent / "datum-build.json").read_text(encoding="utf-8"))[
        "buildId"
    ]
    assert datum.build_id == core_build
    assert datum.info()["buildId"] == core_build
    datum.stop()


# ---- fail_fast, recheck, the ready event -------------------------------------------------------------------------
def test_a_smoke_run_with_the_wrong_verdict_fails_the_start() -> None:
    datum, runtime, _ = make(sandbox=StubSandbox(smoke_ok=False))
    with pytest.raises(ProgramUnavailableError, match="the verdict was wrong"):
        datum.start()
    assert runtime.closed == 1
    assert "the verdict was wrong" in str(datum.health().components["runtime"].details["reason"])


def test_with_fail_fast_off_the_services_answer_unavailable_until_a_recheck_brings_the_runtime_up() -> None:
    ready: list[DatumRuntimeReadyEvent] = []
    sandbox = StubSandbox(abi_error=ProgramUnavailableError("abi too old"))
    datum, _, _ = make(
        {"runtime": {"fail_fast": False}, **DEFINITION_ON},
        sandbox=sandbox,
        listeners=[listener(DatumRuntimeReadyEvent, ready.append)],
    )
    datum.start()
    assert datum.started
    assert not is_ready(datum)
    assert isinstance(datum.definition_service.read("contact"), Unavailable)
    assert ready == []
    assert datum.recheck().components["runtime"].status == "down"  # still too old
    sandbox.abi_error = None
    report = datum.recheck()
    assert report.components["runtime"].status == "up"
    assert is_ready(datum)
    assert len(ready) == 1
    assert isinstance(datum.definition_service.read("contact"), Served)
    datum.stop()


def test_a_recheck_of_a_ready_runtime_proves_the_abi_again_and_a_failure_takes_it_down() -> None:
    sandbox = StubSandbox()
    datum, _, _ = make(sandbox=sandbox)
    datum.start()
    before = sandbox.calls.count("prove_abi")
    assert datum.recheck().is_ready
    assert sandbox.calls.count("prove_abi") == before + 1
    sandbox.smoke_ok = False
    report = datum.recheck()
    assert report.components["runtime"].status == "down"
    assert "the verdict was wrong" in str(report.components["runtime"].details["reason"])
    datum.stop()


def test_a_recheck_before_the_start_changes_nothing() -> None:
    datum, _, sandbox = make()
    assert datum.recheck().components["runtime"].details["reason"] == "lifespan not run"
    assert sandbox.calls == []


def test_an_async_listener_without_an_awaiter_is_refused_at_the_start() -> None:
    async def audit(event: DatumRuntimeReadyEvent) -> None: ...

    datum, runtime, _ = make(listeners=[listener(DatumRuntimeReadyEvent, audit)])
    with pytest.raises(DatumConfigurationError, match="awaiter"):
        datum.start()
    assert not datum.started
    assert runtime.closed == 0


def test_the_ready_event_carries_the_declared_abis_and_the_warm_up_time() -> None:
    ready: list[DatumRuntimeReadyEvent] = []
    datum, _, _ = make(listeners=[listener(DatumRuntimeReadyEvent, ready.append)])
    datum.start()
    (event,) = ready
    assert event.sandbox_abi == datum.info()["sandboxAbi"]
    assert event.pdf_abi == datum.info()["pdfAbi"]
    assert event.warm_up_millis >= 0.0
    datum.stop()


# ---- the observation and the middleware --------------------------------------------------------------------------
@pytest.mark.parametrize(
    ("failure", "reason"),
    [
        (SandboxFailure.BUDGET, "budget"),
        (SandboxFailure.MEMORY, "memory"),
        (SandboxFailure.TRAP, "trap"),
        (SandboxFailure.OUTPUT_CAP, "output-cap"),
        (SandboxFailure.INTERRUPTED, "interrupted"),
    ],
)
def test_a_run_the_runtime_stopped_publishes_one_interrupted_event(failure: SandboxFailure, reason: str) -> None:
    stopped: list[SandboxRunInterruptedEvent] = []
    datum, _, sandbox = make(DEFINITION_ON, listeners=[listener(SandboxRunInterruptedEvent, stopped.append)])
    datum.start()
    sandbox.public_error = SandboxError(failure, "stopped")
    with pytest.raises(SandboxError):
        datum.definition_service.read("contact")
    assert [(e.program, e.reason) for e in stopped] == [("sandbox", reason)]
    assert stopped[0].elapsed >= 0.0
    datum.stop()


def test_a_run_that_ended_otherwise_publishes_no_interrupted_event() -> None:
    stopped: list[SandboxRunInterruptedEvent] = []
    datum, _, sandbox = make(DEFINITION_ON, listeners=[listener(SandboxRunInterruptedEvent, stopped.append)])
    datum.start()
    sandbox.public_error = SandboxError(SandboxFailure.THREW, "threw")
    with pytest.raises(SandboxError):
        datum.definition_service.read("contact")
    assert stopped == []
    datum.stop()


def test_the_first_middleware_is_outermost_and_datums_observation_innermost() -> None:
    order: list[str] = []

    def named(label: str) -> Any:
        def wrap(inner: Sandbox) -> Sandbox:
            class Layer:
                def __getattr__(self, name: str) -> Any:
                    def call(*args: Any, **kwargs: Any) -> Any:
                        order.append(f"{label}:{name}")
                        return getattr(inner, name)(*args, **kwargs)

                    return call

            return cast("Sandbox", Layer())

        return wrap

    stopped: list[SandboxRunInterruptedEvent] = []
    datum, _, sandbox = make(
        DEFINITION_ON,
        sandbox_middleware=[named("first"), named("second")],
        listeners=[listener(SandboxRunInterruptedEvent, stopped.append)],
    )
    datum.start()
    order.clear()
    sandbox.public_error = SandboxError(SandboxFailure.BUDGET, "stopped")
    with pytest.raises(SandboxError):
        datum.definition_service.read("contact")
    assert order == ["first:public_copy", "second:public_copy"]
    assert len(stopped) == 1  # the observation sits inside both and still saw the stop
    datum.stop()


# ---- health, info, services --------------------------------------------------------------------------------------
def test_the_store_components_report_the_memory_stores_details() -> None:
    datum, _, _ = make()
    components = datum.health().components
    assert components["stores.snapshots"].details == {"store": "memory", "entries": 0, "maxEntries": 500}
    assert components["stores.translations"].details["store"] == "memory"


def test_the_configured_sizes_reach_the_stores_and_the_services() -> None:
    sections = {
        "forms": {
            "snapshots": {"max_entries": 7, "public_copy_cache_size": 3},
            "data_sources": {"timeout": 2.5, "max_threads": 4},
        }
    }
    datum, _, _ = make(sections)
    store = datum.snapshot_store
    assert isinstance(store, MemoryDefinitionSnapshotStore)
    assert store.max_entries == 7
    datum.start()
    assert datum.data_source_service.timeout == 2.5
    assert datum.data_source_service._max_threads == 4  # the pool size has no public reader
    assert datum.definition_service._cache.capacity == 3  # the cache bound has no public reader
    datum.stop()


def test_the_services_exist_only_while_started() -> None:
    datum, _, _ = make()
    with pytest.raises(DatumNotStartedError):
        _ = datum.definition_service
    datum.start()
    assert isinstance(datum.definition_service.read("nope"), NotFound)
    datum.stop()
    with pytest.raises(DatumNotStartedError):
        _ = datum.translation_service


def test_stop_closes_the_data_source_pool_and_leaves_no_thread() -> None:
    before = {t.ident for t in threading.enumerate()}
    datum, _, _ = make(data_sources=[Cities()])
    datum.start()
    assert datum.data_source_service.items(DataSourceRequest("cities")).__class__.__name__ == "Items"
    datum.stop()
    deadline = time.monotonic() + 3.0
    while {t.ident for t in threading.enumerate()} - before and time.monotonic() < deadline:
        time.sleep(0.01)
    assert {t.ident for t in threading.enumerate()} <= before


def test_a_stopped_datum_starts_again() -> None:
    ready: list[DatumRuntimeReadyEvent] = []
    datum, runtime, _ = make(listeners=[listener(DatumRuntimeReadyEvent, ready.append)])
    datum.start()
    datum.stop()
    assert datum.health().components["runtime"].details["reason"] == "stopped"
    datum.start()
    assert datum.ready
    assert len(ready) == 2
    datum.stop()
    assert runtime.closed == 2


def test_info_before_the_start_names_no_engine() -> None:
    datum, _, _ = make()
    info = datum.info()
    assert info["engine"] is None
    assert info["engineNotes"] == []
    forms = cast("dict[str, object]", cast("dict[str, object]", info["capabilities"])["forms"])
    assert forms["snapshots"] == "memory"


def test_info_names_no_host_path_in_the_engine_notes() -> None:
    datum, runtime, _ = make()
    runtime.engine_info = lambda: EngineInfo(  # type: ignore[method-assign]
        id="stub", release="1.0", mode="test", notes=("guest qjs-wasi.wasm (/srv/hidden/qjs-wasi.wasm)",)
    )
    datum.start()
    try:
        notes = cast("list[str]", datum.info()["engineNotes"])
    finally:
        datum.stop()
    assert notes == ["guest qjs-wasi.wasm (<path>)"]


def test_a_replacement_sandbox_without_a_runtime_is_described_by_its_class() -> None:
    sandbox = StubSandbox()
    datum = Datum(sandbox=cast("Sandbox", sandbox), form_repository=Repository())
    datum.start()
    assert datum.info()["engine"] == "StubSandbox"
    assert datum.info()["engineMode"] == "unknown"
    assert datum.runtime is None
    datum.stop()


# ---- the translation store bound (datum.forms.translations.max_entries) ---------------------------------------
def test_the_memory_translation_store_takes_its_bound_from_the_settings() -> None:
    datum, _, _ = make({"forms": {"translations": {"max_entries": 3}}})
    assert datum.translation_store.max_entries == 3  # type: ignore[attr-defined]
    default, _, _ = make()
    assert default.translation_store.max_entries == 1000  # type: ignore[attr-defined]


def test_an_application_translation_store_is_kept_whatever_the_bound_says() -> None:
    mine = MemoryTranslationCatalogStore(7)
    datum, _, _ = make({"forms": {"translations": {"max_entries": 3}}}, translation_store=mine)
    assert datum.translation_store is mine


# ---- the guest's location reaches the engine (datum.runtime.qjs_path and qjs_sha256) -------------------------------
class RecordingProvider:
    id = "recording"

    def __init__(self) -> None:
        self.limits: list[EngineLimits] = []

    def availability(self) -> Available:
        return Available()

    def create(self, limits: EngineLimits, engine_settings: EngineSettings, /) -> GuestRuntime:
        self.limits.append(limits)
        raise RuntimeError("recorded; the engine is not built here")


def with_provider(monkeypatch: pytest.MonkeyPatch, provider: RecordingProvider) -> None:
    found = [DiscoveredRuntime("recording", "recording-dist", provider=provider, availability=Available())]
    monkeypatch.setattr(GuestRuntimes, "discover", classmethod(lambda cls: cls(found)))


def test_the_selected_engine_is_built_from_limits_that_carry_the_configured_guest(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    provider = RecordingProvider()
    with_provider(monkeypatch, provider)
    digest = "cd" * 32
    config = DatumConfig.model_validate(
        {
            "runtime": {
                "engine": "recording",
                "fail_fast": False,
                "qjs_path": str(tmp_path / "q.wasm"),
                "qjs_sha256": digest,
            }
        }
    )
    datum = Datum(config=config, form_repository=Repository())
    datum.start()
    assert [(item.module_path, item.module_sha256) for item in provider.limits] == [(tmp_path / "q.wasm", digest)]
    datum.stop()


def test_a_digest_without_a_path_stops_the_start_naming_both_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    with_provider(monkeypatch, RecordingProvider())
    config = DatumConfig.model_validate(
        {"runtime": {"engine": "recording", "fail_fast": False, "qjs_sha256": "cd" * 32}}
    )
    datum = Datum(config=config, form_repository=Repository())
    with pytest.raises(DatumConfigurationError, match=r"qjs_sha256.*qjs_path"):
        datum.start()
