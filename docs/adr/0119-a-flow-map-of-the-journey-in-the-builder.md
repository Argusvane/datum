# ADR 0119: The journey map: a flow map that edits the journey, and Try it draws the same map

## Status

Accepted.

## Context

The Journeys mode (ADR 0115) edits a journey one step at a time in the Step view (ADR 0171), and Try it
(ADR 0141) runs it. Neither shows the journey as a picture of its branches.

A picture is possible because of what a journey is (ADR 0112). It is a graph in list order:
every route goes forward, the first that matches wins, and a step with no match falls through to the
next. A step has no condition and none is passed over, so every step the walk reaches is shown. An exit
step stops the journey, and a Check answers step ends it with a submit (ADR 0172).

A journey is edited as steps and Go to rules, and the map is the one place the whole of it is visible, so it
is where an author adds a step, orders steps and adds a rule. A person trying the journey also needs to see
where they are on that graph, and which way they took.

The author-facing description of the map, its keys, zoom and accessibility, is in
[docs/reference/journeys.md](../reference/journeys.md#the-map-in-detail). This ADR holds the drawing, the
surface, editing on the map, the map in Try it, and their reasons.

## Decision

### What the author sees

1. **The Map is a view of the Journeys workspace: Map | Step.** `JourneyModeView` is `"map" | "step"`
   (ADR 0171); the Map is the default and always offered. The map is a surface the mode puts in the
   canvas's place through `showCanvasSurface` (ADR 0141), so the inspector, the outline and the palette
   go on working beside it. Selection is the journey controller's, so it carries across the two views.
2. **A click selects, and the map edits.** A click on a step, a route's label or a line selects the
   designer node it stands for, through `controller.requestSelect`, so the unsaved-edits prompt still
   applies; Enter or Space does the same from the keyboard. Adding, moving, copying and deleting steps and
   adding a rule are on the map's bar and selection bar (decision 12).
3. **One source of graph facts.** `journeyFlow(journey)` (`core/journey/journey-flow.ts`, engine-root
   API) is built on `diagnoseJourney`'s own walk graph and search (`journeyWalkGraph`,
   `exploreJourneyWalks`), each step's ways out by its position as the path engine takes them. So a step
   the map draws as unreachable is `page.unreachable`, and a map whose End reads "No path submits" is
   `journey.no-end`, steps sharing an id included. It adds what the diagnostics do not compute: which ways
   are live, the "otherwise" of a fall-through, and the ignored routes with their reasons. It takes no
   form: the facts do not depend on what the answers show.
4. **Every way out leaves its step.** There are no decision shapes. A step is one card, and each route is a
   line from it, in written order, labelled with its condition in words. A step with nothing on it is a card
   like the others, noted "No fields yet", and a step whose fields may all be hidden has its line on too: no
   way passes a step over. Ending steps are dashed.
   - **Ids.** Each way has a stable id built from the step it leaves and how: `start`,
     `route:<step>:<index>` with the route's written position, and `next:<step>`, `<step>` being the
     designer's node id for the step (`journeyMapEdgeId`). A test renames a title and a condition and
     gets the same ids. Try it uses them to mark the ways taken.
   - **Why.** A decision shape would draw one decision as two. A line per way out, labelled where it
     leaves, reads as the Logic list does.
5. **One layout control.** Direction: Top down or Left to right. One in-house, deterministic layered
   layout serves both (`journey-map-layout.ts`), and its lines cross no box and no label.
6. **The words are the designer's.** The designer lends the map its words (`JourneyMapWords`):
   `conditionTermsInWords` (a condition as terms, so a label too narrow for it shortens a question's
   label, never the test, and always says which answer takes the way), `pageName`, `findingsSummary`,
   `field`, `isValueless` and `listed` (the Check answers count). The map's chunk never imports the
   designer's inspector words.
7. **A step's findings are placed by its position.** `JourneyDiagnostic.pageIndex` (0-based) is set by
   `diagnoseJourney` on every finding about a step or a route, and `placeJourneyFindings` places by it
   (trusted only when the page there has the finding's page id), so a step repeating an id carries its
   own findings. A finding with no position is placed by the step id.
8. **A journey's own nodes are counted and said on the card** (ADR 0121). A card names what it fills
   and works out from the shared ownership (`journeyOwnership`, kept on the check as
   `JourneyCheck.ownership`): "Fills" names only `aliasOf`, "Works out" only `workedOutOf`, so the card
   never says what the runtime ignores. With no ownership (the steps alone, while the tree cannot be
   written) every entry counts and nothing is named, since nothing can be vouched for. They are rows in
   the card's notes, not chips: a chip needs its own drawing, styles and room in the card's layout, and
   the notes rows already exist and are drawn and measured as the other notes are.

### The surface

9. **Its own lazy chunk.** `builder/journey-map/journey-map.ts` is the entry of
   `datum-builder-journey-map-*.js`, which the designer's chunk loads the first time the map is
   shown (`loadJourneyMap`, a retrying memo: a failed load is tried again, never remembered).
   The Try card loads the same chunk. While it loads the canvas shows "Drawing the map…" and the views group is `aria-busy`. A
   failed load is reported ("The journey map could not be loaded") and the view goes to
   the Step view. A map arriving after the mode is disposed is disposed at once. `check-bundles` holds the
   sentinel `datum-journey-map` out of `datum-form.js` and its chunks, out of `datum-builder.js`
   and out of the designer's chunk, in exactly one `datum-builder-*` chunk and inline in the
   classic script; the journey diagnostics stay in one shared chunk.
10. **Built once, view state laid on after.** The SVG is a pure string (`journeyMapSvg`) that carries no
    view state, written only when it differs from what is shown. Selection, the highlight, the roving tab
    stop and the zoomed size are laid on after each write, so a selection, a hover or a keystroke that moves
    nothing draws nothing. `show` is idempotent, and its size observer runs only while the map is shown,
    on the scroller's border box, so a fit that brings a scrollbar on cannot refit in a loop. Every entry
    point reports through `onError` rather than throwing into the controller, whose listeners have no guard
    (the map hears the selection before the shell's panels do). The surface's head and foot read the shell's
    `--db-side-w` (as `--jm-cover`), so the builder's side drawer (ADR 0099) never hides them.

### The viewer's layout

11. **Remembered per viewer, never in the definition.** `journeyMode.mapLayout` is
    `{ direction: "down" | "right" }`; assigning it draws a map on the page again. Where the host remembers
    panels (`persist-panels`, ADR 0099), it is kept under `datum-builder:journey-map:<key>` in the same
    store, read strictly (anything else is none), and written under the key the host gives at the time. The
    zoom and the view are not remembered. The static `journey-map-preferences.ts` reads it before the chunk
    loads.

### Editing on the map and Try it

12. **Editing on the map.** The map bar has Add step (after the selected step, else at the end) and
    New rule (from the selected step to the next one, off on the last step). A selected step has a
    selection bar: Open, Move up, Move down, Duplicate, Delete (off on the only step, since a journey
    keeps at least one). Each is the controller's own guarded request, so it is one undo entry and the
    unsaved-edits prompt applies. Enter on a step, a double click and Shift+Enter, or Open, show the Step
    view on that step, and a click on a rule's label opens it in the Logic editor (ADR 0127), which edits the route (ADR 0112
    decision 16). The editor also opens from New rule on the map bar, the step inspector's Logic tab and the
    Logic workspace's list; the map reaches it through the `LogicJourneyHost` the mode registers, and a request
    made before the Logic surface exists is held for ten seconds.

13. **A state input and a read-only mount.** `setState({ currentNodeId, takenEdges })` marks the current
    step and the ways taken, by class only, never rewriting the SVG. `readOnly` removes selection and editing
    and keeps zoom, the walk keys and hover. The map's room is measured from a scroller the host names, its
    styles can be adopted into any root (`journeyMapStylesInto`), and it holds no module state, so two maps
    can be on one page.

14. **Try it shows the map.** The Journey card of the Try panel holds a kept, live, read-only map
    instance between its head and the path line. The runtime's last trace
    (`FormRuntime.journeyTrace()`) gives the ways taken (`journey-try-map.ts`): only the ways behind the
    current step are marked, so what lies ahead is not marked and Back unmarks what it leaves. A step reached
    by a Change link says so and where Continue returns. The path line and Restart stay; "Open this step"
    ends Try it and opens the Step view on the step the person was on.

15. **The Try panel keeps the node.** The panel rewrites its HTML on every render and keeps only nodes a
    mode names (`BuilderModeTryIt.kept`, `drawn`). A kept node is moved from the old markup to the new
    inside one task, with its scroll and focus put back, so typing an answer does not rebuild the map.

## Reasoning

- **A layout library** (dagre, elkjs, d3-dag, cytoscape, mermaid) is rejected: each is larger
  than the whole map or wrongly licensed, and none keeps the author's list order readable.
- **The map in the designer's chunk** is rejected: the map is the larger part of the two, and
  only authors who ask for it should load it.
- **A split view of the map beside the step** is rejected: the Step view needs the sheet's width,
  and a split is not practical in the shell. The map is the default and the step is one press away.
- **The layout in the definition** is rejected: it is how one viewer likes to look at a journey,
  not part of the journey.
- **SVG `<marker>` arrowheads** are rejected: they need ids, which two maps on one page would
  share.
- **The map edits what it draws.** An author who sees a missing step adds it where it is missing,
  and moves a step where the order is wrong, in one undo entry each, without opening a step first.
- **The actual map in Try it.** A second drawing of the path would drift from the map. One component
  with a state input shows the way taken in the picture the author already knows.
- **Each name is said once.** An item's tooltip sits in an `aria-hidden` group inside it, since a
  `<title>` of the item's own would become its accessible description and be read twice; every step, way
  out and stub carries its full sentence, so no hidden second list of the map is kept. Inside SVG nothing
  is forced in forced colours, so the aliases every rule reads become system colours. A palette drag over
  the map stops at it, so it never aims at the sheet the map hides.
- **Focus is not selection.** The map's keys walk the items without selecting, so arrowing never raises the
  unsaved-edits prompt; and colours come only through `--db-*` tokens, so every builder theme restyles the
  map with no token of its own.

## Consequences

- **Hosts need nothing.** `journeyMode.view` is `"map"` or `"step"`, and `journeyMode.mapLayout`
  holds the viewer's layout; `<datum-form-builder>` exports the `JourneyMapLayout` type.
- The map chunk's budget is held by `check-bundles`.
- **Engine-root API:** `journeyFlow` and its types; `journeyWalkGraph`, `exploreJourneyWalks`;
  `JourneyDiagnostic.pageIndex`.
- The builder themes' token lists (`studio-tokens.ts`) read the map's styles.
