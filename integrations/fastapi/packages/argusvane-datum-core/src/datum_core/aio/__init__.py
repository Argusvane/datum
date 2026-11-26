"""The async faces a binding awaits (extra `[aio]`): the anyio awaiter, the runner and its drain, the async services.

Only this subpackage imports anyio (the rest of `datum_core` serves a view with no event loop).
"""

from datum_core.aio._awaiter import anyio_awaiter
from datum_core.aio._lifecycle import AsyncLifecycle
from datum_core.aio._runner import AsyncRunner, DrainResult, GraceExpired, size_worker_threads, worker_threads_for
from datum_core.aio._services import (
    AsyncBuilderService,
    AsyncDataSourceService,
    AsyncDefinitionService,
    AsyncPdfService,
    AsyncSubmissionService,
    AsyncTimestampService,
    AsyncTranslationService,
    DefinitionReadOptions,
    count_address,
)

__all__ = [
    "AsyncBuilderService",
    "AsyncDataSourceService",
    "AsyncDefinitionService",
    "AsyncLifecycle",
    "AsyncPdfService",
    "AsyncRunner",
    "AsyncSubmissionService",
    "AsyncTimestampService",
    "AsyncTranslationService",
    "DefinitionReadOptions",
    "DrainResult",
    "GraceExpired",
    "anyio_awaiter",
    "count_address",
    "size_worker_threads",
    "worker_threads_for",
]
