"""The forms and assets wire gate: `datum-host-check --capabilities forms,assets` against `tests/wire/app.py` under
uvicorn.

Needs node, the built kit (`npm run build` in packages/conformance-suite), uvicorn and the real engine; skipped with a
reason when any is missing. Serial: the boot is a subprocess.
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
from collections.abc import Iterator
from pathlib import Path

import pytest

pytestmark = [pytest.mark.server, pytest.mark.runtime]

WIRE = Path(__file__).resolve().parent
REPO = WIRE.parents[5]
KIT = REPO / "packages" / "conformance-suite"
CLI = KIT / "bin" / "datum-host-check.mjs"
BUILT = KIT / "dist" / "host-check.mjs"


def skip_reason() -> str | None:
    if shutil.which("node") is None:
        return "node is not installed"
    if importlib.util.find_spec("uvicorn") is None:
        return "uvicorn is not installed"
    if not CLI.is_file() or not BUILT.is_file():
        return "the conformance kit is not built (npm run build in packages/conformance-suite)"
    return None


REASON = skip_reason()
needs_kit = pytest.mark.skipif(REASON is not None, reason=REASON or "")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def kit(*args: str, timeout: float = 300) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        ["node", str(CLI), *args],  # noqa: S607
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


@pytest.fixture(scope="module")
def fixture_form(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("host-check-fixtures")
    done = kit("fixtures", "--out", str(out))
    assert done.returncode == 0, done.stdout + done.stderr
    return out / "fixture-form.json"


@contextlib.contextmanager
def boot(fixture_form: Path, *, builder: bool, log: Path) -> Iterator[int]:
    port = free_port()
    env = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_WEB__API__ENDPOINTS__DEFINITION": "true",
        "DATUM_WEB__ASSETS__ENABLED": "true",
        "DATUM_FORMS__LOCATIONS": json.dumps([str(fixture_form)]),
        "DATUM_BUILDER__ENABLED": "true" if builder else "false",
        # the kit's address limit, as every host running the kit sets it (FLD-02 is in test_wire_submissions.py)
        "DATUM_WEB__THROTTLE__ADDRESS_LIMIT": "200",
    }
    command = [sys.executable, "-m", "uvicorn", "app:app", "--port", str(port), "--log-level", "warning"]
    with log.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(command, cwd=WIRE, env=env, stdout=sink, stderr=subprocess.STDOUT)  # noqa: S603
        try:
            deadline = time.monotonic() + 90
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


@needs_kit
def test_the_forms_and_assets_cases_pass_with_the_builder_off(fixture_form: Path, tmp_path: Path) -> None:
    out = tmp_path / "report"
    with boot(fixture_form, builder=False, log=tmp_path / "uvicorn.log") as port:
        done = kit("--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "forms,assets", "--out", str(out))
        assert done.returncode == 0, done.stdout + done.stderr
        statuses = {
            result["id"]: result["status"] for result in json.loads((out / "report.json").read_text())["results"]
        }
        for case in ("FRM-01", "FRM-02", "FRM-03", "FRM-04", "AST-01", "AST-02", "AST-03", "AST-04", "AST-05"):
            assert statuses.get(case) == "PASS", (case, statuses.get(case))


@needs_kit
def test_the_builder_on_branch_of_ast_04_passes_with_builder_enabled(fixture_form: Path, tmp_path: Path) -> None:
    out = tmp_path / "report"
    with boot(fixture_form, builder=True, log=tmp_path / "uvicorn.log") as port:
        done = kit(
            "--endpoint", f"http://127.0.0.1:{port}", "--capabilities", "assets", "--builder-enabled", "--out", str(out)
        )
        assert done.returncode == 0, done.stdout + done.stderr
        assert "AST-04" in report_text(done, out)
