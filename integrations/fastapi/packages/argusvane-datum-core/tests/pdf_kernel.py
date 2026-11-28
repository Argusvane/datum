"""Drive the real PDF program from a test: capabilities, document, fill, sign, complete, verify, inspect.

This is the sibling of `tsa_kernel.py` for the PDF program. It runs the packaged program
(`argusvane-datum-programs`) on the real wasmtime engine through `GuestRuntime.run` and the PDF run script, one
request per run, and hands the program's JSON answer back untouched. The program is the oracle: nothing here reads
a PDF, a CMS or a token itself except to hand bytes to the program, to a signer the test owns (an identity of the
test PKI) or to `openssl`.

A test using it carries the `runtime` marker; `pdf_session()` skips, with a reason, when the engine or the program is
absent. The runtime is expensive to start, so a module builds one `PdfKernelSession` and reuses it (`module_session`).
"""

import base64
import contextlib
import hashlib
import json
import shutil
import tempfile
from collections.abc import Callable, Generator, Mapping, Sequence
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast

import pytest

from datum_core.testing.tsa_pki import TsaIdentity
from datum_sandbox.protocol import PDF_ABI_MIN, PDF_RUN_SCRIPT, ProgramLimits, program_run
from datum_sandbox.testing.fixtures import FixturesNotFoundError, endpoint_form, font_bytes, pdf_program
from datum_sandbox.wasi import (
    EngineLimits,
    EngineSettings,
    GuestRuntime,
    GuestRuntimes,
    RunBudget,
    RunEnd,
    RunResult,
)

ENGINE = "wasmtime"
ENV = {"createdAt": "2026-10-20T12:00:00Z", "documentId": "pdf-gate"}
"""The environment every request carries: the program has no clock and no randomness of its own."""
ANSWERS = {"name": "Ada Lovelace", "code": "AB1234", "address": {"city": "London"}}
"""Values the endpoint fixture form accepts (only `name` is required of the first page)."""


def _hash(name: str) -> Any:
    from cryptography.hazmat.primitives import hashes  # noqa: PLC0415 - tests only

    table: dict[str, Any] = {"sha256": hashes.SHA256, "sha384": hashes.SHA384, "sha512": hashes.SHA512}
    return table[name]()


def rsa_sign(private_key: object, data: bytes, hash_name: str = "sha256") -> bytes:
    """Sign `data` with an RSA key, PKCS#1 v1.5 over `hash_name` (the keys of the test PKI are typed as a union)."""
    from cryptography.hazmat.primitives.asymmetric import padding  # noqa: PLC0415 - tests only

    return cast("bytes", cast("Any", private_key).sign(data, padding.PKCS1v15(), _hash(hash_name)))


def ec_sign(private_key: object, data: bytes, hash_name: str = "sha256") -> bytes:
    """Sign `data` with an EC key, ECDSA (DER) over `hash_name`."""
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415 - tests only

    return cast("bytes", cast("Any", private_key).sign(data, ec.ECDSA(_hash(hash_name))))


def rsa_verify(public_key: object, signature: bytes, data: bytes, hash_name: str = "sha256") -> None:
    """Verify an RSA PKCS#1 v1.5 signature; raise `InvalidSignature` when it does not hold."""
    from cryptography.hazmat.primitives.asymmetric import padding  # noqa: PLC0415 - tests only

    cast("Any", public_key).verify(signature, data, padding.PKCS1v15(), _hash(hash_name))


def ec_verify(public_key: object, signature: bytes, data: bytes, hash_name: str = "sha256") -> None:
    """Verify an ECDSA (DER) signature; raise `InvalidSignature` when it does not hold."""
    from cryptography.hazmat.primitives.asymmetric import ec  # noqa: PLC0415 - tests only

    cast("Any", public_key).verify(signature, data, ec.ECDSA(_hash(hash_name)))


def b64(data: bytes) -> str:
    """Return the base64 text of `data`."""
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    """Return the bytes of a base64 text."""
    return base64.b64decode(text)


def sha256_hex(data: bytes) -> str:
    """Return the lower-case hex SHA-256 of `data`."""
    return hashlib.sha256(data).hexdigest()


def two_fonts() -> list[dict[str, Any]]:
    """Return DejaVu Sans regular and bold as the request carries fonts (a small pack keeps the runs short)."""
    return [
        {
            "id": "dejavu-sans",
            "family": "sans-serif",
            "weight": 400,
            "style": "normal",
            "data": b64(font_bytes("DejaVuSans.ttf")),
        },
        {
            "id": "dejavu-sans-bold",
            "family": "sans-serif",
            "weight": 700,
            "style": "normal",
            "data": b64(font_bytes("DejaVuSans-Bold.ttf")),
        },
    ]


def form_root() -> dict[str, Any]:
    """Return the endpoint fixture form's root component (what the `document` op's `form` is)."""
    return cast("dict[str, Any]", endpoint_form()["root"])


def fillable_template() -> bytes:
    """Return a one-page PDF with one text field, `Name`, written byte by byte here (no PDF library): a template."""
    objects = [
        (
            b"<< /Type /Catalog /Pages 2 0 R /AcroForm << /Fields [5 0 R] /DA (/Helv 0 Tf 0 g) "
            b"/DR << /Font << /Helv 4 0 R >> >> >> >>"
        ),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        (
            b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 6 0 R "
            b"/Resources << /Font << /Helv 4 0 R >> >> /Annots [5 0 R] >>"
        ),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
        (
            b"<< /Type /Annot /Subtype /Widget /FT /Tx /T (Name) /Rect [72 700 300 720] /F 4 /P 3 0 R "
            b"/DA (/Helv 12 Tf 0 g) >>"
        ),
    ]
    content = b"BT /Helv 14 Tf 72 740 Td (Template) Tj ET"
    objects.append(b"<< /Length %d >>\nstream\n" % len(content) + content + b"\nendstream")
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def padded_pdf(target: int) -> bytes:
    """Return a one-page PDF of about `target` bytes: its content stream is that many bytes of comment lines."""
    filler = (b"% " + b"x" * 78 + b"\n") * (target // 80)
    objects = [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << >> >>",
        b"<< /Length %d >>\nstream\n" % len(filler) + filler + b"endstream",
    ]
    out = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets: list[int] = []
    for number, body in enumerate(objects, 1):
        offsets.append(len(out))
        out += b"%d 0 obj\n" % number + body + b"\nendobj\n"
    xref = len(out)
    out += b"xref\n0 %d\n0000000000 65535 f \n" % (len(objects) + 1)
    for offset in offsets:
        out += b"%010d 00000 n \n" % offset
    out += b"trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n" % (len(objects) + 1, xref)
    return bytes(out)


def long_document(pages: int) -> dict[str, Any]:
    """Return a `PdfDocument` of exactly `pages` pages: one short paragraph on each, a page break between them."""
    from datum_sandbox.testing.fixtures import pdf_document  # noqa: PLC0415 - tests only

    document = pdf_document("datum-pdf")
    blocks: list[dict[str, Any]] = []
    for number in range(pages):
        text = f"Page {number}. " + "Lorem ipsum dolor sit amet. " * 20
        blocks.append({"id": f"p{number}", "kind": "paragraph", "runs": [{"text": text}]})
        if number < pages - 1:
            blocks.append({"id": f"b{number}", "kind": "pageBreak"})
    return {**document, "blocks": blocks, "footer": [], "anchored": []}


def document_request(**more: Any) -> dict[str, Any]:
    """Return a `document` request over the fixture form with `ANSWERS`, two fonts and the fixed env."""
    request: dict[str, Any] = {
        "abi": PDF_ABI_MIN,
        "op": "document",
        "form": form_root(),
        "values": dict(ANSWERS),
        "locale": "en",
        "fonts": two_fonts(),
        "env": dict(ENV),
    }
    request.update(more)
    return request


@dataclass(frozen=True)
class Signed:
    """A PDF a test signed with an identity of the test PKI through the program's `sign` and `complete`."""

    data: bytes
    """The signed file."""
    value: bytes
    """The signature value the identity produced over `toBeSigned`."""
    prepared: Mapping[str, Any]
    """The `sign` answer (the file with the placeholder and the handoff)."""
    completed: Mapping[str, Any]
    """The `complete` answer."""
    token: bytes | None = None
    """The `TimeStampResp` that was embedded, when one was."""
    chain: tuple[bytes, ...] = field(default=())
    """The DER certificates the signature carried, the signer's first."""


class PdfKernelSession:
    """A started runtime and the packaged PDF program; each method sends one request and returns the answer."""

    def __init__(self, runtime: GuestRuntime, *, time_limit: float = 120.0) -> None:
        self.runtime = runtime
        self.budget = ProgramLimits(pdf_time_limit=time_limit).pdf_budget()
        self.program = pdf_program()
        self.runs = 0
        self._unsigned: bytes | None = None

    # -- the raw call ------------------------------------------------------------------------------------------------
    def run(self, request: Mapping[str, Any], budget: RunBudget | None = None) -> RunResult:
        """Send one request and return the engine's whole result (a test of the limits reads the end)."""
        body = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        self.runs += 1
        return self.runtime.run(
            program_run(self.program.data, PDF_RUN_SCRIPT.encode("utf-8"), body, budget or self.budget)
        )

    def call(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Send one request and return its JSON answer; the test reads `ok` itself."""
        result = self.run(request)
        assert result.end is RunEnd.CLEAN, f"{result.end}: {result.stderr.decode('utf-8', 'replace')}"
        return cast("dict[str, Any]", json.loads(result.stdout))

    def ok(self, request: Mapping[str, Any]) -> dict[str, Any]:
        """Send one request and assert the program accepted it."""
        answer = self.call(request)
        assert answer.get("ok") is True, answer
        return answer

    # -- the eight operations ----------------------------------------------------------------------------------------
    def capabilities(self) -> dict[str, Any]:
        """Return the program's `capabilities` answer: ``{ok, op, abi, kernelVersion}``."""
        return self.ok({"abi": PDF_ABI_MIN, "op": "capabilities"})

    def document(self, **more: Any) -> dict[str, Any]:
        """Print the fixture form with the answers (see `document_request`); the program's answer."""
        return self.call(document_request(**more))

    def fill(self, **members: Any) -> dict[str, Any]:
        """Send a `fill` request (`template`, `values`, `fonts`, `env`, `options`); the program's answer."""
        request: dict[str, Any] = {
            "abi": PDF_ABI_MIN,
            "op": "fill",
            "values": {},
            "fonts": two_fonts(),
            "env": dict(ENV),
            "options": {"flatten": False, "readOnly": False, "appearances": "regenerate"},
        }
        request.update(members)
        request["op"] = "fill"
        return self.call(request)

    def sign(self, pdf: bytes, certificates: Sequence[bytes], **settings: Any) -> dict[str, Any]:
        """Prepare a signature over `pdf` (the `sign` op); `settings` are the signature's members (`certify`...)."""
        return self.call(
            {
                "abi": PDF_ABI_MIN,
                "op": "sign",
                "pdf": {"data": b64(pdf)},
                "env": dict(ENV),
                "signature": {"certificates": [b64(item) for item in certificates], **settings},
            }
        )

    def complete(
        self,
        prepared: Mapping[str, Any],
        certificates: Sequence[bytes],
        value: bytes,
        *,
        token: bytes | None = None,
        **settings: Any,
    ) -> dict[str, Any]:
        """Embed `value` (and a `TimeStampResp` or token) into the prepared file (the `complete` op)."""
        signing: dict[str, Any] = {
            "certificates": [b64(item) for item in certificates],
            "value": b64(value),
            "toBeSignedDigest": prepared["signing"]["toBeSignedDigest"],
            **settings,
        }
        if token is not None:
            signing["timestamp"] = {"token": b64(token)}
        return self.call({"abi": PDF_ABI_MIN, "op": "complete", "pdf": {"data": prepared["bytes"]}, "signing": signing})

    def timestamp_request(self, value: bytes) -> dict[str, Any]:
        """Ask the program for the RFC 3161 request over a signature value (the `timestampRequest` op)."""
        return self.call({"abi": PDF_ABI_MIN, "op": "timestampRequest", "signature": b64(value)})

    def verify(self, pdf: bytes, known: Sequence[bytes] = ()) -> dict[str, Any]:
        """Verify every signature of `pdf` (the `verify` op); `known` are the certificates the host already knows."""
        request: dict[str, Any] = {"abi": PDF_ABI_MIN, "op": "verify", "pdf": {"data": b64(pdf)}}
        if known:
            request["knownCertificates"] = [b64(item) for item in known]
        return self.call(request)

    def inspect(self, template: bytes, *, attachments: str | None = None) -> dict[str, Any]:
        """List a PDF's fields, pages and signatures (the `inspect` op)."""
        request: dict[str, Any] = {"abi": PDF_ABI_MIN, "op": "inspect", "template": {"data": b64(template)}}
        if attachments is not None:
            request["attachments"] = attachments
        return self.call(request)

    # -- documents and signatures a test needs ------------------------------------------------------------------------
    def unsigned_pdf(self) -> bytes:
        """Return (printing once) the fixture form printed with `ANSWERS`."""
        if self._unsigned is None:
            answer = self.document()
            assert answer.get("ok") is True, answer
            self._unsigned = unb64(answer["bytes"])
        return self._unsigned

    def sign_with(
        self,
        identity: TsaIdentity,
        pdf: bytes | None = None,
        *,
        value: Callable[[bytes], bytes] | None = None,
        token: Callable[[bytes], bytes] | None = None,
        chain: Sequence[bytes] | None = None,
        **settings: Any,
    ) -> Signed:
        """Sign `pdf` (default `unsigned_pdf()`) with `identity` through `sign` and `complete`.

        `value` replaces the signing step (a forged value goes here); `token` turns the signature value into the
        `TimeStampResp` to embed (the settings then ask `timestamp: True` so the placeholder has room); `chain` replaces
        the certificates the signature carries.
        """
        certificates = tuple(chain) if chain is not None else (identity.leaf_der,)
        file = self.unsigned_pdf() if pdf is None else pdf
        if token is not None:
            settings.setdefault("timestamp", True)
        prepared = self.sign(file, certificates, **settings)
        assert prepared.get("ok") is True, prepared
        to_be_signed = unb64(prepared["signing"]["toBeSigned"])
        signature = value(to_be_signed) if value is not None else identity.sign(to_be_signed)
        embedded = token(signature) if token is not None else None
        completed = self.complete(
            prepared,
            certificates,
            signature,
            token=embedded,
            **{key: item for key, item in settings.items() if key != "timestamp"},
        )
        assert completed.get("ok") is True, completed
        return Signed(unb64(completed["bytes"]), signature, prepared, completed, embedded, certificates)

    def first_signature(self, data: bytes, known: Sequence[bytes] = ()) -> dict[str, Any]:
        """Verify `data` and return the first signature's report."""
        answer = self.verify(data, known)
        assert answer.get("ok") is True, answer
        return cast("dict[str, Any]", answer["signatures"][0])


def kernel_skip_reason() -> str | None:
    """Return why the program cannot run here, or `None`."""
    if ENGINE not in GuestRuntimes.discover().ids():
        return f"the {ENGINE} engine is not installed (argusvane-datum-sandbox-wasmtime registers it)"
    try:
        pdf_program()
        endpoint_form()
    except FixturesNotFoundError as error:
        return f"the PDF program or its fixtures are not built: {error}"
    return None


@contextlib.contextmanager
def pdf_session(*, time_limit: float = 120.0, pdf_slots: int = 1) -> Generator[PdfKernelSession]:
    """Start the engine and yield a session; skip, with a reason, when the program cannot run here."""
    reason = kernel_skip_reason()
    if reason is not None:
        pytest.skip(reason)
    work_dir = Path(tempfile.mkdtemp(prefix="datum-pdf-kernel-"))
    provider = GuestRuntimes.discover().select(ENGINE)
    runtime = provider.create(
        EngineLimits({"validation": 1, "pdf": pdf_slots}, work_dir, tick_seconds=0.05), EngineSettings()
    )
    try:
        yield PdfKernelSession(runtime, time_limit=time_limit)
    finally:
        runtime.close()
        shutil.rmtree(work_dir, ignore_errors=True)


@pytest.fixture(scope="module")
def module_session() -> Generator[PdfKernelSession]:
    """One started program per test module (import it into a module to use it, as `tsa_kernel` modules do)."""
    with pdf_session() as session:
        yield session
