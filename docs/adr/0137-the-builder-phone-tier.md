# ADR 0137: The builder's phone tier

## Status

Accepted.

## Context

Under 768px the builder cannot draw its Narrow layout squeezed: a strip and a nine-type rail down the start edge, drawers floating over a 300px canvas, a canvas toolbar, a document row and the bar's three groups at the top leave nothing a thumb can use. Phones get full editing, with the same markup, events and text as the other tiers, in a layout built for them.

## Decision

1. **A tier inside Narrow, set by the same observer.** The width observer of ADR 0099 (decision 11) that sets `data-narrow` under 900px sets `data-phone` under 768px of the shell's own box (`PHONE_MAX`), whatever the window.
   - A window shorter than 500px with a coarse pointer (a phone held on its side) is also a phone, whatever the shell's width.
   - The look and the behaviour both key on that one attribute.
   - The shell copies it onto every part with a shadow root of its own: the canvas, the inspector, the side panels, and the Logic, Data, Languages and overview surfaces and the palette once loaded.
   - Each part styles itself under `:host([data-phone])`. `phoneLayout` reads it.
2. **One top row.** It holds a Menu button named by the workspace with its problem count ("Menu. Form workspace, 2 problems"), undo and redo in one pill, and the host's Save.
   - In a designer, Menu is its glyph alone and a back title follows it: the document's name over its kind, which returns to the overview.
   - The workspace tabs and select, the document label, the palette and full-window buttons, the file menu, a mode's actions and the host's other slots are not on the row.
   - The row orders its own parts below zero, so a Save that arrives through a forwarding slot lands last.
3. **A menu drawer.** Menu opens a drawer from the start edge, a modal dialog over a scrim. It lists:
   - the workspaces with their counts;
   - in Journeys or PDF, that mode's documents, All layouts or All journeys, and the open document's options (Rename, Duplicate, Move up and down, Set as default, a two-step Delete);
   - the canvas (Try it, Show hidden components as a switch, zoom on a page with a fixed width);
   - the host's file actions;
   - Search commands and Full window.

   Its head names the form and, from `<datum-form-builder>`'s `dirty`, whether it is saved (`saveState`). The host's bar slots (`history`, `comments`, `publish`, `account`, `toolbar`, `canvas-actions`) and the mode's actions move into its last section, "From the page". The slot elements move, never what the host slotted, and they go back when the shell widens. The host's bar controls are therefore reachable on a phone only through the drawer; a host that wants a second action on the row puts it in `toolbar-start` beside Save.
4. **The bottom bar.** The strip and the rail are laid flat as labelled tabs: the rail's All components reads Add with a plus, and each strip item shows a short label (Form, Header, Add).
   - Form shows Add, Outline, Try it, More.
   - Logic shows Outline, Variables, Settings, Tests.
   - Data shows Variables, Settings, Tests.
   - A designer shows Add, Outline, Form, More.
   - Tests, an author's check rather than a way to change the form, sorts after Settings.
   - At most four items show; past four, the first three show and More lists the rest, the host's strip items included. Script places the items (an inline `order`) and marks the overflow. A host's overflowed item is hidden inline too, so no class of its own brings it back.
   - While the form is tried, Results takes More's place and Add is off.
   - Overviews have no bottom bar.
   - In designers the bottom bar and drawer offer Try it (ADR 0141).
5. **Bottom sheets.** Every drawer becomes a sheet over a scrim: the side column, the inspector, More, Try it's results, Logic's rule editor and Data's row editor. One is up at a time.
   - The side column and the inspector rise to 70% of the box, or to the full box from the handle row the shell draws above them, which also holds Close. The tall choice is remembered per panel for the page.
   - On a small phone (a shell under 360px wide or under 600px tall) both open at the full box by default, and lowering one is remembered the same way.
   - A sheet is a modal dialog: everything behind it is `inert`, focus goes into it, and focus returns to what opened it when the last sheet goes. Escape and the scrim close it.
   - Closing the inspector with an unapplied draft asks first (`requestLeave`).
   - Logic and Data draw their own sheet and say so with `builder-sheet-change`, and the shell then dims and stills its bars.
   - On a phone the inspector and the Form panels drop `data-floating`, so they draw as one framed panel with Apply and Discard pinned in its footer.
6. **A workspace switch puts every sheet away.** The inspector is folded, Try it ends, and Results, More and the drawer close. A layout's zoom does not carry to another tree.
7. **The canvas.** The form lays out at the canvas's width: no device switch, grips or drag handles, and the pan hand answers the mouse only, so a finger scrolls.
   - The canvas toolbar is gone; only the steps stepper and "Previewing · Back to editing" remain, each when it applies.
   - Selecting never opens the inspector. Edit, which leads the full-width selection bar above the bottom bar, a second tap on the selected component, and Enter do.
   - Picking a component in the Components or Outline sheet puts the sheet away.
   - A page with a fixed width (a PDF layout) opens at Fit, and two fingers zoom it.
   - Every workspace opens on a phone with no panel up.
8. **The surfaces.** Data's schema table is a list of cards, each a whole tap target: label, key, kind and "Required: …". Logic's filters scroll in one row. The palette is a tall sheet from the window's bottom edge. The Try panel is the Results sheet, with a head and a Close.
## Consequences

- Phones get every workspace, both designers, Try it, the palette and the file actions, with no second builder: the same markup, events, tests and text.
- Placed boxes in the PDF designer are not dragged by touch: numbers on the Style tab and the selection bar's moves serve instead. The journey map's pinch is its own zoom buttons.
