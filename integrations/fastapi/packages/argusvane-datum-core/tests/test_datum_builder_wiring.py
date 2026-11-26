"""`Datum` and the builder seams: the keywords, the service it builds and when it exists.

`builder_service` exists while Datum is started; the service is built from the repository, the definition service, the
translation and snapshot stores, the sandbox, the component types of the UI assets manifest, the definition cap, the
hooks, the events and the awaiter.
"""

import importlib.resources
import inspect
import json
import threading
from pathlib import Path
from typing import Any, cast, get_type_hints

import pytest
from builder_support import FORM, definition, plain_builder_datum, started_builder

from datum_core import Datum, DatumNotStartedError
from datum_core.builder import BuilderService, NotFound, ReadOnly, Saved
from datum_core.canonical import canonical_digest
from datum_core.datum import DatumOptions
from datum_core.events import FormDefinitionSavedEvent, listener
from datum_core.forms import Served, TranslationsServed
from datum_core.stores import catalog_etag
from datum_core.stores.memory import MemoryFormDefinitionRepository
from datum_sandbox.checks import DatumConfigurationError

KEYWORDS = ["builder_save_customizers", "builder_save_validators"]


def manifest_types() -> list[str]:
    text = importlib.resources.files("datum_assets_ui").joinpath("manifest.json").read_text(encoding="utf-8")
    types = json.loads(text)["knownComponentTypes"]
    assert isinstance(types, list)
    return [str(item) for item in types]


# -- the keywords ------------------------------------------------------------------------------------------------------
@pytest.mark.parametrize("keyword", KEYWORDS)
def test_each_hook_is_a_keyword_only_seam_a_binding_can_pass_on(keyword: str) -> None:
    parameter = inspect.signature(Datum).parameters[keyword]
    assert parameter.kind is inspect.Parameter.KEYWORD_ONLY
    assert keyword in get_type_hints(DatumOptions)


@pytest.mark.parametrize("keyword", KEYWORDS)
def test_a_hook_sequence_defaults_to_nothing_and_keeps_the_list_order(keyword: str) -> None:
    first, second = (lambda *a: None), (lambda *a: None)
    assert getattr(plain_builder_datum(**cast("dict[str, Any]", {keyword: [first, second]})), keyword) == (
        first,
        second,
    )
    assert getattr(plain_builder_datum(), keyword) == ()


def test_the_form_repository_keyword_takes_a_writable_repository() -> None:
    repository = MemoryFormDefinitionRepository(seed=[definition()])
    with started_builder(form_repository=repository) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        stored = repository.current(FORM)
        assert stored is not None
        assert stored.definition["version"] == "2"


# -- the service exists while started ----------------------------------------------------------------------------------
def test_the_builder_service_exists_only_while_datum_is_started() -> None:
    datum = plain_builder_datum()
    with pytest.raises(DatumNotStartedError):
        datum.builder_service  # noqa: B018 - the property raising is the point
    datum.start()
    try:
        assert isinstance(datum.builder_service, BuilderService)
        assert datum.builder_service is datum.builder_service
    finally:
        datum.stop()
    with pytest.raises(DatumNotStartedError):
        datum.builder_service  # noqa: B018


def test_the_service_exists_with_the_builder_switch_off_for_a_caller_that_is_not_a_route() -> None:
    datum = plain_builder_datum({"builder": {"enabled": False}})
    datum.start()
    try:
        assert isinstance(datum.builder_service, BuilderService)
    finally:
        datum.stop()


def test_each_start_builds_its_own_service() -> None:
    datum = plain_builder_datum()
    datum.start()
    first = datum.builder_service
    datum.stop()
    datum.start()
    try:
        assert datum.builder_service is not first
    finally:
        datum.stop()


# -- what it is built from ---------------------------------------------------------------------------------------------
def test_the_kernel_is_asked_with_the_component_types_of_the_ui_assets_manifest_sorted() -> None:
    with started_builder() as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        (asked,) = rig.sandbox.checks
    assert manifest_types()
    assert asked[1] == sorted(manifest_types())
    assert asked[2] == ()


def test_the_definition_cap_is_the_builders_setting() -> None:
    with started_builder({"builder": {"max_definition_size": "2KiB"}}) as rig:
        assert rig.service.max_definition_bytes == 2048
    with started_builder() as rig:
        assert rig.service.max_definition_bytes == 1024 * 1024


def test_the_service_publishes_through_the_listeners_the_datum_was_given() -> None:
    seen: list[FormDefinitionSavedEvent] = []
    with started_builder(listeners=[listener(FormDefinitionSavedEvent, seen.append)]) as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
    assert [(e.key, e.sha256) for e in seen] == [(FORM, outcome.sha256)]


def test_the_service_reads_the_clock_the_datum_was_given() -> None:
    with started_builder() as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        assert outcome.saved_at == rig.datum.now()


def test_the_service_saves_through_the_snapshot_and_translation_stores_the_datum_was_given() -> None:
    with started_builder() as rig:
        first = rig.current_hash()
        assert isinstance(rig.save(definition(version="2")), Saved)
        assert rig.snapshots.find(FORM, first) is not None
        assert "snapshots.record" in rig.trail


def test_the_definition_service_and_the_builder_share_the_repository() -> None:
    with started_builder() as rig:
        outcome = rig.save(definition(version="2"))
        assert isinstance(outcome, Saved)
        served = rig.datum.definition_service.read(FORM, public=False)
        assert isinstance(served, Served)
        assert served.etag == '"' + outcome.sha256 + '"'


def test_the_translation_service_sees_the_catalog_the_builder_wrote() -> None:
    with started_builder() as rig:
        rig.service.save_translations(
            FORM, {"fr": {"form": {"title": "un"}}}, expected_etag=catalog_etag({}), principal=None
        )
        read = rig.datum.translation_service.read(FORM)
        assert isinstance(read, TranslationsServed)
        assert read.catalog == {"fr": {"form": {"title": "un"}}}


# -- a repository that cannot save -------------------------------------------------------------------------------------
def write_form(directory: Path) -> Path:
    path = directory / "contact.json"
    path.write_text(json.dumps(definition()), encoding="utf-8")
    return path


def test_the_default_file_repository_is_read_only_so_every_builder_write_answers_read_only(tmp_path: Path) -> None:
    path = write_form(tmp_path)
    datum = plain_builder_datum({"forms": {"locations": [str(path)]}})
    datum.start()
    try:
        service = datum.builder_service
        saved = service.save(
            FORM, definition(version="2"), expected_sha256=canonical_digest(definition()), principal=None
        )
        created = service.create(definition("fresh"), principal=None)
        missing = service.save("nope", definition("nope"), expected_sha256=None, principal=None)
    finally:
        datum.stop()
    assert isinstance(saved, ReadOnly)
    assert isinstance(created, ReadOnly)
    assert missing == NotFound("nope")


def test_the_application_builds_the_memory_repository_from_the_files_by_seeding_it(tmp_path: Path) -> None:
    path = write_form(tmp_path)
    seed = [json.loads(path.read_text(encoding="utf-8"))]
    with started_builder(seed=seed) as rig:
        assert isinstance(rig.save(definition(version="2")), Saved)
        assert rig.stored().definition["version"] == "2"


def test_the_options_typed_dict_lists_the_two_hook_keywords_as_sequences() -> None:
    hints: dict[str, Any] = get_type_hints(DatumOptions)
    for keyword in KEYWORDS:
        assert "Sequence" in str(hints[keyword])


# -- the UI manifest is read for the builder, not for every start ------------------------------------------------------
def _no_ui_distribution() -> list[str]:
    raise DatumConfigurationError("the component types cannot be read from datum_assets_ui/manifest.json")


def test_with_the_ui_distribution_missing_and_the_builder_off_the_start_succeeds_and_the_builder_service_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("datum_core.datum.known_component_types", _no_ui_distribution)
    datum = plain_builder_datum({"builder": {"enabled": False}})
    datum.start()
    try:
        assert datum.started
        assert datum.definition_service is not None
        assert datum.submission_service is not None
        with pytest.raises(DatumConfigurationError):
            datum.builder_service  # noqa: B018 - the property raising is the point
    finally:
        datum.stop()


def test_with_the_ui_distribution_missing_and_the_builder_on_the_start_raises_and_is_not_started(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr("datum_core.datum.known_component_types", _no_ui_distribution)
    datum = plain_builder_datum()
    with pytest.raises(DatumConfigurationError):
        datum.start()
    assert not datum.started


# -- the scoped dispatcher: a save still running at the stop publishes nothing -----------------------------------------
def test_a_save_still_running_when_datum_stops_publishes_no_saved_event() -> None:
    entered, release = threading.Event(), threading.Event()
    seen: list[FormDefinitionSavedEvent] = []

    def hold(candidate: object) -> None:
        entered.set()
        release.wait(10)

    outcomes: list[object] = []
    with started_builder(
        builder_save_validators=[hold], listeners=[listener(FormDefinitionSavedEvent, seen.append)]
    ) as rig:
        service = rig.service
        thread = threading.Thread(
            target=lambda: outcomes.append(
                service.save(FORM, definition(version="2"), expected_sha256=None, principal=None)
            )
        )
        thread.start()
        assert entered.wait(10)
        rig.datum.stop()
        release.set()
        thread.join(10)
    assert seen == []
    assert [type(o).__name__ for o in outcomes] == ["Unavailable"]
    assert rig.stored().definition["version"] == "1"


@pytest.mark.parametrize("keyword", KEYWORDS)
@pytest.mark.parametrize("typo", [{print: 1}, (n for n in [print])], ids=["dict", "generator"])
def test_a_hook_sequence_is_a_sequence_not_a_dict_or_a_bare_iterable(keyword: str, typo: object) -> None:
    with pytest.raises(TypeError):
        plain_builder_datum(**cast("dict[str, Any]", {keyword: typo}))
