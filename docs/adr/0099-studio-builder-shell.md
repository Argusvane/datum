# ADR 0099: The Studio builder shell: one bar, the strip, drawers over the canvas, remembered panels

## Status

Accepted.

## Context

The builder's shell is a frame around independent panels. The panels themselves (`<datum-builder-toolbar>`, `<datum-builder-canvas>`, `<datum-builder-properties>`, the outline and the lazy surfaces) take a controller, so a different arrangement is a different shell around the same panels, not a rewrite of them.

What the shell has to keep:

- The canvas is the real renderer, and the sheet is authored at the width it is filled in at (ADR 0028).
- Edits are drafts landed by Apply (ADR 0111, decision 16).
- Modes are a host-registered facility (ADR 0045): the form, the PDF side, the journeys side, a host's own.
- Hosts slot their own controls onto the bar and the strip.
- The shell is themed through `--db-*` tokens with exact coverage (ADR 0124).

A shell fails on two counts: when every feature needs its own bar button or dialog, and when floating chrome has to be kept clear of other chrome by geometry rewritten from script on scroll and resize. This shell has one bar, one strip, a canvas with two drawers over it, and no measured geometry.

A shell that lays the strip, the side column, the canvas and the inspector side by side makes every panel narrow the canvas: opening or widening a panel squeezes the form and reflows every field, so an author comparing a panel with the form watches the form move. The shell also has to work where there is no room for columns at all: under about 900px a 240px column and a 300px inspector leave only a sliver of canvas.

The shell has state an author sets and expects to keep: which strip panel is open, how wide the side column and the inspector are, whether the inspector is folded, and which workspace the author was in. The shell is an element a host page embeds, sometimes twice, so remembering must be opt-in and keyed, and must survive a page whose storage is blocked. The shell's tests run in jsdom, which lays nothing out, so anything width-driven has to be driven by something a test can set (decision 11).

## Decision

### 1. One bar

The shell has one bar, in flow at the top of a flex column. It holds, in order:

- the leading group: the host's `toolbar-start` slot, undo and redo, and the command palette button;
- the workspace tabs (ADR 0125);
- at the centre, the label of the document on the page (decision 2);
- the trailing group: the active mode's views switch (ADR 0141; its worded actions are in the canvas's toolbar), the full-window button, the host's `canvas-actions` and `toolbar` slots, the save cue (below), the host's `history`, `comments`, `publish` and `account` slots (each drawn only when filled), and the menu.

The bar owns the controls it shows: it subscribes to the active controller and calls the controller's methods (`undo`, `redo`). Cmd/Ctrl+Z is also bound on the canvas and the outline. A button or select a host slots onto the bar, or a launcher onto the strip, is drawn in the builder's look from its `--db-*` tokens, and any class of the host's still wins (ADR 0118, decision 3). The menu is the last control on the bar; its items and Save are ADR 0118's, and the Dark mode item is ADR 0157's.

**Full window.** The bar's button sets `full-window`, and the builder is then fixed over the whole browser window with the page's scroll held until it leaves. `builder-full-window-change` (`datum-builder-full-window-change` on the wrapper) reports a change. Escape does not leave full window, because Escape is the canvas's "clear the selection" and one key must not do both.

**The save cue** shows only while the host reports the form unsaved (`saveState`). It is a pill with a dot and its words, "Changes not saved", in the warning ink: a state must be a word and a mark, not a hue alone. A phone's menu drawer carries the same words in its state line.

Dialogs, confirmations, the roving toolbars and the leave guard are the shell's shared interaction patterns, in ADR 0179.

### 2. The bar names the document

At the bar's centre (`[data-bar-centre]`) one label (`[data-document-face]`) names the document on the page: its name (the form's title, drafted, or the layout's or journey's label, with the full name as its tooltip), its kind (Form, PDF layout, Journey; absent while a mode has no document yet), and its Default and badge words, as pills. While a switch is under way the face is `aria-busy`. A document with options of its own makes the label the button for its menu. Duplicate and Delete go through the unsaved-edits guard, and Delete is asked twice. Documents are switched on the Journeys and PDF overviews (ADR 0125), through the command palette, and through `selectDocument` and `setMode()`; they are added through an overview's New, the palette, and `newDocument`.

Where the add popover opens depends on what is on the page: when the mode's designer is already there, it is anchored on the document label; otherwise the shell enters the overview and the flow runs with no anchor, so the popover is centred near the builder's top. An overview's own New anchors on its button (ADR 0125 decision 6).

`hiddenModeIds` leaves a mode's documents out, which is how `workspaces="pdf"` hides the form; `showModeSwitch` hides the label outright.

A mode's fixed-position popover is placed by `builder/popover-place.ts`: it is placed at 0, read back and moved by the difference, so a transformed or containing ancestor on the host page does not throw it off. It is held within the builder's box, and without a drawn anchor it is centred near the builder's top.

### 3. An activity strip opening one panel

A narrow vertical icon strip (`role="tablist"`) at the start edge opens one panel beside the canvas at a time. The shell's own nine panels are in `SHELL_PANELS`, with the ids listed in [the builder guide](../reference/builder.md) (The strip and its panels): Form settings and Header & footer (ADR 0103), Components, Form fields (`<datum-builder-form-fields>`, a journey step's fields, offered in the Journeys workspace while the Step view is up), Outline, Variables (ADR 0103), Tests (ADR 0154), View and Settings (ADR 0103). The Outline is `<datum-builder-outline>`, navigation only, drawn from `treeTabHtml` over the controller; since a docked panel hears every draft keystroke (ADR 0103, decision 4), it repaints only when the tree's shape, labels, hidden set or selection changed.

Which workspace offers which panel is ADR 0125's. Clicking the open panel's item closes the side column. A host's own strip items go in the `strip` slot, and its panels in the `panel` slot, named by the `data-panel` the item carries (ADR 0103, decision 5); every future feature is one more strip item, not another bar button or dialog.

### 4. Layout

The wrap is a flex column: the bar, then the body. `layout="page"` (the default) pins the whole shell to the window below `--db-shell-top`; `layout="contained"` fills the element's box. The two differ by one rule each.

The body is a row. The strip (with the component rail above it in the Form workspace) is a floating card of icons at the start edge. The canvas takes the whole width beside the strip. The side column and the inspector are not columns of the row: each is absolutely placed over the canvas as a drawer at every width (decisions 7 and 8), resized by width only (`--db-side-w`, `--db-props-w`, rewritten by two grips; decision 9), and the inspector folds to a stub.

A set sheet width (a device width, a dragged or fixed width) keeps its size and the page scrolls sideways to the rest; the default sheet narrows only to the room decision 14 leaves beside a drawer. The look is a floating one (ADR 0124) drawn on these mechanics: every inset is a constant, and nothing is measured from script.

### 5. Modes and documents

`BuilderMode` carries an optional `documents: BuilderDocuments`: a list, a selection, a subscription, and optionally the verbs a mode supports (add, rename, duplicate, remove, set default, move). A mode without documents has one.

A switch goes through the active controller's unsaved-edits guard, then `setMode()` and `documents.select()`; the shell reads `mode.controller` again afterwards (it may be a getter) and re-points the panels and the bar when the instance changed. `builder-document-change` reports a move.

A mode's `barActions` are the controls the shell draws for it: a views switch on the bar, its actions in the canvas's toolbar (ADR 0141). `showCanvasSurface(surface, options)` puts an element on the canvas in the sheet's place, the panels staying; what the canvas bar may do over it is ADR 0141's.

The PDF mode keeps one controller per layout (ADR 0044) and a populated-form layout is edited as a tree (ADR 0057); the shell treats both as any other mode.

### 6. Hosts

A host wires its catalog through `translationsSource` (read by the Languages workspace, ADR 0125). `<datum-form-builder>` forwards `hiddenModeIds`, adding the form to it under a designer alone (`workspaces="pdf"`, ADR 0125).

### 7. The side column is a drawer over the canvas, always

It is absolutely placed inside the body beside the strip, at its width (`--db-side-w`, 240px by default) capped so that a 48px sliver of canvas always shows. It draws no frame of its own: every shell panel in it is floating (`data-floating`), its parts separate cards on the backdrop, so the drawer is only their place and the canvas takes the pointer between them; a host's slotted panel that is floating is drawn the same way (`data-host-floating`). It sits under the bar's own popovers.

The canvas takes the whole width beside the strip, and the sheet on it keeps clear of the open drawer while there is room (decision 14). A panel may open the drawer wider than the default by id (`PANEL_DRAWER_WIDTHS` in `panel-memory.ts`: the Tests panel's rows are sentences, and the Form fields panel lists labels with a step's name beside each); the shell sets `data-open-panel` on the wrap for it. A width the author has dragged still wins, for every panel alike.

### 8. The inspector is a drawer on the right, the same way

It sits at the body's right edge at its width (`--db-props-w`, 300px by default), capped the same way, and comes and goes with the selection as ADR 0111 has it. It has no collapse control of its own. Folded (`collapsed`, `data-props-collapsed`), it is its stub, a one-button rail over the canvas's edge with none of the drawer's dressing, and the stub's button unfolds it. The shell folds it to put one drawer up at a time (decision 11), and a host may fold it. While the canvas is tried, the inspector's drawer steps aside (`data-trying`).

### 9. The grips ride the drawers' edges

Each resizer sits at its drawer's inner edge and moves with the width as it is dragged. The widths are remembered under `persist-panels` (decision 15), and the grips are hidden in the narrow layout.

### 10. The canvas is a stacking context of its own

The canvas is `isolation: isolate`. Its sheet grips, outlines and badges carry z-indexes of their own, and without the isolation the sheet's edge grip sat above the drawer's grip wherever the two met. The drawers and their grips sit above the canvas whole, and under the bar's own popovers.

### 11. How many drawers are up depends on the shell's width

The shell watches its wrap's own width (a `ResizeObserver`, and the window's `resize` event, which is what jsdom tests drive after stubbing the wrap's rect). A wrap with no width yet (a detached element, jsdom) is none of the tiers below. The same observer sets `data-phone`, which is ADR 0137's.

- **Wide (1280px and up):** both drawers can be open together. They may meet in the middle of a small window; the inspector, later in the markup, is the one on top.
- **Medium (900px to under 1280px):** one drawer sits beside the canvas. A strip panel opening folds the inspector, and it returns when that panel closes; the inspector opening from its stub puts the side column away, and a selection that brings the inspector up sends the panel away (except in Logic, Data and Languages, where the surface is not the canvas). This yielding lasts the session and is not remembered. In Logic, Data and Languages, which draw their own surface in the canvas's place, the surface keeps clear of the open drawer by its width, so no heading or row sits under it.
- **Narrow (under 900px):** `data-narrow` is set on the wrap and `narrowLayout` (read-only) says so. One drawer is up at a time, as in Medium; the grips go; the bar's grid lets the side controls wrap and holds the document's name to the room left. Going narrow keeps the panels as they stood and puts both drawers away for the canvas; widening puts them back as they were. The drawer state is never written under `persist-panels` (decision 20). The bar's rule keys on `data-narrow`, not on a window media query, so a contained builder in a narrow box behaves as a narrow window does.
- **Phone (under 768px):** every drawer is a bottom sheet (ADR 0137).

### 12. Inside the canvas, the width tokens mean how far a drawer reaches over it

The shell sets `--db-side-w` to `0px` on `datum-builder-canvas` while the side column is folded, and `--db-props-w` to `0px` while the inspector is folded or has nothing to show (52px for its stub). The controls pinned to the canvas's start or end edge read them, so a drawer never hides them: the canvas bar, the selection bar, the journey map's head and foot (ADR 0119). The sheet reads `--db-side-w` too (decision 14); a mode's own surface (the journey map, a template's pages) does not move. ADR 0171 holds how the Journeys workspace's Step view keeps its sheet clear of the drawers.

### 13. The names stay small

`panel` and `builder-panel-change` report the drawer's panel, also while narrow. `data-side-collapsed`, `data-props-collapsed`, `data-no-selection` and `data-drawer-open` mark the wrap. No `--db-*` token is added beyond the two width tokens and the strip width: the drawers draw with the surface, divider and shadow tokens the shell has.

### 14. The sheet makes room for the open side drawer and the inspector when the canvas has it

The canvas page's start padding (`.canvas-page:not([data-surface])` in `builder-shared.ts`) is worked out in CSS from `--db-side-w`, at whatever width the drawer opened or was dragged to, and from `--page-sheet`, the sheet as drawn, which the canvas writes on the page wherever it sets the sheet's width and its zoom: a device, dragged or fixed width (a fixed sheet with its padding and border) or the default `--db-sheet-w`, times the zoom. The sheet's start edge must sit a gap past the drawer's edge. With no drawer open the padding is the page's plain one. It grows only by what centring leaves short, so a sheet already clear stays where it is and one that would be covered moves just clear.

One too wide for the room left starts clear of the drawer: the default sheet narrows to the room, and a set width (a device width, a PDF page) keeps its size and the page scrolls to the rest. When the room left beside the drawer would be under 480px, the least a form sheet is useful at, the padding stays the plain one and the drawer lies over the sheet. Nothing is measured for any of it: it is CSS arithmetic over the widths.

The end edge keeps clear of the inspector by the same rule: the end padding (`--page-end`) is `--db-props-w` plus the gaps while the inspector shows, the plain padding while it is folded or has nothing to show, and the plain padding too when under 480px would be left beside it, where the inspector lies over the sheet. Try it sets `--page-end` to its own room. The start padding centres the sheet against that end padding, so a sheet between a drawer and the inspector sits in the room between them and the default sheet narrows to it.

Fit reads the padding, and a fixed sheet's auto-fit runs again when a drawer opens or closes (the canvas observes the notice slot, which spans the page's room, as well as the page). A mode's own surface keeps the plain padding.

### 15. `persist-panels="<key>"` remembers the layout

With the attribute set (property `persistPanels`), the shell writes a small record on every change and puts it back when a shell with the same key next connects, before its first paint. The record holds the open strip panel, the two drawer widths once each has been dragged, whether the inspector is folded, and the workspace when it is Form, Logic, Data, Languages or Print. The Journeys and PDF workspaces are never put back, since their modes may not be registered yet when the shell comes up. The record's contents, storage and limits are in [the builder guide](../reference/builder.md) (The remembered layout). Without the attribute nothing is written or read, which is the default. `<datum-form-builder>` forwards the attribute.

### 16. Only the shell's own panels are remembered

A host's `slot="strip"` panel may not be slotted the next time, so it is never put back. Of the shell's own, the record can name any of the nine panels of decision 3. A restored Tests panel does not run its suite on opening: a page load never runs one by itself.

### 17. A record naming no panel leaves the Components palette to the shell

The shell opens the palette for a form with nothing in it and shuts it for one with components, and does not write its own opening or closing. A shell that reads a record with no panel applies that rule again, so the palette follows the form it finds; a panel the author opened is put back as it was.

### 18. Reading is defensive

A record from another version, one that does not parse, one naming a panel the shell does not have, or a store that throws is treated as no record, and widths are clamped to the drawers' limits on both write and read, so a hand-edited value cannot squash a column.

### 19. Nothing is written before the remembered layout is in place

Building the shell's DOM opens a default panel, which is itself a change; a write there would overwrite the record with the defaults before it was read. Writes start only once the shell is up and the record applied, and a restore never writes back what it applies.

### 20. A passing drawer state is not remembered

While the shell is narrow, or while the Medium tier has folded the inspector to make room for a panel (decision 11), nothing is written: a record made then would replace the author's wide layout with "everything closed". A layout read while the shell is narrow is applied when it widens.

### 21. The builder's colour scheme is not part of this record

It is a person's preference for the origin, so it is read and written under its own key whether or not `persist-panels` is set (ADR 0157).

## Reasoning

- **One bar, one strip.** A feature that is one more strip item or one more workspace costs a host page one more region, not another bar button and another dialog. Floating chrome kept clear of other chrome by script would need geometry custom properties rewritten on scroll and resize; this shell has none.
- **A label, not tabs or a dropdown.** Documents grow with the form's layouts, and a strip of tabs or a dropdown listing them all is the first thing on the bar to run out of room. The Journeys and PDF overviews list the documents with their state, so the bar needs only a name for where the author is.
- **Drawers rather than columns, at every width.** The form is the thing being edited and a panel is something consulted beside it. Making the wide layout a column layout and only the narrow one a drawer layout would keep the reflow where authors work most, and would give the shell two geometries to keep in step.
- **The sheet still moves aside for the side drawer where the room allows.** A panel opened to work on the form (the Tests panel recording against the labels, the outline beside the fields) is of no use over the labels it is about. Moving the sheet only by what centring leaves short keeps the common case still: at a wide window a 240px drawer barely shifts the sheet, and closing it puts the sheet back where it was. Below the useful width the drawer overlays, since a sheet squeezed beside it would reflow every field, which is what drawers are for avoiding.
- **Remembering is opt-in and keyed.** A host that embeds the builder twice, or wants a fresh layout, says so with the key. The site's live demo does not set it, so a marketing page greets every visit the same way.

## Consequences

- The builder is one bar, one strip, a canvas and two drawers over it. The regions a host page shows are what the host slots, the strip, the menu and the mode's views switch.
- The form keeps clear of the side drawer at the widths authors work at, and stays put while the inspector opens, closes and folds. In a canvas too narrow for both, the drawer lies over the sheet.
- With nothing selected the inspector draws nothing and its drawer is away; the form itself (Identity, Localization, chrome) is edited in the Form settings panel. One side panel is open at a time.
- `workspaces="pdf"` hides every workspace but PDF, so a page hosting the PDF side alone still moves between layouts on the PDF overview.
- An author's layout survives a reload, per key, and two builders on one origin keep separate layouts.
- Layout is checked in a real browser, since jsdom lays nothing out: the harness captures the sheet with each drawer closed, open and widened.
