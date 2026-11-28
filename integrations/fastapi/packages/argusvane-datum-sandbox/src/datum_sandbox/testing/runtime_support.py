"""Helpers the runtime contract classes share: budgets, raw and sandbox runs, stand-in programs, producers, inputs.

Nothing here is an assertion; the contract classes make those. Everything is plain data and standard-library calls, so a
fake runtime in a test can recognise the scripts these helpers build.
"""

import json
import threading
import time
from collections.abc import Callable, Mapping, Sequence
from typing import Any, Final, Protocol

from datum_sandbox.json import JsonValue
from datum_sandbox.protocol import (
    APP_PROGRAM,
    APP_RUN_SCRIPT,
    AbiProbe,
    Entry,
    PoolKind,
    Program,
    ProgramKind,
    ProgramLimits,
    RuleModule,
    SandboxService,
    program_run,
    run_script,
    run_stdin,
)
from datum_sandbox.protocol import SANDBOX_ABI_MIN as _ABI
from datum_sandbox.testing.fixtures import freeze_snippet, sandbox_program
from datum_sandbox.wasi import STDERR_CAP, STDOUT_CAP, GuestRun, GuestRuntime, RunBudget, RunResult


class Seen(Protocol):
    """What a `capfd` read returns: the text written to the process's stdout and stderr since the last read."""

    @property
    def out(self) -> str:
        """Text written to stdout."""
        ...

    @property
    def err(self) -> str:
        """Text written to stderr."""
        ...


class Capture(Protocol):
    """The part of pytest's `capfd` the contracts use, so a test can pass a stand-in."""

    def readouterr(self) -> Seen:
        """Return and reset what was captured."""
        ...


MIB: Final = 1024 * 1024
RAW_ARGV: Final = ("qjs", "--std", "/app/run.js")
"""The guest's arguments for a raw run of a script, with `qjs:std` and `qjs:os` available (`std`, `os` are globals)."""
STARTED: Final = "@@started@@"

CONTEXT: Final[dict[str, JsonValue]] = {
    "formId": "t",
    "form": {
        "id": "root",
        "type": "form",
        "configuration": {},
        "children": {"content": [{"id": "name", "type": "text", "configuration": {"label": "Name", "required": True}}]},
    },
    "values": {"name": "Ada"},
    "locale": "en",
}
"""A one-field context the real program accepts: `name` is required and given."""


def context(name: str | None = "Ada") -> dict[str, JsonValue]:
    """Return a one-field validation context; `name=None` leaves the value out (the field is then empty)."""
    values: dict[str, JsonValue] = {} if name is None else {"name": name}
    return {**CONTEXT, "values": values}


def budget(
    seconds: float,
    mib: int,
    *,
    stdout_cap: int = STDOUT_CAP,
    stderr_cap: int = STDERR_CAP,
    wait: float = 60.0,
    pool: PoolKind = PoolKind.VALIDATION,
) -> RunBudget:
    """Return a run budget of `seconds` wall time and `mib` MiB of guest memory, waiting long for a slot in `pool`."""
    return RunBudget(
        wall_seconds=seconds,
        memory_bytes=mib * MIB,
        stdout_cap=stdout_cap,
        stderr_cap=stderr_cap,
        wait=wait,
        pool=pool,
    )


def program_parts(job: GuestRun) -> tuple[bytes, bytes, tuple[str, ...], bytes, RunBudget]:
    """Return a Datum program run's parts: the program, the run script, the arguments, stdin and the budget.

    A fake runtime in a test reads a `GuestRun` back into the five things a Datum program run is made of.
    """
    return (
        job.app_files.get(APP_PROGRAM, b""),
        job.app_files.get(APP_RUN_SCRIPT, b""),
        tuple(job.argv),
        job.stdin,
        job.budget,
    )


def run_raw(
    runtime: GuestRuntime, script: str, run_budget: RunBudget, *, stdin: bytes = b"", argv: Sequence[str] = RAW_ARGV
) -> RunResult:
    """Run a script as `run.js` beside the real sandbox program, without the sandbox protocol."""
    return runtime.run(
        GuestRun(
            app_files={APP_PROGRAM: sandbox_program().data, APP_RUN_SCRIPT: script.encode("utf-8")},
            argv=argv,
            stdin=stdin,
            budget=run_budget,
        )
    )


def sandbox_run(
    runtime: GuestRuntime,
    nonce: str,
    run_budget: RunBudget,
    *,
    rules: Sequence[RuleModule] = (),
    payload: Mapping[str, JsonValue] | None = None,
    body: str | None = None,
    program: Program | None = None,
    entry: Entry = Entry.RUN,
) -> RunResult:
    """Run the sandbox as `SandboxService` does: the real `run.js` for these rules, the nonce and input on stdin."""
    used = program or sandbox_program()
    text = body or json.dumps(payload if payload is not None else CONTEXT, ensure_ascii=False, separators=(",", ":"))
    script = run_script(freeze_snippet(), rules, entry).encode("utf-8")
    return runtime.run(program_run(used.data, script, run_stdin(nonce, text.encode("utf-8")), run_budget))


def service(
    runtime: GuestRuntime,
    *,
    program: Program | None = None,
    limits: ProgramLimits | None = None,
    probe: AbiProbe | None = None,
) -> SandboxService:
    """Return a `SandboxService` over `runtime` with default host options (the real program unless one is given)."""
    return SandboxService(
        runtime, program or sandbox_program(), freeze_snippet=freeze_snippet(), limits=limits, probe=probe
    )


_STAND_IN: Final = (
    "globalThis.__datum_register = function () { return 0; };"
    "globalThis.__datum_run = function () { return %(answer)s; };"
    'globalThis.__datum_inspect = function (r) { var q = JSON.parse(r); var a = q.abi.split(".").map(Number); '
    'var p = "%(abi)s".split(".").map(Number); '
    "return JSON.stringify(a[0] === p[0] && a[1] <= p[1] ? { ok: true, op: q.op } "
    ': { ok: false, error: { code: "abi_mismatch", message: "older program" } }); };'
    '"sandbox-ready";\n'
)


def stand_in_program(abi: str = _ABI, answer: str = "JSON.stringify({ errors: [] })") -> Program:
    """Return a stand-in sandbox program that answers for `abi` and prints the JavaScript expression `answer` per run.

    Its `__datum_inspect` refuses a request naming a newer ABI than its own, as the real program does. With
    ``abi="0.9.0"`` and the default answer it is byte for byte the security suite's `stale-program.js`.
    """
    return Program(ProgramKind.SANDBOX, (_STAND_IN % {"abi": abi, "answer": answer}).encode("utf-8"))


# -- output producers --------------------------------------------------------------------------------------------------

LINE_BYTES: Final = 1024
"""One produced line: eight digits, 1015 `x` and a line feed."""


def producer_script(lines: int | None) -> str:
    """Return a script that prints `lines` numbered 1 KiB lines to stdout, or without end when `lines` is None."""
    head = "var tail = 'x'.repeat(1015);\n"
    if lines is None:
        return head + "for (var i = 0; ; i++) { print(String(i).padStart(8, '0') + tail); }\n"
    return head + f"for (var i = 0; i < {lines}; i++) {{ print(String(i).padStart(8, '0') + tail); }}\n"


def expected_prefix(size: int) -> bytes:
    """Return the first `size` bytes `producer_script` writes."""
    out: list[bytes] = []
    total = 0
    index = 0
    while total < size:
        line = (str(index).zfill(8) + "x" * 1015 + "\n").encode()
        out.append(line)
        total += len(line)
        index += 1
    return b"".join(out)[:size]


STDERR_PRODUCER: Final = "std.err.puts('y'.repeat(100000));\n"
"""A script that writes 100,000 `y` to stderr (past the 64 KiB cap) and nothing to stdout."""


# -- waiting and threads -----------------------------------------------------------------------------------------------


def settle(predicate: Callable[[], bool], timeout: float = 3.0, pause: float = 0.01) -> bool:
    """Poll `predicate` until it holds or `timeout` seconds pass; return whether it held."""
    deadline = time.monotonic() + timeout
    while True:
        if predicate():
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(pause)


def live_threads() -> set[threading.Thread]:
    """Return the Python threads alive now, without the placeholders Python makes for foreign native threads."""
    return {t for t in threading.enumerate() if type(t).__name__ != "_DummyThread"}


# -- golden inputs (ports of the conformance suite's golden-inputs and base-form fixtures) -----------------------------


def stable_json(value: object) -> str:
    """Return compact JSON with every object's keys sorted, as the TypeScript hosts' `stableStringify` writes it.

    Python sorts keys by code point and JavaScript by UTF-16 code unit; the golden inputs' keys are ASCII, where the two
    orders agree.
    """
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def golden_case_context() -> dict[str, Any]:
    """Return the golden case: a container, a 60-row grid, several error kinds, a document and the fold report."""
    form: dict[str, Any] = {
        "id": "root",
        "type": "form",
        "configuration": {},
        "children": {
            "content": [
                {"id": "name", "type": "text", "configuration": {"required": True, "maxLength": 5}},
                {
                    "id": "addr",
                    "type": "container",
                    "configuration": {},
                    "children": {
                        "default": [
                            {"id": "city", "type": "text", "configuration": {"required": True}},
                            {
                                "id": "pick",
                                "type": "select",
                                "configuration": {"options": [{"value": "a", "label": "A"}]},
                            },
                        ]
                    },
                },
                {
                    "id": "rows",
                    "type": "group",
                    "configuration": {},
                    "collection": {},
                    "children": {
                        "content": [
                            {"id": "sku", "type": "text", "configuration": {"required": True}},
                            {"id": "qty", "type": "number", "configuration": {}},
                        ]
                    },
                },
                {
                    "id": "tags",
                    "type": "checkboxes",
                    "configuration": {
                        "options": [{"value": "x", "label": "X"}, {"value": "y", "label": "Y"}],
                    },
                },
            ]
        },
    }
    rows = [{"sku": "" if i % 3 == 0 else f"s{i}", "qty": i} for i in range(60)]
    return {
        "formId": "f",
        "values": {
            "name": "toolongname",
            "addr": {"city": "", "pick": "zzz"},
            "rows": rows,
            "tags": {"x": True, "y": False},
            "stray": 1,
            "constructor": "c",
        },
        "locale": "en",
        "form": form,
        "document": {"b": 1, "a": [3, {"z": 1, "y": 2}], "10": 1, "2": 2},
        "logLevel": "debug",
        "reportFold": True,
    }


def valid_values() -> dict[str, Any]:
    """Return the control vectors' accepted answers (CTL-01) for the endpoint fixture form."""
    return {
        "name": "Ada Lovelace",
        "code": "AB1234",
        "addr": {"city": "Ottawa", "pick": "ok"},
        "tags": {"x": True, "y": False},
        "rows": [{"sku": "s1", "n": 1}],
    }


def control_values() -> dict[str, dict[str, Any]]:
    """Return the answers of CTL-01 to CTL-06: accepted, empty name, long name, bad code, stray keys, polluting keys."""
    valid = valid_values()
    return {
        "CTL-01": valid,
        "CTL-02": {**valid, "name": ""},
        "CTL-03": {**valid, "name": "x" * 41},
        "CTL-04": {**valid, "code": "abc"},
        "CTL-05": {**valid, "stray": "ZZSTRAYZZ", "constructor": "ZZCTORZZ"},
        "CTL-06": {
            **valid,
            "__proto__": {"polluted": "ZZPOLLZZ"},
            "constructor": {"prototype": {"polluted": "ZZPOLLZZ"}},
            "toString": "ZZTOSTRINGZZ",
        },
    }
