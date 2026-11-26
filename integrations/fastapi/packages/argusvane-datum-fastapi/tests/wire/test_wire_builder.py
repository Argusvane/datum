"""The builder wire gate: the conformance kit against `builder_app.py` under uvicorn.

Boot D: `datum-host-check --capabilities forms,assets,builder --builder-enabled --build-form datum-security-suite
--person-header X-Persona=person --other-person-header X-Persona=other` (BLD-01..04, with FRM-01..03 and AST-01..05 as
regressions: the public copy stays redacted while the author's route is claimed, the builder files follow the switch).
The second boot has the builder off: AST-04's builder-off branch passes and a save is the application's 404. Each boot
is fresh (BLD writes the stored fixture; the repository is memory), with no CSRF middleware and no `--csrf`.

Needs node, the built kit, uvicorn and the real engine; skipped with a reason when any is missing. Serial: the boot is a
subprocess (markers `server` and `runtime`).
"""

import contextlib
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
from collections.abc import Iterator
from pathlib import Path

import pytest

pytestmark = [pytest.mark.server, pytest.mark.runtime]

WIRE = Path(__file__).resolve().parent
REPO = WIRE.parents[5]
KIT = REPO / "packages" / "conformance-suite"
HOST_CHECK = KIT / "bin" / "datum-host-check.mjs"
BUILT = (KIT / "dist" / "host-check.mjs", KIT / "dist" / "cli.mjs")
FORM = "datum-security-suite"
PERSONAS = ("--person-header", "X-Persona=person", "--other-person-header", "X-Persona=other")


def skip_reason() -> str | None:
    if shutil.which("node") is None:
        return "node is not installed"
    if importlib.util.find_spec("uvicorn") is None:
        return "uvicorn is not installed"
    if importlib.util.find_spec("datum_sandbox_wasmtime") is None:
        return "no engine is installed (argusvane-datum-sandbox-wasmtime)"
    if not HOST_CHECK.is_file() or not all(path.is_file() for path in BUILT):
        return "the conformance kit is not built (npm run build in packages/conformance-suite)"
    return None


REASON = skip_reason()
needs_kit = pytest.mark.skipif(REASON is not None, reason=REASON or "")


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


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("host-check-fixtures")
    done = kit("fixtures", "--out", str(out))
    assert done.returncode == 0, done.stdout + done.stderr
    return out


@contextlib.contextmanager
def boot(fixtures: Path, log: Path, *, builder: bool) -> Iterator[int]:
    port = free_port()
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_FORMS__LOCATIONS": json.dumps([str(fixtures / "fixture-form.json")]),
        "DATUM_WEB__API__ENDPOINTS__DEFINITION": "true",
        "DATUM_WEB__ASSETS__ENABLED": "true",
        "DATUM_BUILDER__ENABLED": "true" if builder else "false",
    }
    command = [sys.executable, "-m", "uvicorn", "builder_app:app", "--port", str(port), "--log-level", "warning"]
    with log.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(command, cwd=WIRE, env=environment, stdout=sink, stderr=subprocess.STDOUT)  # noqa: S603
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
    """The report has a row for `case` whose status column is PASS (a SKIP or XFAIL row does not count).

    Rows read `| <id> | <title> | <status> | <expected> | <observed> | <ms> |` (cells may hold escaped pipes,
    so only the first three cells are read); the kit's exit code is asserted beside it.
    """
    return re.search(rf"^\|\s*{re.escape(case)}\s*\|[^|]*\|\s*PASS\s*\|", text, re.MULTILINE) is not None


def request(
    port: int, method: str, path: str, *, persona: str | None = "person", body: bytes = b"{}"
) -> tuple[int, bytes]:
    headers = {"Content-Type": "application/json"}
    if persona is not None:
        headers["X-Persona"] = persona
    call = urllib.request.Request(
        f"http://127.0.0.1:{port}{path}",
        data=body if method in {"PUT", "POST"} else None,
        method=method,
        headers=headers,
    )
    try:
        with urllib.request.urlopen(call, timeout=30) as reply:  # noqa: S310
            return reply.status, reply.read()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read()


@needs_kit
def test_boot_d_the_builder_cases_pass_with_the_forms_and_assets_regressions(fixtures: Path, tmp_path: Path) -> None:
    out = tmp_path / "report"
    with boot(fixtures, tmp_path / "uvicorn.log", builder=True) as port:
        done = kit(
            "--endpoint",
            f"http://127.0.0.1:{port}",
            "--capabilities",
            "forms,assets,builder",
            "--builder-enabled",
            "--build-form",
            FORM,
            *PERSONAS,
            "--out",
            str(out),
        )
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
    for case in (
        "BLD-01",
        "BLD-02",
        "BLD-03",
        "BLD-04",
        "FRM-01",
        "FRM-02",
        "FRM-03",
        "AST-01",
        "AST-02",
        "AST-03",
        "AST-04",
        "AST-05",
    ):
        assert passed(text, case), case


@needs_kit
def test_boot_d_a_visitor_and_another_person_are_refused_before_the_form_is_read(
    fixtures: Path, tmp_path: Path
) -> None:
    with boot(fixtures, tmp_path / "uvicorn.log", builder=True) as port:
        for method, path in (
            ("PUT", f"/api/forms/{FORM}"),
            ("POST", "/api/forms"),
            ("PUT", f"/api/forms/{FORM}/translations"),
        ):
            assert request(port, method, path, persona=None)[0] == 401, (method, path)
            assert request(port, method, path, persona="other")[0] == 403, (method, path)
        assert request(port, "GET", f"/api/forms/{FORM}/definition?public=false", persona=None)[0] == 401
        status, body = request(port, "GET", f"/api/forms/{FORM}/definition?public=false", persona="person")
        assert status == 200
        assert b"server-secret" in body


@needs_kit
def test_the_builder_off_boot_passes_ast_04s_builder_off_branch_and_a_save_is_the_applications_404(
    fixtures: Path, tmp_path: Path
) -> None:
    out = tmp_path / "report"
    with boot(fixtures, tmp_path / "uvicorn.log", builder=False) as port:
        done = kit("--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "forms,assets", "--out", str(out))
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
        for case in ("AST-01", "AST-04", "AST-05"):
            assert passed(text, case), case
        assert request(port, "PUT", f"/api/forms/{FORM}", persona=None)[0] == 404
        status, body = request(port, "PUT", f"/api/forms/{FORM}")
        assert status == 404
        assert json.loads(body) == {"detail": "Not Found"}
        assert request(port, "POST", "/api/forms")[0] == 404
        assert request(port, "GET", f"/api/forms/{FORM}/definition?public=false")[0] == 404


def test_the_builder_wire_application_names_no_global_handler_or_middleware_and_no_other_host() -> None:
    text = (WIRE / "builder_app.py").read_text(encoding="utf-8")
    assert "add_middleware" not in text
    assert "add_exception_handler" not in text
    assert "app.state" not in text
