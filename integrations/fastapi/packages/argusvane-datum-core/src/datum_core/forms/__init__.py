"""The forms capability: keys, repositories and stores (protocols), the read services and their sealed outcomes."""

from datum_core.forms.definitions import CustomizerIdentityError, DefinitionService, carries_server_secret_rule
from datum_core.forms.keys import MAX_KEY_LENGTH, is_form_key, parse_form_key
from datum_core.forms.outcomes import (
    DataSourceNotFound,
    DataSourceOutcome,
    DataSourceUnavailable,
    DefinitionOutcome,
    Items,
    NotFound,
    Served,
    TooDeep,
    TranslationsOutcome,
    TranslationsServed,
    Unavailable,
)
from datum_core.forms.protocols import (
    DataSourceProvider,
    DataSourceRequest,
    DefinitionCustomizer,
    DefinitionDraft,
    DefinitionRequest,
    DefinitionSnapshotStore,
    FormDefinitionRepository,
    SnapshotNotRecordedError,
    TranslationCatalogStore,
    WritableFormDefinitionRepository,
)
from datum_core.forms.repository import FileFormDefinitionRepository
from datum_core.forms.sources import CompositeDataSourceProvider, DataSourceService, Deadline
from datum_core.forms.translations import TranslationService
from datum_core.stores import StoredCatalog, StoredDefinition

__all__ = [
    "MAX_KEY_LENGTH",
    "CompositeDataSourceProvider",
    "CustomizerIdentityError",
    "DataSourceNotFound",
    "DataSourceOutcome",
    "DataSourceProvider",
    "DataSourceRequest",
    "DataSourceService",
    "DataSourceUnavailable",
    "Deadline",
    "DefinitionCustomizer",
    "DefinitionDraft",
    "DefinitionOutcome",
    "DefinitionRequest",
    "DefinitionService",
    "DefinitionSnapshotStore",
    "FileFormDefinitionRepository",
    "FormDefinitionRepository",
    "Items",
    "NotFound",
    "Served",
    "SnapshotNotRecordedError",
    "StoredCatalog",
    "StoredDefinition",
    "TooDeep",
    "TranslationCatalogStore",
    "TranslationService",
    "TranslationsOutcome",
    "TranslationsServed",
    "Unavailable",
    "WritableFormDefinitionRepository",
    "carries_server_secret_rule",
    "is_form_key",
    "parse_form_key",
]
