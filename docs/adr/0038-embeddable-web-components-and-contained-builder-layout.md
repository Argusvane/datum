# ADR 0038: Embeddable Web Components and the Contained Builder Layout

## Status

Accepted.

## Context

The engine ships the builder and the renderer as custom elements: `<datum-builder>` (ADR 0028) and `<datum-form-renderer>` / `<datum-form-host>` (ADR 0035, 0066). A page outside this repository needs to load them from a script tag. The elements take rich objects, a `FormRuntime` and a `DatumBuilderOptions` with component definitions, that a page loading a script tag has no way to assemble, and the standard component catalogue (text, select, grid, tabs, file) has to travel with them.

Two more things stand in the way of embedding. The builder's page layout pins its shell to the window, below `--db-shell-top` for a host that keeps an app bar above it, so by itself it can only be the whole page. And the QuickJS WASM sandbox (ADR 0029) is large when inlined as base64, which is the wrong price for a page that wants a form on it.

## Decision

1. **A package that builds bundles: `packages/datum` (`@argusvane/datum`).** Vite library mode, one build per bundle, two formats each: a module for `<script type="module">` and a classic script exposing the API as `window.DatumForm` / `window.DatumBuilder`.
   - Nothing is externalised: a page loads one file (plus the lazy chunks the builder loads on demand, which a host copies beside it).
   - Companion files go beside the bundles for `<link>`: a small sheet per element (a `:not(:defined)` guard while the script loads).
   - Declarations are emitted to `dist/types` for TypeScript consumers, and the package's `exports` point at its sources for consumers inside this workspace, as every other package's do.

   The bundles draw with Datum's binding. A design-system binding is a package of its own (`bindings/<id>`) that a page loads beside them, with the design system's files served by the host.

2. **Two JSON-friendly wrapper elements, not new engine surface.**
   - `<datum-form>` holds a bare `<datum-form-renderer>`: the form and nothing else. The Validate / Print row is `<datum-form-host>`'s and is deliberately not used.
   - `<datum-form-builder>` holds a `<datum-builder>` and chains its `toolbar-start`, `toolbar` and `canvas-actions` slots through (ADR 0125 lists the other places it forwards). The bar's file menu offers the wrapper's own New, Open and Download, which work over the whole definition; `file-actions` and the `fileActions` property choose and replace them.

   Every input is an attribute (JSON where it is an object) with a matching property, and the element assembles what the engine needs from them (the standard registry, the field-constraints validation pipeline, one submission mode, `defineDataSources` over the lists) and reports back through events, `datum-submit` carrying the canonical submission envelope and `datum-builder-change` a complete `FormDefinition`. The attributes and events are listed in [docs/reference/attributes.md](../reference/attributes.md) and [docs/reference/embedding.md](../reference/embedding.md). The engine's own elements and API stay exported beside the wrappers for a page that outgrows attributes.

   Inputs are batched: attribute and property assignments are applied in one microtask, so a page setting several never rebuilds the runtime several times. Only a change to the definition, the data sources, the translations or the draft key rebuilds it; the binding and its assets, mode, messages and chrome are forwarded to the renderer without touching what has been typed. The builder wrapper likewise reseeds the tree only for the definition and the component catalogue, and routes binding, theme, locale and data-source changes through `BuilderController.setOptions`.

   **One definition at a time.** `src` and a definition do not replace each other: setting `src` while the element already holds a definition, or assigning a definition while a `src` fetch is pending, is refused with a `datum-error` and nothing is replaced. A definition brought in by New or Open counts as set. A `src` response that lands after the author edited is dropped with a `datum-warning` (`src.superseded`), and New and Open stay refused while a fetch is pending. This holds for `<datum-form>` and `<datum-form-builder>` alike.

   **A size cap.** The builder's Open and a `src` fetch read at most 2 MiB and refuse a larger document with the importers' own code and message; `max-definition-bytes` raises it for a host that serves larger forms.

   **Twin ids open as a Problem, not a refusal.** A document whose components share an id (`component.id.duplicate`) loads in the builder; both twins are listed as a Problem and Save stays enabled (ADR 0111).

3. **The standard catalogue lives in the package.** The wrappers register the engine's standard component definitions (ADR 0095), so what a host authors and what an embedding page gets are one list. Choice components in the catalogue seed no data source: a host registers its own.

4. **`<datum-builder layout="contained">`.** The page layout pins the shell to the window below `--db-shell-top`; the contained layout fills the element's box (the host sizes it). The attribute is the only difference between the two, and each is one rule in the same flex-column shell (ADR 0099). The element becomes the frame, and the canvas keeps the sheet at its own width inside its column, scrolling sideways when the column is narrower.

   The chain from the element down to the canvas is flex columns and percentage heights: a page's own stylesheet outranks a `:host` rule, so a page that makes the element a plain block must still get a bounded builder. `<datum-form-builder>` is 720px tall when the page gives it nothing. `--db-shell-top` has no meaning in the contained layout, and modal dialogs stay viewport-centred, as modals should.

5. **The WASM sandbox is opt-in.** Field constraints (`required`, `pattern`, length limits, a file field's size and type) validate in-process through the engine's `ValidationPipeline`, which is what the builder promises and the form must keep. Plugin validators that run in the QuickJS sandbox load from a separate chunk (ADR 0046), never as part of the single-file classic script.

## Consequences

- A page embeds a form or the builder with a `<script>` and a tag, and configures it with JSON. The engine's contracts are unchanged; the wrappers are a composition over them.
- CI has a `datum` job for `packages/datum` (typecheck, tests, build). Bundle size is the number to watch: `packages/datum/scripts/check-bundles.mjs` holds each bundle to a budget.
- `layout` defaults to `"page"`. A page that embeds the builder among other content uses `"contained"` and sizes the element.
- The engine's `HTMLElementBase` pattern is repeated in the package (`ElementBase`): the entries are imported under Node by tests and tooling, so the classes must be evaluable there.
