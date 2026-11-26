# ADR 0169: The Engine Entry

## Status

Accepted.

## Context

`FormRuntime` holds the answers, works the rules out, validates and builds the submission envelope.
None of that needs a DOM, and a test, a script, a worker or a server can use it. `datum-form.js`
defines `<datum-form>` when it loads, and the element's module reads `HTMLElement` and
`customElements` as it is evaluated, so importing it where there is no DOM throws: a caller would
have to stand jsdom up first to reach a runtime. A caller that holds a runtime also needs its event
names, and a PDF of the runtime's form.

## Decision

### One more module, built on its own

`packages/datum/src/engine.ts` is built as `dist/datum-engine.js`, a module only, one file with no
chunks (`vite.config.ts` gives it `codeSplitting: false`, as the sandbox module has). It is its own
`vite build --mode engine` in `scripts/build-bundles.mjs`, after the others. The other bundles are
separate builds, so adding it changes none of their bytes. `datum-webauthn.js`, the package's
`./webauthn` export (ADR 0143), is built the same way and needs no DOM either, so the package has two
DOM-free entries, the engine and the WebAuthn functions.

It exports the runtime factory and its constants, the standard component definitions and the merge
over them, the plugin registry, data sources, the validation pipeline and its field-constraints
stage, the file storage resolver, the submission envelope's canonical text, the draft file, the host
context's sanitiser, `toFormDefinition`, `FormEventType`, the journeys runtime (below) and the types
that go with them.

It exports no element, no renderer, no binding and no print or PDF pipeline: drawing stays behind the
element. The in-process validation kernel is not exported here either, as `datum-form.js` does not
export it: the page's sandbox is `datum-wasm.js`, and a server judges with its own.

### Journeys are in

A form with journeys walks page by page in the engine file as it does in `<datum-form>`: the page
shown, Continue, Back and jumps, routes and the pages they pass over, page-scoped validation, the
page's server check, the check at the end and the envelope's `journey`. The entry's
`createFormRuntime` is the package factory's with one difference: `journeyEngine` defaults to
`EagerJourneyEngine`, imported statically (a `journeyEngine` in the config still wins). The entry
exports `EagerJourneyEngine` too, for a `FormRuntime` built with `new`, with `JOURNEY_END` and the
journey types.

The engine is pure over the definition and the state (ADR 0144), so nothing in it reads a DOM
global. What does is elsewhere and stays out: the journey's drawing (the render kit, the page module
and the Check answers list) is the renderer's, and following the address bar is the host page's,
from `datum-page-change` or the runtime's `PAGE_CHANGED`. Nothing registers in the page's
default-engine slot, so a runtime another bundle builds on the same page is untouched.

`createFetchJourneyValidator` and `JourneyValidationHttpError` are exported as well, statically: the
validator needs `fetch` and nothing of the DOM, so it runs in Node and in a worker. The element's
bundle still reaches the same module by dynamic import.

The entry is one file for whoever imports it, and a caller that runs a journey on a server or in a
test has no chunk to fetch and no loader to wait for: the reason the element loads the journeys
runtime on demand (a plain form pays nothing for it in the page) does not hold for a module a script
chooses to import. The element's bundles are separate builds and do not change.

### Definitions without drawing code

A standard component definition (`src/standard-components.ts`) is a type, a version, a
`createDefault`, capabilities and a property editor. It names no adapter: the renderer finds what
draws a type through the binding at render time. So the definitions and the drawing are apart, and
the factory reaches no element, renderer or binding module.

### Holding it

`scripts/guards/17-engine-entry.mjs` reads the built file and its source map. The file is one file
with no chunk beside it and no static or dynamic import. It names no DOM global (`document`,
`window`, `customElements`, `HTMLElement`) at all, and carries neither the sandbox nor the PDF
kernel; the one sentence of prose that names the word `document` (the server validator's refusal,
which means the envelope) is read out first. It carries the eager journeys engine by its name, and
its map names the eager engine, the navigation, the server checks and the path engine. Its map names
no element module, no part of the live renderer, no binding or lit-html, no PDF or print pipeline,
no builder surface, no agent tools, no journey render kit or Check answers list, and not the
element's journeys chunk or its loader. Of this package's sources it names only an allow-list: the
entry, the runtime factory, the standard component definitions, the plugin registry, the support
and host context modules, and the server validator with its error class. Of the form element's
render tree it names only the typed-answers reader the runtime uses. The file has a size budget of
its own.

`tests/engine-entry.test.ts` builds the entry and imports it in a plain `node` child with no DOM
globals, then answers, validates, submits, saves a draft through a store and reads it back,
subscribes by `FormEventType` and by string, and walks a three-page journey (a refused Continue, a
route that passes a page over and one that takes it, Back, a refused and an accepted submit, the
envelope's `journey`, a server validator given in the config and called with the page's request and
the envelope).

### The event names

`FormEventType` is exported from `datum-form.js`, `datum-builder.js` and `datum-engine.js`, with the
`FormEvent` and `FormEventListener` types. `EventBus.subscribe` takes any string, so a listener named
by string keeps working.

### A PDF from a runtime

`datum-pdf.js` exports `renderPdf(runtime, options)`. It takes the element's render options
(`layoutId`, `themeId`, `locale`, `unknownComponents`, `signature` and the rest) and what the element
keeps as properties (`support`, `theme`, `templates`, `binding`). Without a `support` it makes its
own once, with `createPdfSupport()`. The mapping from a support and those settings to what the PDF
pipeline is handed is one function, `pdfServiceDependencies` (`src/pdf-render.ts`), which
`<datum-form>` also sets its renderer's PDF properties from; both then call the engine's
`renderFormPdf`. For the same runtime, options, clock and document id the element and the function
produce the same bytes (`tests/pdf-render-runtime.test.ts`). Neither passes the runtime's host
context to the PDF; a call that wants one names `hostContext`.

`datum-form.js` exports a loader-side `renderPdf(runtime, options)` with one more option, `pdf`, the
module's address (`"auto"` by default, beside the bundle). It loads the module and its support as
`loadPdfSupport` does, shared with `<datum-form pdf>`, and calls the module's function. The PDF
pipeline is in neither the form bundle nor its core chunk.

`datum-pdf.js` carries the pipeline as well as the kernel, so the element's first PDF downloads it
twice: once in the form bundle's lazy pipeline chunk and once in the module. The module runs in Node
too. The browser build stands a stub in for each `node:` import, so `createPdfSupport` reads its font
files through `process.getBuiltinModule("node:fs/promises")` when there is a process and fetches
them when there is not.

## Consequences

- A worker, a test or a server imports `datum-engine.js` and runs a form with no jsdom, journeys
  included. A page that shows a form never loads it.
- The engine's runtime is still one class in two files: a page that loads `datum-form.js` and
  `datum-engine.js` gets two copies of the code. Registries kept on the global (plugins, themes) are
  shared; an `instanceof FormRuntime` across the two is not.
- The hosts' asset scripts do not copy `datum-engine.js`: a host serves the form, and judges
  submissions in its own sandbox.
- `datum-pdf.js` is larger than the kernel alone by the pipeline.
