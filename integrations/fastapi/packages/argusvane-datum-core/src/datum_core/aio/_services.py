"""The async faces of the forms services: one `AsyncRunner.run` per call, the sync service doing the work on a thread.

`AsyncSubmissionService` runs the submission service the same way, `AsyncTimestampService` the timestamp
authority and `AsyncPdfService` the PDF service. `count_address` is the address limit a route asks before it reads
the body: it counts on the event loop when it can, so a request costs no thread before it is counted.
"""

import functools
from typing import TYPE_CHECKING, TypedDict, Unpack

from datum_core.aio._runner import AsyncRunner
from datum_core.builder import BuilderOutcome, BuilderService, LocaleChanges, Malformed
from datum_core.config.models import LogLevel
from datum_core.forms import (
    DataSourceOutcome,
    DataSourceRequest,
    DataSourceService,
    DefinitionOutcome,
    DefinitionService,
    TranslationService,
    TranslationsOutcome,
)
from datum_core.submissions import (
    AcceptedSubmission,
    FormRef,
    InspectOutcome,
    JourneyCheck,
    SubmissionContext,
    SubmissionMode,
    SubmissionOutcome,
    SubmissionService,
    Throttled,
)
from datum_core.throttle import AsyncLimitsThrottle, Deny, LimitsThrottle
from datum_core.timestamp.protocols import HTTP_CHANNEL, TimestampChannel, TimestampGrant

if TYPE_CHECKING:
    from datum_core.pdf.outcomes import PdfOutcome, VerifyOutcome
    from datum_core.pdf.service import PdfService
    from datum_core.timestamp.authority import TimestampAnswer, TimestampAuthority
    from datum_core.timestamp.query import TimestampQuery

_PUBLISHING_MODES = frozenset({SubmissionMode.SUBMIT.value, SubmissionMode.VALIDATE.value})
"""The modes whose address-limit refusal publishes an event, and so goes through the runner."""


class DefinitionReadOptions(TypedDict, total=False):
    """The keywords of `DefinitionService.read`; only the ones given are passed on."""

    public: bool
    sha256: str | None
    principal: object | None
    locale: str


class AsyncDefinitionService:
    """`DefinitionService.read` on a worker thread, as a tracked call of the runner."""

    def __init__(self, service: DefinitionService, runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> DefinitionService:
        """The sync service this face calls."""
        return self._service

    async def read(self, key: str, /, **options: Unpack[DefinitionReadOptions]) -> DefinitionOutcome:
        """Read the definition (see `DefinitionService.read`)."""
        return await self._runner.run(functools.partial(self._service.read, key, **options))


class AsyncTranslationService:
    """`TranslationService.read` on a worker thread, as a tracked call of the runner."""

    def __init__(self, service: TranslationService, runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> TranslationService:
        """The sync service this face calls."""
        return self._service

    async def read(self, key: str, /) -> TranslationsOutcome:
        """Read the form's translation catalog (see `TranslationService.read`)."""
        return await self._runner.run(self._service.read, key)


class AsyncDataSourceService:
    """`DataSourceService.items` on a worker thread, as a tracked call of the runner (the deadline is the service's)."""

    def __init__(self, service: DataSourceService, runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> DataSourceService:
        """The sync service this face calls."""
        return self._service

    async def items(self, request: DataSourceRequest, /) -> DataSourceOutcome:
        """Answer the data source's items (see `DataSourceService.items`)."""
        return await self._runner.run(self._service.items, request)


async def count_address(throttle: object, address: str | None, runner: AsyncRunner) -> Deny | None:
    """Count one request under its client address alone (the address limit); return the `Deny`, else None.

    Only Datum's own throttle keeps the limit: the async face is awaited (its memory store counts on the loop, a
    network store through `limits.aio`), the sync face counts on the loop when its counters are in this process and
    through `runner` otherwise, so the loop never waits on a network counter. Any other throttle (an application's
    `SubmissionThrottle`) keeps no address limit, and nothing is counted here.

    The in-memory count stays on the loop even when it makes room at the `max_keys` cap (measured up to about 28 ms at
    10,000 keys, about once every 625 new addresses): a thread hop on every request costs more than that.
    """
    if isinstance(throttle, AsyncLimitsThrottle):
        answer = await throttle.check_address(address)
    elif isinstance(throttle, LimitsThrottle):
        answer = (
            throttle.check_address(address)
            if throttle.in_process
            else await runner.run(throttle.check_address, address)
        )
    else:
        return None
    return answer if isinstance(answer, Deny) else None


class AsyncSubmissionService:
    """`SubmissionService` calls on a worker thread, each ONE tracked task of the runner.

    The whole call (run, validators, handler, remember, events) is the task: a caller cancelled natively leaves the
    effect to finish, and the drain waits for it. An async hook is resolved through the service's awaiter on the loop.
    """

    def __init__(self, service: SubmissionService, runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> SubmissionService:
        """The sync service this face calls."""
        return self._service

    async def submit(self, form: FormRef, document: object, context: SubmissionContext) -> SubmissionOutcome:
        """Judge a delivery (see `SubmissionService.submit`)."""
        return await self._runner.run(self._service.submit, form, document, context)

    async def validate(
        self, form: FormRef, document: object, context: SubmissionContext, *, check: JourneyCheck | None = None
    ) -> SubmissionOutcome:
        """Judge a document and keep nothing (see `SubmissionService.validate`)."""
        return await self._runner.run(functools.partial(self._service.validate, form, document, context, check=check))

    async def test(
        self, form: FormRef, document: object, context: SubmissionContext, *, log_level: LogLevel | str | None = None
    ) -> SubmissionOutcome:
        """Run every check as a delivery would, with no effect (see `SubmissionService.test`)."""
        return await self._runner.run(
            functools.partial(self._service.test, form, document, context, log_level=log_level)
        )

    async def inspect(self, op: str, definition: object, context: SubmissionContext) -> InspectOutcome:
        """Ask the program about a definition (see `SubmissionService.inspect`)."""
        return await self._runner.run(self._service.inspect, op, definition, context)

    async def address_refusal(self, mode: str, address: str | None, channel: str, retry_after: int) -> Throttled:
        """Answer a request the address limit refused (see `SubmissionService.address_refusal`).

        `submit` and `validate` publish an event, so they run on a worker thread, as the per-form refusal does: a
        listener may block or be async. `test` and `inspect` publish nothing, so they answer on the loop and take no
        runner slot: a flood refused at the address limit must not become 503 `server.busy` when the slots are full.
        """
        if mode not in _PUBLISHING_MODES:
            return self._service.address_refusal(mode, address, channel, retry_after)
        return await self._runner.run(
            functools.partial(self._service.address_refusal, mode, address, channel, retry_after)
        )


class AsyncBuilderService:
    """`BuilderService` writes on a worker thread, each ONE tracked task of the runner.

    The whole write (the hooks, the kernel's check, the store, the snapshots, the saved event) is the task: a caller
    cancelled natively leaves the effect to finish, and the drain waits for it. An async hook is resolved through the
    service's awaiter on the loop. A hook or store raise reaches the awaiting caller as raised.

    A call that the shutdown grace abandons publishes nothing and stores nothing: the service's stop gate, taken under
    the form's lock right before the store, answers `Unavailable` once Datum has stopped.
    """

    def __init__(self, service: BuilderService, runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> BuilderService:
        """The sync service this face calls."""
        return self._service

    async def save(
        self,
        key: str,
        definition: object,
        *,
        expected_sha256: str | None,
        principal: object | None,
        changes: LocaleChanges | Malformed | None = None,
    ) -> BuilderOutcome:
        """Save a new version of the form (see `BuilderService.save`)."""
        return await self._runner.run(
            functools.partial(
                self._service.save,
                key,
                definition,
                expected_sha256=expected_sha256,
                principal=principal,
                changes=changes,
            )
        )

    async def create(
        self, definition: object, *, principal: object | None, changes: LocaleChanges | Malformed | None = None
    ) -> BuilderOutcome:
        """Create a form under the id the definition carries (see `BuilderService.create`)."""
        return await self._runner.run(
            functools.partial(self._service.create, definition, principal=principal, changes=changes)
        )

    async def save_translations(
        self, key: str, catalog: object, *, expected_etag: str | None, principal: object | None
    ) -> BuilderOutcome:
        """Write the form's translation catalog (see `BuilderService.save_translations`)."""
        return await self._runner.run(
            functools.partial(
                self._service.save_translations, key, catalog, expected_etag=expected_etag, principal=principal
            )
        )


class AsyncTimestampService:
    """`TimestampAuthority` calls on a worker thread, each ONE tracked task of the runner.

    The whole token (the customizers, the time source, the serial, the signature, the log row and the events) is the
    task: a caller cancelled natively leaves the effect to finish, and the drain waits for it. Signing never runs on the
    loop; an async customizer or time source is resolved through the authority's awaiter on the loop. A store or key
    that raises ends the token as a `systemFailure` refusal (the authority converts it); the runner's busy and closed
    errors reach the caller as raised, before any serial is taken.
    """

    def __init__(self, service: "TimestampAuthority", runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> "TimestampAuthority":
        """The sync authority this face calls."""
        return self._service

    async def issue(
        self,
        query: "TimestampQuery",
        *,
        channel: TimestampChannel = HTTP_CHANNEL,
        client: str | None = None,
        principal: object | None = None,
    ) -> TimestampGrant:
        """Issue a token for `query`, or raise `TimestampRefusedError` (see `TimestampAuthority.issue`)."""
        return await self._runner.run(
            functools.partial(self._service.issue, query, channel=channel, client=client, principal=principal)
        )

    async def answer(
        self,
        request: bytes,
        *,
        channel: TimestampChannel = HTTP_CHANNEL,
        client: str | None = None,
        principal: object | None = None,
    ) -> "TimestampAnswer":
        """Read `request` and answer it: the granted reply or the rejection (see `TimestampAuthority.answer`)."""
        return await self._runner.run(
            functools.partial(self._service.answer, request, channel=channel, client=client, principal=principal)
        )


class AsyncPdfService:
    """`PdfService` calls on a worker thread, each ONE tracked task of the runner.

    The whole call (the dry run, the customizers, the program's runs, the validators, the signature with its timestamp
    request and the event) is the task: a caller cancelled natively leaves the effect to finish, and the drain waits
    for it. The key is used and the revocation check runs on the worker thread, never on the loop; an async hook is
    resolved through the service's awaiter on the loop. The runner's busy and closed errors reach the caller as raised,
    before anything runs. A PDF run takes a slot of the PDF pool inside the program runtime, as the sync service does.
    """

    def __init__(self, service: "PdfService", runner: AsyncRunner) -> None:
        """Wrap `service`; every call goes through `runner`."""
        self._service = service
        self._runner = runner

    @property
    def service(self) -> "PdfService":
        """The sync service this face calls."""
        return self._service

    async def render(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str | None = None
    ) -> "PdfOutcome":
        """Print posted answers (see `PdfService.render`)."""
        return await self._runner.run(
            functools.partial(self._service.render, form, document, context, layout_id=layout_id)
        )

    async def fill(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str
    ) -> "PdfOutcome":
        """Fill a template layout with posted answers (see `PdfService.fill`)."""
        return await self._runner.run(
            functools.partial(self._service.fill, form, document, context, layout_id=layout_id)
        )

    async def sign(
        self, form: FormRef, document: object, context: SubmissionContext, *, layout_id: str | None = None
    ) -> "PdfOutcome":
        """Print posted answers and sign them with the server's key (see `PdfService.sign`)."""
        return await self._runner.run(
            functools.partial(self._service.sign, form, document, context, layout_id=layout_id)
        )

    async def verify(self, data: bytes, context: SubmissionContext) -> "VerifyOutcome":
        """Read every signature of a PDF and place each signer (see `PdfService.verify`)."""
        return await self._runner.run(self._service.verify, data, context)

    async def render_submission(self, accepted: AcceptedSubmission, *, layout_id: str | None = None) -> "PdfOutcome":
        """Print an accepted submission with the server's seal (see `PdfService.render_submission`)."""
        return await self._runner.run(functools.partial(self._service.render_submission, accepted, layout_id=layout_id))

    async def certificate_chain(self) -> str | None:
        """Return the server's certificate chain as PEM, or `None` without a key (`PdfService.certificate_chain`)."""
        return await self._runner.run(self._service.certificate_chain)
