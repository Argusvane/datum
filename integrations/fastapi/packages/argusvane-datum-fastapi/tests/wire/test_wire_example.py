"""The submissions example is proven: it passes the kit under uvicorn, and its consumer keeps and dead-letters.

The server test boots `examples/submissions/app.py` with the README's environment plus the validate switch, a per-form
limit of 30 and the kit's address limit of 200, and runs `datum-host-check --capabilities submissions,flood` (FLD-01
spends the per-form limit, FLD-02 the address limit). The runtime test runs the
consumer's `main()` in a subprocess (so the example's module state is fresh) and reads its log lines.
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

WIRE = Path(__file__).resolve().parent
REPO = WIRE.parents[5]
EXAMPLE = WIRE.parents[3] / "examples" / "submissions"
KIT = REPO / "packages" / "conformance-suite"
HOST_CHECK = KIT / "bin" / "datum-host-check.mjs"
BUILT = KIT / "dist" / "host-check.mjs"


def engine_reason() -> str | None:
    if importlib.util.find_spec("datum_sandbox_wasmtime") is None:
        return "no engine is installed (argusvane-datum-sandbox-wasmtime)"
    return None


def kit_reason() -> str | None:
    if shutil.which("node") is None:
        return "node is not installed"
    if importlib.util.find_spec("uvicorn") is None:
        return "uvicorn is not installed"
    if not HOST_CHECK.is_file() or not BUILT.is_file():
        return "the conformance kit is not built (npm run build in packages/conformance-suite)"
    return engine_reason()


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def example_env() -> dict[str, str]:
    return {
        **os.environ,
        "PYTHONPATH": os.pathsep.join(filter(None, [str(EXAMPLE), os.environ.get("PYTHONPATH", "")])),
        "DATUM_FORMS__LOCATIONS": json.dumps([str(EXAMPLE / "forms" / "fixture-form.json")]),
        "DATUM_WEB__API__ENDPOINTS__SUBMISSIONS": "true",
        "DATUM_WEB__API__ENDPOINTS__DEFINITION": "true",
    }


@contextlib.contextmanager
def boot(log: Path) -> Iterator[int]:
    port = free_port()
    env = {
        **example_env(),
        "DATUM_WEB__API__ENDPOINTS__VALIDATE": "true",
        "DATUM_WEB__THROTTLE__LIMIT": "30",
        "DATUM_WEB__THROTTLE__ADDRESS_LIMIT": "200",
    }
    command = [sys.executable, "-m", "uvicorn", "app:app", "--port", str(port), "--log-level", "warning"]
    with log.open("w", encoding="utf-8") as sink:
        process = subprocess.Popen(command, cwd=EXAMPLE, env=env, stdout=sink, stderr=subprocess.STDOUT)  # noqa: S603
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
                pytest.fail("the example never listened")
            yield port
        finally:
            process.send_signal(signal.SIGTERM)
            try:
                process.wait(timeout=30)
            except subprocess.TimeoutExpired:
                process.kill()


@pytest.mark.server
@pytest.mark.runtime
@pytest.mark.skipif(kit_reason() is not None, reason=kit_reason() or "")
def test_the_example_application_passes_the_kits_submissions_and_flood_cases(tmp_path: Path) -> None:
    out = tmp_path / "report"
    with boot(tmp_path / "uvicorn.log") as port:
        done = subprocess.run(  # noqa: S603
            [  # noqa: S607
                "node",
                str(HOST_CHECK),
                "--endpoint",
                f"http://127.0.0.1:{port}",
                "--capabilities",
                "submissions,flood",
                "--out",
                str(out),
            ],
            cwd=REPO,
            capture_output=True,
            text=True,
            timeout=600,
            check=False,
        )
    assert done.returncode == 0, done.stdout + done.stderr
    statuses = {result["id"]: result["status"] for result in json.loads((out / "report.json").read_text())["results"]}
    assert (statuses.get("FLD-01"), statuses.get("FLD-02")) == ("PASS", "PASS")


@pytest.mark.runtime
@pytest.mark.skipif(engine_reason() is not None, reason=engine_reason() or "")
def test_the_consumer_keeps_one_submission_answers_its_redelivery_and_dead_letters_the_non_json_message() -> None:
    done = subprocess.run(
        [sys.executable, "consumer.py"],
        cwd=EXAMPLE,
        env=example_env(),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    log = done.stdout + done.stderr
    assert done.returncode == 0, log
    assert "consumed a message: Accepted" in log, log
    # The broker delivers the first message again under its id: the same submit attempt, the first receipt.
    assert "consumed a message: Redelivered" in log, log
    assert "dead-lettered a message that is not a JSON submission" in log, log
    assert "done: 1 submission(s) kept" in log, log


def test_the_example_has_no_asset_route() -> None:
    script = "import json, app; print(json.dumps(app.app.openapi()))"
    done = subprocess.run(  # noqa: S603
        [sys.executable, "-c", script],
        cwd=EXAMPLE,
        env=example_env(),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    assert done.returncode == 0, done.stdout + done.stderr
    schema = json.loads(done.stdout.strip().splitlines()[-1])
    tags = {
        tag for path in schema["paths"].values() for operation in path.values() for tag in operation.get("tags", [])
    }
    assert "datum-assets" not in tags, tags
    assert not [path for path in schema["paths"] if "/assets" in path], list(schema["paths"])


REQUEUE_SCRIPT = """
import asyncio, types
import consumer
from datum_core.submissions import Unavailable

import time

calls = []
keys = []

async def submit(form, document, context):
    calls.append(time.monotonic())
    keys.append(context.submission_key)
    return Unavailable(code="unavailable", reason="the runtime is down")

real = consumer.datum
consumer.datum = types.SimpleNamespace(config=real.config, async_submissions=types.SimpleNamespace(submit=submit))

async def run():
    import logging
    logging.basicConfig(level=logging.INFO)
    queue = asyncio.Queue()
    message_id, body = consumer.SAMPLE_MESSAGES[0]
    queue.put_nowait((message_id, body, 1))
    worker = asyncio.create_task(consumer.consume(queue))
    await asyncio.wait_for(queue.join(), 5)
    worker.cancel()
    gaps = [round(later - earlier, 3) for earlier, later in zip(calls, calls[1:])]
    print("CALLS=%d MAX=%d BACKOFF=%s GAPS=%s" % (len(calls), consumer.MAX_ATTEMPTS, consumer.BACKOFF, gaps))
    print("KEYS=%s ID=%s" % (sorted(set(keys)), message_id))

asyncio.run(run())
"""


def test_the_consumers_unavailable_requeue_is_bounded() -> None:
    done = subprocess.run(  # noqa: S603
        [sys.executable, "-c", REQUEUE_SCRIPT],
        cwd=EXAMPLE,
        env=example_env(),
        capture_output=True,
        text=True,
        timeout=120,
        check=False,
    )
    log = done.stdout + done.stderr
    assert done.returncode == 0, log
    assert "CALLS=3 MAX=3 BACKOFF=0.1" in log, log
    assert "dead-lettered a message after 3 unavailable deliveries" in log, log
    gaps = json.loads(log.split("GAPS=")[1].splitlines()[0])
    assert len(gaps) == 2, log
    assert gaps[0] >= 0.1 - 0.02, gaps  # a back-off of BACKOFF * attempt: 0.1 s before the second delivery
    assert gaps[1] >= 0.2 - 0.02, gaps  # and 0.2 s before the third: the requeue is never a hot loop
    assert gaps[1] > gaps[0] - 0.02, gaps
    # Every delivery of one message is one submit attempt: the message's id is the key each time.
    message_id = log.split(" ID=")[1].splitlines()[0]
    assert f"KEYS=['{message_id}']" in log, log
