# ADR 0171: The Step view draws one step on the form's own canvas

## Status

Accepted.

## Context

A journey is edited as steps (ADR 0112). An author fills a step with the form's fields and with
fields only the journey asks, orders them, and wants to see the step as a person will: its heading,
its counter, its fields, its Back and Continue. The form canvas already draws a form with edit chrome
(selection, drops, a bar), but it draws one tree through one controller. A step is two things: form
fields, which belong to the form and are edited with the form's inspector, and the step's own nodes
(its heading, its buttons, journey-only fields, the order of its members), which belong to the
journey's controller under different node ids.

## Decision

1. **Two views on the Journeys bar: Map | Step.** `JourneyModeView` is `"map" | "step"`. The Map is
   the default and always offered (ADR 0119); a journey with one step opens on its Step view. Step
   draws the form canvas's sheet showing one step as the renderer draws it, with the edit chrome on.
   The canvas bar carries a stepper "‹ Step 2 of 4 · name ›", zoom, Fit and Try it. There
   is no Edit | Preview switch: a journey is run in Try it (ADR 0141), not on the sheet. An unknown
   value assigned to `view` reads as `"map"`.

2. **The canvas draws a root built for the step.** The journey's controller is given a canvas root
   made like the renderer's own journey root (`journeyRenderRoot`): the step's members, plus the slot
   its own fields go into. `BuilderPreviewRuntime.setFormRoot(root, { journeyView })` takes the
   journey's view beside the tree, so the real renderer draws the step's heading, counter and actions
   from that view, with the form's binding. Controller hooks give the canvas that root, its tree view,
   tags, region owner and selection targets (`canvasView`, `canvasJourneyView`, `canvasTags`,
   `canvasRegionOwner`, `canvasSelectTarget`), so the Form workspace, which sets none, is drawn as
   before. The adapter lives in `journey-designer/step-canvas-adapter.ts`, `step-view.ts`; it
   belongs to the designer chunk.

3. **Selection routes to the controller that owns the node.**
   - A form field on the step selects on the form's controller and shows the form's inspector, with
     "Take it off this step" in place of Delete (`BuilderMode.inspection`, `inspectorActions`).
   - The step, its buttons, its heading, a journey-only field and a worked-out value select on the
     journey's controller.
   - A field inside a placed container selects the whole placed group: highlight, inspector and bar
     act on the group, and the inner field is edited in the Form workspace.
   - A press on the step's Back or Continue opens the step's Wording section; a press on its heading
     or counter selects the step.

4. **One history over both controllers.** While the Step view is up, Undo and Redo step one ordered
   history (`step-history.ts`) over the form's controller and the journey's, so an edit made to a
   field and a move of the field between steps undo in the order they were made. A step made in one
   turn is one entry. An entry is live only while each controller's last mark is still its own; a stale
   entry is dropped and never undone blind. Outside the Step view each controller keeps its own history.
   A rename of a field made from the Step view undoes together with the journey's follow-up of it.

5. **Two ways to fill a step.**
   - **The components palette** adds journey-only fields (never data, tagged "Not sent"): in the Step
     view it offers the form's own types as such, and the worked-out value, and hides a type the
     engine forbids as journey-only (ADR 0121). A click with nothing selected adds to the step shown.
   - **The Form fields panel** on the
     activity strip (Journeys workspace, Step view only) lists the form's fields as "Not on a step" then
     "On a step" with the step's name, and a click or a drag places one on the step before its closing
     buttons, as one entry of the history. A field already on the shown step is listed as "On this step"
     and offered no more. The panel refuses an ending and a Check answers step, which ask nothing, and
     says why; palette content still works there. Its list is painted once and repainted only when a
     row, the filter or a word changes, so typing on the step repaints nothing in it.

6. **Findings are where the author looks.** The Journey panel opens with a findings card: errors, then
   warnings, each with the fix the diagnostic has ("Ask it here", "Make it optional on the form",
   "Remove"), and pressing a finding selects its node and brings the Step view to that step. A finding
   is shown once: the card lists it, and the map, the step and the inspector box it concerns carry the
   same object. Diagnostic wording is rewritten to say Step, the step's name and the field's label
   (`journey-finding-words.ts`); core messages, codes and params are untouched, since hosts and the
   parity tests read them. "The form opens as" is a row of the Journey panel (ADR 0115).

7. **The step's own inspector is Step | Logic.** Step holds Kind, Validation and Wording. Logic lists
   the step's Go to rules in the order they are tried, each opening in the Logic editor, with "New
   rule" (ADR 0127).

8. **The sheet keeps clear of the drawers.** The Step view holds content that must not sit under a
   drawer: the Form fields panel is 300px wide (`PANEL_DRAWER_WIDTHS`), and the Check answers list
   fills the column with its Change links at the sheet's right edge. There the canvas keeps clear of
   the open side drawer and of the inspector by each one's reach plus a gap, worked out on the body
   (`--shell-step-start`, `--shell-step-end`). The canvas then reads no drawer (`--db-side-w` and
   `--db-props-w` are `0px` inside it, where ADR 0099 decision 12 has them mean how far a drawer
   reaches over the canvas), so its bar and crumb keep their places, clear of the drawer by the
   gap. The sheet centres in the room left and narrows to fit. The map, the empty state, Try it, the
   narrow layout and the phone keep the rule of ADR 0099 decision 12, where the sheet reads
   `--db-side-w` too (the sheet's own room rule is ADR 0099 decision 14).

## Reasoning

- **The form canvas rather than a second one.** Selection, drops, the zoom, the bar, the chrome and
  the binding are the form canvas's; a second canvas for steps would drift from it. The seams are
  optional hooks that a tree without them ignores.
- **Route by node, not by controller.** A form field's properties are the form's, and a step's membership
  is the journey's; routing selection means each is edited where it lives, and the history ties the two
  so an author sees one Undo.
- **No Preview inside the Step view.** The sheet is where a step is edited. Running it needs answers,
  a path and a server-free session, which Try it already is.

## Consequences

- The designer's node types are definitions with inspectors but are not drawn as cards.
- A host that supplies its own binding sees the step in that binding, with the same chrome.
- The designer chunk's size is held by `check-bundles`; the Step view and the Form fields panel are in
  the Journeys mode's own chunks, not in `datum-builder.js` beyond the seams.
