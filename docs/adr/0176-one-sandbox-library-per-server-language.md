# ADR 0176: One sandbox library per server language for the WebAssembly programs

## Status

Accepted.

## Context

Every capability of a server host that runs a Datum program (validating an answer, checking a
definition, rendering or signing a PDF) needs the same work done once and done hard: find and choose
a WebAssembly engine, run a guest with budgets and a read-only file system, speak the nonce-framed
run protocol, prove the programs' ABI at start, bound the slots and the runs that outlive a stop, and
tell an operator what happened. Without one place for that work, the hardening drifts and the clamps
and the state have no single place to be read from.

- **JVM.** A capability that did that work itself, or reached into another capability's runtime for
  it, would put the hardening in two places, and a framework binding (Spring, ADR 0152) would have
  to repeat the wiring.
- **Python.** Spread over the framework-free composition root, the work could not be used by a second
  Python framework without the rest of the host.

The guides are [docs/spring.md](../spring.md) ("The sandbox as a library", "Engines", "Diagnostics")
and [docs/fastapi.md](../fastapi.md) ("Engines", "Diagnostics", "Using the sandbox without the
host"), which hold the engine seam, the lifecycle and the diagnostics keys; the JVM host's module map
is in `integrations/jvm/README.md` ("Layout") and docs/spring.md ("The sandbox as a library"), and
[ADR 0152](0152-a-spring-boot-host-as-capability-modules-on-shared-jvm-libraries.md) holds the
capability split above it. The two languages make the same split with their own shapes.

## Decision

All of the WebAssembly work of a server language lives in one framework-free library: `datum-sandbox`
(`com.argusvane.datum.sandbox`) on the JVM and `argusvane-datum-sandbox` (`datum_sandbox`) in
Python. A capability asks it for a `Sandbox` (validation) or a `PdfKernel` and knows nothing of
engines, slots, strays, nonces or ABI floors. A framework binding (on the JVM) or a host (in Python:
the framework-free `datum_core`, and through it the FastAPI binding) maps its configuration onto one
settings value and adapts the status, the events and the observation.

### 1. Two layers, one boundary test

Each library has two layers: a generic hardened WASI run that imports no Datum type, and the Datum
run protocol built on it.

**The generic run.** A run is a guest run: an ordered name-to-bytes map that becomes the only files
under a read-only `/app`, the arguments, the standard input and a budget. A guest runtime runs it and
answers how it ended and every byte written up to the caps. The engine-neutral half of a run is a
harness (`RunHarness`); an engine implements only `GuestEngine`, and a `GuestRuntimeProvider` seam
discovers and selects it (JVM: `ServiceLoader`; Python: the `datum.guest_runtimes` entry-point
group, where a runtime may also say which pools it serves).

- **JVM (`.wasi`).** The layer's refusals are one small unchecked family (`WasiException`: a run
  that cannot start, limits an engine cannot honour, an engine that cannot be selected), which
  the layer above translates once into the exceptions and wire codes the hosts share. The guest gets
  no real wall clock and no real randomness (`GuestIo`): the realtime clock and the file times of
  `/app` read the Unix epoch, and `random_get` reads the same seeded stream (the pinned qjs-wasi
  does not import it), on every run, so
  QuickJS's own `Math.random`, which it seeds from the realtime clock, repeats too. The monotonic
  clock stays the engine's (Endive reads it from `System.nanoTime()` with no option to replace
  it): it times sleeps and timers and tells a guest how long it has run, never the date.
- **Python (`datum_sandbox.wasi`).** Imports only the standard library. Each file name is one plain
  file name and the arguments are checked (a bare string is refused). The run directory is private
  (0700) and made read-only before the engine sees it. The layer's refusals are its own
  (`WasiError`, `EngineConfigurationError`, `MemoryFloorError`, `EngineSelectionError`,
  `GuestUnavailableError`).

**The Datum protocol** (JVM `.protocol`, Python `datum_sandbox.protocol`) holds the program and its
store, the run script and the nonce frame, the strict answer reading, the ABI gate, the slots, the
sandbox and PDF services and the decorator seams. The program and `run.js` become the `/app` files,
and the nonce rides on stdin. In Python the strict JSON reader (`datum_sandbox.json`) and the
start-up check record and refusal (`datum_sandbox.checks`: `DatumCheck`, `DatumConfigurationError`,
the runtime's own checks W008, E003, E004) are the library's, because the protocol reads and
raises them; the host's own checks stay the host's.

**The boundary.**

- **JVM.** A boundary test (`LibraryBoundaryTest`) holds `.wasi` to the JDK, SLF4J, JSpecify, Jimfs
  and itself. That is what keeps the layer reusable by any host that wants a hardened WASI guest and
  no Datum program.
- **Python.** import-linter contracts hold `datum_sandbox.wasi` to the standard library and itself,
  keep the layers running downward (`wasi` at the bottom, then `checks`, `json` and `loggers`, then
  `protocol`, `diagnostics`, `runtime`, and `aio` and `testing` on top), keep the whole library free of any other Datum distribution,
  framework, settings loader and OpenTelemetry, and hold the engine to the WASI layer alone. CI runs
  those contracts and each member's `deptry` before the suites, and a test of the library reads its
  own sources for the same rules, so the member's tests alone catch a Datum or third-party import in
  `wasi` and a `datum_core` import anywhere in the library.

### 2. The runtime, its settings and its lifecycle

The settings are one immutable tree (engine, lifecycle, the validation and PDF runs, programs, host
context, diagnostics) that holds every clamp, so a host on any framework clamps the same way. The
property keys are the `datum.runtime.*` and `datum.host.*` names every host shares, so an operator
reads one vocabulary on every host. `explain()` returns a `SettingsReport`: every key with its
effective value and its source (default, configured, clamped from a value to a bound, or replaced
because the application supplied that input in place of the setting). The startup log and the
management read the same report, so what an operator is told is what the sandbox runs with.

The lifecycle object is `DatumSandbox`. It needs no framework. It builds, starts (selects the
engine, loads and pin-checks the programs, proves the ABI, warms up), reports `status()`,
`recheck()`s and `stop()`s, serving the `Sandbox` and the `PdfKernel`. `SandboxStatus` says up or
down with details and names no web type; the binding adapts it.

- **JVM.** `DatumSandbox` (`.runtime`) is `AutoCloseable`, built by `DatumSandbox.builder()`; with
  no runtime given it selects the engine by `SandboxSettings.engine().id()` (default `endive`) and
  uses the packaged programs. Each packaged file it reads (the freeze snippet, and each program not
  overridden) must be listed in datum-programs' `programs.json` with its sha256 and have the sha256
  datum-sandbox was built with: the build copies the same generation's `programs.json` into
  datum-sandbox's jar (`ProgramStore.PINS`), as datum-sandbox-endive's holds `qjs-wasi.wasm` to
  `qjs.sha256`. A missing description, an unlisted file or missing pins stop the start
  (`ProgramUnavailableException`); a `datum.runtime.programs.*` override is listed nowhere and is
  proved by the ABI probe. The bytecode gate lives here: an engine that reports mode `bytecode`
  stops the start unless `allow-bytecode`, before any program is proved, for an application's own
  runtime as for Endive.
- **Python.** `DatumSandbox(settings, *, runtime=None, sandbox=None, ...)` is a context manager.
  `SandboxSettings.build(**values)` holds every value to its bound in one place: a budget outside its
  bound moves to the nearest one with a `datum.W008` check; what cannot be clamped refuses the build
  with a `DatumConfigurationError` naming the key. `datum.host.unknown_fields` and `log_level` are
  kept in the same tree for the host, whose submission service reads them; the sandbox itself
  reads the other three host words. A host maps its own configuration onto the keyword names and
  passes only what was set, so the report can tell a default from a value. A refusal of the
  configuration stops the start whatever `fail_fast` says; any other failure stops it with
  `fail_fast`, or leaves it down until a recheck. The engine layer's refusals are translated once,
  keeping their words (a memory floor is the `datum.E003` check). The PDF program runs only on a
  runtime whose report answers and that serves the PDF pool, so a runtime that cannot vouch for the
  engine never runs it; the `pdfCapable` health detail is that decision. The library is synchronous
  (a run blocks its thread); `datum_sandbox.aio` (the `aio` extra) awaits every call off the event
  loop.

### 3. Engines are separate modules

An engine is its own module behind the provider seam, and the library has no engine of its own (none
on the JVM class path), so a host chooses what it ships, and a second engine would be one more module.
A kit is what an engine's tests bind: the engine's own tests implement the `WasiHardeningContract`
against the generic run alone and the protocol contracts against the real programs.

- **JVM.** The engine is `datum-sandbox-endive` (with the selectors `-jffi` and `-panama`); the kit
  is `datum-sandbox-tck`. QuickJS-ng checks no stack under WASI and its C stack is a fixed 64 KiB
  above the module's statics, so the engine's build compiles the pinned module rewritten after the
  pin check: every `global.set` of `__stack_pointer` traps outside the stack (`StackGuardRewrite`),
  and a module the rewrite cannot decode exactly fails the build rather than compiling unguarded. Each run arms a canary over the stack's lowest bytes and
  reads it, with `.rodata`, after `_start` (`StackGuard`); a run that reached the floor is a trap.
- **Python.** The engine is the distribution `argusvane-datum-sandbox-wasmtime`; the kit is
  `datum_sandbox.testing` (the `testing` extra).

### 4. The framework binding and the host

- **JVM: one binding.** `datum-sandbox-spring` is the only Spring binding of the library:
  `datum.runtime.*` and `datum.host.*` mapped onto `SandboxSettings`, the engine and `DatumSandbox`
  beans, the lifecycle (the start, and a stop after the web server's drain), the `runtime` health
  check, the `datum` actuator section, the failure analyzers, the memory-budget start-up check and
  the replacement decorators. `datum-submissions-spring` and `datum-pdf-spring` depend on it.
  `datum-submissions` and `datum-pdf` depend on `datum-sandbox` and not on a runtime reached through
  each other; `datum-pdf` keeps `datum-submissions` for its HTTP facade only (`pdf.api` judges
  `POST /pdf` answers through the receiver, the throttle and the host context), which is form logic
  and not WebAssembly.
- **Python: the host over the library.** `datum_core.Datum` builds one `DatumSandbox` per start from
  `sandbox_settings(config)` and every seam it was given (the application's runtime or sandbox,
  middleware, the run log, the trace and capture sinks), passes its observation as the innermost
  decorator and its start-up budget as the phase timer, publishes `DatumRuntimeReadyEvent` from the
  sandbox's ready record, and adapts `SandboxStatus` to the `runtime` health component with its keys
  unchanged. The FastAPI binding adds only what is FastAPI's: the settings loader and the management
  router, whose `info` answer carries the settings report under `settings` without any value that
  names a path of the host.

### 5. Diagnostics

Three tools, all off the hot path and none able to change a run's answer.

- **The run trace** (`datum.runtime.diagnostics.trace` = `off`, `failures` or `all`): one structured
  line per run on the logger `datum.sandbox.trace`, or any `RunTrace` the host supplies. Each text
  value is reduced to letters, digits, `.`, `_` and `-` so nothing can split the line, and the line
  carries lengths, never an answer, a definition or the run's nonce. It is called on the run's own
  thread after the run's slot has been released, so a slow trace never holds a slot. With the trace
  and the capture off, a run pays one null check.
- **The settings report** (`datum.runtime.diagnostics.report`, on by default): the block from
  `explain()` logged once at INFO on `datum.sandbox.settings` before the programs are proved, with
  the engine's id, release, mode and notes and each program's sha256 and ABI. A URL's user
  information and its query values are masked everywhere. The management read serves the report as
  JSON under `settings`, minus anything that names a path of the host.
- **The failed-run capture** (`datum.runtime.diagnostics.capture.*`, off by default): for a failed
  run it keeps `stdin.bin`, `stdout.bin`, `stderr.bin`, `run.js` and a `meta.json` so the run can be
  replayed outside the host.

**What counts as failed.** Every word the protocol ends a run with except two: `verdict` (the program
answered and the protocol took the answer) and `refused` (the program answered with a refusal of its
own: an inspect or PDF answer with `ok: false`). Everything else is a failed run: a budget, memory
or trap end, a non-zero exit, an output cap, a malformed or missing outcome, a broken frame, an
interrupt, a run that passed its budget and would not stop (the outcome `budget`; the JVM trace
says `termination=stuck`), and a runtime that could not start the run or refused it past the stray
bound (both hosts: 503 `server.unavailable` with no `Retry-After`, the word `unavailable`). The
caller of the run that would not stop gets 503 `wasm.execution_error` on both hosts, as for any
budget stop. The outcome is read after the protocol's last
check, so an answer the protocol refuses after the run (a PDF answer whose `ok` is not a boolean) is
`no_outcome`. A run refused because no slot was free, or before it was made (a definition too deep,
input that is not JSON), makes no run and no line. The words are listed in docs/spring.md
("Diagnostics").

**The capture's threat model.** A capture holds the submitted answers and the form definition in
clear text on disk. That is why it is opt-in, why the start logs one WARN saying so, and why the
directory is checked before the first byte is written:

- The default sink (`DirectoryCaptureSink`) needs a POSIX file system; Windows and ACL-only file
  systems are refused, because there is no permission story to check.
- A missing directory is created `0700` as it is made, never `chmod`ed after. It must be a real
  directory, not a link, owned by the effective user of the process, with no group or other
  permission bit. Any failure refuses the start and names `diagnostics.capture.directory`.
- On macOS the JDK and `os.stat` read no ACL, and an access-control entry (one inherited from the
  parent included) opens every capture file to others whatever the mode says, so the sink asks
  `/bin/ls -lde` (an absolute path, no shell, `--` and the directory as one argument, a timeout,
  bounded output) at open and before every write; a check that cannot run or whose answer does not
  parse refuses (fail closed).
- The directory is checked again before every write. On the JVM this is the same directory by file
  key, a best-effort check by path and not a handle: what makes a swap harmless is that every file
  is created `0600`, `CREATE_NEW`, by the JVM's user. In Python every file is made through the
  directory's handle (`dir_fd`), so a path swapped after the open is never followed.
- A capture is written into `.partial-<id>` (`0700`), every file created `0600`, exclusively and
  without following a link (JVM `CREATE_NEW`, `NOFOLLOW_LINKS`; Python `O_CREAT | O_EXCL |
  O_NOFOLLOW`) and forced to disk (Python: synced) before the rename; then the directory is
  renamed to `<id>` in one atomic move, so a directory with a capture's name is always complete. Eviction renames `<id>` to `.evict-<id>`
  before deleting, follows no link, and touches capture-named directories only. A leftover
  `.partial-*` or `.evict-*` is never removed automatically; the start WARN counts them and says to
  remove them by hand.
- The capture is bounded (what is kept, what waits to be written); a capture that does not fit is
  dropped and counted, and a write that fails is counted, with a WARN at most once a minute naming
  the capture id and the exception class, never a path or a message. Bounds below 1 refuse the
  start; nothing clamps.
- The run never waits and is never changed: the capture is assembled and queued on the run's thread
  after its slot is released, and one daemon writer thread writes it. Whatever the sink or the trace
  throws is logged and the run's answer stands.
- A start refuses while an earlier writer for the same destination is still alive, so two writers
  never share the bookkeeping of one store.
- `stop()` keeps one deadline: the runs get the shutdown grace and the capture drains in what is
  left, then the queue is dropped and counted. The two languages differ on a start that fails: in
  Python its capture drains within the grace too, so the failed runs that made it fail are kept; on
  the JVM the writer is stopped and the capture takes nothing. A host that stores captures elsewhere supplies a
  `RunCaptureSink` and keeps the bounds, the queue and the one writer thread.

The sink's mechanics are in docs/spring.md and docs/fastapi.md ("Diagnostics"), and in
`DirectoryCaptureSink` and the Python `_capture.py`.

## Reasoning

- **One library over a runtime inside each capability.** The hardening (the frame, the caps, the
  stop, the gate) is the part that must not drift. In one place it is read once and a second
  framework binding is wiring. In Python the library sits beneath the host, because the composition
  root holds every capability and all of them need it; the strict reader and the check record come
  down with the protocol that raises them, instead of a third distribution for two modules.
- **Two layers over one.** The WASI run is useful and testable with no Datum program, and the boundary
  test or contract makes "the generic run learned a Datum word" a failing build.
- **Engines outside the library.** Endive's compiled class is the heavy, version-bound part; a host
  that wants a different engine, or none in a test, does not pay for it.
- **Pools, not a PDF flag (Python).** Whether a runtime can serve a kind of run is a generic fact (the
  pools it serves); what a PDF run needs is the protocol's decision over that fact.
- **Keyword-only constructors and a sync core (Python).** The Python idiom for a value with many
  optional inputs is a keyword-only constructor; a sync core with a thin async facade serves sync and
  async frameworks alike.
- **The same property keys.** The keys are the vocabulary every host shares, so the language's own
  types are free to follow the code.
- **Capture as a separate, bounded tool.** A trace answers what happened and is safe to leave on.
  Whether a failure can be replayed needs the bytes, which are personal data; so those sit behind an
  explicit switch, a hardened directory, bounds and a loud WARN, and never touch the run's thread or
  answer.
- **No command-line tool.** The report and the trace are in the log and the actuator the operator
  already reads.

## Consequences

- A host without a framework runs the programs with `DatumSandbox.builder().build()` on the JVM or
  `DatumSandbox(...)` in Python, and a second Python framework's binding maps its settings and adapts
  the status, and does nothing WebAssembly.
- An engine is held to the same guarantees by `WasiHardeningContract` whatever the program on top.
- The capture on macOS runs one `/bin/ls` per captured failed run, on the writer thread.
- A capture directory is the operator's to protect and to empty: the sink bounds it and hardens it and
  does not encrypt it.
