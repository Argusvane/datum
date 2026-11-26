"""`datum.E002` (the builder on over a per-process store with more than one worker), `datum.W004` for the
writable memory repository, and the health component `stores.forms`.

The builder's saves are only visible on the worker that took them while the definition repository, the snapshot store
and the translation store are in memory, so a second worker is an ERROR; one worker is a WARN.
"""

import json
import logging
from typing import Any, cast

import pytest
from builder_support import (
    CheckSandbox,
    TrailRepository,
    TrailSnapshots,
    TrailTranslations,
    definition,
    plain_builder_datum,
    started_builder,
)

from datum_core import Datum
from datum_core.checks import E002, W004
from datum_core.health import ComponentHealth
from datum_core.loggers import CHECKS
from datum_core.stores import catalog_etag
from datum_core.stores.memory import (
    MemoryDefinitionSnapshotStore,
    MemoryFormDefinitionRepository,
    MemoryTranslationCatalogStore,
)
from datum_sandbox.checks import CheckLevel, DatumConfigurationError

TWO_WORKERS = {"workers_expected": 2}
STORES = {
    "repository": "stores.forms",
    "snapshots": "stores.snapshots",
    "translations": "stores.translations",
}


def custom_stores() -> dict[str, Any]:
    """Stores that are not the in-memory ones (wrappers the check does not recognise): a shared store stands in."""
    trail: list[str] = []
    return {
        "form_repository": TrailRepository(trail, MemoryFormDefinitionRepository(seed=[definition()])),
        "snapshot_store": TrailSnapshots(trail),
        "translation_store": TrailTranslations(trail),
    }


def memory_stores() -> dict[str, Any]:
    return {
        "form_repository": MemoryFormDefinitionRepository(seed=[definition()]),
        "snapshot_store": MemoryDefinitionSnapshotStore(500),
        "translation_store": MemoryTranslationCatalogStore(1000),
    }


def e002_datum(memory: str, **config: Any) -> Datum:
    """A builder `Datum` whose one in-memory store is `memory` (`repository`, `snapshots` or `translations`)."""
    seams = custom_stores()
    key = {"repository": "form_repository", "snapshots": "snapshot_store", "translations": "translation_store"}[memory]
    seams[key] = memory_stores()[key]
    return plain_builder_datum({**TWO_WORKERS, **config}, **seams)


# -- E002 --------------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("memory", sorted(STORES))
def test_the_builder_over_one_in_memory_store_and_two_workers_is_refused_naming_that_store(memory: str) -> None:
    datum = e002_datum(memory)
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [problem.id for problem in raised.value.problems] == [E002]
    problem = raised.value.problems[0]
    assert problem.level is CheckLevel.ERROR
    assert STORES[memory] in problem.msg
    assert "2 workers" in problem.msg
    assert all(STORES[other] not in problem.msg for other in STORES if other != memory)
    assert "shared" in problem.hint
    assert not datum.started


def test_all_three_in_memory_stores_are_named_in_the_one_refusal() -> None:
    datum = plain_builder_datum(TWO_WORKERS, **memory_stores())
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert [problem.id for problem in raised.value.problems] == [E002]
    message = raised.value.problems[0].msg
    assert all(name in message for name in STORES.values())


def test_the_default_stores_are_in_memory_so_the_builder_with_two_workers_is_refused() -> None:
    datum = plain_builder_datum(TWO_WORKERS)
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert E002 in [problem.id for problem in raised.value.problems]


def test_three_shared_stores_and_two_workers_start() -> None:
    datum = plain_builder_datum(TWO_WORKERS, **custom_stores())
    datum.start()
    try:
        assert datum.started
    finally:
        datum.stop()


def test_one_worker_over_in_memory_stores_starts_with_warnings_and_no_error(caplog: pytest.LogCaptureFixture) -> None:
    datum = plain_builder_datum({"workers_expected": 1}, **memory_stores())
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        ids = {getattr(record, "datum_check_id", None) for record in caplog.records}
        assert W004 in ids
        assert E002 not in ids
    finally:
        datum.stop()


def test_two_workers_without_the_builder_are_not_an_e002() -> None:
    datum = plain_builder_datum({**TWO_WORKERS, "builder": {"enabled": False}}, **memory_stores())
    datum.start()
    datum.stop()


def test_the_refusal_comes_before_the_runtime_is_asked_anything() -> None:
    sandbox = CheckSandbox([])
    datum = plain_builder_datum(TWO_WORKERS, sandbox=sandbox, **memory_stores())
    with pytest.raises(DatumConfigurationError):
        datum.start()
    assert sandbox.checks == []
    assert not datum.started


def test_the_refusal_cannot_be_silenced() -> None:
    with pytest.raises(ValueError, match="only INFO and WARNING"):
        plain_builder_datum({**TWO_WORKERS, "silenced_checks": [E002]}, **memory_stores())


def test_the_worker_count_may_come_from_the_servers_environment(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("WEB_CONCURRENCY", "3")
    datum = plain_builder_datum({}, **memory_stores())
    with pytest.raises(DatumConfigurationError) as raised:
        datum.start()
    assert "3 workers" in raised.value.problems[0].msg


# -- a read-only repository --------------------------------------------------------------------------------------------
def test_a_repository_that_cannot_save_is_not_an_e002_with_one_worker_the_builder_answers_read_only_instead() -> None:
    class Files:
        def current(self, key: str) -> None:
            return None

    seams = {k: v for k, v in custom_stores().items() if k != "form_repository"}
    datum = plain_builder_datum({}, form_repository=Files(), **seams)
    datum.start()
    datum.stop()


# -- W004 for the writable repository ----------------------------------------------------------------------------------
def test_the_memory_repository_states_the_per_process_notice_once_with_the_builder_on(
    caplog: pytest.LogCaptureFixture,
) -> None:
    with (
        caplog.at_level(logging.WARNING, logger=CHECKS),
        started_builder(form_repository=MemoryFormDefinitionRepository(seed=[definition()])),
    ):
        pass
    notices = [r.getMessage() for r in caplog.records if r.getMessage().startswith("(datum.W004)")]
    forms = [text for text in notices if "stores.forms" in text]
    assert len(forms) == 1
    assert "this process's memory" in forms[0]


def test_a_custom_repository_has_no_notice(caplog: pytest.LogCaptureFixture) -> None:
    with caplog.at_level(logging.WARNING, logger=CHECKS), started_builder():
        pass
    assert not [r for r in caplog.records if "stores.forms" in r.getMessage()]


def test_the_notice_can_be_silenced_by_its_id(caplog: pytest.LogCaptureFixture) -> None:
    with (
        caplog.at_level(logging.WARNING, logger=CHECKS),
        started_builder(
            {"silenced_checks": [W004]}, form_repository=MemoryFormDefinitionRepository(seed=[definition()])
        ),
    ):
        pass
    assert not [r for r in caplog.records if getattr(r, "datum_check_id", None) == W004]


def test_the_memory_repository_notice_is_a_warning_with_the_sql_hint() -> None:
    check = MemoryFormDefinitionRepository().check()
    assert (check.level, check.id) == (CheckLevel.WARNING, W004)
    assert "SQL" in check.hint or "store" in check.hint


# -- health ------------------------------------------------------------------------------------------------------------
def test_the_memory_repository_reports_under_stores_forms_with_its_entries_and_bound() -> None:
    repository = MemoryFormDefinitionRepository(seed=[definition()], max_entries=9)
    with started_builder(form_repository=repository) as rig:
        report = rig.datum.health()
        component = report.components["stores.forms"]
        assert component.status == "up"
        assert component.details == {"store": "memory", "entries": 1, "maxEntries": 9}
        assert rig.create(definition("fresh")).__class__.__name__ == "Saved"
        assert rig.datum.health().components["stores.forms"].details["entries"] == 2


def test_a_full_repository_is_visible_in_its_health_details() -> None:
    repository = MemoryFormDefinitionRepository(seed=[definition()], max_entries=1)
    with started_builder(form_repository=repository) as rig:
        details = rig.datum.health().components["stores.forms"].details
    assert details["entries"] == details["maxEntries"] == 1


def test_a_full_translation_store_is_visible_in_its_health_details() -> None:
    store = MemoryTranslationCatalogStore(1)
    assert store.write("other", {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({})) is not None
    with started_builder(translation_store=store) as rig:
        details = rig.datum.health().components["stores.translations"].details
    assert details["entries"] == details["maxEntries"] == 1


def test_a_custom_repository_reports_custom() -> None:
    with started_builder() as rig:
        assert rig.datum.health().components["stores.forms"].details == {"store": "custom"}


def test_the_health_names_stay_flat_one_per_store() -> None:
    with started_builder() as rig:
        names = set(rig.datum.health().components)
    assert {"runtime", "stores.snapshots", "stores.translations", "stores.forms"} <= names
    assert not any(name.startswith("stores.") and name.count(".") > 1 for name in names)


def test_the_forms_component_is_registered_once_a_registry_refuses_a_duplicate() -> None:
    datum = plain_builder_datum()
    with pytest.raises(ValueError, match=r"stores\.forms"):
        datum.health_registry.register("stores.forms", ComponentHealth.up)


def test_info_names_the_builder_capability_and_the_stores_it_runs_over() -> None:
    with started_builder(form_repository=MemoryFormDefinitionRepository(seed=[definition()])) as rig:
        capabilities = rig.datum.info()["capabilities"]
    builder = cast("dict[str, Any]", cast("dict[str, Any]", capabilities)["builder"])
    assert builder["enabled"] is True
    assert builder["repository"] == "memory"
    assert builder["customizers"] == 0
    assert builder["validators"] == 0


def test_info_counts_the_hooks_and_says_custom_for_a_repository_that_is_not_the_memory_one() -> None:
    def customize(draft: Any) -> None:
        return None

    with started_builder(builder_save_customizers=[customize]) as rig:
        capabilities = cast("dict[str, Any]", rig.datum.info()["capabilities"])
    builder = capabilities["builder"]
    assert builder["repository"] == "custom"
    assert builder["customizers"] == 1


def test_info_says_the_builder_is_off_when_it_is() -> None:
    datum = plain_builder_datum({"builder": {"enabled": False}})
    datum.start()
    try:
        capabilities = cast("dict[str, Any]", datum.info()["capabilities"])
        assert capabilities["builder"]["enabled"] is False
    finally:
        datum.stop()


def test_datum_disabled_over_memory_stores_and_two_workers_is_not_an_e002_and_reports_the_builder_off() -> None:
    datum = plain_builder_datum({**TWO_WORKERS, "enabled": False}, **memory_stores())
    datum.start()
    try:
        capabilities = cast("dict[str, Any]", datum.info()["capabilities"])
        assert capabilities["builder"]["enabled"] is False
    finally:
        datum.stop()


def test_a_memory_repository_with_the_builder_off_states_no_w004_and_registers_no_forms_health(
    caplog: pytest.LogCaptureFixture,
) -> None:
    datum = plain_builder_datum(
        {
            "workers_expected": 1,
            "builder": {"enabled": False},
            "web": {"api": {"endpoints": {"definition": True}}},
        },
        form_repository=MemoryFormDefinitionRepository(seed=[definition()]),
    )
    with caplog.at_level(logging.WARNING, logger=CHECKS):
        datum.start()
    try:
        assert not [r for r in caplog.records if "stores.forms" in r.getMessage()]
        assert "stores.forms" not in datum.health().components
    finally:
        datum.stop()


def test_no_given_repository_is_reported_as_files_in_info() -> None:
    datum = plain_builder_datum({"workers_expected": 1})
    datum.start()
    try:
        capabilities = cast("dict[str, Any]", datum.info()["capabilities"])
        assert capabilities["builder"]["repository"] == "files"
        forms = datum.health().components.get("stores.forms")
        assert forms is not None
        assert forms.details["store"] == "files"
    finally:
        datum.stop()


def test_datums_own_file_repository_is_reported_as_files_in_health_and_info(tmp_path: Any) -> None:
    from datum_core.forms import FileFormDefinitionRepository  # noqa: PLC0415

    path = tmp_path / "contact.json"
    path.write_text(json.dumps(definition()), encoding="utf-8")
    with started_builder(form_repository=FileFormDefinitionRepository([str(path)])) as rig:
        assert rig.datum.health().components["stores.forms"].details == {"store": "files"}
        capabilities = cast("dict[str, Any]", rig.datum.info()["capabilities"])
        assert capabilities["builder"]["repository"] == "files"


@pytest.mark.parametrize("kind", ["files", "memory", "custom"])
def test_info_and_health_name_the_repository_that_runs_through_the_one_helper(kind: str, tmp_path: Any) -> None:
    """Both read `Datum.form_repository` (the running one), so a repository seeded into memory reports `memory`."""
    from datum_core.forms import FileFormDefinitionRepository  # noqa: PLC0415

    path = tmp_path / "contact.json"
    path.write_text(json.dumps(definition()), encoding="utf-8")
    make: dict[str, Any] = {
        "files": lambda: FileFormDefinitionRepository([str(path)]),
        "memory": lambda: MemoryFormDefinitionRepository(seed=[definition()]),
        "custom": lambda: TrailRepository([], MemoryFormDefinitionRepository(seed=[definition()])),
    }
    with started_builder(form_repository=make[kind]()) as rig:
        datum = rig.datum
        datum._given_repository = None  # the running repository is the one that is read, not the one given
        assert datum.info()["capabilities"]["builder"]["repository"] == kind  # type: ignore[index]
        details = datum.health().components["stores.forms"].details
        assert details["store"] == kind
