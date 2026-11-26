# ADR 0103: Panels on the activity strip: form settings, header and footer, variables, view and settings

## Status

Accepted.

## Context

The activity strip exists so that every feature is one more strip item, not another bar button or dialog (ADR 0099). The form-level places an author goes to are strip panels, not a state the inspector falls into when nothing is selected (ADR 0111): Form settings, Header & footer, Variables, View and Settings. Each is one strip item, one icon name drawn by every shipped icon set, one custom element where it has one, and one value in the remembered-panel union, and no new `--db-*` token.

On a PDF layout the root carries the PDF file, the fill options, the archival settings and the signature choice, reached through the same Form settings panel.

A form's author also composes a header and footer (ADR 0066: `root.configuration.chrome`, the part union, the merge with the host's parts). The editor for them has to handle a list of typed parts, each with its own boxes, and groups holding more parts. That does not fit a one-line property row in the Form settings panel, and a modal dialog with its own working copy shows nothing on the canvas until Apply. The header and footer are form-level, so they are one more strip item.

Several places in the builder take a reference to an answer, and each leaves the author to know what may be written there: a rule is a formula that names a field by its id, with scoped prefixes; a journey's condition is a formula over the form's answers by id; a PDF layout's text holds `{{placeholders}}` over value paths. Help lines name a few; nothing lists the fields with the reference that reaches each.

## Decision

### Form settings, view and settings

1. **A Form settings item leads the activity strip.** It opens a panel in the side column (`data-form-panel-item`), toggling the way the other strip items do, and is remembered under `persist-panels` (ADR 0099). It is labelled "Form settings" so as not to share its name with the Form workspace's tab; its id is `form`. It is offered in the Form, Journeys and PDF workspaces.

2. **The panel edits the active controller's root, whatever the tab.** On the form it is the form's settings; on another mode's document it is that document's, under the mode's own word for it: `BuilderMode.inspector.settingsLabel` ("Layout" for a PDF layout, "Journey" for a journey). One rule, and nothing becomes unreachable on a tab that is not the form's. The panel is the inspector element scoped to the root (ADR 0111, decision 10).

3. **The strip takes the canvas controls, and opens to a host.** How the canvas shows the form, not what the form is, lives in the View panel the strip opens, for the preview only: the preview width, the design-system binding the canvas draws with (ADR 0157), the form chrome the preview is drawn under, and whether a rule's hidden components are drawn. The chrome is the page's frame (not set, or one the binding draws), whether the page fixes that frame, the form's header and footer shown or left out, and the language switcher shown or not; it is `controller.previewChrome()` / `setPreviewChrome()`, handed to the canvas renderer's `chrome`, and the definition never holds it. "Show components a rule hides" (`[data-show-hidden]`) is a checkbox, on by default (`controller.showHiddenComponents()`): an author edits what the form has, and Try it shows what a person sees.

   In a panel these carry labels instead of an icon and a tooltip. A `strip` slot lets a host put its own launchers on the strip below the built-in ones. What a host wires around the builder, rather than opens from it, does not belong on the builder at all: such a control sits on the host's own toolbar above the shell.

4. **A docked panel paints only when it has something new to show, and only when it is on screen.** Every panel is a permanent subscriber to the controller, so an author typing a field's label would otherwise repaint the palette, whose catalogue cannot depend on it, and the Form panel, which sits on the root and is behind its strip item. Four rules, all on `BuilderPanelElement`:
   - A paint whose markup is what the panel already shows does not touch the DOM.
   - A panel that is `hidden` does not paint at all, and makes the paint up when its strip item opens it.
   - A caller setting several properties at once holds the paints and takes one at the end (`suspendPaints` / `resumePaints`, which the shell uses as it re-points the panels).
   - A panel may refuse a change outright: the palette ignores `edit`, `select` and `preview`, and the inspector ignores an `edit` that left its own subject alone.

   A live draft write under a formula box (`BuilderChangeEvent.live`, ADR 0140) refreshes the panel that made it in place and paints nothing else.

   A hidden panel's DOM is therefore the last paint's until it is opened. A host or test reading a closed panel's shadow root reads stale markup, and should open the panel first.

5. **A host puts its own panels on the strip, and the column is wide enough to hold them.** A `slot="strip"` item naming a panel in `data-panel`, and a `slot="panel"` element naming the same one, are a pair the shell opens and closes together; `DatumBuilderPanel` widens to any such id. The host draws the panel; the shell only shows and hides it.
   - A host panel is not remembered by `persist-panels`, since it may not be slotted next time.
   - A click inside such a panel is not a click on the item that opens it: the shell takes a strip item to be one under `[data-strip]` or assigned to the strip's slot, since a host's panel names itself the same way and would otherwise close itself on every click inside it.
   - A host's strip items are the shell's equals for the keyboard and for assistive technology (the arrow keys, `aria-selected` on every panel change and when an item is slotted).
   - An item names the workspaces that show it in `data-workspace` (ADR 0125); naming none, it shows in all.

   The side column runs to 900px (ADR 0099), since the panels it holds include wide tables and grids, and its grip draws a hairline of its own instead of being invisible until hovered (the inspector's grip is the exception, ADR 0111, decision 20), which is the difference between a column that can be resized and one nobody discovers can be.

### Header and footer

6. **A Header & footer item follows Form on the activity strip.** It opens a panel in the side column like Form, Components and Outline, toggles the way they do, and is remembered under `persist-panels` as they are (`RememberedPanel` includes `"chrome"`). The element is `datum-builder-chrome-panel`, exported from the engine's builder index.

7. **The panel edits both regions at once, and the root's draft directly.** It lists the header and then the footer, each a section of blocks, one per part, with its type, its place on its row and its own boxes, groups indented with their own Add, and Add at the end of each. There is no working copy of its own to apply: every edit is written to the form root's draft as it is made, the way the inspector writes a property, so the canvas previews the header as it is typed.

    Apply and Discard at the panel's foot are the root's: the same draft the Form settings panel edits, so an edit made in either shows as not applied in both, and either's Apply lands both. The guards on that draft travel with it: the panel draws the prompt for changes not applied when the controller holds one naming the root and it is the panel on screen. The draft model is keyed to allow two editors of one root draft, and the shared Apply makes a "Not applied" mark in one panel for an edit made in the other honest rather than surprising.

    Row keys are the part's indices within its region, so a repaint after each keystroke brings the box being typed in, and its caret, back by that key; the section around a control names the region, which is how the header's first part is told from the footer's. The panel composes markup only when the drafted regions, the root's dirty state or a prompt naming the root has changed (decision 4).

8. **Parts is the one tab; the JSON sits behind a ⋯ menu.** The JSON view shows the root's `chrome` block as it will be saved (the frame included), read-only, through the same viewer as the inspector's JSON; the parts stay the only way to change it. Apply and Discard are at hand either way.

9. **The Form settings panel's rows point at the panel.** Its Header & footer section keeps the Frame picker (ADR 0068) and a summary row per region. The row's button opens the Header & footer panel on that region by a composed `builder-open-panel` event the shell routes (`{ panel: "chrome", region }`), which a host mounting the panel on its own can hear. The Frame picker stays in the Form settings panel: it is the form's look on the page, not a part of either region, and a plain select fits a property row.

10. **Another mode's tab has no such item.** The header and footer are the form's; a PDF layout's document has none. On a tab that is not the form's the strip hides the item, and a shell left on that panel moves to Form.

11. **Texts are translated in the Languages workspace.** A part's texts are edited in the default language here; their translations are entries under kind `chrome`, keyed by the part's `id` (ADR 0066, ADR 0158). The builder gives each part it creates an id (`part_1`, …) unique across both regions. Under a part's boxes a pointer line takes the author to its row in the Languages workspace.

### Variables

12. **A Variables item follows Outline on the activity strip.** It is remembered under `persist-panels` (ADR 0099) and offered in the Logic, Data, Journeys, PDF and Print workspaces, where an answer is referred to; the panel's body is a chunk loaded the first time it opens (ADR 0143).

13. **The panel is reference, not editing.** `<datum-builder-variables-panel>` lists what may be referenced: the fields that carry an answer (buttons, static HTML and images carry none, and a container is not an answer), one group per repeating section, and the fixed names the engine supplies. A click copies the reference to the clipboard, marks the row and says so in a live region; a page without a clipboard still gets the mark and the text. Every pick is a composed `builder-variable-pick` event (`{ reference, syntax, copied }`) a host may hear to insert the reference into an editor of its own. A filter box narrows the list by reference or label, hiding a group with nothing left. Nothing here writes to the form. The Rules tab's note names the panel, so an author writing a rule is pointed at the list.

14. **One panel, three syntaxes, chosen by the mode on the page.** The panel's `syntax` comes from the active mode's `BuilderMode.variables`; a mode that names none gets `rules` on the form (the primary mode) and `placeholders` on any other. A host listing for a mode of its own may set `syntax` outright, and that wins. `rules` writes fields by id, since a rule addresses a field by its id wherever it sits; `placeholders` writes them as value paths in braces, since the PDF's form scope is keyed the way the data is stored; `conditions` (the Journeys mode) writes fields by id with no scoped paths, since a journey condition reaches a section only as a whole. The lists, and how each workspace narrows them, are in [the builder guide](../reference/builder.md) (The strip and its panels, Variables panel). `buildVariablesModel(view, syntax, options)` composes the list from a `NestedTreeNodeView` and is exported, DOM-free, for hosts and tests. Data lists no functions, since nothing in Data takes a formula; Print lists no repeating section's rows or row aliases, since a margin box reads the form's own values (ADR 0174); Logic and PDF keep their syntax's list.

15. **The panel reads the form's controller on every tab.** The references are the form's fields whichever document is being edited, so the shell points the panel at the form's own controller once and never re-points it; on a PDF layout's tab the other panels follow the layout's controller while this one keeps listing the form. It hears every change of that controller, as every docked panel does (decision 4), and repaints only when the tree's shape, ids, labels, data keys or scoping changed, or the syntax or workspace did. The filter's text and focus survive a repaint. The selection is no concern of the list.

### The Settings panel

16. **The Settings panel holds what the author tries the form with, never the form itself.** A gear on the strip, in every workspace, opens it. All of it is the session's, kept on the controller, never in the definition:
    - **Language.** The language the canvas shows the form in: the same `<datum-locale-select>`, with the same `locale-change` event. A form in one language says so there.
    - **Submitting in Try it.** The stand-in for the page's server (ADR 0141).
    - **Data sources.** Every data source the form's choices name, the host's own ids and any simulated ones. `controller.setSimulatedDataSource(id, items)` lays the list over the host's set, and a simulated id wins. The layered set is kept while neither layer changes, so the canvas reloads only on a change. The inspector's Data source picker offers simulated ids too.

## Reasoning

- **A copy and an event, not an insertion at the caret of the inspector's box.** The inspector lives in another shadow root and repaints on every keystroke, so a reference the author pastes, and an event a host may act on, is the honest shape. A picker inside the inspector's own text boxes would be a decision of its own.
- **Header & footer edits the root's draft with no working copy.** A modal dialog with its own working copy shows nothing on the canvas until Apply; writing each edit to the root's draft lets the canvas preview the header as it is typed.

## Consequences

- Form-level settings are reachable in one click from a fixed place, on every tab, instead of by discovering that a click on nothing changes what the inspector is for. The panel's own head says what it edits.
- The header and footer are one click away on every form tab, edited beside the canvas that previews them.
- Every reference an author may write is one click away in the syntax that side reads, and the value-path rule for a field inside a data-scoping container is shown rather than discovered from an empty line in the PDF.
- The row scope on the Form side is listed because the evaluator reads it, though the browser runtime evaluates rules against form-scoped values; a rule inside a repeating section's entry is a runtime matter this panel does not settle.
