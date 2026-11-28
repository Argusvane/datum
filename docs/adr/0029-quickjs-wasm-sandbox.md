# ADR 0029: QuickJS/WASM Sandbox — real engine, portable kernel, plugin modules

## Status
Accepted.

## Context
The WASM validation seam is a versioned serialization boundary between a host and a validation
program (the ABI). Three requirements shape the real engine behind it:

1. **Portable server execution.** Target hosts are polyglot (Node.js, JVM, Python, isolated
   submission processors). A Java host cannot run engine TypeScript, so the schema and every
   piece of validate/sanitize logic must live *inside* the sandbox program, reachable through
   a string-in/string-out protocol.
2. **Validated data, not just errors.** On success the sandbox must return the submission, which
   may differ from what the form sent, because properties the schema does not define are
   silently stripped.
3. **Plugin validators in the sandbox.** Plugins the form uses must contribute custom
   validation that runs wherever the sandbox runs. A function-backed validator cannot cross a
   sandbox boundary.

Real WASM instantiation is asynchronous, so the host contract is asynchronous too.

## Decision

The contract, the kernel's judgements, the inspect operations, the limits and the version ranges
are specified in `docs/reference/sandbox-abi.md`; this record holds the choices behind them.

### Engine and packaging
- **`quickjs-emscripten-core` + `@jitl/quickjs-singlefile-mjs-release-sync`, pinned exactly and
  in lockstep.** The singlefile variant embeds the WASM binary as base64: no asset fetch, no
  Vite config, identical behavior in browser, Node and vitest. RELEASE_SYNC keeps evaluation
  synchronous; only module instantiation is async.
- The adapter lives in **`packages/quickjs-wasm-host`** (`@argusvane/datum-quickjs-wasm-host`).
  The engine keeps zero runtime dependencies; hosts inject the adapter the way they inject
  bindings and draft stores, and load it by dynamic import so the embedded binary stays out of
  the main bundle.

### The contract
`WASM_ABI_VERSION` names the contract between a host and the program; the version rule and the
current value are in `docs/reference/sandbox-abi.md`.

- **The context carries the schema root** (`form`), so the sandbox can sanitize and enforce
  schema-declared constraints on any host. It leaves out the browser-only members
  (`requiredComponents`, `inputStates`, `invalidComponents`, resolved grid bounds): the kernel
  works those out for itself, so no host can believe the sandbox honours a record it was handed.
- **The outcome is the error contract and the sanitized values.** `errors` carry `code`,
  `parameters`, `componentId`/`path`, never prose and never presentation, and `values` is present
  only when nothing blocked. Display is entirely the renderer's job, worded by code from the
  host's catalog. Every optional key is present only when it has something to say.
- **The unknown-key policy is a per-run choice** (`unknownFields`: `strip`, `keep`, `reject`),
  carried in the serialized context, so any host sets it at request time. `strip` is the default.
- **The program serializes its own outcome, in UTF-16 code-unit key order.** `localeCompare` is
  out: ICU collation differs between engines, and the ABI requires byte-identical serialization
  from QuickJS and V8.
- **External data is resolved by the host outside the sandbox** and injected as a serializable
  snapshot gated by `policy.allowedExternalDataKeys`; the sandbox never fetches. Choice options
  reach the kernel the same way, as `optionSnapshot`.
- **The document is digested in the program.** The context key `document` is the delivered
  document as the host received it, not rewritten. The outcome carries its `canonical` text and
  `digest`, whatever the verdict. The hash is computed before the compile, the fold and the
  validators, and validators never see `document`, so nothing in the run can change it. The
  engine's canonical serializer sorts the same way, so the browser and every host name one record
  by one digest.
- **`index` rows are built from the outcome's own sanitized values**, so no host rebuilds the
  index with its own reading of the schema.
- **Every run is observable.** After a successful or fail-closed run the runtime publishes
  `WASM_VALIDATION_COMPLETED` with the exchange, and telemetry can subscribe to it.

### Introspection: `__datum_inspect`
The program has a second entry point beside `__datum_run`, for what a host must know about a
definition before it serves or stores it, so a host that cannot run engine TypeScript ports
nothing. It is pure: the same request answers the same bytes on every host. A request of another
major ABI or a newer minor is `abi_mismatch`, one of no usable shape `invalid_request`, and
neither throws. A host that binds a program probes its ABI with an `__datum_inspect` request at
bind and refuses a program whose answer does not prove the version it was built for. The four
ops answer:

- `public`: the definition with every `run: "server-secret"` rule removed, wherever it is
  written, so a host serves nothing it must keep secret.
- `check`: the formula compile (ADR 0139) and the definition's structure, so a host refuses a
  definition at save or registration time instead of per submission. A definition past a size cap
  is answered with the size problems alone, before any formula is compiled, so the check cannot
  be made to cost more than it is worth. A problem's message is a fixed sentence built from the
  code and the limit, never from author text, and a problem at a journey or PDF site is redacted
  when a server-secret value is present.
- `inspect`: a static inventory of the rules, the plugins they need and every value path the
  kernel reads. It lists function names even for a secret rule, because that is how a host knows
  which rule modules to register.
- `test`: runs the form's tests on the kernel's reading (ADR 0154), so the engine's suite can
  hold the sandbox to the in-process bytes.

### The portable kernel (`validation/wasm/portable-kernel.ts`)
Self-contained, import-free, declaration-style functions that sanitize (derive known value paths
from the schema, strip unknown keys), enforce schema constraints (the exact semantics of
`createFieldConstraintsStage`), run plugin validators against the sanitized values, and return
the outcome. Because the core kernel already covers schema-declared validation, **a form using
only standard constraints needs no wasm plugin at all**.

The kernel runs in two places from literally the same source: the in-process reference adapter
calls the functions directly; the QuickJS adapter splices their `Function.prototype.toString()`
output into one evaluated program, with the entry points bound by `fn.name` so minifier renames
survive. The kernel deliberately re-implements the data-scope and field-constraint readings it
must not import; `engine/tests/portable-kernel.test.ts` holds the two readings identical, and the
package's parity tests require **byte-identical outcomes** between QuickJS and V8 for every
vector.

What the kernel judges is listed in `docs/reference/sandbox-abi.md`, "What the kernel judges".
The choices behind it:

- **One fold, shared with the browser.** Visibility, enabled and read-only state, requiredness
  (`configuration.required` OR `rules.requiredWhen`, ADR 0120), calculations, a journey's path
  and the hidden-value policies are decided by the fold before anything is judged, so a server is
  never stricter than the browser except where the author scoped a rule to the server (ADR 0178,
  ADR 0139). A field a journey places on no page is judged as the whole form judges it (ADR 0178
  decision 3), and a presentation's nodes place the form fields they reference (ADR 0121).
- **A key is known only by shape.** Entry indexes count only when canonical and right after a
  repeating section's collection path; nested posts are flattened a level at a time before the
  fold, so the allowlist, the option check and the constraints see one shape. Anything else is an
  unknown key and `unknownFields` decides it.
- **Answers are held to their kind** (ADR 0122) and to their bounds, attachments and counts.
  Format codes hold for a hidden answer still submitted; bounds and counts do not (ADR 0142).
- **Repeating sections and data grids are checked at each entry's key**, with the same codes and
  paths, and a grid's row count has a ceiling when nothing configures one (ADR 0153).
- **A choice answer is held to its options on every host**, on a hidden component too, so inline
  options and answer shape are enforced in the browser's in-process run as well. A source the
  snapshot lacks fails closed, and `data.answersFree: true` is the author's explicit opt-out
  (ADR 0037, ADR 0142).
- **Validators are untrusted at the seam.** A validator reads a deep-frozen copy of the values; one
  that throws blocks the run with its own code and the outcome, digest included, still comes back;
  one that returns no usable answer fails the run; an unknown severity blocks (ADR 0142).
- **Formulas are FEEL text compiled once per definition.** `formulaErrors` and `riskyPatterns`
  decide what a problem does (ADR 0139, ADR 0142). A `server-secret` rule's problems carry only
  where, the code and a fixed sentence, never the rule's text or an unknown function's name.
- **Structure is bounded before anything walks it.** Component depth, a journey's pages and routes,
  the error list, whole-text inputs and a run-log entry each have a cap, checked by an iterative
  pass or at the point of use (the wasi build of QuickJS traps at about 80 levels of recursion).
- **Regular expressions fail closed.** A pattern the risk analysis cannot follow but the engine
  accepts is risky, the analysis has a step budget so a long pattern is read in bounded time, and
  a pattern built at run time is refused unless the host allows it.
- **A journey reads the settled view.** An answer the fold withheld, and a component on a page the
  path skips, are no input to a calculation; the kernel and the browser run the same loop until the
  view settles, so a forged off-path answer derives nothing and steers no later page.
- **A client-derived answer is held to the rules like any other.** `clientDerived` lists the
  answers worked out in the browser and kept as sent, so a host knows which values the kernel could
  not reproduce.

### Async host contract
Instantiation and `run()` may be asynchronous: an adapter's `instantiate` may return a promise, an
instance may have `dispose()`, and `WasmValidationHost.create()` is the factory for an asynchronous
adapter (`docs/reference/sandbox-abi.md`, "The program and its limits"). `FormRuntime.submit()` awaits the wasm stage, uses
the returned sanitized values for everything downstream (server validation, hidden-value policy,
canonicalization), and **fails closed**: any sandbox or host failure becomes one blocking
`wasm.execution_error` rather than a rejected promise. Wasm and server stage errors are written to
the `ErrorStore` with `ERRORS_CHANGED` published; the renderer's existing pull model (summary and
inline field errors) does the rest.

### Core and plugins, wired at startup
A plugin contributes at most one **`wasmPlugin`** module (`{ id, version, source }` on
`FormPlugin`): an ES2020 program whose completion value is `{ validators?, functions? }`.
`functions` registers formula functions (ADR 0139). Unknown module keys are ignored, so a
contribution kind can be added without an ABI break. `PluginPlatform` collects the modules and the
host hands them to `createQuickJsValidationHost` once at startup. All installed plugins' modules
are wired for every form; there is no per-form selection.

### Trust model and limits
Plugins are **trusted first-party code**: the sandbox is a determinism and parity boundary, not a
defense against malicious validators, and Datum has no bundle signing. QuickJS provides no ambient
authority by construction (no fetch, filesystem, process or timers), and the program disables
`Math.random` and `Date`. The limits are safety nets against runaway code:

- **The deadline is wall-clock.** Left unset, `maxEvalMs` scales with the definition (a base, a
  charge per rule read and per kilobyte of definition, and a charge per kilobyte of each request),
  is capped, and is worked out once per definition; a host-set `maxEvalMs` is used exactly as
  given. The budget counts the paths the rules read, not a grid's rows times columns, so a host
  that validates big grids sets it itself.
- **Memory, stack and answer size are bounded**, and an answer longer than the cap is refused
  with nothing of it kept. A filler can cause it with `unknownFields: "reject"`, so the
  submissions service answers it as a typed 422.
- **A host blames the definition only when the guest did.** A host's classifier answers 422
  `definition.tooCostly` only when the guest itself reported an interrupt or an out-of-memory; a
  wall-clock limit, the output limit or an unavailable runtime stays a 503. A host may remember
  that verdict for a short time per definition, so repeated Saves do not each burn the time budget
  (the Spring Boot host does, `datum.forms.too-costly-memory`).
- **The program is one closure.** Everything the kernel needs (its functions, the prepared-definition
  cache, the plugin registries, the budget state, a local alias of every language global it reads)
  is a local no plugin can name. The only globals are `__datum_register`, `__datum_run` and
  `__datum_inspect`, non-configurable. A host takes hold of those three once, right after the
  program loads and before the freeze and any plugin module, and calls those handles. A module's
  top-level code can call `__datum_register` itself, append-only and before the first run, and
  cannot read, empty or reorder what is registered.
- **The language is frozen before any plugin loads.** `FREEZE_INTRINSICS_SNIPPET` freezes every
  object reachable from the global object, the three entry points included; the global object
  stays extensible so a plugin may define globals of its own. Every global data property becomes
  non-writable and non-configurable, and the snippet makes that hold on both engines: before the
  freeze it puts guarded `Object.defineProperty`, `Object.defineProperties` and
  `Reflect.defineProperty` in place, which refuse a change to a non-configurable own property of
  the global object as the language does (a `TypeError`, or `false` from `Reflect`), and `Proxy`
  refuses the global object as its target. `freezeIntrinsics: false` is the documented opt-out for
  a plugin that must patch a built-in. A host that embeds the program itself evaluates the same
  snippet at the same point.
- **A server gives every call a fresh sandbox, on its own thread** (ADR 0181).
- **There is no bundle signing** (`plugin.manifest.json.signature` is a reserved field). The
  `security:wasm-sandbox-isolation` gate verifies the no-ambient-authority guarantee, not a
  hostile-code boundary; the conformance suite (ADR 0151) attacks the rest.

## Reasoning
- **QuickJS in WASM, not a JS library or a native binding.** One binary runs identically in a
  browser, Node, vitest and any host that can run a WASM runtime.
- **The kernel is spliced source, not a bundle.** The same functions must run in V8 and QuickJS,
  and a server host must receive them as one text. Declaration-style, import-free functions
  survive `toString()`; that is why the kernel duplicates the data-scope and constraint readings
  and a parity test holds them together.
- **No compatibility shims in the ABI.** The program speaks one contract, and the host's version
  check makes drift loud.
- **A sandbox failure blocks.** Passing a submission because the check could not run is the
  failure the gate exists to prevent (ADR 0142).
- **A closure and a deep freeze, not property attributes alone.** Bellard's QuickJS (the
  quickjs-emscripten build) lets `Object.defineProperty(globalThis, name, { value })` replace a
  global whatever its attributes, while quickjs-ng refuses. The kernel therefore reads no global
  at all, and the guarded define functions make the attributes hold for the plugin modules, which
  do read globals, on both engines. Armed state in a shared sandbox could otherwise change every
  verdict after it, which is why a server also isolates each call (ADR 0181).
- **A key is known only by shape.** Taking every `[n]` out of a submitted key before comparing it
  with the definition's value paths let `province[0]` beside `province`, `items.sku` with no
  index and `items[0][1].sku` pass as known, and a host storing the sandbox's values stored them.
- **The inspect ops are pure and the check is bounded.** A host calls them at save time with
  author-controlled input, so the answer must not depend on the host and must not be a way to
  spend the server's time.
- **Plugins are trusted first-party code.** A defense against hostile validators would need
  bundle signing, which Datum does not have; the sandbox's job is parity and bounded resources.

## Consequences
- The sandbox is delivered for the browser and made portable by construction: any server host
  (Node, JVM + QuickJS, wasmtime) runs the same program over the same string protocol and
  produces byte-identical outcomes.
- Parity is not tautological: browser (V8, in-process) and wasm (QuickJS) differ in engine, and
  the vectors hold them identical.
- The submission the platform accepts is schema-bounded: unknown properties cannot ride through
  submit once a wasm host is configured.
- The kernel's duplicated readings (data-scope, constraints) are a standing maintenance cost, held
  in check by parity tests that fail loudly on divergence.
- A host's program must speak the ABI the host expects; a program below the floor is refused at
  start rather than judging by other rules.
