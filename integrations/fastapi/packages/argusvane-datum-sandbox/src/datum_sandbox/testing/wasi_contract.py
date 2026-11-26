"""`WasiHardeningContract`: an engine held to the generic run's guarantees through `GuestRuntime` and `GuestRun` alone.

No Datum program runs here: each case hands the engine one tiny `run.js` (QuickJS-ng's `qjs --std /app/run.js`) and
reads what came back. The guarantees: the given files and nothing else under a read-only `/app`, no host environment,
stdin as given, the output caps ending the run (with every byte up to the cap returned, never an error the guest can
ignore), the time and memory budgets, the stop at close (`INTERRUPTED`, then `EngineClosedError`), and a run that
refuses a bare string for its arguments and a file name that is not one plain name before any slot is taken.

A binding subclasses it like the other contracts and may set `pool` (the pool its runtime serves for these runs).
"""

# ruff: noqa: S101 - a contract is assertions

import json
import threading
import time
from collections.abc import Callable
from typing import ClassVar

import pytest

from datum_sandbox.testing._base import ContractBase
from datum_sandbox.wasi import EngineClosedError, GuestRun, GuestRuntime, RunBudget, RunEnd, RunResult

_ARGV = ("qjs", "--std", "/app/run.js")
_MIB = 1024 * 1024


class WasiHardeningContract(ContractBase):
    """The generic run's guarantees; every case is one `GuestRun` with an inline script."""

    pool: ClassVar[str] = "validation"
    """The pool the runs of this contract name; the runtime under test serves it."""

    def _budget(self, seconds: float = 10.0, memory_mib: int = 32, *, stdout_cap: int = 1 << 20) -> RunBudget:
        return RunBudget(
            wall_seconds=seconds, memory_bytes=memory_mib * _MIB, stdout_cap=stdout_cap, wait=30.0, pool=self.pool
        )

    def _run(
        self,
        runtime: GuestRuntime,
        script: str,
        *,
        files: dict[str, bytes] | None = None,
        stdin: bytes = b"",
        budget: RunBudget | None = None,
    ) -> RunResult:
        app = {"run.js": script.encode("utf-8"), **(files or {})}
        return runtime.run(GuestRun(app_files=app, argv=_ARGV, stdin=stdin, budget=budget or self._budget()))

    def test_only_the_given_files_are_under_a_read_only_app(self, runtime: GuestRuntime) -> None:
        """The guest lists exactly the run's files, reads them back, and cannot write, create or remove under `/app`."""
        script = """
var names = os.readdir('/app')[0].filter(function (n) { return n !== '.' && n !== '..'; }).sort();
var wrote = std.open('/app/new.txt', 'w');
var appended = std.open('/app/data.txt', 'a');
print(JSON.stringify({names: names, data: std.loadFile('/app/data.txt'), wrote: wrote !== null,
  appended: appended !== null, removed: os.remove('/app/data.txt') === 0, made: os.mkdir('/app/d') === 0,
  outside: std.open('/etc/passwd', 'r') !== null || std.open('/app/../etc/passwd', 'r') !== null}));
"""
        result = self._run(runtime, script, files={"data.txt": b"kept"})
        assert result.end is RunEnd.CLEAN, result.stderr
        answer = json.loads(result.stdout)
        assert answer["names"] == ["data.txt", "run.js"]
        assert answer["data"] == "kept"
        assert not any(answer[key] for key in ("wrote", "appended", "removed", "made", "outside"))

    def test_no_host_environment_and_stdin_as_given(self, runtime: GuestRuntime) -> None:
        """The guest sees no environment variable and reads exactly the bytes it was given on stdin."""
        script = "print(JSON.stringify([std.getenviron(), std.in.readAsString()]));"
        result = self._run(runtime, script, stdin="given é".encode())
        assert result.end is RunEnd.CLEAN, result.stderr
        assert json.loads(result.stdout) == [{}, "given é"]

    def test_the_stdout_cap_ends_the_run_and_keeps_every_byte_up_to_it(self, runtime: GuestRuntime) -> None:
        """Past the cap the run is OUTPUT_CAP and stdout is exactly its first `cap` bytes, whatever the guest did."""
        script = "var line = 'x'.repeat(1023); for (var i = 0; i < 4096; i++) { print(line); }"
        cap = 64 * 1024
        result = self._run(runtime, script, budget=self._budget(stdout_cap=cap))
        assert result.end is RunEnd.OUTPUT_CAP
        assert result.stdout_capped
        assert len(result.stdout) == cap
        assert result.stdout == (b"x" * 1023 + b"\n") * (cap // 1024)

    def test_the_time_budget_stops_a_loop_and_returns_what_it_wrote_first(self, runtime: GuestRuntime) -> None:
        """A loop ends BUDGET within the budget plus the stop grace, and the line it printed first comes back."""
        began = time.monotonic()
        result = self._run(runtime, "print('before'); for (;;) {}", budget=self._budget(seconds=0.5))
        assert result.end is RunEnd.BUDGET
        assert result.stdout.startswith(b"before\n")
        assert time.monotonic() - began < 0.5 + self.stop_grace + self.wall_margin

    def test_the_memory_budget_ends_a_run_that_grows_past_it(self, runtime: GuestRuntime) -> None:
        """A guest that keeps allocating ends MEMORY (or exits non-zero at its limit), never CLEAN with an answer."""
        script = "var keep = []; for (;;) { keep.push(new ArrayBuffer(1 << 20)); }"
        result = self._run(runtime, script, budget=self._budget(seconds=20, memory_mib=16))
        assert result.end in {RunEnd.MEMORY, RunEnd.EXIT, RunEnd.TRAP}, result.end

    def test_a_bare_string_argv_and_a_path_as_a_file_name_are_refused(self) -> None:
        """A `GuestRun` refuses both before any runtime sees it."""
        budget = self._budget()
        with pytest.raises(TypeError, match="argv"):
            GuestRun(app_files={"run.js": b""}, argv="qjs /app/run.js", stdin=b"", budget=budget)
        for name in ("../run.js", "a/b.js", ".", "..", "", "a\x00b"):
            with pytest.raises(ValueError, match="file name"):
                GuestRun(app_files={name: b""}, argv=_ARGV, stdin=b"", budget=budget)

    def test_close_interrupts_a_run_in_flight_and_refuses_runs_after(
        self, new_runtime: Callable[[], GuestRuntime]
    ) -> None:
        """Closing the runtime ends a looping run INTERRUPTED at once; a run after the close is refused."""
        runtime = new_runtime()
        ended: list[RunEnd] = []
        worker = threading.Thread(
            target=lambda: ended.append(self._run(runtime, "for (;;) {}", budget=self._budget(seconds=60)).end)
        )
        worker.start()
        time.sleep(0.5)
        began = time.monotonic()
        runtime.close()
        worker.join(30)
        assert ended == [RunEnd.INTERRUPTED]
        assert time.monotonic() - began < self.stop_grace + self.wall_margin
        with pytest.raises(EngineClosedError):
            self._run(runtime, "print(1);")
