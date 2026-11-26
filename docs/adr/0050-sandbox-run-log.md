# ADR 0050: The sandbox run log

## Status

Accepted.

## Context

The validation sandbox has no console. QuickJS provides no ambient authority and the program
disables what determinism forbids (ADR 0029), so a rule that calls `console.log` throws (in the
browser as a fail-closed `wasm.execution_error`, in a Python host as a `JSException`) and nothing
inside a run could say what it did. A host sees the outcome and the duration, and no more. With
rules of a page's own running in the sandbox (ADR 0046), and the same program re-run by a server,
"why did this submission fail" needs an answer from inside the run: which keys were stripped,
which constraints tripped, what each rule looked at and decided.

A host callback (`add_callable` in the Python binding, `newFunction` in QuickJS-emscripten) could
stream lines live, but every host would have to bind it, a missing binding would break a rule, and
it hands rules a side channel. The program's one-directional string protocol is what makes a JVM or
a Python process a valid host with an `eval` and a call; the log had to keep that.

## Decision

1. **A per-run log, returned with the outcome.** The kernel creates a log for each run and offers it
   to validators as `context.log` with `debug`, `info`, `warn` and `error`. Each call appends
   `{ level, message, data? }` to an array, which `__datum_run` returns as `logs` beside `errors`
   and `values`. The host reads it after the run and forwards it to a logger of its own.
2. **The kernel logs its own steps**, not only the rules, so "step by step" covers the kernel too.
3. **A threshold per run, off by default in effect.** The context carries `logLevel` beside
   `unknownFields`; the kernel keeps entries at or above it. The default is `warn`, so a run that
   behaves records nothing and `logs` is absent from its outcome. Below the threshold a call costs
   one comparison, so debug lines in production rules are free.
4. **Plain data, no clock, capped.** `data` must be plain data, with nothing an engine formats
   differently, so the same run yields the same log on V8 and QuickJS and the parity tests compare
   logs at every level. The sandbox has no `Date`, so entries carry no timestamps; the host stamps
   the batch. A run keeps a bounded number of entries and each entry is bounded in size.
5. **Both keys are optional**: `logLevel` in the context, `logs` in the outcome. The runtime, the
   element and `createFormRuntime` each take the level.
6. **Not a callback.** The log is returned, never streamed, and rules must not depend on anything
   beyond `context.log`.

The levels, the entry caps and the names of the settings are in `docs/reference/server-runs.md`,
"The run log".

## Consequences

- Rules read like `context.log.debug("phone contact", { method, country, offered })`, and the same
  line lands in the browser's event log and a Python server's logger, in the same order, with the
  same data.
- The log arrives after the run, not during it. A run is synchronous, so the order is the record. A
  program that takes seconds (the PDF kernel reports through `warnings` the same way) would need a
  callback to stream, which this contract does not have.
