"""Fakes for the submission route tests: a recording sandbox, throttle and handler on the shared TRACE, an app
builder."""

import hashlib
import json
import threading
import uuid
from collections.abc import Mapping, Sequence
from typing import Any, cast

from datum_fakes import StubRepository, StubRuntime, definition, merged, runtime_of
from fastapi import APIRouter, FastAPI
from fastapi.routing import APIRoute
from trace_log import TRACE

from datum_core import DatumConfig
from datum_core.events import DatumEvent, DatumRuntimeReadyEvent
from datum_core.submissions import Allow, SubmissionReceipt
from datum_core.throttle import Allow as ThrottleAllow
from datum_core.throttle import Deny, ThrottleKey
from datum_fastapi import Datum, routers
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import Program, ProgramKind, RuleModule, Sandbox, SandboxResult, Smoke

FORM = "contact"
SWITCHES = {"submissions": True, "validate": True, "test": True, "inspect": True}


def sections(**more: Any) -> dict[str, Any]:
    """Every submissions endpoint on, merged with `more` (deeply)."""
    return merged({"web": {"api": {"endpoints": dict(SWITCHES)}}}, more)


def config(**more: Any) -> DatumConfig:
    return DatumConfig.model_validate(sections(**more))


def envelope(*, form: str = FORM, version: str = "1", values: Mapping[str, Any] | None = None) -> dict[str, Any]:
    return {
        "versionContext": {"form": {"id": form, "version": version}, "client": {"runtimeVersion": "x"}},
        "submission": {"locale": "en", "values": dict({"name": "Ada Lovelace"} if values is None else values)},
    }


def body_of(document: Mapping[str, Any] | None = None, *, wrapped: bool = True, key: str | None = None) -> bytes:
    """The body of a delivery: `{document, submissionKey}` with `key`, else a fresh key (one submit attempt)."""
    document = envelope() if document is None else document
    if not wrapped:
        return json.dumps(document).encode()
    return json.dumps({"document": document, "submissionKey": key or str(uuid.uuid4())}).encode()


def check_body_of(document: Mapping[str, Any] | None = None, scope: str = "journey", **more: Any) -> bytes:
    """The body of a `validate`: `{document, scope}`, with `pageId` for a page check in `more`."""
    return json.dumps({"document": envelope() if document is None else document, "scope": scope, **more}).encode()


def digest_of(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


class RecordingSandbox:
    """The submissions sandbox: appends `sandbox` to TRACE; `gate` holds a run open; `error` makes it fail."""

    def __init__(self, *, gate: threading.Event | None = None) -> None:
        self.program = Program(ProgramKind.SANDBOX, b"stub")
        self.verdict: SandboxResult | None = None
        self.error: Exception | None = None
        self.gate = gate
        self.entered = threading.Event()
        self.contexts: list[dict[str, JsonValue]] = []
        self.inspections: list[str] = []

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        TRACE.append("sandbox")
        self.contexts.append(dict(context))
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(30)
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
        TRACE.append("sandbox.inspect")
        self.inspections.append(op)
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


class RecordingThrottle:
    """Appends `throttle` to TRACE; `deny` makes it answer a 429 for that many seconds."""

    def __init__(self) -> None:
        self.keys: list[ThrottleKey] = []
        self.deny: int | None = None

    def check(self, key: ThrottleKey) -> ThrottleAllow | Deny:
        TRACE.append("throttle")
        self.keys.append(key)
        return ThrottleAllow() if self.deny is None else Deny(retry_after=self.deny)

    def record(self, key: ThrottleKey) -> None:
        return None


class Handler:
    def __init__(self) -> None:
        self.calls: list[Any] = []
        self.fail: Exception | None = None
        self.gate: threading.Event | None = None
        self.entered = threading.Event()

    def __call__(self, accepted: Any) -> SubmissionReceipt:
        TRACE.append("handler")
        self.calls.append(accepted)
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(30)
        if self.fail is not None:
            raise self.fail
        return SubmissionReceipt(id=f"id-{len(self.calls)}", reference=f"REF-{len(self.calls)}")


def pre_check_that_records(incoming: Any) -> Allow:
    TRACE.append("pre_check")
    return Allow()


class Parts:
    """The recording seams of one `Datum`, kept together for the assertions."""

    def __init__(self, *, gate: threading.Event | None = None) -> None:
        self.sandbox = RecordingSandbox(gate=gate)
        self.throttle = RecordingThrottle()
        self.handler = Handler()
        self.events: list[Any] = []

    def record(self, event: DatumEvent) -> None:
        """Keep the events a request made; the start's own ready event is not one of them."""
        if not isinstance(event, DatumRuntimeReadyEvent):
            self.events.append(event)


def make_datum(cfg: DatumConfig | None = None, parts: Parts | None = None, **seams: Any) -> tuple[Datum, Parts]:
    parts = parts or Parts()
    options: dict[str, Any] = {
        "config": cfg or config(),
        "runtime": runtime_of(StubRuntime()),
        "sandbox": cast("Sandbox", parts.sandbox),
        "form_repository": StubRepository(definition(FORM)),
        "throttle": parts.throttle,
        "handler": parts.handler,
        "listeners": [(DatumEvent, parts.record)],
    }
    options.update(seams)
    return Datum(**options), parts


def build_app(datum: Datum, *, authoring: Sequence[Any] | None = None, submissions: Sequence[Any] = ()) -> FastAPI:
    """The application: the public router, and the authoring router when `authoring` dependencies are given."""
    app = FastAPI()
    app.include_router(routers.submissions(datum, dependencies=list(submissions)))
    if authoring is not None:
        app.include_router(routers.authoring(datum, dependencies=list(authoring)))
    return app


def operations_of(router: APIRouter) -> dict[str, APIRoute]:
    """The router's API routes by operation id."""
    return {route.operation_id: route for route in router.routes if isinstance(route, APIRoute) and route.operation_id}


def paths_of(router: APIRouter) -> set[str]:
    """The paths of the router's API routes."""
    return {route.path for route in router.routes if isinstance(route, APIRoute)}
