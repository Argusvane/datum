# ADR 0045: One builder for HTML and PDF; a slim renderer with optional PDF

## Status

Accepted.

## Context

The PDF layout designer is the builder pointed at the layout tree (ADR 0043), and a form has
several layouts (ADR 0044). Hosts should not run two builders for that: an author designing a form
and its PDFs moves between one set of panels over different trees, not between pages and elements
that share nothing but the definition.

The renderer has the opposite concern. If `render/core/render-orchestrator.ts` imported the PDF
model builder statically for `mode: "pdf"`, every page carrying `dist/datum-form.js` would carry
the whole PDF pipeline (the render model, the renditions, the template planner), PDF or not.

The goal: one builder that is the full HTML and PDF builder, with the PDF executor (the kernel
program that renders previews, test fills and inspects templates) part of the builder's own
bundle so there is nothing to configure; and a renderer that is HTML by default, with the whole PDF
side optional and loaded only by a host that asks for it. No engine code duplicated.

Two tags carry the builder. `<datum-form-builder>` (`packages/datum`) is the element a page places;
it creates and wraps `<datum-builder>`, the engine's shell, which owns the modes, the bar and the
panels. This record names `<datum-builder>` where the shell's own API is meant (modes, documents,
overlays) and `<datum-form-builder>` where an attribute or a bundle on the page is meant; "the
builder" is the pair.

## Decision

1. **Modes are a PDF-agnostic facility of `<datum-builder>`.** A mode is a controller plus chrome, the form is the primary one and a host adds others with `addMode()`, and the shell never learns what a PDF is. ADR 0125 (decision 10) holds the mode API: the documents a mode lists on the bar, the events, and where its actions, overlays and canvas surface go.

   A mode may say what the properties panel offers over its tree (`inspector`). The PDF mode offers a Rules tab on the layout's root only, where it edits the layout's `when` (ADR 0044). Nothing else on a layout reads a node's `rules`: the render model walks the layout without evaluating them, and the design canvas, a `BuilderPreviewRuntime` over the layout tree with no values, would hide nodes the PDF still prints. A section, box or table that should disappear with its hidden fields uses `skipWhenEmpty` (ADR 0043 §4) instead.

2. **The PDF designer is a mode provider in the engine's builder layer.** `createPdfBuilderMode(options)`
   (`builder/pdf-designer/pdf-builder-mode.ts`) keeps one `BuilderController` per layout (created
   on first select, dropped on remove), so undo, drafts and selection survive a move between
   layouts, as the form's already do across a mode switch. It owns the layouts as documents, the
   add popover, *Preview PDF* as one of its actions, and the preview dialog as an overlay. The catalog
   and selection logic is a DOM-free model (`pdf-mode-model.ts`) over `layout-catalog.ts`; the
   dialogs live in the engine (`pdf-designer-panels.ts`, themed through `--dpd-*` tokens derived
   from the builder's `--db-*`), so every host shares one drawing.

   Its inputs are
   accessors (`formRoot()`, `values()`, `runtime()`, `templates()`, …) so it follows every edit
   without being rebuilt; `activate()` rebuilds a layout's designer only when the form tree or the
   layout id changed since the last build, so history, drafts and selection survive a round trip
   through the form side. Inspections of a template's PDF are cached per source. `support` (the
   executor: a `PdfRenderProvider`, fonts, images) may be the value or a loader awaited on first
   use; the buttons that need it are disabled with a title until it arrives.

3. **The renderer reaches the PDF pipeline only lazily.** The render core has a mode-adapter
   registry (`registerRenderModeAdapter`, `hasRenderModeAdapter`); `mode: "pdf"` looks its adapter
   up and throws `Render mode "pdf" is not available` when none is registered.
   `render/pdf/pdf-render-mode.ts` registers `buildPdfRenderModel`; `renderFormPdf` calls it first,
   so any path that renders a PDF registers the mode on its own — no module-scope side effect,
   nothing for a host to remember; `registerPdfRenderMode()` is exported for a host that builds
   PDF render models without going through `renderFormPdf`.

   `<datum-form-renderer>` imports the
   pipeline with a dynamic `import("../pdf/pdf-service.js")` inside `renderPdf()`, shared through
   one module-level promise; its properties and `pdfLayouts()` are core. The pipeline is a chunk of
   the ES form bundle that shares its engine code; nothing is fetched until the first PDF.

4. **The builder loads the PDF side lazily, in layers.** `<datum-form-builder>` registers the PDF
   mode on connect unless its `features` list leaves the PDF side out (`-pdf`), and the mode and the designer's chunk (the add popover, the
   template planners) are chunks of the builder's own bundle, loaded when the PDF side is on and a
   layout opens, a preview runs or an add is asked for.

   The executor is a further lazy chunk,
   supplied by `() => import("./pdf.js").then((m) => m.createPdfSupport())` from the builder's own
   source and fetched on the first preview, test fill or template inspection; fonts come from
   `fonts/` beside the bundle. The in-process provider is the default; the QuickJS-WASM sandbox is
   not bundled — a host that wants sandboxed execution assigns `pdfSupport` with
   `createQuickJsPdfProvider()`. Page imagery for template areas is another lazy chunk (ADR 0057).

5. **The renderer is opt-in; the builder is opt-out.** `<datum-form>` without `pdf` shows no PDF
   button and never loads the pipeline chunk or `datum-pdf.js`; `pdf="auto"` (or a URL) loads both
   on the first PDF. `<datum-form-builder>` needs no attribute (`"auto"` means the same);
   `features="-pdf"` removes the PDF mode for a host that never wants it; a URL loads a different
   executor module instead of the bundled chunk.

   The `features` list (ADR 0143) is the master over both, and `pdf` configures the PDF feature
   without ever enabling it: a `features` list that omits `pdf` leaves a renderer with no PDFs even
   where `pdf="auto"` is set, and a builder with no PDF mode or workspace even where `pdf` is
   absent. What the page or the definition asks of the omitted feature is ignored with one console
   warning, `renderPdf()` and `downloadPdf()` reject, and `datum-pdf.js` is never requested. With no
   `features` list every feature but `agent` exists, so the renderer still needs its own `pdf`
   attribute to offer PDFs.

6. **The PDF layouts alone are the same element, not a second tag.** A page that designs a
   form's PDF layouts and nothing else writes `<datum-form-builder workspaces="pdf">` (ADR 0125):
   the form's documents leave the bar, the builder opens on the PDF side, and `layout-id` names
   the layout to open on. The layout catalog API is the mode's own, reached through
   `builder.pdfMode`; the element forwards none of it, so there is one place it is defined.

   `<datum-form-builder>` emits `datum-pdf-layout-change`, `datum-pdf-layout-select` and
   `datum-pdf-designer-ready` from the mode, and its `datum-builder-change` carries `mode` and a
   wider `reason` (`"layouts"`, `"template"`) so a host persisting on every change saves PDF edits
   too. A tag per designer would need one for the journeys as well, each a list of forwarded
   members to keep in step with its mode; an attribute over the workspaces covers both.

7. **The IIFE bundles inline the chunks** (Rollup cannot code-split a classic script): the
   renderer's classic script keeps the pipeline inline (the kernel stays out of it, ADR 0043), and
   the builder's classic script is one file with the designer and the kernel inside, by decision. A
   build check (`packages/datum/scripts/check-bundles.mjs`, run by `npm run build`) holds the line:
   - The ES
     renderer bundle contains neither the pipeline nor the designer nor pdf-lib.
   - Exactly one form
     chunk carries the pipeline.
   - Exactly one builder chunk carries the designer and exactly one the
     kernel.
   - The builder's core carries neither.

8. **A host has one builder.** It is `<datum-form-builder>` with the PDF mode from
   `createPdfBuilderMode`, reading the form, the runtime's answers and the host's template
   resolver.

## Consequences

- One builder: the form and each PDF layout a document on its bar, the same palette, canvas and
  properties panels over either tree, one unsaved-edits guard, per-document undo. Hosts add modes
  of their own the same way.
- A renderer page fetches at most two PDF files, and only after a PDF is asked for.
- The engine's builder layer depends on `render/pdf`; the render core depends on nothing PDF.
- `builder-mutation` stays primary-only; a host wanting PDF mutations subscribes to the mode's
  controller (`pdfMode.controller.on("change")`).
- `BuilderController.add()` / `requestAdd()` assume no root called `root` with a `content` slot:
  with no parent or slot named (the palette's click) they take the tree's root and its `content`
  slot when it has one, else its first slot, so a PDF document (`document`; `body`, `header`,
  `footer`) takes a palette click into its body.
- The Vite lib builds set `preserveEntrySignatures: "allow-extension"` so the entry keeps its
  exports rather than becoming a facade over a chunk, and name chunks `<base>-[name]-[hash].js` so
  the lazy chunks are recognisable beside their bundle.
