# The builder element

`<datum-form-builder>` is the design surface. It edits one definition and returns it as JSON through the `definition` property, saves it to your server, or hands it to the person through its own file actions.

```html
<link rel="stylesheet" href="datum-builder.css">
<script type="module" src="datum-builder.js"></script>

<datum-form-builder
  src="/forms/intake.json"
  save="/api/forms/intake"
  layout="contained"
></datum-form-builder>
```

`src` loads the form and `save` stores it at that address: Save appears in the ⋮ menu at the end of the bar, and on Ctrl/Cmd+S. No script is needed.

## Attributes

<!--@include: ./_generated/builder-attributes.md-->

## Properties without an attribute

<!--@include: ./_generated/builder-properties.md-->

## Saving

There are three ways to save:

- `save` with an address sends the form there.
- A bare `save` fires `datum-builder-save`.
- `fileActions.save` takes a function.

[Saving forms](/saving-forms) chooses between them and covers `dirty`, the leave guard and language changes.

## Workspace or mode

The builder has two ways of saying where the author is, and one of them is enough.

- **`workspace`** is the tab on the bar: `form`, `logic`, `data`, `languages`, `journeys`, `pdf` or `print`. It is the one to use.
  - Set the attribute or property to start somewhere other than Form.
  - Call `setWorkspace(id)` to move.
  - Listen to `datum-builder-workspace-change` (`detail.workspace` and `detail.previous`).
  - A switch goes through the unsaved-edits guard, so `setWorkspace()` returns `false` for a workspace that is off or hidden, and `true` when the switch has started, which includes waiting for the question the guard asks.
- **`mode`** is lower level: which document designer is on the canvas, `form`, `pdf` or `journeys`. Journeys and PDF are both a workspace and a mode, but opening the workspace shows its list of journeys or layouts with the form still the mode, and the mode changes only when one of them is opened.
  - `datum-builder-mode-change` (`detail.mode` and `detail.previous`) and the `mode` field of `datum-builder-change` use it.
  - `modes` lists the ones on offer.
  - `showModeSwitch` and `hiddenModeIds` are for pages that lay out their own switch.

A page that wires both gets both events for one move. Set attributes before the element connects: a call to `setWorkspace()` straight after `createElement` has nothing to act on yet.

## One workspace alone

`workspaces` names the only workspaces the bar offers. A page where someone designs a form's PDF layouts and nothing else asks for the PDF workspace alone:

```html
<datum-form-builder workspaces="pdf" file-actions="off"
  layout="contained" style="height: 720px"
  src="/forms/intake.json"
  values='{"fullName":"Ada Lovelace"}'></datum-form-builder>

<script type="module">
  const builder = document.querySelector("datum-form-builder");
  builder.addEventListener("datum-pdf-layout-change", (event) => {
    save(event.detail.definition);
  });
</script>
```

`workspaces="journeys"` does the same for the journeys. With a list of `pdf` or `journeys` alone:

- The builder opens on that workspace, and the bar has no workspace switch. The form's components and rules pass through untouched.
- A loading card stands in the builder's place until the workspace's code is in, so the form editor never shows first.
- New, Open and Download still work over the whole form. `file-actions="off"` puts them away, or `file-actions="download"` keeps one.

A longer list, such as `workspaces="form logic"`, only narrows the tabs. `features` and `hidden-workspaces` still take away from the list, and none of them brings a workspace back.

Two more attributes suit this page:

- `values` gives the PDF preview sample answers to draw.
- `layout-id` names the layout to open on.

### Driving the PDF layouts from script

A page with its own layout list drives the PDF side through `pdfMode`. It is `undefined` until the PDF code is in, so wait for `datum-pdf-designer-ready` before using it.

```js
builder.addEventListener("datum-pdf-designer-ready", () => {
  const layout = builder.pdfMode.newLayout({ name: "Registry copy", from: "form" });
});
```

| `pdfMode` member | What it is |
|---|---|
| `layouts` | The layouts, in the definition's order. |
| `layoutId` | Which layout is on the page. The builder's own `layoutId` property (the `layout-id` attribute) sets it. |
| `pdfLayout` | The layout on the page as designed so far. |
| `ready` | Whether the layout on the page is up. |
| `controller` | The builder controller over the layout's tree. |
| `selectLayout(id)` | Puts a layout on the page. |
| `newLayout(options)` | Makes a layout and returns it. `options` is `{ name, from, select }`: `from` is `"form"` (derived from the form), `"blank"` or `"copy"` of the layout on the page; `select` defaults to true. |
| `addLayout(layout, { select })` | Adds a layout the page made or loaded. |
| `addTemplateLayout(source, name)` | Adds an existing PDF as a template layout, ready for its fields to be mapped. `source` is `{ storage, name, type, size, data }` for a file held in the layout as base64, or `{ storage, name, type, size, ref }` for a file your own store holds (see [Offering your own PDFs](#offering-your-own-pdfs)). |
| `replaceLayout(id, layout)` | Swaps a layout for another under the same id. |
| `duplicateLayout(id, options)` | Copies a layout and returns the copy. `options` may carry `id`, `name` and `select`. |
| `renameLayout(id, name)` | Renames a layout. |
| `moveLayout(id, toIndex)` | Moves a layout in the order they are tried in. |
| `setDefaultLayout(id)` | Makes a layout the one drawn when no condition holds. |
| `removeLayout(id)` | Removes a layout. |
| `openAdd(anchor)` | Opens the PDF side's own Add menu, beside an element of the page's. |
| `previewPdf()` | Draws the preview now. |
| `renderPdf({ layoutId })` | Draws the PDF and resolves with a result whose `bytes` are the file, with `pageCount`, `warnings`, `layoutId` and `fileName`. |

Layouts, templates and what a PDF can carry are described in [PDFs](/pdf).

## Remembering the layout

`persist-panels="key"` has the builder remember, in the browser's `localStorage` under that key, and put back the next time a builder with the same key opens:

- Which strip panel is open.
- The widths of the side column and the inspector.
- Whether the inspector is folded.
- The workspace.

An attribute with no value uses the key `default`. Things to know:

- The workspace stored is the last of Form, Logic, Data, Languages and Print the author was in. Journeys and PDF are never stored, so an author who leaves from one of them comes back to that earlier workspace.
- A stored workspace wins over the `workspace` attribute. With one stored, `workspace="pdf"` opens the stored workspace, not PDF. The attribute decides only when nothing is stored, or when the stored workspace is not available.
- The store belongs to the origin, so two builders on one origin with one key share a layout. Give each its own key.
- Where `localStorage` is blocked, the layout is kept for the life of the page only.

## Settings the page owns

`managed-settings` lists inspector settings the page keeps for itself. For each one:

- The inspector shows "Managed by the site." in place of the box and never changes the stored value.
- The JSON editor refuses text that would change it.

A setting is named by its property path in the component's configuration, as it appears in the JSON of the component: `required`, `label`, `data.answersFree`, `chrome.frame`. One word is shorthand: `answersFree` means `data.answersFree`.

To find a path, select a component, open Edit JSON on the inspector's ⋯ menu and read the key.

```html
<datum-form-builder managed-settings="required data.answersFree"></datum-form-builder>
```

## Offering your own PDFs

An uploaded PDF template is kept inside the definition as base64. A host that keeps its PDFs in a store gives the builder a resolver instead, and the layout then carries only a storage kind and a reference, never the bytes. Set `pdfTemplates` to an object made by `createPdfTemplateResolver`, exported by `datum-builder.js`:

```js
import { createPdfTemplateResolver } from "./datum-builder.js";

builder.pdfTemplates = createPdfTemplateResolver(
  {
    // How each storage kind turns a reference into bytes.
    assets: async (source) => new Uint8Array(await (await fetch(`/pdf/${source.ref}`)).arrayBuffer())
  },
  {
    // The PDFs the designer offers beside Upload.
    templates: [
      { id: "permit", label: "Permit application", source: { storage: "assets", name: "permit.pdf", type: "application/pdf", size: 98304, ref: "permit-v3" } }
    ],
    // ICC profiles offered as PDF/A output conditions.
    profiles: []
  }
);
```

- The first argument maps a storage kind to a function from a template source to its bytes; the kind `base64` is always understood.
- `templates` and `profiles` are lists, or functions that return a promise of one, and both are optional.
- A source is `{ storage, name, type, size }` with `data` (base64) for an embedded file or `ref` for one the host finds.
- The same resolver turns a layout's source into bytes whenever the PDF is drawn.

## Formula functions

Functions that plugins contribute to the formula language are listed in the Logic editor, the inspector, the form settings and the Variables panel, and a call to one is evaluated on the canvas and in Try it, with no further wiring: the builder reads them from the plugins on the page and on the element. Set `formulaFunctions` only to hand it a different source: the plugin platform's formula function registry, or any object with:

- `table()`: rows to list.
- `signatures()`: names and argument counts, so formulas parse.
- `functions()`: optional; the evaluators, by name.

A source without `functions()` lists and parses the names, and a call to one works out to nothing while authoring.

## More properties

| Property | What it is |
|---|---|
| `save` | `false`, `true` or an address: the property behind the `save` attribute. |
| `dirty` | Whether the form differs from the saved one, drafts held in a panel included. It is also reflected as a `dirty` attribute on the element, so a Save button can be styled from CSS. |
| `savedDefinition` | The baseline `dirty` compares with. Setting it makes the form saved at that definition. |
| `definition` | The form being edited, as authored so far. |
| `controller` | The engine's builder controller behind the form's panels, for a page that needs the whole engine surface. |
| `builder` | The inner `<datum-builder>`. |
| `componentTypeFilter` | The property for `component-types`, which limits the palette. The different property `componentTypes` adds entries to it. |
| `modes`, `mode`, `showModeSwitch`, `hiddenModeIds` | See [Workspace or mode](#workspace-or-mode). |
| `pdfMode`, `journeyMode`, `pdfConfiguration`, `journeyConfiguration` | The designer sides and the objects behind `pdf` and `journeys`. |
| `serverChecks` | The object behind `wasm`. |

These attributes have no property of their own: `debug`, `no-full-window`, `no-scheme-toggle`, `allow-origins` and `leave-guard`.

## Hosting the builder

The builder is a page component like the form.

- Give it `layout="contained"` inside your own shell, or `page` to take the viewport.
- A host that keeps definitions gives the builder a Save (see [Saving forms](/saving-forms)); the Spring Boot and FastAPI hosts have write endpoints for it, off by default.
- The builder's own strings can be translated for a workspace in another language.

Which workspaces and panels show, the builder's own look, its command palette and its languages are covered in [Customising the builder](/customising-the-builder).

## Events

Every event bubbles and crosses shadow boundaries.

<!--@include: ./_generated/builder-events.md-->

### `datum-builder-change`

Fires after every change to the form, and when the selection moves. A keystroke typed into the inspector is not a change until Apply. `detail`:

| Field | Meaning |
|---|---|
| `definition` | The whole form as authored. |
| `reason` | Why it changed. On the form: `init` (the form was loaded or replaced, by `definition`, `src`, New or Open), `add`, `move`, `remove`, `edit`, `select` (only the selection moved). On the PDF side: `layouts` and `template`, with the form's own reasons. On the Journeys side: `journeys`, `form-rename`, `page-rename` and `journey-rename`. A change that only restyled the canvas is not announced. |
| `mode` | Which side changed: `form`, `pdf` or `journeys`. |
| `selectedComponentId` | The selected component on the form side, else `undefined`. |
| `renamed` | Only on the change that gave a component a new id: `{ from, to }`, with `dataPath` (where its answers moved to, `[]` standing for a repeating section's entries), `rules` (ids of the components whose rules were rewritten) and `unparsed` (formulas that spell the old id but do not parse, left as written). Journeys follow the rename in a `form-rename` change of their own. |
| `renameStepped` | Only on the change an Undo or Redo of a rename made: `{ from, to, by }`, with `by` `undo` or `redo`. |
| `dataMoved` | Only on a change that moved where answers are stored (a data key, a container's key, a container that stops or starts nesting data): a list of `{ from, to }` value paths. Undo announces the moves reversed and Redo the same moves again. |
| `historyStep` | `undo` or `redo` on every change an Undo or Redo made, so you can tell a redone `dataMoved` from a new one. |

A page that keeps anything keyed by answer path (drafts, tests, a catalogue) follows `dataMoved` as one map, so two keys swapped stay swapped, and applies each change's map exactly once, as it is told. Undo and Redo send theirs with `historyStep` precisely so that each is applied once and in the direction the author went.

### The other events

| Event | `detail` |
|---|---|
| `datum-builder-file-action` | `{ action, name?, definition, trigger?, warnings? }`. `action` is `new`, `open`, `download` or `save`; `definition` is the form after it; `warnings` is on a Download that left something to say (`no-submit-button`: the form has no Submit button). |
| `datum-builder-workspace-change` | `{ workspace, previous }`. |
| `datum-builder-mode-change` | `{ mode, previous }`. |
| `datum-builder-dirty-change` | `{ dirty }`, when the form starts or stops differing from the saved one. |
| `datum-builder-binding-change` | `{ bindingId }`, when the author picks a design system for the canvas in the View panel. `datum` is Datum's own. |
| `datum-builder-full-window-change` | `{ fullWindow }`. |
| `datum-builder-scheme-change` | `{ scheme }`, `light` or `dark`, when the author switches Dark mode in the menu. |
| `datum-pdf-layout-change` | `{ layout, pdf, definition, reason }`: the layout edited, the layouts block and the form to save. |
| `datum-pdf-layout-select` | `{ layoutId, layout }`. |
| `datum-pdf-designer-ready` | `{ layout }`: a layout is up. |
| `datum-journey-change` | `{ journey?, configuration, definition, reason, renamed? }`: the journey concerned, the `journey` block as it stands, and for `page-rename` and `journey-rename` `renamed` as `{ journeyId, from, to }`. |
| `datum-journey-select` | `{ journeyId, journey }`. |
| `datum-error` | `{ code, message, cause? }`: a form refused, an attribute refused, a file that did not load. `code` names the cause; the [codes](/codes#datum-error-codes) page lists them. |
| `datum-warning` | `{ message, code, count?, addresses? }`: something taken but not whole, such as `translations.dropped` or `src.superseded`. |

`datum-builder-save`, for the Save a page asks for, is described in [Saving forms](/saving-forms#a-request-of-your-own).

## Methods

| Method | Does |
|---|---|
| `markSaved()` | Tells the builder the page has saved: the definition and its languages as they stand become the baseline, and `dirty` clears. |
| `hasUnsavedChanges()` | Whether an edit is still open in a panel that a leave would lose. A changed definition is the `dirty` property. |
| `requestLeave(run)` | Runs `run` at once when nothing is open, otherwise after the person answers the builder's Save or Discard question. Call it before swapping the builder out. |
| `localeChangesSinceSave()` | The languages changed since the last save, for a page that keeps a translation catalog of its own. |
| `markLocalesSaved()` | Makes the languages as they stand the baseline, after a save of the page's own. `markSaved()` does the same. |
| `setWorkspace(id)` | Opens a workspace. Returns `false` for one that is off or hidden. See [Workspace or mode](#workspace-or-mode). |
| `setMode(id)` | Opens a document designer by its mode id. Returns `false` for one that is off or hidden. |
| `featureEnabled(name)` | Whether a part named in `features` is on, such as `pdf` or `tests`. |
| `undo()`, `redo()` | Undo and redo on the side the author is looking at. |
| `openPalette()` | Opens the command palette, as Ctrl+K or Cmd+K does inside the builder. See [Keyboard shortcuts](/shortcuts). |
| `registerCommands(source)` | Adds the page's own commands to the palette, such as Publish. `source` is `{ commands() }` and is read each time the palette opens. Returns a function that removes them. |
| `triedAnswers()` | The answers the author typed in Try it, by value path, without the page's `values`. |
| `clearTriedAnswers()` | Empties them, as the Try panel's Clear answers does. |
| `agentTools()` | With the `agent` feature: the builder's tools for a browser assistant. See [Browser assistants](/assistants). |
| `executeAgentTool(name, input)` | Runs one of those tools and resolves with its result, a refusal included. |

## Exports

`datum-builder.js` also exports:

- `createPdfTemplateResolver`
- `parseBuilderFeatures`, `normalizeBuilderFeatures`, `BUILDER_FEATURES` and `BUILDER_FEATURE_PRESETS`
- `formDefinitionProblem`: the check Open applies to a file, for a page that reads files itself.
- `adoptBuilderHostControlStyles`
- `BUILDER_THEMES` and `resolveBuilderTheme`
- `BUILDER_WORKSPACES`
- The element classes.

The classic script `datum-builder.iife.js` exposes them on `window.DatumBuilder`.
