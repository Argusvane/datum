"""Doubles, builders and rigs for the PDF tests.

The API under test is named in the import lines here and in the test modules: the facade `datum_core.pdf`, the `Datum`
keywords (`pdf_signer`,
`timestamper`, `pdf_trust_policy`, `pdf_request_customizers`, `pdf_result_validators`, `pdf_middleware`) and
`Datum.pdf_service`.

Nothing here parses a PDF, a CMS or a token to decide anything: the scripted runtime answers what the PDF program would
(`ScriptedPdfRuntime`), the signature reports are built from a test-PKI identity so a valid value is really valid and a
forged one really is not, and the real program is driven by `pdf_kernel.py`. `kernel`-level facts that need no new name
live in `pdf_kernel.py`, which imports nothing red, so a module of those collects today.
"""

import base64
import contextlib
import json
import threading
import traceback
from collections.abc import Callable, Generator, Iterable, Iterator, Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from pathlib import Path
from typing import Any, cast

from submissions_support import (
    Handler,
    RecordingSandbox,
    RecordingThrottle,
    Repository,
    bus,
    definition,
    envelope,
    http_context,
)
from tsa_support import POLICY, leaks, make_authority, run_openssl

from datum_core import Datum, DatumConfig
from datum_core.config.models import Signing
from datum_core.events import DatumEvent
from datum_core.hooks import Awaiter
from datum_core.submissions import AcceptedSubmission, FormRef, SubmissionContext
from datum_core.testing.pdf_handoff import signing_handoff
from datum_core.testing.tsa_pki import INSTANT, TsaIdentity, bytes_to_pem
from datum_core.timestamp.protocols import TimestampChannel, TimestampGrant, TransportReply
from datum_sandbox.protocol import PDF_ABI_MIN, Sandbox
from datum_sandbox.testing.runtime_support import program_parts
from datum_sandbox.wasi import EngineInfo, GuestRun, GuestRuntime, RunBudget, RunEnd, RunResult

__all__ = [
    "ABI",
    "FEATURES",
    "FORM",
    "PDF_P12_PASSWORD",
    "AuthorityTransport",
    "IdentitySigner",
    "PdfRig",
    "RecordingTimestamper",
    "ScriptedPdfRuntime",
    "anchors_file",
    "b64",
    "bus",
    "envelope",
    "fake_pdf",
    "http_context",
    "pdf_definition",
    "pdf_signing",
    "pem_signing",
    "rsa_pss_files",
    "signature_report",
    "started_pdf",
    "template_layout",
    "timestamp_report",
    "unreadable_curve_chain",
    "verify_reply",
]

ABI = PDF_ABI_MIN
FEATURES = (
    "render",
    "layout",
    "document",
    "build",
    "fill",
    "inspect",
    "signature",
    "verify-detail",
    "output-safety",
    "render-caps",
    "attachment-types",
)
"""The program's feature list as far as the host gate reads it (the real list has 29; see `test_pdf_program_facts`)."""
FORM = "contact"
NAME = "Ada Lovelace"
PDF_HEAD = b"%PDF-1.7\n"


def b64(data: bytes) -> str:
    """Return the base64 text of `data`."""
    return base64.b64encode(data).decode("ascii")


def fake_pdf(tag: str = "doc") -> bytes:
    """Return bytes that start like a PDF and say what they stand for (the scripted program's output)."""
    return PDF_HEAD + f"% scripted {tag}\n".encode()


# -- the definition the repository serves ------------------------------------------------------------------------------


def template_layout(layout_id: str = "t1", *, data: bytes | None = None, storage: str = "base64") -> dict[str, Any]:
    """Return a template layout of a definition: inline base64 by default, else a host storage the host must resolve."""
    layout: dict[str, Any] = {
        "id": layout_id,
        "kind": "template",
        "template": {"storage": storage, "name": "t.pdf", "type": "application/pdf", "size": 9},
        "fields": [{"pdfField": "Name", "source": {"kind": "component", "componentId": "name"}}],
    }
    if storage == "base64":
        layout["template"]["data"] = b64(data if data is not None else fake_pdf("template"))
    else:
        layout["template"]["ref"] = {"key": "templates/t.pdf"}
    return layout


def generated_layout(layout_id: str = "g1") -> dict[str, Any]:
    """Return a generated layout stub (the kernel reads the real one; the host only reads `id` and `kind`)."""
    return {"id": layout_id, "kind": "generated", "root": {"id": "doc", "type": "pdf-document", "children": {}}}


def pdf_definition(*layouts: dict[str, Any], default: str | None = None) -> dict[str, Any]:
    """Return the `contact` form with a `pdf` block holding `layouts`."""
    form = definition()
    if layouts:
        form["pdf"] = {"layouts": [dict(item) for item in layouts]}
        if default is not None:
            form["pdf"]["defaultLayoutId"] = default
    return form


# -- the scripted program ----------------------------------------------------------------------------------------------


@dataclass
class Call:
    """One request the scripted program received."""

    op: str
    request: dict[str, Any]
    budget: RunBudget


class ScriptedPdfRuntime:
    """A `GuestRuntime` whose PDF program is a table of per-op answers; every run lands on `calls` and the trail.

    `answers` maps an op to a function from the request to the answer's members (`ok` and `op` are added); `fail(op,
    code, message)` makes an op answer ``{ok: false, error: {code, message}}``; a run of an op nobody scripted answers
    the default below. `abi` and `features` are what `capabilities` says. The runtime is thread-safe (a lock guards
    the log).
    """

    def __init__(self, trail: list[str] | None = None, *, abi: str = ABI, features: Sequence[str] = FEATURES) -> None:
        self.trail = trail if trail is not None else []
        self.abi = abi
        self.features = tuple(features)
        self.calls: list[Call] = []
        self.answers: dict[str, Callable[[dict[str, Any]], dict[str, Any]]] = {}
        self.ends: dict[str, RunEnd] = {}
        self.raws: dict[str, bytes] = {}
        self.signing_serial = 0
        self.closed = False
        self._lock = threading.Lock()

    # -- scripting ---------------------------------------------------------------------------------------------------
    def on(self, op: str, answer: Callable[[dict[str, Any]], dict[str, Any]]) -> None:
        """Answer `op` with `answer(request)` (its members; ``ok`` and ``op`` are filled in unless given)."""
        self.answers[op] = answer

    def fail(self, op: str, code: str, message: str = "scripted failure") -> None:
        """Make `op` answer ``{ok: false, error: {code, message}}``."""
        self.answers[op] = lambda _request: {"ok": False, "error": {"code": code, "message": message}}

    def raw(self, op: str, stdout: bytes | dict[str, Any]) -> None:
        """Make `op` print exactly `stdout` (a dict is written as JSON with no `ok` or `op` added)."""
        self.raws[op] = stdout if isinstance(stdout, bytes) else json.dumps(stdout).encode("utf-8")

    def end(self, op: str, end: RunEnd) -> None:
        """Make a run of `op` end `end` (budget, memory, trap...) with no answer."""
        self.ends[op] = end

    def requests(self, op: str) -> list[dict[str, Any]]:
        """Return the requests of `op` in the order they came."""
        return [call.request for call in self.calls if call.op == op]

    def ops(self) -> list[str]:
        """Return the ops run, in order."""
        return [call.op for call in self.calls]

    # -- the GuestRuntime protocol ---------------------------------------------------------------------------------
    def run(self, job: GuestRun, /) -> RunResult:
        _, _, _, stdin, budget = program_parts(job)
        request = cast("dict[str, Any]", json.loads(stdin))
        op = str(request.get("op"))
        with self._lock:
            self.calls.append(Call(op, request, budget))
            self.trail.append(f"pdf.{op}")
        if op in self.ends:
            return RunResult(self.ends[op], b"", b"scripted end", None)
        if op in self.raws:
            return RunResult(RunEnd.CLEAN, self.raws[op], b"", 0)
        script = self.answers.get(op)
        answer = script(request) if script is not None else self._default(op, request)
        answer.setdefault("ok", True)
        if answer["ok"]:
            answer.setdefault("op", op)
        return RunResult(RunEnd.CLEAN, json.dumps(answer).encode("utf-8"), b"", 0)

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="scripted", release="1.0", mode="test")

    def close(self) -> None:
        self.closed = True

    # -- the default answers -----------------------------------------------------------------------------------------
    def answer_of(self, op: str, request: dict[str, Any]) -> dict[str, Any]:
        """The scripted program's own answer to `request` (a test changes it, then answers with it)."""
        return self._default(op, request)

    def _default(self, op: str, request: dict[str, Any]) -> dict[str, Any]:  # noqa: PLR0911 - one per op
        if op == "capabilities":
            return {"abi": self.abi, "features": list(self.features), "kernelVersion": "0.1.0"}
        if op in {"document", "render", "fill"}:
            produced: dict[str, Any] = {
                "bytes": b64(fake_pdf(op)),
                "pageCount": 1,
                "pages": [],
                "warnings": [],
                "layoutId": "default",
                "layoutKind": "derived",
            }
            if isinstance(request.get("signature"), dict):
                produced["signing"] = self._handoff(request["signature"], fake_pdf(op))
            return produced
        if op == "sign":
            prepared = fake_pdf("prepared")
            return {"bytes": b64(prepared), "signing": self._handoff(request["signature"], prepared), "warnings": []}
        if op == "complete":
            signing = request["signing"]
            return {
                "bytes": b64(fake_pdf("signed")),
                "field": "Signature1",
                "cms": b64(b"cms"),
                "timestamped": "timestamp" in signing,
            }
        if op == "verify":
            return {"signatures": [], "attachments": [], "warnings": [], "documentId": None}
        if op == "inspect":
            return {"info": {"pageCount": 1, "pages": [], "fields": [], "hasXfa": False, "encrypted": False}}
        if op == "timestampRequest":
            return {"request": b64(b"timestamp-request")}
        return {"ok": False, "error": {"code": "invalid_request", "message": f"scripted: no answer for {op}"}}

    def _handoff(self, signature: Mapping[str, Any], prepared: bytes) -> dict[str, Any]:
        """The handoff over `prepared`, as the program makes it; each one's attributes differ (a signing time)."""
        with self._lock:
            self.signing_serial += 1
            serial = self.signing_serial
        return signing_handoff(prepared, algorithm=algorithm_of(signature), serial=serial)


def algorithm_of(signature: Mapping[str, Any]) -> str:
    """Return the algorithm the real program picks for a request's `signature`: decided by the leaf's key."""
    from cryptography import x509  # noqa: PLC0415 - tests only
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415

    certificates = signature.get("certificates") or []
    try:
        key = x509.load_der_x509_certificate(base64.b64decode(certificates[0])).public_key()
    except (IndexError, ValueError):
        return "RSASSA-PKCS1-v1_5-SHA256"
    if isinstance(key, ec.EllipticCurvePublicKey):
        return "ECDSA-P384-SHA256" if key.curve.name == "secp384r1" else "ECDSA-P256-SHA256"
    return "RSASSA-PKCS1-v1_5-SHA256"


# -- signer and timestamper doubles ------------------------------------------------------------------------------------


class IdentitySigner:
    """A `PdfSigner` over a test-PKI identity; it counts its uses and puts them on the trail."""

    def __init__(self, identity: TsaIdentity, trail: list[str] | None = None, *, chain: bool = True) -> None:
        self.identity = identity
        self.trail = trail if trail is not None else []
        self._chain = identity.chain_der if chain else (identity.leaf_der,)
        self.signs: list[bytes] = []
        self._lock = threading.Lock()

    def certificates(self) -> tuple[bytes, ...]:
        return self._chain

    @property
    def algorithm(self) -> str:
        key_algorithm = self.identity.algorithm
        if key_algorithm == "rsa-sha256":
            return "RSASSA-PKCS1-v1_5-SHA256"
        return "ECDSA-P384-SHA256" if self.identity.key.key_size == 384 else "ECDSA-P256-SHA256"

    def sign(self, to_be_signed: bytes) -> bytes:
        with self._lock:
            self.signs.append(to_be_signed)
            self.trail.append("signer.sign")
        return self.identity.sign(to_be_signed)


class RecordingTimestamper:
    """A `Timestamper` over the in-process authority (a real token): records each request, can be told to fail."""

    def __init__(
        self, identity: TsaIdentity, trail: list[str] | None = None, *, now: Callable[[], datetime] | None = None
    ) -> None:
        self.identity = identity
        self.trail = trail if trail is not None else []
        self.authority = make_authority(identity) if now is None else make_authority(identity, now=now)
        self.requests: list[tuple[bytes, str, TimestampChannel, str | None, bool]] = []
        self.error: Exception | None = None
        self.grants: list[TimestampGrant] = []

    def request(
        self,
        imprint: bytes,
        algorithm: str,
        *,
        policy: str | None = None,
        cert_req: bool = True,
        channel: TimestampChannel = "seal",
    ) -> TimestampGrant:
        self.trail.append("timestamper.request")
        self.requests.append((imprint, algorithm, channel, policy, cert_req))
        if self.error is not None:
            raise self.error
        grant = self.authority.request(imprint, algorithm, policy=policy, cert_req=cert_req, channel=channel)
        self.grants.append(grant)
        return grant


class AuthorityTransport:
    """A `TsaTransport` that answers every POST with a real `TimeStampResp` from the in-process authority.

    The seal's client of `datum.pdf.signing.tsa.url` is the standard library's; handing it this transport keeps the test
    off the network and lets it see the URL, the headers and the query bytes the client sent.
    """

    follow_redirects = False

    def __init__(self, identity: TsaIdentity) -> None:
        self.authority = make_authority(identity)
        self.calls: list[tuple[str, dict[str, str], bytes]] = []

    def post(
        self, url: str, body: bytes, *, content_type: str, accept: str, headers: Mapping[str, str], timeout: float
    ) -> TransportReply:
        self.calls.append((url, {"content-type": content_type, "accept": accept, **headers}, body))
        answer = self.authority.answer(body)
        return TransportReply(200, "application/timestamp-reply", bytes(answer.response))


# -- verify answers the scripted program can give ----------------------------------------------------------------------


def _spki(identity: TsaIdentity) -> bytes:
    from cryptography.hazmat.primitives import serialization  # noqa: PLC0415 - tests only

    return identity.key.public_key().public_bytes(
        serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
    )


def _signer_record(identity: TsaIdentity, certificate: bytes | None = None) -> dict[str, Any]:
    leaf = identity.leaf
    return {
        "certificate": b64(certificate if certificate is not None else identity.leaf_der),
        "publicKey": b64(_spki(identity)),
        "subject": leaf.subject.rfc4514_string(),
        "issuer": leaf.issuer.rfc4514_string(),
        "serialNumber": format(leaf.serial_number, "x"),
        "notBefore": leaf.not_valid_before_utc.isoformat(),
        "notAfter": leaf.not_valid_after_utc.isoformat(),
    }


def signature_report(
    identity: TsaIdentity,
    *,
    to_be_verified: bytes = b"signed-attributes",
    forge: bool = False,
    signature: bytes | None = None,
    covers_document: bool = True,
    digest_matches: bool = True,
    certificate_matches: bool = True,
    field_name: str = "Signature1",
    signing_time: str | None = "2026-10-20T12:00:00Z",
    certification: str | None = None,
    timestamp: Mapping[str, Any] | None = None,
    later_revisions: Mapping[str, Any] | None = None,
    byte_range: Sequence[int] = (0, 10, 20, 30),
    signer: Mapping[str, Any] | bool | None = True,
    carried: Sequence[bytes] | None = None,
    signer_source: str | None = "signature",
    signed_document_id: str | None = "ab" * 16,
    algorithm_oid: str | None = None,
) -> dict[str, Any]:
    """Return a kernel signature report whose value really is (or, with `forge`, really is not) valid for the signer.

    `signer=False` is a report with no signer (`signer: null`); a mapping replaces the signer record. `carried` are the
    DER certificates the signature carries (default the identity's leaf).
    """
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415 - tests only

    is_ec = isinstance(identity.key, ec.EllipticCurvePrivateKey)
    value = signature if signature is not None else identity.sign(to_be_verified)
    if forge:
        # a structurally valid value (right shape, right length) that is not a signature over `to_be_verified`
        value = identity.sign(to_be_verified + b"-another-message")
    certificates = list(carried) if carried is not None else [identity.leaf_der]
    report: dict[str, Any] = {
        "field": field_name,
        "subFilter": "ETSI.CAdES.detached",
        "byteRange": list(byte_range),
        "coversDocument": covers_document,
        "digestMatches": digest_matches,
        "certificateMatches": certificate_matches,
        "signer": None
        if signer is False
        else (dict(signer) if isinstance(signer, Mapping) else _signer_record(identity)),
        "signerSource": signer_source if signer is not False else None,
        "certificates": [b64(item) for item in certificates],
        "signatureAlgorithm": algorithm_oid or ("1.2.840.10045.4.3.2" if is_ec else "1.2.840.113549.1.1.11"),
        "toBeVerified": b64(to_be_verified),
        "signature": b64(value),
        "signingTime": signing_time,
        "certification": None if certification is None else {"permissions": certification},
        "details": "signed",
        "changedAfter": {},
        "signedDocumentId": signed_document_id,
    }
    if timestamp is not None:
        report["timestamp"] = dict(timestamp)
    if later_revisions is not None:
        report["laterRevisions"] = dict(later_revisions)
    return report


def later_revisions(
    *, permitted: object, relied_on: Sequence[Mapping[str, Any]] = (), revisions: int = 1
) -> dict[str, Any]:
    """Return a `laterRevisions` report."""
    return {
        "revisions": revisions,
        "changes": [],
        "permitted": permitted,
        "reliedOnSignatures": [dict(x) for x in relied_on],
    }


def timestamp_report(
    grant: TimestampGrant,
    tsa: TsaIdentity,
    *,
    covers_signature: bool = True,
    message_digest_matches: bool = True,
    certificate_matches: bool = True,
    content_type_matches: bool = True,
    include_certificates: bool = True,
) -> dict[str, Any]:
    """Return the `timestamp` member of a signature report for a real `grant` (the facts are the kernel's, scripted)."""
    return {
        "time": grant.gen_time.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "tsa": tsa.leaf.subject.rfc4514_string(),
        "coversSignature": covers_signature,
        "token": b64(grant.token),
        "messageDigestMatches": message_digest_matches,
        "contentTypeMatches": content_type_matches,
        "certificateMatches": certificate_matches,
        "serial": format(grant.serial, "x"),
        "signer": _signer_record(tsa),
        "signerSource": "token",
        "certificates": [b64(tsa.leaf_der), b64(tsa.root_der)] if include_certificates else [],
    }


def verify_reply(
    *reports: Mapping[str, Any], document_id: str | None = "cd" * 16, warnings: Sequence[Any] = ()
) -> dict[str, Any]:
    """Return a `verify` answer's members for `reports`."""
    return {
        "signatures": [dict(report) for report in reports],
        "attachments": [],
        "warnings": list(warnings),
        "documentId": document_id,
    }


# -- files the tests write ---------------------------------------------------------------------------------------------


PDF_P12_PASSWORD = "pdf-p12-password-xyz"
"""The password `pdf_signing` writes its PKCS#12 store under unless told otherwise."""


def pdf_signing(
    directory: Path,
    identity: TsaIdentity,
    *,
    password: str | None = PDF_P12_PASSWORD,
    key_name: str | None = "datum-pdf",
    ca_names: Sequence[str | None] = (None,),
    friendly_name: str | None = None,
    file_name: str = "seal.p12",
    **more: Any,
) -> Signing:
    """Write `identity` as PKCS#12 under `directory` and return the `datum.pdf.signing` settings that name it."""
    path = directory / file_name
    path.write_bytes(identity.pkcs12(password=password, key_name=key_name, ca_names=ca_names))
    return Signing.model_validate(
        {
            "type": "PKCS12",
            "pkcs12_file": str(path),
            "pkcs12_password": password,
            "friendly_name": friendly_name,
            **more,
        }
    )


def unreadable_curve_chain(identity: TsaIdentity) -> bytes:
    """Return `identity`'s leaf as PEM with its curve OID swapped for one cryptography cannot read (built per test)."""
    der = identity.leaf_der
    assert der.count(bytes.fromhex("06082a8648ce3d030107")) == 1
    swapped = der.replace(bytes.fromhex("06082a8648ce3d030107"), bytes.fromhex("06082a8648ce3d030102"), 1)
    body = base64.b64encode(swapped).decode()
    lines = [body[at : at + 64] for at in range(0, len(body), 64)]
    return ("-----BEGIN CERTIFICATE-----\n" + "\n".join(lines) + "\n-----END CERTIFICATE-----\n").encode()


def rsa_pss_files(directory: Path) -> tuple[Path, Path]:
    """Make an RSA-PSS key and its self-signed certificate with openssl; return (key file, certificate file)."""
    key_file, cert_file = directory / "pss-key.pem", directory / "pss-cert.pem"
    made = run_openssl("genpkey", "-algorithm", "RSA-PSS", "-pkeyopt", "rsa_keygen_bits:2048", "-out", str(key_file))
    assert made.returncode == 0
    made = run_openssl(
        "req", "-x509", "-new", "-key", str(key_file), "-subj", "/CN=pss", "-days", "2", "-out", str(cert_file)
    )
    assert made.returncode == 0
    return key_file, cert_file


def pem_signing(
    directory: Path, identity: TsaIdentity, *, key_password: str | None = None, with_root: bool = True, **more: Any
) -> Signing:
    """Write `identity` as a PEM key and chain under `directory`; return the `datum.pdf.signing` settings."""
    key_file, cert_file = identity.write_pem_pair(directory, key_password=key_password, with_root=with_root)
    return Signing.model_validate(
        {"type": "PEM", "key_file": str(key_file), "cert_file": str(cert_file), "key_password": key_password, **more}
    )


def anchors_file(directory: Path, *certificates: bytes, name: str = "anchors.pem") -> str:
    """Write DER `certificates` as one PEM file and return its path (what `trust_anchors` lists)."""
    path = directory / name
    path.write_bytes(b"".join(bytes_to_pem(item) for item in certificates))
    return str(path)


# -- the Datum rig -----------------------------------------------------------------------------------------------------


@dataclass
class PdfRig:
    """A started `Datum` with the PDF capability over the scripted program, and what its seams recorded."""

    datum: Datum
    trail: list[str]
    runtime: ScriptedPdfRuntime
    sandbox: RecordingSandbox
    throttle: RecordingThrottle
    repository: Repository
    handler: Handler
    signer: IdentitySigner | None
    timestamper: RecordingTimestamper | None
    events: list[DatumEvent] = field(default_factory=lambda: cast("list[DatumEvent]", []))

    @property
    def service(self) -> Any:
        return self.datum.pdf_service

    def render(
        self, document: Mapping[str, Any] | None = None, context: SubmissionContext | None = None, **more: Any
    ) -> Any:
        return self.service.render(FormRef.from_document(), document or envelope(), context or bus(), **more)

    def fill(
        self, layout_id: str, document: Mapping[str, Any] | None = None, context: SubmissionContext | None = None
    ) -> Any:
        return self.service.fill(FormRef.from_document(), document or envelope(), context or bus(), layout_id=layout_id)

    def sign(
        self, document: Mapping[str, Any] | None = None, context: SubmissionContext | None = None, **more: Any
    ) -> Any:
        return self.service.sign(FormRef.from_document(), document or envelope(), context or bus(), **more)

    def verify(self, data: bytes, context: SubmissionContext | None = None) -> Any:
        return self.service.verify(data, context or bus())

    def render_submission(self, accepted: AcceptedSubmission | None = None, **more: Any) -> Any:
        return self.service.render_submission(accepted or accepted_submission(), **more)

    def kinds(self) -> list[str]:
        return [type(event).__name__ for event in self.events]

    def position(self, label: str) -> int:
        """Return where `label` first occurs on the trail (an `AssertionError` when it never does)."""
        for index, entry in enumerate(self.trail):
            if entry == label:
                return index
        raise AssertionError(f"{label!r} is not on the trail {self.trail}")


def pdf_config(config: Mapping[str, Any] | DatumConfig | None = None, **pdf: Any) -> DatumConfig:
    """A configuration with the PDF capability on and the seal on, without a timestamp; `pdf` replaces members."""
    if isinstance(config, DatumConfig):
        return config
    seal = {"enabled": True, "timestamp": False}
    seal.update(pdf.pop("seal", {}))
    sections: dict[str, Any] = {"pdf": {"enabled": True, "seal": seal, **pdf}}
    for name, value in (config or {}).items():
        if name in sections and isinstance(value, Mapping):
            sections[name] = {**sections[name], **value}
        else:
            sections[name] = value
    return DatumConfig.model_validate(sections)


@contextlib.contextmanager
def started_pdf(
    config: Mapping[str, Any] | DatumConfig | None = None,
    *,
    signer: TsaIdentity | None = None,
    tsa: TsaIdentity | None = None,
    tsa_now: Callable[[], datetime] | None = None,
    abi: str = ABI,
    awaiter: Awaiter | None = None,
    pdf: Mapping[str, Any] | None = None,
    form: dict[str, Any] | None = None,
    trail: list[str] | None = None,
    **seams: Any,
) -> Generator[PdfRig]:
    """Start a `Datum` over the scripted program, a recording sandbox and the doubles above, and yield the rig.

    `trail` lets a hook built before the rig write on the rig's trail. `signer` is the identity of the server's seal
    key (an `IdentitySigner`, via the `pdf_signer` keyword); `tsa` makes a
    `RecordingTimestamper` over a timestamp identity (the `timestamper` keyword). A `seams` keyword replaces the
    recording one. The trail is cleared after the start: the start's own proofs are not the request's path.
    """
    trail = trail if trail is not None else []
    events: list[DatumEvent] = []
    runtime = ScriptedPdfRuntime(trail, abi=abi)
    sandbox = RecordingSandbox(trail)
    throttle = RecordingThrottle(trail)
    handler = Handler(trail)
    repository = seams.pop("form_repository", None) or Repository(trail, form if form is not None else definition())
    seal_signer = IdentitySigner(signer, trail) if signer is not None else None
    timestamper = RecordingTimestamper(tsa, trail, now=tsa_now) if tsa is not None else None

    def record(event: DatumEvent) -> None:
        trail.append(f"event:{type(event).__name__}")
        events.append(event)

    options: dict[str, Any] = {
        "handler": handler,
        "throttle": throttle,
        "form_repository": repository,
        "listeners": [*seams.pop("listeners", ()), (DatumEvent, record)],
        "now": lambda: INSTANT,
    }
    if seal_signer is not None:
        options["pdf_signer"] = seal_signer
    if timestamper is not None:
        options["timestamper"] = timestamper
    options.update(seams)
    settings = pdf_config(config, **dict(pdf or {}))
    datum = Datum(config=settings, runtime=cast("GuestRuntime", runtime), sandbox=cast("Sandbox", sandbox), **options)
    datum.start(awaiter=awaiter)
    trail.clear()
    events.clear()
    runtime.calls.clear()
    try:
        yield PdfRig(datum, trail, runtime, sandbox, throttle, repository, handler, seal_signer, timestamper, events)
    finally:
        datum.stop()


def plain_pdf_datum(config: Mapping[str, Any] | DatumConfig | None = None, **seams: Any) -> Datum:
    """A not-started `Datum` over the scripted program, for the tests that read its start or its settings."""
    trail: list[str] = []
    seams.setdefault("runtime", cast("GuestRuntime", ScriptedPdfRuntime(trail)))
    seams.setdefault("sandbox", cast("Sandbox", RecordingSandbox(trail)))
    seams.setdefault("form_repository", Repository(trail, definition()))
    seams.setdefault("now", lambda: INSTANT)
    return Datum(config=pdf_config(config), **seams)


def accepted_submission(**more: Any) -> AcceptedSubmission:
    """Return what a handler is handed for the `contact` form's one delivery (the input of `render_submission`)."""
    fields: dict[str, Any] = {
        "form_key": FORM,
        "digest": "ab" * 32,
        "values": {"name": NAME},
        "warnings": (),
        "channel": "http",
        "remote_address": None,
        "user_agent": None,
        "version": "1",
        "locale": "en",
        "principal": None,
    }
    fields.update(more)
    return AcceptedSubmission(**fields)


def timed(moment: datetime) -> str:
    """Return `moment` as the ISO text a kernel report carries."""
    return moment.strftime("%Y-%m-%dT%H:%M:%SZ")


__all__ += [
    "Call",
    "accepted_submission",
    "generated_layout",
    "later_revisions",
    "pdf_config",
    "plain_pdf_datum",
    "timed",
]
_ = POLICY  # re-exported for the test modules' convenience


# -- the secrecy probes ------------------------------------------------------------------------------------------------

DEPTH = 4
LEAVES = (str, int, float, bool, type(None), bytes, bytearray)


def children_of(obj: object) -> list[object]:
    """The values reachable from `obj` one step on: container items, public attributes, instance slots."""
    if isinstance(obj, Mapping):
        return [*obj.keys(), *obj.values()]
    if isinstance(obj, list | tuple | set | frozenset):
        return list(cast("Iterable[object]", obj))
    names = {name for name in dir(obj) if not name.startswith("__")}
    for klass in type(obj).__mro__:
        slots = getattr(klass, "__slots__", ())
        names.update([slots] if isinstance(slots, str) else slots)
    names.update(getattr(obj, "__dict__", {}))
    values: list[object] = []
    for name in sorted(names):
        try:
            value = getattr(obj, name)
        except Exception:  # noqa: S112 - a property that raises exposes nothing
            continue
        if not callable(value):
            values.append(value)
    return values


def exposed(obj: object, *, depth: int = DEPTH, seen: set[int] | None = None) -> Iterator[str]:
    """Yield the text of `obj` and of everything reachable through its public attributes, slots and containers."""
    seen = set() if seen is None else seen
    if id(obj) in seen:
        return
    seen.add(id(obj))
    if isinstance(obj, bytes | bytearray):
        yield repr(bytes(obj))
        yield bytes(obj).hex()
        yield b64(bytes(obj))
    else:
        yield repr(obj)
        yield str(obj)
    opaque = type(obj).__module__.startswith("cryptography")  # the library's key object: only its repr can leak
    if depth == 0 or opaque or isinstance(obj, LEAVES):
        return
    for child in children_of(obj):
        yield from exposed(child, depth=depth - 1, seen=seen)


def assert_clean(obj: object, forbidden: Sequence[str | bytes], what: str = "object") -> None:
    """Assert nothing in `forbidden` shows in `obj`'s text or in anything it exposes."""
    found = leaks("\n".join(exposed(obj)), forbidden)
    assert not found, f"{what} exposes {found}"


def log_text(caplog: Any) -> str:
    """Every record's message, arguments, extras and formatted traceback."""
    parts: list[str] = [caplog.text]
    for record in caplog.records:
        parts.append(record.getMessage())
        parts.append(str(record.args))
        parts.append(str({k: v for k, v in vars(record).items() if k.startswith("datum_")}))
        if record.exc_info:
            parts.append("".join(traceback.format_exception(*record.exc_info)))
        if record.exc_text:
            parts.append(record.exc_text)
    return "\n".join(parts)


def chain_text(error: BaseException) -> str:
    """The message, hint, arguments, repr, traceback text and every chained exception."""
    parts: list[str] = []
    current: BaseException | None = error
    for _ in range(10):
        if current is None:
            break
        parts += [str(current), repr(current), getattr(current, "hint", ""), *map(str, current.args)]
        parts.append("".join(traceback.format_exception(current)))
        current = current.__cause__ or current.__context__
    return "\n".join(parts)


def frame_locals(error: BaseException) -> list[object]:
    """Every local variable of every frame of `error`'s traceback and of the exceptions it chains."""
    found: list[object] = []
    current: BaseException | None = error
    for _ in range(10):
        if current is None:
            break
        trace = current.__traceback__
        while trace is not None:
            found.extend(trace.tb_frame.f_locals.values())
            trace = trace.tb_next
        current = current.__cause__ or current.__context__
    return found


__all__ += ["assert_clean", "chain_text", "children_of", "exposed", "frame_locals", "log_text"]


# -- reading what the seal asked of the program ------------------------------------------------------------------------

SEALED_OPS = ("document", "fill", "sign")


def signature_request(rig: PdfRig) -> dict[str, Any]:
    """Return the `signature` member of the first kernel request that carries one (settings, certificates)."""
    for call in rig.runtime.calls:
        if call.op in SEALED_OPS and isinstance(call.request.get("signature"), dict):
            return cast("dict[str, Any]", call.request["signature"])
    raise AssertionError(f"no kernel request carries a signature: {rig.runtime.ops()}")


def completion(rig: PdfRig) -> dict[str, Any]:
    """Return the `signing` member of the `complete` request (the value, the token, the settings)."""
    (request,) = rig.runtime.requests("complete")
    return cast("dict[str, Any]", request["signing"])


def common_name(der: bytes) -> str:
    """Return the common name of a DER certificate."""
    from cryptography import x509  # noqa: PLC0415 - tests only
    from cryptography.x509.oid import NameOID  # noqa: PLC0415

    return str(x509.load_der_x509_certificate(der).subject.get_attributes_for_oid(NameOID.COMMON_NAME)[0].value)


__all__ += ["SEALED_OPS", "common_name", "completion", "signature_request"]
