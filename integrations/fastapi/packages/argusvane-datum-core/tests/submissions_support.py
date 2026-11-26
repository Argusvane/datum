"""Fakes and builders for the service tests: a stage trail shared by every seam, a rig that starts a `Datum`.

Every seam (throttle, pre-check, repository, contributor, customizer, rules provider, sandbox, idempotency store,
validator, handler, listener) appends its own name to one `trail`, so a test reads the order the service called them in.
The rig starts a real `datum_core.Datum` over a stub runtime and a recording sandbox (no engine), then clears the trail,
so what is left is the request's own path.
"""

import threading
import uuid
from collections.abc import Awaitable, Callable, Iterator, Mapping, Sequence
from contextlib import ExitStack, contextmanager
from dataclasses import dataclass, field
from typing import Any, cast

from anyio.from_thread import start_blocking_portal

from datum_core import Datum, DatumConfig
from datum_core.events import DatumEvent
from datum_core.forms import DataSourceRequest, StoredDefinition
from datum_core.hooks import Awaiter, HookFindings
from datum_core.submissions import (
    AcceptedSubmission,
    Allow,
    FormRef,
    IncomingSubmission,
    PreCheckDecision,
    RememberedReceipt,
    SubmissionContext,
    SubmissionReceipt,
    SubmissionService,
    ValidatedSubmission,
)
from datum_core.throttle import Allow as ThrottleAllow
from datum_core.throttle import Deny, ThrottleKey
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import Program, ProgramKind, RuleModule, Sandbox, SandboxResult, Smoke
from datum_sandbox.wasi import EngineInfo, GuestRuntime

FORM = "contact"
VERSION = "1"
NAME = "Ada Lovelace"


SOURCE = "countries"


def definition(form_id: str = FORM, version: str = VERSION, *, sourced: bool = False) -> dict[str, Any]:
    """The form the repository serves: one required text component; `sourced` adds a choice fed by a data source."""
    content: list[dict[str, Any]] = [
        {"id": "name", "type": "text", "configuration": {"label": "Name", "required": True}}
    ]
    if sourced:
        content.append(
            {"id": "country", "type": "select", "configuration": {"label": "Country", "data": {"sourceId": SOURCE}}}
        )
    return {
        "id": form_id,
        "version": version,
        "root": {
            "id": "form",
            "type": "form",
            "children": {"content": content},
        },
    }


def envelope(
    *,
    form: str = FORM,
    version: str = VERSION,
    values: Mapping[str, Any] | None = None,
    locale: str = "en",
    extra: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """The document a browser posts (`versionContext` + `submission`), shaped like the conformance kit's envelope."""
    document: dict[str, Any] = {
        "versionContext": {
            "form": {"id": form, "version": version},
            "client": {"runtimeVersion": "x", "rendererVersion": "x", "schemaVersion": "1"},
        },
        "submission": {"locale": locale, "values": dict({"name": NAME} if values is None else values)},
    }
    if extra:
        document["submission"].update(extra)
    return document


def wrapped(document: Mapping[str, Any]) -> dict[str, Any]:
    """The suite's body: the envelope under `document`."""
    return {"document": dict(document)}


def body_for(call: str, document: Mapping[str, Any]) -> dict[str, Any]:
    """The body a service call takes for `document`: validate's wrapper with its scope, test's wrapper, else as is."""
    if call == "validate":
        return journey_check(document)
    return wrapped(document) if call == "test" else dict(document)


def journey_check(document: Mapping[str, Any], scope: str = "journey", **more: Any) -> dict[str, Any]:
    """The body of a `validate`: the envelope under `document` with the check's `scope` (and `pageId`) beside it."""
    return {"document": dict(document), "scope": scope, **more}


def bus(**fields: Any) -> SubmissionContext:
    """A queue consumer's context: channel `bus`, no request, no throttle key, a submit attempt of its own."""
    fields.setdefault("submission_key", str(uuid.uuid4()))
    return SubmissionContext(channel="bus", **fields)


def http_context(*, ip: str = "203.0.113.7", principal: str | None = None, **fields: Any) -> SubmissionContext:
    """A route's context: channel `http`, an address, a user agent, a throttle key made of address and principal.

    Each context is a submit attempt of its own (a fresh `submission_key`) unless the caller names one.
    """
    fields.setdefault("submission_key", str(uuid.uuid4()))
    return SubmissionContext(
        channel="http",
        remote_address=ip,
        user_agent="pytest",
        throttle_key=ThrottleKey(ip=ip, principal=principal),
        **fields,
    )


def refused_by_kernel(code: str = "required", field_id: str = "name") -> SandboxResult:
    """The sandbox's verdict for a refused document: one error of severity `error` on a component."""
    error: dict[str, JsonValue] = {"code": code, "componentId": field_id, "path": field_id, "severity": "error"}
    return SandboxResult({"errors": [error], "values": {}}, 0.01)


class StubRuntime:
    """A `GuestRuntime` that is only an identity and a `close`."""

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        return None


class Repository:
    """One form (`contact`, version 1) and a trail entry per lookup."""

    def __init__(self, trail: list[str], *forms: dict[str, Any]) -> None:
        self.trail = trail
        self.forms = {form["id"]: form for form in (forms or (definition(),))}

    def current(self, key: str) -> StoredDefinition | None:
        self.trail.append("definition")
        form = self.forms.get(key)
        if form is None:
            return None
        return StoredDefinition(key=key, definition=form, sha256="0" * 64)


class RecordingSandbox:
    """The sandbox calls a submission makes; `verdict` is what `validate` answers, `error` what it raises."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.program = Program(ProgramKind.SANDBOX, b"stub")
        self.verdict: SandboxResult | None = None
        self.error: Exception | None = None
        self.validations: list[tuple[dict[str, JsonValue], tuple[RuleModule, ...], bool]] = []
        self.inspections: list[tuple[str, Mapping[str, JsonValue]]] = []

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        self.trail.append("sandbox")
        self.validations.append((dict(context), tuple(rules), real))
        if self.error is not None:
            raise self.error
        if self.verdict is not None:
            return self.verdict
        raw = context.get("values")
        values: dict[str, JsonValue] = dict(raw) if isinstance(raw, dict) else {}
        return SandboxResult({"errors": [], "values": values}, 0.01)

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        self.trail.append("sandbox.inspect")
        self.inspections.append((op, definition))
        if self.error is not None:
            raise self.error
        return {"ok": True, "op": op}

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        return {"ok": True}

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        return dict(definition)

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def prove_abi(self) -> None:
        return None


class SourceProvider:
    """A data source provider that puts the option snapshot on the trail; it answers two rows for any source."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail

    def exists(self, source_id: str) -> bool:
        return source_id == SOURCE

    def items(self, request: DataSourceRequest) -> list[dict[str, JsonValue]]:
        self.trail.append("option_snapshot")
        return [{"value": "ca", "label": "Canada"}, {"value": "us", "label": "United States"}]


class RecordingThrottle:
    """A `SubmissionThrottle` that records the key it was asked about; `deny_after` allows that many checks."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.keys: list[ThrottleKey] = []
        self.deny: int | None = None

    def check(self, key: ThrottleKey) -> ThrottleAllow | Deny:
        self.trail.append("throttle")
        self.keys.append(key)
        return ThrottleAllow() if self.deny is None else Deny(retry_after=self.deny)

    def record(self, key: ThrottleKey) -> None:
        return None


class RecordingIdempotency:
    """An idempotency store over a dict, with the protocol's two calls on the trail."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.finds: list[tuple[str, str, str]] = []
        self.records: list[tuple[str, str, str, RememberedReceipt]] = []
        self._receipts: dict[tuple[str, str, str], RememberedReceipt] = {}
        self._lock = threading.Lock()

    def find(self, form_key: str, version: str, submission_key: str) -> RememberedReceipt | None:
        self.trail.append("idempotency.find")
        self.finds.append((form_key, version, submission_key))
        with self._lock:
            return self._receipts.get((form_key, version, submission_key))

    def record(
        self, form_key: str, version: str, submission_key: str, remembered: RememberedReceipt
    ) -> RememberedReceipt:
        self.trail.append("idempotency.record")
        self.records.append((form_key, version, submission_key, remembered))
        with self._lock:
            return self._receipts.setdefault((form_key, version, submission_key), remembered)


class Handler:
    """The effect: records what it was handed and answers a numbered receipt; `fail` makes it raise."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.calls: list[AcceptedSubmission] = []
        self.fail: Exception | None = None
        self.hold: Callable[[], object] | None = None

    def __call__(self, accepted: AcceptedSubmission) -> SubmissionReceipt:
        self.trail.append("handler")
        self.calls.append(accepted)
        if self.hold is not None:
            self.hold()
        if self.fail is not None:
            raise self.fail
        number = len(self.calls)
        return SubmissionReceipt(id=f"id-{number}", reference=f"REF-{number}")


class ThreadLoopAwaiter:
    """An awaiter for a sync caller: awaitables run on the event loop of an anyio blocking portal (own thread)."""

    def __init__(self) -> None:
        self._stack = ExitStack()
        self._portal = self._stack.enter_context(start_blocking_portal())

    def __call__[T](self, awaitable: Awaitable[T], /) -> T:
        async def wrap() -> T:
            return await awaitable

        return self._portal.call(wrap)

    def close(self) -> None:
        self._stack.close()


@dataclass
class Rig:
    """A started `Datum` and the recording seams it was built with."""

    datum: Datum
    trail: list[str]
    handler: Handler
    sandbox: RecordingSandbox
    throttle: RecordingThrottle
    idempotency: RecordingIdempotency
    repository: Repository
    events: list[DatumEvent] = field(default_factory=lambda: cast("list[DatumEvent]", []))

    @property
    def service(self) -> SubmissionService:
        return self.datum.submission_service

    def submit(self, document: Mapping[str, Any] | None = None, context: SubmissionContext | None = None) -> Any:
        return self.service.submit(FormRef.from_document(), document or envelope(), context or bus())


def pre_check_that_allows(trail: list[str]) -> Callable[[IncomingSubmission], PreCheckDecision]:
    def check(incoming: IncomingSubmission) -> PreCheckDecision:
        trail.append("pre_check")
        return Allow()

    return check


def recording_hooks(trail: list[str]) -> dict[str, Any]:
    """One hook of every kind, each appending its name: the `Datum` keywords for the full receiver order."""

    def contributor(context: SubmissionContext) -> Mapping[str, JsonValue] | None:
        trail.append("contributor")
        return None

    def customizer(form_key: str, form: Any, settings: Any, context: SubmissionContext) -> None:
        trail.append("customizer")

    def rules(form_key: str, form: Any, context: SubmissionContext) -> Sequence[RuleModule]:
        trail.append("rules")
        return ()

    def validator(candidate: ValidatedSubmission, context: SubmissionContext) -> HookFindings | None:
        trail.append("validator")
        return None

    return {
        "pre_checks": [pre_check_that_allows(trail)],
        "context_contributors": [contributor],
        "host_options_customizers": [customizer],
        "data_sources": [SourceProvider(trail)],
        "rules_providers": [rules],
        "validators": [validator],
    }


@contextmanager
def started(
    config: Mapping[str, Any] | DatumConfig | None = None,
    *,
    full: bool = False,
    awaiter: Awaiter | None = None,
    **seams: Any,
) -> Iterator[Rig]:
    """Start a `Datum` over the recording seams (a `seams` keyword replaces the recording one) and yield the rig.

    `full=True` adds one recording hook of every kind (the form then has a data-sourced choice for the option
    snapshot). The trail is cleared after the start: the start's own sandbox proof and warm-up are not the request's
    path.
    """
    trail: list[str] = []
    events: list[DatumEvent] = []
    repository = seams.pop("form_repository", None) or Repository(trail, definition(sourced=full))
    sandbox = RecordingSandbox(trail)
    throttle = RecordingThrottle(trail)
    idempotency = RecordingIdempotency(trail)
    handler = Handler(trail)

    def record_event(event: DatumEvent) -> None:
        trail.append(f"event:{type(event).__name__}")
        events.append(event)

    options: dict[str, Any] = {
        "handler": handler,
        "throttle": throttle,
        "idempotency_store": idempotency,
        "form_repository": repository,
        "listeners": [(DatumEvent, record_event)],
    }
    if full:
        options.update(recording_hooks(trail))
    options.update(seams)
    settings = config if isinstance(config, DatumConfig) else DatumConfig.model_validate(dict(config or {}))
    datum = Datum(
        config=settings,
        runtime=cast("GuestRuntime", StubRuntime()),
        sandbox=cast("Sandbox", sandbox),
        **options,
    )
    datum.start(awaiter=awaiter)
    trail.clear()
    events.clear()  # the start published its own ready event
    try:
        yield Rig(datum, trail, handler, sandbox, throttle, idempotency, cast("Repository", repository), events)
    finally:
        datum.stop()


FULL_PATH = [
    "throttle",
    "pre_check",
    "definition",
    "idempotency.find",
    "contributor",
    "customizer",
    "option_snapshot",
    "rules",
    "sandbox",
    "validator",
    "handler",
    "idempotency.record",
    "event:SubmissionValidatedEvent",
]
"""The trail of an accepted submission through every hook kind, in the receiver order."""


def plain_datum(config: Mapping[str, Any] | None = None, **seams: Any) -> Datum:
    """A `Datum` over the stub runtime and a recording sandbox, not started: for the tests that read its settings."""
    seams.setdefault("runtime", cast("GuestRuntime", StubRuntime()))
    seams.setdefault("sandbox", cast("Sandbox", RecordingSandbox([])))
    return Datum(config=DatumConfig.model_validate(dict(config or {})), **seams)


def capabilities_of(datum: Datum) -> dict[str, Any]:
    """The `capabilities` of `datum.info()` as a plain dict."""
    return cast("dict[str, Any]", datum.info()["capabilities"])


def assign(target: object, name: str, value: object) -> None:
    """Set an attribute by a name held in a variable (a frozen record refuses it; the test expects that)."""
    setattr(target, name, value)


def attr_of(record: object, name: str) -> Any:
    """Read an attribute of a record whose class the test only knows by behaviour."""
    return getattr(record, name)
