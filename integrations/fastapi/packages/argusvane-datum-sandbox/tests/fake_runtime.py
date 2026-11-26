"""Fake runtimes for the contract kit's own tests: one wrong about everything, one right about a few things.

`FakeGuestRuntime` ends every run cleanly and silently: bound to the contracts it must make them fail (or xfail, for a
declared limit). `ScriptedRuntime` recognises the scripts the kit sends (the output producers, the sandbox run script, a
looping rule) and answers them as a correct engine would; `Faults` then breaks one thing at a time, so a test can show
that the contract notices (one byte stored past the cap, a corrupt prefix, a missing flag, a late end, a leaked
thread, a second frame).
"""

import re
import threading
import time
from dataclasses import dataclass

from datum_sandbox.protocol import marker
from datum_sandbox.testing.runtime_support import LINE_BYTES, STARTED, STDERR_PRODUCER, expected_prefix, program_parts
from datum_sandbox.wasi import EngineInfo, GuestRun, RunBudget, RunEnd, RunResult

_SANDBOX_SCRIPT = "(function (std, print, evaluate) {"
_LINES = re.compile(r"i < (\d+)")


class FakeGuestRuntime:
    """A runtime wrong about everything: every run is a clean end with no output at all."""

    def __init__(self) -> None:
        self.closed = False

    def run(self, job: GuestRun, /) -> RunResult:
        del job
        return RunResult(end=RunEnd.CLEAN, stdout=b"", stderr=b"")

    pools = frozenset({"validation"})  # a validation-only engine: no PDF pool, so the PDF program never runs here

    def engine_info(self) -> EngineInfo:
        return EngineInfo(id="fake", release="0", mode="fake")

    def close(self) -> None:
        self.closed = True


@dataclass(frozen=True, slots=True)
class Faults:
    """One thing to get wrong; the default is a correct engine for the scripts `ScriptedRuntime` knows."""

    overrun: int = 0
    """Bytes stored past the stdout cap."""
    corrupt_prefix: bool = False
    """Flip the last stored byte."""
    no_flag: bool = False
    """Never set `stdout_capped`."""
    clean_end: bool = False
    """End a capped run as CLEAN."""
    late: float = 0.0
    """Seconds an endless producer runs past its wall budget."""
    leak_thread: bool = False
    """Leave one thread behind per run."""
    second_frame: bool = False
    """Print the sandbox frame twice."""
    flag_at_cap: bool = False
    """Treat an output of exactly the cap as capped."""
    noise: bool = False
    """Write to the process's own stdout on a capped run."""


class ScriptedRuntime(FakeGuestRuntime):
    """An engine that is right about the kit's own scripts, with one chosen fault."""

    def __init__(self, faults: Faults = Faults()) -> None:
        super().__init__()
        self.faults = faults
        self.leaked: list[threading.Event] = []

    def run(self, job: GuestRun, /) -> RunResult:
        _, run_script, _, stdin, budget = program_parts(job)
        script = run_script.decode("utf-8")
        if self.faults.leak_thread:
            hold = threading.Event()
            self.leaked.append(hold)
            threading.Thread(target=hold.wait, name="leaked", daemon=True).start()
        if script.startswith(_SANDBOX_SCRIPT):
            return self._sandbox(script, stdin, budget)
        if "for (;;) {}" in script:
            stdout = f"{STARTED}\n".encode() if STARTED in script else b""
            return RunResult(end=RunEnd.BUDGET, stdout=stdout, stderr=b"", elapsed=budget.wall_seconds)
        if script.startswith("var tail"):
            return self._producer(script, budget)
        if script.startswith(STDERR_PRODUCER):
            return self._stderr(budget)
        return RunResult(end=RunEnd.CLEAN, stdout=b"", stderr=b"")

    def _sandbox(self, script: str, stdin: bytes, budget: RunBudget) -> RunResult:
        nonce = stdin[:32].decode("ascii")
        started = marker(nonce, "started")
        if "for (;;) {}" in script:
            return RunResult(end=RunEnd.BUDGET, stdout=started + b"\n", stderr=b"", elapsed=budget.wall_seconds)
        frame = (
            started
            + b"\n"
            + marker(nonce, "begin")
            + b"\n"
            + b'{"errors":[],"values":{"name":"Ada"}}\n'
            + marker(nonce, "end")
            + b"\n"
        )
        return RunResult(end=RunEnd.CLEAN, stdout=frame * (2 if self.faults.second_frame else 1), stderr=b"")

    def _producer(self, script: str, budget: RunBudget) -> RunResult:
        found = _LINES.search(script)
        total = None if found is None else int(found.group(1)) * LINE_BYTES
        cap = budget.stdout_cap
        capped = total is None or total > cap or (self.faults.flag_at_cap and total == cap)
        if total is None:
            time.sleep(budget.wall_seconds * 0.2 + self.faults.late)
        stored = expected_prefix(cap if capped else total or 0)
        if capped and self.faults.overrun:
            stored = expected_prefix(cap + self.faults.overrun)
        if capped and self.faults.corrupt_prefix and stored:
            stored = stored[:-1] + bytes([stored[-1] ^ 1])
        if capped and self.faults.noise:
            print("failed custom output")  # noqa: T201 - the fault is exactly a print on the process's stdout
        flagged = capped and not self.faults.no_flag
        end = RunEnd.OUTPUT_CAP if capped and not self.faults.clean_end else RunEnd.CLEAN
        return RunResult(end=end, stdout=stored, stderr=b"", stdout_capped=flagged, elapsed=budget.wall_seconds)

    def _stderr(self, budget: RunBudget) -> RunResult:
        cap = budget.stderr_cap
        return RunResult(end=RunEnd.OUTPUT_CAP, stdout=b"after\n", stderr=b"y" * cap, stderr_capped=True, elapsed=0.0)
