"""Params > form / version > customizers > the kernel's public copy > the answer."""

import json
import logging
from typing import Any, assert_never

import pytest
from forms_support import (
    SECRET_MARKER,
    LogCustomizer,
    LogSandbox,
    definition,
    etag_of,
    has_secret_rule,
    stored_hash,
)

from datum_core.forms import (
    CustomizerIdentityError,
    DefinitionDraft,
    DefinitionRequest,
    DefinitionService,
    NotFound,
    Served,
    StoredDefinition,
    TooDeep,
    Unavailable,
)
from datum_core.hooks import HookRefusedError
from datum_core.stores.memory import MemoryDefinitionSnapshotStore
from datum_sandbox.protocol import DefinitionTooDeepError, ProgramUnavailableError

FORMS_LOGGER = "datum.forms"


class LogRepository:
    """A repository over a dictionary that logs into the stage log."""

    def __init__(self, log: list[str], *forms: dict[str, Any]) -> None:
        self.log = log
        self.forms = {form["id"]: form for form in forms}

    def current(self, key: str) -> StoredDefinition | None:
        self.log.append("repository.current")
        form = self.forms.get(key)
        return None if form is None else StoredDefinition(key=key, definition=form, sha256=stored_hash(form))


class LogSnapshots(MemoryDefinitionSnapshotStore):
    def __init__(self, log: list[str]) -> None:
        super().__init__(max_entries=10)
        self.log = log

    def find(self, key: str, sha256: str) -> dict[str, Any] | None:
        self.log.append("snapshots.find")
        return super().find(key, sha256)


def build(
    *customizers: LogCustomizer,
    secret: bool = True,
    down: Exception | None = None,
) -> tuple[DefinitionService, list[str], LogSandbox, LogSnapshots, dict[str, Any]]:
    log: list[str] = []
    form = definition("contact", "1", secret=secret)
    sandbox = LogSandbox(log, down=down)
    snapshots = LogSnapshots(log)
    service = DefinitionService(
        repository=LogRepository(log, form),
        snapshots=snapshots,
        sandbox=sandbox.provider,
        customizers=customizers,
    )
    return service, log, sandbox, snapshots, form


def served(outcome: object) -> Served:
    assert isinstance(outcome, Served), outcome
    return outcome


def test_the_public_copy_runs_the_stages_in_customizer_order() -> None:
    first, second = LogCustomizer("A", []), LogCustomizer("B", [])
    service, log, *_ = build(first, second)
    first.log, second.log = log, log
    served(service.read("contact"))
    assert log == ["repository.current", "customizer:A", "customizer:B", "sandbox.public_copy"]


def test_a_version_asked_by_hash_comes_from_the_snapshot_store_not_the_repository() -> None:
    customizer = LogCustomizer("A", [])
    service, log, _sandbox, snapshots, form = build(customizer)
    customizer.log = log
    snapshots.record("contact", stored_hash(form), form)
    log.clear()
    outcome = served(service.read("contact", sha256=stored_hash(form)))
    assert log == ["snapshots.find", "customizer:A", "sandbox.public_copy"]
    assert outcome.definition["id"] == "contact"


def test_a_hash_the_snapshot_store_does_not_hold_is_not_found() -> None:
    service, log, *_ = build()
    assert isinstance(service.read("contact", sha256="0" * 64), NotFound)
    assert log == ["snapshots.find", "repository.current"]  # the current version is asked second


def test_a_snapshot_miss_for_the_hash_of_the_current_version_serves_and_records_it() -> None:
    customizer = LogCustomizer("A", [])
    service, log, _sandbox, snapshots, form = build(customizer)
    customizer.log = log
    outcome = served(service.read("contact", sha256=stored_hash(form)))
    assert log == ["snapshots.find", "repository.current", "customizer:A", "sandbox.public_copy"]
    assert outcome.definition["id"] == "contact"
    assert snapshots.find("contact", stored_hash(form)) == form
    log.clear()
    served(service.read("contact", sha256=stored_hash(form)))
    assert log == ["snapshots.find", "customizer:A", "sandbox.public_copy"]  # recorded: the second read is a hit


def test_a_snapshot_miss_for_any_other_hash_stays_not_found_and_records_nothing() -> None:
    service, _log, _sandbox, snapshots, form = build()
    assert isinstance(service.read("contact", sha256="1" * 64), NotFound)
    assert snapshots.find("contact", stored_hash(form)) is None


def test_the_author_copy_by_hash_also_falls_back_to_the_current_version() -> None:
    service, _log, _sandbox, _snapshots, form = build()
    outcome = served(service.read("contact", public=False, sha256=stored_hash(form)))
    assert json.loads(outcome.body)["id"] == "contact"


def test_a_form_that_does_not_exist_is_not_found_and_no_customizer_or_sandbox_runs() -> None:
    customizer = LogCustomizer("A", [])
    service, log, *_ = build(customizer)
    customizer.log = log
    assert isinstance(service.read("missing"), NotFound)
    assert log == ["repository.current"]


@pytest.mark.parametrize("key", ["../etc", "a b", "", "x" * 129])
def test_a_key_that_is_no_form_key_is_not_found_without_asking_the_repository(key: str) -> None:
    service, log, *_ = build()
    assert isinstance(service.read(key), NotFound)
    assert log == []


def test_the_catalog_key_id_at_version_serves_the_current_version_and_another_version_is_not_found() -> None:
    service, *_ = build()
    assert served(service.read("contact@1")).definition["id"] == "contact"
    assert served(service.read("contact")).definition["id"] == "contact"
    assert isinstance(service.read("contact@2"), NotFound)
    assert isinstance(service.read("contact@"), NotFound)
    assert isinstance(service.read("contact@1@2"), NotFound)
    assert isinstance(service.read("other@1"), NotFound)


def test_the_catalog_key_applies_to_the_authors_copy_too() -> None:
    service, *_ = build()
    assert served(service.read("contact@1", public=False)).definition["id"] == "contact"
    assert isinstance(service.read("contact@2", public=False), NotFound)


def test_a_customizer_sees_what_the_one_before_left_and_a_copy_of_the_stored_definition() -> None:
    def add_city_label(draft: DefinitionDraft) -> None:
        draft.definition["root"]["children"]["content"][1]["configuration"]["label"] = "Town"

    def read_label(draft: DefinitionDraft) -> None:
        second.seen_label = draft.definition["root"]["children"]["content"][1]["configuration"]["label"]  # type: ignore[attr-defined]

    first = LogCustomizer("A", [], change=add_city_label)
    second = LogCustomizer("B", [], change=read_label)
    service, _log, _sandbox, _snapshots, form = build(first, second)
    outcome = served(service.read("contact"))
    assert second.seen_label == "Town"  # type: ignore[attr-defined]
    assert outcome.definition["root"]["children"]["content"][1]["configuration"]["label"] == "Town"
    assert form["root"]["children"]["content"][1]["configuration"]["label"] == "City"  # the stored one is untouched


def test_a_customizer_is_told_who_asks_and_which_version() -> None:
    customizer = LogCustomizer("A", [])
    service, _log, _sandbox, _snapshots, form = build(customizer)
    served(service.read("contact", principal="ana", locale="fr-CA"))
    request, _definition = customizer.seen[0]
    assert isinstance(request, DefinitionRequest)
    assert request.form_key == "contact"
    assert request.sha256 == stored_hash(form)
    assert request.current is True
    assert request.principal == "ana"
    assert request.locale == "fr-CA"


def test_the_first_refusal_stops_the_rest_and_nothing_reaches_the_kernel() -> None:
    refusing = LogCustomizer("A", [], refuse=HookRefusedError.forbidden("no.way", "Not for you."))
    later = LogCustomizer("B", [])
    service, log, *_ = build(refusing, later)
    refusing.log, later.log = log, log
    with pytest.raises(HookRefusedError) as raised:
        service.read("contact")
    assert raised.value.problems[0].code == "no.way"
    assert log == ["repository.current", "customizer:A"]


@pytest.mark.parametrize("field", ["id", "version"])
def test_a_customizer_that_changes_the_id_or_the_version_is_an_error_not_a_served_page(field: str) -> None:
    def change(draft: DefinitionDraft) -> None:
        draft.definition[field] = "other"

    service, _log, sandbox, *_ = build(LogCustomizer("A", [], change=change))
    with pytest.raises(CustomizerIdentityError):
        service.read("contact")
    assert sandbox.inputs == []


def test_a_customizer_that_raises_propagates_its_error_for_the_route_to_make_a_500() -> None:
    def change(draft: DefinitionDraft) -> None:
        raise RuntimeError("boom")

    service, *_ = build(LogCustomizer("A", [], change=change))
    with pytest.raises(RuntimeError, match="boom"):
        service.read("contact")


def test_the_authors_copy_is_never_customized_and_never_asks_the_kernel() -> None:
    def add_extra(draft: DefinitionDraft) -> None:
        draft.definition.update(extra=1)

    customizer = LogCustomizer("A", [], change=add_extra)
    service, log, sandbox, _snapshots, form = build(customizer)
    customizer.log = log
    outcome = served(service.read("contact", public=False))
    assert log == ["repository.current"]
    assert sandbox.inputs == []
    assert outcome.definition == form
    assert has_secret_rule(outcome.definition)  # the author sees the rule
    assert outcome.etag == f'"{stored_hash(form)}"'  # the ETag the builder's If-Match names


def test_the_public_copy_never_carries_a_server_secret_rule_whoever_added_it() -> None:
    def add_secret(draft: DefinitionDraft) -> None:
        draft.definition["root"]["children"]["content"][1]["rules"] = {
            "visibleWhen": {"run": "server-secret", "formula": f'city = "{SECRET_MARKER}2"'}
        }

    service, _log, sandbox, *_ = build(LogCustomizer("A", [], change=add_secret))
    outcome = served(service.read("contact"))
    assert not has_secret_rule(outcome.definition)
    assert SECRET_MARKER not in outcome.body.decode()
    assert "server-secret" not in outcome.body.decode()
    assert has_secret_rule(sandbox.inputs[0])  # the kernel saw the customized definition and took the rules out


def test_the_etag_is_the_quoted_sha256_of_the_bytes_served() -> None:
    service, *_ = build()
    outcome = served(service.read("contact"))
    assert outcome.etag == etag_of(outcome.body)
    assert len(outcome.etag) == 66
    assert json.loads(outcome.body) == outcome.definition


def test_a_form_with_secret_rules_while_the_runtime_is_down_is_unavailable() -> None:
    service, *_ = build(down=ProgramUnavailableError("runtime down"))
    assert isinstance(service.read("contact"), Unavailable)


def test_a_form_with_no_secret_rules_is_served_without_the_runtime() -> None:
    service, _log, sandbox, *_ = build(secret=False, down=ProgramUnavailableError("runtime down"))
    outcome = served(service.read("contact"))
    assert outcome.definition["id"] == "contact"
    assert sandbox.inputs == []


def test_a_definition_nested_past_the_depth_limit_is_too_deep() -> None:
    service, *_ = build(down=DefinitionTooDeepError(256, "too deep"))
    assert isinstance(service.read("contact"), TooDeep)


def test_the_outcomes_are_exhaustive() -> None:
    service, *_ = build()
    outcome = service.read("contact")
    match outcome:
        case Served():
            pass
        case NotFound() | Unavailable() | TooDeep():
            pytest.fail("a served form")
        case _:
            assert_never(outcome)


# ---- the public-copy cache -----------------------------------------------------------------------------------------
def test_with_no_customizer_the_public_copy_is_cached_by_the_stored_hash() -> None:
    service, _log, sandbox, *_ = build()
    first = served(service.read("contact"))
    second = served(service.read("contact"))
    assert len(sandbox.inputs) == 1
    assert first.body == second.body


def test_a_customizer_with_a_cache_key_runs_every_time_but_the_kernel_runs_once() -> None:
    customizer = LogCustomizer("A", [], key="static")
    service, _log, sandbox, *_ = build(customizer)
    served(service.read("contact"))
    served(service.read("contact"))
    assert len(customizer.seen) == 2
    assert len(sandbox.inputs) == 1


def test_a_customizer_that_answers_no_cache_key_is_never_cached() -> None:
    customizer = LogCustomizer("A", [], key=None)
    service, _log, sandbox, *_ = build(customizer)
    served(service.read("contact"))
    served(service.read("contact"))
    assert len(sandbox.inputs) == 2


def test_a_cache_key_that_names_too_little_serves_a_fresh_copy_with_a_warning_never_another_requests(
    caplog: pytest.LogCaptureFixture,
) -> None:
    def label_for_principal(draft: DefinitionDraft) -> None:
        draft.definition["root"]["children"]["content"][1]["configuration"]["label"] = f"for {draft.request.principal}"

    customizer = LogCustomizer("A", [], change=label_for_principal, key="same-for-everyone")
    service, _log, sandbox, *_ = build(customizer)
    with caplog.at_level(logging.WARNING, logger=FORMS_LOGGER):
        ana = served(service.read("contact", principal="ana"))
        ben = served(service.read("contact", principal="ben"))
    assert b"for ana" in ana.body
    assert b"for ben" in ben.body
    assert b"for ana" not in ben.body
    assert len(sandbox.inputs) == 2
    assert [r for r in caplog.records if r.name == FORMS_LOGGER and r.levelno == logging.WARNING]


def test_a_changed_stored_definition_is_a_new_hash_and_a_new_public_copy() -> None:
    service, _log, sandbox, *_ = build()
    served(service.read("contact"))
    repository: Any = service.repository
    changed = definition("contact", "1")
    changed["root"]["children"]["content"][1]["configuration"]["label"] = "Town"
    repository.forms["contact"] = changed
    served(service.read("contact"))
    assert len(sandbox.inputs) == 2


# ---- the snapshot store --------------------------------------------------------------------------------------------
def test_the_memory_snapshot_store_is_bounded_and_drops_the_oldest() -> None:
    store = MemoryDefinitionSnapshotStore(max_entries=2)
    for index in range(3):
        form = definition("contact", str(index), secret=False)
        store.record("contact", stored_hash(form), form)
    assert store.find("contact", stored_hash(definition("contact", "0", secret=False))) is None
    assert store.find("contact", stored_hash(definition("contact", "2", secret=False))) is not None


def test_recording_a_snapshot_twice_is_one_entry() -> None:
    store = MemoryDefinitionSnapshotStore(max_entries=2)
    form = definition("contact", "1", secret=False)
    store.record("contact", stored_hash(form), form)
    store.record("contact", stored_hash(form), form)
    other = definition("contact", "2", secret=False)
    store.record("contact", stored_hash(other), other)
    assert store.find("contact", stored_hash(form)) is not None
