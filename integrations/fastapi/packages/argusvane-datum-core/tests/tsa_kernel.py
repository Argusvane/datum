"""Drive the real PDF program for the timestamp gate: the kernel's `parseTimestampToken`, by `complete` and `verify`.

The flow runs on the real wasmtime engine and the packaged program (`argusvane-datum-programs`): render
a PDF, ask the program to `sign` it with a timestamp flag, sign `toBeSigned` here (RSA PKCS#1 v1.5, a throwaway signer
certificate from the test PKI), ask `timestampRequest` for the request the program wants, let the authority under test
answer it, `complete` the PDF with the whole `TimeStampResp` (the kernel parses the token and checks it covers the
signature value) and `verify` it (`coversSignature`, `certificateMatches`). Nothing here reads a token itself: the
program is the oracle.

A test using it carries the `runtime` marker; `kernel_session()` skips, with a reason, when the engine or the program is
absent. The runtime is expensive to start, so a module builds one (`KernelSession`) and reuses it.
"""

import base64
import contextlib
import json
import shutil
import tempfile
from collections.abc import Generator, Sequence
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

import pytest
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import padding, rsa
from cryptography.x509.oid import ExtendedKeyUsageOID

from datum_core.testing.tsa_pki import TsaPki, make_leaf
from datum_sandbox.protocol import PDF_ABI_MIN, PDF_RUN_SCRIPT, ProgramLimits, program_run
from datum_sandbox.testing.fixtures import FixturesNotFoundError, pdf_hashes, pdf_program
from datum_sandbox.testing.pdf_contract import pdf_fonts, render_request
from datum_sandbox.wasi import EngineLimits, EngineSettings, GuestRuntime, GuestRuntimes, RunEnd

ENGINE = "wasmtime"
ENV = {"createdAt": "2026-10-20T12:00:00Z", "documentId": "tsa-gate"}


def b64(data: bytes) -> str:
    """Return the base64 text of `data`."""
    return base64.b64encode(data).decode("ascii")


def unb64(text: str) -> bytes:
    """Return the bytes of a base64 text."""
    return base64.b64decode(text)


@dataclass(frozen=True)
class Signing:
    """A PDF signed up to the point the timestamp is asked for."""

    prepared: dict[str, Any]
    value: bytes
    """The signature value the PDF signer produced: what a token must cover."""
    request: bytes
    """The TimeStampReq the program asked for over that value."""


class KernelSession:
    """A started runtime, the packaged PDF program and a throwaway document signer."""

    def __init__(self, runtime: GuestRuntime, pki: TsaPki) -> None:
        self.runtime = runtime
        self._budget = ProgramLimits(pdf_time_limit=120).pdf_budget()
        self._program = pdf_program()
        self._key = rsa.generate_private_key(65537, 2048)
        leaf = make_leaf(
            "Document signer",
            self._key,
            pki.rsa.root,
            pki.rsa.root_key,
            eku=(ExtendedKeyUsageOID.CODE_SIGNING,),
            eku_critical=False,
        )
        self.signer_der = leaf.public_bytes(serialization.Encoding.DER)
        self._unsigned: str | None = None

    def call(self, request: dict[str, Any]) -> dict[str, Any]:
        """Send one request to the PDF program and return its JSON answer (the test reads `ok` itself)."""
        body = json.dumps(request, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        result = self.runtime.run(program_run(self._program.data, PDF_RUN_SCRIPT.encode("utf-8"), body, self._budget))
        assert result.end is RunEnd.CLEAN, result.stderr.decode("utf-8", "replace")
        return cast("dict[str, Any]", json.loads(result.stdout))

    def unsigned_pdf(self) -> str:
        """Render (once) a small PDF; return its base64."""
        if self._unsigned is None:
            theme = min(pdf_hashes())
            request = json.loads(render_request(theme, pdf_fonts()))
            request["env"] = {**request["env"], **ENV}
            reply = self.call(request)
            assert reply["ok"], reply
            self._unsigned = str(reply["bytes"])
        return self._unsigned

    def prepare(self) -> Signing:
        """Prepare a signature with a timestamp flag, sign it here and ask for the program's TimeStampReq."""
        prepared = self.call(
            {
                "abi": PDF_ABI_MIN,
                "op": "sign",
                "pdf": {"data": self.unsigned_pdf()},
                "env": ENV,
                "signature": {"certificates": [b64(self.signer_der)], "timestamp": True, "reason": "Submitted"},
            }
        )
        assert prepared["ok"], prepared
        value = self._key.sign(unb64(prepared["signing"]["toBeSigned"]), padding.PKCS1v15(), hashes.SHA256())
        asked = self.call({"abi": PDF_ABI_MIN, "op": "timestampRequest", "signature": b64(value)})
        assert asked["ok"], asked
        return Signing(prepared, value, unb64(asked["request"]))

    def complete(self, signing: Signing, answer: bytes, *, over: bytes | None = None) -> dict[str, Any]:
        """Hand `answer` (the whole TimeStampResp, or a bare token) to `complete`; `over` replaces the signed value."""
        value = signing.value if over is None else over
        return self.call(
            {
                "abi": PDF_ABI_MIN,
                "op": "complete",
                "pdf": {"data": signing.prepared["bytes"]},
                "signing": {
                    "certificates": [b64(self.signer_der)],
                    "reason": "Submitted",
                    "value": b64(value),
                    "toBeSignedDigest": signing.prepared["signing"]["toBeSignedDigest"],
                    "timestamp": {"token": b64(answer)},
                },
            }
        )

    def verify(self, completed: dict[str, Any], known: Sequence[bytes] = ()) -> dict[str, Any]:
        """Verify the completed PDF and return the first signature's `timestamp` report."""
        request: dict[str, Any] = {"abi": PDF_ABI_MIN, "op": "verify", "pdf": {"data": completed["bytes"]}}
        if known:
            request["knownCertificates"] = [b64(item) for item in known]
        verified = self.call(request)
        assert verified["ok"], verified
        report = verified["signatures"][0].get("timestamp")
        assert report is not None, verified["signatures"][0]
        return cast("dict[str, Any]", report)


def kernel_skip_reason() -> str | None:
    """Return why the kernel gate cannot run here, or `None`."""
    if ENGINE not in GuestRuntimes.discover().ids():
        return f"the {ENGINE} engine is not installed (argusvane-datum-sandbox-wasmtime registers it)"
    try:
        pdf_program()
        pdf_hashes()
    except FixturesNotFoundError as error:
        return f"the PDF program or its fixtures are not built: {error}"
    return None


@contextlib.contextmanager
def kernel_session(pki: TsaPki) -> Generator[KernelSession]:
    """Start the engine and yield a session; skip, with a reason, when the program cannot run here."""
    reason = kernel_skip_reason()
    if reason is not None:
        pytest.skip(reason)
    work_dir = Path(tempfile.mkdtemp(prefix="datum-tsa-kernel-"))
    provider = GuestRuntimes.discover().select(ENGINE)
    runtime = provider.create(EngineLimits({"validation": 1, "pdf": 1}, work_dir, tick_seconds=0.05), EngineSettings())
    try:
        yield KernelSession(runtime, pki)
    finally:
        runtime.close()
        shutil.rmtree(work_dir, ignore_errors=True)
