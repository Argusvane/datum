"""Fakes for the forms tests: a stage log shared by a repository, a snapshot store, customizers and a sandbox."""

import copy
import hashlib
import json
from collections.abc import Mapping, Sequence
from typing import Any, cast

from datum_core.canonical import canonical_digest
from datum_core.hooks import HookRefusedError
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import ProgramUnavailableError, Sandbox

SECRET_MARKER = "ZZSECRETZZ"


def definition(form_id: str = "contact", version: str = "1", *, secret: bool = True) -> dict[str, Any]:
    """A small definition; with `secret` one component carries a server-secret rule naming the marker."""
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
                "content": [
                    {"id": "name", "type": "text", "configuration": {"label": "Name"}, "rules": rules},
                    {"id": "city", "type": "text", "configuration": {"label": "City"}},
                ]
            },
        },
    }


def stored_hash(value: Mapping[str, Any]) -> str:
    return canonical_digest(value)


def strip_secret(node: Any) -> Any:
    """What the kernel's public copy does: remove every rule whose `run` is `server-secret`."""
    if isinstance(node, dict):
        record = cast("dict[str, Any]", node)
        return {
            key: strip_secret(value)
            for key, value in record.items()
            if not (isinstance(value, dict) and cast("dict[str, Any]", value).get("run") == "server-secret")
        }
    if isinstance(node, list):
        return [strip_secret(item) for item in cast("list[Any]", node)]  # type: ignore[redundant-cast]
    return node


def has_secret_rule(node: Any) -> bool:
    return "server-secret" in json.dumps(node)


class LogSandbox:
    """The one `Sandbox` operation the definition service uses; logs into the shared stage log."""

    def __init__(self, log: list[str], *, down: Exception | None = None) -> None:
        self.log = log
        self.down = down
        self.inputs: list[dict[str, Any]] = []

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.log.append("sandbox.public_copy")
        self.inputs.append(copy.deepcopy(dict(definition)))
        if self.down is not None:
            raise self.down
        return cast("dict[str, JsonValue]", strip_secret(copy.deepcopy(dict(definition))))

    def provider(self) -> Sandbox:
        """What the service is handed: a callable resolving the sandbox lazily."""
        if self.down is not None and isinstance(self.down, ProgramUnavailableError):
            self.log.append("sandbox.lookup")
        return cast("Sandbox", self)


class LogCustomizer:
    """A customizer that records its place and may change the draft, refuse, or name a cache key."""

    def __init__(
        self,
        name: str,
        log: list[str],
        *,
        change: Any = None,
        refuse: HookRefusedError | None = None,
        key: Any = None,
    ) -> None:
        self.name = name
        self.log = log
        self.change = change
        self.refuse = refuse
        self.key = key
        self.seen: list[Any] = []

    def __call__(self, draft: Any) -> None:
        self.log.append(f"customizer:{self.name}")
        self.seen.append((draft.request, copy.deepcopy(draft.definition)))
        if self.refuse is not None:
            raise self.refuse
        if self.change is not None:
            self.change(draft)

    def cache_key(self, request: Any) -> str | None:
        if callable(self.key):
            return cast("str | None", self.key(request))
        return cast("str | None", self.key)


def etag_of(body: bytes) -> str:
    return '"' + hashlib.sha256(body).hexdigest() + '"'


def keys_of(records: Sequence[Any]) -> list[str]:
    return [record.key for record in records]
