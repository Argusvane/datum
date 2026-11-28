"""Fakes for the PDF route tests: a scripted PDF program, a sandbox that judges, a signer, a `Datum` and an app.

The API under test is named in the import lines: `routers.pdf` (privileged), `datum_fastapi.Datum` with the PDF keywords
and `Datum.async_pdf`. The scripted program answers the way the real one does for the members the host reads
(`capabilities`, `document`, `sign`, `complete`, `verify`); the real program is driven by the in-process round trips of
argusvane-datum-core and by the wire gate. Everything that signs uses a `datum_core.testing.tsa_pki` identity.
"""

import base64
import json
import threading
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import Any, cast

from datum_fakes import StubRepository, definition, merged
from fastapi import FastAPI

from datum_core import DatumConfig
from datum_core.events import DatumEvent, DatumRuntimeReadyEvent
from datum_core.testing.pdf_handoff import signing_handoff
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity
from datum_fastapi import Datum, routers
from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import PDF_ABI_MIN, Sandbox, SandboxResult, Smoke
from datum_sandbox.testing.runtime_support import program_parts
from datum_sandbox.wasi import EngineInfo, GuestRun, GuestRuntime, RunBudget, RunEnd, RunResult

PDF_MEDIA = "application/pdf"
HEAD = b"%PDF-1.7\n"
ENDPOINTS = {"pdf": True, "fill": True, "sign": True, "verify": True, "certificate": True, "definition": True}


def b64(data: bytes) -> str:
    return base64.b64encode(data).decode("ascii")


def fake_pdf(tag: str = "doc") -> bytes:
    return HEAD + f"% scripted {tag}\n".encode()


def envelope(name: str = "Ada Lovelace", *, form: str = "contact", version: str = "1") -> dict[str, Any]:
    return {
        "versionContext": {
            "form": {"id": form, "version": version},
            "client": {"runtimeVersion": "x", "rendererVersion": "x", "schemaVersion": "1"},
        },
        "submission": {"locale": "en", "values": {"name": name}},
    }


def pdf_definition(*layouts: dict[str, Any]) -> dict[str, Any]:
    form = definition("contact")
    if layouts:
        form["pdf"] = {"layouts": list(layouts)}
    return form


def template_layout(layout_id: str = "t1") -> dict[str, Any]:
    return {
        "id": layout_id,
        "kind": "template",
        "template": {
            "storage": "base64",
            "name": "t.pdf",
            "type": "application/pdf",
            "size": 9,
            "data": b64(fake_pdf("t")),
        },
        "fields": [],
    }


def generated_layout(layout_id: str = "g1") -> dict[str, Any]:
    return {"id": layout_id, "kind": "generated", "root": {"id": "doc", "type": "pdf-document", "children": {}}}


def algorithm_of(signature: Mapping[str, Any]) -> str:
    """Return the algorithm the real program picks for a request's `signature`: decided by the leaf's key."""
    from cryptography import x509  # noqa: PLC0415 - tests only
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415

    certificates = signature.get("certificates") or []
    if not certificates:
        return "RSASSA-PKCS1-v1_5-SHA256"
    key = x509.load_der_x509_certificate(base64.b64decode(certificates[0])).public_key()
    if isinstance(key, ec.EllipticCurvePublicKey):
        return "ECDSA-P384-SHA256" if key.curve.name == "secp384r1" else "ECDSA-P256-SHA256"
    return "RSASSA-PKCS1-v1_5-SHA256"


class ScriptedProgram:
    """A `GuestRuntime` whose PDF program answers by op; `calls` holds what it was asked, in order."""

    def __init__(self, *, abi: str = PDF_ABI_MIN) -> None:
        self.abi = abi
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.budgets: list[RunBudget] = []
        self.answers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}
        self.ends: dict[str, RunEnd] = {}
        self.raises: dict[str, Exception] = {}
        self._lock = threading.Lock()
        self._serial = 0

    def ops(self) -> list[str]:
        """The operations requests asked, in order; the ABI gate's `capabilities` question is left out.

        The start (and a recheck) asks `capabilities` to prove the program before any route answers, so "no run" for a
        request means no other op; `requests("capabilities")` still holds the proof's questions.
        """
        return [op for op, _ in self.calls if op != "capabilities"]

    def requests(self, op: str) -> list[dict[str, Any]]:
        return [request for name, request in self.calls if name == op]

    def run(self, job: GuestRun, /) -> RunResult:
        _, _, _, stdin, budget = program_parts(job)
        request = cast("dict[str, Any]", json.loads(stdin))
        op = str(request["op"])
        with self._lock:
            self.calls.append((op, request))
            self.budgets.append(budget)
        if op in self.raises:
            raise self.raises[op]
        if op in self.ends:
            return RunResult(self.ends[op], b"", b"", None)
        answer = self.answers[op](request) if op in self.answers else self._default(op, request)
        answer.setdefault("ok", True)
        if answer["ok"]:
            answer.setdefault("op", op)
        return RunResult(RunEnd.CLEAN, json.dumps(answer).encode(), b"", 0)

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="scripted", release="1", mode="test")

    def close(self) -> None:
        return None

    def _handoff(self, signature: Mapping[str, Any], prepared: bytes) -> dict[str, Any]:
        """The handoff over `prepared`, as the program makes it; each one's attributes differ (a signing time)."""
        with self._lock:
            self._serial += 1
            serial = self._serial
        return signing_handoff(prepared, algorithm=algorithm_of(signature), serial=serial)

    def _default(self, op: str, request: dict[str, Any]) -> dict[str, Any]:
        if op == "capabilities":
            return {"abi": self.abi, "kernelVersion": "0.1.0"}
        if op in {"document", "fill"}:
            answer: dict[str, Any] = {
                "bytes": b64(fake_pdf(op)),
                "pageCount": 2,
                "pages": [],
                "warnings": [],
                "layoutId": "default",
                "layoutKind": "derived",
            }
            if isinstance(request.get("signature"), dict):
                answer["signing"] = self._handoff(request["signature"], fake_pdf(op))
            return answer
        if op == "sign":
            prepared = fake_pdf("prepared")
            return {"bytes": b64(prepared), "signing": self._handoff(request["signature"], prepared), "warnings": []}
        if op == "complete":
            return {
                "bytes": b64(fake_pdf("signed")),
                "field": "Signature1",
                "cms": b64(b"c"),
                "timestamped": "timestamp" in request["signing"],
            }
        if op == "verify":
            return {"signatures": [], "attachments": [], "warnings": [], "documentId": None}
        return {"ok": False, "error": {"code": "invalid_request", "message": op}}


class PdfSandbox:
    """The sandbox the dry run asks: it accepts the document's values unless `verdict` says otherwise."""

    def __init__(self) -> None:
        self.program = None
        self.verdict: SandboxResult | None = None
        self.error: Exception | None = None
        self.validations = 0

    def prove_abi(self) -> None:
        return None

    def smoke(self) -> Smoke:
        return Smoke(ok=True, elapsed=0.0, message="")

    def validate(self, context: Mapping[str, JsonValue], rules: Sequence[Any] = (), *, real: bool) -> SandboxResult:
        self.validations += 1
        if self.error is not None:
            raise self.error
        if self.verdict is not None:
            return self.verdict
        values = context.get("values")
        return SandboxResult({"errors": [], "values": dict(values) if isinstance(values, dict) else {}}, 0.0)

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        return dict(definition)


def required_missing() -> SandboxResult:
    error: dict[str, JsonValue] = {"code": "required", "componentId": "name", "path": "name", "severity": "error"}
    return SandboxResult({"errors": [error], "values": {}}, 0.0)


class Signer:
    """A `PdfSigner` over a test-PKI identity; it counts its signatures."""

    def __init__(self, identity: TsaIdentity) -> None:
        self.identity = identity
        self.signs = 0

    def certificates(self) -> tuple[bytes, ...]:
        return self.identity.chain_der

    @property
    def algorithm(self) -> str:
        return "RSASSA-PKCS1-v1_5-SHA256" if self.identity.algorithm == "rsa-sha256" else "ECDSA-P256-SHA256"

    def sign(self, to_be_signed: bytes) -> bytes:
        self.signs += 1
        return self.identity.sign(to_be_signed)


@dataclass
class Parts:
    """The recording seams of one PDF `Datum`, kept together for the assertions."""

    program: ScriptedProgram = field(default_factory=ScriptedProgram)
    sandbox: PdfSandbox = field(default_factory=PdfSandbox)
    signer: Signer | None = None
    events: list[DatumEvent] = field(default_factory=lambda: cast("list[DatumEvent]", []))

    def record(self, event: DatumEvent) -> None:
        if not isinstance(event, DatumRuntimeReadyEvent):
            self.events.append(event)

    def kinds(self) -> list[str]:
        return [type(event).__name__ for event in self.events]


def pdf_sections(**pdf: Any) -> dict[str, Any]:
    seal = {"enabled": True, "timestamp": False}
    seal.update(pdf.pop("seal", {}))
    return {"pdf": {"enabled": True, "seal": seal, **pdf}}


def config(
    *, pdf: dict[str, Any] | None = None, endpoints: Mapping[str, bool] | None = None, **more: Any
) -> DatumConfig:
    base: dict[str, Any] = {"web": {"api": {"endpoints": dict(ENDPOINTS if endpoints is None else endpoints)}}}
    return DatumConfig.model_validate(merged(merged(base, pdf_sections(**(pdf or {}))), more))


def make_datum(
    cfg: DatumConfig | None = None, parts: Parts | None = None, *, form: dict[str, Any] | None = None, **seams: Any
) -> tuple[Datum, Parts]:
    parts = parts or Parts()
    options: dict[str, Any] = {
        "config": cfg or config(),
        "runtime": cast("GuestRuntime", parts.program),
        "sandbox": cast("Sandbox", parts.sandbox),
        "form_repository": StubRepository(form or pdf_definition()),
        "listeners": [(DatumEvent, parts.record)],
        "now": lambda: INSTANT,
    }
    if parts.signer is not None:
        options["pdf_signer"] = parts.signer
    options.update(seams)
    return Datum(**options), parts


def build_app(
    datum: Datum, *, dependencies: Sequence[Any] = (), prefix: str | None = None, **app_kwargs: Any
) -> FastAPI:
    app = FastAPI(**app_kwargs)
    router = (
        routers.pdf(datum, dependencies=list(dependencies))
        if prefix is None
        else routers.pdf(datum, prefix=prefix, dependencies=list(dependencies))
    )
    app.include_router(router)
    return app


def operations_of(router: Any) -> dict[str, Any]:
    return {route.operation_id: route for route in router.routes if getattr(route, "operation_id", None)}
