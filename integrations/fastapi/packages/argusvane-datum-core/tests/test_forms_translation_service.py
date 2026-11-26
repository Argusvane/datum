"""The translations read: the form must exist, the ETag is the store's, no customizer."""

from typing import Any

import pytest
from forms_support import definition, stored_hash

from datum_core.canonical import canonical_bytes
from datum_core.forms import NotFound, StoredDefinition, TranslationService, TranslationsServed
from datum_core.stores import catalog_etag
from datum_core.stores.memory import MemoryTranslationCatalogStore

CATALOG = {"fr": {"components": {"name": {"label": "Nom"}}}, "en": {"components": {"name": {"label": "Name"}}}}


class Repository:
    def __init__(self, *forms: dict[str, Any]) -> None:
        self.forms = {form["id"]: form for form in forms}

    def current(self, key: str) -> StoredDefinition | None:
        form = self.forms.get(key)
        return None if form is None else StoredDefinition(key, form, stored_hash(form))


def build() -> tuple[TranslationService, MemoryTranslationCatalogStore]:
    store = MemoryTranslationCatalogStore()
    return TranslationService(repository=Repository(definition("contact", "1")), store=store), store


def test_the_catalog_of_an_existing_form_is_served_with_the_stores_etag() -> None:
    service, store = build()
    put = store.put("contact", CATALOG)
    outcome = service.read("contact")
    assert isinstance(outcome, TranslationsServed)
    assert outcome.catalog == CATALOG
    assert outcome.etag == put.etag
    assert outcome.body == canonical_bytes(CATALOG)


def test_a_form_with_no_catalog_yet_has_the_empty_one() -> None:
    service, _store = build()
    outcome = service.read("contact")
    assert isinstance(outcome, TranslationsServed)
    assert outcome.catalog == {}
    assert outcome.etag == catalog_etag({})


@pytest.mark.parametrize("key", ["missing", "a b", "", "contact@2", "contact@", "x" * 129])
def test_a_key_that_is_no_form_or_names_another_version_is_not_found(key: str) -> None:
    service, store = build()
    store.put("missing", CATALOG)  # a catalog without a form is never served
    assert isinstance(service.read(key), NotFound)


def test_the_catalog_key_with_the_current_version_is_served() -> None:
    service, store = build()
    store.put("contact", CATALOG)
    assert isinstance(service.read("contact@1"), TranslationsServed)
