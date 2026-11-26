# ADR 0126: The Form workspace

## Status

Accepted.

## Context

The Form workspace is where the author builds the form on the real renderer's canvas (ADR 0028), with an inspector for the selected component (ADR 0111). Three problems shape it:

- On a canvas that works like the live form, a click on a field's own control types into it rather than selecting it, so the author would exercise rules and edit the form with the same click.
- Moving, copying and deleting a component would otherwise mean dragging or going to the inspector, and nothing would walk the components from the keyboard.
- A component on the canvas moves to another container, tab, step or (in the Journeys workspace) another page only by a mouse drag. The selection bar's Move up and Move down stay inside the component's own slot (`BuilderController.moveBy`), and Alt with an arrow does the same from the keyboard. A keyboard or screen-reader author therefore cannot put a question on another journey page, or a field into a group, at all; a mouse author has to drag across a long form, often to a step or tab that is not showing.

The controller already moves a component anywhere by a drop's rules (`move(componentId, { parentId, slotId, index })`, one undo entry, refused where a drop is refused). Moving by keyboard needs (1) a way to ask where a component may legally go, without trying each place, (2) a place in the canvas that offers those places, and (3) a keyboard gesture that walks them.

## Decision

### 1. Edit and preview

The canvas edits by default. A field is one click target: its controls take no pointer (`:host(:not([data-previewing]))` in the canvas chrome) and leave the Tab order (`data-db-inert`, kept across repaints by a mutation observer on the preview). Tab and step controls stay live, since they choose what the canvas shows. "Try it" on the canvas bar (`previewing` on `datum-builder-canvas`, `canvas-preview-change`) hands the form back: its controls work, its rules run through the preview runtime, nothing is selected, hidden components are not shown and the builder's chrome is put away. Values typed in preview never reach the definition. ADR 0141 holds Try it's panel and its answers.

### 2. Clicks

A click on a component selects it. A click that lands on no component, whether on the form's background or the canvas around the sheet, goes through `requestLeave`: that asks about the selection's and the root's unsaved edits, then clears the selection and closes the side panel (`canvas-background`).

### 3. One Tab stop, and keys

The canvas's scrolling page is a `role="group"` named "Form canvas" with its keys described, so Page Up, Page Down and Space scroll it.

- Up and Down walk the components in reading order, Right and Left go into a container and back out (swapped right-to-left), and Home and End go to either end.
- Alt with Up or Down moves the selection within its slot. Delete and Backspace ask before removing. Escape clears the selection. Enter opens the inspector at its first control.
- `M` starts moving the selection anywhere it may go (decision 12).
- `+`, `-` and `0` zoom (decision 5). Shift with an arrow key pans the form.

A live region says where the selection landed ("Street, text, 3 of 9"). Focus stays on the pane: the components live in the preview's shadow root, where `aria-activedescendant` cannot point.

### 4. The selection bar

One toolbar at the bottom centre of the part of the canvas the drawers leave showing, never attached to a field, so nothing is measured. It holds the selection's name, then Move up, Move down, Move to… (decision 11), Duplicate, Add logic and Delete. Buttons that cannot act are disabled, the bar is one Tab stop roved with the arrow keys (ADR 0179, section 1), and Delete uses the inspector's own prompt. Add logic opens the inspector on Logic. The bar is hidden in preview. On a narrow canvas the component's name gives way first, and below 360px it is dropped (the inspector still names the selection). On a phone the bar leads with Edit (ADR 0137).

### 5. The canvas bar: steps, widths, zoom, Try it

At the canvas's top end, clear of the document label:

- **Stepper.** "Step 2 of 4 · Business details" for the steps container around the selection or the form's first one.
- **Device widths.** Desktop, tablet and phone (1280, 768, 390). A second press lets go, and the sheet's grips still set any width.
- **Zoom.** − + Fit and the level, which goes back to 100%.
  - The keys + − and 0 work on the canvas page, and the API is `canvas.zoom` and `canvas.zoomTo(scale | "fit" | "fit-width")`.
  - Steps multiply by 1.25, between 25% and 200%. Fit shows the whole sheet in the page and never goes above 100%; it is the one measurement, made when asked.
  - The sheet scales by CSS `zoom`, so the page scrolls the scaled sheet, and clicks, drops and scrolling into view land where they are drawn; a sheet-edge drag divides the pointer's travel by the zoom.
  - The zoom is the canvas's for the session, never the definition's, and it hides while a mode's own surface fills the canvas (ADR 0141 says what a surface may ask for).
- **A mode's actions.** In a designer, the mode's worded tools sit before the widths and zoom and its primary action (Preview PDF) just before Try it (ADR 0141).
- **Try it.** Hands the form back (decision 1).

The bar is one Tab stop, the arrow keys moving between its tools (ADR 0179, section 1). Below 520px of canvas bar, the width and zoom buttons (and a mode's worded tools) fold behind one "Width and zoom" button ("More PDF tools" while a mode's tool is in it) and open as a card under the bar, focus on its first tool; a click elsewhere, a tool from a mode run from it, or Escape puts them away. The canvas page leaves room for both bars.

**Moving the form.** The form moves on the canvas by a drag on empty canvas, a middle-button drag anywhere, or Shift with an arrow key, so it can sit beside an open panel on a laptop. The offset is a translate on the sheet, divided by the zoom so it is in screen pixels, and kept apart from the page's scroll, so centring and zoom are unaffected by it. Some of the sheet always stays in view. Fit centres it again, as does another mode's tree. The click a pan ends on is not a canvas click, so it keeps the selection. `pan` and `panTo(x, y)` are on the canvas element.

### 6. The controller's structural operations

In `builder-controller.ts`: `parentOf`, `move`, `moveBy`, `moveTo`, `duplicate` and `addAfter`, each one undo entry, with guarded `requestMove`, `requestMoveBy`, `requestMoveTo`, `requestDuplicate` and `requestAddAfter`. A duplicate takes numbered ids, drops data keys that would clash in the same data scope, and re-points its own rules at the copy. `applyDrop` converts a same-slot index the way `move` does. Decision 10 covers `moveTo`.

Where a drag over the canvas lands is ADR 0028's (decision 9).

### 7. The component rail and the palette's click

Above the strip in the Form workspace, on the form only: up to nine common types the form offers (`RAIL_ORDER`), then All components, which toggles the palette. A click on either adds after the selection in its slot when that slot takes the type, else at the end. A rail type also drags, starting the same copy drag the palette's rows do, so it can be dropped on any drop zone. All components is a button, never a drag.

The shell also settles the Components palette itself (`settlePalette`), in the Form workspace on the form only: open for a form with nothing to add to yet (no component, or only the untouched Submit button New seeds), shut for one with components. It runs as the shell comes up and whenever a form is put in place (New, Open, a host's definition).

It never overrides a choice: once the author opens or switches a panel, or a host names `panel`, the palette's state is theirs. A click on the canvas puts away a palette the shell opened; one the author opened stays. A phone or narrow shell keeps its drawers put away, and nothing here is written to `persist-panels`.

### 8. One legality rule, shared with the drop

A pure function in `builder/drag-drop/move-legality.ts`, `moveRefusal(root, componentId, parentId, slotId, resolver)`, says why a component may not move into a slot, or nothing when it may:

- The form's root never moves.
- A component never goes into itself or anything inside it.
- The slot must take it by the parent type's declared slots (`canAcceptInSlot`: the slot's allowed types, its `multiple` and `max`, counting the component only when it arrives from elsewhere).

These are exactly the checks a drop meets (`MoveComponentCommand` and the tree's cycle guard). The controller adds its own two, as `move` already does: a `fixed` node never moves, and a move that would give two components one place in the data (ADR 0109) is refused. The mouse drag itself is unchanged.

### 9. The place a component may go is listed, not tried

`moveTargets(componentId): BuilderMoveTarget[]` lists every slot the component may move to, in the canvas's reading order (the form's root first, then each container depth first), its own slot included. Each target names its parent (`parentId`, and `pageId` when the parent is a journey page, ADR 0115), its `slotId`, a `label` (the outline's name for the parent; a journey page as the outline names it, "Step 2 · Title"), a `slotLabel` when the parent has more than one slot that takes the component (a tab, a grid column), `depth`, the components already there with the moving one left out (`siblings`), and `current`, the position it holds when this is its own slot. It is empty for the root, a fixed node or an id not in the tree.

### 10. `moveTo` and `requestMoveTo`

`moveTo(componentId, container, index, slotId?)` moves the component into `container`, which is a component id, or a journey page's `pageId` when no component has that id (the page's node id stays internal, ADR 0115), at `index`, the position it ends at among that slot's other components (0 first, `siblings.length` last). Without `slotId`, the container's first slot that legally takes it. It is one undo entry; the component keeps its id, its configuration, its rules and its data bindings, and stays selected: only its parent and place change. It returns `false`, changing nothing, when refused or when it is already there. `requestMoveTo(...)` is the same through the unsaved-edits guard, as `requestMoveBy` is.

### 11. "Move to..." in the selection bar

A button after Move down opens a dialog over the canvas with two native selects: "Move to" (every target, indented by depth, its own slot marked as where it is now) and "Position" (First, After each component already there, Last). It opens on the component's own place, and Move is enabled once the choice differs. Move runs `requestMoveTo`, closes the dialog, returns focus to the canvas and announces the result in the canvas's polite live region. Cancel or Escape closes it with nothing moved.

The button is disabled for a fixed node. Where a component may go is worked out only when asked (never on every repaint of the bar), so a component with nowhere else to go (alone in the only slot that takes it) opens the dialog with a line saying so and Move off. Choosing the place it already holds moves nothing and says so.

### 12. Keyboard move mode

On the canvas, with a component selected, `M` starts moving it: the insertion marker a drag draws appears at its place, the component is drawn as a drag source, and the live region says what is happening and how to finish. The arrow keys walk every legal position across every target in reading order (Down and Right forward, Up and Left back; Home and End to the first and last), crossing page, step, tab and container boundaries; each step announces the place and position ("Page 2, position 3 of 5") and opens the tab or step it lands in.

Enter moves the component there as one undo step and announces where; Escape cancels with nothing changed, and so does Tab, which then moves focus as usual. While the mode is on, the canvas's other keys (Delete, Alt with an arrow, undo) do nothing. Any repaint of the canvas (an edit, an undo, a click that selects, Try it) ends the mode, nothing moved, and says so. A component with nowhere else to go says so instead of starting.

### 13. Up and down stay inside the slot

Move up, Move down and Alt with an arrow stay inside the component's slot. Crossing boundaries is Move to... and the move mode.

### 14. Journeys

In the Journeys workspace the same controls work on the journey's tree: a question (or a layout of the journey's own) moves between pages' `content` slots, a route between pages' `routes` slots, a page within the journey's `pages`. Node ids are not touched, so a route's `to` and every page id still name the same nodes; only the parent changes.

### 15. A lazy chunk, and the words

The dialog and the keyboard mode are `builder/drag-drop/move-ui.ts`, loaded on the first Move to... or `M` through a retrying memo (as Try it's chunk is, ADR 0141), so the builder's entry carries only the button, the keys that ask for the chunk and the controller API. A load that fails is forgotten and the next press asks again.

The dialog's and the mode's English is an area table in the chunk (`drag-drop/move-texts-en.ts`, `MOVE_EN`); the button's two texts (`canvas.action.move`, `canvas.action.moveTip`) are in the builder's eager text catalog. All are read by key through the builder's text catalog, so a host translates them.

## Reasoning

- **A click selects.** Making a field's controls inert in edit mode and handing them back in Try it separates the two things an author does with a form, instead of overloading one click.
- **One fixed selection bar.** A toolbar attached to the selected node has to be measured against the node and the drawers around it; a fixed bar at the bottom centre needs no measurement.
- **Move by the drop's rules, from a list.** Up and down crossing boundaries, and drag only, were the alternatives not taken: asking the controller where a component may legally go gives the dialog and the key mode one source, and the same refusals a drop meets.

## Consequences

- A host page tries its rules in Try it (ADR 0141), since the edit canvas takes a field's click as a selection.
- Hosts that copy the builder's bundle copy its chunks too (the PDF, journeys, JSON, Try it, move, Logic, Data, Languages and overview chunks); without the JSON chunk the JSON shows as plain text.
- The keyboard walk has the rail's stop before the strip.
- An author with no mouse can restructure a form and a journey; a mouse author can move a component to a step or tab that is not showing without dragging to it.
- One undo step per confirmed move; nothing is written while the move mode walks.
- `runAction` (the command palette's entry to the selection bar) accepts `"move"`, which opens the dialog.
- The selection bar has six buttons.
