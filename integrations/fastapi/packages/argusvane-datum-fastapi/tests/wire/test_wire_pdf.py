"""The PDF wire gate: the conformance kit, openssl and pyHanko against `pdf_app.py` under uvicorn.

Boot G (`pdf_app.py`: `routers.forms` and `routers.pdf(dependencies=[])`; the kit's fixture form in
`datum.forms.locations`; the five PDF switches and the definition switch; a PKCS#12 key the test builds in
`DATUM_PDF__SIGNING__PKCS12_FILE`; `DATUM_PDF__SEAL__ENABLED=true` and `..__TIMESTAMP=true` with the in-process
authority `DATUM_TSA__ENABLED=true`, `..__SIGNER__SELF_SIGNED=true`, `..__ALLOW_MEMORY_STORES=true` and a
labelled-placeholder `DATUM_TSA__POLICY`): `datum-host-check --capabilities pdf --pdf-signing` exits 0 with PDF-01..05.
The same boot answers the checks the kit has no case for: posted answers verify as exactly one intact signature read
`self_signed`, a sealed `/api/pdf/sign` names the key's subject and reads `site` with a timestamp,
`/api/server/certificate` is the key's chain, `openssl cms -verify` accepts the signature over its ByteRange bytes and
pyHanko finds it intact, valid and trusted against the key's root. Boot H (no key, seal off): the same run without
`--pdf-signing` exits 0 with PDF-03 and PDF-05 SKIPPED and `/api/server/certificate` is 404. Program mode:
`datum-security-check --pdf-program` passes OUT-01..15 against the packaged program (OUT-11 skips exactly when veraPDF
is absent, OUT-12 without openssl, each with the reason).

Needs node, the built kit, uvicorn, the real engine and the openssl binary; skipped with a reason when any is missing.
Serial: each boot is a subprocess (markers `server`, `runtime` and `openssl`).
"""

import base64
import contextlib
import importlib.util
import io
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Generator
from pathlib import Path
from typing import Any

import pytest

from datum_core.testing.openssl import openssl_binary, openssl_skip_reason
from datum_core.testing.tsa_pki import DocumentPki, build_document_pki

pytestmark = [pytest.mark.server, pytest.mark.runtime, pytest.mark.openssl]

WIRE = Path(__file__).resolve().parent
REPO = WIRE.parents[5]
KIT = REPO / "packages" / "conformance-suite"
HOST_CHECK = KIT / "bin" / "datum-host-check.mjs"
SECURITY_CHECK = KIT / "bin" / "datum-security-check.mjs"
BUILT = (KIT / "dist" / "host-check.mjs", KIT / "dist" / "cli.mjs")
PDF_PROGRAM = (
    REPO
    / "integrations"
    / "fastapi"
    / "packages"
    / "argusvane-datum-programs"
    / "src"
    / "datum_programs"
    / "resources"
    / "datum-pdf-program.js"
)
P12_PASSWORD = "wire-pdf-p12-correct-horse-9"
FORM = "datum-security-suite"
PDF = "application/pdf"


def skip_reason() -> str | None:
    if shutil.which("node") is None:
        return "node is not installed"
    if importlib.util.find_spec("uvicorn") is None:
        return "uvicorn is not installed"
    if importlib.util.find_spec("datum_sandbox_wasmtime") is None:
        return "no engine is installed (argusvane-datum-sandbox-wasmtime)"
    if not HOST_CHECK.is_file() or not all(path.is_file() for path in BUILT):
        return "the conformance kit is not built (npm run build in packages/conformance-suite)"
    return openssl_skip_reason()


PYHANKO_OPTIONAL = os.environ.get("DATUM_WIRE_PYHANKO_OPTIONAL") == "1"
"""The dev group holds pyhanko, so its absence is a broken environment and fails loudly; this opts out for a leg that
installs the host without the dev group."""


def verapdf_path() -> Path:
    """Where the kit looks for veraPDF: `VERAPDF` when that file exists, else `~/verapdf/verapdf`."""
    named = os.environ.get("VERAPDF")
    if named and Path(named).exists():
        return Path(named)
    return Path.home() / "verapdf" / "verapdf"


REASON = skip_reason()
needs_tools = pytest.mark.skipif(REASON is not None, reason=REASON or "")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def run_kit(binary: Path, *args: str, timeout: float = 900) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        ["node", str(binary), *args],  # noqa: S607
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def openssl(*args: str, data: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    binary = openssl_binary()
    assert binary is not None
    return subprocess.run([binary, *args], input=data, capture_output=True, check=False, timeout=60)  # noqa: S603


@pytest.fixture(scope="module")
def fixture_form(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("host-check-fixtures")
    done = run_kit(HOST_CHECK, "fixtures", "--out", str(out), timeout=300)
    assert done.returncode == 0, done.stdout + done.stderr
    return out / "fixture-form.json"


@pytest.fixture(scope="module")
def pki() -> DocumentPki:
    return build_document_pki()


def environment_for(form: Path, **more: str) -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_FORMS__LOCATIONS": json.dumps([str(form)]),
        "DATUM_WEB__API__ENDPOINTS__PDF": "true",
        "DATUM_WEB__API__ENDPOINTS__FILL": "true",
        "DATUM_WEB__API__ENDPOINTS__SIGN": "true",
        "DATUM_WEB__API__ENDPOINTS__VERIFY": "true",
        "DATUM_WEB__API__ENDPOINTS__CERTIFICATE": "true",
        "DATUM_WEB__API__ENDPOINTS__DEFINITION": "true",
        **more,
    }


def key_environment(directory: Path, pki: DocumentPki) -> dict[str, str]:
    p12 = directory / "seal.p12"
    p12.write_bytes(pki.signer.pkcs12(password=P12_PASSWORD, key_name="datum-pdf"))
    return {
        "DATUM_PDF__SIGNING__TYPE": "PKCS12",
        "DATUM_PDF__SIGNING__PKCS12_FILE": str(p12),
        "DATUM_PDF__SIGNING__PKCS12_PASSWORD": P12_PASSWORD,
        "DATUM_PDF__SIGNING__FRIENDLY_NAME": "datum-pdf",
        "DATUM_PDF__SEAL__ENABLED": "true",
        "DATUM_PDF__SEAL__TIMESTAMP": "true",
        "DATUM_TSA__ENABLED": "true",
        "DATUM_TSA__SIGNER__SELF_SIGNED": "true",
        "DATUM_TSA__ALLOW_MEMORY_STORES": "true",
        "DATUM_TSA__POLICY": "1.3.6.1.4.1.99999.1",
    }


@contextlib.contextmanager
def boot(log: Path, env: dict[str, str]) -> Generator[int]:
    port = free_port()
    command = [sys.executable, "-m", "uvicorn", "pdf_app:app", "--port", str(port), "--log-level", "debug"]
    with log.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(command, cwd=WIRE, env=env, stdout=sink, stderr=subprocess.STDOUT)  # noqa: S603
        try:
            deadline = time.monotonic() + 180
            while time.monotonic() < deadline:
                assert process.poll() is None, f"uvicorn exited {process.returncode}: {log.read_text(encoding='utf-8')}"
                try:
                    socket.create_connection(("127.0.0.1", port), timeout=1).close()
                    break
                except OSError:
                    time.sleep(0.2)
            else:
                pytest.fail("the application never listened")
            yield port
        finally:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()


def report_text(done: subprocess.CompletedProcess[str], out: Path) -> str:
    parts = [done.stdout, done.stderr]
    parts += [p.read_text(encoding="utf-8", errors="replace") for p in sorted(out.rglob("*")) if p.is_file()]
    return "\n".join(parts)


def status_of_case(text: str, case: str) -> str | None:
    """The status of one case in a kit report (`| ID | Title | Status |`, or with Sev, Attacker and Runner)."""
    words = r"(PASS|SKIP|FAIL|WARN|ERROR|XFAIL|XPASS)"
    for middle in (1, 3):
        found = re.search(rf"^\|\s*{re.escape(case)}\s*\|(?:[^|]*\|){{{middle}}}\s*{words}\s*\|", text, re.MULTILINE)
        if found is not None:
            return found.group(1)
    return None


def case_row(text: str, case: str) -> str:
    """The report's table row of one case (its status and the reason a skip gives)."""
    found = re.search(rf"^\|\s*{re.escape(case)}\s*\|.*$", text, re.MULTILINE)
    return "" if found is None else found.group(0)


def exchange(
    port: int, path: str, *, body: bytes | None = None, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], bytes]:
    call = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=body, method="POST" if body is not None else "GET", headers=headers or {}
    )
    try:
        with urllib.request.urlopen(call, timeout=120) as reply:  # noqa: S310
            return reply.status, {k.lower(): v for k, v in reply.headers.items()}, reply.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def control_one() -> dict[str, Any]:
    """The kit's CTL-01 envelope: the fixture form at version 1 with the suite's valid answers."""
    return {
        "document": {
            "versionContext": {
                "form": {"id": FORM, "version": "1"},
                "client": {"runtimeVersion": "x", "rendererVersion": "x", "schemaVersion": "1"},
            },
            "submission": {
                "locale": "en",
                "values": {
                    "name": "Ada Lovelace",
                    "code": "AB1234",
                    "addr": {"city": "Ottawa", "pick": "ok"},
                    "tags": {"x": True, "y": False},
                    "rows": [{"sku": "s1", "n": 1}],
                },
            },
        }
    }


def post_json(port: int, path: str, body: dict[str, Any]) -> tuple[int, dict[str, str], bytes]:
    return exchange(port, path, body=json.dumps(body).encode(), headers={"Content-Type": "application/json"})


def signature_bytes(data: bytes) -> tuple[bytes, bytes]:
    """The ByteRange bytes of the first signature and its CMS DER, read straight from the PDF's bytes."""
    found = re.search(rb"/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]", data)
    assert found is not None
    a, b, c, d = (int(item) for item in found.groups())
    covered = data[a : a + b] + data[c : c + d]
    blob = bytes.fromhex(data[a + b : c].strip(b"<>").decode("ascii"))
    length = blob[1]
    cms = (
        blob[: 2 + length]
        if length < 0x80
        else blob[: 2 + (length & 0x7F) + int.from_bytes(blob[2 : 2 + (length & 0x7F)], "big")]
    )
    return covered, cms


# -- the wire application ----------------------------------------------------------------------------------------------
def test_the_wire_application_exists_and_is_the_forms_and_pdf_routers_with_settings_from_the_environment() -> None:
    path = WIRE / "pdf_app.py"
    assert path.is_file(), "7H writes tests/wire/pdf_app.py"
    text = path.read_text(encoding="utf-8")
    assert "routers.pdf" in text
    assert "routers.forms" in text
    assert "dependencies=[]" in text, "the explicit opt-out of the privileged factory"
    for forbidden in (
        "routers.builder",
        "routers.submissions",
        "routers.tsa",
        "add_middleware",
        "add_exception_handler",
    ):
        assert forbidden not in text
    assert "app.state" not in text
    assert "DatumSettings" in text


# -- boot G: the kit, openssl and pyHanko ------------------------------------------------------------------------------
@needs_tools
def test_boot_g_the_kit_passes_pdf_01_to_05_with_the_signing_key(
    tmp_path: Path, fixture_form: Path, pki: DocumentPki
) -> None:
    out = tmp_path / "report"
    env = environment_for(fixture_form, **key_environment(tmp_path, pki))
    with boot(tmp_path / "uvicorn.log", env) as port:
        done = run_kit(
            HOST_CHECK,
            "--endpoint",
            f"http://127.0.0.1:{port}",
            "--capabilities",
            "pdf",
            "--pdf-signing",
            "--out",
            str(out),
        )
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
    for case in ("PDF-01", "PDF-02", "PDF-03", "PDF-04", "PDF-05"):
        assert status_of_case(text, case) == "PASS", case


@needs_tools
def test_boot_g_posted_answers_are_one_intact_self_signed_signature_and_pyhanko_finds_it_sound(
    tmp_path: Path, fixture_form: Path, pki: DocumentPki
) -> None:
    if importlib.util.find_spec("pyhanko") is None and not PYHANKO_OPTIONAL:
        pytest.fail("pyhanko is in the dev group (locked at 0.38.0) and is not installed: sync the workspace")
    pytest.importorskip("pyhanko")
    from asn1crypto import x509 as asn1_x509  # type: ignore[import-untyped]  # noqa: PLC0415
    from pyhanko.pdf_utils.reader import PdfFileReader  # noqa: PLC0415
    from pyhanko.sign.validation import validate_pdf_signature  # noqa: PLC0415
    from pyhanko_certvalidator import ValidationContext  # noqa: PLC0415

    env = environment_for(fixture_form, **key_environment(tmp_path, pki))
    with boot(tmp_path / "uvicorn.log", env) as port:
        status, headers, pdf = post_json(port, "/api/pdf", control_one())
        assert status == 200
        assert pdf.startswith(b"%PDF-")
        assert "Datum test seal" in urllib.parse.unquote(headers["x-signed-by"])
        status, _, report = exchange(port, "/api/pdf/verify", body=pdf, headers={"Content-Type": PDF})
    assert status == 200
    signatures = json.loads(report)["signatures"]
    assert len(signatures) == 1
    assert (signatures[0]["value"], signatures[0]["intact"], signatures[0]["trust"]) == ("valid", True, "self_signed")
    reader = PdfFileReader(io.BytesIO(pdf))
    embedded = reader.embedded_signatures[0]
    own = asn1_x509.Certificate.load(embedded.signer_cert.dump())
    verdict = validate_pdf_signature(
        embedded, signer_validation_context=ValidationContext(trust_roots=[own], allow_fetching=False)
    )
    assert (verdict.intact, verdict.valid) == (True, True)


@needs_tools
def test_boot_g_sign_names_the_keys_subject_reads_site_with_a_timestamp_and_openssl_accepts_the_signature(
    tmp_path: Path, fixture_form: Path, pki: DocumentPki
) -> None:
    env = environment_for(fixture_form, **key_environment(tmp_path, pki))
    with boot(tmp_path / "uvicorn.log", env) as port:
        status, headers, pdf = post_json(port, "/api/pdf/sign", control_one())
        assert status == 200
        assert "Test document signer" in urllib.parse.unquote(headers["x-signed-by"])
        _, _, chain = exchange(port, "/api/server/certificate")
        _, _, report = exchange(port, "/api/pdf/verify", body=pdf, headers={"Content-Type": PDF})
    assert chain.count(b"-----BEGIN CERTIFICATE-----") == 2
    assert base64.b64encode(pki.signer.leaf_der).decode() in chain.decode().replace("\n", "")
    verdict = json.loads(report)["signatures"][0]
    # The wire report carries the catalog's members only, so `timestamped` is read from the signature itself: the
    # CMS holds an RFC 3161 token (id-aa-signatureTimeStampToken) as an unsigned attribute.
    assert (verdict["value"], verdict["intact"], verdict["trust"]) == ("valid", True, "site")
    covered, cms = signature_bytes(pdf)
    assert bytes.fromhex("060b2a864886f70d010910020e") in cms
    (tmp_path / "root.pem").write_bytes(pki.signer.root_pem)
    (tmp_path / "sig.der").write_bytes(cms)
    (tmp_path / "content.bin").write_bytes(covered)
    accepted = openssl(
        "cms",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-in",
        str(tmp_path / "sig.der"),
        "-content",
        str(tmp_path / "content.bin"),
        "-CAfile",
        str(tmp_path / "root.pem"),
        "-purpose",
        "any",
        "-out",
        str(tmp_path / "out.bin"),
    )
    assert accepted.returncode == 0, accepted.stderr
    flipped = bytearray(covered)
    flipped[200] ^= 1
    (tmp_path / "content.bin").write_bytes(bytes(flipped))
    refused = openssl(
        "cms",
        "-verify",
        "-binary",
        "-inform",
        "DER",
        "-in",
        str(tmp_path / "sig.der"),
        "-content",
        str(tmp_path / "content.bin"),
        "-CAfile",
        str(tmp_path / "root.pem"),
        "-purpose",
        "any",
        "-out",
        str(tmp_path / "out.bin"),
    )
    assert refused.returncode != 0


@needs_tools
def test_boot_g_the_refusals_come_in_the_catalogs_words_over_the_wire(
    tmp_path: Path, fixture_form: Path, pki: DocumentPki
) -> None:
    env = environment_for(fixture_form, **key_environment(tmp_path, pki))
    with boot(tmp_path / "uvicorn.log", env) as port:
        invalid = control_one()
        invalid["document"]["submission"]["values"]["name"] = ""
        status, _, body = post_json(port, "/api/pdf", invalid)
        assert (status, json.loads(body)["errors"][0]["code"]) == (422, "required")
        status, _, body = post_json(port, "/api/pdf/fill", {**control_one(), "layoutId": "datum-tck-no-such-layout"})
        assert (status, json.loads(body)["errors"][0]["code"]) == (404, "layout.notFound")
        assert exchange(port, "/api/pdf", body=b"{}", headers={"Content-Type": "text/plain"})[0] == 415
        assert exchange(port, "/api/pdf/verify", body=b"{}", headers={"Content-Type": "application/json"})[0] == 415
        status, _, body = exchange(port, "/api/pdf/verify", body=b"hello", headers={"Content-Type": PDF})
        assert (status, json.loads(body)["errors"][0]["code"]) == (400, "pdf.notAPdf")


@needs_tools
def test_boot_g_the_password_and_the_key_stay_out_of_the_log_and_the_answers(
    tmp_path: Path, fixture_form: Path, pki: DocumentPki
) -> None:
    log = tmp_path / "uvicorn.log"
    env = environment_for(fixture_form, **key_environment(tmp_path, pki))
    with boot(log, env) as port:
        _, headers, pdf = post_json(port, "/api/pdf/sign", control_one())
        _, _, chain = exchange(port, "/api/server/certificate")
        _, _, report = exchange(port, "/api/pdf/verify", body=pdf, headers={"Content-Type": PDF})
        _, _, openapi = exchange(port, "/openapi.json")
    text = log.read_text(encoding="utf-8")
    everything = text + chain.decode() + report.decode() + openapi.decode() + json.dumps(headers)
    assert P12_PASSWORD not in everything
    assert "PRIVATE KEY" not in everything
    assert str(tmp_path / "seal.p12") not in report.decode() + chain.decode()


# -- boot H: no key, no seal -------------------------------------------------------------------------------------------
@needs_tools
def test_boot_h_without_a_key_pdf_03_and_pdf_05_are_skipped_and_the_certificate_is_404(
    tmp_path: Path, fixture_form: Path
) -> None:
    out = tmp_path / "report"
    env = environment_for(fixture_form, DATUM_PDF__SEAL__ENABLED="false")
    with boot(tmp_path / "uvicorn.log", env) as port:
        done = run_kit(HOST_CHECK, "--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "pdf", "--out", str(out))
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
        status, _, body = exchange(port, "/api/server/certificate")
        assert (status, json.loads(body)["errors"][0]["code"]) == (404, "certificate.notFound")
        status, headers, pdf = post_json(port, "/api/pdf", control_one())
        assert status == 200
        assert "x-signed-by" not in headers
    for case in ("PDF-01", "PDF-02", "PDF-04"):
        assert status_of_case(text, case) == "PASS", case
    for case in ("PDF-03", "PDF-05"):
        assert status_of_case(text, case) == "SKIP", case
    assert pdf.startswith(b"%PDF-")


@needs_tools
def test_a_boot_that_cannot_load_its_key_never_listens_and_says_which_setting(
    tmp_path: Path, fixture_form: Path, pki: DocumentPki
) -> None:
    port = free_port()
    env = environment_for(fixture_form, **key_environment(tmp_path, pki))
    env["DATUM_PDF__SIGNING__PKCS12_FILE"] = str(tmp_path / "missing.p12")
    log = tmp_path / "uvicorn.log"
    with log.open("w", encoding="utf-8") as sink:
        done = subprocess.run(  # noqa: S603
            [sys.executable, "-m", "uvicorn", "pdf_app:app", "--port", str(port)],
            cwd=WIRE,
            env=env,
            stdout=sink,
            stderr=subprocess.STDOUT,
            timeout=180,
            check=False,
        )
    text = log.read_text(encoding="utf-8")
    assert done.returncode != 0
    assert "pkcs12_file" in text
    assert P12_PASSWORD not in text
    with pytest.raises(OSError, match=r"(?i)refused|connect"):
        socket.create_connection(("127.0.0.1", port), timeout=1).close()


# -- program mode ------------------------------------------------------------------------------------------------------
@pytest.mark.skipif(
    shutil.which("node") is None or not SECURITY_CHECK.is_file() or not PDF_PROGRAM.is_file(),
    reason="node, the built security check or the PDF program is missing",
)
def test_the_security_check_passes_out_01_to_out_15_against_the_packaged_pdf_program(tmp_path: Path) -> None:
    out = tmp_path / "report"
    done = run_kit(SECURITY_CHECK, "--pdf-program", str(PDF_PROGRAM), "--out", str(out), timeout=900)
    assert done.returncode == 0, done.stdout + done.stderr
    text = report_text(done, out)
    assert "0 fail" in done.stdout
    assert "0 error" in done.stdout
    for number in range(1, 16):
        case = f"OUT-{number:02d}"
        assert status_of_case(text, case) in {"PASS", "SKIP"}, case
    skipped = [f"OUT-{n:02d}" for n in range(1, 16) if status_of_case(text, f"OUT-{n:02d}") == "SKIP"]
    # OUT-11 skips exactly when veraPDF is absent (present, it must PASS) and OUT-12 only without openssl.
    assert set(skipped) <= {"OUT-11", "OUT-12"}
    assert ("OUT-11" in skipped) is (not verapdf_path().exists()), skipped
    if "OUT-11" in skipped:
        assert "veraPDF was not found" in case_row(text, "OUT-11")
    if "OUT-12" in skipped:
        assert openssl_binary() is None
        assert "openssl is not available" in case_row(text, "OUT-12")
