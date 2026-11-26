"""The per-route binding gate: `datum-host-check --capabilities pdf --pdf-bindings` on `bindings_app.py`.

Two routes on one host (the kit's fixture form `datum-security-suite` and its copy `datum-security-suite-b`) are drawn
by different bindings (`DATUM_BINDINGS__ROUTES`), the second a binding the host registers (`DATUM_BINDINGS__CATALOG`)
with the kit's PDF theme `datum-host-check-pdf`, whose object the host supplies from the kit's `fixture-pdf-theme.json`
(`DATUM_BINDINGS__PDF_THEMES`). PDF-06 reads `host.json`'s bindings table and holds each route's PDF to its catalog PDF
theme, named in `X-Datum-Pdf-Theme` and drawn into the PDF (the theme's text colour in the content streams); the PDF
program is the real one. A host that names the theme but drops its object fails the case. A binding the catalog does not
list stops the start.

Needs node, the built kit, uvicorn and the real engine; skipped with a reason when any is missing. Serial: the boot is
a subprocess.
"""

import contextlib
import importlib.util
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.request
from collections.abc import Generator
from pathlib import Path

import pytest

pytestmark = [pytest.mark.server, pytest.mark.runtime]

WIRE = Path(__file__).resolve().parent
REPO = WIRE.parents[5]
KIT = REPO / "packages" / "conformance-suite"
HOST_CHECK = KIT / "bin" / "datum-host-check.mjs"
BUILT = KIT / "dist" / "host-check.mjs"
THEME = "datum-host-check-pdf"


def skip_reason() -> str | None:
    if shutil.which("node") is None:
        return "node is not installed"
    if importlib.util.find_spec("uvicorn") is None:
        return "uvicorn is not installed"
    if importlib.util.find_spec("datum_sandbox_wasmtime") is None:
        return "no engine is installed (argusvane-datum-sandbox-wasmtime)"
    if not HOST_CHECK.is_file() or not BUILT.is_file():
        return "the conformance kit is not built (npm run build in packages/conformance-suite)"
    return None


REASON = skip_reason()
needs_kit = pytest.mark.skipif(REASON is not None, reason=REASON or "")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def kit(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        ["node", str(HOST_CHECK), *args],  # noqa: S607
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("host-check-fixtures")
    done = kit("fixtures", "--out", str(out))
    assert done.returncode == 0, done.stdout + done.stderr
    return out


def environment(fixtures: Path, **more: str) -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_FORMS__LOCATIONS": json.dumps(
            [str(fixtures / "fixture-form.json"), str(fixtures / "fixture-form-b.json")]
        ),
        "DATUM_WEB__API__ENDPOINTS__PDF": "true",
        "DATUM_WEB__API__ENDPOINTS__VERIFY": "true",
        "DATUM_WEB__API__ENDPOINTS__DEFINITION": "true",
        "DATUM_WEB__ASSETS__ENABLED": "true",
        "DATUM_BINDINGS__ROUTES": json.dumps({"datum-security-suite-b": "ledger-binding"}),
        "DATUM_BINDINGS__CATALOG": json.dumps({"ledger-binding": {"label": "Ledger", "pdf_theme": THEME}}),
        "DATUM_BINDINGS__PDF_THEMES": json.dumps({THEME: str(fixtures / "fixture-pdf-theme.json")}),
        **more,
    }


@contextlib.contextmanager
def boot(log: Path, env: dict[str, str]) -> Generator[int]:
    port = free_port()
    command = [sys.executable, "-m", "uvicorn", "bindings_app:app", "--port", str(port), "--log-level", "warning"]
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


@needs_kit
def test_two_routes_on_one_host_get_each_routes_catalog_pdf_theme(fixtures: Path, tmp_path: Path) -> None:
    with boot(tmp_path / "uvicorn.log", environment(fixtures)) as port:
        done = kit(
            "--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"
        )
        assert done.returncode == 0, done.stdout + done.stderr
        assert "PASS PDF-06" in done.stdout, done.stdout
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/datum/assets/host.json", timeout=30) as reply:
            table = json.loads(reply.read())["bindings"]
        assert table["default"] == "datum"
        assert table["routes"] == {"datum-security-suite-b": "ledger-binding"}
        assert {"id": "ledger-binding", "label": "Ledger", "pdfTheme": THEME} in table["catalog"]


@needs_kit
def test_a_host_that_names_the_theme_but_never_prints_under_it_fails(fixtures: Path, tmp_path: Path) -> None:
    with boot(tmp_path / "uvicorn.log", environment(fixtures, DATUM_TEST_DROP_PDF_THEME="1")) as port:
        done = kit(
            "--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "pdf", "--pdf-bindings", "--only", "PDF-06"
        )
    assert done.returncode == 1, done.stdout + done.stderr
    assert "FAIL PDF-06" in done.stdout, done.stdout
    assert "is not drawn under datum-host-check-pdf" in done.stdout, done.stdout


@needs_kit
def test_without_the_switch_the_case_is_skipped_never_passed(fixtures: Path, tmp_path: Path) -> None:
    with boot(tmp_path / "uvicorn.log", environment(fixtures)) as port:
        done = kit("--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "pdf", "--only", "PDF-06")
        assert "SKIP PDF-06" in done.stdout, done.stdout + done.stderr


@needs_kit
def test_a_binding_the_catalog_does_not_list_stops_the_start(fixtures: Path, tmp_path: Path) -> None:
    env = environment(fixtures, DATUM_BINDINGS__DEFAULT="nope")
    with pytest.raises(AssertionError, match="nope"), boot(tmp_path / "uvicorn.log", env):
        pass
