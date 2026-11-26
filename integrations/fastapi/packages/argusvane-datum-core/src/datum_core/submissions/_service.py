"""`SubmissionService`: the receive pipeline, synchronous and framework-free, for every channel.

The steps run in the contract's order (`SubmissionService.STAGES`), each a refusal that stops the rest. The catalog
read fetches the host's translation catalog, beside the definition's own translations map that rides in the stored
definition; both go to the run:

    document rules > wrapper > form id > form key > values > journey id > locale > throttle > pre-check > definition >
    version > idempotency > journey > sandbox_now > contributors > host context > customizers > option snapshot >
    rules > catalog read > run > digest > verdict > signature > validators > dry-run report | record_use > handler >
    remember > stored > event

The one size cap comes first (`TooLarge` before the throttle or anything else walks the tree); the receiver's 415,
address limit, body cap and strict parse are the route's (`datum_core.http`, `datum_core.aio.count_address`), so the
throttle step here is the per-form one. A route whose address limit refused asks `address_refusal` for the same
refusal the per-form step gives. A refused call costs no run. What a hook raises
reaches the caller as raised, with two exceptions: an ordinary exception from a contributor, a
customizer or a validator is `Unavailable` `validator_unavailable`, and one from a rules provider, the host-context
provider or the option snapshot is `Unavailable` `server.unavailable` (a `HookRefusedError`, a `DatumError` and a
configuration error are always raised as they are). The host context (sandbox ABI 4.1.0) is the host's own answer for
the call, never read from the body; one the sandbox cannot take as JSON is `server.unavailable` too, before any run.
Events are published inside the call, after the step they report, through the guarded dispatcher; a dry run publishes
none. The idempotency store is asked before the document is judged (a submission
is its attempt's key: a known key is a retry or a conflict whatever the document holds) and told after the handler
with NO lock between (none holds across instances): two deliveries in flight may both reach the handler.
"""

import copy
import json
import logging
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Final, cast

from datum_core.canonical import canonical_bytes, canonical_digest
from datum_core.config.models import LogLevel, ThrottleKind, UnknownFields
from datum_core.events import DatumEvent, EventDispatcher
from datum_core.forms import DataSourceService, DataSourceUnavailable, FormDefinitionRepository, StoredDefinition
from datum_core.forms.keys import version_matches
from datum_core.forms.protocols import TranslationCatalogStore
from datum_core.hooks import Awaiter, Hook, HookFindings, HookProblem, HookRefusedError, call_hook, resolve
from datum_core.loggers import SUBMISSIONS
from datum_core.submissions import _report
from datum_core.submissions._document import Delivery, read_delivery
from datum_core.submissions._events import (
    JourneyCheckedEvent,
    SubmissionRedeliveredEvent,
    SubmissionRejectedEvent,
    SubmissionThrottledEvent,
    SubmissionValidatedEvent,
)
from datum_core.submissions._hooks import (
    Allow,
    ContextContributor,
    HostContextProvider,
    HostOptionsCustomizer,
    Reject,
    RulesProvider,
    SubmissionHandler,
    SubmissionIdempotencyStore,
    SubmissionPreCheck,
    SubmissionSignatureCheck,
    SubmissionValidator,
)
from datum_core.submissions._journeys import JourneyScope, choose_journey, in_scope
from datum_core.submissions._model import (
    AcceptedSubmission,
    FormRef,
    IncomingSubmission,
    JourneyCheck,
    RememberedReceipt,
    RunSettings,
    SubmissionContext,
    SubmissionError,
    SubmissionMode,
    SubmissionNote,
    SubmissionReceipt,
    ValidatedSubmission,
)
from datum_core.submissions._outcomes import (
    Accepted,
    Checked,
    DryRun,
    Inspected,
    InspectOutcome,
    KeyConflict,
    Malformed,
    NotFound,
    Outdated,
    PdfChecked,
    PdfCheckOutcome,
    Redelivered,
    Refused,
    Rejected,
    SubmissionOutcome,
    Throttled,
    TooLarge,
    Unavailable,
)
from datum_core.throttle import Deny, SubmissionThrottle, ThrottleKey, address_key, counted_address
from datum_sandbox.checks import DatumConfigurationError
from datum_sandbox.json import BadDocumentError, JsonValue, json_size
from datum_sandbox.protocol import DatumError, RuleModule, Sandbox, SandboxResult, StrayBoundError
from datum_sandbox.wasi import EngineBusyError, EngineClosedError

__all__ = ["SubmissionService", "log_submission"]

logger = logging.getLogger(SUBMISSIONS)

_KINDS: Final = {
    SubmissionMode.SUBMIT: ThrottleKind.SUBMIT,
    SubmissionMode.VALIDATE: ThrottleKind.VALIDATE,
    SubmissionMode.TEST: ThrottleKind.TEST,
}
_INSPECT: Final = "inspect"
_ADDRESS_KINDS: Final[dict[str, ThrottleKind]] = {
    **{mode.value: kind for mode, kind in _KINDS.items()},
    _INSPECT: ThrottleKind.TEST,
}
"""The kind an address-limit refusal names, by the route's mode word; inspect counts as a test, as in `inspect`."""
_PUBLISHED: Final = frozenset({SubmissionMode.SUBMIT.value, SubmissionMode.VALIDATE.value})
"""The modes whose throttling publishes `SubmissionThrottledEvent`: a dry run and an inspect publish none."""
_REASONS: Final = {
    "server.unavailable": "The server could not judge the answers now; try again later.",
    "server.busy": "Every sandbox slot is taken; try again shortly.",
    "validator_unavailable": "A check the server runs could not answer, so the answers were not judged.",
    "wasm.execution_error": "The sandbox run gave no verdict.",
    "outcome_too_large": "The answers produce a verdict larger than the server will judge.",
    "definition.tooDeep": "The form is nested deeper than the sandbox reads.",
}
_STRAYS_REASON: Final = (
    "The server runtime is unavailable: runs that would not stop have not ended, so the answers were not judged."
)
"""The reason of the `server.unavailable` a full stray bound answers: a runtime fault, never "try again shortly"."""
_NOT_BLOCKING: Final = frozenset({"warning", "info"})
_OP_LENGTH: Final = 64
HOST_CONTEXT_MAX_DEPTH: Final = 64
"""How deep a host context may nest below its keys (a key's value is level 1), the bound the ABI holds it to."""
HOST_CONTEXT_MAX_VALUES: Final = 1_000_000
"""How many values a host context may hold in all (every value below a key counts, containers included)."""


def log_submission(accepted: AcceptedSubmission) -> SubmissionReceipt:
    """Log the delivery on `datum.submissions` (form and channel only) and answer a fresh receipt: the default handler.

    It keeps nothing: an application that serves submissions passes its own handler (`datum.W003` says so at start).
    """
    receipt = SubmissionReceipt(id=str(uuid.uuid4()), reference=uuid.uuid4().hex[:12].upper())
    logger.info(
        "accepted a submission of %s over %s (receipt %s); the default handler keeps nothing",
        accepted.form_key,
        accepted.channel,
        receipt.id,
        extra={"datum_form_key": accepted.form_key, "datum_channel": accepted.channel},
    )
    return receipt


type _Answer = SubmissionOutcome | PdfChecked
"""Everything a call of the pipeline can end in: the outcomes, and the PDF mode's checked values."""


class _Stop(Exception):  # noqa: N818 - control flow inside this module only
    """A step reached the call's answer: unwind to the caller with it."""

    def __init__(self, outcome: _Answer) -> None:
        super().__init__(type(outcome).__name__)
        self.outcome = outcome


@dataclass(frozen=True, slots=True)
class _Judged:
    """A verdict with nothing blocking: the sandbox's values, its run report and the canonical digest."""

    values: Mapping[str, JsonValue]
    digest: str
    report: dict[str, JsonValue]  # the dry run's trace; empty on any other call
    notes: tuple[SubmissionNote, ...] = ()


@dataclass(frozen=True, slots=True)
class _Validated:
    """What the validators left: their warnings, as handed on, and the same as the verdict's notes."""

    warnings: tuple[HookProblem, ...]
    notes: tuple[SubmissionNote, ...]


class SubmissionService:
    """The receive pipeline: `submit`, `validate`, `test` and `inspect`, one call per thread.

    Synchronous and framework-free: a route calls it through `datum_core.aio`'s runner, a queue consumer calls it as
    it is. Every seam is a keyword; `awaiter` resolves an async hook's or store's awaitable on the calling thread
    (`None`: every one of them is sync, and an async one raises `DatumConfigurationError`).
    """

    STAGES: Final = (
        "document",
        "wrapper",
        "form_id",
        "form_key",
        "values",
        "journey_id",
        "locale",
        "throttle",
        "pre_check",
        "definition",
        "version",
        "idempotency",
        "journey",
        "sandbox_now",
        "contributors",
        "host_context",
        "customizers",
        "option_snapshot",
        "rules",
        "run",
        "digest",
        "verdict",
        "signature",
        "validators",
        "dry_run_report",
        "record_use",
        "handler",
        "remember",
        "stored",
        "event",
    )
    """The receiver order, one name per step; the `signature`, `record_use` and `stored` slots are
    no-ops until the passkey capability fills them."""

    def __init__(
        self,
        *,
        repository: FormDefinitionRepository,
        sandbox: Callable[[], Sandbox],
        idempotency_store: SubmissionIdempotencyStore,
        events: EventDispatcher,
        max_document_bytes: int,
        handler: SubmissionHandler = log_submission,
        throttle: SubmissionThrottle | None = None,
        data_sources: DataSourceService | None = None,
        pre_checks: Sequence[SubmissionPreCheck] = (),
        context_contributors: Sequence[ContextContributor] = (),
        host_options_customizers: Sequence[HostOptionsCustomizer] = (),
        rules_providers: Sequence[RulesProvider] = (),
        validators: Sequence[SubmissionValidator] = (),
        signature_check: SubmissionSignatureCheck | None = None,
        unknown_fields: UnknownFields = UnknownFields.STRIP,
        log_level: LogLevel = LogLevel.WARN,
        awaiter: Awaiter | None = None,
        translation_store: TranslationCatalogStore | None = None,
        host_context: HostContextProvider | None = None,
    ) -> None:
        """Keep the seams. `sandbox` is read once per call, after the definition (`sandbox_now`).

        `host_context` answers the run's `hostContext` per call; `None` supplies none (the lenient reading).
        """
        if signature_check is not None:
            raise DatumConfigurationError(
                "a signature check was given, but the signature slot is reserved until the passkey capability",
                hint="leave signature_check unset",
            )
        if max_document_bytes < 1:
            raise ValueError("max_document_bytes is at least 1")
        self._repository = repository
        self._sandbox = sandbox
        self._store = idempotency_store
        self._events = events
        self._max_bytes = max_document_bytes
        self._handler = handler
        self._throttle = throttle
        self._data_sources = data_sources
        self._pre_checks = tuple(pre_checks)
        self._contributors = tuple(context_contributors)
        self._customizers = tuple(host_options_customizers)
        self._rules_providers = tuple(rules_providers)
        self._validators = tuple(validators)
        self._unknown_fields = UnknownFields(unknown_fields)
        self._log_level = LogLevel(log_level)
        self._awaiter = awaiter
        self._translation_store = translation_store
        self._host_context = host_context

    def _catalog_of(self, form_key: str) -> Mapping[str, JsonValue] | None:
        """Return the form's stored host catalog when it holds anything, else None.

        A store that raises is `Unavailable` `server.unavailable`, as the form repository's failure is: the run
        would otherwise word a message without the host's text. (A `HookRefusedError`, a `DatumError` and a
        configuration error rise as they are.)
        """
        if self._translation_store is None:
            return None
        try:
            stored = self._translation_store.read(form_key)
        except (HookRefusedError, DatumError, DatumConfigurationError, MemoryError):
            raise
        except Exception as error:
            logger.warning("the translation catalog store (stores.translations) failed (%s)", type(error).__name__)
            raise _Stop(_unavailable_code("server.unavailable", error)) from None
        return cast("Mapping[str, JsonValue]", stored.catalog) if stored is not None and stored.catalog else None

    @property
    def max_document_bytes(self) -> int:
        """The one size cap (`datum.web.api.max_body_size`), measured on the tree."""
        return self._max_bytes

    # -- the calls -------------------------------------------------------------------------------------------------
    def submit(self, form: FormRef, document: object, context: SubmissionContext) -> SubmissionOutcome:
        """Judge a delivery and, accepted, hand it to the handler once per (form, version, submission key)."""
        return cast("SubmissionOutcome", self._call(SubmissionMode.SUBMIT, form, document, context))

    def validate(
        self, form: FormRef, document: object, context: SubmissionContext, *, check: JourneyCheck | None = None
    ) -> SubmissionOutcome:
        """Judge a document and keep nothing (`Checked`); `check` (or the body's `scope`/`pageId`) names a page."""
        return cast("SubmissionOutcome", self._call(SubmissionMode.VALIDATE, form, document, context, check=check))

    def test(
        self,
        form: FormRef,
        document: object,
        context: SubmissionContext,
        *,
        log_level: LogLevel | str | None = None,
    ) -> SubmissionOutcome:
        """Run every check as a delivery would, with no handler, nothing kept and no event (`DryRun`)."""
        level = None if log_level is None else LogLevel(log_level)
        return cast("SubmissionOutcome", self._call(SubmissionMode.TEST, form, document, context, log_level=level))

    def pdf_check(self, form: FormRef, document: object, context: SubmissionContext) -> PdfCheckOutcome:
        """Judge the answers a PDF is made from (`PdfChecked`): the receiver's order, kept nothing, announced nowhere.

        It takes no throttle step (the PDF service has its own), no idempotency, no handler and no event.
        """
        return cast("PdfCheckOutcome", self._call(SubmissionMode.PDF, form, document, context))

    def inspect(self, op: str, definition: object, context: SubmissionContext) -> InspectOutcome:  # noqa: PLR0911 - one return per refusal
        """Ask the program about a definition (`Sandbox.inspect`), counted as the `test` kind; nothing is kept."""
        if not op or len(op) > _OP_LENGTH or not op.isascii() or not op.isalpha():
            return Malformed("an inspect op is a word")
        try:
            size = json_size(definition)
        except BadDocumentError:
            return Malformed("the definition has no JSON form")
        if size > self._max_bytes:
            return TooLarge(self._max_bytes)
        if not isinstance(definition, Mapping):
            return Malformed("a definition is a JSON object")
        given = cast("Mapping[str, JsonValue]", definition)
        form_id = given.get("id")
        key = self._throttled(context, form_id if isinstance(form_id, str) else None, ThrottleKind.TEST, publish=False)
        if isinstance(key, Throttled):
            return key
        try:
            sandbox = self._sandbox()
            return Inspected(sandbox.inspect(op, given))
        except (DatumError, EngineBusyError, EngineClosedError) as error:
            return _unavailable(error)

    def address_refusal(self, mode: str, address: str | None, channel: str, retry_after: int) -> Throttled:
        """Answer a request the address limit refused, as the per-form throttle answers one.

        The count is the route's, before it reads the body (`datum_core.aio.count_address`); this gives the refusal:
        `Throttled` with the throttle's seconds, its key the counted address and the route's kind, and for `submit` and
        `validate` the same `SubmissionThrottledEvent` (a dry run, `test`, and an `inspect` publish nothing).
        """
        kind = _ADDRESS_KINDS.get(mode)
        if kind is None:
            raise ValueError(f"an address-limit refusal is for submit, validate, test or inspect, not {mode!r}")
        key = address_key(address, kind, channel)
        if mode in _PUBLISHED:
            self._publish(SubmissionThrottledEvent(key, kind, retry_after, channel))
        return Throttled(retry_after, key)

    # -- the pipeline ----------------------------------------------------------------------------------------------
    def _call(
        self,
        mode: SubmissionMode,
        form: FormRef,
        document: object,
        context: SubmissionContext,
        *,
        check: JourneyCheck | None = None,
        log_level: LogLevel | None = None,
    ) -> _Answer:
        read = read_delivery(document, mode=mode, form=form, max_bytes=self._max_bytes, check=check)
        if isinstance(read, Malformed | TooLarge | NotFound | Unavailable):
            return read
        if mode is SubmissionMode.SUBMIT and context.submission_key is None:
            # Without its attempt's key a retry could not be told from another person's identical answers.
            return Malformed("a delivery carries the submission key of its submit attempt (submissionKey)")
        try:
            return self._judge(mode, read, context, log_level)
        except _Stop as stop:
            return stop.outcome

    def _judge(  # noqa: PLR0911 - one return per mode of the receiver
        self, mode: SubmissionMode, delivery: Delivery, context: SubmissionContext, log_level: LogLevel | None
    ) -> _Answer:
        if mode is not SubmissionMode.PDF:  # the PDF dry run is never counted: the PDF service has its own throttle
            key = self._throttled(context, delivery.form_key, _KINDS[mode], publish=mode is not SubmissionMode.TEST)
            if isinstance(key, Throttled):
                return key
        self._pre_check(mode, delivery, context)
        stored = self._definition(delivery)
        if mode is SubmissionMode.SUBMIT:
            known = self._known_attempt(delivery, cast("str", context.submission_key), context)
            if known is not None:
                return known
        scope = self._journey(mode, delivery, stored, context)
        try:
            sandbox = self._sandbox()  # sandbox_now: read once, after the definition and before the first hook
        except (DatumError, EngineBusyError, EngineClosedError) as error:
            return _unavailable(error)
        host = self._contributed(context)
        host_context = self._host_context_of(delivery.form_key, context)
        settings = self._customized(delivery.form_key, stored, context, log_level)
        snapshot = self._snapshot(stored, delivery)
        rules = self._rules(delivery.form_key, stored, context)
        result = sandbox_run(
            sandbox,
            mode=mode,
            stored=stored,
            delivery=delivery,
            scope=scope,
            host=host,
            settings=settings,
            snapshot=snapshot,
            rules=rules,
            catalog=self._catalog_of(delivery.form_key),
            host_context=host_context,
        )
        judged = self._verdict(mode, delivery, scope, result, context, rules=rules, settings=settings)
        # the signature slot: no-op until the passkey capability (the constructor refuses a check today)
        validated = self._validated(mode, delivery, scope, judged, context)
        warnings = validated.warnings
        if mode is SubmissionMode.VALIDATE:
            return self._checked(delivery, scope, (), context, validated.notes)
        if mode is SubmissionMode.PDF:
            return PdfChecked(
                judged.values,
                delivery.form_key,
                delivery.version,
                delivery.locale,
                judged.digest,
                stored.definition,
                warnings,
                host_context,
            )
        if mode is SubmissionMode.TEST:
            report = {
                **judged.report,
                "errors": [
                    *cast("list[JsonValue]", judged.report["errors"]),
                    *(
                        _report.finding(
                            w.field, w.code, w.message or None, severity="warning", stage="server", source="server"
                        )
                        for w in warnings
                    ),
                ],
            }
            return DryRun(True, None, (), judged.values, _report.assemble(True, None, report))
        # the record_use slot: no-op until the passkey capability
        accepted = AcceptedSubmission(
            form_key=delivery.form_key,
            digest=judged.digest,
            values=judged.values,
            warnings=warnings,
            channel=context.channel,
            remote_address=context.remote_address,
            user_agent=context.user_agent,
            version=delivery.version,
            locale=delivery.locale,
            principal=context.principal,
            submission_key=context.submission_key,
            host_context=host_context,
        )
        receipt = call_hook(self._handler, self._awaiter, accepted)
        if not isinstance(receipt, SubmissionReceipt):  # pyright: ignore[reportUnnecessaryIsInstance]
            raise TypeError(f"the submission handler answered {type(receipt).__name__}, not a SubmissionReceipt")
        standing = self._remember(delivery, cast("str", context.submission_key), judged.digest, receipt)
        # the stored slot: no-op until the passkey capability
        self._publish(SubmissionValidatedEvent(accepted, standing, context.channel))
        return Accepted(standing, accepted, warnings)

    # -- throttle, pre-check, definition, version, journey ---------------------------------------------------------
    def _throttled(
        self, context: SubmissionContext, form_key: str | None, kind: ThrottleKind, *, publish: bool
    ) -> ThrottleKey | Throttled | None:
        given = context.throttle_key
        if given is None or self._throttle is None:
            return None
        key = ThrottleKey(
            ip=counted_address(given.ip),
            form_key=form_key,
            principal=given.principal,
            kind=kind,
            channel=context.channel,
        )
        answer = resolve(self._throttle.check(key), self._awaiter, what="the throttle")
        if not isinstance(answer, Deny):
            return key
        if publish:
            self._publish(SubmissionThrottledEvent(key, kind, answer.retry_after, context.channel))
        return Throttled(answer.retry_after, key)

    def _pre_check(self, mode: SubmissionMode, delivery: Delivery, context: SubmissionContext) -> None:
        if not self._pre_checks:
            return
        incoming = IncomingSubmission(delivery.form_key, mode, context, delivery.version, delivery.locale)
        for pre_check in self._pre_checks:
            decision = call_hook(pre_check, self._awaiter, incoming)
            if isinstance(decision, Reject):
                raise _Stop(Refused(decision))
            if not isinstance(decision, Allow):  # pyright: ignore[reportUnnecessaryIsInstance]
                raise TypeError(f"a pre-check answered {type(decision).__name__}, not Allow or Reject")

    def _definition(self, delivery: Delivery) -> StoredDefinition:
        try:
            stored = self._repository.current(delivery.form_key)
        except (HookRefusedError, DatumError, DatumConfigurationError, MemoryError):
            raise
        except Exception as error:
            logger.warning("the form repository failed (%s)", type(error).__name__)
            raise _Stop(_unavailable_code("server.unavailable", error)) from None
        if stored is None:
            raise _Stop(NotFound(delivery.form_key))
        if not version_matches(stored.definition, delivery.version):
            held = stored.definition.get("version")
            current = str(held) if isinstance(held, str | int) and not isinstance(held, bool) else ""
            raise _Stop(Outdated(current, stored.sha256))
        return stored

    def _journey(
        self, mode: SubmissionMode, delivery: Delivery, stored: StoredDefinition, context: SubmissionContext
    ) -> JourneyScope:
        chosen = choose_journey(stored.definition, delivery.journey_id, delivery.check)
        if isinstance(chosen, Malformed):
            raise _Stop(chosen)
        if isinstance(chosen, JourneyScope):
            return chosen
        errors: tuple[SubmissionError, ...] = ((None, chosen, None),)
        raise _Stop(self._refused(mode, delivery, None, errors, stage="journey", values={}, context=context))

    # -- contributors, customizers, option snapshot, rules ---------------------------------------------------------
    def _contributed(self, context: SubmissionContext) -> dict[str, JsonValue]:
        host: dict[str, JsonValue] = {}
        for contributor in self._contributors:
            entries = self._hook(contributor, "validator_unavailable", context)
            if entries is None:
                continue
            if not isinstance(entries, Mapping):  # pyright: ignore[reportUnnecessaryIsInstance]
                raise _Stop(_unavailable_code("validator_unavailable", TypeError("not a mapping")))
            host.update(entries)
        return host

    def _host_context_of(self, form_key: str, context: SubmissionContext) -> dict[str, JsonValue] | None:
        """Ask the host-context provider for the call's context, and hold its answer to what the sandbox takes.

        A raise is `server.unavailable` (`_hook`); so is an answer that is not an object or that JSON would refuse or
        reshape: it is the host's bug, never a verdict on the answers. The run reads a plain copy.
        """
        if self._host_context is None:
            return None
        given: object = self._hook(self._host_context, "server.unavailable", form_key, context)
        if given is None:
            return None
        refusal = _host_context_refusal(given)
        if refusal is not None:
            logger.error(
                "the host context provider answered a host context the sandbox cannot take (%s); the answers were "
                "not judged",
                refusal,
                extra={"datum_form_key": form_key},
            )
            raise _Stop(_unavailable_code("server.unavailable", None))
        copied: dict[str, JsonValue] = json.loads(
            json.dumps(dict(cast("Mapping[str, JsonValue]", given)), ensure_ascii=False, allow_nan=False)
        )
        return copied

    def _customized(
        self,
        form_key: str,
        stored: StoredDefinition,
        context: SubmissionContext,
        log_level: LogLevel | None,
    ) -> RunSettings:
        settings = RunSettings(self._unknown_fields, self._log_level)
        if self._customizers:
            copied = copy.deepcopy(dict(stored.definition))
            for customizer in self._customizers:
                self._hook(customizer, "validator_unavailable", form_key, copied, settings, context)
        try:
            settings.unknown_fields = UnknownFields(settings.unknown_fields)
            settings.log_level = LogLevel(settings.log_level)
        except ValueError as error:
            raise _Stop(_unavailable_code("validator_unavailable", error)) from None
        if log_level is not None:
            settings.log_level = log_level
        return settings

    def _snapshot(self, stored: StoredDefinition, delivery: Delivery) -> dict[str, JsonValue] | None:
        sources = sourced_choices(stored.definition)
        if not sources or self._data_sources is None:
            return None if not sources else {}
        found = self._data_sources.snapshot(sources, form_key=delivery.form_key, locale=delivery.locale)
        if isinstance(found, DataSourceUnavailable):
            raise _Stop(_unavailable_code("server.unavailable", None))
        return {
            source: cast("JsonValue", [_option(row) for row in rows if "value" in row])
            for source, rows in found.items()
        }

    def _rules(self, form_key: str, stored: StoredDefinition, context: SubmissionContext) -> tuple[RuleModule, ...]:
        modules: list[RuleModule] = []
        if self._rules_providers:
            copied = copy.deepcopy(dict(stored.definition))
            for provider in self._rules_providers:
                given: object = self._hook(provider, "server.unavailable", form_key, copied, context)
                if not given:  # no modules (an empty list, or None from a provider typed loosely)
                    continue
                if not isinstance(given, list | tuple) or not all(
                    isinstance(module, RuleModule) for module in cast("Sequence[object]", given)
                ):
                    raise _Stop(_unavailable_code("server.unavailable", TypeError("not rule modules")))
                modules.extend(cast("Sequence[RuleModule]", given))
        return tuple(modules)

    def _hook[**P, T](self, hook: Hook[P, T], code: str, *args: P.args, **kwargs: P.kwargs) -> T:
        """Call a hook through the awaiter.

        Its refusal, a `DatumError` and a configuration error rise as they are; any other exception is `Unavailable`
        under `code` (logged by its class, never by its words).
        """
        try:
            return call_hook(hook, self._awaiter, *args, **kwargs)
        except (HookRefusedError, DatumError, DatumConfigurationError, MemoryError):
            raise
        except Exception as error:
            logger.warning(
                "the hook %s failed (%s); the answers were not judged",
                getattr(hook, "__qualname__", type(hook).__qualname__),
                type(error).__name__,
            )
            raise _Stop(_unavailable_code(code, error)) from None

    # -- digest, verdict ------------------------------------------------------------------------------------------
    def _verdict(
        self,
        mode: SubmissionMode,
        delivery: Delivery,
        scope: JourneyScope,
        result: SandboxResult,
        context: SubmissionContext,
        *,
        rules: Sequence[RuleModule],
        settings: RunSettings,
    ) -> _Judged:
        outcome = result.outcome
        digest = canonical_digest(delivery.envelope)
        described = outcome.get("digest")
        if described is not None and described != digest:
            logger.error("the sandbox named another document than the one it was handed; the answers were not judged")
            raise _Stop(_unavailable_code("validator_unavailable", None))
        raw_values = outcome.get("values")
        kept = dict(raw_values) if isinstance(raw_values, dict) else None
        values: dict[str, JsonValue] = {} if kept is None else kept
        listed = outcome.get("errors")
        items = listed if isinstance(listed, list) else []
        scoped = [item for item in items if in_scope(item, scope, outcome)]
        errors = tuple(_error(item) for item in scoped if _blocks(item))
        notes = tuple(_note(item) for item in scoped if not _blocks(item))
        report: dict[str, JsonValue] = {}
        if mode is SubmissionMode.TEST:
            canonical = outcome.get("canonical")
            report = _report.trace(
                sent=delivery.values,
                outcome=outcome,
                values=kept,
                findings=[_report.sandbox_finding(item) for item in scoped],
                digest=digest,
                canonical=canonical
                if isinstance(canonical, str)
                else canonical_bytes(delivery.envelope).decode("utf-8"),
                elapsed=result.elapsed,
                rules=[module.id for module in rules],
                unknown_fields=settings.unknown_fields.value,
                log_level=settings.log_level.value,
            )
        if errors:
            raise _Stop(
                self._refused(
                    mode,
                    delivery,
                    scope,
                    errors,
                    stage="sandbox",
                    values=values,
                    context=context,
                    report=report,
                    notes=notes,
                )
            )
        return _Judged(values, digest, report, notes)

    # -- idempotency, validators, remember -------------------------------------------------------------------------
    def _known_attempt(
        self, delivery: Delivery, submission_key: str, context: SubmissionContext
    ) -> Redelivered | KeyConflict | None:
        # A submission is its attempt's key, so the key is asked before the document is judged: a retry (the same
        # key and digest) is answered with its first receipt and costs no run, and the key with another document is
        # refused whatever that document holds, never answered with the receipt, so a guessed key reads nothing and
        # an invalid document under a known key gets the same answer from every host.
        first = self._find(delivery, submission_key)
        if first is None:
            return None
        digest = canonical_digest(delivery.envelope)
        if first.digest != digest:
            return KeyConflict(digest)
        self._publish(SubmissionRedeliveredEvent(delivery.form_key, digest, first.receipt, context.channel))
        return Redelivered(first.receipt, digest)

    def _find(self, delivery: Delivery, submission_key: str) -> RememberedReceipt | None:
        try:
            return resolve(
                self._store.find(delivery.form_key, delivery.version, submission_key), self._awaiter, what="the store"
            )
        except (DatumError, DatumConfigurationError, MemoryError):
            raise
        except Exception as error:
            logger.warning("the idempotency store failed to answer (%s)", type(error).__name__)
            raise _Stop(_unavailable_code("server.unavailable", error)) from None

    def _validated(
        self,
        mode: SubmissionMode,
        delivery: Delivery,
        scope: JourneyScope,
        judged: _Judged,
        context: SubmissionContext,
    ) -> _Validated:
        if not self._validators:
            return _Validated((), judged.notes)
        candidate = ValidatedSubmission(
            delivery.form_key, judged.values, judged.digest, delivery.version, delivery.locale
        )
        findings = HookFindings()
        for validator in self._validators:
            found = self._hook(validator, "validator_unavailable", candidate, context)
            if found is not None and not isinstance(found, HookFindings):  # pyright: ignore[reportUnnecessaryIsInstance]
                raise _Stop(_unavailable_code("validator_unavailable", TypeError("not HookFindings")))
            findings = findings.merged(found)
        notes = (*judged.notes, *(_warning_note(warning) for warning in findings.warnings))
        if findings.errors:
            errors = tuple((p.field, p.code, p.message or None) for p in findings.errors)
            report = judged.report
            if mode is SubmissionMode.TEST:
                server = [
                    _report.finding(
                        p.field, p.code, p.message or None, severity="error", stage="server", source="server"
                    )
                    for p in findings.errors
                ]
                server += [
                    _report.finding(
                        p.field, p.code, p.message or None, severity="warning", stage="server", source="server"
                    )
                    for p in findings.warnings
                ]
                report = {**report, "errors": [*cast("list[JsonValue]", report["errors"]), *server]}
            raise _Stop(
                self._refused(
                    mode,
                    delivery,
                    scope,
                    errors,
                    stage="server",
                    values=judged.values,
                    context=context,
                    report=report,
                    notes=notes,
                )
            )
        return _Validated(findings.warnings, notes)

    def _remember(
        self, delivery: Delivery, submission_key: str, digest: str, receipt: SubmissionReceipt
    ) -> SubmissionReceipt:
        try:
            standing = resolve(
                self._store.record(
                    delivery.form_key, delivery.version, submission_key, RememberedReceipt(digest, receipt)
                ),
                self._awaiter,
                what="the store",
            )
        except (DatumConfigurationError, MemoryError):
            raise
        except Exception as error:
            # The effect happened: the answer stands, and a retry of the attempt reaches the (idempotent) handler again.
            logger.error("the idempotency store failed to keep a receipt (%s)", type(error).__name__)  # noqa: TRY400 - the class only: no traceback carries a store's words
            return receipt
        return standing.receipt

    # -- answers ---------------------------------------------------------------------------------------------------
    def _refused(
        self,
        mode: SubmissionMode,
        delivery: Delivery,
        scope: JourneyScope | None,
        errors: tuple[SubmissionError, ...],
        *,
        stage: str,
        values: Mapping[str, JsonValue] | None,
        context: SubmissionContext,
        report: Mapping[str, JsonValue] | None = None,
        notes: tuple[SubmissionNote, ...] = (),
    ) -> SubmissionOutcome:
        if mode is SubmissionMode.VALIDATE:
            return self._checked(delivery, scope, errors, context, notes)
        if mode is SubmissionMode.PDF:
            return Rejected(errors, stage)
        if mode is SubmissionMode.TEST:
            kept = report or _report.refusal(delivery.values, errors)
            return DryRun(False, stage, errors, values, _report.assemble(False, stage, kept))
        self._publish(
            SubmissionRejectedEvent(delivery.form_key, errors, stage, context.remote_address, context.channel)
        )
        return Rejected(errors, stage)

    def _checked(
        self,
        delivery: Delivery,
        scope: JourneyScope | None,
        errors: tuple[SubmissionError, ...],
        context: SubmissionContext,
        notes: tuple[SubmissionNote, ...] = (),
    ) -> Checked:
        journey_id = scope.journey_id if scope is not None else _named_journey(delivery.journey_id)
        page_id = delivery.check.page_id if delivery.check is not None else None
        accepted = not errors
        self._publish(JourneyCheckedEvent(delivery.form_key, journey_id, page_id, accepted, context.channel))
        return Checked(accepted, errors, journey_id, page_id, notes)

    def _publish(self, event: DatumEvent) -> None:
        self._events.publish(event)


# -- helpers ---------------------------------------------------------------------------------------------------------
def sandbox_run(
    sandbox: Sandbox,
    *,
    mode: SubmissionMode,
    stored: StoredDefinition,
    delivery: Delivery,
    scope: JourneyScope,
    host: Mapping[str, JsonValue],
    settings: RunSettings,
    snapshot: Mapping[str, JsonValue] | None,
    rules: Sequence[RuleModule],
    catalog: Mapping[str, JsonValue] | None = None,
    host_context: Mapping[str, JsonValue] | None = None,
) -> SandboxResult:
    """Run the validation over the stored form (never a hook's copy), the answers and the run's words.

    `host_context` is the host's own (`HostContextProvider`), never the body's: absent, no `hostContext` is sent and
    every rule reading `host.` is left unjudged. A run that gave no verdict is `Unavailable` under its own code.
    """
    run_input: dict[str, JsonValue] = {
        "formId": delivery.form_key,
        "form": stored.definition.get("root"),
        "values": dict(delivery.values),
        "locale": delivery.locale,
        "unknownFields": settings.unknown_fields.value,
        "logLevel": settings.log_level.value,
        "document": dict(delivery.envelope),
    }
    translations = stored.definition.get("translations")
    if isinstance(translations, dict):
        # The kernel reads the run context, not the definition, so the map rides in the context.
        run_input["translations"] = translations
    if catalog is not None:
        # The kernel reads the host catalog before the map under the same
        # locale tag, as the browser does.
        run_input["catalog"] = dict(catalog)
    if host:
        run_input["externalData"] = dict(host)
    if host_context is not None:
        # sandbox ABI 4.1.0: beside `today` (the host's keys), present even when empty, so every `host.` rule is judged
        run_input["hostContext"] = dict(host_context)
    if snapshot is not None:
        run_input["optionSnapshot"] = dict(snapshot)
    if scope.journey is not None:
        run_input["journey"] = dict(scope.journey)
    if scope.page_id is not None:
        run_input["page"] = scope.page_id
    try:
        return sandbox.validate(run_input, rules, real=mode is SubmissionMode.SUBMIT)
    except (DatumError, EngineBusyError, EngineClosedError) as error:
        raise _Stop(_unavailable(error)) from None


def sourced_choices(definition: Mapping[str, JsonValue]) -> list[str]:
    """List the source ids of the form tree's data-sourced choices (`configuration.data.sourceId`), in tree order."""
    found: list[str] = []
    stack: list[object] = [definition.get("root")]
    while stack:
        node = stack.pop()
        if isinstance(node, list):
            stack.extend(reversed(cast("list[object]", node)))
            continue
        if not isinstance(node, dict):
            continue
        record = cast("dict[str, object]", node)
        configuration = record.get("configuration")
        data = cast("dict[str, object]", configuration).get("data") if isinstance(configuration, dict) else None
        source = cast("dict[str, object]", data).get("sourceId") if isinstance(data, dict) else None
        if isinstance(source, str) and source and source not in found:
            found.append(source)
        stack.extend(reversed(list(record.values())))
    return found


def _option(row: Mapping[str, JsonValue]) -> JsonValue:
    """Shape an item as the program's snapshot takes it: its value, and its label when the label is text."""
    item: dict[str, JsonValue] = {"value": row["value"]}
    label = row.get("label")
    if isinstance(label, str):
        item["label"] = label
    return item


def _blocks(item: JsonValue) -> bool:
    """Say whether a verdict's error blocks: any severity but `warning` and `info` (a typo is not a pass)."""
    return not (isinstance(item, dict) and item.get("severity") in _NOT_BLOCKING)


def _error(item: JsonValue) -> SubmissionError:
    """Read a verdict error as (component id, code, message).

    The message is the item's own text for a person when it is non-empty text (the form's or the catalog's wording, as
    the sandbox resolved it), else None. A hook's finding is its own item with its own message; the two never merge.
    """
    record = item if isinstance(item, dict) else {}
    component = record.get("componentId")
    path = record.get("path")
    code = record.get("code")
    message = record.get("message")
    field = component if isinstance(component, str) else path if isinstance(path, str) else None
    return (
        field,
        code if isinstance(code, str) and code else "invalid",
        message if isinstance(message, str) and message else None,
    )


def _note(item: JsonValue) -> SubmissionNote:
    """Read a verdict's warning or info item as (component id, code, severity, message).

    The message is the item's own text for a person when it is non-empty text (the form's or the catalog's wording,
    as the kernel resolved it), else None.
    """
    record = item if isinstance(item, dict) else {}
    component = record.get("componentId")
    path = record.get("path")
    code = record.get("code")
    message = record.get("message")
    field = component if isinstance(component, str) else path if isinstance(path, str) else None
    return (
        field,
        code if isinstance(code, str) and code else "invalid",
        "info" if record.get("severity") == "info" else "warning",
        message if isinstance(message, str) and message else None,
    )


def _warning_note(problem: HookProblem) -> SubmissionNote:
    """Return a validator's warning as a note: severity `warning`, the validator's own words when it gave any."""
    return (problem.field, problem.code, "warning", problem.message or None)


def _host_context_refusal(given: object) -> str | None:
    """Say why the sandbox cannot take `given` as its `hostContext`, or None when it can.

    The ABI's bounds, walked as the program walks them: each key's value at level 1 and nothing deeper than
    `HOST_CONTEXT_MAX_DEPTH`, at most `HOST_CONTEXT_MAX_VALUES` values in all; then an object whose every key is
    text and nothing JSON cannot carry or would reshape (`json_size` refuses a number that is not finite, a lone
    surrogate, a key that is not text and a value with no JSON form). Iterative, so a deep answer costs no recursion.
    The reason names no value.
    """
    if not isinstance(given, Mapping):
        return f"a {type(given).__name__}, not an object"
    record = dict(cast("Mapping[object, object]", given))
    values = 0
    stack: list[tuple[object, int]] = [(value, 1) for value in record.values()]
    while stack:
        node, level = stack.pop()
        values += 1
        if values > HOST_CONTEXT_MAX_VALUES:
            return f"more than {HOST_CONTEXT_MAX_VALUES} values"
        if level > HOST_CONTEXT_MAX_DEPTH:
            return f"nested deeper than {HOST_CONTEXT_MAX_DEPTH} levels"
        if isinstance(node, dict):
            stack.extend((child, level + 1) for child in cast("dict[str, object]", node).values())
        elif isinstance(node, list | tuple):
            stack.extend((child, level + 1) for child in cast("Sequence[object]", node))
    try:  # after the bounds, so a huge answer costs at most the bounded walk
        json_size(record)
    except BadDocumentError as error:
        return f"no JSON form: {error.reason}"
    return None


def _named_journey(journey_id: JsonValue) -> str | None:
    return journey_id if isinstance(journey_id, str) else None


_RUN_CODES: Final = frozenset(
    {"server.busy", "server.unavailable", "wasm.execution_error", "outcome_too_large", "definition.tooDeep"}
)


def _unavailable(error: DatumError | EngineBusyError | EngineClosedError) -> Unavailable:
    """Answer the run's own refusal as `Unavailable`: busy, closed, a full stray bound, or the `DatumError`'s code."""
    if isinstance(error, EngineBusyError):
        return _unavailable_code("server.busy", error)
    if isinstance(error, EngineClosedError):
        return _unavailable_code("server.unavailable", error)
    if isinstance(error, StrayBoundError):
        return Unavailable("server.unavailable", _STRAYS_REASON, error)
    if error.code not in _RUN_CODES:
        raise error  # a code the catalog gives no run answer reaches the caller as raised
    return _unavailable_code(error.code, error)


def _unavailable_code(code: str, cause: BaseException | None) -> Unavailable:
    return Unavailable(code, _REASONS.get(code, _REASONS["server.unavailable"]), cause)
