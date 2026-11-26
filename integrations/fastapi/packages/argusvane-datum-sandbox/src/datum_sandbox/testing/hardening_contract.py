"""`SandboxHardeningContract`: the sandbox hardening on an engine, through `SandboxService` with the real program.

The ABI gate (a stale program refused, a proof kept per program), a rule module that cannot forge an outcome,
rebind the kernel or write outside the frame, rule sources evaluated as written and in order, thrown words, the
output cap, the depth guard, the loop, memory and recursion stops, and the smoke run. The security suite's
hardening rules and stale program (`host-check/`) are the shared inputs; the cases whose input is inline are
ported from the same list.
"""

# ruff: noqa: S101 - a contract is assertions

import contextlib
import time
from typing import TYPE_CHECKING

import pytest

from datum_sandbox.protocol import (
    SANDBOX_ABI_MIN,
    AbiProbe,
    DefinitionTooCostlyError,
    DefinitionTooDeepError,
    ProgramLimits,
    ProgramUnavailableError,
    RuleModule,
    SandboxError,
    SandboxFailure,
    SandboxResult,
)
from datum_sandbox.testing._base import ContractBase
from datum_sandbox.testing.fixtures import hardening_rules, stale_program
from datum_sandbox.testing.runtime_capabilities import Capability, requires
from datum_sandbox.testing.runtime_support import context, service, stand_in_program
from datum_sandbox.wasi import EngineInfo, GuestRun, GuestRuntime, RunResult

if TYPE_CHECKING:
    from datum_sandbox.json import JsonValue

_ROOMY = ProgramLimits(validation_memory=512 * 1024 * 1024, validation_time_limit=20)


def _rule(source: str, name: str = "probe") -> list[RuleModule]:
    return [RuleModule(name, "1", source)]


def _codes(result: SandboxResult) -> list[str]:
    errors = result.outcome["errors"]
    assert isinstance(errors, list)
    return [str(item["code"]) for item in errors if isinstance(item, dict)]


def _failure(error: pytest.ExceptionInfo[SandboxError]) -> SandboxFailure:
    return error.value.reason


class _CountingRuntime:
    """A `GuestRuntime` that counts the runs it is asked for and forwards them."""

    def __init__(self, inner: GuestRuntime) -> None:
        self.inner = inner
        self.runs = 0

    def run(self, run: GuestRun, /) -> RunResult:
        self.runs += 1
        return self.inner.run(run)

    def engine_info(self) -> EngineInfo:
        return self.inner.engine_info()

    def close(self) -> None:
        self.inner.close()


class SandboxHardeningContract(ContractBase):
    """The hardening contract; every case goes through `SandboxService`."""

    @pytest.fixture(scope="class", autouse=True)
    @classmethod
    def warm_up_for_the_two_second_budgets(cls, warm_up_the_engine: None, runtime: GuestRuntime) -> None:
        """Two cases stop a looping rule at a 2 s budget and need its started marker: run one full sandbox run first."""
        del warm_up_the_engine  # an ordering dependency only
        with contextlib.suppress(Exception):  # best effort: a wrong engine fails the cases themselves
            service(runtime, limits=ProgramLimits(validation_time_limit=30)).prove_abi()

    # -- the ABI gate --------------------------------------------------------------------------------------------------

    def test_a_program_below_the_floor_is_refused_every_time_and_never_remembered(self, runtime: GuestRuntime) -> None:
        """The stale program (ABI 2.11.0) is a 503 for the submitter, twice over, through validate and inspect."""
        probe = AbiProbe()
        program = stand_in_program("2.11.0")
        assert program.data == stale_program(), "the stand-in is the security suite's stale program"
        stale = service(runtime, program=program, probe=probe)
        for _ in range(2):
            with pytest.raises(ProgramUnavailableError, match="abi_mismatch"):
                stale.validate(context(), real=False)
        assert probe.proved(program.sha256) is False, "a refusal is not remembered"
        definition = {"id": "x", "root": context()["form"]}
        with pytest.raises(ProgramUnavailableError):
            stale.inspect("check", definition)

    def test_the_proof_is_kept_per_program(self, runtime: GuestRuntime) -> None:
        """A program at the floor passes and is remembered by its hash; an older replacement is proved and refused."""
        probe = AbiProbe()
        good = stand_in_program(SANDBOX_ABI_MIN)
        current = service(runtime, program=good, probe=probe)
        assert _codes(current.validate(context(), real=False)) == []
        assert probe.proved(good.sha256) is True
        assert _codes(current.validate(context(), real=False)) == []
        replaced = service(runtime, program=stand_in_program("2.11.0"), probe=probe)
        with pytest.raises(ProgramUnavailableError):
            replaced.validate(context(), real=False)

    # -- a rule module cannot forge, rebind or write outside the frame -------------------------------------------------

    def test_a_rule_module_cannot_forge_an_outcome(self, runtime: GuestRuntime) -> None:
        """No global is left for a rule; replacing `__datum_run` changes nothing; print, console and std are absent."""
        sandbox = service(runtime)
        probe = (
            "(function () { var seen = []; "
            "['std','os','print','console','performance','scriptArgs','bjson'].forEach(function (n) { "
            "if (typeof globalThis[n] !== 'undefined') { seen.push(n); } }); "
            "globalThis.__datum_run = function () { return JSON.stringify({ errors: [], forged: true }); }; "
            "return { validators: [function () { return { errors: seen.map(function (n) { "
            "return { code: 'leak.' + n, componentId: 'name', message: n }; }) }; }] }; })()"
        )
        result = sandbox.validate(context(), _rule(probe), real=False)
        assert _codes(result) == [], "no global is left for a rule to reach"
        assert "forged" not in result.outcome, "the entry point was captured before the module ran"
        values = result.outcome["values"]
        assert isinstance(values, dict)
        assert values["name"] == "Ada"
        for source in (
            '(print(\'{"errors":[],"forged":true}\'), std.exit(0), { validators: [] })',
            "(console.log('x'), { validators: [] })",
            "(std.out.puts('x'), { validators: [] })",
        ):
            with pytest.raises(SandboxError) as caught:
                sandbox.validate(context(), _rule(source, "evil"), real=False)
            assert _failure(caught) is SandboxFailure.THREW, (
                f"a module reaching for print, console or std throws: {source}"
            )
            assert "ReferenceError" in caught.value.stderr

    def test_a_rule_module_cannot_rebind_the_kernel(self, runtime: GuestRuntime) -> None:
        """Rebinding a kernel function or patching an intrinsic changes nothing: an empty required answer is refused."""
        poison = (
            "(function () { globalThis.kernelIsEmptyValue = function () { return false; }; "
            "Array.prototype.some = function () { return false; }; Object.prototype.polluted = 1; "
            "return { validators: [function () { return { errors: [] }; }] }; })()"
        )
        result = service(runtime).validate(context(""), _rule(poison, "poison"), real=False)
        assert _codes(result) == ["required"]

    def test_rule_sources_are_evaluated_as_written_and_in_order(self, runtime: GuestRuntime) -> None:
        """A trailing comment, quotes, a backslash, U+2028 and an astral character reach the module; order is kept."""
        text = 'é 😀 \u2028 "quoted" \\ back'
        literal = _js_string(text)
        rules = [
            RuleModule(
                "first",
                "1",
                "({ validators: [function () { return { errors: [{ code: 'first', componentId: 'name', message: "
                + literal
                + " }] }; }] }) // a trailing line comment",
            ),
            RuleModule(
                "second",
                "1",
                "({ validators: [function () { return { errors: "
                "[{ code: 'second', componentId: 'name', message: 'two' }] }; }] })",
            ),
        ]
        result = service(runtime).validate(context(), rules, real=False)
        assert _codes(result) == ["first", "second"]
        errors = result.outcome["errors"]
        assert isinstance(errors, list)
        first = errors[0]
        assert isinstance(first, dict)
        assert first["message"] == text

    def test_bytes_written_outside_the_frame_refuse_the_run(self, runtime: GuestRuntime) -> None:
        """A module that reaches stdout through `qjs:std` after the frame is refused; so is blank-looking junk."""
        sandbox = service(runtime)
        stray = (
            "(import('qjs:std').then(function (m) { m.out.puts('INJECTED-LINE\\n'); m.out.flush(); }), "
            "{ validators: [] })"
        )
        with pytest.raises(SandboxError, match="outside its answer frame") as outside:
            sandbox.validate(context(), _rule(stray, "evil"), real=False)
        assert _failure(outside) is SandboxFailure.FRAME
        blank = "(import('qjs:std').then(function (m) { m.out.puts('\\0\\0\\v'); m.out.flush(); }), { validators: [] })"
        with pytest.raises(SandboxError) as quiet:
            sandbox.validate(context(), _rule(blank, "blank"), real=False)
        assert _failure(quiet) is SandboxFailure.FRAME, "a NUL or a vertical tab after the frame refuses the run"
        assert _codes(sandbox.validate(context(), _rule("({ validators: [] })", "quiet"), real=False)) == []

    def test_the_security_suites_hardening_rules_each_meet_their_documented_end(self, runtime: GuestRuntime) -> None:
        """The shared rule module by `name`: a stray line refuses the frame, a 40 MiB message hits the output cap."""
        rules = _rule(hardening_rules(), "hardening")
        sandbox = service(runtime, limits=_ROOMY)
        assert _codes(sandbox.validate(context("fine"), rules, real=False)) == []
        with pytest.raises(SandboxError) as stray:
            sandbox.validate(context("datum-tck-stray"), rules, real=False)
        assert _failure(stray) is SandboxFailure.FRAME
        with pytest.raises(SandboxError) as huge:
            sandbox.validate(context("datum-tck-huge"), rules, real=False)
        assert _failure(huge) is SandboxFailure.OUTPUT_CAP
        assert huge.value.guest_stopped is False, "the cap proves nothing about the definition"

    @requires(Capability.BUDGET_STOP)
    def test_the_security_suites_loop_rule_is_stopped_and_the_memory_rule_fails_its_validator(
        self, runtime: GuestRuntime
    ) -> None:
        """The shared loop rule ends as BUDGET with the guest's own stop; the memory rule is caught by the kernel."""
        rules = _rule(hardening_rules(), "hardening")
        with pytest.raises(SandboxError) as loop:
            service(runtime, limits=ProgramLimits(validation_time_limit=2)).validate(
                context("datum-tck-loop"), rules, real=False
            )
        assert _failure(loop) is SandboxFailure.BUDGET
        assert loop.value.guest_stopped is True
        caught = service(runtime).validate(context("datum-tck-memory"), rules, real=False)
        assert "validator.failed" in _codes(caught)

    def test_thrown_words_do_not_make_the_runtime_unavailable(self, runtime: GuestRuntime) -> None:
        """A thrown message with an old tripwire's words is a failed run (THREW), never 'unavailable'."""
        sandbox = service(runtime)
        for words in ("No such file attacker", "failed deserialization", "wasm trap: interrupt"):
            with pytest.raises(SandboxError) as thrown:
                sandbox.validate(context(), _rule(f"(() => {{ throw new Error('{words}'); }})()", "t"), real=False)
            assert _failure(thrown) is SandboxFailure.THREW, words

    # -- caps, depth, stops --------------------------------------------------------------------------------------------

    @requires(Capability.OUTPUT_CAP)
    def test_output_past_the_cap_refuses_the_run_as_output_cap(self, runtime: GuestRuntime) -> None:
        """A 40 MiB answer against the 32 MiB cap is OUTPUT_CAP, and the guest is not blamed for it."""
        wide = stand_in_program(SANDBOX_ABI_MIN, '"x".repeat(40 * 1024 * 1024)')
        with pytest.raises(SandboxError, match="output limit") as caught:
            service(runtime, program=wide, limits=_ROOMY).validate(context(), real=False)
        assert _failure(caught) is SandboxFailure.OUTPUT_CAP
        assert caught.value.guest_stopped is False

    def test_a_definition_nested_past_the_limit_is_refused_before_any_guest_starts(self, runtime: GuestRuntime) -> None:
        """Forty nested containers are refused by the depth guard; not even the ABI probe ran."""
        counting = _CountingRuntime(runtime)
        sandbox = service(counting)
        node: dict[str, JsonValue] = {"id": "leaf", "type": "text", "configuration": {}}
        for depth in range(1, 41):
            node = {"id": f"g{depth}", "type": "container", "configuration": {}, "children": {"content": [node]}}
        form: dict[str, JsonValue] = {
            "id": "root",
            "type": "form",
            "configuration": {},
            "children": {"content": [node]},
        }
        deep: dict[str, JsonValue] = {**context(), "form": form}
        with pytest.raises(DefinitionTooDeepError):
            sandbox.validate(deep, real=False)
        assert counting.runs == 0, "no guest started, not even the ABI probe"

    @requires(Capability.BUDGET_STOP)
    def test_a_looping_validator_is_stopped_at_the_budget_as_the_guests_own_stop(self, runtime: GuestRuntime) -> None:
        """BUDGET with `guest_stopped`, within the budget plus the grace; the next validation answers."""
        sandbox = service(runtime, limits=ProgramLimits(validation_time_limit=2))
        sandbox.prove_abi()
        began = time.monotonic()
        with pytest.raises(SandboxError) as caught:
            sandbox.validate(context(), _rule("({ validators: [function () { for (;;) {} }] })", "loop"), real=False)
        seconds = time.monotonic() - began
        assert _failure(caught) is SandboxFailure.BUDGET
        assert caught.value.guest_stopped is True, "the started marker was handed back with the stop"
        assert seconds < 2 + self.stop_grace
        assert _codes(sandbox.validate(context(), real=False)) == []

    @requires(Capability.BUDGET_STOP)
    def test_a_check_stopped_after_it_started_is_too_costly_not_unavailable(self, runtime: GuestRuntime) -> None:
        """A check that runs into its own budget after the started marker is 422 `definition.tooCostly`."""
        sandbox = service(runtime, limits=ProgramLimits(validation_time_limit=2))
        definition = {"id": "costly", "root": context()["form"]}
        with pytest.raises(DefinitionTooCostlyError) as caught:
            sandbox.check(definition, ["form", "text"], _rule("(function () { for (;;) {} })()", "loop"))
        assert caught.value.code == "definition.tooCostly"

    @requires(Capability.MEMORY_STOP)
    def test_a_memory_bomb_stops_at_the_limit_and_the_next_run_answers(self, runtime: GuestRuntime) -> None:
        """Allocating without end is the memory stop, the guest's own; inside a validator the kernel names it.

        At the top level of a rule module (after the started marker) small allocations fill the guest's memory to the
        run's limit; the engine reports the limit reached (`RunEnd.MEMORY`), which the sandbox reads as `MEMORY` with
        the guest's own stop. Inside a validator the kernel catches QuickJS's out-of-memory error.
        """
        sandbox = service(runtime)
        bomb = "(function () { var a = []; for (;;) { a.push({ x: a.length }); } })()"
        with pytest.raises(SandboxError) as caught:
            sandbox.validate(context(), _rule(bomb, "bomb"), real=False)
        assert _failure(caught) is SandboxFailure.MEMORY
        assert caught.value.guest_stopped is True, "the stop came after the started marker"
        inside = "({ validators: [function () { var a = []; for (;;) { a.push(new Array(1e5).fill(1.5)); } }] })"
        assert "validator.failed" in _codes(sandbox.validate(context(), _rule(inside, "bomb"), real=False))
        assert _codes(sandbox.validate(context(), real=False)) == []

    @requires(Capability.MEMORY_STOP)
    def test_a_check_with_one_oversized_allocation_is_too_costly(self, runtime: GuestRuntime) -> None:
        """One allocation larger than the room left (64 MiB under a 32 MiB cap) kills the program: 422 for a check."""
        sandbox = service(runtime, limits=ProgramLimits(validation_memory=32 * 1024 * 1024))
        definition = {"id": "big", "root": context()["form"]}
        with pytest.raises(DefinitionTooCostlyError) as caught:
            sandbox.check(definition, ["form", "text"], _rule("(function () { new ArrayBuffer(64 << 20); })()", "big"))
        assert caught.value.code == "definition.tooCostly"
        assert _codes(sandbox.validate(context(), real=False)) == []

    def test_a_rule_that_throws_the_out_of_memory_words_is_a_throw_not_the_memory_stop(
        self, runtime: GuestRuntime
    ) -> None:
        """A rule cannot forge the memory stop: `throw new InternalError('out of memory')` is THREW, not MEMORY."""
        sandbox = service(runtime)
        with pytest.raises(SandboxError) as caught:
            sandbox.validate(context(), _rule("throw new InternalError('out of memory');", "forge"), real=False)
        assert _failure(caught) is SandboxFailure.THREW
        assert caught.value.guest_stopped is False
        assert _codes(sandbox.validate(context(), real=False)) == []

    @requires(Capability.STACK_TRAP)
    def test_runaway_recursion_traps_and_the_next_run_answers(self, runtime: GuestRuntime) -> None:
        """Recursion past the instance's stack is the TRAP failure; the next validation answers."""
        sandbox = service(runtime)
        deep = "({ validators: [function () { var f = function (n) { return f(n + 1) + 1; }; return f(0); }] })"
        with pytest.raises(SandboxError) as caught:
            sandbox.validate(context(), _rule(deep, "deep"), real=False)
        assert _failure(caught) is SandboxFailure.TRAP
        assert _codes(sandbox.validate(context(), real=False)) == []

    def test_the_smoke_run_passes(self, runtime: GuestRuntime) -> None:
        """The service's own smoke run (an empty required field gives one `required`) passes on this runtime."""
        smoke = service(runtime).smoke()
        assert smoke.ok, smoke.message


def _js_string(text: str) -> str:
    import json  # noqa: PLC0415 - beside its only use

    return json.dumps(text)
