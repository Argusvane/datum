"""The forms write side of the memory stores: the three contracts bound to the memory stores, then
what only a bounded memory store owes (its bound, its W004 notice, its health details, copies in and out).

"""

import hashlib

import pytest

from datum_core.canonical import canonical_digest
from datum_core.checks import W004
from datum_core.forms import (
    DefinitionSnapshotStore,
    FileFormDefinitionRepository,
    SnapshotNotRecordedError,
    TranslationCatalogStore,
    WritableFormDefinitionRepository,
)
from datum_core.stores import StoreFullError, catalog_etag
from datum_core.stores.memory import (
    MemoryDefinitionSnapshotStore,
    MemoryFormDefinitionRepository,
    MemoryTranslationCatalogStore,
)
from datum_core.testing.forms_contract import (
    FormRepositoryContract,
    SnapshotStoreContract,
    TranslationStoreContract,
    form,
)
from datum_sandbox.checks import CheckLevel

BOUND = 5


class TestMemoryRepositoryKeepsTheContract(FormRepositoryContract):
    bound = BOUND

    @pytest.fixture
    def store(self) -> WritableFormDefinitionRepository:
        return MemoryFormDefinitionRepository()

    @pytest.fixture
    def bounded_store(self) -> WritableFormDefinitionRepository:
        return MemoryFormDefinitionRepository(max_entries=BOUND)


class TestMemorySnapshotStoreKeepsTheContract(SnapshotStoreContract):
    bound = BOUND

    @pytest.fixture
    def store(self) -> DefinitionSnapshotStore:
        return MemoryDefinitionSnapshotStore(500)

    @pytest.fixture
    def bounded_store(self) -> DefinitionSnapshotStore:
        return MemoryDefinitionSnapshotStore(BOUND)


class TestMemoryTranslationStoreKeepsTheContract(TranslationStoreContract):
    bound = BOUND

    @pytest.fixture
    def store(self) -> TranslationCatalogStore:
        return MemoryTranslationCatalogStore(1000)

    @pytest.fixture
    def bounded_store(self) -> TranslationCatalogStore:
        return MemoryTranslationCatalogStore(BOUND)


# -- the memory form repository ----------------------------------------------------------------------------------------
def test_the_health_name_is_the_flat_dotted_one() -> None:
    assert MemoryFormDefinitionRepository().health_name == "stores.forms"


def test_a_repository_is_seeded_with_the_definitions_it_is_given_keyed_by_their_ids() -> None:
    seeded = MemoryFormDefinitionRepository(seed=[form("contact", "1"), form("claims", "3")])
    contact, claims = seeded.current("contact"), seeded.current("claims")
    assert contact is not None
    assert claims is not None
    assert (contact.key, contact.sha256) == ("contact", canonical_digest(form("contact", "1")))
    assert dict(claims.definition) == form("claims", "3")
    assert seeded.current("other") is None


def test_the_seed_is_copied_so_a_caller_cannot_change_a_seeded_form() -> None:
    given = form("contact")
    seeded = MemoryFormDefinitionRepository(seed=[given])
    given["version"] = "tampered"
    found = seeded.current("contact")
    assert found is not None
    assert dict(found.definition) == form("contact")


def test_a_seed_that_repeats_an_id_or_overflows_the_bound_is_refused_at_construction() -> None:
    with pytest.raises(ValueError, match="contact"):
        MemoryFormDefinitionRepository(seed=[form("contact"), form("contact", "2")])
    with pytest.raises(ValueError, match="2"):
        MemoryFormDefinitionRepository(seed=[form("a"), form("b"), form("c")], max_entries=2)


def test_a_seed_member_without_a_form_key_for_an_id_is_refused_at_construction() -> None:
    with pytest.raises(ValueError, match="id"):
        MemoryFormDefinitionRepository(seed=[{"version": "1"}])
    with pytest.raises(ValueError, match="id"):
        MemoryFormDefinitionRepository(seed=[form("not a key")])
    with pytest.raises(ValueError, match="id"):
        MemoryFormDefinitionRepository(seed=[form("contact@2")])


def test_a_bound_below_one_is_refused() -> None:
    with pytest.raises(ValueError, match="at least"):
        MemoryFormDefinitionRepository(max_entries=0)


def test_the_check_is_the_per_process_notice_naming_the_store() -> None:
    check = MemoryFormDefinitionRepository().check()
    assert (check.level, check.id) == (CheckLevel.WARNING, W004)
    assert "stores.forms" in check.msg


def test_the_details_state_the_kind_the_entries_held_and_the_bound() -> None:
    repository = MemoryFormDefinitionRepository(seed=[form("a")], max_entries=7)
    assert repository.details() == {"store": "memory", "entries": 1, "maxEntries": 7}
    assert repository.create("b", form("b")) is not None
    assert repository.details()["entries"] == 2


def test_a_full_repository_says_so_in_its_own_words_without_a_definition_in_them() -> None:
    repository = MemoryFormDefinitionRepository(seed=[form("a")], max_entries=1)
    with pytest.raises(StoreFullError) as raised:
        repository.create("b", form("b", label="ZZSECRETZZ"))
    assert "ZZSECRETZZ" not in str(raised.value)
    assert repository.details()["entries"] == 1


def test_the_bound_counts_forms_not_versions() -> None:
    repository = MemoryFormDefinitionRepository(max_entries=1)
    first = repository.create("a", form("a", "1"))
    assert first is not None
    sha = first.sha256
    for number in range(2, 30):
        stored = repository.replace("a", form("a", str(number)), sha)
        assert stored is not None
        sha = stored.sha256
    assert repository.details()["entries"] == 1


def test_the_memory_repository_is_writable_and_the_file_repository_is_not() -> None:
    assert hasattr(MemoryFormDefinitionRepository(), "create")
    assert hasattr(MemoryFormDefinitionRepository(), "replace")
    files = FileFormDefinitionRepository(())
    assert not hasattr(files, "create")
    assert not hasattr(files, "replace")


# -- the memory translation store --------------------------------------------------------------------------------------
def test_a_full_translation_store_names_its_bound_and_none_of_the_text() -> None:
    store = MemoryTranslationCatalogStore(1)
    assert store.write("a", {"en": {"form": {"title": "hello"}}}, expected_etag=catalog_etag({})) is not None
    with pytest.raises(StoreFullError) as raised:
        store.write("b", {"en": {"form": {"title": "ZZSECRETZZ"}}}, expected_etag=catalog_etag({}))
    assert "ZZSECRETZZ" not in str(raised.value)
    assert store.details()["entries"] == 1


def test_a_refused_write_to_a_full_store_does_not_hide_a_stale_etag_of_a_held_form() -> None:
    store = MemoryTranslationCatalogStore(1)
    assert store.write("a", {"en": {"form": {"title": "hello"}}}, expected_etag=catalog_etag({})) is not None
    assert (
        store.write("a", {"en": {"form": {"title": "again"}}}, expected_etag=catalog_etag({})) is None
    )  # held form: stale, not full


def test_the_etag_of_an_empty_catalog_is_the_canonical_hash_of_an_empty_object_and_is_quoted() -> None:
    assert catalog_etag({}).startswith('"')
    assert catalog_etag({}).endswith('"')
    assert len(catalog_etag({})) == 66
    assert catalog_etag({}) == '"' + hashlib.sha256(b"{}").hexdigest() + '"'


# -- the snapshot store's own failure ----------------------------------------------------------------------------------
def test_the_snapshot_failure_is_an_exception_a_store_raises_and_the_builder_alone_catches() -> None:
    assert issubclass(SnapshotNotRecordedError, Exception)
    assert not issubclass(SnapshotNotRecordedError, (KeyError, ValueError, OSError))
    assert str(SnapshotNotRecordedError("the table is gone"))
