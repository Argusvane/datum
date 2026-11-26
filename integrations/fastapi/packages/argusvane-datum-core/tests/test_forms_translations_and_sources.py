"""The translations read carries the store's own ETag; data sources are asked in order."""

import hashlib

import pytest

from datum_core.canonical import canonical_bytes
from datum_core.forms import (
    DataSourceNotFound,
    DataSourceRequest,
    DataSourceService,
    DataSourceUnavailable,
    Items,
    StoredCatalog,
)
from datum_core.stores.memory import MemoryTranslationCatalogStore

CATALOG = {"fr": {"components": {"name": {"label": "Nom"}}}, "en": {"components": {"name": {"label": "Name"}}}}


def test_the_memory_translation_store_reads_what_was_put_with_a_strong_etag_of_the_canonical_catalog() -> None:
    store = MemoryTranslationCatalogStore()
    assert store.read("contact") is None
    put = store.put("contact", CATALOG)
    assert isinstance(put, StoredCatalog)
    read = store.read("contact")
    assert read == put
    assert read is not None
    assert read.catalog == CATALOG
    assert read.etag == '"' + hashlib.sha256(canonical_bytes(CATALOG)).hexdigest() + '"'


def test_the_etag_changes_with_the_catalog_and_not_with_key_order() -> None:
    store = MemoryTranslationCatalogStore()
    first = store.put("contact", {"fr": {"form": {"a": "1"}}, "en": {"form": {"a": "2"}}})
    same = store.put("contact", {"en": {"form": {"a": "2"}}, "fr": {"form": {"a": "1"}}})
    changed = store.put("contact", {"en": {"form": {"a": "3"}}})
    assert first.etag == same.etag
    assert changed.etag != first.etag


class Provider:
    def __init__(self, ids: dict[str, list[dict[str, str]]], *, fails: bool = False) -> None:
        self.ids = ids
        self.fails = fails
        self.asked: list[str] = []

    def exists(self, source_id: str) -> bool:
        self.asked.append(f"exists:{source_id}")
        return source_id in self.ids

    def items(self, request: DataSourceRequest) -> list[dict[str, str]]:
        self.asked.append(f"items:{request.source_id}")
        if self.fails:
            raise RuntimeError("down")
        return self.ids[request.source_id]


def test_the_first_provider_whose_exists_answers_true_serves_the_items() -> None:
    first = Provider({"a": [{"value": "1"}]})
    second = Provider({"b": [{"value": "2"}]})
    service = DataSourceService([first, second])
    match service.items(DataSourceRequest("b")):
        case Items(items=items):
            assert items == [{"value": "2"}]
        case other:
            pytest.fail(str(other))
    assert first.asked == ["exists:b"]
    assert second.asked == ["exists:b", "items:b"]


def test_an_id_no_provider_knows_is_not_found_and_no_provider_means_not_found() -> None:
    assert isinstance(DataSourceService([Provider({"a": []})]).items(DataSourceRequest("zz")), DataSourceNotFound)
    assert isinstance(DataSourceService([]).items(DataSourceRequest("a")), DataSourceNotFound)


def test_a_provider_that_raises_makes_the_source_unavailable() -> None:
    assert isinstance(
        DataSourceService([Provider({"a": []}, fails=True)]).items(DataSourceRequest("a")), DataSourceUnavailable
    )
