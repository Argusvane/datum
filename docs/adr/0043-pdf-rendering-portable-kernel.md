# ADR 0043: PDF Rendering — Portable Kernel, Renditions, Layouts, Templates

## Status
Accepted.

## Context

A PDF of a form has to meet requirements that printing paged HTML through a browser engine
cannot:

1. **Per-component choice of appearance.** A text field is sometimes an AcroForm widget a
   person types into, sometimes its label and value as text, sometimes a ruled line to write on.
   The component type, a PDF theme, the component instance and the layout must each be able to
   choose, in a stated order.
2. **A layout of its own.** The PDF is a different document from the form: a wizard's steps
   become sections, a tabbed form becomes one flow, several answers may be written into one text
   block, and the same answers may need several PDFs — an applicant copy, an internal summary, a
   government template.
3. **Existing forms.** A form's answers must fill an existing AcroForm PDF.
4. **Accessibility.** Tagged PDF, optionally.
5. **Portability.** The whole pipeline must run in WASM so browser, Java and .NET hosts produce
   the same bytes — the property ADR 0029 established for validation.
6. **Server hosts without a browser.** A server that validates a submission (ADR 0046 §6) and
   wants the record as a PDF has to render it with no browser, and no JavaScript runtime of its
   own, in the loop. The program has to sit beside the bundles a page copies to its site, as the
   validation program does (`datum-sandbox-program.js`). A JVM, .NET, Node or Python process
   embeds QuickJS and calls one global.
7. **An old engine.** A QuickJS binding in use embeds the QuickJS of 2021-03-27. pdf-lib, its
   standard-fonts package and fontkit each carry a base64 decoder that sizes its buffer for the
   padding and then writes three bytes per quartet regardless: a padded input writes one or two
   bytes past the end. Every current engine drops such a write; QuickJS before 2023 throws
   `out-of-bound numeric index` in strict code, and the program is strict. The standard-fonts
   package decodes its encodings at load, so the program could not even be evaluated there.
8. **Types nothing knows.** A component type with no PDF rendition at all is drawn by the generic
   rendition for its shape, and `rendition.unknown` fires only when something *names* a rendition a
   type lacks, so such a type falls through silently. It hurts most in the sandboxed program: a
   Java, .NET or Python host sends a custom component to `document`, the sandbox has no component
   registry, and the answer prints as label plus `JSON.stringify(value)` with nothing in the
   response to say the program was never taught the type. A host needs a way to be told, and a
   way to refuse the document rather than ship a flattened one.

The engine's own seams stay in force: a pure document model, deterministic semantic
reinterpretation, and a provider seam modelled on the signing provider (ADR 0001).

## Decision

### 1. One portable program, two layers

`@argusvane/datum-pdf-kernel` (`packages/pdf-kernel`) builds one import-free ES2020 program,
`dist/datum-pdf.program.js`. JS hosts import the same modules in-process; browser and Node hosts
may also evaluate the program in a QuickJS runtime; JVM and .NET hosts embed QuickJS the way ADR
0029 envisages and call the same global. Byte-identical output across these is a tested invariant
(a parity suite and a release gate). The program is a second portable program beside the
validation one of ADR 0029, with an ABI of its own (`PDF_ABI_VERSION`, apart from
`WASM_ABI_VERSION`; [`docs/reference/pdf-abi.md`](../reference/pdf-abi.md) holds the operations,
the messages and what each version added).

The program carries **two layers** so a non-JS host never needs the TypeScript engine: the
*model builder* (engine slices bundled by esbuild that turn a form root, a layout, values and a
snapshot of resolved data-source options into a `PdfDocument`) and the *kernel* (layout
arithmetic, the PDF writer, AcroForm fill and inspection, tagging). Requests and responses are
stable-stringified JSON; bytes travel as base64. The host supplies time and identity in `env`;
the program never reads a clock or a random source. Data sources are resolved outside the
sandbox and injected as an option snapshot, as ADR 0029 does for external data. A plugin's wasm
module may carry a `pdfRenditions` array — ADR 0029 reserved unknown module keys for exactly
this.

The QuickJS host is a generic program host with two resource profiles: the validation profile of
ADR 0029 and a document profile (15 s, 256 MiB). Both keep the 1 MiB stack. `call()` drains
pending jobs, because the writer's `save()` is a promise.

### 2. Bytes: `@cantoo/pdf-lib`, one library family

The kernel writes and reads PDFs with `@cantoo/pdf-lib` (the maintained fork of pdf-lib; pinned
exactly), fontkit for metrics, shaping and subsetting, pako for deflate, `linebreak` (UAX#14)
and `bidi-js` (UAX#9). One object model serves generation *and* template fill; widgets get
real appearance streams, so flattening works and viewers agree.

- **pdfkit** was considered: it is actively maintained and has a tagging API, but it is
  write-only (no template fill), leaves widget appearances to the viewer, has no radio-group
  helper, and is a streaming builder whose own layout the pipeline would bypass.
- **A Rust module** was considered: fastest and best shaping, but a second toolchain, and a
  Java/.NET host would still need QuickJS for the model builder plus a bridge between two WASM
  modules.

These dependencies live only in the package; `@argusvane/datum-engine` takes none of them. All
pdf-lib calls sit in `writer/` and `template/`, so a swap touches one directory.

The sandbox needs polyfills injected before any module body runs: `TextEncoder`, a `TextDecoder`
that honours `utf-16be` and Latin-1 labels (fontkit reads a font's name table as UTF-16BE),
`atob`, a microtask `setTimeout` and a silent `console` (pdf-lib reports through it, and a
static-XFA template raised a ReferenceError without one). `setMaxStackSize` stays at 1 MiB,
because the single-file WASM build's stack is about that and a larger limit makes every
evaluation fail; the document profile raises memory and time, never the stack. pdf-lib's own
random source is a seeded generator, so the hardening prelude's throwing `Math.random` is never
reached; its PNG decoder reads `Date.now()` only to time itself, so a clock frozen at zero inside
the sandbox keeps images embedding without any variation.

### 3. Determinism

Byte-identical output is achieved with library options, not by patching globals: metadata
updates off and dates from `env.createdAt`, a fixed name on every embedded font, no timers at
save, the trailer `/ID` from a pure-JS hash of `env.documentId`, glyph subsets in encounter
order, no `Intl`, and the kernel's own base64 (the list is in
[`docs/pdf-rendering.md`](../pdf-rendering.md#determinism)). The sandbox prelude still throws on
`Date` and `Math.random`, so an accidental use fails the parity suite instead of silently
differing.

### 4. Layouts on the definition

`FormDefinition.pdf?: { layouts: PdfLayoutDocument[]; defaultLayoutId? }`
(`core/schema/pdf-layout.ts`; additive under ADR 0001). A layout is `generated` or `template`.

A **generated** layout is a tree of PDF component types — ordinary `ComponentDefinition`s, so the
builder's registry, slot constraints and inspector apply unchanged (the node types are listed in
[`docs/pdf-rendering.md`](../pdf-rendering.md#generated-layouts)). **Pages are an output of
measurement, not an input**: there are no page slots. Content flows, breaks and keep-together
shape it, and the designer shows page edges from the kernel's `layout` operation.
`renditionDefaults` on the layout lets one form carry a "filled record" and a "blank fillable"
document.

A **template** layout carries the PDF (the file-attachment envelope: inline base64, or a host
storage kind resolved through a `PdfTemplateResolver`) and a field mapping whose sources are a
component, a value path, a template text, an expression, or a literal. XFA is stripped with a
warning.

A form may declare no layout; every host then prints from a layout derived from the form
(`deriveDefaultPdfLayout`). It heads no section with a label the author hid, captions an untitled
tab by its lone `tab` component's label or its place, never its slot id, and carries the form's
title as a literal, never a template. Several layouts per form, and the choice among them, are ADR 0044.

Layout nodes carry no rules of their own: what prints follows the bound components' effective
state. `pdf-section`, `pdf-box` and `pdf-table` take `skipWhenEmpty` so a container can follow its
fields, and the derived layout sets it on every section and grid table it makes, so a container
a rule hides leaves no orphan heading.

### 5. Renditions and their order

`ComponentDefinition.pdf?: { renditions: PdfRenditionDeclaration[]; defaultRendition }`; a
rendition renders the node and a `PdfRenditionContext` (the resolved `RenderComponentModel`, the
formatted value, style, theme, locale, direction, translation catalog) into `PdfBlock`s. A plugin
adds renditions to types it does not own through `FormPlugin.pdfRenditions` (manifest kind
`pdfRenditions`), registered in a `PdfRenditionRegistry`.

The engine ships a built-in table for its own types, the analogue of the HTML `fieldHtml`
defaults. `core/schema/pdf-renditions.ts` names each built-in type's renditions, labels and
default, `render/pdf/standard-renditions.ts` implements them and a test holds the two equal; the
registry layer never imports render, so the form builder's PDF inspector section reads the
catalog alone.

The rendition a bound component takes is decided in this order, most specific first: the
binding's, the instance's, the layout's `renditionDefaults`, the PDF theme's, the definition's
default, the built-in table's default, the generic text rendition. An unknown id falls through
with a warning. A type that reaches the last rung because nothing knows it at all is reported or
refused under the `unknownComponents` policy (§14). The same component bound twice as `field`
produces two widgets of one AcroForm field, which is what PDF means by it.

A PDF theme is a `PdfThemeDefinition` (`target: "pdf"`) registered in a `PdfThemeRegistry`.
Which theme a document renders under is chosen by id; ADR 0098 decision 7 holds the order.

### 6. The render model

`buildPdfRenderModel` is a mode adapter in the sense of ADR 0001: pure, DOM-free, built on
`resolveOptionStatesForTree` (`docs/data-sources.md`) and `buildComponentModels(..., { readOnlyByMode: true })`,
returning `{ mode: "pdf", document | fill, components, warnings }`. It resolves renditions,
evaluates templates and expressions through the rules evaluator (whose context already scopes
`row.`, `ancestor.` and `host.`), expands repeats engine-side, lifts anchored boxes out of the
flow and collects widget specifications, warning when two owners take one AcroForm field name.
Inside an entry, a field of the entries reads the entry's answer at its key and nothing else: a
collection adds no path level, so the template model's own value is another field's answer. A
placeholder reads its path through the component it names (by id, value path, or an entry's
indexed path), so it is formatted and cut as that component's answer. The document's page is the
layout's over the theme's, field by field, and a page break's own setup changes only what it names.
The kernel therefore never evaluates an expression.
`buildRenderOutput({ mode: "pdf" })` returns this model; a genuinely unknown mode still throws.

### 7. Tagging

Output is tagged by default (`accessibility.tagged`). The structure tree is hand-written
(`kernel/tagging.ts`: roles, table rows and cells, alt text, widgets, artifacts); pdfkit's
tagging API was not worth a second library. It is best-effort structure, not a conformance
claim: no PDF/UA claim is made. PDF/A is its own switch, veraPDF-validated (ADR 0059). Guide:
[`docs/pdf-tagging.md`](../pdf-tagging.md).

### 8. Hosts

`PdfRenderProvider` is the seam (the shape of ADR 0001's signing provider): `render`,
`document`, `layout`, `fill`, `inspect`. `renderFormPdf(runtime, deps, { layoutId })` in the
engine drives it from a running form, and the elements that expose it are in
[`docs/pdf-rendering.md`](../pdf-rendering.md#hosting).

Fonts come from a `PdfFontProvider`; the package ships a default pack (DejaVu Sans, Serif and
Mono) and falls back to the standard 14 with warnings. The kernel and its fonts are a lazy
module chunk in `@argusvane/datum`, kept out of the renderer's classic script (ADR 0045 decision 7).
How the renderer and the builder reach the pipeline lazily is ADR 0045. Printing a live form is ADR 0035.

A PDF in another language is an option, not a switch: `RenderFormPdfOptions.locale` renders the
form for a locale other than the runtime's current one — one submission, an English and a French
PDF — leaving the live form as it is. Value formatting stays locale-free by §3.

### 9. Designer

The PDF layout designer is the builder pointed at the layout tree, not a second builder: a
`BuilderController` over PDF component definitions, with the same commands, undo history,
drafts, unsaved-changes guard, drop pipeline and inspector composition. It is a mode of
`<datum-builder>` (ADR 0045). Its canvas mounts `<datum-form-renderer>` over a
`BuilderPreviewRuntime` whose root is the layout tree (ADR 0028's approach), each bound field
shows its own read-only drawing over sample answers, and page edges come from the kernel's
`layout` report. The sheet is the page's width, not the author's: the builder's preview-width
picker and sheet grips stand for the devices a form is filled in on, and a page offers no such
choice. The guide is [`docs/pdf-rendering.md`](../pdf-rendering.md#designing-a-layout).

### 10. The PDF program ships beside the bundles

`@argusvane/datum` build copies `@argusvane/datum-pdf-kernel`'s `dist/datum-pdf.program.js` to
`dist/datum-pdf-program.js`, named as the sandbox program is, with the DejaVu fonts already in
`dist/fonts/`. A server has the executor the browser's `datum-pdf.js` carries, as one plain
script, and the fonts it embeds from the same place the page serves them. `check-bundles` holds
it to a plain script with the executor and both entry points, and never the validation sandbox.

### 11. The program runs on any QuickJS since 2021-03-27

The build guards the three base64 decoders at bundle time — room for the overrun, then trimmed —
and fails when a library upgrade moves them; `datum-pdf.program.meta.json` records the count,
and the bundle test holds the program to that and to reaching for no API such an engine lacks
(`Object.hasOwn`, `Array.prototype.at`, `findLast`, `WeakRef`). The engine's `structuredClone`
sits in the builder's tree mutations, which the render path never calls. Portability is measured
against the oldest engine a host in use embeds, not the newest.

The build stubs the engine's custom elements and every dynamic `import()` into the engine out of
the program (`build-program.mjs`), because one lazy edge makes esbuild wrap the modules under it in
initializers nothing eager runs, and the program would then install no ABI. It evaluates its
output in a bare `vm` context and refuses a program that installs no ABI version.

### 12. A server renders with `document`, after it validates

The endpoint re-runs the sandbox program over the envelope first, so the PDF prints the
sanitized values — what the form defines, nothing else — and a bad submission is a 422 with
codes. It then sends the form root, the definition's `pdf` block, those values, a locale of its
choosing, the data-source options it resolved itself (the program never fetches), the fonts as
base64, `options` and `env` (`createdAt`, `documentId`: the only time and identity the program
sees), and answers `application/pdf` with the bytes, a `Content-Disposition` file name and the
page count in a header. The request is described in
[`docs/pdf-rendering.md`](../pdf-rendering.md#java--net).

### 13. The promise is settled by running the job queue, not by an event loop

`__datum_pdf` answers with a promise; a host calls it and runs the runtime's pending jobs until
it has settled. In a QuickJS binding that is `execute_pending_job()` in a loop and a global read
back; under QuickJS-ng's own `qjs-wasi.wasm` each request is a run of its own and the promise
settles before `qjs` exits. The program's only timers are microtasks, so the loop ends. One
context serves one render at a time.

### 14. Unknown components: one policy, three settings

`unknownComponents: "ignore" | "warn" | "fail"` (`PdfUnknownComponentPolicy`), **default
`warn`**: the generic rendition with no report, the generic rendition with a `component.unknown`
warning once per component, or the document refused with a `PdfKernelError` whose code is
`unknown_component` (in the program the typed failure `{ ok: false, error: { code, message } }`;
a provider rethrows it, so a host branches on `.code`).

**Unknown** means the type's rendition catalog is empty — `resolver.catalog(type).length === 0` —
which is exactly "this resolver, or this program, has never been told about the type". A known
type asked for a rendition it lacks is still `rendition.unknown`. The settings, where they are
set and what the program reports are in
[`docs/pdf-rendering.md`](../pdf-rendering.md#unknown-component-types).

### 15. The verdict follows the schema, not the answers

The check runs on every bound form component the layout reaches, **before** visibility is
consulted and **after** `configuration.pdf.exclude`: a component a rule hides for these answers
still counts, one the author left out of PDFs does not. A host that sets `fail` gets the same
verdict for every submission of the same form and layout. A `PdfKernelError` raised inside a
rendition passes through the `rendition.failed` guard, which otherwise turns a rendition's
exception into a warning. Template layouts involve no renditions and are never checked.

### 16. Where the policy is set

It is set where a host already configures a PDF: on the wire (`PdfDocumentInputs.unknownComponents`
on `document` and `build`, announced by the `unknown-components` capability), in the engine
(`PdfRenderModelOptions`, `RenderFormPdfOptions`) and on the elements (`pdfUnknownComponents`,
the `pdf-unknown-components` attribute), the last as the default for `renderPdf()` and
`downloadPdf()`, which is what the toolbar's PDF button and a button's `"pdf"` action do.

### 17. A contributed rendition is the type's default

For a type with no definition and no built-in entry, the first rendition a plugin module
contributes (`__datum_pdf_register({ pdfRenditions: [...] })` in the sandbox, a
`PdfRenditionRegistry` in the engine) is that type's default. Otherwise a contribution to an
unknown type would make it "known" but only be drawn when a binding, layout or theme named it,
and the remedy the `fail` message suggests, register one for the type, would change nothing. A
built-in or defined type keeps its own default; a contribution there is one more choice.

### 18. The runtime says where renditions come from

`RenderableRuntime.pdfRenditionSources?()` names the registries a lookup consults beyond the
built-ins; `FormRuntime` answers with its `componentRegistry` and the platform's `pdfRenditions`,
and `renderFormPdf` builds its resolver from them when `PdfServiceDependencies.renditions` is
absent. Every host path — `<datum-form>`, `<datum-form-host>`, the builder's PDF preview — ends
in a `FormRuntime`, so a definition-declared rendition prints without wiring, and a definition's
`pdf` block and a plugin's `pdfRenditions` never read as unknown. The bridge only *types* the
sources; the resolver is built in the PDF service, which keeps `standard-renditions` out of the
slim renderer bundle (ADR 0045).

## Consequences

- The engine has `core/schema/pdf-layout.ts`, `render/pdf/*`, `registry/pdf/*`,
  `builder/pdf-designer/*` and a `pdf` branch in the orchestrator; it takes no dependency for
  them. `engine/tests/barrel-node-import.test.ts` and `check-architecture-boundaries.mjs` keep
  applying.
- Two portable programs exist (validation, PDF), each with its own ABI version and resource
  profile. They share the QuickJS program host and the stable-stringify rule.
- A Java or .NET host produces PDFs by embedding QuickJS once and calling one global; the package
  README documents the recipe and the byte hashes the parity suite records.
- Output size and speed are bounded by an interpreter: the document profile, per-script font
  subsets, a reused runtime and the byte-free `layout` operation are the mitigations.
- Two files for a server sit beside the bundles: `datum-sandbox-program.js` (validation, ADR 0046)
  and `datum-pdf-program.js` (rendering), each evaluated once and called by a global.
  `packages/pdf-kernel` must be built before `packages/datum` (CI does so), as the copy is of a
  built artifact.
- The parity guarantee reaches an engine three years older than the one in the tests: the base64
  guard changes no byte of any output (the decoders return the same bytes, minus an overrun no
  engine kept), so the release gate's hashes stand.
- A custom component whose definition declares `pdf` renditions prints through them on every host
  path, and is never `component.unknown`; the warning is left for types nothing knows. A host that
  builds its own resolver (`PdfServiceDependencies.renditions`) still wins. A strict deployment
  sends `"unknownComponents": "fail"` and treats `unknown_component` as a configuration error.
