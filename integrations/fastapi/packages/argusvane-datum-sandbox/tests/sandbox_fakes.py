"""A fake `GuestRuntime` that speaks the sandbox protocol from the outside, for the lifecycle and diagnostics tests.

It reads the nonce from stdin, tells the inspect entry from the run entry by the run script, and answers the ABI probe,
the smoke run and a validation as the real program would, framed with the nonce. An input holding `TRAP-ME` traps
after the started marker, `LOOP-ME` ends as the time budget, and one holding `BAD-FRAME` writes outside the frame;
`fail_with` makes the next run raise instead of running.
"""

import json
import threading
from dataclasses import dataclass, field

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import APP_RUN_SCRIPT, marker
from datum_sandbox.wasi import EngineInfo, GuestRun, RunEnd, RunResult, RunTimings

SECRET: str = "ANSWER-MARKER-7f3c"
"""A value tests put in the answers to prove it never reaches a trace line."""


@dataclass
class FakeRuntime:
    """A protocol-speaking fake engine; it records every run it was given."""

    pools: frozenset[str] = frozenset({"validation"})
    runs: list[GuestRun] = field(default_factory=list[GuestRun])
    fail_with: Exception | None = None
    closed: int = 0
    gate: threading.Event | None = None
    """When set, a validation waits on it before it answers (holds its slot)."""
    lock: threading.Lock = field(default_factory=threading.Lock)

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="fake", release="1.0", mode="test", notes=("fake engine",))

    def close(self) -> None:
        self.closed += 1

    def run(self, job: GuestRun, /) -> RunResult:
        with self.lock:
            self.runs.append(job)
        if self.fail_with is not None:
            error, self.fail_with = self.fail_with, None
            raise error
        script = job.app_files[APP_RUN_SCRIPT].decode("utf-8")
        nonce = job.stdin[:32]
        body = job.stdin[33:].decode("utf-8")
        started = marker(nonce.decode("ascii"), "started") + b"\n"
        timings = RunTimings(0.001, 0.002, 0.003, 0.004) if job.timed else None
        if "__datum_inspect" in script:
            answer = json.dumps({"ok": True, "op": json.loads(body).get("op", "inspect"), "structure": [],
                                 "structureWarnings": []}).encode()  # fmt: skip
        elif "TRAP-ME" in body:
            return RunResult(RunEnd.TRAP, started, b"trap!", timings=timings, elapsed=0.01)
        elif "LOOP-ME" in body:
            return RunResult(RunEnd.BUDGET, started, b"", timings=timings, elapsed=job.budget.wall_seconds)
        else:
            if self.gate is not None:
                self.gate.wait(10)
            context = json.loads(body)
            values = context.get("values", {})
            errors = [] if values.get("name") else [{"code": "required", "componentId": "name"}]
            answer = json.dumps({"errors": errors, "values": values}).encode()
        frame = started + marker(nonce.decode("ascii"), "begin") + b"\n" + answer + b"\n"
        frame += marker(nonce.decode("ascii"), "end") + b"\n"
        if "BAD-FRAME" in body:
            frame += b"stray\n"
        return RunResult(RunEnd.CLEAN, frame, b"", timings=timings, elapsed=0.01)


def context(name: str = "Ada", **extra: JsonValue) -> dict[str, JsonValue]:
    """A validation context over the one-field form the smoke run uses."""
    return {
        "formId": "f",
        "form": {
            "id": "root",
            "type": "form",
            "configuration": {},
            "children": {"content": [{"id": "name", "type": "text", "configuration": {"required": True}}]},
        },
        "values": {"name": name, **extra},
        "locale": "en",
    }
