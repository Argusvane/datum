# Embedding the form and the builder

## The bundles

`packages/datum` packages the engine's elements as bundles a page loads with
`<script>` and `<link>` — no build step on the page's side (ADR 0038).

```
cd packages/datum && npm install && npm run build   # → dist/
npm run demo                                                 # demo pages on http://localhost:4173/
```

The files below come from two kinds of package. The engine's own are in
`packages/datum/dist/` (`dist/…`); each plugin builds its own bundle with `npm run build` in
`plugins/<id>` into `plugins/<id>/dist/`. Copy the folders a page uses beside the engine's `dist/` (the file
names a page loads are the same wherever they come from): a plugin's bundle resolves its assets beside itself.

| File | Load with | What it is |
|---|---|---|
| `dist/datum-form.js` | `<script type="module">` | `<datum-form>`: the form renderer alone — no toolbar, no panels, no PDF layer (ADR 0045). With `pdf="auto"` it fetches `dist/datum-form-pdf-service-*.js` (the PDF pipeline, a chunk of this bundle) and `datum-pdf.js` on the first PDF. A definition with journeys fetches `dist/datum-form-journey-engine-chunk-*.js` (the journeys runtime, ADR 0144); a one-page form never does. |
| `dist/datum-form.iife.js` | `<script>` | The same as a classic script; the API is `window.DatumForm`. Carries the pipeline inline (a classic script cannot split); the kernel is still fetched. |
| `dist/datum-builder.js` | `<script type="module">` | `<datum-form-builder>`: the full HTML and PDF builder — palette, canvas and properties, with the form, its PDF layouts (several per form, custom or populating an existing PDF, ADR 0044) and its journeys (ADR 0115), each named by the document label on its top bar. The PDF executor is `dist/datum-builder-pdf-*.js`, a chunk of this bundle fetched on the first preview, test fill or template inspection; `pdf="off"` leaves the PDF side out. The Journeys designer, its preview included, is `dist/datum-builder-journey-designer-*.js`, a chunk fetched when the Journeys side is first opened; `journeys="off"` leaves that side out, the definition's journeys passing through as they are. Also defines `<datum-form>`. `workspaces="pdf"` is the same builder opened on its PDF side alone. |
| `dist/datum-builder.iife.js` | `<script>` | The same as a classic script, the executor and the Journeys designer inside; the API is `window.DatumBuilder`. |
| `dist/datum-engine.js` | `import` (the package's `./engine`) | The form runtime with no element: one module file with no chunks, which reads no DOM global when it loads, for a test, script, worker or server that needs a `FormRuntime` without jsdom (ADR 0169). |
| `dist/datum-webauthn.js` | `import` (the package's `./webauthn`) | The WebAuthn functions with no element (`createWebAuthnSigningProvider`, `verifyWebAuthnSubmission`, `verifyRegistration` and the rest of `datum-form.js`'s WebAuthn names): one module file with no chunks, which reads no DOM global when it loads, for a page, worker or Node that wants the engine's own code without the lazy hop `datum-form.js` keeps in front of it (ADR 0143). |
| `plugins/icons-fontawesome/dist/datum-icons-fontawesome.js` (+ `.iife.js`) | `<script type="module">` (`<script>`) | Optional: Font Awesome as the builder chrome's icon set, registered as the default on load (ADR 0048, ADR 0095) — loaded *before* `datum-builder.js`, which carries no icon library and draws with the engine's own glyphs without it. A page with a bundler registers the package with `setDefaultIconSet(FONT_AWESOME_ICONS)`. |
| `dist/datum-pdf.js` + `dist/fonts/` | loaded by `pdf="auto"` | The PDF kernel and its fonts (ADR 0043) for the renderer, fetched on the first PDF by `<datum-form pdf>`; never inside the renderer's classic script. |
| `dist/datum-wasm.js` | loaded by `wasm="auto"` | The QuickJS/WASM validation sandbox (ADR 0029, ADR 0046): `<datum-form wasm>` fetches it once the form is ready and wires it with the page's `wasmPlugins`; every submit then re-validates and sanitizes in it. A module only, never inside a classic script; a page may import it itself and hand `createWasmValidationHost()`'s result to `wasmValidationHost`. |
| `dist/datum-sandbox-program.js` | a server's QuickJS | The program the sandbox runs — the portable kernel with its `__datum_register` / `__datum_run` entry points — as one plain script for a server that re-validates submissions in a QuickJS of its own (ADR 0046): the same schema, the same rules (formulas included, ADR 0139), the same verdict. A second entry point, `__datum_inspect`, takes `{ abi, op, definition, formulaErrors? }` and answers `public` (the definition without its `server-secret` rules, to serve to a browser), `check` (the formula problems, the policy and the verdict) or `inspect` (what every rule reads and calls); see [docs/formulas.md](../formulas.md). The docs' [validation example](../../site/docs/server-example-validate.md) is that server in Python. |
| `dist/datum-pdf-program.js` | a server's QuickJS | The PDF program (ADR 0043) — the executor behind `datum-pdf.js`, with its `__datum_pdf` entry point — as one plain script for a server that renders submissions as PDFs in a QuickJS of its own (ADR 0043), embedding the fonts from `dist/fonts/`: the same layout, the same bytes as the browser's PDF button; and signs them (`sign` / `complete` / `verify`, ADR 0061), the server keeping the key. The docs' [PDF example](../../site/docs/server-example-pdf.md) is that server in Python. |
| `dist/datum-form.css`, `dist/datum-builder.css` | `<link rel="stylesheet">` | Optional: a flash-of-undefined guard while the script loads. |
| `dist/builder-fonts/` | `<datum-form-builder load-fonts>`, or `<link rel="stylesheet">` to `builder-fonts.css` | Optional: the builder's own faces, Geist and Geist Mono (variable woff2, about 140 KB, with the OFL licence). Without them the builder draws in the system face (ADR 0124). |

Leaving parts out: `<datum-form>` and `<datum-form-builder>` take a `features` attribute (a space or comma list, also a property) that selects what loads. Absent, everything loads; `features="minimal"` is the preset for a one-page form (the builder's `features="minimal logic"` adds Logic). `dist/feature-files.json` lists which files a host may delete for each excluded feature, and the lazy chunks are `datum-form-journey-engine-chunk-*.js`, `datum-form-pdf-service-*.js`, `datum-builder-pdf-*.js` and `datum-builder-journey-designer-*.js`, each fetched only when its feature is enabled. If a file is missing for an enabled feature, the page gets a `datum-error` event and an inline Retry card in place of that part, and the rest of the form keeps working rather than breaking. The builder also fetches `datum-builder-json-viewer-*.js`, `datum-builder-logic-surface-*.js`, `datum-builder-data-surface-*.js`, `datum-builder-overview-surface-*.js` and `datum-builder-command-palette-*.js` the first time the thing each holds is used ([the builder page](builder.md) says when): copy the builder's chunks beside the bundle.

The builder's lazy modes (ADR 0143). `datum-builder.js` and `window.DatumBuilder` export `loadPdfBuilderMode()` and `loadJourneyBuilderMode()`, each a Promise of the mode's module (`(await loadPdfBuilderMode()).createPdfBuilderMode(...)`), and the `PdfBuilderModeModule` and `JourneyBuilderModeModule` types. They do not export `createPdfBuilderMode` or `createJourneyBuilderMode`, which would pull both modes back into the entry; `@argusvane/datum-engine` (its root and `./builder`) keeps both factories, synchronously. A builder fetches a mode's chunk once it is connected, unless its side is off (`pdf="off"`, `journeys="off"`) or its workspace is hidden. The first builder on a page registers the mode one asynchronous step after the chunk arrives, later builders at once, and a `setWorkspace` or `setMode` asked in the meantime applies on registration; a test waits on `pdfMode` or `journeyMode`. `defineDatumBuilderElement()` does not define the Header & footer and Variables panel tags: the shell defines each when its chunk arrives, a page using one on its own calls `defineBuilderChromePanel()` or `defineBuilderVariablesPanel()` (both exported), and a panel's properties are unreadable before it is first opened. With `journeys` left out of `features`, `previousPage()` and `goToPage()` reject. `datum-form.js` keeps `createWebAuthnSigningProvider`, `verifyWebAuthnSubmission` and the other WebAuthn names exported, as light wrappers over the lazy `datum-form-webauthn-*.js` chunk with the engine's own signatures; `verifyRegistration` is the engine's, exported from `render/webauthn/registration-verify.ts`, because it is synchronous and cannot sit behind a chunk.

The engine entry (ADR 0169). `dist/datum-engine.js` exports the runtime factory (`createFormRuntime`, `FormRuntime`, `createComponentRegistry`, `EMBED_SUBMISSION_MODE`, `EMBED_RUNTIME_VERSION`, `versionContextFor`), the standard component definitions and `mergeComponentDefinitions`, the plugin registry, data sources, the validation pipeline and its field-constraints stage, the file storage resolver, the submission envelope's canonical text (`canonicalizeJcs`, `signedCanonicalOf`, `signedCanonicalForSignature`), the draft file (`serializeDraftFile`, `parseDraftFile`), the host context's sanitiser (`plainHostContext`), `toFormDefinition`, `FormEventType`, the journeys runtime and the types that go with them. It exports no element, no renderer, no binding and no print or PDF pipeline: drawing stays behind the element. The in-process validation kernel is not exported either, as `datum-form.js` does not export it: the page's sandbox is `datum-wasm.js`, and a server judges with its own. A form with journeys walks page by page here as it does in `<datum-form>`: the page shown (`journeyView()`), Continue, Back and jumps (`nextPage`, `previousPage`, `goToPage`), routes and the pages they pass over, page-scoped validation, the page's server check, the check at the end and the envelope's `journey`. Its `createFormRuntime` is the package factory's with one difference: `journeyEngine` defaults to `EagerJourneyEngine`, imported statically (a `journeyEngine` in the config still wins). The entry also exports `EagerJourneyEngine`, for a `FormRuntime` built with `new`, `JOURNEY_END` and the journey types (pages, routes, validation settings, state, trace, block reasons, the page and check event data, the server validator's request and response), with `createFetchJourneyValidator` and `JourneyValidationHttpError`. `FormEventType` is exported from `datum-form.js`, `datum-builder.js` and `datum-engine.js`.

## Render a form

Render a form:

```html
<link rel="stylesheet" href="datum-form.css">
<script type="module" src="datum-form.js"></script>

<datum-form id="intake" pdf="auto" language-switcher draft="intake" src="/forms/intake.json"></datum-form>
<script type="module">
  const form = document.getElementById("intake");
  form.dataSources = { countries: [{ value: "CA", label: "Canada" }, { value: "US", label: "United States" }] };
  // The page's wording per error code; it wins over the messages the form authors itself (ADR 0049) for the codes it names.
  form.messages = { required: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } } };
  form.addEventListener("datum-submit", ({ detail }) => {
    if (!detail.accepted) return; // the form shows its own validation errors
    detail.waitUntil(deliver(detail.submission, detail.submissionKey)); // the form stays locked until this settles
  });
  async function deliver(submission, submissionKey) {
    try {
      const response = await fetch("/api/submissions", { method: "POST", body: JSON.stringify({ document: submission, submissionKey }), signal: AbortSignal.timeout(8000) });
      if (response.ok) {
        const { confirmationNumber } = await response.json();
        form.setNotice({ title: "Application received", details: [{ label: "Confirmation number", value: confirmationNumber }] });
        return;
      }
      const { errors } = await response.json(); // [{ field, code, message }]
      form.setErrors(errors.map((e) => ({ componentId: e.field, code: e.code, message: e.message })));
    } catch {
      form.setErrors([{ code: "delivery.failed", message: "The form could not be sent. Try again." }]);
    }
  }
</script>
```

The definition is a `FormDefinition` (what `<datum-form-builder>` emits), given as `src`, as a
JSON `definition` attribute, or as the `definition` property. A `button` component with
`action: "submit"` submits through the element; the page hears `datum-submit` with the canonical
envelope and delivers it. One with `action: "download"` submits the same way and, when accepted,
saves the envelope as a JSON file the browser downloads — a cancelable `datum-download` carries
the file name and text first, so a page can take the file over (ADR 0052). From the press of
Submit until the promise handed to `detail.waitUntil` settles, the form is locked: `aria-busy`, a
status line reading "Submitting…" — or the page's own words, per locale, from `texts` — with a
spinner beside it, at the top of the form, the bottom beside the button, or both
(`submitting-placement="top bottom"`), every field, button and the language switcher inert; a second press does
nothing, and `submit()` runs one at a time (ADR 0052). There is no timeout of the form's own: the
signal on the fetch is it. What comes back — the server's verdict on a field, or no reply at all —
goes back into the form through `setErrors()`: an entry with a `componentId` shows on that field
and in the summary, one without is listed in the summary alone, focus moves to the first, and the
next `validate()` or `submit()` replaces them (ADR 0052). A receipt — the confirmation number a
200 carries — goes in through `setNotice()`: shown at the ends of the form its `placement` lists
(`["top"]` where the summary goes, the default; `["bottom"]` after the fields beside the button;
or both), each text a `LocalizedText` worded for the locale, printed with the form, focus moved
to it, cleared by the next `submit()`. The notice's `data` (plain JSON, `{ reference: "GC-48213" }`)
is never drawn; a printed header or footer reads it as `{{receipt.reference}}`, and the built-in
`confirmation` fills it from the delivery's reply (ADR 0174);
`mode = "readonly"` keeps the answers as sent. `datum-change` reports a value once it has
settled (ADR 0055): a typed one after `change-debounce` ms of quiet (300 by default) or when the
field is left, or under `change-on="commit"` only when the field is left; a pick at once; and
whatever is still pending before `datum-submit`. `datum-validated` reports the errors after
`validate()`, `datum-error` anything the element could
not use (bad JSON, an unknown PDF theme, a definition that failed to load). `values`, `errors`,
`submitting` (also reflected as an attribute), `notice`, `runtime` and `renderer` are readable
properties; `validate()`, `submit()`, `submitAndDownload()`, `setErrors()`, `setNotice()`,
`print()`, `setLocale()`, `restoreDraft()` and `clearDraft()` the methods.

### Bindings and assets

A form is drawn by a binding. Datum's own `datum` binding draws it when none is named, in light and
dark (`colorScheme`), with nothing to load. A design-system binding draws the same form in that
design system's own markup. The reference bindings under `bindings/` are starting points and demos;
Datum ships none of a design system's files, and each binding owns the accessibility of what it
draws. The pieces on the element:

- `binding` (property): a `LiveBinding` object, or the id of one registered with `bindings.register`.
  An id nobody registered is a `datum-binding-error` and the form is drawn by the Datum binding.
- `assets` (property): the design system's files as the host serves them,
  `{ stylesheets: [{ url, integrity? }], fonts: [...], scripts: [{ url, classic?, integrity? }], rootFontSize? }`.
- `bindings.register(binding, { assets })` (from the bundle): registers a binding once under its id,
  with the assets it is drawn with wherever it is named by id and the element gives none of its own;
  `bindings.fromFactory(createBinding)` calls a binding package's factory with the page's lit and
  Datum's binding and returns the binding to register; `bindings.get`, `.assets`, `.list` and
  `.subscribe` read the registry. The builder's canvas offers each registered binding in its picker.

```js
import { bindings } from "./datum-form.js";
import { createBinding } from "./bindings/gcds.js";   // built from bindings/gcds with `npm run build`

bindings.register(bindings.fromFactory(createBinding), {
  assets: {
    stylesheets: [{ url: "/design-system/gcds.css", integrity: "sha384-…" }],
    scripts: [{ url: "/design-system/gcds.esm.js" }]
  }
});
document.querySelector("datum-form").binding = "gcds";
```

What the host has to know:

- The stylesheets are fetched and adopted into the form's shadow root, so each must be same-origin or
  served with CORS, and a page opened from `file://` cannot draw a design-system binding. `integrity`
  is checked on every stylesheet and script.
- A stylesheet or script that cannot be had stops the draw: an error alert takes the form's place
  (and the builder canvas's), naming the address, and the element raises `datum-binding-error` with
  `hook: "assets"` and the `url`. A font file that cannot be had is reported the same way and the form
  still draws, in another face.
- A design system made of web components registers them once per page, so the page serves one release
  of it to every form.
- A design system's own script can change things outside the form (Ontario's language toggle writes the
  page's `lang`); each binding's documentation lists them.
- A host with a Content-Security-Policy allows the script addresses in `script-src`, and the
  stylesheet addresses in `connect-src`: the sheets are fetched and adopted as constructed sheets,
  which `style-src` does not govern. The font files they name need `font-src`. Where
  `require-trusted-types-for` is enforced, `trusted-types` names the renderer's `lit-html` policy,
  the print frame's `datum-print` policy and, where a binding lists a script, the `datum-assets`
  policy its address is set through. [Host security](../host-security.md) has the table.
- Choosing a binding changes how the form is drawn and nothing else: nothing is written into the
  definition or its PDF layouts. A binding may suggest a PDF theme (see
  [PDF rendering](../pdf-rendering.md#themes)).

A restyled Datum is `createDatumBinding({ … })`, exported by `datum-form.js`, set as the form's
`binding` (tokens, dark set, frames, parts, per-type adapters, controls, field order). Its options
and writing a binding are in [Writing a design-system binding](../binding-authoring.md#5-the-datum-seams).

## Embed the builder

Embed the builder:

```html
<link rel="stylesheet" href="datum-builder.css">
<script type="module" src="datum-builder.js"></script>

<datum-form-builder id="builder" layout="contained" persist-panels="intake" style="height: 720px"
  src="/forms/intake.json" save="/api/forms/intake">
</datum-form-builder>
<script type="module">
  const builder = document.getElementById("builder");
  builder.dataSources = { countries: [{ value: "CA", label: "Canada" }] };
  builder.addEventListener("datum-builder-change", ({ detail }) => autosave(detail.definition));
</script>
```

`layout="contained"` keeps the builder's bar, panels and canvas inside the element's box, for
a builder embedded among other content: the page sizes the element (it is 720px tall when the
page says nothing) and the canvas scrolls inside it. The default `"page"` layout pins the shell
to the window (set `--db-shell-top` to the height of a page header that stays above it). `persist-panels="<key>"`
makes the shell remember its layout under that key for the next builder with the same key
([the remembered layout](builder.md#the-remembered-layout)); unset, nothing is remembered. `theme` styles the
shell: the builder has a built-in look (`default`, or no attribute) and a built-in dark one (`datum-dark`), and a host may register a
builder theme of its own over the `--db-*` tokens and name it here
([the look](builder.md#the-look-and-its-dark-scheme)). An id no
builder theme is registered under keeps the built-in look and is reported as a `datum-error`
(`Unknown builder theme`); the canvas previews the form under a design-system binding (the `binding` property); `pdf-theme` is
what the PDF side's previews and downloads print with (`default`, or a registered PDF theme's id) unless a
layout names its own — the
document's **PDF theme** property. `component-types="text,select,grid"`
restricts the palette, and an entry led by `-` drops a type instead, with a trailing `*` for
a prefix, so `component-types="-acme-*"` offers everything but the Acme group;
`locale` is what the canvas resolves labels in (its language switcher
offers the locales the form itself declares, under the labels authored with them), and
`data-sources` / `data-source-ids` feed the canvas preview and the inspector's Data source
picker. `definition` reads back the form as
authored — its `id`, `version` and `schemaVersion` included, which the Form selection's
Identity section edits beside its Localization section — `undo()` / `redo()` do what they say,
and `requestLeave(fn)` runs `fn` once unsaved inspector edits have been applied or discarded.

What the builder does once it is on the page is on [the builder page](builder.md). The attributes,
properties and methods a host reaches, by where they are described there:

- The bar, the document label and `selectDocument()` / `newDocument()`: [The bar](builder.md#the-bar).
- `file-actions` and the `fileActions` property, with `datum-builder-file-action`: [File actions](builder.md#file-actions).
- The `toolbar-start`, `toolbar`, `canvas-actions`, `history`, `comments`, `publish`, `account`, `strip` and `panel` slots, and `load-fonts`: [Toolbar slots and host controls](builder.md#toolbar-slots-and-host-controls).
- `workspace`, `hidden-workspaces`, `datum-builder-workspace-change` and `workspaceProblems`: [Workspaces](builder.md#workspaces).
- The strip, `panel` and `builder-panel-change`, the form settings, Header & footer, Variables, View and Settings panels: [The strip and its panels](builder.md#the-strip-and-its-panels).
- Drawer widths and the width tiers: [Drawers and width tiers](builder.md#drawers-and-width-tiers).
- `canvas-preview-change` and the canvas bar: [The canvas](builder.md#the-canvas); the inspector: [The inspector](builder.md#the-inspector).
- `serverChecks` and the settings Try it runs with: [Try it](builder.md#try-it).
- `registerCommands()` and `openPalette()`: [The command palette](builder.md#the-command-palette).
- `leave-guard` and `requestLeave()`: [Leaving the page](builder.md#leaving-the-page).
- `scheme`, `no-scheme-toggle` and the `--db-*` tokens: [The look and its dark scheme](builder.md#the-look-and-its-dark-scheme).

Saving and problems. The builder has no Save until the page asks for one, in one of three ways; each
puts Save in the builder's ⋮ menu and on Ctrl/Cmd+S inside it, asks about an edit still in the
inspector first, shows "Saving…" and is disabled while the save is pending, and shows a failure's reason beside the
menu. `save="/api/forms/intake"` has the builder send the definition itself, as JSON, by `PUT`
(`save-method="POST"` for the other); any 2xx answer is saved. A bare `save` sends nothing and fires
`datum-builder-save`, whose listener stores `detail.definition` and hands the work to
`detail.waitUntil(promise)`; the event fires before the request of `save="/api/forms/intake"` too,
where `preventDefault()` leaves the request out. `builder.fileActions = { save, saveLabel }` takes a
function and wins over the attribute. `save-label` names the item.
`<datum-form-builder>` treats the definition it loads as saved. After a save by the attribute it
takes the form as sent for the saved one; with your own function, set `savedDefinition` to what the
save sent (or call `markSaved()`) once your server has the form. Read `dirty` (also a `dirty`
attribute and `datum-builder-dirty-change`) to show saved / unsaved on the bar's `toolbar` slot or
guard leaving. The docs' [Saving forms](../../site/docs/saving-forms.md) page covers every route and
[Embedding the builder](../../site/docs/embedding-the-builder.md) shows them live.
The engine's own `<datum-builder>`, used bare (as a host that assembles its own bar uses it), writes no definition:
the host assembles Save and Download from `value`, `localization`, `identity`, `tests` and the rest, and hands its
wiring in through `fileActions`, with the form's `kinds` map
([a host that writes the definition itself](builder.md#a-host-that-writes-the-definition-itself)).

Printing (ADR 0035, ADR 0174). A read-only form prints what it shows. A live form prints by each
component's "On paper" settings (`configuration.print`): where it is drawn (`on`: both, `screen` or
`paper`), whether it starts a new page (`breakBefore`) or stays whole (`keepTogether`), and what it
does while a rule hides it (`show`: as on screen, `always` with a "Complete only if…" note
(`print.note`), or `answered`). Both prints are flattened: tabs, steps and collapsed parts print
open. Word the default note with the `printOnlyIf` text key. The form root's `print` block says
which versions a form offers (`renditions`, `defaultRendition`), the heading, the `scale`, a
`header` and a `footer` with a `start` and an `end` line of text with `{{placeholders}}`
(`{{title}}`, `{{date}}`, `{{page}}`, `{{pages}}`, `{{receipt.<path>}}`, `{{host.<path>}}`, a field's
value path), and `journeyPageBreaks`. When a form offers more than one version, the form host's
Print button is a menu of them; `print({ rendition, page, locale })` picks one, and
`preparePrintDocument(options)` builds the document without printing it. The builder's Print
workspace (`features` token `print`) edits all of it beside a preview; `<datum-builder>.printTheme`
is the theme that preview draws with.
`<datum-form>.printTheme` picks what draws the printed page: `basicPrintTheme` when left out, or `datumPrintTheme`, or a
design-system package's own (the GC Design System binding exports one at `@argusvane/datum-binding-gcds/print`). A print theme
returns escaped HTML from Datum's `printHtml` tag, the print document carries a `script-src 'none'` policy, and it links the
binding's stylesheets and fonts but never its scripts. See [Print support](../print-support.md).


## Icons

Bring your own icons (ADR 0048). The builder's chrome — palette, canvas toolbar, drag grips,
the rails' reopen buttons — and `<datum-form-host>`'s Validate / Print / PDF buttons draw every
glyph by name through an icon set. `datum-builder.js` carries no icon library and draws with the
engine's own glyphs; `datum-icons-fontawesome.js`, loaded before it, registers Font Awesome as
the default (ADR 0095). To draw with something else, register a set before the elements
upgrade, or give one element its own:

```html
<script type="module">
  import { setDefaultIconSet, svgIconSet, markupIconSet, DATUM_ICON_NAMES } from "./datum-builder.js";
  // Your own SVG path data, per name (see DATUM_ICON_NAMES for the vocabulary)…
  setDefaultIconSet(svgIconSet("acme", {
    undo: { viewBox: "0 0 24 24", body: '<path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>', attrs: 'fill="none" stroke="currentColor" stroke-width="2"' },
    "field-date": { viewBox: "0 0 24 24", body: '<rect x="3" y="4" width="18" height="17" rx="2"/>' }
  }));
  // …or an icon font: the page loads the font, the set carries the class rule into the shadow roots.
  document.getElementById("builder").icons = markupIconSet("material", {
    undo: ({ size }) => `<span class="ms" style="font-size:${size}px">undo</span>`
  }, `.ms { font-family: "Material Symbols Outlined"; line-height: 1 }`);
</script>
```

A set answers the names it has; any it leaves out gets the engine's own drawing (marked
`datum-icon-fallback`), so a partial set is a complete one. A set's markup is the page's,
trusted like the page's own CSS. `datum-form.js` carries no icon library: `<datum-form>` draws no
chrome icons. A host bundling from source registers whichever set it installed —
`@argusvane/datum-icons-fontawesome` exports `FONT_AWESOME_ICONS` — or none, and gets the engine's
drawings.

## The API behind the elements

Both bundles export the API behind the elements (`createFormRuntime`, the standard component
catalogue, the bindings and themes registries, `defineDataSources`, `FormRuntime`, the engine's own elements) for a
page that needs more than attributes. The sandbox is never inside a bundle: without `wasm`,
field constraints validate in-process.

Validating in the sandbox, and re-running the same programs on a server, are in
[Sandbox and server runs](server-runs.md).
