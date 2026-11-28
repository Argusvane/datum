"""`SandboxService`: runs the sandbox program over a `GuestRuntime`, runtime-agnostic.

Every run, in this order: the depth guard before any guest starts; the ABI gate, once per program, so a stale program
never runs; the input written as strict JSON; a fresh nonce; the run, whose slot the runtime's harness takes with the
budget's wait (`EngineBusyError` is 503 `server.busy`; a full stray bound is `StrayBoundError`, 503
`server.unavailable`); the classification of how it ended and the frame; then the answer read strictly. A validation's
outcome must be an object with an `errors` list and is refused past 8 Mi UTF-16 code units; a real submission's run log
is relayed to the `RunLog`.

The service is final: a host observes runs by wrapping the `Sandbox` it answers (`compose_sandbox`), never by
subclassing. With a `recorder` (the diagnostics are on) each operation hands its run to it after its last check
(`_watch`); without one, an operation pays one `is None` test.
"""

import copy
import json
import logging
from collections.abc import Callable, Iterable, Mapping, Sequence
from contextlib import AbstractContextManager, nullcontext
from dataclasses import dataclass
from typing import Final, final

from datum_sandbox.json import BadDocumentError, JsonValue, read
from datum_sandbox.loggers import SANDBOX
from datum_sandbox.protocol._abi import SANDBOX_ABI_MIN, AbiProbe, require_probe_answer, sandbox_probe_request
from datum_sandbox.protocol._classify import read_inspect, read_outcome, sandbox_answer, stderr_text
from datum_sandbox.protocol._depth import assert_context_shallow, assert_shallow
from datum_sandbox.protocol._errors import (
    DefinitionTooCostlyError,
    ProgramUnavailableError,
    SandboxError,
    SandboxFailure,
    StrayBoundError,
)
from datum_sandbox.protocol._frame import new_nonce, run_stdin
from datum_sandbox.protocol._host_options import FormulaErrors, HostOptions
from datum_sandbox.protocol._limits import ProgramLimits
from datum_sandbox.protocol._protocol import Program, ProgramKind, SandboxResult, Smoke
from datum_sandbox.protocol._run_script import Entry, RuleModule, program_run, run_script
from datum_sandbox.protocol._watch import REFUSED, RunRecorder, clock, note_outcome, note_run, outcome_of, watched
from datum_sandbox.wasi import (
    EngineBusyError,
    EngineClosedError,
    EngineInfo,
    EngineStrayBoundError,
    GuestRuntime,
    RunBudget,
    RunResult,
)

logger = logging.getLogger(SANDBOX)

_RESERVED_REQUEST_KEYS: Final = frozenset({"abi", "op", "definition", "formulaErrors"})
_SMOKE_CONTEXT: Final[dict[str, JsonValue]] = {
    "formId": "datum-smoke",
    "form": {
        "id": "root",
        "type": "form",
        "configuration": {},
        "children": {"content": [{"id": "name", "type": "text", "configuration": {"label": "Name", "required": True}}]},
    },
    "values": {},
    "locale": "en",
}
_LOG_LEVELS: Final = {"error": logging.ERROR, "warn": logging.WARNING, "info": logging.INFO, "debug": logging.DEBUG}


@dataclass(frozen=True, slots=True)
class RunLogEntry:
    """One entry of a real submission's run log: the form, the guest's level word, message and data."""

    form_id: str | None
    level: str | None
    message: str
    data: JsonValue


type RunLog = Callable[[RunLogEntry], None]
"""Where a real submission's run log goes; dry, smoke, warm-up and probe runs relay nothing."""


def _escaped(text: str) -> str:
    return text.encode("unicode_escape").decode("ascii")


def log_run_entry(entry: RunLogEntry) -> None:
    """Log one escaped line per entry on `datum.sandbox` at the entry's level (else INFO): the default `RunLog`."""
    level = _LOG_LEVELS.get(entry.level or "", logging.INFO)
    logger.log(
        level, "%s: %s", _escaped(entry.form_id or "-"), _escaped(entry.message), extra={"datum_form_id": entry.form_id}
    )


@dataclass(frozen=True, slots=True)
class _Executed:
    answer: bytes
    stderr: str
    elapsed: float


def _input_json(value: Mapping[str, JsonValue]) -> bytes:
    """Write a run's input as strict JSON; a number or text JSON cannot carry refuses the run (a backstop)."""
    try:
        text = json.dumps(value, ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        return text.encode("utf-8")
    except (ValueError, TypeError, RecursionError) as error:
        raise SandboxError(
            SandboxFailure.INPUT, f"The run input could not be written as JSON ({type(error).__name__})."
        ) from None


def _quickjs_refused_allocation(stderr: str) -> bool:
    """Say whether stderr opens with QuickJS's own `InternalError: out of memory` line (a nonzero exit after start)."""
    return stderr.lstrip().split("\n", 1)[0].rstrip() == "InternalError: out of memory"


@final
class SandboxService:
    """The one `Sandbox` implementation: runs the sandbox program through the protocol."""

    __slots__ = ("_freeze", "_host_options", "_limits", "_probe", "_program", "_recorder", "_run_log", "_runtime")

    def __init__(
        self,
        runtime: GuestRuntime,
        program: Program,
        *,
        freeze_snippet: str,
        limits: ProgramLimits | None = None,
        host_options: HostOptions | None = None,
        probe: AbiProbe | None = None,
        run_log: RunLog | None = None,
        recorder: RunRecorder | None = None,
    ) -> None:
        """Run the sandbox `program` on `runtime`.

        The freeze snippet is argusvane-datum-programs' `freeze-intrinsics.js`. `recorder` receives every run's record
        (the trace and the capture); `None` (the default) records nothing and measures nothing.
        """
        if program.kind is not ProgramKind.SANDBOX:
            raise ValueError(f"the sandbox service runs the sandbox program, not the {program.kind} program")
        run_script(freeze_snippet)  # refuses an empty snippet now rather than at the first run
        self._runtime = runtime
        self._program = program
        self._freeze = freeze_snippet
        self._limits = limits or ProgramLimits()
        self._host_options = host_options or HostOptions()
        self._probe = probe or AbiProbe()
        self._run_log: RunLog = run_log or log_run_entry
        self._recorder = recorder

    @property
    def program(self) -> Program:
        """The program this service runs."""
        return self._program

    @property
    def limits(self) -> ProgramLimits:
        """The budgets runs are made with."""
        return self._limits

    @property
    def recorder(self) -> RunRecorder | None:
        """The diagnostics' recorder this service hands its runs to, or `None` while they are off."""
        return self._recorder

    def _engine_info(self) -> EngineInfo:
        return self._runtime.engine_info()

    def _watched(self, op: str) -> AbstractContextManager[None]:
        recorder = self._recorder
        if recorder is None:  # pragma: no cover - callers test it first
            return nullcontext()
        return watched(
            recorder,
            program=self._program.kind.value,
            op=op,
            abi=self._program.abi,
            sha256=self._program.sha256,
            engine=self._engine_info,
        )

    # -- the operations ----------------------------------------------------------------------------------------------

    def validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        """Run one validation over a copy of `context` with the host's keys set over it.

        Raises `DefinitionTooDeepError` before any guest starts, `SandboxError` when the run gave no verdict (`BUSY`
        when every slot stayed taken) and `ProgramUnavailableError` when the program or the runtime cannot be used
        (`StrayBoundError` while runs that would not stop fill the stray bound).
        """
        if self._recorder is None:
            return self._validate(context, rules, real=real)
        with self._watched("validate"):
            return self._validate(context, rules, real=real)

    def _validate(
        self, context: Mapping[str, JsonValue], rules: Sequence[RuleModule] = (), *, real: bool
    ) -> SandboxResult:
        merged = self._host_options.merged(context)
        assert_context_shallow(merged)
        run = self._execute(Entry.RUN, rules, merged, gate=True)
        outcome = read_outcome(run.answer, run.stderr)
        if real:
            self._relay(merged, outcome)
        return SandboxResult(outcome, run.elapsed)

    def inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        """Ask the program about a definition with the host's ABI floor, so a program too old refuses (`abi_mismatch`).

        `extra` adds request members (`types`, `riskyPatterns`); it never names `abi`, `op`, `definition` or
        `formulaErrors` (the last is the `formula_errors` argument's).
        """
        if self._recorder is None:
            return self._inspect(op, definition, formula_errors=formula_errors, extra=extra, rules=rules)
        with self._watched(op):
            return self._inspect(op, definition, formula_errors=formula_errors, extra=extra, rules=rules)

    def _inspect(
        self,
        op: str,
        definition: Mapping[str, JsonValue],
        *,
        formula_errors: str | None = None,
        extra: Mapping[str, JsonValue] | None = None,
        rules: Sequence[RuleModule] = (),
    ) -> dict[str, JsonValue]:
        assert_shallow(definition)
        request: dict[str, JsonValue] = {"abi": SANDBOX_ABI_MIN, "op": op, "definition": dict(definition)}
        if formula_errors is not None:
            request["formulaErrors"] = FormulaErrors(formula_errors).value
        if extra:
            clash = _RESERVED_REQUEST_KEYS.intersection(extra)
            if clash:
                raise ValueError(f"an inspect request's {', '.join(sorted(clash))} is the host's, not an extra member")
            request.update(extra)
        run = self._execute(Entry.INSPECT, rules, request, gate=True)
        return read_inspect(run.answer, op, run.stderr)

    def check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        """Ask whether a definition may be saved; a check with no verdict is never read as "no problems".

        Raises `DefinitionTooDeepError`, `DefinitionTooCostlyError` (422, a time or memory stop the guest ran into after
        it started) or `ProgramUnavailableError` (503) for every other failure, an answer with no structure included.
        """
        if self._recorder is None:
            return self._check(definition, types, rules)
        with self._watched("check"):
            return self._check(definition, types, rules)

    def _check(
        self, definition: Mapping[str, JsonValue], types: Sequence[str], rules: Sequence[RuleModule] = ()
    ) -> dict[str, JsonValue]:
        keys = self._host_options.context_keys()
        sorted_types: list[JsonValue] = [*sorted(types)]
        extra: dict[str, JsonValue] = {"types": sorted_types, "riskyPatterns": keys["riskyPatterns"]}
        try:
            answer = self._inspect(
                "check", definition, formula_errors=FormulaErrors(keys["formulaErrors"]), extra=extra, rules=rules
            )
        except SandboxError as error:
            if error.reason in {SandboxFailure.BUDGET, SandboxFailure.MEMORY} and error.guest_stopped:
                raise DefinitionTooCostlyError(error) from error
            if error.reason is SandboxFailure.THREW and _quickjs_refused_allocation(error.stderr):
                # Authoring only: a single allocation larger than the room left kills the program below the
                # store limit; a validation keeps the engine-signal rule, so a rule's own words buy nothing there.
                raise DefinitionTooCostlyError(error) from error
            raise _check_unavailable(error.reason) from error
        if not isinstance(answer.get("structure"), list) or not isinstance(answer.get("structureWarnings"), list):
            if self._recorder is not None:
                note_outcome(SandboxFailure.NO_OUTCOME.value)
            raise _check_unavailable(SandboxFailure.NO_OUTCOME)
        return answer

    def public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        """Return the definition without its server-secret rules; one with none anywhere is its own copy (no run).

        The depth guard runs first either way, so a definition too deep is refused whether or not it has a secret.
        """
        if self._recorder is None:
            return self._public_copy(definition)
        with self._watched("public"):
            return self._public_copy(definition)

    def _public_copy(self, definition: Mapping[str, JsonValue]) -> dict[str, JsonValue]:
        assert_shallow(definition)
        if b"server-secret" not in _input_json(definition):
            return copy.deepcopy(dict(definition))
        answer = self._inspect("public", definition)
        public = answer.get("definition")
        if not isinstance(public, dict):
            raise SandboxError(SandboxFailure.NO_OUTCOME, "The sandbox answered the public request with no definition.")
        return public

    def smoke(self) -> Smoke:
        """Validate a form whose one required field is empty: exactly one `required` error for it is expected."""
        if self._recorder is None:
            return self._smoke()
        with self._watched("smoke"):
            return self._smoke()

    def _smoke(self) -> Smoke:
        try:
            result = self._validate(_SMOKE_CONTEXT, (), real=False)
        except (SandboxError, ProgramUnavailableError) as error:
            if self._recorder is not None:
                note_outcome(outcome_of(error))
            return Smoke(ok=False, elapsed=0.0, message=error.message)
        errors = result.outcome.get("errors")
        first = errors[0] if isinstance(errors, list) and len(errors) == 1 else None
        ok = isinstance(first, dict) and first.get("code") == "required" and first.get("componentId") == "name"
        if not ok and self._recorder is not None:
            note_outcome(SandboxFailure.NO_OUTCOME.value)  # an answer, but not the smoke's: the start fails on it
        message = (
            "The sandbox answered as expected." if ok else "The sandbox answered, but not with the expected verdict."
        )
        return Smoke(ok=ok, elapsed=result.elapsed, message=message)

    def prove_abi(self) -> None:
        """Prove the program answers for `SANDBOX_ABI_MIN`, once per program SHA-256; a refusal is never remembered.

        Raises `ProgramUnavailableError` when it does not answer for the floor, and `SandboxError` (`BUSY`,
        `INTERRUPTED`) or `StrayBoundError` when the probe could not run at all.
        """
        if self._probe.proved(self._program.sha256):
            return
        if self._recorder is None:
            self._prove_abi()
            return
        with self._watched("probe"):
            self._prove_abi()

    def _prove_abi(self) -> None:
        try:
            run = self._execute(Entry.INSPECT, (), sandbox_probe_request(), gate=False)
            answer: JsonValue = read(run.answer, max_depth=64)
        except SandboxError as error:
            if error.reason in {SandboxFailure.BUSY, SandboxFailure.INTERRUPTED}:
                raise
            raise ProgramUnavailableError(
                f"The sandbox program did not answer the ABI {SANDBOX_ABI_MIN} probe ({error.reason})."
            ) from error
        except BadDocumentError:
            answer = None
            if self._recorder is not None:
                note_outcome(SandboxFailure.NOT_JSON.value)
        try:
            require_probe_answer(answer)
        except ProgramUnavailableError:
            if self._recorder is not None and answer is not None:
                note_outcome(REFUSED)  # the program answered: a probe it does not answer for is its own refusal
            raise
        self._probe.remember(self._program.sha256)

    # -- one run -----------------------------------------------------------------------------------------------------

    def _execute(
        self, entry: Entry, rules: Iterable[RuleModule], payload: Mapping[str, JsonValue], *, gate: bool
    ) -> _Executed:
        """One guest run: the gate, the input, a fresh nonce, the run, the classification and the frame."""
        if gate:
            self.prove_abi()
        input_json = _input_json(payload)
        # A fresh nonce per run, sent on stdin only: the guest has no file to read it from, and a rule module never
        # sees it, so it cannot print the markers.
        nonce = new_nonce()
        budget = self._limits.validation_budget()
        script = run_script(self._freeze, rules, entry).encode("utf-8")
        result = self._run(script, run_stdin(nonce, input_json), budget)
        answer = sandbox_answer(result, nonce, budget)
        return _Executed(answer, stderr_text(result), result.elapsed)

    def _run(self, script: bytes, stdin: bytes, budget: RunBudget) -> RunResult:
        recorder = self._recorder
        run = program_run(self._program.data, script, stdin, budget, timed=recorder is not None)
        began = clock() if recorder is not None else 0.0
        try:
            result = self._runtime.run(run)
        except EngineBusyError as error:
            raise SandboxError(
                SandboxFailure.BUSY, f"Every sandbox slot stayed taken for {budget.wait:g} s ({error.reason})."
            ) from None
        except EngineClosedError:
            raise SandboxError(
                SandboxFailure.INTERRUPTED, "The sandbox runtime is stopping; the run was not made."
            ) from None
        except EngineStrayBoundError:
            # A fault of the runtime, not a queue: a failed run the watch records as `unavailable`, never a busy one.
            if recorder is not None:
                note_run(run, None, clock() - began)
            raise StrayBoundError(
                "The sandbox runtime is unavailable: runs that would not stop have not ended, so no new run starts "
                "until they do."
            ) from None
        except Exception as error:
            if recorder is not None:
                note_run(run, None, clock() - began)
            raise ProgramUnavailableError("The runtime could not start the sandbox program.") from error
        if recorder is not None:
            note_run(run, result, clock() - began)
        return result

    def _relay(self, context: Mapping[str, JsonValue], outcome: Mapping[str, JsonValue]) -> None:
        """Offer every log entry to the run log; a sink that raises never turns the verdict into a refusal."""
        logs = outcome.get("logs")
        if not isinstance(logs, list):
            return
        form_id = context.get("formId")
        form = form_id if isinstance(form_id, str) else None
        failed: Exception | None = None
        failures = 0
        for item in logs:
            if not isinstance(item, dict):
                continue
            level = item.get("level")
            message = item.get("message")
            entry = RunLogEntry(
                form,
                level if isinstance(level, str) else None,
                message if isinstance(message, str) else "",
                item.get("data"),
            )
            try:
                self._run_log(entry)
            except Exception as error:
                failed = failed or error
                failures += 1
        if failed is not None:
            # The class only: the message may carry the guest's text.
            logger.warning(
                "the run log refused %d of this run's entries (%s); the verdict stands",
                failures,
                type(failed).__name__,
            )


def _check_unavailable(reason: SandboxFailure) -> ProgramUnavailableError:
    return ProgramUnavailableError(
        f"The form could not be checked because the server runtime is not available ({reason}), so it was not saved. "
        "Try again later."
    )
