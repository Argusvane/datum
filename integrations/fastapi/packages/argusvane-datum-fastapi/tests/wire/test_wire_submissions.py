"""The submissions wire gate: the conformance kit against `submissions_app.py` and `hardening_app.py` under uvicorn.

Boot A: `datum-host-check --capabilities submissions,submissions-test,flood` (SUB-01..06, DRY-01, FLD-01, FLD-02), the
per-form limit at 30 so FLD-01 can exceed it and the address limit at the kit's 200 (`KIT_ADDRESS_LIMIT`): above the
body posts of the whole run before FLD-02, below FLD-02's 400 bodies that do not parse. Boot B:
`datum-security-check --endpoint` (the receiving profile: REC-01..16, SEC-05, the never-5xx rule), the per-form limit
raised and the address limit off so nothing is refused for flooding. Boot C: `--capabilities hardening`
against the hardening application (HRD-01..04: the loop stopped inside the budget, the memory bomb, the 40 MiB answer
capped, stray bytes refused, the next CTL-01 still 200). Each boot is fresh: the flood case spends the throttle.

Needs node, the built kit, uvicorn and the real engine; skipped with a reason when any is missing. Serial: the boot is a
subprocess (markers `server` and `runtime`).
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
HOST_CHECK = KIT / "bin" / "datum-host-check.mjs"
SECURITY_CHECK = KIT / "bin" / "datum-security-check.mjs"
BUILT = (KIT / "dist" / "host-check.mjs", KIT / "dist" / "cli.mjs")
FORM = "datum-security-suite"
KIT_ADDRESS_LIMIT = "200"
"""The address limit a host running the kit sets (`datum.web.throttle.address_limit`)."""
FLOOD_OFF = {"DATUM_WEB__THROTTLE__LIMIT": "100000", "DATUM_WEB__THROTTLE__ADDRESS_LIMIT": "off"}


def skip_reason() -> str | None:
    if shutil.which("node") is None:
        return "node is not installed"
    if importlib.util.find_spec("uvicorn") is None:
        return "uvicorn is not installed"
    if importlib.util.find_spec("datum_sandbox_wasmtime") is None:
        return "no engine is installed (argusvane-datum-sandbox-wasmtime)"
    if not all(path.is_file() for path in (HOST_CHECK, SECURITY_CHECK, *BUILT)):
        return "the conformance kit is not built (npm run build in packages/conformance-suite)"
    return None


REASON = skip_reason()
needs_kit = pytest.mark.skipif(REASON is not None, reason=REASON or "")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def kit(cli: Path, *args: str, timeout: float = 600) -> subprocess.CompletedProcess[str]:
    return subprocess.run(  # noqa: S603
        ["node", str(cli), *args],  # noqa: S607
        cwd=REPO,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


@pytest.fixture(scope="module")
def fixtures(tmp_path_factory: pytest.TempPathFactory) -> Path:
    out = tmp_path_factory.mktemp("host-check-fixtures")
    done = kit(HOST_CHECK, "fixtures", "--out", str(out))
    assert done.returncode == 0, done.stdout + done.stderr
    return out


@contextlib.contextmanager
def boot(module: str, fixtures: Path, log: Path, **env: str) -> Iterator[int]:
    port = free_port()
    environment = {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(WIRE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_FORMS__LOCATIONS": json.dumps([str(fixtures / "fixture-form.json")]),
        "DATUM_WEB__API__ENDPOINTS__SUBMISSIONS": "true",
        "DATUM_WEB__API__ENDPOINTS__VALIDATE": "true",
        "DATUM_WEB__API__ENDPOINTS__TEST": "true",
        "DATUM_WEB__API__ENDPOINTS__DEFINITION": "true",
        "WIRE_HARDENING_RULES": str(fixtures / "hardening-rules.js"),
        **env,
    }
    command = [sys.executable, "-m", "uvicorn", f"{module}:app", "--port", str(port), "--log-level", "warning"]
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


def statuses_of(out: Path) -> dict[str, str]:
    return {result["id"]: result["status"] for result in json.loads((out / "report.json").read_text())["results"]}


def report_text(done: subprocess.CompletedProcess[str], out: Path) -> str:
    parts = [done.stdout, done.stderr]
    parts += [p.read_text(encoding="utf-8", errors="replace") for p in sorted(out.rglob("*")) if p.is_file()]
    return "\n".join(parts)


@needs_kit
def test_boot_a_the_submissions_dry_run_and_flood_cases_pass(fixtures: Path, tmp_path: Path) -> None:
    out = tmp_path / "report"
    env = {"DATUM_WEB__THROTTLE__LIMIT": "30", "DATUM_WEB__THROTTLE__ADDRESS_LIMIT": KIT_ADDRESS_LIMIT}
    with boot("submissions_app", fixtures, tmp_path / "uvicorn.log", **env) as port:
        done = kit(
            HOST_CHECK,
            "--endpoint",
            f"http://127.0.0.1:{port}",
            "--capabilities",
            "submissions,submissions-test,flood",
            "--out",
            str(out),
        )
        assert done.returncode == 0, done.stdout + done.stderr
        statuses = statuses_of(out)
    for case in ("SUB-01", "SUB-02", "SUB-03", "SUB-04", "SUB-05", "SUB-06", "DRY-01", "FLD-01", "FLD-02"):
        assert statuses.get(case) == "PASS", (case, statuses.get(case))


@needs_kit
def test_boot_b_the_security_suites_submissions_profile_passes_with_the_throttle_raised_and_the_address_limit_off(
    fixtures: Path, tmp_path: Path
) -> None:
    out = tmp_path / "report"
    with boot("submissions_app", fixtures, tmp_path / "uvicorn.log", **FLOOD_OFF) as port:
        done = kit(
            SECURITY_CHECK,
            "--endpoint",
            f"http://127.0.0.1:{port}",
            "--form",
            FORM,
            "--allow-writes",
            "--i-installed-the-suite-fixture",
            "--out",
            str(out),
        )
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
    assert "REC-01" in text
    assert "SEC-05" in text


@needs_kit
def test_boot_c_the_hardening_cases_pass_against_the_hostile_rules_in_a_test_deployment(
    fixtures: Path, tmp_path: Path
) -> None:
    out = tmp_path / "report"
    env = {"DATUM_RUNTIME__VALIDATION__MEMORY": "512MiB", **FLOOD_OFF}
    with boot("hardening_app", fixtures, tmp_path / "uvicorn.log", **env) as port:
        done = kit(
            HOST_CHECK,
            "--endpoint",
            f"http://127.0.0.1:{port}",
            "--capabilities",
            "hardening",
            "--out",
            str(out),
        )
        assert done.returncode == 0, done.stdout + done.stderr
        text = report_text(done, out)
    for case in ("HRD-01", "HRD-02", "HRD-03", "HRD-04"):
        assert case in text, case


def test_the_wire_applications_name_no_global_handler_or_middleware() -> None:
    for name in ("submissions_app.py", "hardening_app.py"):
        text = (WIRE / name).read_text(encoding="utf-8")
        assert "add_middleware" not in text
        assert "add_exception_handler" not in text
