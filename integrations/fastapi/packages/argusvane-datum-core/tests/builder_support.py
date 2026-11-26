"""Fakes and a rig for the builder tests: a stage trail shared by every seam, a rig that starts a `Datum`.

Every seam the builder touches (the kernel's check, the repository's writes, the snapshot and translation stores, each
customizer and validator, the saved event) appends its own name to one `trail`, so a test reads the order the service
called them in. The rig starts a real `datum_core.Datum` over a stub runtime and a recording sandbox (no engine) and a
`MemoryFormDefinitionRepository`, then clears the trail, so what is left is the request's own path.

The API under test is named in this one place and in the import lines of the test modules: the
builder package (`datum_core.builder`), the writable repository (`datum_core.stores.memory`), `Datum.builder_service`
and the two hook keywords of the constructor.
"""

import copy
import threading
from collections.abc import Callable, Iterator, Mapping, Sequence
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import UTC, datetime
from typing import Any, cast

from submissions_support import StubRuntime, ThreadLoopAwaiter

from datum_core import Datum, DatumConfig
from datum_core.builder import BuilderOutcome, BuilderSaveCandidate, BuilderSaveDraft, BuilderService
from datum_core.events import DatumEvent
from datum_core.forms import StoredDefinition
from datum_core.hooks import Awaiter, HookFindings, HookRefusedError
from datum_core.stores import Catalog, CatalogView, StoredCatalog
from datum_core.stores.memory import (
    MemoryDefinitionSnapshotStore,
    MemoryFormDefinitionRepository,
    MemoryTranslationCatalogStore,
)
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import Program, ProgramKind, RuleModule, Sandbox, SandboxResult, Smoke

FORM = "contact"
VERSION = "1"
MARKER = "ZZSECRETZZ"
"""A server-secret rule's formula text: it must never reach a log, an event or an error body."""
FIXED_NOW = datetime(2026, 10, 21, 9, 30, 0, tzinfo=UTC)
PRINCIPAL = object()


def definition(
    form_id: str = FORM, version: str = VERSION, *, secret: bool = False, label: str = "Name"
) -> dict[str, Any]:
    """A small valid definition: a form root with one text component (and, with `secret`, a server-secret rule)."""
    rules: dict[str, Any] = {}
    if secret:
        rules = {"requiredWhen": {"run": "server-secret", "formula": f'name = "{MARKER}"'}}
    return {
        "id": form_id,
        "version": version,
        "root": {
            "id": "form",
            "type": "form",
            "children": {
                "content": [{"id": "name", "type": "text", "configuration": {"label": label}, "rules": rules}]
            },
        },
    }


def content_of(value: dict[str, Any]) -> list[dict[str, Any]]:
    """The root's content list of a definition built by `definition()` (the list the tests add components to)."""
    return cast("list[dict[str, Any]]", value["root"]["children"]["content"])


def finding(code: str, where: str = "rules:name:requiredWhen", message: str = "A finding.") -> dict[str, JsonValue]:
    """One kernel finding as the check op writes it (`code`, `where`, `message`)."""
    return {"code": code, "where": where, "message": message}


def verdict(
    *,
    problems: Sequence[Mapping[str, JsonValue]] = (),
    warnings: Sequence[Mapping[str, JsonValue]] = (),
    structure: Sequence[Mapping[str, JsonValue]] = (),
    structure_warnings: Sequence[Mapping[str, JsonValue]] = (),
) -> dict[str, JsonValue]:
    """The check op's answer: formula problems and warnings, structure refusals and warnings, and the verdict word."""
    failed = bool(problems or structure)
    return {
        "ok": True,
        "op": "check",
        "policy": "fail",
        "problems": [dict(item) for item in problems],
        "warnings": [dict(item) for item in warnings],
        "structure": [dict(item) for item in structure],
        "structureWarnings": [dict(item) for item in structure_warnings],
        "verdict": "fail" if failed else "pass",
    }


def _without_secret_rules(node: Any) -> Any:
    """What the kernel's public copy does: remove every rule whose `run` is `server-secret`."""
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


class CheckSandbox:
    """The sandbox as the builder uses it: `check` records its ask and answers `answer` (or raises `error`)."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.program = Program(ProgramKind.SANDBOX, b"stub")
        self.answer: dict[str, JsonValue] = verdict()
        self.error: Exception | None = None
        self.checks: list[tuple[dict[str, Any], list[str], tuple[RuleModule, ...]]] = []
        self.public_copies = 0
        self.hold_first: threading.Event | None = None
        self.entered = threading.Event()
        self._first = True
        self._lock = threading.Lock()

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        self.trail.append("sandbox.check")
        with self._lock:
            self.checks.append((copy.deepcopy(dict(definition)), list(types), tuple(rules)))
            held = self.hold_first is not None and self._first
            self._first = False
        if held and self.hold_first is not None:
            self.entered.set()
            self.hold_first.wait(30)
        if self.error is not None:
            raise self.error
        return copy.deepcopy(self.answer)

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        self.trail.append("sandbox.public_copy")
        self.public_copies += 1
        return cast("dict[str, JsonValue]", _without_secret_rules(copy.deepcopy(dict(definition))))

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        self.trail.append("sandbox.validate")
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
        self.trail.append("sandbox.inspect")
        return {"ok": True, "op": op}

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def prove_abi(self) -> None:
        return None


class TrailRepository:
    """A writable repository over a `MemoryFormDefinitionRepository` that puts its writes on the trail."""

    def __init__(self, trail: list[str], inner: MemoryFormDefinitionRepository) -> None:
        self.trail = trail
        self.inner = inner
        self.fail: Exception | None = None
        self.interfere: Callable[[], None] | None = None
        """Run once right before the next write reaches the inner repository: another instance's write landing."""

    def current(self, key: str) -> StoredDefinition | None:
        return self.inner.current(key)

    def _interfere(self) -> None:
        if self.interfere is not None:
            hook, self.interfere = self.interfere, None
            hook()

    def create(self, key: str, definition: Mapping[str, JsonValue]) -> StoredDefinition | None:
        self.trail.append("repository.create")
        if self.fail is not None:
            raise self.fail
        self._interfere()
        return self.inner.create(key, definition)

    def replace(
        self, key: str, definition: Mapping[str, JsonValue], expected_sha256: str | None
    ) -> StoredDefinition | None:
        self.trail.append("repository.replace")
        if self.fail is not None:
            raise self.fail
        self._interfere()
        return self.inner.replace(key, definition, expected_sha256)


class TrailSnapshots:
    """A snapshot store over the memory one; `fail` is raised by `record` (a store's own failure, or any other)."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.inner = MemoryDefinitionSnapshotStore(500)
        self.fail: Exception | None = None

    def record(self, key: str, sha256: str, definition: Mapping[str, JsonValue]) -> None:
        self.trail.append("snapshots.record")
        if self.fail is not None:
            raise self.fail
        self.inner.record(key, sha256, definition)

    def find(self, key: str, sha256: str) -> dict[str, JsonValue] | None:
        return self.inner.find(key, sha256)


class TrailTranslations:
    """A translation store over the memory one; `write` is on the trail, `fail_write` makes it raise."""

    def __init__(self, trail: list[str]) -> None:
        self.trail = trail
        self.inner = MemoryTranslationCatalogStore(1000)
        self.fail_write: Exception | None = None
        self.interfere: Callable[[], None] | None = None
        self.interfere_always = False
        self.writes: list[tuple[str, Catalog, str]] = []
        self.reads: list[str] = []

    def read(self, key: str) -> StoredCatalog | None:
        self.reads.append(key)
        return self.inner.read(key)

    def write(self, key: str, catalog: CatalogView, *, expected_etag: str) -> StoredCatalog | None:
        self.trail.append("translations.write")
        self.writes.append((key, cast("Catalog", copy.deepcopy(catalog)), expected_etag))
        if self.interfere is not None:
            hook = self.interfere
            if not self.interfere_always:
                self.interfere = None
            hook()  # another writer lands between this call's read and its write
        if self.fail_write is not None:
            raise self.fail_write
        return self.inner.write(key, catalog, expected_etag=expected_etag)


def customizer(
    name: str,
    trail: list[str],
    *,
    change: Callable[[BuilderSaveDraft], None] | None = None,
    refuse: HookRefusedError | None = None,
    fail: Exception | None = None,
    seen: list[BuilderSaveDraft] | None = None,
) -> Callable[[BuilderSaveDraft], None]:
    """A save customizer that records its place and may change the draft, refuse, or raise."""

    def run(draft: BuilderSaveDraft) -> None:
        trail.append(f"customizer:{name}")
        if seen is not None:
            seen.append(draft)
        if refuse is not None:
            raise refuse
        if fail is not None:
            raise fail
        if change is not None:
            change(draft)

    return run


def validator(
    name: str,
    trail: list[str],
    *,
    findings: HookFindings | None = None,
    refuse: HookRefusedError | None = None,
    fail: Exception | None = None,
    seen: list[BuilderSaveCandidate] | None = None,
) -> Callable[[BuilderSaveCandidate], HookFindings | None]:
    """A save validator that records its place and answers findings, refuses, or raises."""

    def run(candidate: BuilderSaveCandidate) -> HookFindings | None:
        trail.append(f"validator:{name}")
        if seen is not None:
            seen.append(candidate)
        if refuse is not None:
            raise refuse
        if fail is not None:
            raise fail
        return findings

    return run


@dataclass
class Rig:
    """A started `Datum` and the recording seams it was built with."""

    datum: Datum
    trail: list[str]
    sandbox: CheckSandbox
    repository: TrailRepository
    snapshots: TrailSnapshots
    translations: TrailTranslations
    events: list[DatumEvent] = field(default_factory=lambda: cast("list[DatumEvent]", []))

    @property
    def service(self) -> BuilderService:
        return self.datum.builder_service

    def stored(self, key: str = FORM) -> StoredDefinition:
        found = self.repository.inner.current(key)
        assert found is not None
        return found

    def current_hash(self, key: str = FORM) -> str:
        return self.stored(key).sha256

    def save(
        self,
        value: object | None = None,
        *,
        key: str = FORM,
        expected: str | None = "current",
        principal: object | None = None,
        changes: Any = None,
    ) -> BuilderOutcome:
        """Save `value` (a valid definition by default) as `key`; `expected="current"` names the stored hash."""
        sha = self.current_hash(key) if expected == "current" else expected
        return self.service.save(
            key, definition(key) if value is None else value, expected_sha256=sha, principal=principal, changes=changes
        )

    def create(
        self, value: object | None = None, *, principal: object | None = None, changes: Any = None
    ) -> BuilderOutcome:
        return self.service.create(
            definition("fresh") if value is None else value, principal=principal, changes=changes
        )

    def steps(self) -> list[str]:
        """The trail without the sandbox-free noise: every recorded step, in order."""
        return list(self.trail)


@contextmanager
def started_builder(
    config: Mapping[str, Any] | DatumConfig | None = None,
    *,
    seed: Sequence[Mapping[str, JsonValue]] | None = None,
    awaiter: Awaiter | None = None,
    trail: list[str] | None = None,
    **seams: Any,
) -> Iterator[Rig]:
    """Start a `Datum` with the builder on over the recording seams (a `seams` keyword replaces the recording one).

    Pass `trail` to share the list with hooks built before the start (the rig clears it once the start is done).
    """
    trail = [] if trail is None else trail
    events: list[DatumEvent] = []
    sandbox = CheckSandbox(trail)
    inner = MemoryFormDefinitionRepository(seed=[definition()] if seed is None else list(seed))
    repository = TrailRepository(trail, inner)
    snapshots = TrailSnapshots(trail)
    translations = TrailTranslations(trail)

    def record_event(event: DatumEvent) -> None:
        trail.append(f"event:{type(event).__name__}")
        events.append(event)

    options: dict[str, Any] = {
        "form_repository": repository,
        "snapshot_store": snapshots,
        "translation_store": translations,
        "listeners": [(DatumEvent, record_event)],
        "now": lambda: FIXED_NOW,
    }
    options.update(seams)
    base: dict[str, Any] = {"builder": {"enabled": True}}
    if isinstance(config, DatumConfig):
        settings = config
    else:
        merged = {**base, **dict(config or {})}
        if "builder" in (config or {}):
            merged["builder"] = {**base["builder"], **dict((config or {})["builder"])}
        settings = DatumConfig.model_validate(merged)
    datum = Datum(config=settings, runtime=cast("Any", StubRuntime()), sandbox=cast("Sandbox", sandbox), **options)
    datum.start(awaiter=awaiter)
    trail.clear()
    events.clear()  # the start published its own ready event
    try:
        yield Rig(datum, trail, sandbox, repository, snapshots, translations, events)
    finally:
        datum.stop()


def with_awaiter() -> ThreadLoopAwaiter:
    """An awaiter for a sync caller whose hooks are `async def` (close it when the test is done)."""
    return ThreadLoopAwaiter()


def plain_builder_datum(config: Mapping[str, Any] | None = None, **seams: Any) -> Datum:
    """A `Datum` over a stub runtime and the check sandbox, not started: for the tests that read its settings."""
    base: dict[str, Any] = {"builder": {"enabled": True}}
    seams.setdefault("runtime", cast("Any", StubRuntime()))
    seams.setdefault("sandbox", cast("Sandbox", CheckSandbox([])))
    return Datum(config=DatumConfig.model_validate({**base, **dict(config or {})}), **seams)
