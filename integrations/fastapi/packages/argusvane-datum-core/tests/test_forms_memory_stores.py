"""The memory stores: the W004 warning, the health details, the bounds."""

import pytest
from forms_support import definition, stored_hash

from datum_core.checks import W004
from datum_core.stores import StoreFullError
from datum_core.stores.memory import MemoryDefinitionSnapshotStore, MemoryTranslationCatalogStore
from datum_sandbox.checks import CheckLevel


def test_the_snapshot_store_states_the_w004_warning_naming_its_health_component() -> None:
    check = MemoryDefinitionSnapshotStore().check()
    assert (check.level, check.id) == (CheckLevel.WARNING, W004)
    assert "stores.snapshots" in check.msg
    assert "process" in check.msg
    assert check.hint


def test_the_translation_store_states_the_w004_warning_naming_its_health_component() -> None:
    check = MemoryTranslationCatalogStore().check()
    assert (check.level, check.id) == (CheckLevel.WARNING, W004)
    assert "stores.translations" in check.msg
    assert check.hint


def test_the_health_details_say_memory_the_entries_held_and_the_bound() -> None:
    snapshots = MemoryDefinitionSnapshotStore(max_entries=3)
    assert snapshots.details() == {"store": "memory", "entries": 0, "maxEntries": 3}
    form = definition("contact", secret=False)
    snapshots.record("contact", stored_hash(form), form)
    assert snapshots.details()["entries"] == 1
    translations = MemoryTranslationCatalogStore(max_entries=5)
    translations.put("contact", {"en": {"form": {"a": "b"}}})
    assert translations.details() == {"store": "memory", "entries": 1, "maxEntries": 5}


def test_the_health_names_are_the_ones_the_policy_documents() -> None:
    assert MemoryDefinitionSnapshotStore.health_name == "stores.snapshots"
    assert MemoryTranslationCatalogStore.health_name == "stores.translations"


def test_a_snapshot_found_is_a_copy_so_changing_it_changes_nothing_stored() -> None:
    store = MemoryDefinitionSnapshotStore()
    form = definition("contact", secret=False)
    store.record("contact", stored_hash(form), form)
    found = store.find("contact", stored_hash(form))
    assert found is not None
    found["id"] = "changed"
    again = store.find("contact", stored_hash(form))
    assert again is not None
    assert again["id"] == "contact"


def test_a_snapshot_read_keeps_that_entry_among_the_newest() -> None:
    store = MemoryDefinitionSnapshotStore(max_entries=2)
    first, second, third = (definition("contact", str(n), secret=False) for n in range(3))
    store.record("contact", stored_hash(first), first)
    store.record("contact", stored_hash(second), second)
    assert store.find("contact", stored_hash(first)) is not None
    store.record("contact", stored_hash(third), third)
    assert store.find("contact", stored_hash(first)) is not None
    assert store.find("contact", stored_hash(second)) is None


@pytest.mark.parametrize("make", [MemoryDefinitionSnapshotStore, MemoryTranslationCatalogStore])
def test_a_bound_below_one_is_refused(
    make: type[MemoryDefinitionSnapshotStore | MemoryTranslationCatalogStore],
) -> None:
    with pytest.raises(ValueError, match="at least one"):
        make(0)


def test_a_full_translation_store_refuses_a_new_form_and_still_replaces_a_held_one() -> None:
    store = MemoryTranslationCatalogStore(max_entries=1)
    store.put("one", {"en": {"form": {"a": "1"}}})
    with pytest.raises(StoreFullError):
        store.put("two", {"en": {"form": {"a": "2"}}})
    replaced = store.put("one", {"en": {"form": {"a": "3"}}})
    assert store.read("one") == replaced
    assert store.read("two") is None


def test_a_catalog_read_is_a_copy() -> None:
    store = MemoryTranslationCatalogStore()
    store.put("one", {"en": {"form": {"a": "1"}}})
    read = store.read("one")
    assert read is not None
    read.catalog["en"]["form"]["a"] = "changed"
    again = store.read("one")
    assert again is not None
    assert again.catalog == {"en": {"form": {"a": "1"}}}
