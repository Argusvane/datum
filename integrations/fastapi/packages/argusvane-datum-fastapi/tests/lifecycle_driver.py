"""Drives uvicorn through the lifecycle scenarios : one subprocess per scenario."""

import os
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
HEADERS = {"x-a": "1", "x-b-key": "k"}
MAIN = "/api/forms/contact/definition"


def named(prefix: str) -> str:
    """The definition path of a router made with `prefix` (its paths sit directly under it)."""
    return f"{prefix}/forms/contact/definition"


@dataclass
class Outcome:
    """What one scenario saw."""

    listening: bool = False
    exit_code: int | str | None = None
    events: list[str] = field(default_factory=list)
    stderr: str = ""
    responses: dict[str, tuple[int, str]] = field(default_factory=dict)


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def get(port: int, path: str, headers: dict[str, str] | None = None) -> tuple[int, str]:
    request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", headers=headers or {})
    try:
        with urllib.request.urlopen(request, timeout=20) as reply:  # noqa: S310
            return int(reply.status), reply.read().decode()
    except urllib.error.HTTPError as error:
        with error:
            return error.code, error.read().decode()


def run_scenario(
    log_dir: Path,
    name: str,
    *,
    extra_args: tuple[str, ...] = (),
    env_extra: dict[str, str] | None = None,
    requests: tuple[tuple[str, str, dict[str, str] | None], ...] = (),
    stop_with: signal.Signals = signal.SIGTERM,
    app: str = "lifecycle_app:app",
) -> Outcome:
    events_file, stderr_file = log_dir / f"{name}.events", log_dir / f"{name}.stderr"
    for file in (events_file, stderr_file):
        file.unlink(missing_ok=True)
    port = free_port()
    env = {
        **os.environ,
        "DATUM_EVENT_LOG": str(events_file),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH", "")])),
        **(env_extra or {}),
    }
    command = [sys.executable, "-m", "uvicorn", app, "--port", str(port), "--log-level", "info", *extra_args]
    outcome = Outcome()
    with stderr_file.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(command, cwd=HERE, env=env, stdout=sink, stderr=subprocess.STDOUT)  # noqa: S603
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and process.poll() is None:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                outcome.listening = True
                break
            except OSError:
                time.sleep(0.1)
        if outcome.listening:
            for label, path, headers in requests:
                outcome.responses[label] = get(port, path, headers)
            process.send_signal(stop_with)
        try:
            outcome.exit_code = process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()
            outcome.exit_code = "killed after 60 s"
    outcome.events = events_file.read_text(encoding="utf-8").splitlines() if events_file.exists() else []
    outcome.stderr = stderr_file.read_text(encoding="utf-8")
    return outcome


def _get_in_background(port: int, path: str, sink: dict[str, tuple[int, str] | str]) -> threading.Thread:
    def fetch() -> None:
        try:
            sink["reply"] = get(port, path)
        except OSError as error:  # the server closed the connection: the answer was discarded
            sink["reply"] = type(error).__name__

    thread = threading.Thread(target=fetch, daemon=True)
    thread.start()
    return thread


def run_shutdown_scenario(
    log_dir: Path,
    name: str,
    *,
    path: str,
    extra_args: tuple[str, ...] = (),
    env_extra: dict[str, str] | None = None,
    app: str = "shutdown_app:app",
) -> Outcome:
    """Start uvicorn, send one request, SIGTERM the server once the request's work has started, collect what happened.

    The reply (status and body, or the name of the connection error) is `responses["request"]`.
    """
    events_file, stderr_file = log_dir / f"{name}.events", log_dir / f"{name}.stderr"
    for file in (events_file, stderr_file):
        file.unlink(missing_ok=True)
    port = free_port()
    env = {
        **os.environ,
        "DATUM_EVENT_LOG": str(events_file),
        "PYTHONPATH": os.pathsep.join(filter(None, [str(HERE), os.environ.get("PYTHONPATH", "")])),
        **(env_extra or {}),
    }
    command = [sys.executable, "-m", "uvicorn", app, "--port", str(port), "--log-level", "info", *extra_args]
    outcome = Outcome()
    sink: dict[str, tuple[int, str] | str] = {}
    with stderr_file.open("w", encoding="utf-8") as stream:
        process = subprocess.Popen(command, cwd=HERE, env=env, stdout=stream, stderr=subprocess.STDOUT)  # noqa: S603
        deadline = time.monotonic() + 60
        while time.monotonic() < deadline and process.poll() is None:
            try:
                socket.create_connection(("127.0.0.1", port), timeout=1).close()
                outcome.listening = True
                break
            except OSError:
                time.sleep(0.1)
        if outcome.listening:
            fetching = _get_in_background(port, path, sink)
            started = time.monotonic() + 30
            while time.monotonic() < started and "effect start" not in _lines(events_file):
                time.sleep(0.05)
            process.send_signal(signal.SIGTERM)
            fetching.join(60)
        try:
            outcome.exit_code = process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            process.kill()
            outcome.exit_code = "killed after 60 s"
    reply = sink.get("reply")
    if isinstance(reply, tuple):
        outcome.responses["request"] = reply
    elif reply is not None:
        outcome.responses["request"] = (0, reply)
    outcome.events = _lines(events_file)
    outcome.stderr = stderr_file.read_text(encoding="utf-8")
    return outcome


def _lines(path: Path) -> list[str]:
    return path.read_text(encoding="utf-8").splitlines() if path.exists() else []
