# ADR 0125: Builder workspaces

## Status

Accepted.

## Context

The strip holds the builder's panels, and the studio design groups the work by what the author is doing: building the form, its logic, its data, its languages, its journeys, its PDF layouts. That grouping is a layer over the builder's modes, not a replacement for them: `BuilderMode` (form, PDF, journeys) is a public API that hosts use (decision 10; ADR 0099, section 5).

## Decision

1. **Seven workspaces.** `BuilderWorkspace` is `"form" | "logic" | "data" | "languages" | "journeys" | "pdf" | "print"`. They are tabs on the bar after the leading group (`role="tablist"`, one Tab stop, arrows, Home and End, Enter or a click to switch). Under 1024px of shell (a container query) the tabs become one native menu. Journeys and PDF are offered only while their mode is registered: `journeys="off"` or `pdf="off"` removes the tab, and so does `removeMode`. If that workspace was on the page, the form's last workspace comes back.

   A host narrows the tabs two ways on `<datum-form-builder>`:
   - `hidden-workspaces` lists the ones to leave off;
   - `workspaces` lists the only ones to offer (the wrapper turns it into the hidden list the shell is given; `features`, `pdf="off"`, `journeys="off"` and `hidden-workspaces` still take away from it).

   A `workspaces` list of `pdf` or `journeys` alone, with neither the form nor a workspace over it, is a designer alone: the wrapper adds the form to `hiddenModeIds`, opens on the first side listed once its mode registers, and keeps the shell hidden behind a loading card (then the failure card with Retry) while that mode's chunk is coming, so the form editor never shows in its place. It implies nothing else: the file actions and every other attribute behave as on any builder. One attribute serves both designers, where a tag per designer would be a subclass forwarding its mode's API for each.

2. **A layer, not a mode.** Form, Logic, Data, Languages and Print (ADR 0174) edit the form's controller and never another mode's. Journeys and PDF each belong to a mode. Entering one from a tab, the palette or `setWorkspace` puts the form back on the page as the mode and draws that side's overview where the canvas is (decision 6).

   Every mode change made anywhere (`setMode`, `selectDocument`, the palette, the `mode` attribute, a host's `removeMode`) passes through `reflectMode`, the one place that moves the workspace: the journeys mode belongs to Journeys, the PDF mode to PDF. The form back on the page by any route other than an overview's return goes to the form's last workspace. A host mode of another kind keeps the workspace it opened in.

3. **Each workspace owns strip panels.** `SHELL_PANELS` gives each panel its workspaces; items another workspace owns carry `data-out-of-workspace` and are not drawn.

   | Panel | Workspaces |
   | --- | --- |
   | Form settings | Form, Journeys, PDF |
   | Header & footer | Form |
   | Components | Journeys, PDF (in Form, the rail's All components opens the palette) |
   | Form fields | Journeys, while the Step view is up |
   | Outline | Form, Logic, Journeys, PDF |
   | Variables | Logic, Data, Journeys, PDF, Print |
   | Tests | Form, Logic, Data, Journeys, PDF, Print |
   | View | Form |
   | Settings | every workspace |

   The strip's form panel is labelled "Form settings", so that it does not share its name with the Form tab; its id stays `form`. A host's strip item names its workspaces in `data-workspace` (space-separated); naming none, it shows in every workspace.

   A workspace opens on the panel last open there, else its default (Components in Form; none in Logic, Data, Languages and Print, whose own surfaces fill the canvas's place; the panels they offer open beside them); a panel the new workspace also offers stays open. A designer opened from its overview opens with no panel, and going back from a designer to its overview puts the drawer away.

4. **A switch goes through the unsaved-edits guard.** An unapplied draft holds it behind the Apply / Discard / Stay prompt, and the menu returns to the current workspace while it is held. Every way back to an overview asks the same way: the bar's "‹ Journeys" and "‹ Layouts", a phone's back title, and the drawer's All journeys or All layouts. A workspace chosen while a designer is still loading wins: the pending activation is superseded. Focus lands on something visible after every switch between an overview and a designer, and after a rename: the card, the canvas or the document label.

   A host that names a panel the workspace on the page does not offer (the `panel` property, an assistant's `open`) moves the workspace for it, behind the same guard: a Stay leaves both as they were, and an assistant is refused rather than raising the author's prompt.

   A host that takes the workspace away (`features`, `hidden-workspaces`) does not ask: what the workspace holds unapplied is discarded through that surface's own discard, so its pending state and its guard clear, and the author leaves at once. Work in a panel that stays open beside the workspace the author lands on, such as a scenario in the Tests panel, is not the workspace's and is kept. A workspace the bar no longer offers is never drawn as the selected tab.

   Ctrl or Cmd+Z, Shift+Z and Y in Print and Languages step the form's history through the shell's one `historyStep`, as the outline, the fields panel and the canvas do, and suppress the browser's per-box text undo. Typed values still waiting are written first, so the key takes back what the author sees.

5. **API.** `<datum-builder>` and `<datum-form-builder>` take the `workspace` attribute and property (reflected), `hidden-workspaces`, and `setWorkspace(id)` (it returns whether the switch started now); `availableWorkspaces()` lists Journeys and PDF only while their modes are registered; `builder-workspace-change` / `datum-builder-workspace-change` carries `{ workspace, previous }` (`docs/reference/attributes.md`, `docs/reference/builder.md`). A workspace the host hides while it is on the page gives way to the first shown, at once and without a prompt.

   `persist-panels` remembers `form`, `logic`, `data`, `languages` or `print` in an optional `workspace` of its record, and that wins over the host's attribute. The designer workspaces are never put back, since their modes may not be registered yet when the shell comes up.

6. **Journeys and PDF open on an overview.** `builder/overview/overview-surface.ts` (`<datum-builder-overview>`, with a `section` of `journeys` or `pdf`) is one lazy chunk, loaded by `overview-loader.ts` the first time either opens (`check-bundles` holds its sentinel `data-overview-open` to that one chunk). It is drawn where the canvas is, and the wrap carries `data-overview` while it shows, which hides the rails.

   - **What each lists.** Journeys lists each journey with its steps, how many fields it asks of the form's and its problems, and "+ New journey"; the one the form opens as is marked. PDF lists the layouts numbered in the order they are tried (ADR 0044), with the default, each `when` rule as a sentence (`conditionSentence`) and its findings (`pdfLayoutConditionFindings`), whether each fills a PDF or is generated, and "+ New layout". With nothing to list, each says so; the PDF overview's note is that a PDF of the form prints from the form as it stands (ADR 0044).
   - **Open.** A card's Open puts that document's designer on the page with the workspace kept. The bar then shows "‹ Journeys" or "‹ Layouts" leading the document's pill, after the workspace tabs and before the document's name, divided from it by a hairline (`[data-overview-back]`; on the bar, not the canvas, so no row above the page is kept for it, and never before the tabs, so they do not move when it shows), which returns to the overview. From one designer, the other workspace's tab opens that workspace's overview, not a document. The surface raises `overview-open` and `overview-add`.
   - **New starts on the overview.** An overview's "+ New" starts the add flow over the overview, with the form still the page's mode; so do the palette's New and a host's `newDocument` when that mode's designer is not on the page (the shell enters the workspace's overview first). When the designer is already on the page they run the flow there instead, anchored on the document label. The shell puts up only the mode's popover and styles for the flow; a mode that loads them in a chunk loads it first (`documents.prepareAdd`).

     The popover opens under the overview's New when that button started it, and is centred near the builder's top, held within its box, when the palette or `newDocument` did, since nothing is anchored. It offers no "copy of this one", since no document is on the page. A choice opens the new document's designer; Escape or a click elsewhere leaves the overview as it was. The mode reports the end through `add(anchor, kind, { fromOverview, onEnd })`, and the shell also opens a document that appears in the mode's list meanwhile, for a mode that never reports. `setMode` on a designer with no documents opens its overview, and deleting the last one returns there. A designer alone (`workspaces="pdf"`), which hides the form, keeps the PDF side's own empty page.

7. **Host places on the bar.** The `history`, `comments`, `publish` and `account` slots join `toolbar-start`, `toolbar` and `canvas-actions`, each drawn only when filled and dressed by the host-control sheet (ADR 0124). `<datum-form-builder>` forwards all of them, and `strip` and `panel` too; the shell reads its strip and panel slots flattened.

8. **Problem counts on the tabs.** `workspaceProblems` takes counts per workspace from a host or the wrapper, under the keys of the workspaces. Data adds the form's data-key clashes (ADR 0109) itself. The wrapper counts `journeys` from the journey diagnostics chunk, loaded when the page is idle after a change (until then the tab shows no count and nothing waits), and `pdf` from the layouts' rule findings (ADR 0044). A count is a danger chip drawn `aria-hidden`, and the tab's name says it in words ("Data, 2 problems").

9. **The saved baseline.** `<datum-form-builder>` takes the definition it loads as the saved one, at the first seeding; `markSaved()` after the host saves, or `savedDefinition`, moves it, and `dirty` follows every change on any side (`docs/reference/embedding.md`, "Saving and problems"). The PDF and Journeys modes read their blocks in their own words when they attach (the PDF side, for one, names its default layout), so until the author edits anything the baseline is taken again as each mode attaches, and neither `dirty` nor a later comparison counts that difference. A host's `markSaved()` or `savedDefinition` is never overridden.

   A layout that fails validation is left out of the builder and reported through `datum-error`, naming each layout and why; the saved baseline keeps it as declared, so the form opens dirty, and the host's next save is a choice the author can see. `markSaved()` accepts the loss.

10. **Modes are a PDF-agnostic facility of `<datum-builder>`.** A mode is a controller plus chrome: `BuilderMode { id, label, controller, activate?, deactivate?, documents?, barActions?, overlays?, styles?, inspector?, tryIt?, dispose? }` and further optional hooks (`builder/web-component/builder-modes.ts`). The shell seeds the primary mode `"form"` from its own controller; a host adds others with `addMode()` and takes one away with `removeMode()`. A mode's `controller` may be a getter: a mode with several documents keeps one controller per document and answers with the selected one, and the shell reads it again after every `documents.select()`. The shell never learns what a PDF is; the PDF designer is one mode provider (ADR 0045).

    - **Documents.** A mode's `documents` (`BuilderDocuments`: `list()`, `selectedId()`, `select(id)`, `subscribe(listener)`, and optionally `add(anchor, kind, options)`, `prepareAdd`, `rename`, `duplicate`, `remove`, `setDefault`, `move`) are what the bar's documents dropdown lists, the form's own first; a mode without documents is one entry. Choosing one goes through the active controller's unsaved-edits guard (`requestLeave`), deactivates the old mode, awaits the new one's `activate()`, and re-points the toolbar, canvas and properties panels at its controller. `hiddenModeIds` leaves a mode's documents out and `showModeSwitch` hides the dropdown.
    - **Events and state.** The `mode` attribute and property reflect the active mode. `builder-mode-change` (bubbling, composed) reports it, `builder-document-change` a move between documents, and `builder-mode-error` a failed activation, with the builder staying put. `value`, `options`, `controller`, `builder-change` and `builder-mutation` stay the primary mode's; `activeController` is whichever mode is on the page; `undo()` and `redo()` act on it.
    - **Chrome.** A mode's `barActions` sit inside the shell's shadow (its views switch on the bar, its actions in the canvas's toolbar, ADR 0141), its `overlays` (dialogs) are appended to the shadow for its lifetime, and `BuilderModeContext.showCanvasSurface()` puts an element on the canvas in the sheet's place, the panels staying. A mode may also say what the properties panel offers over its tree (`inspector`).

11. **The Languages workspace.** The Languages workspace (`builder/languages/`, a lazy chunk like Data's) draws where the canvas is, with no drawer of its own (Settings opens beside it). It gathers every text the form says in every language; the translations themselves are the definition's own map (ADR 0158). The inspector edits the default text only: a `localized-text` field is one plain box, and the pointer line under a component's texts (its coverage per language and Open in Languages) opens this workspace on that component.

    - **The form's languages.** Their names, the default, and add and remove. Each change is one undo step, run by the controller's `localizationActions`. Removing a language asks first and says how many translations go with it; the removal prunes them in the same step. Making a language the default, renaming a code and removing the default language are held back while the Form settings panel has unapplied edits, until the author applies or discards them.
    - **Every text.** Labels, hints, options, validation messages, the header and footer, and the journeys' and layouts' wording are rows. Each language is a column, with coverage counts, search, a kind filter and a status filter (All, Missing, Source changed, Overridden by the page).
    - **The page's catalog.** A host that lends its catalog (`translationsSource`) has the texts it words shown read-only, as the page words them, under "Page catalog".
    - **Applying.** Typed translations wait under "Translations not applied" with Apply and Discard. Apply is one `setTranslations` call, so one undo step. While translations wait, a leave guard asks before the author leaves.
    - **The language switcher.** Where the form lets a person change its language (the header, the footer, both or neither) and what the control is called; the preview language the canvas shows is here and in Settings.
    - **From elsewhere.** The pointer line's Open in Languages, under a component's texts and under a part of the header and footer, opens Languages filtered to that text.

## Reasoning

- **Workspaces are a layer.** Keeping `BuilderMode` as the public API means the four hosts that register modes keep working; the layer only decides which panels and which surface are drawn.
- **Journeys and PDF layouts are separate workspaces.** They are separate kinds of work with separate designers. A single map of the form, its journeys and its layouts, with print, checks, a diff and an embed snippet beside them, would repeat what Try it already does (print, the server's checks) or what the builder does not need. Each designer workspace opening on an overview of its own documents is the part that earns its place.
- **No overflow menu.** The file actions stay on the bar at every width rather than folding into a ⋯ menu, whose contents are unclear; at Narrow the bar's side groups take only the width their controls need, and the document's name gives way first.

## Consequences

- The strip lists what the author needs for the work at hand; a host's strip item that names no workspace shows in every workspace.
- A host that sets `workspace` or calls `setWorkspace` uses `form`, `logic`, `data`, `languages`, `journeys`, `pdf` or `print`; any other id is ignored. A host that lists workspaces in `hidden-workspaces` can leave Languages off with `languages`.
- A host that switches PDF and journeys off has four workspaces.
- The overviews show no previews of a printed form or a layout; the Print workspace (ADR 0174) is where a printed form is previewed.
- Phones keep the same workspaces (ADR 0137).
