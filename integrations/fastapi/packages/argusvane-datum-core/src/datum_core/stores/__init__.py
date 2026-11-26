"""Store records shared by the forms capability and its stores; the in-memory stores live in `stores.memory`."""

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass

from datum_core.canonical import canonical_bytes
from datum_sandbox.json import JsonValue

__all__ = [
    "Catalog",
    "CatalogTree",
    "CatalogView",
    "StoreFullError",
    "StoredCatalog",
    "StoredDefinition",
    "catalog_etag",
]

type CatalogTree = dict[str, str | CatalogTree]
"""A branch of a catalog: property segments down to string leaves (a host holds no fingerprints)."""
type Catalog = dict[str, dict[str, CatalogTree]]
"""A translation catalog: locale, then kind (`form` holds a tree, the others an owner id to a tree), then segments."""
type CatalogViewNode = Mapping[str, str | CatalogViewNode]
type CatalogView = Mapping[str, Mapping[str, CatalogViewNode]]
"""A catalog a callee only reads (a `Catalog` is one)."""


class StoreFullError(RuntimeError):
    """A bounded store holds `max_entries` forms and was asked for another; nothing is dropped silently."""


@dataclass(frozen=True, slots=True)
class StoredCatalog:
    """A translation catalog and the strong ETag the store names it by (quoted sha256).

    The catalog has the shape: locale, then kind, then owner, then a tree of property segments with
    string leaves.
    """

    catalog: Catalog
    etag: str


@dataclass(frozen=True, slots=True)
class StoredDefinition:
    """The current version of a form as a repository holds it: key, the definition and its canonical sha256 (hex).

    A repository may hand out a copy or its own object; callers never change the definition either way (the services
    copy before they customize).
    """

    key: str
    definition: Mapping[str, JsonValue]
    sha256: str


def catalog_etag(catalog: CatalogView) -> str:
    """Return the strong ETag of a catalog: the quoted sha256 of its canonical bytes."""
    return '"' + hashlib.sha256(canonical_bytes(catalog)).hexdigest() + '"'
