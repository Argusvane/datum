"""The `run.js` a sandbox run executes, and the guest's arguments.

One function, so what it holds is out of the rule modules' reach. It reads stdin (the run's nonce, a line feed, then the
input) and keeps `std`, `print`, `eval`, the entry point and the registration function in locals; removes `std`, `os`,
`print`, `console`, `performance`, `scriptArgs` and `bjson` from the global scope, and the extras quickjs-ng adds that
the page's engine does not have (`queueMicrotask`, `gc`, `navigator`, `argv0`, `execArgv`, `atob`, `btoa`,
`DOMException`), failing the run if one stays (the ES-standard `DisposableStack`, `AsyncDisposableStack` and
`SuppressedError` stay, under the freeze);
evaluates the freeze snippet (the engine's `FREEZE_INTRINSICS_SNIPPET`, shipped as `freeze-intrinsics.js` by
argusvane-datum-programs and never copied here), so the kernel and the intrinsics are read-only to what follows; prints
the started marker; evaluates each rule module as a global expression and registers it, in order; calls the entry point;
and prints the answer between the begin and end markers.

The order is the hardening: the entry point and the registration function are captured before the globals are removed (a
module that redefines `__datum_run` changes nothing), the globals are removed and the intrinsics frozen before the
started marker, and every module is registered after it. A rule module therefore cannot reach stdin, `print` or `std` by
name, nor print a verdict without the nonce; it can still import `qjs:std`, so it is host-trusted code, and the strict
frame refuses anything it prints.

The PDF program registers no untrusted module, so its script is one line with no nonce frame (`PDF_RUN_SCRIPT`).
"""

import enum
import json
import re
from collections.abc import Iterable
from dataclasses import dataclass
from typing import Final

from datum_sandbox.wasi import GuestRun, RunBudget

APP_PROGRAM: Final = "program.js"
"""The program's name inside the run's read-only `/app`."""
APP_RUN_SCRIPT: Final = "run.js"
"""The run script's name inside the run's read-only `/app`."""

REMOVED_GLOBALS: Final = (
    "std",
    "os",
    "print",
    "console",
    "performance",
    "scriptArgs",
    "bjson",
    "queueMicrotask",
    "gc",
    "navigator",
    "argv0",
    "execArgv",
    "atob",
    "btoa",
    "DOMException",
)
"""The globals the script removes before any module is evaluated, in the script's order: the host's, then the extras
quickjs-ng has and the page's engine does not."""

PDF_RUN_SCRIPT: Final = "__datum_pdf(std.in.readAsString()).then((json) => print(json));\n"
"""The PDF program's script: qjs runs the pending jobs after the script, so the promise settles before it exits."""

_LABEL_DROP: Final = re.compile(r"[^A-Za-z0-9_.@-]")


class Entry(enum.StrEnum):
    """Which entry point of the sandbox program a run calls."""

    RUN = "run"
    """`__datum_run`: a validation."""
    INSPECT = "inspect"
    """`__datum_inspect`: a question about a definition (ABI 2.8.0)."""


@dataclass(frozen=True, slots=True)
class RuleModule:
    """A rule module: an ES2020 program text whose completion value is ``{validators: [...], functions: {...}}``."""

    id: str
    version: str
    source: str


def guest_argv() -> tuple[str, ...]:
    """Return the guest's arguments: `--std` gives the script `std` (which it removes); `-I` runs the program first."""
    return ("qjs", "--std", "-I", f"/app/{APP_PROGRAM}", f"/app/{APP_RUN_SCRIPT}")


def program_run(program: bytes, script: bytes, stdin: bytes, budget: RunBudget, *, timed: bool = False) -> GuestRun:
    """Return the one `GuestRun` of a Datum program: `/app/program.js` and `/app/run.js`, the guest's arguments, stdin.

    The two names are the program and run script `guest_argv` passes to qjs, byte for byte; nothing else is in `/app`.
    """
    return GuestRun(
        app_files={APP_PROGRAM: program, APP_RUN_SCRIPT: script},
        argv=guest_argv(),
        stdin=stdin,
        budget=budget,
        timed=timed,
    )


def _freeze_lines(freeze_snippet: str) -> list[str]:
    text = freeze_snippet
    # A generated file may end with a line break, which is not a line of the script; nothing else is touched.
    while text.endswith(("\n", "\r")):
        text = text[:-1]
    if not text.strip():
        # Never optional: without the freeze a module could rebind a kernel function for the rest of the run.
        raise ValueError("the freeze snippet is empty: rebuild the program assets (npm run fastapi:assets)")
    return text.split("\n")


def _label(module: RuleModule) -> str:
    """Return a module's comment label: ASCII letters, digits, `_`, `.`, `@` and `-` only (no line can end)."""
    return _LABEL_DROP.sub("", f"{module.id}@{module.version}")


def _literal(source: str) -> str:
    """Return the module's source as an ASCII-only JSON string literal.

    Every character, a lone surrogate included, reaches `eval` unchanged, and U+2028 or U+2029 never end a script line.
    """
    # The parentheses make the source an expression; the line feeds keep a trailing line comment from swallowing ")".
    return json.dumps("(\n" + source + "\n)", ensure_ascii=True)


def run_script(freeze_snippet: str, modules: Iterable[RuleModule] = (), entry: Entry = Entry.RUN) -> str:
    """Return the sandbox `run.js` for these rule modules, registered in the order given, calling `entry`."""
    registrations: list[str] = []
    for module in modules:
        registrations.append("  // " + _label(module))
        registrations.append("  register(evaluate(" + _literal(module.source) + "));")
    lines = [
        "(function (std, print, evaluate) {",
        '  "use strict";',
        "  var raw = std.in.readAsString();",
        "  var nonce = raw.slice(0, 32);",
        '  if (raw.charAt(32) !== "\\n" || !/^[0-9a-f]{32}$/.test(nonce)) { throw new Error("no run nonce"); }',
        "  var input = raw.slice(33);",
        f"  var entry = globalThis.__datum_{Entry(entry).value};",
        "  var register = globalThis.__datum_register;",
        (
            '  if (typeof entry !== "function" || typeof register !== "function") '
            '{ throw new Error("no sandbox program"); }'
        ),
        "  [" + ", ".join(f'"{name}"' for name in REMOVED_GLOBALS) + "].forEach(function (name) {",
        "    delete globalThis[name];",
        '    if (name in globalThis) { throw new Error("cannot remove " + name); }',
        "  });",
        *_freeze_lines(freeze_snippet),
        '  var mark = function (kind) { return "@@datum:" + nonce + ":" + kind + "@@"; };',
        '  print(mark("started"));',
        *registrations,
        "  var answer = entry(input);",
        '  print(mark("begin"));',
        "  print(answer);",
        '  print(mark("end"));',
        "})(std, print, eval);",
    ]
    return "\n".join(lines) + "\n"
