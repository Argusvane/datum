"""The sealed outcomes of the forms services: frozen, slotted records with no header and no status.

`datum_core.http` maps each to its answer; a caller closes a union with `match` and `assert_never`. What a customizer
or a store raises reaches the caller as raised.
"""

import json
from dataclasses import dataclass
from typing import Any

from datum_core.stores import Catalog
from datum_sandbox.json import JsonValue

__all__ = [
    "DataSourceNotFound",
    "DataSourceOutcome",
    "DataSourceUnavailable",
    "DefinitionOutcome",
    "Items",
    "NotFound",
    "Served",
    "TooDeep",
    "TranslationsOutcome",
    "TranslationsServed",
    "Unavailable",
]


@dataclass(frozen=True, slots=True)
class Served:
    """A definition ready to send: its canonical JSON bytes and the strong ETag of exactly those bytes."""

    body: bytes
    etag: str

    @property
    def definition(self) -> dict[str, Any]:
        """The definition, parsed afresh from `body` on each read, so no caller shares or changes another's copy."""
        return json.loads(self.body)  # type: ignore[no-any-return]


@dataclass(frozen=True, slots=True)
class NotFound:
    """No such form, version, hash or catalog owner."""


@dataclass(frozen=True, slots=True)
class Unavailable:
    """The form carries server-secret rules and the runtime that removes them cannot answer now."""


@dataclass(frozen=True, slots=True)
class TooDeep:
    """The definition is nested past a depth limit; the kernel refused it before any guest ran."""


type DefinitionOutcome = Served | NotFound | Unavailable | TooDeep


@dataclass(frozen=True, slots=True)
class TranslationsServed:
    """A form's translation catalog and the strong ETag of its canonical bytes (the store's own)."""

    catalog: Catalog
    body: bytes
    etag: str


type TranslationsOutcome = TranslationsServed | NotFound


@dataclass(frozen=True, slots=True)
class Items:
    """The items of a data source, each a mapping the form's choice component reads (`value`, `label`, ...)."""

    items: list[dict[str, JsonValue]]


@dataclass(frozen=True, slots=True)
class DataSourceNotFound:
    """No provider knows this data-source id."""


@dataclass(frozen=True, slots=True)
class DataSourceUnavailable:
    """A provider that knows the id failed or ran past the deadline; its own words are logged, never carried."""


type DataSourceOutcome = Items | DataSourceNotFound | DataSourceUnavailable
