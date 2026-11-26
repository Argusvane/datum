"""The forms seams: repository, snapshot and translation stores, data-source provider, customizer.

Protocols are structural and never `runtime_checkable` (a check of names is not a check of signatures). The write
halves are compare-and-set: a refusal is `None`, and the loser of a race reads the winner's hash or ETag with the read
the store already has. `StoredDefinition` lives in `datum_core.stores` (beside `StoredCatalog`) and is re-exported here.
"""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from types import MappingProxyType
from typing import Any, Protocol

from datum_core.hooks import MaybeAwaitable
from datum_core.stores import CatalogView, StoredCatalog, StoredDefinition
from datum_sandbox.json import JsonValue

__all__ = [
    "DataSourceProvider",
    "DataSourceRequest",
    "DefinitionCustomizer",
    "DefinitionDraft",
    "DefinitionRequest",
    "DefinitionSnapshotStore",
    "FormDefinitionRepository",
    "SnapshotNotRecordedError",
    "StoredDefinition",
    "TranslationCatalogStore",
    "WritableFormDefinitionRepository",
]


class FormDefinitionRepository(Protocol):
    """Where form definitions come from."""

    def current(self, key: str) -> StoredDefinition | None:
        """Return the current version of the form with this id, or None."""
        ...


class WritableFormDefinitionRepository(FormDefinitionRepository, Protocol):
    """A repository the builder can write: `create` a form, compare-and-set `replace` it.

    A refusal is `None`, never an exception: the key is taken, the stored hash is not the one the caller read, or the
    form to replace does not exist. A full store raises `datum_core.stores.StoreFullError` from `create`.
    The definition is copied in and the stored version copied out.
    """

    def create(self, key: str, definition: Mapping[str, JsonValue]) -> StoredDefinition | None:
        """Store a form nobody has created and return it, or None when the key is taken (one winner of any race)."""
        ...

    def replace(
        self, key: str, definition: Mapping[str, JsonValue], expected_sha256: str | None
    ) -> StoredDefinition | None:
        """Swap the form's definition and return the new version, or None.

        None means the form does not exist or `expected_sha256` is not exactly its stored hash (None expects any hash:
        an as-sent replace of a form that exists). It never creates a form.
        """
        ...


class SnapshotNotRecordedError(Exception):
    """A snapshot store could not record a version (the table is gone, the disk is full); the builder alone catches it.

    The save has already happened when a snapshot is recorded, so the builder logs this and goes on.
    """


class DefinitionSnapshotStore(Protocol):
    """Older versions by hash, so a version a browser holds can still be asked for."""

    def record(self, key: str, sha256: str, definition: Mapping[str, JsonValue]) -> None:
        """Remember the definition under its key and hash; recording a held one changes nothing."""
        ...

    def find(self, key: str, sha256: str) -> dict[str, JsonValue] | None:
        """Return the definition recorded under the key and hash, or None."""
        ...


class TranslationCatalogStore(Protocol):
    """Translation catalogs by form key, each with the store's own strong ETag."""

    def read(self, key: str) -> StoredCatalog | None:
        """Return the form's catalog, or None."""
        ...

    def write(self, key: str, catalog: CatalogView, *, expected_etag: str) -> StoredCatalog | None:
        """Store the catalog and return it with its ETag, or None when `expected_etag` is not the stored one.

        A form with no catalog reads as `{}`: its first write expects the ETag of `{}` (`catalog_etag({})`). A full
        store raises `datum_core.stores.StoreFullError` for a form it does not hold.
        """
        ...


@dataclass(frozen=True, slots=True)
class DataSourceRequest:
    """What a provider is asked for: the source id, the form it is read for, the locale and the request's query.

    `form_key` is the form the browser is filling (`None` when the route was not given one); `query` holds the
    query parameters the route passed on, read-only. A provider decides what to do with them; Datum interprets none.
    """

    source_id: str
    form_key: str | None = None
    locale: str = "en"
    query: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))


class DataSourceProvider(Protocol):
    """Items for a data-sourced choice. Inherit it to get the default `exists`, which answers for every id.

    A provider that keeps the default hides every provider after it and raises `datum.W006`; implement `exists`.
    Either method may be `async`; it then runs through the awaiter.
    """

    def items(self, request: DataSourceRequest) -> MaybeAwaitable[Sequence[Mapping[str, JsonValue]]]:
        """Return the items of the source `request.source_id`, for the form, locale and query it carries."""
        ...

    def exists(self, source_id: str) -> MaybeAwaitable[bool]:  # noqa: ARG002 - the default answers every id
        """Say whether this provider serves the id (the default says yes to every id)."""
        return True


@dataclass(frozen=True, slots=True)
class DefinitionRequest:
    """What a customizer is told: the form, the stored version's hash, current or by hash, who asks, in which locale."""

    form_key: str
    sha256: str
    current: bool
    principal: object | None
    locale: str


@dataclass(slots=True)
class DefinitionDraft:
    """The request and a copy of the stored definition for a customizer to change in place (JSON, keys as stored)."""

    request: DefinitionRequest
    definition: dict[str, Any]


class DefinitionCustomizer(Protocol):
    """Changes the public copy of a definition before the kernel takes the server-secret rules out.

    Raise `HookRefusedError` to refuse; never change `id` or `version`. `cache_key` names everything the customizer
    reads from the request that changes its output, or answers None to opt out of caching.
    """

    def __call__(self, draft: DefinitionDraft) -> MaybeAwaitable[None]:
        """Change `draft.definition` in place, or refuse."""
        ...

    def cache_key(self, request: DefinitionRequest) -> str | None:
        """Return a string naming this request's effect on the output, or None to never cache."""
        ...
