"""The secrecy lens of the definition service: the public copy never carries a server-secret rule, whoever added it."""

import logging
from typing import Any

import pytest
from forms_support import LogCustomizer, LogSandbox, definition, has_secret_rule, stored_hash

from datum_core.forms import (
    CustomizerIdentityError,
    DefinitionDraft,
    DefinitionService,
    NotFound,
    Served,
    StoredDefinition,
    TooDeep,
    carries_server_secret_rule,
)
from datum_core.forms.translations import TranslationService
from datum_core.hooks import HookRefusedError
from datum_core.stores.memory import MemoryDefinitionSnapshotStore, MemoryTranslationCatalogStore
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError


class Repository:
    def __init__(self, *forms: dict[str, Any]) -> None:
        self.forms = {form["id"]: form for form in forms}
        self.reads = 0

    def current(self, key: str) -> StoredDefinition | None:
        self.reads += 1
        form = self.forms.get(key)
        return None if form is None else StoredDefinition(key, form, stored_hash(form))


class LogSnapshotStore(MemoryDefinitionSnapshotStore):
    def __init__(self, log: list[str]) -> None:
        super().__init__(max_entries=10)
        self.log = log

    def find(self, key: str, sha256: str) -> dict[str, Any] | None:
        self.log.append("snapshots.find")
        return super().find(key, sha256)


class LeakySandbox(LogSandbox):
    """A kernel that returns the definition unchanged: the service must not serve it."""

    def public_copy(self, definition: Any) -> dict[str, JsonValue]:
        self.log.append("sandbox.public_copy")
        return dict(definition)


def service_for(form: dict[str, Any], sandbox: LogSandbox, *customizers: LogCustomizer) -> DefinitionService:
    return DefinitionService(
        repository=Repository(form),
        snapshots=MemoryDefinitionSnapshotStore(),
        sandbox=sandbox.provider,
        customizers=customizers,
    )


def test_a_kernel_copy_that_still_carries_a_secret_rule_is_never_served() -> None:
    sandbox = LeakySandbox([])
    service = service_for(definition("contact", secret=True), sandbox)
    with pytest.raises(RuntimeError, match="server-secret"):
        service.read("contact")


def test_the_secret_gate_calls_the_kernel_for_a_secret_in_any_string_and_not_for_none() -> None:
    assert carries_server_secret_rule({"a": [{"b": "server-secret"}]})
    assert carries_server_secret_rule({"run": " Server-Secret "})
    assert not carries_server_secret_rule(definition("contact", secret=False))
    assert not carries_server_secret_rule({"run": "client"})


def test_a_very_deep_definition_is_walked_without_recursion() -> None:
    node: Any = "server-secret"
    for _ in range(50_000):
        node = [node]
    assert carries_server_secret_rule(node)


def test_a_customizer_that_replaces_the_definition_with_a_non_object_is_an_identity_error() -> None:
    def replace(draft: DefinitionDraft) -> None:
        draft.definition = ["not", "an", "object"]  # type: ignore[assignment]

    sandbox = LogSandbox([])
    service = service_for(definition("contact"), sandbox, LogCustomizer("A", [], change=replace))
    with pytest.raises(CustomizerIdentityError):
        service.read("contact")
    assert sandbox.inputs == []


def test_an_identity_change_is_caught_after_the_customizer_that_made_it_not_only_at_the_end() -> None:
    def rename(draft: DefinitionDraft) -> None:
        draft.definition["id"] = "other"

    def restore(draft: DefinitionDraft) -> None:
        draft.definition["id"] = "contact"

    first = LogCustomizer("A", [], change=rename)
    second = LogCustomizer("B", [], change=restore)
    service = service_for(definition("contact"), LogSandbox([]), first, second)
    with pytest.raises(CustomizerIdentityError):
        service.read("contact")
    assert second.seen == []


def test_the_author_copy_never_reaches_a_customizer_even_when_asked_by_hash() -> None:
    form = definition("contact")
    customizer = LogCustomizer("A", [])
    service = service_for(form, LogSandbox([]), customizer)
    served(service.read("contact"))  # records the snapshot
    customizer.seen.clear()
    outcome = served(service.read("contact", public=False, sha256=stored_hash(form)))
    assert customizer.seen == []
    assert has_secret_rule(outcome.definition)


def test_a_bad_hash_is_not_found_without_asking_the_store() -> None:
    log: list[str] = []
    service = DefinitionService(
        repository=Repository(definition("contact")),
        snapshots=LogSnapshotStore(log),
        sandbox=LogSandbox([]).provider,
    )
    for bad in ("", "abc", "G" * 64, "A" * 64, "0" * 63, "0" * 65):
        assert isinstance(service.read("contact", sha256=bad), NotFound)
    assert log == []


def test_a_version_asked_by_hash_is_checked_against_that_versions_definition() -> None:
    form = definition("contact", "1", secret=False)
    service = service_for(form, LogSandbox([]))
    served(service.read("contact"))  # records version 1 under its hash
    assert served(service.read("contact@1", sha256=stored_hash(form))).definition["version"] == "1"
    assert isinstance(service.read("contact@2", sha256=stored_hash(form)), NotFound)


def test_reading_the_current_version_records_it_so_it_can_be_asked_for_by_hash() -> None:
    form = definition("contact", "1", secret=False)
    service = service_for(form, LogSandbox([]))
    assert isinstance(service.read("contact", sha256="1" * 64), NotFound)
    served(service.read("contact"))
    served(service.read("contact", sha256=stored_hash(form)))


def test_the_current_hash_is_served_on_a_snapshot_miss_and_recorded_for_the_next_read() -> None:
    # A browser holding the current hash is never answered 404 after a restart.
    form = definition("contact", "1", secret=False)
    service = service_for(form, LogSandbox([]))
    served(service.read("contact", sha256=stored_hash(form)))
    assert service.snapshots.find("contact", stored_hash(form)) == form


def test_an_integer_version_in_a_file_matches_its_spelling_in_the_key() -> None:
    form = definition("contact", secret=False)
    form["version"] = 3
    service = service_for(form, LogSandbox([]))
    served(service.read("contact@3"))
    assert isinstance(service.read("contact@3.0"), NotFound)
    form["version"] = True
    assert isinstance(service.read("contact@True"), NotFound)


def test_a_refusal_from_the_second_customizer_stops_the_kernel() -> None:
    sandbox = LogSandbox([])
    refusing = LogCustomizer("B", [], refuse=HookRefusedError.conflict("busy", "Try later."))
    service = service_for(definition("contact"), sandbox, LogCustomizer("A", []), refusing)
    with pytest.raises(HookRefusedError):
        service.read("contact")
    assert sandbox.inputs == []


def test_a_customizer_may_be_async_when_an_awaiter_runs_it() -> None:
    class AsyncCustomizer:
        async def __call__(self, draft: DefinitionDraft) -> None:
            draft.definition["extra"] = 1

        def cache_key(self, request: Any) -> str | None:
            return None

    seen: list[object] = []

    def awaiter(awaitable: Any) -> Any:
        seen.append(awaitable)
        try:
            awaitable.send(None)
        except StopIteration as stop:
            return stop.value

    form = definition("contact", secret=False)
    service = DefinitionService(
        repository=Repository(form),
        snapshots=MemoryDefinitionSnapshotStore(),
        sandbox=LogSandbox([]).provider,
        customizers=[AsyncCustomizer()],
        awaiter=awaiter,
    )
    assert served(service.read("contact")).definition["extra"] == 1
    assert seen


def test_an_async_customizer_with_no_awaiter_is_a_configuration_error() -> None:
    class AsyncCustomizer:
        async def __call__(self, draft: DefinitionDraft) -> None:
            return None

        def cache_key(self, request: Any) -> str | None:
            return None

    service = DefinitionService(
        repository=Repository(definition("contact")),
        snapshots=MemoryDefinitionSnapshotStore(),
        sandbox=LogSandbox([]).provider,
        customizers=[AsyncCustomizer()],
    )
    with pytest.raises(DatumConfigurationError):
        service.read("contact")


def test_a_plain_function_customizer_with_no_cache_key_is_never_cached() -> None:
    calls: list[int] = []

    def plain(draft: DefinitionDraft) -> None:
        calls.append(1)

    sandbox = LogSandbox([])
    service = DefinitionService(
        repository=Repository(definition("contact")),
        snapshots=MemoryDefinitionSnapshotStore(),
        sandbox=sandbox.provider,
        customizers=[plain],  # type: ignore[list-item]
    )
    served(service.read("contact"))
    served(service.read("contact"))
    assert len(sandbox.inputs) == 2


def test_a_cache_key_that_is_right_caches_per_key_and_serves_each_its_own_copy() -> None:
    def label_for_principal(draft: DefinitionDraft) -> None:
        draft.definition["root"]["children"]["content"][1]["configuration"]["label"] = f"for {draft.request.principal}"

    customizer = LogCustomizer("A", [], change=label_for_principal, key=lambda request: f"p:{request.principal}")
    sandbox = LogSandbox([])
    service = service_for(definition("contact"), sandbox, customizer)
    ana1 = served(service.read("contact", principal="ana"))
    ben = served(service.read("contact", principal="ben"))
    ana2 = served(service.read("contact", principal="ana"))
    assert b"for ana" in ana1.body
    assert b"for ben" in ben.body
    assert ana1 == ana2
    assert len(sandbox.inputs) == 2


def test_the_too_little_warning_is_given_once_per_slot(caplog: pytest.LogCaptureFixture) -> None:
    def label_for_principal(draft: DefinitionDraft) -> None:
        draft.definition["root"]["children"]["content"][1]["configuration"]["label"] = f"for {draft.request.principal}"

    service = service_for(
        definition("contact"), LogSandbox([]), LogCustomizer("A", [], change=label_for_principal, key="same")
    )
    with caplog.at_level(logging.WARNING, logger="datum.forms"):
        for who in ("ana", "ben", "cy", "di"):
            served(service.read("contact", principal=who))
    assert len([r for r in caplog.records if r.name == "datum.forms"]) == 1


def test_a_served_definition_is_parsed_afresh_so_no_caller_changes_the_cached_copy() -> None:
    service = service_for(definition("contact", secret=False), LogSandbox([]))
    first = served(service.read("contact"))
    first.definition["id"] = "changed"
    assert served(service.read("contact")).definition["id"] == "contact"


def test_the_runtime_lookup_is_deferred_until_a_form_has_a_secret_rule() -> None:
    log: list[str] = []
    service = service_for(definition("contact", secret=False), LogSandbox(log, down=ProgramUnavailableError("down")))
    served(service.read("contact"))
    assert "sandbox.lookup" not in log


def served(outcome: object) -> Served:
    assert isinstance(outcome, Served), outcome
    return outcome


def nested(depth: int) -> dict[str, Any]:
    form = definition("contact", secret=False)
    node: dict[str, Any] = form["root"]
    for index in range(depth):
        child: dict[str, Any] = {"id": f"g{index}", "type": "group", "children": {"content": []}}
        node["children"]["content"].append(child)
        node = child
    return form


def test_a_too_deep_definition_with_no_secret_rule_is_too_deep_without_the_runtime() -> None:
    sandbox = LogSandbox([])
    service = service_for(nested(33), sandbox)
    assert isinstance(service.read("contact"), TooDeep)
    assert sandbox.inputs == []


def test_a_customizer_that_nests_the_draft_past_the_limit_is_too_deep() -> None:
    def deepen(draft: DefinitionDraft) -> None:
        draft.definition["root"] = nested(40)["root"]

    sandbox = LogSandbox([])
    service = service_for(definition("contact", secret=False), sandbox, LogCustomizer("A", [], change=deepen))
    assert isinstance(service.read("contact"), TooDeep)
    assert sandbox.inputs == []


@pytest.mark.parametrize(
    ("field", "before", "after"),
    [("version", 1, True), ("version", 1, 1.0), ("version", "__absent__", None), ("id", "contact", 1)],
)
def test_an_identity_change_of_json_type_or_presence_is_an_identity_error(field: str, before: Any, after: Any) -> None:
    form = definition("contact", secret=False)
    if before == "__absent__":
        del form[field]
    else:
        form[field] = before

    def change(draft: DefinitionDraft) -> None:
        draft.definition[field] = after

    sandbox = LogSandbox([])
    service = service_for(form, sandbox, LogCustomizer("A", [], change=change))
    with pytest.raises(CustomizerIdentityError):
        service.read("contact")
    assert sandbox.inputs == []


def test_a_versionless_or_boolean_version_form_has_no_catalog_key_with_a_version_in_both_services() -> None:
    form = definition("contact", secret=False)
    del form["version"]
    translations = TranslationService(repository=Repository(form), store=MemoryTranslationCatalogStore())
    assert isinstance(service_for(form, LogSandbox([])).read("contact@None"), NotFound)
    assert isinstance(translations.read("contact@None"), NotFound)
    form["version"] = True
    translations = TranslationService(repository=Repository(form), store=MemoryTranslationCatalogStore())
    assert isinstance(service_for(form, LogSandbox([])).read("contact@True"), NotFound)
    assert isinstance(translations.read("contact@True"), NotFound)


def test_with_no_customizer_the_cache_slot_is_by_hash_so_a_changed_form_runs_the_kernel_once_and_never_warns(
    caplog: pytest.LogCaptureFixture,
) -> None:
    repository = Repository(definition("contact", "1"))
    sandbox = LogSandbox([])
    service = DefinitionService(
        repository=repository, snapshots=MemoryDefinitionSnapshotStore(), sandbox=sandbox.provider
    )
    with caplog.at_level(logging.WARNING, logger="datum.forms"):
        served(service.read("contact"))
        repository.forms["contact"] = definition("contact", "2")
        served(service.read("contact"))
        served(service.read("contact"))
    assert len(sandbox.inputs) == 2
    assert [r for r in caplog.records if r.name == "datum.forms"] == []
