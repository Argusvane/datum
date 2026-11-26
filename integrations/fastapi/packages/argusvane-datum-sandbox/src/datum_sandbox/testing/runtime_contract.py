"""`RuntimeContract`: the runtime's own promises on the real QuickJS, held by every engine behind `GuestRuntime`.

A private read-only `/app` with the program and `run.js` only and nothing reachable outside it; every way a run ends,
reported structurally with the started marker kept; the output caps (bytes up to the cap stored, the rest dropped and
flagged, the run ended within its wall budget, nothing on the process streams); a loop stopped at its budget and
the next run answering; shutdown; parallel streams; a looping run beside fifteen honest ones; eight runs stopped at
once; and a hundred settled runs that add no thread and only bounded memory.

The caps are: a finite producer ends by itself, an infinite one is ended by the wall
budget, and either way any end with a cap flag set is `RunEnd.OUTPUT_CAP`. Nothing here assumes how the engine
stops the guest.
"""

# ruff: noqa: S101 - a contract is assertions

import gc
import json
import sys
import time
import tracemalloc
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import ClassVar, Final

import pytest

from datum_sandbox.protocol import (
    RuleModule,
    SandboxError,
    SandboxFailure,
    marker,
    new_nonce,
    read_outcome,
    sandbox_answer,
    started,
)
from datum_sandbox.testing._base import ContractBase
from datum_sandbox.testing.fixtures import sandbox_program, sha256_hex
from datum_sandbox.testing.guest_scripts import APP_VIEW, NO_WRITE, reach_outside
from datum_sandbox.testing.runtime_capabilities import Capability, requires
from datum_sandbox.testing.runtime_support import (
    LINE_BYTES,
    STARTED,
    STDERR_PRODUCER,
    Capture,
    budget,
    expected_prefix,
    live_threads,
    producer_script,
    run_raw,
    sandbox_run,
    settle,
)
from datum_sandbox.wasi import STDERR_CAP, STDOUT_CAP, EngineClosedError, GuestRuntime, RunEnd, RunResult

LOOP: Final = RuleModule("probe", "1", "({ validators: [function () { for (;;) {} }] })")
"""A rule module whose validator loops without end."""
REACH_LINES: Final = 4
"""The lines the outside-reach script prints."""
EXIT_CODE: Final = 3
"""The code `std.exit` is given in the exit case."""
SPIN: Final = f"print('{STARTED}'); for (;;) {{}}"
"""A raw script that prints the started line and then loops without end."""
SLEEPER: Final = RuleModule(
    "probe", "1", "(import('qjs:os').then(function (m) { m.sleep(60000); }), { validators: [] })"
)
"""A rule module that reaches `os.sleep` through `import('qjs:os')` and sleeps a minute inside the host call."""


def interrupted_end() -> RunEnd:
    """Return `RunEnd.INTERRUPTED` (value `interrupted`), failing the test plainly while the enum lacks it."""
    try:
        return RunEnd("interrupted")
    except ValueError:
        pytest.fail(
            "RunEnd has no INTERRUPTED member: datum_sandbox.wasi must add RunEnd.INTERRUPTED ('interrupted') for a "
            "run stopped by the shutdown epoch bump"
        )


def _out(result: RunResult) -> str:
    return result.stdout.decode("utf-8", "replace")


def _err(result: RunResult) -> str:
    return result.stderr.decode("utf-8", "replace")


class RuntimeContract(ContractBase):
    """The runtime contract; a test per promise, each named for it."""

    heap_slope_bound: ClassVar[int] = 4 << 20
    """The Python heap a hundred settled runs may add, after collection (a provisional bound)."""
    rss_growth_bound: ClassVar[int] = 64 << 20
    """The peak resident size a hundred settled runs may add, in bytes where the platform reports it."""

    # -- the /app ------------------------------------------------------------------------------------------------------

    @requires(Capability.READ_ONLY_APP)
    def test_a_run_sees_only_its_program_and_run_script_and_no_environment(self, runtime: GuestRuntime) -> None:
        """The guest sees `/app/program.js` and `/app/run.js` and nothing else; the program is the very bytes given."""
        program = sandbox_program().data
        script = APP_VIEW
        result = run_raw(runtime, script, budget(30, 64))
        assert result.end is RunEnd.CLEAN, _err(result)
        lines = _out(result).split("\n", 5)
        assert lines[0] == "[true,true]"
        assert lines[1] == "[false,false,false,false,false]", "only the preopen is reachable"
        assert lines[2] == "{}", "no environment"
        assert lines[3] == '["/app/run.js"]'
        assert lines[4] == '["program.js","run.js"]'
        copy = lines[5].encode("utf-8")
        assert sha256_hex(copy) == sha256_hex(program + b"\n"), (
            "the guest reads the very bytes given; print adds a line feed"
        )

    @requires(Capability.READ_ONLY_APP)
    def test_the_guest_reaches_nothing_outside_its_directory(self, runtime: GuestRuntime, tmp_path: Path) -> None:
        """Dot segments, absolute paths, a symbolic link and `import()` all fail to reach a host file."""
        host_module = tmp_path / "host-module.js"
        host_module.write_text("export default 'REACHED-THE-HOST';\nprint('REACHED-THE-HOST');\n", encoding="utf-8")
        host = host_module.resolve().as_posix()
        script = reach_outside(host)
        result = run_raw(runtime, script, budget(30, 64))
        assert result.end is RunEnd.CLEAN, _err(result)
        assert "REACHED-THE-HOST" not in _out(result), "the host file's code never ran"
        lines = _out(result).rstrip("\n").split("\n")
        assert len(lines) == REACH_LINES, lines
        assert lines[0] == "[false,false,false,false,false]", (
            "absolute, through /app/.., dot segments, loadFile, ../run.js"
        )
        assert lines[1] == "[true,false,true]", "no symbolic link can be made, followed or read"
        assert lines[2] == '["rejected","rejected","rejected","rejected","rejected","rejected"]', "import() is refused"
        assert lines[3] == "[false,false,false,false,false,false]", (
            "refused because nothing was found, never a parse error"
        )

    @requires(Capability.READ_ONLY_APP)
    def test_the_guest_cannot_write_to_its_directory(self, runtime: GuestRuntime) -> None:
        """Nothing in `/app` can be created, changed or removed; a name bomb of 200,000-character names fails."""
        script = NO_WRITE
        result = run_raw(runtime, script, budget(30, 128))
        assert result.end is RunEnd.CLEAN, _err(result)
        lines = _out(result).split("\n")
        assert lines[0] == "[true,true,true,true,true,true,true,true,true]", (
            "write, mkdir, remove, rename, symlink, utimes"
        )
        assert lines[1] == "[true,0]", "the name bomb made nothing"
        assert lines[2] == "true", "run.js is untouched"
        assert lines[3] == "[false,false,false,false,false,false]", "nothing outside /app can be written or made"
        assert lines[4] == "true", "the stdin sibling (it holds the nonce) cannot be opened through /app/.."

    # -- how runs end --------------------------------------------------------------------------------------------------

    def test_exits_and_throws_are_ends_with_their_codes(self, runtime: GuestRuntime) -> None:
        """A plain return is clean; `std.exit(3)` is an exit with code 3; a throw is an exit with code 1."""
        fine = run_raw(runtime, "print('fine');", budget(30, 32))
        assert fine.end is RunEnd.CLEAN
        assert fine.stdout == b"fine\n"

        exit_three = run_raw(runtime, f"print('before'); std.exit({EXIT_CODE});", budget(30, 32))
        assert exit_three.end is RunEnd.EXIT
        assert exit_three.exit_code == EXIT_CODE
        assert exit_three.stdout == b"before\n"

        thrown = run_raw(runtime, "print('before'); throw new Error('boom from the guest');", budget(30, 32))
        assert thrown.end is RunEnd.EXIT
        assert thrown.exit_code == 1
        assert thrown.stdout == b"before\n"
        assert "boom from the guest" in _err(thrown)

    @requires(Capability.BUDGET_STOP)
    def test_a_run_stopped_at_its_budget_keeps_the_started_marker_and_the_next_run_answers(
        self, runtime: GuestRuntime
    ) -> None:
        """A looping rule ends as BUDGET within the budget plus the grace, its started marker kept; the next answers."""
        nonce = new_nonce()
        began = time.monotonic()
        result = sandbox_run(runtime, nonce, budget(2, 32), rules=[LOOP])
        seconds = time.monotonic() - began
        assert result.end is RunEnd.BUDGET, _err(result)
        assert started(result.stdout, nonce), f"the started marker reached stdout: {_out(result)!r}"
        assert seconds < 2 + self.stop_grace, "stopped at the budget, not later"

        later = new_nonce()
        answer = sandbox_answer(sandbox_run(runtime, later, budget(5, 32)), later, budget(5, 32))
        assert b'"errors":[]' in answer
        assert b'"name":"Ada"' in answer

    @requires(Capability.BUDGET_STOP)
    def test_a_rule_that_sleeps_in_a_host_call_ends_at_its_budget_and_leaves_no_stray(
        self, runtime: GuestRuntime
    ) -> None:
        """A rule that sleeps 60 s through `qjs:os` ends BUDGET within the wall, its thread gone; the next answers.

        The sleep is a host call the guest waits in: an engine that only checks for its stop between guest
        instructions must cut the wait itself to the run's remaining wall budget, or the run is stuck and its
        thread a stray holding its slot for the minute.
        """
        before = live_threads()
        nonce = new_nonce()
        run_budget = budget(1, 32)
        began = time.monotonic()
        result = sandbox_run(runtime, nonce, run_budget, rules=[SLEEPER])
        seconds = time.monotonic() - began
        assert result.end is RunEnd.BUDGET, f"{result.end}: {_err(result)}"
        assert seconds < 1 + self.wall_margin, f"ended within the wall budget, not {seconds:.2f} s"
        assert settle(lambda: not [t for t in live_threads() - before if t.name == "datum-run"], timeout=1.0), (
            "the sleeping run's thread outlived it (a stray)"
        )
        with pytest.raises(SandboxError) as caught:
            sandbox_answer(result, nonce, run_budget)
        assert caught.value.reason is SandboxFailure.BUDGET

        later = new_nonce()
        answer = sandbox_answer(sandbox_run(runtime, later, budget(5, 32)), later, budget(5, 32))
        assert read_outcome(answer)["errors"] == []

    def test_an_exit_zero_in_the_middle_of_the_frame_is_clean_and_never_an_answer(self, runtime: GuestRuntime) -> None:
        """`std.exit(0)` (WASI `proc_exit(0)`) after the begin marker and the answer is a clean end, and no answer."""
        nonce = new_nonce()
        lines = [marker(nonce, "started"), marker(nonce, "begin"), b'{"errors":[]}']
        script = "".join(f"print({json.dumps(line.decode('ascii'))});" for line in lines) + "std.exit(0);"
        result = run_raw(runtime, script, budget(30, 32))
        assert result.end is RunEnd.CLEAN, _err(result)
        assert result.stdout == b"\n".join(lines) + b"\n", "everything before the exit is kept"
        with pytest.raises(SandboxError) as caught:
            sandbox_answer(result, nonce, budget(30, 32))
        assert caught.value.reason is SandboxFailure.NO_OUTCOME, "a frame without its end marker is no answer"

    @requires(Capability.STACK_TRAP)
    def test_runaway_recursion_traps_and_keeps_the_started_marker(self, runtime: GuestRuntime) -> None:
        """Recursion past the instance's own stack ends as a trap, with the started marker in stdout."""
        recurse = RuleModule(
            "probe",
            "1",
            "({ validators: [function () { var f = function (n) { return f(n + 1) + 1; }; return f(0); }] })",
        )
        nonce = new_nonce()
        result = sandbox_run(runtime, nonce, budget(30, 32), rules=[recurse])
        assert result.end is RunEnd.TRAP, _err(result)
        assert started(result.stdout, nonce)

    @requires(Capability.MEMORY_STOP)
    def test_a_run_past_its_memory_ends_by_itself_and_keeps_its_output(self, runtime: GuestRuntime) -> None:
        """QuickJS's allocator sees `memory.grow` refused and exits with `out of memory`; output kept, next run fine."""
        script = f"print('{STARTED}'); var a = []; for (;;) {{ a.push(new ArrayBuffer(1 << 20)); }}"
        result = run_raw(runtime, script, budget(30, 32))
        assert result.end in {RunEnd.EXIT, RunEnd.MEMORY}, f"a refused grow is the guest's own end, not {result.end}"
        if result.end is RunEnd.EXIT:
            assert result.exit_code == 1
        assert "out of memory" in _err(result)
        assert result.stdout == f"{STARTED}\n".encode()
        assert run_raw(runtime, "print('again');", budget(30, 32)).end is RunEnd.CLEAN, "the next run is fine"

    @requires(Capability.MEMORY_STOP)
    def test_a_forty_mib_guest_fails_under_32_mib_and_completes_under_64_mib(self, runtime: GuestRuntime) -> None:
        """The memory cap is the budget's value: 40 MiB of buffer fails at 32 MiB and completes at 64 MiB."""
        script = (
            f"print('{STARTED}'); var b = new ArrayBuffer(40 * 1024 * 1024); new Uint8Array(b).fill(1); print('done');"
        )
        under = run_raw(runtime, script, budget(10, 32))
        assert under.end in {RunEnd.EXIT, RunEnd.MEMORY}, _err(under)
        if under.end is RunEnd.EXIT:
            assert under.exit_code == 1
            assert "out of memory" in _err(under)
        assert under.stdout == f"{STARTED}\n".encode()
        over = run_raw(runtime, script, budget(10, 64))
        assert over.end is RunEnd.CLEAN, _err(over)
        assert over.stdout == f"{STARTED}\ndone\n".encode()

    # -- the output caps -----------------------------------------------------------------------------------------------

    @requires(Capability.OUTPUT_CAP)
    @pytest.mark.parametrize(
        ("cap", "lines"),
        [
            pytest.param(64 * 1024, 4096, id="aligned"),
            pytest.param(64 * 1024 + 100, 4096, id="unaligned"),
            pytest.param(1023, 64, id="inside-the-first-line"),
            pytest.param(1, 64, id="one-byte"),
            pytest.param(64 * LINE_BYTES - 1, 64, id="one-byte-over"),
            pytest.param(STDOUT_CAP, 40 * 1024, id="default-32-MiB-of-40"),
        ],
    )
    def test_a_finite_producer_past_the_stdout_cap_keeps_exactly_the_first_cap_bytes(
        self, runtime: GuestRuntime, capfd: Capture, cap: int, lines: int
    ) -> None:
        """Exactly the first cap bytes are stored; the flag is set; the process streams stay quiet."""
        assert lines * LINE_BYTES > cap
        result = run_raw(runtime, producer_script(lines), budget(30, 64, stdout_cap=cap))
        assert result.end is RunEnd.OUTPUT_CAP
        assert result.stdout_capped is True
        assert result.stderr_capped is False
        assert len(result.stdout) <= cap, "at most the cap is stored"
        assert result.stdout == expected_prefix(cap), "exactly the first bytes written"
        seen = capfd.readouterr()
        assert (seen.out, seen.err) == ("", ""), "nothing reached the process's own streams"

    @requires(Capability.OUTPUT_CAP)
    def test_a_finite_producer_that_exactly_fits_the_stdout_cap_ends_clean(
        self, runtime: GuestRuntime, capfd: Capture
    ) -> None:
        """An answer of exactly the cap size drops no byte: the flag stays down and the run ends clean."""
        lines = 64
        cap = lines * LINE_BYTES
        result = run_raw(runtime, producer_script(lines), budget(30, 64, stdout_cap=cap))
        assert result.end is RunEnd.CLEAN
        assert result.stdout_capped is False, "no byte was dropped"
        assert result.stderr_capped is False
        assert result.stdout == expected_prefix(cap), "the whole output is stored"
        seen = capfd.readouterr()
        assert (seen.out, seen.err) == ("", ""), "nothing reached the process's own streams"

    @requires(Capability.OUTPUT_CAP)
    @pytest.mark.parametrize(
        ("cap", "wall"),
        [
            pytest.param(64 * 1024, 1.0, id="aligned"),
            pytest.param(64 * 1024 + 100, 1.0, id="unaligned"),
            # The guest must reach the cap before its wall budget ends, or the run is rightly a plain BUDGET stop: a
            # wasmtime-py binding delivers about 30 MiB/s through its output callbacks on a laptop (one callback per
            # 1 KiB print), but a CI runner sharing its cores with the other members' suites delivers a fraction of
            # that, so 32 MiB gets a 15 s wall (about 2.2 MiB/s). The endless guest runs the whole wall either way.
            pytest.param(STDOUT_CAP, 15.0, id="default-32-MiB"),
        ],
    )
    def test_an_endless_producer_ends_within_its_wall_budget_with_the_exact_prefix(
        self, runtime: GuestRuntime, capfd: Capture, cap: int, wall: float
    ) -> None:
        """The wall budget ends a guest that never stops writing; the cap flag makes it OUTPUT_CAP; prefix exact."""
        began = time.monotonic()
        result = run_raw(runtime, producer_script(None), budget(wall, 64, stdout_cap=cap))
        seconds = time.monotonic() - began
        assert result.end is RunEnd.OUTPUT_CAP, (
            f"ended {result.end.name} with {len(result.stdout)} of {cap} bytes stored after {seconds:.2f} s"
        )
        assert result.stdout_capped is True
        assert seconds < wall + self.wall_margin, f"ended within the wall budget, not {seconds:.2f} s"
        assert len(result.stdout) <= cap
        assert result.stdout == expected_prefix(cap)
        seen = capfd.readouterr()
        assert (seen.out, seen.err) == ("", ""), "nothing reached the process's own streams"

    @requires(Capability.OUTPUT_CAP)
    @pytest.mark.parametrize("cap", [pytest.param(STDERR_CAP, id="aligned-64-KiB"), pytest.param(1000, id="unaligned")])
    def test_a_stderr_past_its_cap_keeps_exactly_the_first_cap_bytes(
        self, runtime: GuestRuntime, capfd: Capture, cap: int
    ) -> None:
        """Stderr has its own cap, flag and prefix; stdout stays untouched and uncapped."""
        result = run_raw(runtime, STDERR_PRODUCER + "print('after');\n", budget(30, 32, stderr_cap=cap))
        assert result.end is RunEnd.OUTPUT_CAP
        assert result.stderr_capped is True
        assert result.stdout_capped is False
        assert result.stderr == b"y" * cap
        seen = capfd.readouterr()
        assert (seen.out, seen.err) == ("", "")

    @requires(Capability.OUTPUT_CAP)
    def test_an_endless_stderr_producer_ends_within_its_wall_budget_with_the_exact_prefix(
        self, runtime: GuestRuntime, capfd: Capture
    ) -> None:
        """The wall budget ends a guest that never stops writing to stderr; the cap flag and the prefix are exact."""
        began = time.monotonic()
        result = run_raw(runtime, "for (;;) { std.err.puts('y'.repeat(1000)); }", budget(1.0, 32))
        seconds = time.monotonic() - began
        assert result.end is RunEnd.OUTPUT_CAP
        assert result.stderr_capped is True
        assert result.stdout_capped is False
        assert result.stderr == b"y" * STDERR_CAP
        assert seconds < 1.0 + self.wall_margin, f"ended within the wall budget, not {seconds:.2f} s"
        seen = capfd.readouterr()
        assert (seen.out, seen.err) == ("", "")

    @requires(Capability.OUTPUT_CAP)
    def test_a_cap_in_one_run_is_not_a_cap_in_the_next(self, runtime: GuestRuntime) -> None:
        """The flag belongs to its run: a quiet run after a capped one is clean with nothing flagged."""
        capped = run_raw(runtime, producer_script(64), budget(30, 32, stdout_cap=1000))
        assert capped.end is RunEnd.OUTPUT_CAP
        quiet = run_raw(runtime, "print('fine');", budget(30, 32))
        assert quiet.end is RunEnd.CLEAN
        assert (quiet.stdout_capped, quiet.stderr_capped) == (False, False)
        assert quiet.stdout == b"fine\n"

    # -- concurrency ---------------------------------------------------------------------------------------------------

    def test_runs_in_parallel_keep_their_own_streams(self, runtime: GuestRuntime) -> None:
        """Four runs at once each read their own stdin and write only their own stdout."""
        with ThreadPoolExecutor(4) as pool:
            futures = [
                pool.submit(
                    run_raw, runtime, "print(std.in.readAsString());", budget(60, 32), stdin=f"run-{i}".encode()
                )
                for i in range(4)
            ]
            results = [future.result(timeout=120) for future in futures]
        for index, result in enumerate(results):
            assert result.end is RunEnd.CLEAN, _err(result)
            assert result.stdout == f"run-{index}\n".encode()

    @requires(Capability.BUDGET_STOP)
    def test_a_looping_run_beside_fifteen_honest_runs_every_honest_run_answers(self, runtime: GuestRuntime) -> None:
        """One run loops to its budget beside fifteen honest validations: each honest run answers."""
        honest = 15
        loop_nonce = new_nonce()

        def one_honest() -> tuple[RunResult, bytes]:
            nonce = new_nonce()
            run_budget = budget(30, 32)
            result = sandbox_run(runtime, nonce, run_budget)
            return result, sandbox_answer(result, nonce, run_budget)

        with ThreadPoolExecutor(honest + 1) as pool:
            looping = pool.submit(sandbox_run, runtime, loop_nonce, budget(3, 32), rules=[LOOP])
            answers = [pool.submit(one_honest) for _ in range(honest)]
            honest_results = [future.result(timeout=120) for future in answers]
            loop_result = looping.result(timeout=120)
        for result, answer in honest_results:
            assert result.end is RunEnd.CLEAN, _err(result)
            assert read_outcome(answer)["errors"] == []
            assert b'"name":"Ada"' in answer
        assert loop_result.end is RunEnd.BUDGET
        assert started(loop_result.stdout, loop_nonce)
        assert loop_result.elapsed < 3 + self.stop_grace

    @requires(Capability.BUDGET_STOP)
    def test_runs_stopped_together_all_end_as_budget_stops_and_the_next_run_answers(
        self, runtime: GuestRuntime
    ) -> None:
        """Eight looping runs stopped at once (some in set-up): all BUDGET, none left behind, the next run fine."""
        runs = 8
        before = live_threads()
        with ThreadPoolExecutor(runs) as pool:
            futures = [pool.submit(run_raw, runtime, SPIN, budget(2, 64)) for _ in range(runs)]
            results = [future.result(timeout=2 + self.stop_grace + 60) for future in futures]
        for result in results:
            assert result.end is RunEnd.BUDGET, _err(result)
            assert _out(result) in {"", f"{STARTED}\n"}
        assert settle(lambda: not [t for t in live_threads() - before if t.name == "datum-run"]), (
            "a stopped run outlived its grace"
        )
        assert run_raw(runtime, "print('again');", budget(30, 32)).end is RunEnd.CLEAN

    # -- shutdown ------------------------------------------------------------------------------------------------------

    @requires(Capability.SHUTDOWN_STOP)
    def test_closing_the_runtime_stops_runs_in_flight_as_interrupted_and_runs_nothing_after(
        self, new_runtime: Callable[[], GuestRuntime]
    ) -> None:
        """Shutdown during looping runs returns within the grace, each run INTERRUPTED; a closed one runs nothing."""
        interrupted = interrupted_end()
        own = new_runtime()
        try:
            with ThreadPoolExecutor(4) as pool:
                futures = [pool.submit(run_raw, own, SPIN, budget(60, 64)) for _ in range(4)]
                time.sleep(1.5)
                began = time.monotonic()
                own.close()
                closing = time.monotonic() - began
                results = [future.result(timeout=self.stop_grace + 30) for future in futures]
        finally:
            own.close()
        assert closing < self.stop_grace + self.wall_margin, f"close() returned within the grace, not {closing:.2f} s"
        for result in results:
            assert result.end is interrupted, _err(result)
            assert _out(result) in {"", f"{STARTED}\n"}
        self._assert_runs_nothing(own)

    @requires(Capability.SHUTDOWN_STOP)
    def test_a_closed_runtime_runs_nothing_and_closing_twice_is_harmless(
        self, new_runtime: Callable[[], GuestRuntime]
    ) -> None:
        """A run asked of a closed runtime is refused (EngineClosedError) or answered INTERRUPTED with no output."""
        own = new_runtime()
        own.close()
        own.close()
        self._assert_runs_nothing(own)

    @staticmethod
    def _assert_runs_nothing(closed: GuestRuntime) -> None:
        try:
            result = run_raw(closed, "print(1);", budget(5, 32))
        except EngineClosedError:
            return
        assert result.end is interrupted_end()
        assert result.stdout == b""

    # -- leaks ---------------------------------------------------------------------------------------------------------

    @requires(Capability.SETTLED_RUNS)
    def test_a_hundred_settled_runs_add_no_thread_and_only_bounded_memory(self, runtime: GuestRuntime) -> None:
        """After 50 runs to settle, the next hundred leave no thread behind and add bounded Python heap and peak RSS."""

        def validations(count: int) -> None:
            for index in range(count):
                nonce = new_nonce()
                run_budget = budget(30, 32)
                result = sandbox_run(runtime, nonce, run_budget)
                assert result.end is RunEnd.CLEAN, f"run {index}: {_err(result)}"
                assert read_outcome(sandbox_answer(result, nonce, run_budget))["errors"] == []

        validations(5)
        before_threads = live_threads()
        validations(45)
        gc.collect()
        peak_before = _peak_rss()
        tracemalloc.start()
        try:
            gc.collect()
            settled, _ = tracemalloc.get_traced_memory()
            validations(100)
            gc.collect()
            after, _ = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        peak_after = _peak_rss()
        assert settle(lambda: not (live_threads() - before_threads)), (
            f"threads left behind: {sorted(t.name for t in live_threads() - before_threads)}"
        )
        assert after - settled < self.heap_slope_bound, (
            f"Python heap added {after - settled} bytes over 100 settled runs"
        )
        if peak_before is not None and peak_after is not None:
            assert peak_after - peak_before < self.rss_growth_bound, "peak resident size kept growing"


def _peak_rss() -> int | None:
    """Return this process's peak resident size in bytes, or None where the platform does not report it."""
    try:
        import resource  # noqa: PLC0415 - POSIX only
    except ImportError:
        return None
    peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
    return peak if sys.platform == "darwin" else peak * 1024
