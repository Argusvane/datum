# ADR 0028: Builder Preview Through the Shared Form Renderer

## Status

Accepted.

## Context

The builder canvas has to show what the live form shows: a `select`'s real options, layout containers (a `grid` with `columns: 3` three-across, not stacked), field descriptions, required markers, disabled and read-only state, the binding the form is drawn under, translated labels and conditional visibility. A second drawing path for the canvas would need a copy of every drawing decision, and would drift from the form.

The canvas also has to be editable: a field is selected by a click, dragged by a grip and dropped into a slot. That chrome is the builder's, and must not change where the form puts a field.

## Decision

1. **The canvas mounts the real `<datum-form-renderer>`.** `DatumBuilderCanvasElement` (`builder/web-component/builder-panels.ts`) sets the renderer's `binding` (the controller's pick under the builder's scheme, with the designers' own faces, `canvasComponents`, laid over it through `extendBinding`), `assets`, `colorScheme`, `canvasHooks`, `showHiddenComponents`, `dataGridRows` and the canvas chrome's sheet (`extraStyles`), each only when it changed. The live renderer (`render/live`) and the binding draw the form; the renderer's shadow root keeps the builder's CSS and the form's apart.

2. **The builder decorates what was drawn, never inside it.** `CanvasHooks` (`render/live/mount.ts`) has three template-typed points, built by `buildCanvasHooks` (`builder/web-component/canvas-hooks.ts`, through `render/live/lit.ts`):
   - `decorateField(model, content)` wraps a field's drawing in its node (`.db-node`, `data-component-id`) with the drag grip, the hidden tag and the "no options" button, and puts the drawing in a `.db-leaf` (`display: contents`) under HTML `inert`, so a click selects the field and never types into it;
   - `renderContainer(info, drawn)` wraps a container's drawing in a `.db-node--container` with its grip and type chip, never inert, since a step's or a tab's controls choose what the canvas shows. The root gets no node: it is selected from the Form settings panel and cannot be dragged or deleted;
   - `emptySlot(info)` draws a drop zone (`data-dropzone`, `data-parent-id`, `data-slot-id`) holding the slot's hint, or "Drop components here.".

   The hooks are set only while editing. Previewing and Try it set `canvasHooks = undefined`, so the form is drawn exactly as a person sees it. While the hooks are set the renderer keeps empty containers in the fold, so an empty group, tab or step can take a drop.

3. **Drop zones are found, not drawn.** A slot that holds components has no element of its own in a binding's markup. After each draw `markDropZones` (`builder/web-component/builder-shared.ts`) marks the smallest element holding a slot's drawn components (through the renderer's wrappers, `[data-component-id]` and `[data-container-id]`); the root's zone is the `<form>` (`data-db-root`).

   A slot whose components share their element with another slot is left unmarked, and a drop there lands in the container around it. So a design system's container keeps its own markup on the canvas.

4. **Chrome draws no box that moves a field.** Selection is an `outline` (solid for the selection, dashed for hover and for containers, widest for the root), never a `border` or `box-shadow`. The `db-*` classes and data attributes are the canvas's. A zone drawn by the binding shows a drag over it through an attribute (`data-db-drag-over`), because lit owns the `class` of what it draws.

5. **A design-time runtime, not `FormRuntime`.** `BuilderPreviewRuntime` (`builder/preview/builder-preview-runtime.ts`) satisfies `RenderHostRuntime` over a `FormStateStore`, an `EventBus`, a `ComponentTree` and a `RuntimeOrchestrator`.

   Rules (`visibleWhen`, `enabledWhen`, `readonlyWhen`, `requiredWhen`) are evaluated live against a scratch value store, so conditional logic behaves on the canvas as it will in the form. `setFormRoot` keeps that store across tree edits, because the builder emits a change per keystroke and rebuilding would discard what the author typed.

6. **Hidden components.** In Try it a component whose `visibleWhen` is false is left out as the live form leaves it out. While editing, the canvas draws what a rule hides (`showHiddenComponents`, the mount's `includeHidden`) unless the author turns that off in the View panel (ADR 0103, decision 3). The Outline lists every component and marks the hidden ones.

7. **A component type is drawn the same way on both surfaces.** `ComponentDefinition.adapter` (`core/schema/contracts.ts`) is the live renderer's adapter for a type, or a factory `(lit, datum) => adapter`. It is laid over whatever binding draws the form, so a plugin's type draws identically on the canvas and in the running form, with no builder-side counterpart. A type nothing draws shows the renderer's unknown-component note.

8. **After each draw,** `painted()` queues the canvas's pass: the edit-mode Tab order (`applyEditInertness`), the drop zones (`markZones`, which calls `markDropZones`) and the sheet colour (`syncSheetColour`, ADR 0163).

9. **Where a drag over the canvas lands** (`dropZoneOnPath` in `builder-shared.ts`):
   1. the nearest drop zone on the event's composed path;
   2. else the one zone a container's own chrome wraps: a PDF page band's label and padding, a tab panel's padding, a card's heading, a group's legend. An element wrapping several zones (a grid's columns, the PDF page's three bands, the form root) is ambiguous and skipped, and a node's grip and type chip count only for the zone around the node;
   3. else, anywhere over the canvas, the root's first declared slot: `content` for a form, `body` for a PDF document.

   Falling through to the root's first zone in document order would send every drop on blank paper or the footer band's label to the PDF sheet's header band, which the page draws first.

## Reasoning

- **One renderer.** The canvas's promise is that the form looks like this. Only the form's own renderer and binding can keep it, for every binding a host registers.
- **Hooks around the drawing.** A binding owns its leaf markup. Decorating outside it, and marking drop zones on what it drew, lets a design system's markup reach the canvas unchanged.
- **Inert leaves.** `inert` takes a field's controls out of the pointer, the Tab order and the selection in one attribute, whatever markup the binding draws.
- **A design-time runtime.** `FormRuntime` demands a `ValidationPipeline` and a `SubmissionModeRegistry` the builder has no business inventing.

## Consequences

- Adding a component type means registering a definition with an `adapter`; both surfaces draw it.
- `builder/` imports `runtime/browser/runtime-orchestrator.js` and `render/`. These are downward imports; the layering check in `check-architecture-boundaries.mjs` constrains only `core/` (the script also bans icon-library imports engine-wide, ADR 0048).
- The canvas draws asynchronously, like the live form, because building a render model resolves data-source options. Hosts and tests read the drawn form through `DatumBuilderCanvasElement.previewRoot()`.
- A design-system stylesheet the canvas cannot fetch draws the renderer's alert in the canvas's place, naming the URL, as the live form does.
- `engine/tests/builder-preview-parity.test.ts` holds the preview runtime's render model equal to the live runtime's on the same tree.
