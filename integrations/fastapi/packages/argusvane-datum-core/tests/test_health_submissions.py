"""The health components of a started Datum, flat dotted names, and their detail fields."""

import json
from typing import Any, cast

import pytest
from submissions_support import Repository, StubRuntime, bus, capabilities_of, envelope, plain_datum

from datum_core import Datum
from datum_core.health import ComponentHealth
from datum_core.submissions import FormRef
from datum_sandbox.wasi import EngineInfo, HarnessStats

# The PDF capability is on by default and has a `pdf` component of its own (test_datum_pdf_wiring); these tests are
# about the engine and the stores, over runtimes that are not PDF capable or cannot run a program at all.
SUBMISSIONS_ON = {"web": {"api": {"endpoints": {"submissions": True}}}, "pdf": {"enabled": False}}
FLAT_NAMES = {"runtime", "stores.snapshots", "stores.translations", "stores.throttle", "stores.idempotency"}


class CountingRuntime(StubRuntime):
    """A runtime that reports its slots the way the wasmtime engine does."""

    pools = frozenset({"validation", "pdf"})  # serves both pools, as the wasmtime engine does

    def __init__(self, stats: HarnessStats) -> None:
        self._stats = stats

    def stats(self) -> HarnessStats:
        return self._stats

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="counting", release="9.9", mode="jit", notes=("note one",))


def started_datum(runtime: StubRuntime | None = None, **seams: Any) -> Datum:
    given: dict[str, Any] = {"runtime": runtime} if runtime is not None else {}
    datum = plain_datum(SUBMISSIONS_ON, form_repository=Repository([]), **given, **seams)
    datum.start()
    return datum


def test_the_components_are_flat_dotted_names_with_no_stores_component_and_no_nesting() -> None:
    datum = started_datum()
    try:
        report = datum.health()
    finally:
        datum.stop()
    assert set(report.components) == FLAT_NAMES
    assert "stores" not in report.components
    assert not any("components" in component.details for component in report.components.values())
    assert report.is_up
    assert report.is_ready


def test_the_wire_body_is_status_and_components_each_with_status_and_details() -> None:
    datum = started_datum()
    try:
        body = datum.health().to_json()
    finally:
        datum.stop()
    assert set(body) == {"status", "components"}
    assert body["status"] == "up"
    for component in cast("dict[str, Any]", body["components"]).values():
        assert set(component) == {"status", "details"}
    assert json.dumps(body)  # plain JSON all the way down


def test_the_runtime_component_carries_the_engine_and_the_slot_counters() -> None:
    runtime = CountingRuntime(HarnessStats(slots=4, slots_in_use=1, runs_in_flight=2, stuck_runs=0, stray_runs=3))
    datum = started_datum(runtime)
    try:
        details = datum.health().components["runtime"].details
    finally:
        datum.stop()
    assert details["state"] == "ready"
    assert (details["engine"], details["engineRelease"], details["engineMode"]) == ("counting", "9.9", "jit")
    assert details["pdfCapable"] is True
    assert details["engineNotes"] == ["note one"]
    assert {"sandboxAbi", "pdfAbi"} <= set(details)
    assert (details["slots"], details["slotsInUse"], details["runsInFlight"]) == (4, 1, 2)
    assert (details["stuckRuns"], details["strayRuns"]) == (0, 3)


def test_pdf_unavailable_is_a_runtime_detail_only_when_the_engine_cannot_run_the_pdf_path() -> None:
    incapable = started_datum()  # the stub runtime is not PDF capable
    capable = started_datum(
        CountingRuntime(HarnessStats(slots=1, slots_in_use=0, runs_in_flight=0, stuck_runs=0, stray_runs=0))
    )
    try:
        without = incapable.health().components["runtime"].details
        with_pdf = capable.health().components["runtime"].details
    finally:
        incapable.stop()
        capable.stop()
    assert without["pdfCapable"] is False
    assert "pdfUnavailable" in without
    assert "pdfUnavailable" not in with_pdf


def test_the_runtime_component_before_the_lifespan_is_down_with_lifespan_not_run() -> None:
    datum = plain_datum(SUBMISSIONS_ON)
    component = datum.health().components["runtime"]
    assert component.status == "down"
    assert component.details["reason"] == "lifespan not run"
    assert not datum.health().is_ready


def test_the_stores_say_memory_or_custom_never_sql_without_an_engine() -> None:
    datum = started_datum()
    try:
        components = datum.health().components
    finally:
        datum.stop()
    kinds = {name: components[name].details["store"] for name in FLAT_NAMES - {"runtime"}}
    assert kinds == dict.fromkeys(kinds, "memory")


def test_an_application_store_reads_custom_in_its_own_component_only() -> None:
    class Own:
        def find(self, form_key: str, version: str, submission_key: str) -> None:
            return None

        def record(self, form_key: str, version: str, submission_key: str, remembered: Any) -> Any:
            return remembered

    datum = started_datum(idempotency_store=Own())
    try:
        components = datum.health().components
    finally:
        datum.stop()
    assert components["stores.idempotency"].details["store"] == "custom"
    assert components["stores.throttle"].details["store"] == "memory"


def test_the_throttle_and_idempotency_details_show_entries_and_bounds() -> None:
    datum = started_datum()
    try:
        datum.submission_service.submit(FormRef.from_document(), envelope(), bus())
        components = datum.health().components
    finally:
        datum.stop()
    assert components["stores.idempotency"].details["entries"] == 1
    assert components["stores.idempotency"].details["maxEntries"] == 10_000
    assert components["stores.throttle"].details["maxKeys"] == 10_000
    assert components["stores.throttle"].details["evictions"] == 0
    assert components["stores.throttle"].details["perProcess"] is True


@pytest.mark.parametrize("name", ["stores.throttle", "stores.idempotency"])
def test_a_component_name_registered_twice_is_a_value_error(name: str) -> None:
    datum = started_datum()
    try:
        with pytest.raises(ValueError, match="duplicate"):
            datum.health_registry.register(name, ComponentHealth.up)
    finally:
        datum.stop()


def test_the_info_capabilities_name_the_throttle_and_the_idempotency_kinds() -> None:
    datum = started_datum()
    try:
        capabilities = capabilities_of(datum)
    finally:
        datum.stop()
    assert capabilities["throttle"] == "memory"
    assert capabilities["idempotency"] == "memory"
    assert capabilities["forms"]["snapshots"] == "memory"


def test_the_health_body_holds_no_key_no_digest_and_no_address() -> None:
    datum = started_datum()
    try:
        datum.submission_service.submit(FormRef.from_document(), envelope(), bus())
        text = json.dumps(datum.health().to_json())
    finally:
        datum.stop()
    assert "Ada" not in text
    assert "203.0.113" not in text
