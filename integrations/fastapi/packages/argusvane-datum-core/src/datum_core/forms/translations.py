"""`TranslationService`: the translations read: no customizer, the ETag is the store's own.

The builder writes the catalog back with `If-Match` against that ETag (a later phase adds the write half).
"""

from datum_core.canonical import canonical_bytes
from datum_core.forms.keys import parse_form_key, version_matches
from datum_core.forms.outcomes import NotFound, TranslationsOutcome, TranslationsServed
from datum_core.forms.protocols import FormDefinitionRepository, TranslationCatalogStore
from datum_core.stores import catalog_etag

__all__ = ["TranslationService"]


class TranslationService:
    """Read the translation catalog of a form that exists; a form with no catalog yet has the empty one."""

    def __init__(self, *, repository: FormDefinitionRepository, store: TranslationCatalogStore) -> None:
        """Keep the repository (does the form exist) and the catalog store."""
        self.repository = repository
        self.store = store

    def read(self, key: str) -> TranslationsOutcome:
        """Return the catalog and its ETag, or NotFound for a key that is no form of the repository."""
        parsed = parse_form_key(key)
        if parsed is None:
            return NotFound()
        form_id, version = parsed
        current = self.repository.current(form_id)
        if current is None:
            return NotFound()
        if not version_matches(current.definition, version):
            return NotFound()
        stored = self.store.read(form_id)
        if stored is None:
            return TranslationsServed({}, canonical_bytes({}), catalog_etag({}))
        return TranslationsServed(stored.catalog, canonical_bytes(stored.catalog), stored.etag)
