"""Fakes shared by the binding's tests: a runtime and a sandbox that need no engine, a repository, two dependencies."""

import copy
import hashlib
import json
import threading
from collections.abc import Callable, Mapping
from typing import Annotated, Any, cast

from fastapi import Header, HTTPException, Request, Security
from fastapi.security import APIKeyHeader
from trace_log import TRACE

from datum_core import DatumConfig
from datum_core.canonical import canonical_digest
from datum_core.forms import StoredDefinition
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import Sandbox, Smoke
from datum_sandbox.wasi import EngineInfo, GuestRuntime

SECRET_MARKER = "ZZSECRETZZ"
HEADERS = {"x-a": "1", "x-b-key": "k"}


def definition(form_id: str = "contact", version: str = "1", *, secret: bool = False) -> dict[str, Any]:
    rules: dict[str, Any] = {}
    if secret:
        rules = {"requiredWhen": {"run": "server-secret", "formula": f'name = "{SECRET_MARKER}"'}}
    return {
        "id": form_id,
        "version": version,
        "root": {
            "id": "form",
            "type": "form",
            "children": {
                "content": [{"id": "name", "type": "text", "configuration": {"label": "Name"}, "rules": rules}]
            },
        },
    }


def strip_secret(node: Any) -> Any:
    if isinstance(node, dict):
        return {
            key: strip_secret(value)
            for key, value in node.items()
            if not (isinstance(value, dict) and value.get("run") == "server-secret")
        }
    if isinstance(node, list):
        return [strip_secret(item) for item in node]
    return node


class StubRuntime:
    """A `GuestRuntime` that is only an identity and a `close`."""

    def __init__(self) -> None:
        self.closed = 0

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="stub", release="1.0", mode="test")

    def close(self) -> None:
        self.closed += 1


class StubSandbox:
    """The sandbox operations a start and the forms routes use."""

    def __init__(self, *, gate: threading.Event | None = None) -> None:
        self.abi_proofs = 0
        self.public_copies = 0
        self.gate = gate
        self.entered = threading.Event()

    def prove_abi(self) -> None:
        self.abi_proofs += 1

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.public_copies += 1
        self.entered.set()
        if self.gate is not None:
            self.gate.wait(10)
        return cast("dict[str, JsonValue]", strip_secret(copy.deepcopy(dict(definition))))


class StubRepository:
    """A form repository over a dictionary."""

    def __init__(self, *forms: dict[str, Any]) -> None:
        self.forms = {form["id"]: form for form in forms}

    def current(self, key: str) -> StoredDefinition | None:
        form = self.forms.get(key)
        return None if form is None else StoredDefinition(key=key, definition=form, sha256=canonical_digest(form))


def runtime_of(stub: StubRuntime) -> GuestRuntime:
    return cast("GuestRuntime", stub)


def sandbox_of(stub: StubSandbox) -> Sandbox:
    return cast("Sandbox", stub)


def merged(base: dict[str, Any], extra: Mapping[str, Any]) -> dict[str, Any]:
    """Deep merge: `extra` wins, nested dictionaries are merged rather than replaced."""
    out = dict(base)
    for key, value in extra.items():
        out[key] = merged(out[key], value) if isinstance(value, Mapping) and isinstance(out.get(key), dict) else value
    return out


def config(*, definition_route: bool = True, **sections: Any) -> DatumConfig:
    """A configuration with the definition and data-source endpoints on, plus any sections given (merged deeply)."""
    base: dict[str, Any] = {
        "web": {"api": {"endpoints": {"definition": definition_route, "data_sources": definition_route}}}
    }
    return DatumConfig.model_validate(merged(base, sections))


def etag_of(body: bytes) -> str:
    return '"' + hashlib.sha256(body).hexdigest() + '"'


# ---- the application's own dependencies (a pair) ------------------------------------------------------------
def dep_a(request: Request, x_a: Annotated[str | None, Header()] = None) -> None:
    TRACE.append("a")


_key_b = APIKeyHeader(name="x-b-key", auto_error=False)


def dep_b(request: Request, key: Annotated[str | None, Security(_key_b)] = None) -> None:
    TRACE.append("b")


def refusing(status: int, label: str) -> Callable[[Request], None]:
    def dependency(request: Request) -> None:
        TRACE.append(label)
        raise HTTPException(status, f"{label} refused")

    return dependency


def body_json(body: bytes) -> Any:
    return json.loads(body)
