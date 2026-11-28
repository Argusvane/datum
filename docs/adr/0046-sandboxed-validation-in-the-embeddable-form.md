# ADR 0046: Sandboxed validation in the embeddable form

## Status

Accepted.

## Context

The embeddable bundles (ADR 0038) leave the QuickJS/WASM sandbox (ADR 0029) out: the embedded
binary is the wrong price for a page that wants a form on it, and field constraints validate
in-process regardless. The sandbox is an opt-in attribute loading a separate file of the module
build, never part of the single-file classic script, the same line ADR 0045 draws for the PDF
kernel (`datum-pdf.js`, fetched by `pdf="auto"`).

A page embedding `<datum-form>` otherwise has no way to run a rule the builder cannot express (a
name needs two words; phone contact depends on the country) other than checking the envelope after
`datum-submit`, outside the form's own error model. The engine's sandbox is exactly that facility:
plugin validators as portable programs, run over the sanitized values, returning the error contract
the renderer already displays, to the same verdict wherever the program runs.

## Decision

1. **A module of its own: `dist/datum-wasm.js`.** `src/wasm.ts` exports
   `createWasmValidationHost(plugins, options)` over `@argusvane/datum-quickjs-wasm-host`'s
   `createQuickJsValidationHost`, with `certifyWasmPlugin` and `toSourcePlugin` beside it. Built as
   an ES module only, like `datum-pdf.js`; the binary is embedded, so it is one file. The engine's
   surface is unchanged.
2. **`<datum-form wasm>`.** `"auto"` loads the module from beside the bundle, else a URL
   (`wasm-loader.ts`, one load per URL, shared by every element on the page); absent, nothing
   changes. The element wires the module with the page's `wasmPlugins` and gives the runtime
   `wasmExternalData`, a snapshot or a function resolving one per submit, as its
   `wasmExternalDataProvider`. A page that imports the module itself assigns `wasmValidationHost`:
   a host, or a promise of one. `datum-wasm-ready` reports the sandbox in place; a module that
   cannot load is reported as `datum-error`. `docs/reference/server-runs.md`, "Validate in the
   sandbox", shows the wiring. `wasm-integrity` (`wasmIntegrity`) holds the module to a
   Subresource Integrity hash: the element fetches it, checks its bytes, and imports exactly those
   bytes from a `blob:` URL, which the module can be imported from because it is one file. A module
   that does not match is never run, and a submit fails closed as for any sandbox that cannot load.
   The package's `integrity.json`, beside `dist`, lists the sha384 of every file in `dist` a page can load.
3. **The runtime is built with a deferring host, and never rebuilt for the sandbox.** Whenever the
   element has a way to a sandbox (`wasm` set, or `wasmValidationHost` assigned) the runtime gets a
   `WasmValidationHost` subclass whose `run` defers to whichever sandbox the element resolves at
   that moment. So the module loads in the background from `datum-ready` on; a submit before it
   arrives waits for it rather than skipping it; the sandbox landing later rebuilds nothing (a
   rebuild starts a new runtime, which loses what only the old one held, such as the errors on
   show); and a new `wasmPlugins` list takes effect on the next submit.

   Only the way to a sandbox appearing or going rebuilds the runtime, as a change of data sources
   does. `createFormRuntime` takes the three engine dependencies (`wasmValidationHost`,
   `wasmExternalDataProvider`, `wasmPolicy`) for a page wiring its own.
4. **Fail closed, as the engine does.** A sandbox that cannot load or run blocks the submission
   under `wasm.execution_error` (ADR 0029) rather than passing it without the stage; the page's
   messages word it. The strict policy stands. The element sets no `allowedExternalDataKeys`:
   what the page's own provider returns is what crosses, and a page that wants an allowlist passes
   `wasmPolicy` to `createFormRuntime`.
5. **The classic script may load it too.** `import()` and `import.meta.url` work from a classic
   script, so `datum-form.iife.js` with `wasm="auto"` fetches the module the same way; the sandbox
   is never inlined. `check-bundles.mjs` holds the line: `datum-wasm.js` carries the sandbox
   program, and no other bundle, chunk or classic script does.
6. **The program ships as a file for other hosts.** `npm run build` also writes
   `dist/datum-sandbox-program.js` (`scripts/write-sandbox-program.ts`, run through vite-node so it
   reads the workspace's sources as the bundler does): the very text `datum-wasm.js` evaluates, the
   portable kernel with its `__datum_register`, `__datum_run` and `__datum_inspect` entry points,
   as a plain script any QuickJS context can evaluate. The file does not contain
   `FREEZE_INTRINSICS_SNIPPET` (`sandbox-program.ts` exports it); the order a host evaluates the
   two in is in `docs/reference/sandbox-abi.md`, "The program and its limits". A server that must
   not trust the browser re-validates the envelope in it and gets the same error contract and the
   same sanitized values, byte for byte (ADR 0029). `check-bundles.mjs` proves the file carries the
   program's entry points and is a script, not a module.

   The Spring Boot and FastAPI hosts, and the C# and Node.js examples of
   `docs/reference/server-runs.md`, run QuickJS-ng's own WebAssembly build (`qjs-wasi.wasm`, from the
   project's releases) directly, with no binding in between and nothing shared between requests;
   the in-process Node hosts run the engine's own module (ADR 0181). The Python host has no binding
   to choose: the QuickJS-ng project publishes none of its own, only the engine and its
   WebAssembly builds, and the `quickjs` package is archived at a QuickJS of 2021.

## Consequences

- Rules of the page's own run where the form runs, with the error contract and messages the form
  already has, and the same program runs server-side to the same verdict (ADR 0029): a Python, Java
  or .NET host needs `datum-sandbox-program.js`, a QuickJS, the form's definition and the plugin
  modules, with no engine code and no port of the rules.
- `datum-form.js` does not carry the sandbox; `datum-wasm.js` (the QuickJS binary is most of it) is
  fetched only by a form with `wasm` set, from `datum-ready` on, so the first submit does not wait
  on it. The wasm build inlines its dynamic imports (the host reaches its binary through one) so the
  module is a single file to deploy, where the PDF module's fonts sit beside it.
- The runtime's `wasmValidationHost` dependency is a class, so the deferring host is a subclass with
  `run` and `dispose` overridden; the engine needed no interface for it.
- `<datum-form-builder>` is untouched: the canvas previews, it does not submit.
- A sandbox the element loaded is released when superseded (a new plugin list, a new spec), not
  when the element leaves the page: the runtime survives that, and so does its sandbox.
