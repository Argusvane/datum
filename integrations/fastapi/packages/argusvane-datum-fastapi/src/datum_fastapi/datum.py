"""`datum_fastapi.Datum`: the core composition root plus what a FastAPI application needs.

It adds the two request seams (`principal` and `locale`, the application's FastAPI dependencies), the
reference-counted `lifespan` every router factory's router carries, `async with datum:`, `asgi_app()` for a mounted
sub-application, and the async faces the routes await.
"""

import functools
import locale as process_locale
import re
from collections.abc import AsyncIterator, Callable
from contextlib import asynccontextmanager
from typing import Final, Self, Unpack
from urllib.parse import urlsplit

from fastapi import FastAPI, Request

from datum_core.aio import (
    AsyncBuilderService,
    AsyncDataSourceService,
    AsyncDefinitionService,
    AsyncLifecycle,
    AsyncPdfService,
    AsyncRunner,
    AsyncSubmissionService,
    AsyncTimestampService,
    AsyncTranslationService,
)
from datum_core.config import DatumConfig
from datum_core.config.models import Throttle
from datum_core.datum import Datum as CoreDatum
from datum_core.datum import DatumOptions
from datum_core.health import HealthReport
from datum_core.http import HttpAnswer, datum_error_answer, preferred_language
from datum_core.throttle import AsyncLimitsThrottle
from datum_fastapi import routers
from datum_fastapi.lifespan import StartedGuard
from datum_fastapi.routing import AnswerError
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.wasi import EngineBusyError

__all__ = ["Datum", "LocaleDependency", "PrincipalDependency", "accept_language", "preferred_language"]

type PrincipalDependency = Callable[..., object]
"""The application's optional-mode authentication dependency (`HTTPBearer(auto_error=False)`, ...): a user or None."""

type LocaleDependency = Callable[..., str]
"""A FastAPI dependency answering the request's locale (for example `def locale(request: Request) -> str`)."""

_LANGUAGE_TAG: Final = re.compile(r"[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*")
_FALLBACK_LOCALE: Final = "en"


@functools.cache
def _process_language() -> str:
    name = process_locale.getlocale()[0]
    if not name or name in {"C", "POSIX"}:
        return _FALLBACK_LOCALE
    tag = name.split(".")[0].replace("_", "-")
    return tag if _LANGUAGE_TAG.fullmatch(tag) else _FALLBACK_LOCALE


def accept_language(request: Request) -> str:
    """Datum's default `locale`: the request's preferred `Accept-Language` language, else the process locale."""
    return preferred_language(request.headers.get("accept-language")) or _process_language()


def _network_storage(settings: Throttle) -> bool:
    """Whether the throttle counts over the network (`async+redis://...` or `redis://...`): awaited, never threaded.

    A route never blocks the loop on a counter: every storage but memory is counted through `limits.aio`, which asks
    for the `async+` form of the same URI.
    """
    return urlsplit(settings.storage).scheme.removeprefix("async+") != "memory"


def anonymous() -> None:
    """Datum's default `principal`: every request is anonymous."""


class Datum(CoreDatum):
    """Datum for FastAPI: build it once, include its routers (each carries its lifespan), or mount `asgi_app()`."""

    def __init__(
        self,
        *,
        principal: PrincipalDependency | None = None,
        locale: LocaleDependency | None = None,
        **options: Unpack[DatumOptions],
    ) -> None:
        """Keep the request seams and the core seams (keyword-only; see `datum_core.Datum`)."""
        if options.get("throttle") is None:
            settings = (options.get("config") or DatumConfig()).web.throttle
            if _network_storage(settings):
                options["throttle"] = AsyncLimitsThrottle(settings)  # counted on the loop, through `limits.aio`
        super().__init__(**options)
        self.principal: PrincipalDependency = principal or anonymous
        self.locale: LocaleDependency = locale or accept_language
        self._lifecycle = AsyncLifecycle(self)
        self._guard = StartedGuard(self, self._lifecycle)

    # -- the lifespan ------------------------------------------------------------------------------------------------
    async def __aenter__(self) -> Self:
        """Enter Datum: the first entry starts it (off the event loop), later ones only count."""
        try:
            await self._lifecycle.enter()
        except BaseException:
            if self._lifecycle.entries == 0:  # a refused second loop is not a failed start: the first loop still serves
                self._guard.note_failed_start()
            raise
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        """Leave Datum: the last exit drains the calls in flight within the grace and stops it."""
        await self._lifecycle.exit()

    @asynccontextmanager
    async def lifespan(self, app: object) -> AsyncIterator[None]:  # noqa: ARG002 - the Lifespan signature
        """Enter Datum for one router's lifespan (`APIRouter(lifespan=datum.lifespan)`): `async with self`."""
        async with self:
            yield

    @property
    def started_guard(self) -> StartedGuard:
        """The router-level `started` dependency (503 `server.unavailable` until a lifespan entered Datum)."""
        return self._guard

    @property
    def entries(self) -> int:
        """How many lifespans are inside Datum now (router inclusions and `async with`)."""
        return self._lifecycle.entries

    # -- what the routes await ---------------------------------------------------------------------------------------
    @property
    def runner(self) -> AsyncRunner | None:
        """The runner of the running lifespan, `None` outside it."""
        return self._lifecycle.runner

    def _live_runner(self) -> AsyncRunner:
        runner = self._lifecycle.runner
        if runner is None:
            raise AnswerError(self.unavailable_answer())
        return runner

    @property
    def async_definitions(self) -> AsyncDefinitionService:
        """The definition read service, awaited through the runner."""
        return AsyncDefinitionService(self.definition_service, self._live_runner())

    @property
    def async_translations(self) -> AsyncTranslationService:
        """The translations read service, awaited through the runner."""
        return AsyncTranslationService(self.translation_service, self._live_runner())

    @property
    def async_data_sources(self) -> AsyncDataSourceService:
        """The data-source service, awaited through the runner."""
        return AsyncDataSourceService(self.data_source_service, self._live_runner())

    @property
    def async_submissions(self) -> AsyncSubmissionService:
        """The submission service, awaited through the runner (one tracked task per call)."""
        return AsyncSubmissionService(self.submission_service, self._live_runner())

    @property
    def async_builder(self) -> AsyncBuilderService:
        """The builder service, awaited through the runner (one tracked task per write)."""
        return AsyncBuilderService(self.builder_service, self._live_runner())

    @property
    def async_timestamps(self) -> AsyncTimestampService:
        """The timestamp authority, awaited through the runner (one tracked task per token).

        Only while `datum.tsa.enabled`: the TSA router is not mounted otherwise, so no route reaches the refusal below.
        """
        authority = self.timestamp_authority
        if authority is None:
            raise DatumConfigurationError(
                "the timestamp server is off", hint="set datum.tsa.enabled to true to serve tokens"
            )
        return AsyncTimestampService(authority, self._live_runner())

    @property
    def async_pdf(self) -> AsyncPdfService:
        """The PDF service, awaited through the runner (one tracked task per call).

        Only while `datum.pdf.enabled`: the PDF router is not mounted otherwise, so no route reaches the refusal below.
        """
        service = self.pdf_service
        if service is None:
            raise DatumConfigurationError("the PDF capability is off", hint="set datum.pdf.enabled to true")
        return AsyncPdfService(service, self._live_runner())

    async def async_recheck(self) -> HealthReport:
        """`Datum.recheck()` on a worker thread, as a tracked call of the runner (the management route awaits this)."""
        return await self._live_runner().run(self.recheck)

    def unavailable_answer(self) -> HttpAnswer:
        """503 `server.unavailable` (no `Retry-After`), in the configured error format."""
        return self._guard.unavailable()

    def busy_answer(self) -> HttpAnswer:
        """503 `server.busy` with `Retry-After`, in the configured error format."""
        api = self.config.web.api
        return datum_error_answer(
            EngineBusyError("slots"), retry_after=api.busy_retry_after, problem_details=api.problem_details
        )

    # -- mounted mode ------------------------------------------------------------------------------------------------
    def asgi_app(self) -> FastAPI:
        """Return a FastAPI sub-application holding Datum's public routers, for a `Mount` under another ASGI parent.

        It holds the forms and submissions routers (and the assets router when assets are on). The privileged routers
        (authoring, management) take the application's `dependencies`, so the application includes them itself.

        A `Mount` forwards no lifespan: the parent's lifespan writes `async with datum:`. The sub-application serves
        no OpenAPI document or docs page of its own; URLs come from `scope["root_path"]`.
        """
        app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)
        app.include_router(routers.forms(self))
        app.include_router(routers.submissions(self))
        if self.config.web.assets.enabled:
            app.include_router(routers.assets(self))
        return app
