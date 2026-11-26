"""Fakes for the builder route tests: a recording sandbox with a kernel check, a memory repository, a persona, an app.

The builder routes are privileged, so every app here puts the persona dependency in front of them: someone who sends no
`X-Persona` header is refused 401, someone who is not `person` 403, `person` builds. The author's-copy route and the
public one share a path; `build_app` includes them in either order. The assumed API (`routers.builder`,
`Datum.async_builder`, the memory repository) is spelled in the import lines.
"""

import copy
import hashlib
import json
import threading
from collections.abc import Mapping, Sequence
from typing import Annotated, Any, cast

from datum_fakes import StubRuntime, definition, merged, runtime_of
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.routing import APIRoute
from trace_log import TRACE

from datum_core import DatumConfig
from datum_core.events import DatumEvent, DatumRuntimeReadyEvent
from datum_core.stores.memory import MemoryFormDefinitionRepository
from datum_fastapi import Datum, routers
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import Program, ProgramKind, RuleModule, Sandbox, SandboxResult, Smoke

FORM = "contact"
MARKER = "ZZSECRETZZ"
PERSON = {"X-Persona": "person"}
OTHER = {"X-Persona": "other"}
JSON_TYPE = {"Content-Type": "application/json"}
WRITE = {**PERSON, **JSON_TYPE}


def sections(**more: Any) -> dict[str, Any]:
    """The builder and the definition route on, merged with `more` (deeply)."""
    return merged({"builder": {"enabled": True}, "web": {"api": {"endpoints": {"definition": True}}}}, more)


def config(**more: Any) -> DatumConfig:
    return DatumConfig.model_validate(sections(**more))


def body_of(value: Mapping[str, Any]) -> bytes:
    return json.dumps(value).encode()


def digest_of(value: Mapping[str, Any]) -> str:
    from datum_core.canonical import canonical_digest  # noqa: PLC0415

    return canonical_digest(dict(value))


def etag_of(value: Mapping[str, Any]) -> str:
    return f'"{digest_of(value)}"'


def error_code(reply: Any) -> str:
    return str(reply.json()["errors"][0]["code"])


def _without_secret_rules(node: Any) -> Any:
    if isinstance(node, dict):
        record = cast("dict[str, Any]", node)
        return {
            key: _without_secret_rules(value)
            for key, value in record.items()
            if not (isinstance(value, dict) and cast("dict[str, Any]", value).get("run") == "server-secret")
        }
    if isinstance(node, list):
        return [_without_secret_rules(item) for item in node]
    return node


def verdict(
    *,
    problems: Sequence[Mapping[str, JsonValue]] = (),
    warnings: Sequence[Mapping[str, JsonValue]] = (),
    structure: Sequence[Mapping[str, JsonValue]] = (),
    structure_warnings: Sequence[Mapping[str, JsonValue]] = (),
) -> dict[str, JsonValue]:
    return {
        "ok": True,
        "op": "check",
        "policy": "fail",
        "problems": [dict(item) for item in problems],
        "warnings": [dict(item) for item in warnings],
        "structure": [dict(item) for item in structure],
        "structureWarnings": [dict(item) for item in structure_warnings],
        "verdict": "fail" if (problems or structure) else "pass",
    }


def finding(code: str, where: str = "rules:name:requiredWhen", message: str = "A finding.") -> dict[str, JsonValue]:
    return {"code": code, "where": where, "message": message}


class CheckSandbox:
    """The kernel as the builder asks it: `check` answers `answer`; `gate` holds it open; `error` makes it fail."""

    def __init__(self, *, gate: threading.Event | None = None) -> None:
        self.program = Program(ProgramKind.SANDBOX, b"stub")
        self.answer: dict[str, JsonValue] = verdict()
        self.error: Exception | None = None
        self.gate = gate
        self.entered = threading.Event()
        self.checks: list[dict[str, Any]] = []
        self.public_copies = 0
        self._lock = threading.Lock()

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        TRACE.append("sandbox.check")
        with self._lock:
            self.checks.append(copy.deepcopy(dict(definition)))
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(30)
        if self.error is not None:
            raise self.error
        return copy.deepcopy(self.answer)

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.public_copies += 1
        return cast("dict[str, JsonValue]", _without_secret_rules(copy.deepcopy(dict(definition))))

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        return SandboxResult({"errors": [], "values": {}}, 0.01)

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        return {"ok": True, "op": op}

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def prove_abi(self) -> None:
        return None


class Parts:
    """The recording seams of one `Datum`, kept together for the assertions."""

    def __init__(self, *, gate: threading.Event | None = None, secret: bool = False, seed: bool = True) -> None:
        self.sandbox = CheckSandbox(gate=gate)
        self.repository = MemoryFormDefinitionRepository(seed=[definition(FORM, "1", secret=secret)] if seed else [])
        self.events: list[Any] = []

    def record(self, event: DatumEvent) -> None:
        if not isinstance(event, DatumRuntimeReadyEvent):
            self.events.append(event)

    def stored(self, key: str = FORM) -> Any:
        found = self.repository.current(key)
        assert found is not None
        return found


def person_name(x_persona: Annotated[str | None, Header()] = None) -> str | None:
    """Datum's `principal` for these apps: the persona header, else anonymous."""
    return x_persona


def persona(request: Request) -> str:
    """The application's security in front of the builder: no header 401, anyone but `person` 403."""
    TRACE.append("persona")
    who = request.headers.get("x-persona")
    if who is None:
        raise HTTPException(401, "sign in")
    if who != "person":
        raise HTTPException(403, "not you")
    return who


def make_datum(cfg: DatumConfig | None = None, parts: Parts | None = None, **seams: Any) -> tuple[Datum, Parts]:
    parts = parts or Parts()
    options: dict[str, Any] = {
        "config": cfg or config(),
        "runtime": runtime_of(StubRuntime()),
        "sandbox": cast("Sandbox", parts.sandbox),
        "form_repository": parts.repository,
        "listeners": [(DatumEvent, parts.record)],
        "principal": person_name,
    }
    options.update(seams)
    return Datum(**options), parts


def build_app(
    datum: Datum,
    *,
    builder: bool = True,
    forms: bool = True,
    assets: bool = False,
    builder_first: bool = False,
    dependencies: Sequence[Any] | None = None,
) -> FastAPI:
    """Build the app: the forms router and the builder router in either order, the persona guarding the builder."""
    app = FastAPI()
    guards = [Depends(persona)] if dependencies is None else list(dependencies)

    def add_builder() -> None:
        if builder:
            app.include_router(routers.builder(datum, dependencies=guards))

    def add_forms() -> None:
        if forms:
            app.include_router(routers.forms(datum))

    if builder_first:
        add_builder()
        add_forms()
    else:
        add_forms()
        add_builder()
    if assets:
        app.include_router(routers.assets(datum))
    return app


def operations_of(router: Any) -> dict[str, APIRoute]:
    return {route.operation_id: route for route in router.routes if isinstance(route, APIRoute) and route.operation_id}


def paths_of(router: Any) -> set[str]:
    return {route.path for route in router.routes if isinstance(route, APIRoute)}


def sha_of(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()
