"""The timestamp wire gate: the conformance kit and openssl against `tsa_app.py` under uvicorn.

Boot E (`tsa_app.py`: only `routers.tsa`; `DATUM_TSA__ENABLED=true`, `ACCESS=open`, `SIGNER__SELF_SIGNED=true`,
`ALLOW_MEMORY_STORES=true`, `SESSION_COOKIES=["JSESSIONID"]` because TSA-03 sends that cookie name): `datum-host-check
--capabilities tsa` exits 0 with TSA-01..04. The same boot answers the `openssl ts -query | curl | openssl ts -verify`
recipe: the reply verifies against the query and against the data with the certificate the server serves as the root,
the nonce is echoed, and a SHA-1 query is refused `badAlg`. A second boot E holds a PKCS#12 key the test builds
(the root is the test PKI's, so the carried chain verifies to it, and the password never reaches the server's
log). Boot F is the same application with `ACCESS=clients` and one client key hash in `DATUM_TSA__CLIENTS`: the kit
passes with `--header "Authorization=Bearer <key>"` and a request without it is 401 with `WWW-Authenticate`.

Needs node, the built kit, uvicorn, the real engine and the openssl binary; skipped with a reason when any is missing.
Serial: each boot is a subprocess (markers `server`, `runtime` and `openssl`)."""

import contextlib
import hashlib
import importlib.util
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
import urllib.request
from collections.abc import Generator
from pathlib import Path

import pytest

from datum_core.testing.openssl import openssl_binary, openssl_skip_reason
from datum_core.testing.tsa_pki import TsaPki

pytestmark = [pytest.mark.server, pytest.mark.runtime, pytest.mark.openssl]

WIRE = Path(__file__).resolve().parent
REPO = WIRE.parents[5]
KIT = REPO / "packages" / "conformance-suite"
HOST_CHECK = KIT / "bin" / "datum-host-check.mjs"
BUILT = (KIT / "dist" / "host-check.mjs", KIT / "dist" / "cli.mjs")
QUERY = "application/timestamp-query"
REPLY = "application/timestamp-reply"
CLIENT_KEY = "dtsa_Qk1uZ0pLd0d4cWFyTVpKbVhzbmFwdG9nZ1l3aHBqaXE"
P12_PASSWORD = "wire-p12-correct-horse-9"


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


REASON = skip_reason()
needs_tools = pytest.mark.skipif(REASON is not None, reason=REASON or "")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def kit(*args: str, timeout: float = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        ["node", str(HOST_CHECK), *args],  # noqa: S607
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


@contextlib.contextmanager
def boot(log: Path, **environment: str) -> Generator[int]:
    port = free_port()
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_TSA__ENABLED": "true",
        "DATUM_TSA__POLICY": "1.3.6.1.4.1.99999.1",
        "DATUM_TSA__ALLOW_MEMORY_STORES": "true",
        "DATUM_TSA__SESSION_COOKIES": json.dumps(["JSESSIONID"]),
        **environment,
    }
    command = [sys.executable, "-m", "uvicorn", "tsa_app:app", "--port", str(port), "--log-level", "debug"]
    with log.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(command, cwd=WIRE, env=env, stdout=sink, stderr=subprocess.STDOUT)  # noqa: S603
        try:
            deadline = time.monotonic() + 120
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


def passed(text: str, case: str) -> bool:
    return re.search(rf"^\|\s*{re.escape(case)}\s*\|[^|]*\|\s*PASS\s*\|", text, re.MULTILINE) is not None


def exchange(
    port: int, path: str, *, body: bytes | None = None, headers: dict[str, str] | None = None
) -> tuple[int, dict[str, str], bytes]:
    call = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}", data=body, method="POST" if body is not None else "GET", headers=headers or {}
    )
    try:
        with urllib.request.urlopen(call, timeout=30) as reply:  # noqa: S310
            return reply.status, {k.lower(): v for k, v in reply.headers.items()}, reply.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


SELF_SIGNED = {"DATUM_TSA__ACCESS": "open", "DATUM_TSA__SIGNER__SELF_SIGNED": "true"}


# -- the wire application ----------------------------------------------------------------------------------------------
def test_the_wire_application_exists_and_is_only_the_tsa_router_with_settings_from_the_environment() -> None:
    path = WIRE / "tsa_app.py"
    assert path.is_file(), "6G writes tests/wire/tsa_app.py"
    text = path.read_text(encoding="utf-8")
    assert "routers.tsa" in text
    for forbidden in (
        "routers.forms",
        "routers.builder",
        "routers.submissions",
        "add_middleware",
        "add_exception_handler",
    ):
        assert forbidden not in text
    assert "app.state" not in text
    assert "DatumSettings" in text


# -- boot E: the kit and openssl ---------------------------------------------------------------------------------------
@needs_tools
def test_boot_e_the_kit_passes_tsa_01_to_04_with_a_session_cookie_name_the_application_refuses(tmp_path: Path) -> None:
    out = tmp_path / "report"
    with boot(tmp_path / "uvicorn.log", **SELF_SIGNED) as port:
        done = kit("--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "tsa", "--out", str(out))
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
    for case in ("TSA-01", "TSA-02", "TSA-03", "TSA-04"):
        assert passed(text, case), case


@needs_tools
def test_boot_e_the_openssl_query_the_post_and_the_verify_recipe_round_trip(tmp_path: Path) -> None:
    data = tmp_path / "file.txt"
    data.write_bytes(b"the document to timestamp\n")
    query = openssl("ts", "-query", "-sha256", "-cert", "-data", str(data))
    assert query.returncode == 0, query.stderr
    with boot(tmp_path / "uvicorn.log", **SELF_SIGNED) as port:
        status, headers, reply = exchange(port, "/tsa", body=query.stdout, headers={"Content-Type": QUERY})
        assert status == 200
        assert headers["content-type"].partition(";")[0] == REPLY
        assert "no-store" in headers["cache-control"]
        assert "etag" not in headers
        _, _, chain = exchange(port, "/tsa/certificate")
        _, _, der = exchange(port, "/tsa/certificate?format=der")
    root = tmp_path / "root.pem"
    root.write_bytes(chain)
    (tmp_path / "request.tsq").write_bytes(query.stdout)
    (tmp_path / "reply.tsr").write_bytes(reply)
    by_query = openssl(
        "ts",
        "-verify",
        "-in",
        str(tmp_path / "reply.tsr"),
        "-queryfile",
        str(tmp_path / "request.tsq"),
        "-CAfile",
        str(root),
    )
    assert by_query.returncode == 0, by_query.stderr
    by_data = openssl("ts", "-verify", "-in", str(tmp_path / "reply.tsr"), "-data", str(data), "-CAfile", str(root))
    assert by_data.returncode == 0, by_data.stderr
    text = openssl("ts", "-reply", "-in", str(tmp_path / "reply.tsr"), "-text").stdout.decode()
    nonce = re.search(r"Nonce: (0x[0-9A-Fa-f]+)", text)
    assert nonce is not None, text
    assert (
        nonce.group(1).lower()
        in openssl("ts", "-query", "-in", str(tmp_path / "request.tsq"), "-text").stdout.decode().lower()
    )
    assert der[0] == 0x30


@needs_tools
def test_boot_e_a_sha1_query_is_refused_bad_alg_with_a_400_rejection(tmp_path: Path) -> None:
    data = tmp_path / "file.txt"
    data.write_bytes(b"x")
    query = openssl("ts", "-query", "-sha1", "-data", str(data))
    with boot(tmp_path / "uvicorn.log", **SELF_SIGNED) as port:
        status, headers, reply = exchange(port, "/tsa", body=query.stdout, headers={"Content-Type": QUERY})
    assert status == 400
    assert headers["content-type"].partition(";")[0] == REPLY
    (tmp_path / "reply.tsr").write_bytes(reply)
    text = openssl("ts", "-reply", "-in", str(tmp_path / "reply.tsr"), "-text").stdout.decode()
    assert "Rejected" in text
    assert "unrecognized or unsupported algorithm identifier" in text


@needs_tools
def test_boot_e_a_cookie_is_403_and_another_type_is_415_in_plain_text(tmp_path: Path) -> None:
    with boot(tmp_path / "uvicorn.log", **SELF_SIGNED) as port:
        status, headers, body = exchange(
            port, "/tsa", body=b"x", headers={"Content-Type": QUERY, "Cookie": "JSESSIONID=x"}
        )
        assert (status, headers["content-type"].partition(";")[0]) == (403, "text/plain")
        status, _, _ = exchange(port, "/tsa", body=b"x", headers={"Content-Type": "application/octet-stream"})
        assert status == 415
        assert b"bad_document" not in body


@needs_tools
def test_boot_e_with_a_pkcs12_key_the_carried_chain_verifies_to_the_test_root_and_the_password_stays_out_of_the_log(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    p12 = tmp_path / "tsa.p12"
    p12.write_bytes(tsa_pki.ec.pkcs12(password=P12_PASSWORD))
    root = tmp_path / "root.pem"
    root.write_bytes(tsa_pki.ec.root_pem)
    data = tmp_path / "file.txt"
    data.write_bytes(b"signed by a real chain\n")
    query = openssl("ts", "-query", "-sha256", "-cert", "-data", str(data))
    log = tmp_path / "uvicorn.log"
    environment = {
        "DATUM_TSA__ACCESS": "open",
        "DATUM_TSA__SIGNER__TYPE": "PKCS12",
        "DATUM_TSA__SIGNER__PKCS12_FILE": str(p12),
        "DATUM_TSA__SIGNER__PKCS12_PASSWORD": P12_PASSWORD,
        "DATUM_TSA__SIGNER__FRIENDLY_NAME": "datum-tsa",
    }
    with boot(log, **environment) as port:
        status, _, reply = exchange(port, "/tsa", body=query.stdout, headers={"Content-Type": QUERY})
        assert status == 200
        _, _, chain = exchange(port, "/tsa/certificate")
    (tmp_path / "reply.tsr").write_bytes(reply)
    verified = openssl("ts", "-verify", "-in", str(tmp_path / "reply.tsr"), "-data", str(data), "-CAfile", str(root))
    assert verified.returncode == 0, verified.stderr
    assert chain.count(b"BEGIN CERTIFICATE") == 2
    text = log.read_text(encoding="utf-8")
    assert P12_PASSWORD not in text
    assert "PRIVATE KEY" not in text
    assert hashlib.sha256(P12_PASSWORD.encode()).hexdigest() not in text


@needs_tools
def test_boot_e_the_pdf_program_signs_stamps_over_the_wire_completes_and_verifies(
    tmp_path: Path, tsa_pki: TsaPki
) -> None:
    """The PDF program's `timestampRequest` is answered by the running server; `complete` and `verify` accept it."""
    sys.path.insert(0, str(REPO / "integrations" / "fastapi" / "packages" / "argusvane-datum-core" / "tests"))
    try:
        from tsa_kernel import kernel_session  # noqa: PLC0415
    finally:
        sys.path.pop(0)
    p12 = tmp_path / "tsa.p12"
    p12.write_bytes(tsa_pki.ec.pkcs12(password=P12_PASSWORD))
    environment = {
        "DATUM_TSA__ACCESS": "open",
        "DATUM_TSA__SIGNER__TYPE": "PKCS12",
        "DATUM_TSA__SIGNER__PKCS12_FILE": str(p12),
        "DATUM_TSA__SIGNER__PKCS12_PASSWORD": P12_PASSWORD,
        "DATUM_TSA__SIGNER__FRIENDLY_NAME": "datum-tsa",
    }
    with kernel_session(tsa_pki) as session, boot(tmp_path / "uvicorn.log", **environment) as port:
        signing = session.prepare()
        status, headers, reply = exchange(port, "/tsa", body=signing.request, headers={"Content-Type": QUERY})
        assert status == 200
        assert headers["content-type"].partition(";")[0] == REPLY
        completed = session.complete(signing, reply)
        assert completed["ok"], completed
        assert completed["timestamped"] is True
        report = session.verify(completed, known=[tsa_pki.ec.leaf_der])
    assert report["coversSignature"] is True
    assert report["certificateMatches"] is True


# -- boot F: client keys -----------------------------------------------------------------------------------------------
CLIENTS = {
    "DATUM_TSA__ACCESS": "clients",
    "DATUM_TSA__SIGNER__SELF_SIGNED": "true",
    "DATUM_TSA__CLIENTS": json.dumps([hashlib.sha256(CLIENT_KEY.encode()).hexdigest()]),
}


@needs_tools
def test_boot_f_the_kit_passes_with_the_client_key_in_the_authorization_header(tmp_path: Path) -> None:
    out = tmp_path / "report"
    log = tmp_path / "uvicorn.log"
    with boot(log, **CLIENTS) as port:
        done = kit(
            "--endpoint",
            f"http://127.0.0.1:{port}",
            "--capabilities",
            "tsa",
            "--header",
            f"Authorization=Bearer {CLIENT_KEY}",
            "--out",
            str(out),
        )
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
    for case in ("TSA-01", "TSA-02", "TSA-03", "TSA-04"):
        assert passed(text, case), case
    assert CLIENT_KEY not in log.read_text(encoding="utf-8")


@needs_tools
def test_boot_f_a_request_without_the_key_is_401_with_the_challenge_and_a_wrong_key_is_too(tmp_path: Path) -> None:
    body = openssl("ts", "-query", "-sha256", "-digest", "00" * 32, "-no_nonce").stdout
    with boot(tmp_path / "uvicorn.log", **CLIENTS) as port:
        for headers in ({}, {"Authorization": "Bearer dtsa_wrong"}):
            status, reply_headers, text = exchange(port, "/tsa", body=body, headers={"Content-Type": QUERY, **headers})
            assert status == 401
            assert (
                reply_headers["www-authenticate"] == 'Bearer realm="timestamp server", Basic realm="timestamp server"'
            )
            assert reply_headers["content-type"].partition(";")[0] == "text/plain"
            assert CLIENT_KEY.encode() not in text
        status, _, _ = exchange(
            port, "/tsa", body=body, headers={"Content-Type": QUERY, "Authorization": f"Bearer {CLIENT_KEY}"}
        )
        assert status == 200


@needs_tools
def test_boot_f_the_certificates_are_public_without_a_key(tmp_path: Path) -> None:
    with boot(tmp_path / "uvicorn.log", **CLIENTS) as port:
        for path in ("/tsa/certificate", "/tsa/certificates", "/tsa/certificate?format=der"):
            assert exchange(port, path)[0] == 200, path


@needs_tools
def test_a_boot_that_cannot_load_its_key_never_listens_and_says_which_setting(tmp_path: Path) -> None:
    port = free_port()
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_TSA__ENABLED": "true",
        "DATUM_TSA__POLICY": "1.3.6.1.4.1.99999.1",
        "DATUM_TSA__ALLOW_MEMORY_STORES": "true",
        "DATUM_TSA__SIGNER__TYPE": "PKCS12",
        "DATUM_TSA__SIGNER__PKCS12_FILE": str(tmp_path / "missing.p12"),
        "DATUM_TSA__SIGNER__PKCS12_PASSWORD": P12_PASSWORD,
    }
    log = tmp_path / "uvicorn.log"
    with log.open("w", encoding="utf-8") as sink:
        done = subprocess.run(  # noqa: S603
            [sys.executable, "-m", "uvicorn", "tsa_app:app", "--port", str(port)],
            cwd=WIRE,
            env=env,
            stdout=sink,
            stderr=subprocess.STDOUT,
            timeout=120,
            check=False,
        )
    text = log.read_text(encoding="utf-8")
    assert done.returncode != 0
    assert "pkcs12_file" in text
    assert P12_PASSWORD not in text
    with pytest.raises(OSError, match=r"(?i)refused|connect"):
        socket.create_connection(("127.0.0.1", port), timeout=1).close()
