"""`Datum`: the framework-free composition root.

The object is keyword-only and holds the seams an application hands over; `None` (or an empty sequence) means Datum's
default. `start()` and `stop()` are synchronous: a binding calls them off its event loop (the runtime compiles its guest
for about a second) and owns the reference counting of its lifespan. The start, in order:

1. the build-id agreement of the installed resource distributions and of argusvane-datum-core itself (assets on or off);
2. the checks: the budget clamp (`datum.W008`, `datum.E003`), the builder's shared-store rule
   (`datum.E002`), per-process memory stores (`datum.W004`), data-source providers keeping the default `exists`
   (`datum.W006`), routers whose every switch is off (`datum.W001`), the memory the slots may take against the
   container's (`datum.W002`), the default logging handler, the per-process throttle and idempotency store of a
   deployment that serves submissions (`datum.W003`, `datum.W004`), the timestamp server's serial allocator and log
   kept in memory (`datum.E001`, or `datum.W009` once `datum.tsa.allow_memory_stores` acknowledges them), the process
   zone (`datum.W010`), the PDF seal's key and timestamp sources (`datum.W013`, `datum.W011`, `datum.W012`,
   `datum.I002`) and one INFO line naming the routes that are on (`datum.I001`). ERRORs are raised together;
   the rest is logged on `datum.checks`;
3. the form repository (a bad file stops the start naming it) and, with assets on, the asset catalog;
4. the runtime: selected by `datum.runtime.engine` from the installed engines (or the application's), the sandbox
   composed (the application's middleware outside, Datum's observation innermost), the ABI proof once, the smoke and
   warm-up runs (the engine sweeps leftover run directories when it is built);
5. the forms services and the submission service (the hooks, stores and throttle `Datum` was given, or
   its defaults), then, only while `datum.tsa.enabled`, the timestamp authority (its key read once from the seam or the
   settings; the memory stores of its trust state are checked in step 2, before any key is asked for), then, only while
   `datum.pdf.enabled`, the PDF service (the signer read once from the seam or `datum.pdf.signing`, the trust anchors
   read, the seal's timestamper chosen: the application's, else the client of `datum.pdf.signing.tsa.url`, else the
   in-process authority; the PDF program's ABI is proved beside the sandbox's in step 4), then `DatumRuntimeReadyEvent`.
   A PDF program that fails its proof stops the start with `datum.runtime.fail_fast`, else leaves PDFs unavailable
   (`pdfUnavailable` on the `runtime` health) and everything else working.

A configuration the start refuses (`DatumConfigurationError`, an engine that cannot be selected included) stops it
whatever `datum.runtime.fail_fast` says. Any other failure to bring the runtime up raises with `fail_fast` (the
default), or else leaves the start done with the `runtime` health component down and its reason, so the routes answer
503 until `recheck()` succeeds. Either way a failed start undoes what it built (the runtime is closed, no thread is
left).
"""

import importlib.util
import logging
import os
import threading
import time
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass
from datetime import datetime
from typing import TYPE_CHECKING, Final, Literal, TypedDict, cast
from zoneinfo import ZoneInfo

from datum_core.bindings import HostBindings
from datum_core.builder import (
    BuilderSaveCustomizer,
    BuilderSaveValidator,
    BuilderService,
    known_component_types,
)
from datum_core.checks import (
    E002,
    I001,
    W001,
    default_handler_in_use,
    log_checks,
    pdf_seal_without_key,
    pdf_timestamp_without_source,
    pdf_tsa_client_unused,
    pdf_tsa_policy_unused,
    silence,
    startup_memory_check,
    trust_store_acknowledged,
    trust_store_refused,
)
from datum_core.config import DatumConfig, process_zone
from datum_core.config.sandbox import sandbox_settings
from datum_core.events import (
    DatumRuntimeReadyEvent,
    EventDispatcher,
    InterruptReason,
    ListenerEntry,
    SandboxRunInterruptedEvent,
)
from datum_core.forms import (
    CompositeDataSourceProvider,
    DataSourceProvider,
    DataSourceService,
    DefinitionCustomizer,
    DefinitionService,
    DefinitionSnapshotStore,
    FileFormDefinitionRepository,
    FormDefinitionRepository,
    TranslationCatalogStore,
    TranslationService,
)
from datum_core.health import ComponentHealth, HealthRegistry, HealthReport
from datum_core.hooks import Awaiter
from datum_core.http import HttpAnswer
from datum_core.http.assets import RESOURCE_PACKAGES, AssetCatalog, AssetSource, WithheldAssets
from datum_core.http.assets import agree_build_ids as agree_resource_build_ids
from datum_core.loggers import TSA
from datum_core.observe import (
    CORE_VERSION,
    ObservedPdfKernel,
    ObservedSubmissionService,
    observed_repository,
    quiet,
    run_observed,
    watch_slots,
)
from datum_core.stores.memory import (
    InMemoryTsaFlood,
    MemoryDefinitionSnapshotStore,
    MemoryFormDefinitionRepository,
    MemorySubmissionIdempotencyStore,
    MemoryTranslationCatalogStore,
    MemoryTsaLog,
    MemoryTsaSerialAllocator,
)
from datum_core.stores.tsa import SettingsTsaClientStore, TsaClientStore, TsaLog, TsaSerialAllocator
from datum_core.submissions import (
    ContextContributor,
    HostContextProvider,
    HostOptionsCustomizer,
    PreCheckStatuses,
    Reject,
    RememberedReceipt,
    RulesProvider,
    SubmissionHandler,
    SubmissionIdempotencyStore,
    SubmissionPreCheck,
    SubmissionService,
    SubmissionSignatureCheck,
    SubmissionValidator,
    log_submission,
)
from datum_core.throttle import AsyncSubmissionThrottle, LimitsThrottle, LimitsThrottleBase, SubmissionThrottle
from datum_core.throttle.limits_throttle import HEALTH_NAME as THROTTLE_HEALTH
from datum_core.timestamp.protocols import (
    Timestamper,
    TimestampRequestCustomizer,
    TimestampRequestHook,
    TsaKeyMaterial,
    TsaTimeSource,
    TsaTransport,
)
from datum_sandbox.checks import CheckLevel, DatumCheck, DatumConfigurationError, raise_errors, startup_over_budget
from datum_sandbox.diagnostics import RunCaptureSink, RunTrace, SettingsReport, without_paths
from datum_sandbox.json import JsonValue
from datum_sandbox.loggers import RUNTIME
from datum_sandbox.protocol import (
    AbiProbe,
    PdfKernel,
    Program,
    ProgramKind,
    ProgramLimits,
    ProgramUnavailableError,
    RuleModule,
    RunLog,
    Sandbox,
    SandboxError,
    SandboxFailure,
    SandboxMiddleware,
    SandboxResult,
    Smoke,
    declared_abis,
)
from datum_sandbox.runtime import DatumSandbox, SandboxReady, SandboxSettings, SandboxState
from datum_sandbox.wasi import EngineInfo, EngineSettings, GuestRuntime

if TYPE_CHECKING:
    from datum_core.http.timestamp import TimestampGate
    from datum_core.pdf.protocols import PdfKernelMiddleware, PdfRequestCustomizer, PdfResultValidator, PdfSigner
    from datum_core.pdf.seal import PdfSeal, TimestampSource
    from datum_core.pdf.service import PdfService
    from datum_core.pdf.trust import PdfTrustPolicy
    from datum_core.timestamp.authority import TimestampAuthority
else:
    # The PDF modules are imported only while the capability is on (importing `datum_core.pdf` imports no submodule, and
    # the policy needs argusvane-datum-core[pdf]), but `get_type_hints(DatumOptions)` must resolve every name: at run
    # time the keyword hints read these as `object`; the type checkers see the real types above.
    PdfKernelMiddleware = PdfRequestCustomizer = PdfResultValidator = PdfSigner = PdfTrustPolicy = object

__all__ = [
    "CORE_PACKAGE",
    "RESOURCE_PACKAGES",
    "Datum",
    "DatumNotStartedError",
    "DatumOptions",
    "ErrorTranslator",
    "WithheldAssets",
]

logger = logging.getLogger(RUNTIME)
_tsa_logger = logging.getLogger(TSA)

type ErrorTranslator = Callable[[Exception], HttpAnswer | None]
"""An application's answer for an exception a Datum route raised, asked before Datum's own mapping, in list order."""

CORE_PACKAGE: Final = ("datum_core", "argusvane-datum-core")
"""argusvane-datum-core's own build marker, held to the same build id."""

_LIFESPAN_NOT_RUN: Final = "lifespan not run"
FORMS_HEALTH: Final = MemoryFormDefinitionRepository.health_name
"""The health component of the form repository, `stores.forms`, flat like its siblings.

Unlike its siblings it is registered only when `datum.enabled` and `datum.builder.enabled` are both on: the snapshot,
translation, throttle and idempotency stores are always Datum's to run, but the form repository is a read-only source
while the builder is off (nothing writes to it, nothing can diverge between workers), so it has nothing to report.
"""
IDEMPOTENCY_HEALTH: Final = MemorySubmissionIdempotencyStore.health_name
"""The health component of the idempotency store, `stores.idempotency`, flat like its siblings."""
PDF_HEALTH: Final = "pdf"
"""The health component of the PDF capability, registered only while `datum.pdf.enabled`; it never fails `readyz`."""
TSA_HEALTH: Final = "tsa"
"""The health component of the timestamp server, registered only while `datum.tsa.enabled`; it never fails `readyz`."""
_TSA: Final = "datum.tsa"
_TSA_EXTRA_MODULES: Final = ("asn1crypto", "cryptography")
_PDF: Final = "datum.pdf"
_PDF_EXTRA_MODULES: Final = ("asn1crypto", "cryptography")
_TSA_TABLE: Final = "datum_tsa_log"
_TSA_FLAG: Final = "datum.tsa.allow_memory_stores"
_TSA_SERIALS_CONSEQUENCE: Final = (
    "serials are seeded from the clock and unique only within this process, so a second instance, a restart after the"
    " clock was set back or more than 1000 tokens a millisecond could repeat one (RFC 3161 section 2.4.2)."
)
_TSA_LOG_CONSEQUENCE: Final = (
    "it keeps only the last 1000 tokens of this process, so a restart loses the record of what was issued and a second"
    " instance keeps a record of its own."
)
_INTERRUPTS: Final[Mapping[SandboxFailure, InterruptReason]] = {
    SandboxFailure.BUDGET: "budget",
    SandboxFailure.MEMORY: "memory",
    SandboxFailure.TRAP: "trap",
    SandboxFailure.OUTPUT_CAP: "output-cap",
    SandboxFailure.INTERRUPTED: "interrupted",
}


class DatumNotStartedError(RuntimeError):
    """A service was asked of a `Datum` that has not started (or has stopped): run its lifespan first."""


class DatumOptions(TypedDict, total=False):
    """The keyword seams of `Datum` as a binding's subclass passes them on (`**options`)."""

    config: DatumConfig | None
    listeners: Sequence[ListenerEntry]
    sandbox_middleware: Sequence[SandboxMiddleware]
    sandbox: Sandbox | None
    now: Callable[[], datetime] | None
    runtime: GuestRuntime | None
    engine_settings: EngineSettings | None
    error_translators: Sequence[ErrorTranslator]
    withheld_assets: Sequence[WithheldAssets]
    form_repository: FormDefinitionRepository | None
    snapshot_store: DefinitionSnapshotStore | None
    translation_store: TranslationCatalogStore | None
    data_sources: Sequence[DataSourceProvider]
    definition_customizers: Sequence[DefinitionCustomizer]
    run_log: RunLog | None
    handler: SubmissionHandler | None
    pre_checks: Sequence[SubmissionPreCheck]
    pre_check_statuses: Callable[[Reject], int] | None
    host_options_customizers: Sequence[HostOptionsCustomizer]
    rules_providers: Sequence[RulesProvider]
    context_contributors: Sequence[ContextContributor]
    host_context: HostContextProvider | None
    validators: Sequence[SubmissionValidator]
    throttle: SubmissionThrottle | AsyncSubmissionThrottle | None
    idempotency_store: SubmissionIdempotencyStore | None
    signature_check: SubmissionSignatureCheck | None
    builder_save_customizers: Sequence[BuilderSaveCustomizer]
    builder_save_validators: Sequence[BuilderSaveValidator]
    timestamp_request_customizers: Sequence[TimestampRequestHook | TimestampRequestCustomizer]
    tsa_time_source: TsaTimeSource | None
    tsa_key_material: TsaKeyMaterial | None
    tsa_serial_allocator: TsaSerialAllocator | None
    tsa_log: TsaLog | None
    tsa_client_store: TsaClientStore | None
    tsa_transport: TsaTransport | None
    pdf_request_customizers: Sequence[PdfRequestCustomizer]
    pdf_result_validators: Sequence[PdfResultValidator]
    pdf_middleware: Sequence[PdfKernelMiddleware]
    pdf_signer: PdfSigner | None
    timestamper: Timestamper | None
    pdf_trust_policy: PdfTrustPolicy | None
    trace: RunTrace | None
    capture_sink: RunCaptureSink | None


type _Phase = Literal["new", "starting", "ready", "down", "failed", "stopped"]


@dataclass(slots=True)
class _Timestamps:
    """The timestamp server one start built: the authority, the flood counters and client store the gate reads."""

    authority: "TimestampAuthority"
    flood: InMemoryTsaFlood
    clients: TsaClientStore
    gate: "TimestampGate | None" = None


@dataclass(frozen=True, slots=True)
class _PdfParts:
    """What the PDF service needs that is read or chosen before the other services: the seal, the policy, the chain."""

    seal: "PdfSeal"
    policy: "PdfTrustPolicy"
    known: tuple[bytes, ...]


@dataclass(frozen=True, slots=True)
class _Running:
    """The services one start built; `stop()` closes `resources` before the runtime."""

    resources: ExitStack
    repository: FormDefinitionRepository
    definitions: DefinitionService
    translations: TranslationService
    data_sources: DataSourceService
    submissions: SubmissionService
    asset_catalog: AssetCatalog | None
    builder: BuilderService | DatumConfigurationError  # the error when the UI manifest cannot be read (builder off)
    timestamps: _Timestamps | None = None  # None while datum.tsa.enabled is off
    pdf: "PdfService | None" = None  # None while datum.pdf.enabled is off
    bindings: HostBindings | None = None  # which binding each form route is drawn by (datum.bindings)


class Datum:
    """The composition root: settings, seams, the runtime's start and stop, checks, health and info."""

    def __init__(  # noqa: PLR0915 - one assignment per seam the composition root keeps
        self,
        *,
        config: DatumConfig | None = None,
        listeners: Sequence[ListenerEntry] = (),
        sandbox_middleware: Sequence[SandboxMiddleware] = (),
        sandbox: Sandbox | None = None,
        now: Callable[[], datetime] | None = None,
        runtime: GuestRuntime | None = None,
        engine_settings: EngineSettings | None = None,
        error_translators: Sequence[ErrorTranslator] = (),
        withheld_assets: Sequence[WithheldAssets] = (),
        form_repository: FormDefinitionRepository | None = None,
        snapshot_store: DefinitionSnapshotStore | None = None,
        translation_store: TranslationCatalogStore | None = None,
        data_sources: Sequence[DataSourceProvider] = (),
        definition_customizers: Sequence[DefinitionCustomizer] = (),
        run_log: RunLog | None = None,
        handler: SubmissionHandler | None = None,
        pre_checks: Sequence[SubmissionPreCheck] = (),
        pre_check_statuses: Callable[[Reject], int] | None = None,
        host_options_customizers: Sequence[HostOptionsCustomizer] = (),
        rules_providers: Sequence[RulesProvider] = (),
        context_contributors: Sequence[ContextContributor] = (),
        host_context: HostContextProvider | None = None,
        validators: Sequence[SubmissionValidator] = (),
        throttle: SubmissionThrottle | AsyncSubmissionThrottle | None = None,
        idempotency_store: SubmissionIdempotencyStore | None = None,
        signature_check: SubmissionSignatureCheck | None = None,
        builder_save_customizers: Sequence[BuilderSaveCustomizer] = (),
        builder_save_validators: Sequence[BuilderSaveValidator] = (),
        timestamp_request_customizers: Sequence[TimestampRequestHook | TimestampRequestCustomizer] = (),
        tsa_time_source: TsaTimeSource | None = None,
        tsa_key_material: TsaKeyMaterial | None = None,
        tsa_serial_allocator: TsaSerialAllocator | None = None,
        tsa_log: TsaLog | None = None,
        tsa_client_store: TsaClientStore | None = None,
        tsa_transport: TsaTransport | None = None,
        pdf_request_customizers: Sequence[PdfRequestCustomizer] = (),
        pdf_result_validators: Sequence[PdfResultValidator] = (),
        pdf_middleware: Sequence[PdfKernelMiddleware] = (),
        pdf_signer: PdfSigner | None = None,
        timestamper: Timestamper | None = None,
        pdf_trust_policy: PdfTrustPolicy | None = None,
        trace: RunTrace | None = None,
        capture_sink: RunCaptureSink | None = None,
    ) -> None:
        """Keep the seams; nothing starts here (`start()` does).

        The submission seams are sequences kept in list order, or single seams; `None` means Datum's
        default: the logging handler (which `datum.W003` reports), `PreCheckStatuses.standard()`, `LimitsThrottle` on
        `datum.web.throttle` and an in-memory idempotency store of `datum.submissions.idempotency.memory_size` receipts.
        `signature_check` is reserved: the service refuses anything but `None` until the passkey capability.
        `host_context` (`HostContextProvider`, one callable or `None`) works out the values a form's `host.` paths read
        for each judged call from the form key and the call's context; `None` supplies none (every rule reading `host.`
        is left unjudged), which is also the default. A provider that is not callable is a `TypeError` here.
        The builder hooks (`builder_save_customizers`, `builder_save_validators`) are sequences of callables kept in
        list order; anything else is a `TypeError` here, not at the first save.
        The timestamp seams matter only while `datum.tsa.enabled`: `timestamp_request_customizers` is a
        sequence kept in list order (a bare callable runs for the endpoint's tokens only; `every_channel` and
        `applies_to` choose others); `tsa_time_source` defaults to `now`, `tsa_key_material` to the key
        `datum.tsa.signer` names, `tsa_client_store` to `datum.tsa.clients`; `tsa_serial_allocator` and `tsa_log`
        default to memory stores that the start refuses unless `datum.tsa.allow_memory_stores` acknowledges them.
        `tsa_transport` is the outbound POST of a timestamp client (kept for the PDF seal and the receipts).
        The PDF seams matter only while `datum.pdf.enabled`: `pdf_request_customizers` and `pdf_result_validators` are
        sequences of hooks kept in list order, `pdf_middleware` wraps the PDF program's kernel (the first entry
        outermost), `pdf_signer` replaces the key `datum.pdf.signing` names (read once, at start), `timestamper`
        issues the seal's tokens (else the client of `datum.pdf.signing.tsa.url`, else the in-process authority) and
        `pdf_trust_policy` replaces the default `PdfTrustPolicy.standard` that places verified signers.
        The diagnostics seams are argusvane-datum-sandbox's: `trace` receives each traced run's record (instead of the
        `datum.sandbox.trace` log line) and `capture_sink` stores failed-run captures (instead of the owner-only
        directory `datum.runtime.diagnostics.capture.directory`); both matter only while their settings are on.
        """
        self.config: DatumConfig = config or DatumConfig()
        self.events = EventDispatcher(listeners)
        self.sandbox_middleware: tuple[SandboxMiddleware, ...] = tuple(sandbox_middleware)
        self.error_translators: tuple[ErrorTranslator, ...] = tuple(error_translators)
        self.withheld_assets: tuple[WithheldAssets, ...] = tuple(withheld_assets)
        self.data_sources: tuple[DataSourceProvider, ...] = tuple(data_sources)
        self.definition_customizers: tuple[DefinitionCustomizer, ...] = tuple(definition_customizers)
        zone = ZoneInfo(self.config.host.time_zone)
        self.now: Callable[[], datetime] = now or (lambda: datetime.now(zone))
        self.snapshot_store: DefinitionSnapshotStore = snapshot_store or MemoryDefinitionSnapshotStore(
            self.config.forms.snapshots.max_entries
        )
        self.translation_store: TranslationCatalogStore = translation_store or MemoryTranslationCatalogStore(
            self.config.forms.translations.max_entries
        )
        self.default_handler: bool = handler is None
        self.handler: SubmissionHandler = log_submission if handler is None else handler
        self.pre_checks: tuple[SubmissionPreCheck, ...] = tuple(pre_checks)
        self.pre_check_statuses: Callable[[Reject], int] = pre_check_statuses or PreCheckStatuses.standard()
        self.host_options_customizers: tuple[HostOptionsCustomizer, ...] = tuple(host_options_customizers)
        self.rules_providers: tuple[RulesProvider, ...] = tuple(rules_providers)
        self.context_contributors: tuple[ContextContributor, ...] = tuple(context_contributors)
        if host_context is not None and not callable(host_context):
            raise TypeError("host_context is a callable (form_key, context) -> mapping or None, or None")
        self.host_context: HostContextProvider | None = host_context
        self.validators: tuple[SubmissionValidator, ...] = tuple(validators)
        self.throttle: SubmissionThrottle | AsyncSubmissionThrottle = (
            LimitsThrottle(self.config.web.throttle) if throttle is None else throttle
        )
        self.idempotency_store: SubmissionIdempotencyStore = (
            MemorySubmissionIdempotencyStore[RememberedReceipt](self.config.submissions.idempotency.memory_size)
            if idempotency_store is None
            else idempotency_store
        )
        self.signature_check: SubmissionSignatureCheck | None = signature_check
        self.builder_save_customizers: tuple[BuilderSaveCustomizer, ...] = _hook_sequence(
            "builder_save_customizers", builder_save_customizers
        )
        self.builder_save_validators: tuple[BuilderSaveValidator, ...] = _hook_sequence(
            "builder_save_validators", builder_save_validators
        )
        self.timestamp_request_customizers: tuple[TimestampRequestHook | TimestampRequestCustomizer, ...] = (
            _hook_sequence("timestamp_request_customizers", timestamp_request_customizers)
        )
        self.tsa_time_source: TsaTimeSource | None = tsa_time_source
        self.tsa_key_material: TsaKeyMaterial | None = tsa_key_material
        self.tsa_serial_allocator: TsaSerialAllocator = (
            MemoryTsaSerialAllocator(self.now) if tsa_serial_allocator is None else tsa_serial_allocator
        )
        self.tsa_log: TsaLog = MemoryTsaLog() if tsa_log is None else tsa_log
        self.tsa_client_store: TsaClientStore | None = tsa_client_store
        self.tsa_transport: TsaTransport | None = tsa_transport
        self.pdf_request_customizers: tuple[PdfRequestCustomizer, ...] = _hook_sequence(
            "pdf_request_customizers", pdf_request_customizers
        )
        self.pdf_result_validators: tuple[PdfResultValidator, ...] = _hook_sequence(
            "pdf_result_validators", pdf_result_validators
        )
        self.pdf_middleware: tuple[PdfKernelMiddleware, ...] = _hook_sequence("pdf_middleware", pdf_middleware)
        self.pdf_signer: PdfSigner | None = pdf_signer
        self.timestamper: Timestamper | None = timestamper
        self.pdf_trust_policy: PdfTrustPolicy | None = pdf_trust_policy
        self._pdf_probe = AbiProbe()
        self._gate_lock = threading.Lock()
        self._given_repository = form_repository
        self._given_runtime = runtime
        self._given_sandbox = sandbox
        self._engine_settings = engine_settings
        self._run_log = run_log
        self._trace = trace
        self._capture_sink = capture_sink
        self._probe = AbiProbe()
        self._sandbox_runtime: DatumSandbox | None = None
        self._settings: SandboxSettings | None = None
        self._lock = threading.RLock()
        self._routers: dict[str, dict[str, bool]] = {}
        self._endpoints: dict[str, str] = {}
        self._phase: _Phase = "new"
        self._reason: str | None = None
        self._started = False
        self._awaiter: Awaiter | None = None
        self._build_id: str | None = None
        self._running: _Running | None = None
        self._runtime_resources: ExitStack | None = None
        self._phases: list[tuple[str, float]] = []
        self._open_phase: tuple[str, float] | None = None
        self._began: float | None = None
        self.health_registry = HealthRegistry()
        self.health_registry.register("runtime", self._runtime_health)
        if self.config.enabled and self.config.builder.enabled:  # the forms store is a concern of the writes
            self.health_registry.register(FORMS_HEALTH, self._forms_health)
        self.health_registry.register("stores.snapshots", lambda: _store_health(self.snapshot_store))
        self.health_registry.register("stores.translations", lambda: _store_health(self.translation_store))
        self.health_registry.register(THROTTLE_HEALTH, lambda: _throttle_health(self.throttle))
        self.health_registry.register(IDEMPOTENCY_HEALTH, lambda: _idempotency_health(self.idempotency_store))
        if self._tsa_on():
            self.health_registry.register(TSA_HEALTH, self._tsa_health)
        if self._pdf_on() and self._pdf_extra_installed():
            self.health_registry.register(PDF_HEALTH, self._pdf_health)

    # -- state -------------------------------------------------------------------------------------------------------
    @property
    def started(self) -> bool:
        """Whether `start()` has completed and `stop()` has not run since (the runtime may still be down)."""
        return self._started

    @property
    def ready(self) -> bool:
        """Whether the runtime is up: started, probed and warmed (`readyz`)."""
        return self._phase == "ready" and self._sandbox_up()

    def _sandbox_up(self) -> bool:
        runtime = self._sandbox_runtime  # its state, not its status: `ready` is read on the event loop, with no I/O
        return runtime is not None and runtime.state is SandboxState.READY

    @property
    def build_id(self) -> str | None:
        """The build id the distributions agreed on at the last start."""
        return self._build_id

    @property
    def sandbox_settings(self) -> SandboxSettings:
        """The sandbox settings of the running start; before a start, the settings clamped without warnings."""
        if self._settings is not None:
            return self._settings
        return sandbox_settings(self.config)

    @property
    def limits(self) -> ProgramLimits:
        """The clamped run budgets of the running start; before a start, the settings clamped without warnings."""
        return self.sandbox_settings.limits

    @property
    def sandbox_runtime(self) -> DatumSandbox | None:
        """The sandbox library's lifecycle object of the running start (`datum_sandbox.DatumSandbox`)."""
        return self._sandbox_runtime

    @property
    def runtime(self) -> GuestRuntime | None:
        """The program runtime in use (the application's or the selected engine's), once started."""
        runtime = self._sandbox_runtime
        return runtime.runtime if runtime is not None else None

    @property
    def sandbox(self) -> Sandbox:
        """The composed sandbox; `ProgramUnavailableError` (503) while the runtime is not up."""
        runtime = self._sandbox_runtime
        if runtime is None or self._phase != "ready":
            raise ProgramUnavailableError("The Datum runtime is not running.")
        return runtime.sandbox

    def explain(self) -> SettingsReport:
        """Return the effective sandbox settings, where each came from, and what runs (the engine, the programs)."""
        runtime = self._sandbox_runtime
        return runtime.explain() if runtime is not None else self.sandbox_settings.explain()

    def settings_info(self) -> dict[str, object]:
        """Return the settings report as a management read serves it: JSON, with no value naming a host path."""
        return self.explain().to_json(hide_paths=True)

    @property
    def form_repository(self) -> FormDefinitionRepository | None:
        """The form repository: the application's, or the file repository the start loaded."""
        running = self._running
        return running.repository if running is not None else self._given_repository

    @property
    def bindings(self) -> HostBindings:
        """Which design-system binding each form route is drawn by (`datum.bindings`), of the running start."""
        bindings = self._services().bindings
        if bindings is None:  # a start always builds it
            raise DatumNotStartedError("Datum has not started: run its lifespan (or call start()) first")
        return bindings

    @property
    def asset_catalog(self) -> AssetCatalog | None:
        """The asset catalog the start resolved (assets on), else `None`."""
        running = self._running
        return running.asset_catalog if running is not None else None

    @property
    def definition_service(self) -> DefinitionService:
        """The definition read service of the running start."""
        return self._services().definitions

    @property
    def translation_service(self) -> TranslationService:
        """The translations read service of the running start."""
        return self._services().translations

    @property
    def data_source_service(self) -> DataSourceService:
        """The data-source service of the running start."""
        return self._services().data_sources

    @property
    def submission_service(self) -> SubmissionService:
        """The submission service of the running start (the submission receiver, with its `datum.submission` span)."""
        return self._services().submissions

    @property
    def builder_service(self) -> BuilderService:
        """The builder service of the running start (the writes; the routes decide who may call it)."""
        builder = self._services().builder
        if isinstance(builder, DatumConfigurationError):
            raise builder
        return builder

    @property
    def timestamp_authority(self) -> "TimestampAuthority | None":
        """The timestamp authority of the running start (built only while `datum.tsa.enabled`), else `None`."""
        timestamps = self._services().timestamps
        return None if timestamps is None else timestamps.authority

    @property
    def timestamp_gate(self) -> "TimestampGate | None":
        """Return the admission gate of `POST /tsa` (client store and flood counters of this start), else `None`."""
        timestamps = self._services().timestamps
        if timestamps is None:
            return None
        with self._gate_lock:
            if timestamps.gate is None:
                from datum_core.http.timestamp import TimestampGate  # noqa: PLC0415 - built on first use

                timestamps.gate = TimestampGate(
                    self.config.tsa,
                    clients=timestamps.clients,
                    flood=timestamps.flood,
                    clock=time.monotonic,
                    now=self.now,
                )
            return timestamps.gate

    @property
    def pdf_service(self) -> "PdfService | None":
        """The PDF service of the running start, built only while `datum.pdf.enabled`; `None` while it is off."""
        if not self._pdf_on():
            return None
        return self._services().pdf

    def _services(self) -> _Running:
        running = self._running
        if running is None:
            raise DatumNotStartedError("Datum has not started: run its lifespan (or call start()) first")
        return running

    def register_router(self, capability: str, switches: Mapping[str, bool]) -> None:
        """Record that a binding built `capability`'s router and the settings switches it reads (for `datum.W001`)."""
        self._routers[capability] = dict(switches)

    def register_endpoint(self, name: str, base: str) -> None:
        """Record where a capability's routes live (`tsa`, `webauthn`), for `host.json`'s `paths`.

        `base` is application-relative (the router's prefix); `host.json` adds the request's root path. One name has one
        base: a second router that names it is refused.
        """
        before = self._endpoints.get(name)
        if before is not None and before != base:
            raise ValueError(f"two routers name the endpoint base {name!r} ({before}, {base}): one name has one base")
        self._endpoints[name] = base

    @property
    def endpoints(self) -> dict[str, str]:
        """The endpoint bases the built routers registered, sorted by name (`host.json`'s `paths`)."""
        return dict(sorted(self._endpoints.items()))

    # -- start and stop ----------------------------------------------------------------------------------------------
    def start(self, *, awaiter: Awaiter | None = None) -> None:
        """Bring Datum up (see the module docstring); a second call while started does nothing.

        `awaiter` is the binding's bridge for async hooks, listeners and stores, handed over here; `None` means every
        one of them is sync, and an async one is then refused. The start has `datum.runtime.startup_budget` seconds: a
        timer thread reports an overrun (`datum.E004`) while a slow phase is still running, and the start raises it at
        the next phase boundary, undoing what it built (a synchronous compile cannot be cut short from outside).
        """
        with self._lock:
            if self._started:
                return
            timer = threading.Timer(self.config.runtime.startup_budget.total_seconds(), self._report_overrun)
            timer.name = "datum-start-budget"
            timer.daemon = True
            self._phases, self._open_phase, self._began = [], None, time.perf_counter()
            timer.start()
            try:
                self._start(awaiter)
            except BaseException as error:
                self._close_all()
                self._phase = "failed"
                self._reason = str(error) or type(error).__name__
                raise
            finally:
                timer.cancel()
                timer.join()  # the thread is gone when the start returns or raises: a failed start leaves none
                self._began = None

    def startup_phases(self) -> list[tuple[str, float]]:
        """Return the phases of the current or last start measured so far, in seconds; a running one says so."""
        phases = list(self._phases)
        open_phase = self._open_phase
        if open_phase is not None:
            phases.append((f"{open_phase[0]} (still running)", time.perf_counter() - open_phase[1]))
        return phases

    def startup_budget_error(self) -> DatumConfigurationError:
        """Return the `datum.E004` error for a start past `datum.runtime.startup_budget`, naming the phases so far."""
        budget = self.config.runtime.startup_budget.total_seconds()
        return DatumConfigurationError.from_checks([startup_over_budget(budget, self.startup_phases())])

    def _report_overrun(self) -> None:
        if self._began is None:  # the start already met its budget (or is over)
            return
        logger.error("%s", self.startup_budget_error().message)

    @contextmanager
    def _timed(self, name: str) -> Iterator[None]:
        """Measure one start phase, then meet the budget at its boundary."""
        began = time.perf_counter()
        self._open_phase = (name, began)
        try:
            yield
        finally:
            self._phases.append((name, time.perf_counter() - began))
            self._open_phase = None
        self._checkpoint()

    def _checkpoint(self) -> None:
        """Raise `datum.E004` when the start has run past the budget (a recheck's rebuild is not a start)."""
        began = self._began
        over = began is not None and time.perf_counter() - began > self.config.runtime.startup_budget.total_seconds()
        if self._phase == "starting" and over:
            raise self.startup_budget_error()

    def stop(self, *, deadline: float | None = None) -> None:
        """Close what the start built (the services, then the runtime, which interrupts its runs); then a no-op.

        `deadline` (`time.monotonic`) is the one shutdown deadline a binding's drain started from: the failed-run
        capture drains in what is left of it. Without one it is `datum.runtime.shutdown_grace` from now.
        """
        with self._lock:
            was_started = self._started
            self._started = False
            if was_started:
                self._phase = "stopped"
                self._reason = None
            self._close_all(deadline)

    def recheck(self) -> HealthReport:
        """Re-prove the sandbox (the ABI and a smoke run) or, when the runtime is down, build it again and prove it.

        Before a start (or after a stop) it changes nothing. Returns the health report afterwards.
        """
        with self._lock:
            runtime = self._sandbox_runtime
            if self._started and runtime is not None:
                status = runtime.recheck()
                self._phase = "ready" if status.is_up else "down"
                self._reason = status.reason if not status.is_up else None
            return self.health()

    def _start(self, awaiter: Awaiter | None) -> None:
        self._phase = "starting"
        self._reason = None
        with self._timed("build ids"):
            build_id = agree_build_ids()
        with self._timed("checks"):
            settings = sandbox_settings(self.config)
            limits = settings.limits
            found = silence([*settings.checks, *self._start_checks(limits)], self.config.silenced_checks)
            raise_errors(found)
            self.events.bind(awaiter)
            self.events.validate()
            log_checks(found)
        with self._timed("forms and assets"):
            repository = self._given_repository or FileFormDefinitionRepository(self._form_locations())
            catalog = self._asset_catalog()
            self._awaiter = awaiter
            self._settings = settings
            self._build_id = build_id
            self._running = self._services_for(repository, catalog, awaiter)
        runtime = self._sandbox_for(settings)
        self._sandbox_runtime = runtime
        self._runtime_resources = ExitStack()
        self._runtime_resources.callback(watch_slots(runtime.slot_limit))
        runtime.start(phase=self._timed)  # a refusal raises; any other failure raises with fail_fast, else DOWN
        status = runtime.status()
        self._started = True
        if not status.is_up:
            self._phase = "down"
            self._reason = status.reason
            return
        self._checkpoint()
        self._began = None
        self._phase = "ready"

    def _close_all(self, deadline: float | None = None) -> None:
        running, self._running = self._running, None
        try:
            if running is not None:
                running.resources.close()
        finally:
            self._close_runtime(deadline)

    def _close_runtime(self, deadline: float | None = None) -> None:
        resources, self._runtime_resources = self._runtime_resources, None
        runtime = self._sandbox_runtime
        try:
            if runtime is not None:
                runtime.stop(deadline=deadline)
        finally:
            if resources is not None:
                resources.close()

    def _sandbox_for(self, settings: SandboxSettings) -> DatumSandbox:
        """Build the sandbox library's lifecycle for this start: the settings and every seam Datum was given."""
        running = self._running
        return DatumSandbox(
            settings,
            runtime=self._given_runtime,
            sandbox=self._given_sandbox,
            engine_settings=self._engine_settings,
            run_log=self._run_log,
            sandbox_middleware=self.sandbox_middleware,
            observation=self._observe,
            pdf=running is not None and running.pdf is not None,
            pdf_middleware=self.pdf_middleware,
            pdf_observation=self._observe_pdf,
            now=self.now,
            trace=self._trace,
            capture_sink=self._capture_sink,
            on_ready=self._publish_ready,
            probe=self._probe,
            pdf_probe=self._pdf_probe,
            unobserved=quiet,
        )

    def _publish_ready(self, ready: SandboxReady) -> None:
        self._began = None  # the budget is met: the ready publication is not a measured phase, so no overrun report
        self._started = True
        self._phase = "ready"
        self._reason = None
        self.events.publish(
            DatumRuntimeReadyEvent(
                engine=ready.engine,
                sandbox_abi=ready.sandbox_abi,
                pdf_abi=ready.pdf_abi,
                warm_up_millis=ready.warm_up_millis,
            )
        )

    def _services_for(
        self, repository: FormDefinitionRepository, catalog: AssetCatalog | None, awaiter: Awaiter | None
    ) -> _Running:
        forms = self.config.forms
        events = self.events.scoped()  # closed at stop: a call the grace abandons publishes nothing further
        timestamps = self._timestamps(events, awaiter)  # first: a key that cannot be read leaves nothing half-built
        pdf_parts = self._pdf_parts(timestamps)  # the PDF key and anchors are read here, for the same reason
        bindings = HostBindings.build(self.config.bindings)  # a binding or PDF theme that cannot work stops the start
        definitions = DefinitionService(
            repository=repository,
            snapshots=self.snapshot_store,
            sandbox=lambda: self.sandbox,
            customizers=self.definition_customizers,
            cache_size=forms.snapshots.public_copy_cache_size,
            awaiter=awaiter,
        )
        translations = TranslationService(repository=repository, store=self.translation_store)
        data_sources = DataSourceService(
            self.data_sources,
            timeout=forms.data_sources.timeout.total_seconds(),
            max_threads=forms.data_sources.max_threads,
            awaiter=awaiter,
        )
        submissions = ObservedSubmissionService(
            repository=observed_repository(repository),
            sandbox=lambda: self.sandbox,  # read once per call: the runtime may be down
            idempotency_store=self.idempotency_store,
            events=events,
            max_document_bytes=int(self.config.web.api.max_body_size),
            handler=self.handler,
            # An async throttle answers an awaitable, which the service resolves through the start's awaiter.
            throttle=cast("SubmissionThrottle", self.throttle),
            data_sources=data_sources,
            pre_checks=self.pre_checks,
            context_contributors=self.context_contributors,
            host_options_customizers=self.host_options_customizers,
            rules_providers=self.rules_providers,
            validators=self.validators,
            signature_check=self.signature_check,
            unknown_fields=self.config.host.unknown_fields,
            log_level=self.config.host.log_level,
            awaiter=awaiter,
            translation_store=self.translation_store,
            host_context=self.host_context,
        )
        builder: BuilderService | DatumConfigurationError
        try:
            types = known_component_types()
        except DatumConfigurationError as error:
            if self.config.enabled and self.config.builder.enabled:
                raise
            types = None
            builder = error  # never a service over an empty type list: every component would warn
        if types is not None:
            builder = BuilderService(
                repository=repository,
                snapshots=self.snapshot_store,
                translations=self.translation_store,
                sandbox=lambda: self.sandbox,
                types=types,
                events=events,
                max_definition_bytes=int(self.config.builder.max_definition_size),
                now=self.now,
                customizers=self.builder_save_customizers,
                validators=self.builder_save_validators,
                awaiter=awaiter,
            )
        pdf = (
            None
            if pdf_parts is None
            else self._pdf_service_for(pdf_parts, repository, submissions, events, awaiter, bindings=bindings)
        )
        resources = ExitStack()
        resources.callback(events.close)
        resources.callback(data_sources.close)
        return _Running(
            resources,
            repository,
            definitions,
            translations,
            data_sources,
            submissions,
            catalog,
            builder,
            timestamps,
            pdf,
            bindings,
        )

    # -- the PDF service ------------------------------------------------------------------------
    def _pdf_on(self) -> bool:
        return self.config.enabled and self.config.pdf.enabled

    def _pdf_extra_installed(self) -> bool:
        """Whether `argusvane-datum-core[pdf]` is installed (found, not imported: the modules need it)."""
        return all(importlib.util.find_spec(name) is not None for name in _PDF_EXTRA_MODULES)

    def _pdf_demanded(self) -> bool:
        """Whether the configuration asks something of the PDF capability: the seal, a key, a PDF route or a seam."""
        config = self.config
        signing = config.pdf.signing
        endpoints = config.web.api.endpoints
        routes = any(getattr(endpoints, name) is True for name in ("pdf", "fill", "sign", "verify", "certificate"))
        key = bool(signing.pkcs12_file or signing.key_file or signing.cert_file)
        return config.pdf.seal.enabled or routes or key or self.pdf_signer is not None

    def _pdf_timestamp_source(self) -> "TimestampSource":
        """Name where the seal's tokens come from, in the order the seal chooses (it builds nothing to say so)."""
        if not self._pdf_on():
            return "none"
        if self.timestamper is not None:
            return "custom"
        if self.config.pdf.signing.tsa.url is not None:
            return "server"
        return "site" if self._tsa_on() else "none"

    def _pdf_timestamp_word(self) -> "TimestampSource":
        """Name the timestamp source of the PDF service that was built; `none` when there is none (nothing asked).

        Before a start there is no service to ask, so the configuration answers; once started the built service does (a
        deployment without `argusvane-datum-core[pdf]` that asks nothing of PDFs has no source whatever its settings
        say).
        """
        running = self._running
        if running is None:
            return self._pdf_timestamp_source()
        return "none" if running.pdf is None else running.pdf.timestamp_source

    def _pdf_parts(self, timestamps: _Timestamps | None) -> "_PdfParts | None":
        """Read the signer and the anchors once and choose the timestamper; `None` while the capability is off.

        The PDF modules are imported here, not at the top of the module: `argusvane-datum-core[pdf]` brings
        cryptography, and a deployment with the capability off never imports it. A key or an anchor file that cannot be
        read stops the start naming its setting.
        """
        if not self._pdf_on():
            return None
        if not (self._pdf_extra_installed() or self._pdf_demanded()):
            return None  # the capability is on by default; a deployment that asks nothing of it needs no extra
        try:
            from datum_core.pdf.seal import PdfSeal, choose_timestamper  # noqa: PLC0415 - needs the extra
            from datum_core.pdf.signer import KeyFilePdfSigner  # noqa: PLC0415
            from datum_core.pdf.trust import PdfTrustPolicy  # noqa: PLC0415
        except ModuleNotFoundError as error:
            if (error.name or "").partition(".")[0] not in _PDF_EXTRA_MODULES:
                raise
            missing = (error.name or "").partition(".")[0]
            raise DatumConfigurationError(
                f"{_PDF} is enabled but the pdf extra is not installed "
                f"({missing} is missing): install argusvane-datum-core[pdf]",
                hint="install argusvane-datum-core[pdf], or set datum.pdf.enabled to false",
            ) from error
        signing = self.config.pdf.signing
        signer = self.pdf_signer
        if signer is None and (signing.pkcs12_file or signing.key_file or signing.cert_file):
            signer = KeyFilePdfSigner.from_settings(signing)
        authority = None if timestamps is None else timestamps.authority
        timestamper, source = choose_timestamper(
            self.timestamper, options=signing.tsa, transport=self.tsa_transport, authority=authority
        )
        seal = PdfSeal(
            self.config.pdf.seal, signer=signer, timestamper=timestamper, timestamp_source=source, now=self.now
        )
        site: list[bytes] = []
        if seal.server_signer is not None:
            site.append(seal.server_signer.certificates()[0])
        if authority is not None:
            site.append(authority.certificate_chain_der[0])
        policy = self.pdf_trust_policy or PdfTrustPolicy.standard(signing, site_certificates=site)
        known = () if authority is None else tuple(authority.certificate_chain_der)
        return _PdfParts(seal, policy, known)

    def _pdf_service_for(
        self,
        parts: "_PdfParts",
        repository: FormDefinitionRepository,
        submissions: SubmissionService,
        events: EventDispatcher,
        awaiter: Awaiter | None,
        *,
        bindings: HostBindings,
    ) -> "PdfService":
        from datum_core.observe_pdf import ObservedPdfService  # noqa: PLC0415 - needs the extra
        from datum_core.pdf.outcomes import PdfUnavailableError  # noqa: PLC0415

        def kernel() -> PdfKernel:
            runtime = self._sandbox_runtime
            current = runtime.pdf_kernel if runtime is not None else None
            if self._phase != "ready" or current is None or runtime is None:
                down = (runtime.pdf_down or runtime.pdf_absent) if runtime is not None else None
                raise PdfUnavailableError(down or "the PDF program is not running")
            return current

        return ObservedPdfService(
            kernel=kernel,
            submissions=submissions,
            repository=observed_repository(repository),
            seal=parts.seal,
            trust_policy=parts.policy,
            events=events,
            now=self.now,
            verify_max_bytes=self.limits.verify_max_bytes,  # the clamped value, as the verify route reads it
            fonts=self.config.pdf.fonts,
            throttle=cast("SubmissionThrottle", self.throttle),
            customizers=self.pdf_request_customizers,
            validators=self.pdf_result_validators,
            known_certificates=parts.known,
            awaiter=awaiter,
            translation_store=self.translation_store,
            bindings=bindings,
        )

    def _observe_pdf(self, kernel: PdfKernel) -> PdfKernel:
        return ObservedPdfKernel(kernel, lambda: self._engine_info().mode, self._pdf_interrupted)

    def _pdf_interrupted(self, error: SandboxError, elapsed: float) -> None:
        reason = _INTERRUPTS.get(error.reason)
        if reason is not None:
            self.events.publish(
                SandboxRunInterruptedEvent(program=ProgramKind.PDF.value, reason=reason, elapsed=elapsed)
            )

    # -- the timestamp authority ------------------------------------------------------------------
    def _tsa_on(self) -> bool:
        return self.config.enabled and self.config.tsa.enabled

    def _timestamps(self, events: EventDispatcher, awaiter: Awaiter | None) -> _Timestamps | None:
        """Build the authority from the seams and the settings, once per start; `None` while the server is off.

        The authority is imported here, not at the top of the module: `argusvane-datum-core[timestamp]` brings
        asn1crypto and cryptography, and a deployment without the server never imports either. Its events go to the
        start's scoped dispatcher, which `stop()` closes: after that no serial is allocated and nothing is signed.
        """
        if not self._tsa_on():
            return None
        tsa = self.config.tsa
        try:
            from datum_core.timestamp.authority import TimestampAuthority  # noqa: PLC0415 - needs the extra
            from datum_core.timestamp.certificate import read_retired_certificates  # noqa: PLC0415
            from datum_core.timestamp.query import policy_problem  # noqa: PLC0415
        except ModuleNotFoundError as error:
            if (error.name or "").partition(".")[0] not in _TSA_EXTRA_MODULES:
                raise
            missing = (error.name or "").partition(".")[0]
            raise DatumConfigurationError(
                f"{_TSA} is enabled but the timestamp extra is not installed ({missing} is missing)",
                hint="install argusvane-datum-core[timestamp], or set datum.tsa.enabled to false",
            ) from error
        if tsa.policy is None:
            raise DatumConfigurationError(
                f"{_TSA}.policy is not set; the timestamp server issues under one policy OID",
                hint="set datum.tsa.policy to an OID your organisation owns",
            )
        for setting, policy in (
            (f"{_TSA}.policy", tsa.policy),
            *((f"{_TSA}.accepted_policies", accepted) for accepted in tsa.accepted_policies),
        ):
            problem = policy_problem(policy)
            if problem is not None:
                raise DatumConfigurationError(f"{setting} is refused: {problem}", hint=f"fix {setting}")
        key = self.tsa_key_material if self.tsa_key_material is not None else self._tsa_signing_key()
        try:
            authority = TimestampAuthority(
                key,
                self.tsa_serial_allocator,
                policy=tsa.policy,
                accepted_policies=tsa.accepted_policies,
                accuracy=tsa.accuracy.total_seconds(),
                time_source=self.tsa_time_source,
                now=self.now,
                customizers=self.timestamp_request_customizers,
                log=self.tsa_log,
                events=events,
                awaiter=awaiter,
                retired_certificates=read_retired_certificates(tsa.retired_certificates),
            )
        except ValueError as error:
            if isinstance(error, DatumConfigurationError):
                raise
            raise DatumConfigurationError(f"{_TSA} cannot be set up: {error}", hint=f"fix {_TSA}") from error
        return _Timestamps(authority, InMemoryTsaFlood(), self._tsa_clients())

    def _tsa_signing_key(self) -> TsaKeyMaterial:
        """Read the key `datum.tsa.signer` names (once), or make the throwaway one `self_signed` asks for."""
        from datum_core.timestamp.certificate import SelfSignedTsaCertificate  # noqa: PLC0415 - needs the extra
        from datum_core.timestamp.keys import KeyFileTsaKeyMaterial  # noqa: PLC0415

        signer = self.config.tsa.signer
        if not signer.self_signed:
            return KeyFileTsaKeyMaterial.from_settings(signer)
        if signer.pkcs12_file or signer.key_file or signer.cert_file:
            raise DatumConfigurationError(
                f"{_TSA}.signer.self_signed is true and a key file is named as well",
                hint="name a key (pkcs12_file, or key_file and cert_file) or set self_signed, not both",
            )
        return SelfSignedTsaCertificate.generate(self.now())

    def _tsa_clients(self) -> TsaClientStore:
        tsa = self.config.tsa
        if self.tsa_client_store is not None:
            return self.tsa_client_store
        if tsa.client_store.value == "sql" and tsa.access.value == "clients":
            raise DatumConfigurationError(
                f"{_TSA}.client_store is sql but Datum was given no tsa_client_store",
                hint="pass tsa_client_store=..., or set datum.tsa.client_store to settings",
            )
        return SettingsTsaClientStore.from_settings(tsa)

    # -- the observation (innermost sandbox layer) -------------------------------------------------------------------
    def _observe(self, sandbox: Sandbox) -> Sandbox:
        return _Observed(sandbox, self.events, lambda: self._engine_info().mode)

    def _forms_reachable(self) -> bool:
        return self.config.enabled and (self.config.web.api.endpoints.definition or self.config.builder.enabled)

    def _forms_resolved(self) -> bool:
        """Whether a route that looks a form up by its id is on (`inspect` looks nothing up)."""
        config = self.config
        endpoints = config.web.api.endpoints
        names = ("definition", "submissions", "validate", "test", "pdf", "fill")
        return config.enabled and (config.builder.enabled or any(getattr(endpoints, name) is True for name in names))

    def _form_locations(self) -> tuple[str, ...]:
        # The file repository loads eagerly and warns about a location matching nothing: only when a form route is on,
        # so an application with none does not hear about the default location.
        return self.config.forms.locations if self._forms_resolved() else ()

    def _asset_catalog(self) -> AssetCatalog | None:
        config = self.config
        if not (config.enabled and config.web.assets.enabled):
            return None
        return AssetCatalog.installed(
            builder_enabled=config.builder.enabled,
            omit_features=config.web.assets.omit_features,
            withheld=self.withheld_assets,
        )

    # -- checks ----------------------------------------------------------------------------------------
    def _start_checks(self, limits: ProgramLimits) -> list[DatumCheck]:
        found = [
            *self._builder_store_checks(),
            *self._memory_store_checks(),
            *self._submission_checks(),
            *self._tsa_store_checks(),
            *self._pdf_checks(),
        ]
        memory = startup_memory_check(limits, expected_workers(self.config))
        if memory is not None:
            found.append(memory)
        found.extend(CompositeDataSourceProvider(self.data_sources).checks())
        found.extend(self._router_checks())
        zone = process_zone()
        if zone.check is not None and self.config.host.time_zone == zone.name:
            found.append(zone.check)
        found.append(self._routes_on())
        return found

    def _memory_stores(self) -> Iterator[tuple[str, MemoryDefinitionSnapshotStore | MemoryTranslationCatalogStore]]:
        for store in (self.snapshot_store, self.translation_store):
            if isinstance(store, MemoryDefinitionSnapshotStore | MemoryTranslationCatalogStore):
                yield store.health_name, store

    def _memory_repository(self) -> MemoryFormDefinitionRepository | None:
        """Return the in-memory form repository the application gave, else None (the file repository is read-only)."""
        given = self._given_repository
        return given if isinstance(given, MemoryFormDefinitionRepository) else None

    def _memory_store_checks(self) -> list[DatumCheck]:
        if not self._forms_reachable():
            return []
        found = [store.check() for _, store in self._memory_stores()]
        repository = self._memory_repository()
        if repository is not None and self.config.enabled and self.config.builder.enabled:
            found.append(repository.check())
        return found

    def _submissions_reachable(self) -> bool:
        endpoints = self.config.web.api.endpoints
        return self.config.enabled and any(
            getattr(endpoints, name) is True for name in ("submissions", "validate", "test", "inspect")
        )

    def _submission_checks(self) -> list[DatumCheck]:
        """`datum.W003` and the per-process `datum.W004` notices, for a deployment whose routes serve submissions."""
        if not self._submissions_reachable():
            return []
        found: list[DatumCheck] = []
        if self.default_handler:
            found.append(default_handler_in_use())
        if isinstance(self.throttle, LimitsThrottleBase):
            found.extend(
                check
                for check in (self.throttle.storage_check(), self.throttle.check_key_salt(), self.throttle.check_w004())
                if check is not None
            )
        store = self.idempotency_store
        if isinstance(store, MemorySubmissionIdempotencyStore):
            found.append(cast("MemorySubmissionIdempotencyStore[RememberedReceipt]", store).check())
        return found

    def _tsa_memory_stores(self) -> list[tuple[str, str, str]]:
        """Name the TSA trust-state stores kept in memory: the store, the protocol that replaces it, the consequence."""
        stores: list[tuple[str, str, str]] = []
        if isinstance(self.tsa_serial_allocator, MemoryTsaSerialAllocator):
            stores.append(("its serial allocator", "TsaSerialAllocator", _TSA_SERIALS_CONSEQUENCE))
        if isinstance(self.tsa_log, MemoryTsaLog):
            stores.append(("its issue log", "TsaLog", _TSA_LOG_CONSEQUENCE))
        return stores

    def _tsa_store_checks(self) -> list[DatumCheck]:
        """`datum.E001` for each TSA store in memory, or `datum.W009` for each once the flag acknowledges it."""
        if not self._tsa_on():
            return []
        acknowledged = self.config.tsa.allow_memory_stores
        found: list[DatumCheck] = []
        for store, protocol, consequence in self._tsa_memory_stores():
            if acknowledged:
                found.append(trust_store_acknowledged(_TSA, store=store, flag=_TSA_FLAG))
            else:
                found.append(
                    trust_store_refused(
                        _TSA,
                        store=store,
                        table=_TSA_TABLE,
                        consequence=consequence,
                        protocol=protocol,
                        flag=_TSA_FLAG,
                    )
                )
        return found

    def _pdf_checks(self) -> list[DatumCheck]:
        """`datum.W013` (no signing key), `datum.W011` (timestamps asked, a server key, no source), `W012`, `I002`.

        W013 only while the PDF capability and its seal are on; the other three while the capability is on and the seal
        or the `sign` route is (`sign` seals with the server key and asks a token whatever the seal switch says). The
        in-process authority is a source of its own and is never counted as the application's `timestamper`, so it
        raises neither unused-setting notice.
        """
        seal_on = self.config.pdf.seal.enabled
        if not (self._pdf_on() and (seal_on or self.config.web.api.endpoints.sign is True)):
            return []
        found: list[DatumCheck] = []
        signing = self.config.pdf.signing
        named = bool(signing.pkcs12_file or signing.key_file or signing.cert_file)
        if seal_on and not named and not self._pdf_server_signer_given():
            found.append(pdf_seal_without_key())
        server_key = named or self._pdf_server_signer_given()
        if self.config.pdf.seal.timestamp and server_key and self._pdf_timestamp_source() == "none":
            found.append(pdf_timestamp_without_source())
        if self.timestamper is not None:
            tsa = signing.tsa
            if tsa.policy is not None:
                found.append(pdf_tsa_policy_unused())
            if tsa.url is not None or tsa.bearer_token is not None or tsa.basic_user or tsa.basic_password is not None:
                found.append(pdf_tsa_client_unused())
        return found

    def _pdf_server_signer_given(self) -> bool:
        """Whether the application gave a signer that is the server's own key (the test seal is not)."""
        signer = self.pdf_signer
        if signer is None:
            return False
        if not self._pdf_extra_installed():
            return True  # counts as the server's; _pdf_parts then names argusvane-datum-core[pdf]
        from datum_core.pdf.signer import TestSealSigner  # noqa: PLC0415 - a signer was given, so the extra is there

        return not isinstance(signer, TestSealSigner)

    def _builder_store_checks(self) -> list[DatumCheck]:
        config = self.config
        workers = expected_workers(config)
        memory = [name for name, _ in self._memory_stores()]
        if self._memory_repository() is not None:
            memory.insert(0, MemoryFormDefinitionRepository.health_name)
        if not (config.enabled and config.builder.enabled and workers > 1 and memory):
            return []
        return [
            DatumCheck(
                CheckLevel.ERROR,
                E002,
                f"the builder is on with in-memory stores ({', '.join(memory)}) and {workers} workers expected;"
                " a save on one worker is invisible on the others",
                "give Datum shared stores (a SQL engine or your own), or set datum.workers_expected to 1",
            )
        ]

    def _forms_health(self) -> ComponentHealth:
        repository = self.form_repository
        if isinstance(repository, MemoryFormDefinitionRepository):
            return ComponentHealth.up(**repository.details())
        return ComponentHealth.up(store=_repository_kind(repository))

    def _router_checks(self) -> list[DatumCheck]:
        found: list[DatumCheck] = []
        for capability, switches in sorted(self._routers.items()):
            if self.config.enabled and any(switches.values()):
                continue
            names = ["datum.enabled"] if not self.config.enabled else sorted(switches)
            found.append(
                DatumCheck(
                    CheckLevel.WARNING,
                    W001,
                    f"the Datum router {capability} was included but every switch it reads is off, so it serves no"
                    " route",
                    f"set {' or '.join(names)} to true, or do not include the router",
                )
            )
        return found

    def _routes_on(self) -> DatumCheck:
        config = self.config
        on: list[str] = []
        if config.enabled:
            endpoints = config.web.api.endpoints
            on = [name for name in type(endpoints).model_fields if getattr(endpoints, name) is True]
            if config.web.assets.enabled:
                on.append("assets")
        listing = ", ".join(on) if on else "none (set datum.web.api.endpoints.* or datum.web.assets.enabled)"
        return DatumCheck(CheckLevel.INFO, I001, f"Datum routes on: {listing}")

    # -- health and info ---------------------------------------------------------------------------------------------
    def health(self) -> HealthReport:
        """Run every registered health contributor and return the flat report."""
        return self.health_registry.health()

    def _engine_info(self) -> EngineInfo:
        runtime = self._sandbox_runtime
        if runtime is not None:
            return runtime.engine_info()
        sandbox = self._given_sandbox
        name = type(sandbox).__name__ if sandbox is not None else "none"
        return EngineInfo(id=name, release="", mode="unknown")

    def _runtime_health(self) -> ComponentHealth:
        phase = self._phase
        if phase == "new":
            return ComponentHealth.down(_LIFESPAN_NOT_RUN)
        if phase == "starting":
            return ComponentHealth.down("starting")
        if phase == "stopped":
            return ComponentHealth.down("stopped")
        runtime = self._sandbox_runtime
        status = runtime.status() if runtime is not None and phase == "ready" else None
        if status is None or not status.is_up:
            reason = (status.reason if status is not None else None) or self._reason or "start failed"
            return ComponentHealth.down(reason)
        return ComponentHealth.up(**status.details)

    def _pdf_health(self) -> ComponentHealth:
        """Report the PDF capability: the engine and its mode.

        Down with the reason when the PDF program failed its proof; up with `unavailable` when the engine simply cannot
        run it (the `runtime` component says so too). Never a path, a key or a certificate. It never fails `readyz`,
        which reads the `runtime` component alone.
        """
        if self._running is None or self._running.pdf is None:
            return ComponentHealth.down(_LIFESPAN_NOT_RUN if self._phase == "new" else self._phase)
        info = self._engine_info()
        runtime = self._sandbox_runtime
        if self._phase != "ready" or runtime is None:
            return ComponentHealth.down(self._reason or self._phase, engine=info.id, engineMode=info.mode)
        kernel = runtime.pdf_kernel
        if kernel is None and runtime.pdf_absent is not None:  # the engine's choice, not a failure
            return ComponentHealth.up(engine=info.id, engineMode=info.mode, unavailable=runtime.pdf_absent)
        if kernel is None:
            reason = runtime.pdf_down or "the PDF program is not running"
            return ComponentHealth.down(reason, engine=info.id, engineMode=info.mode)
        return ComponentHealth.up(engine=info.id, engineMode=info.mode)

    def _tsa_health(self) -> ComponentHealth:
        """Report the timestamp server: how its serials are kept, whether the time can be vouched for, the flood.

        Down only for the time source (`time: unavailable (<reason>)`); never a path, a password or a key id. It
        reports the outcome of the authority's LAST time read (`not read yet` before the first token) and never calls
        the time source: `health()` runs on the event loop, where an async source cannot be awaited and a slow one
        would block every request. The reason is the source's own words, which carry no host or address; a source
        that raises reads as "the time source failed" and its message goes to the `datum.tsa` log. It never fails
        `readyz`.
        """
        if self._running is None or self._running.timestamps is None:
            return ComponentHealth.down(_LIFESPAN_NOT_RUN if self._phase == "new" else self._phase)
        details: dict[str, object] = {"serials": self._tsa_serials_word(), "flood": "memory (per process)"}
        authority = self._running.timestamps.authority
        if not authority.time_read:
            return ComponentHealth.up(time="not read yet", **details)
        reason = authority.last_time_problem
        if reason is None:
            return ComponentHealth.up(time="available", **details)
        return ComponentHealth.down(f"time: unavailable ({reason})", time=f"unavailable ({reason})", **details)

    def _tsa_serials_word(self) -> str:
        """How the trust-state stores are kept: `memory`, `custom`, or each store named when the pair is mixed.

        A memory store reads `memory`, and `memory (acknowledged)` once `datum.tsa.allow_memory_stores` is set. Two
        memory stores or two supplied ones read as one word; a mixed pair names each, for example
        `allocator: custom, log: memory (acknowledged)`. Health and `info` share this helper.
        """
        memory = "memory (acknowledged)" if self.config.tsa.allow_memory_stores else "memory"
        allocator = memory if isinstance(self.tsa_serial_allocator, MemoryTsaSerialAllocator) else "custom"
        log = memory if isinstance(self.tsa_log, MemoryTsaLog) else "custom"
        if allocator == log:
            return allocator
        return f"allocator: {allocator}, log: {log}"

    def _tsa_info(self) -> dict[str, object]:
        if not self._tsa_on():
            return {"enabled": False}
        return {
            "enabled": True,
            "access": self.config.tsa.access.value,
            "customizers": len(self.timestamp_request_customizers),
            "serials": self._tsa_serials_word(),
        }

    def _pdf_runnable(self) -> bool:
        runtime = self._sandbox_runtime
        return runtime is not None and runtime.pdf_runnable

    def info(self) -> dict[str, object]:
        """Return the flat `info` body: Datum's version, the ABIs, the build id, the engine and the capabilities."""
        sandbox_abi, pdf_abi = declared_abis()
        engine = self._engine_info() if self._started else None
        return {
            "engineVersion": core_version(),
            "sandboxAbi": sandbox_abi,
            "pdfAbi": pdf_abi,
            "buildId": self._build_id,
            "engine": engine.id if engine else None,
            "engineRelease": engine.release if engine else None,
            "engineMode": engine.mode if engine else None,
            "pdfCapable": self._pdf_runnable() if engine else False,
            "engineNotes": [without_paths(note) for note in engine.notes] if engine else [],  # no host path
            "capabilities": {
                "forms": {
                    "snapshots": _store_kind(self.snapshot_store),
                    "translations": _store_kind(self.translation_store),
                    "dataSources": len(self.data_sources),
                    "definitionCustomizers": len(self.definition_customizers),
                },
                "builder": {
                    "enabled": self.config.enabled and self.config.builder.enabled,
                    "repository": _repository_kind(self.form_repository),
                    "customizers": len(self.builder_save_customizers),
                    "validators": len(self.builder_save_validators),
                },
                "assets": {"enabled": self.config.enabled and self.config.web.assets.enabled},
                "throttle": _throttle_kind(self.throttle),
                "throttleDegraded": _throttle_degraded(self.throttle),
                "idempotency": _store_kind_of(self.idempotency_store),
                "tsa": self._tsa_info(),
                "timestamp": self._pdf_timestamp_word(),
            },
        }


class _Observed:
    """Datum's observation, the innermost sandbox layer: a span and the instruments around every call, and the event.

    A call's span is `datum.sandbox.run` and its metrics are recorded here, not in the routes, so a queue consumer or a
    batch that calls the service gets them too (`datum_core.observe`). A stopped run publishes its event.
    """

    def __init__(self, inner: Sandbox, events: EventDispatcher, engine_mode: Callable[[], str]) -> None:
        self._inner = inner
        self._events = events
        self._engine_mode = engine_mode

    @property
    def program(self) -> Program:
        return self._inner.program

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        return self._watched("validate", lambda: self._inner.validate(context, rules, real=real), ran=_elapsed)

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        return self._watched(
            "inspect",
            lambda: self._inner.inspect(op, definition, formula_errors=formula_errors, extra=extra, rules=rules),
        )

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        return self._watched("check", lambda: self._inner.check(definition, types, rules))

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        return self._watched("public", lambda: self._inner.public_copy(definition))

    def smoke(self) -> Smoke:
        return self._watched("smoke", self._inner.smoke, ran=_elapsed)

    def prove_abi(self) -> None:
        self._watched("abi", self._inner.prove_abi)

    def _watched[T](
        self, op: str, call: Callable[[], T], *, ran: Callable[[T], float | None] = lambda _result: None
    ) -> T:
        began = time.perf_counter()
        try:
            return run_observed(op, self._engine_mode(), call, ran=ran)
        except SandboxError as error:
            reason = _INTERRUPTS.get(error.reason)
            if reason is not None:
                self._events.publish(
                    SandboxRunInterruptedEvent(
                        program=ProgramKind.SANDBOX.value, reason=reason, elapsed=time.perf_counter() - began
                    )
                )
            raise


def _elapsed(result: SandboxResult | Smoke) -> float:
    return result.elapsed


# -- module helpers ------------------------------------------------------------------------------------------------
def expected_workers(config: DatumConfig) -> int:
    """`datum.workers_expected`, else `WEB_CONCURRENCY` as a hint, else 1."""
    if config.workers_expected is not None:
        return config.workers_expected
    hint = os.environ.get("WEB_CONCURRENCY", "").strip()
    return int(hint) if hint.isdecimal() and int(hint) > 0 else 1


def agree_build_ids() -> str:
    """Hold every installed resource distribution and argusvane-datum-core to one build id.

    Refuse naming both otherwise.

    The shared agreement (`datum_core.http.agree_build_ids`) with argusvane-datum-core's own `datum-build.json` passed
    in.
    """
    return agree_resource_build_ids(
        packages=RESOURCE_PACKAGES, markers=[AssetSource.build_marker(CORE_PACKAGE[0], name=CORE_PACKAGE[1])]
    )


def core_version() -> str:
    """argusvane-datum-core's own version (the instrumentation scope's version too)."""
    return CORE_VERSION


def _repository_kind(repository: object) -> str:
    """Name the form repository as `info()` does: `memory`, `files` (Datum's own, the default) or `custom`."""
    if repository is None or isinstance(repository, FileFormDefinitionRepository):
        return "files"
    return "memory" if isinstance(repository, MemoryFormDefinitionRepository) else "custom"


def _hook_sequence[T](name: str, value: Sequence[T]) -> tuple[T, ...]:
    """Keep a hook sequence in list order; a string, a dict, a bare iterable or a non-callable item is a `TypeError`."""
    given: object = value
    if not isinstance(given, Sequence) or isinstance(given, str | bytes):
        raise TypeError(f"{name} is a sequence of callables, not {type(value).__name__}")
    items = tuple(value)
    for item in items:
        if not callable(item):
            raise TypeError(f"{name} holds callables, not {type(item).__name__}")
    return items


def _throttle_kind(throttle: object) -> str:
    """Name the throttle's counter store as `info()` does: `memory`, the limits scheme (`redis`...) or `custom`."""
    if isinstance(throttle, LimitsThrottleBase):
        return str(throttle.details().get("store", "custom"))
    return "custom"


def _throttle_degraded(throttle: object) -> bool:
    """Whether the throttle's counter storage failed on its last call (it fails open; the status stays up)."""
    return isinstance(throttle, LimitsThrottleBase) and throttle.details().get("degraded") is True


def _store_kind_of(store: object) -> str:
    return "memory" if isinstance(store, MemorySubmissionIdempotencyStore) else "custom"


def _throttle_health(throttle: object) -> ComponentHealth:
    if isinstance(throttle, LimitsThrottleBase):
        return ComponentHealth.up(**throttle.details())
    return ComponentHealth.up(store="custom")


def _idempotency_health(store: object) -> ComponentHealth:
    if isinstance(store, MemorySubmissionIdempotencyStore):
        return ComponentHealth.up(**cast("MemorySubmissionIdempotencyStore[RememberedReceipt]", store).details())
    return ComponentHealth.up(store="custom")


def _store_kind(store: object) -> str:
    return "memory" if isinstance(store, MemoryDefinitionSnapshotStore | MemoryTranslationCatalogStore) else "custom"


def _store_health(store: object) -> ComponentHealth:
    if isinstance(store, MemoryDefinitionSnapshotStore | MemoryTranslationCatalogStore):
        return ComponentHealth.up(**store.details())
    return ComponentHealth.up(store="custom")
