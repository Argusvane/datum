"""The sealed outcomes of the builder service: frozen, slotted records with no header and no status.

`datum_core.http.builder` maps each to its answer; a caller closes the union with `match` and `assert_never`. What a
customizer, a validator or a store raises reaches the caller as raised.

Libraries: the standard library `dataclasses` is the whole of it; pydantic would
validate what the service has already built, and `typing.NamedTuple` would make an outcome a tuple a caller could
unpack by position.
"""

from dataclasses import dataclass
from datetime import datetime

from datum_core.hooks import HookProblem, HookRefusedError
from datum_core.stores import CatalogView

__all__ = [
    "BuilderOutcome",
    "CatalogOutdated",
    "CatalogSaved",
    "Declined",
    "Exists",
    "Malformed",
    "NotFound",
    "Outdated",
    "ReadOnly",
    "Refused",
    "Saved",
    "TooLarge",
    "Unavailable",
]


@dataclass(frozen=True, slots=True)
class Saved:
    """A definition was stored (created when `created`): the hash stored and the catalog that moved with it."""

    key: str
    sha256: str
    version: str
    removed_locales: tuple[str, ...]
    catalog: CatalogView
    warnings: tuple[str, ...]
    kernel_warnings: tuple[HookProblem, ...]
    created: bool
    saved_at: datetime


@dataclass(frozen=True, slots=True)
class CatalogSaved:
    """A translation catalog was stored: its normalised form and its ETag."""

    key: str
    etag: str
    catalog: CatalogView
    saved_at: datetime


@dataclass(frozen=True, slots=True)
class Outdated:
    """The `If-Match` hash is not the stored one."""

    current_sha256: str
    current_version: str


@dataclass(frozen=True, slots=True)
class CatalogOutdated:
    """The `If-Match` ETag is not the catalog's."""

    current_etag: str


@dataclass(frozen=True, slots=True)
class Refused:
    """The definition or catalog was refused: `definition.refused`, `.tooDeep`, `.tooCostly` or `catalog.invalid`."""

    code: str
    errors: tuple[HookProblem, ...]
    cause: Exception | None = None


@dataclass(frozen=True, slots=True)
class ReadOnly:
    """The repository takes no writes."""

    cause: Exception | None = None


@dataclass(frozen=True, slots=True)
class Exists:
    """A create named a form that exists."""

    key: str
    current_sha256: str


@dataclass(frozen=True, slots=True)
class NotFound:
    """No such form."""

    key: str


@dataclass(frozen=True, slots=True)
class Malformed:
    """The document, or a header that rides with it, is not what the contract reads."""

    reason: str


@dataclass(frozen=True, slots=True)
class TooLarge:
    """The definition is over `datum.builder.max_definition_size`."""

    max_bytes: int


@dataclass(frozen=True, slots=True)
class Unavailable:
    """A runtime or a store cannot answer now."""

    code: str
    reason: str
    cause: BaseException | None


@dataclass(frozen=True, slots=True)
class Declined:
    """A hook refused the save with its kind and problems."""

    refusal: HookRefusedError


type BuilderOutcome = (
    Saved
    | CatalogSaved
    | Outdated
    | CatalogOutdated
    | Refused
    | ReadOnly
    | Exists
    | NotFound
    | Malformed
    | TooLarge
    | Unavailable
    | Declined
)
