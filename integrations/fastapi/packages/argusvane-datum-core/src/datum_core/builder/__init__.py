"""The builder capability: `BuilderService`, its sealed outcomes, its hooks and the locale changes a save carries.

A layer of its own (a sibling of `submissions`, above `forms`, below `http`): it imports no web framework.
"""

from datum_core.builder.catalog import (
    MAX_CATALOG_ENTRIES,
    MAX_CATALOG_KEY_LENGTH,
    MAX_CATALOG_TEXT_BYTES,
    move_locales,
    read_catalog,
)
from datum_core.builder.changes import MAX_LOCALES, LocaleChanges, is_locale_code
from datum_core.builder.drafts import (
    BuilderSaveCandidate,
    BuilderSaveCustomizer,
    BuilderSaveDraft,
    BuilderSaveValidator,
)
from datum_core.builder.manifest import known_component_types
from datum_core.builder.outcomes import (
    BuilderOutcome,
    CatalogOutdated,
    CatalogSaved,
    Declined,
    Exists,
    Malformed,
    NotFound,
    Outdated,
    ReadOnly,
    Refused,
    Saved,
    TooLarge,
    Unavailable,
)
from datum_core.builder.service import LOCK_STRIPES, MOVE_ATTEMPTS, BuilderService
from datum_core.builder.shape import (
    MAX_COMPONENTS,
    MAX_OPTIONS,
    MAX_OPTIONS_IN_ALL,
    MAX_PROBLEMS,
    MAX_VERSION_LENGTH,
    read_shape,
)
from datum_core.builder.tree import TreeReading, read_tree

__all__ = [
    "LOCK_STRIPES",
    "MAX_CATALOG_ENTRIES",
    "MAX_CATALOG_KEY_LENGTH",
    "MAX_CATALOG_TEXT_BYTES",
    "MAX_COMPONENTS",
    "MAX_LOCALES",
    "MAX_OPTIONS",
    "MAX_OPTIONS_IN_ALL",
    "MAX_PROBLEMS",
    "MAX_VERSION_LENGTH",
    "MOVE_ATTEMPTS",
    "BuilderOutcome",
    "BuilderSaveCandidate",
    "BuilderSaveCustomizer",
    "BuilderSaveDraft",
    "BuilderSaveValidator",
    "BuilderService",
    "CatalogOutdated",
    "CatalogSaved",
    "Declined",
    "Exists",
    "LocaleChanges",
    "Malformed",
    "NotFound",
    "Outdated",
    "ReadOnly",
    "Refused",
    "Saved",
    "TooLarge",
    "TreeReading",
    "Unavailable",
    "is_locale_code",
    "known_component_types",
    "move_locales",
    "read_catalog",
    "read_shape",
    "read_tree",
]
