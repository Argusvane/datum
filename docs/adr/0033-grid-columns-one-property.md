# ADR 0033: Grid Columns Are One Property

## Status
Accepted.

## Context

A `grid` container is the layout an author reaches for to put fields side by side. Three
things an author expects of one have to be possible: dropping a component into a specific
column, leaving a column empty, and stacking two components in the same column. A grid that
holds all its children in one slot and lets CSS grid auto-placement flow them across the
tracks allows none of them: there is one drop target, the third child always lands in the
third track, and the next child always goes one track to the right.

An author also needs to say the common thing a layout grid is for: a wide main column beside
a narrow one, `6/4/2` rather than `4/4/4`. Every grid system an author has met (Bootstrap,
Foundation, Material) says it the same way: a row is twelve units and each column spans some
of them. The builder's property editor has no list control, and a count kept in one box and a
width list in another would have to be held in step by the author.

## Decision

### Columns are slots

1. **A grid's columns are its child slots.** A grid with N columns has slots `column_1` …
   `column_N`, derived from its configuration (`core/schema/grid.ts`) the way a `tabs`
   container's slots are derived from `configuration.tabs`. The registered `grid` definition
   declares no static slots, because a static list could not follow the count.
   `configuredSlotIds` in `render/core/tab-slots.ts` is the one place both surfaces ask
   "which slots does this node have" for such types.

2. **The grid is a group with one cell per slot.** The renderer hands the grid's group adapter
   its slots in order; Datum's (`render/live/datum/groups.ts`) draws a
   `datum-form__layout--grid` element holding one `datum-form__grid-column` cell per slot,
   each stacking its children like the form itself does. Every declared column gets a cell
   whether or not it holds anything, so an empty second column keeps the third column's
   content in the third column.

   On the builder canvas an empty slot is drawn by the canvas's
   `emptySlot` hook, a vertical drop zone, exactly as for `panel` and `tabs`, so the canvas
   shows one drop target per column inside the real cell. A stack
   container placed in a column sits in a vertical context and spreads its children as it
   does anywhere else.

3. **Nothing authored is dropped when the count shrinks.** A slot the grid does not declare
   (a column removed by lowering the count, or any other slot id) still renders, as a
   trailing cell that takes the whole row. When the grid's configuration is next edited
   through the builder (Save on the properties panel, or `BuilderController.setProperty`),
   `foldGridChildrenIntoColumns` moves those children into the last remaining column, after
   whatever is already there, in the same undo entry as the edit.

### One property, two readings

4. **`configuration.columns` is the one property, and it reads two ways.**
   - A count (`3`, or
     `"3"` as the builder's text box stores it) gives that many equal columns.
   - A span list
     (`"8/4"`, `"3 / 6 / 3"`, `[8, 4]`; `/`, `,` or spaces separate) sizes the columns on a
     twelve-track row and implies their number: two spans, two columns.

   `readGridColumnSpec` in
   `core/schema/grid.ts` is the single reading; `readGridColumnCount` and
   `readGridColumnWidths` are views of it, so the slots, the fold on shrink and the drawing all
   agree. A list may be authored as a JSON array or as the builder's string; both render
   identically.

5. **Each span is an integer 1..12, floored.** A sum below twelve leaves empty tracks at the
   end of the row; a sum above twelve wraps (Bootstrap's semantics, so nothing an author
   already knows is contradicted).

6. **Equal spans are equal columns.** `"6/6"` and `"4/4/4"` read as the counts 2 and 3: the
   same markup, the same tracks, the same wrapping. Only an uneven list takes the sized path
   below.

7. **A lone number is always a count.** `"12"` is twelve columns, not one full-width span;
   one column is `"1"`.

8. **Anything unreadable falls back to the default two equal columns**, so a half-typed value
   never leaves a grid with nothing to drop into.

9. **A count or a width list is capped at twelve** (`GRID_MAX_COLUMNS`): a larger count is cut
   to twelve and a longer list to its first twelve. A definition is untrusted input and every
   slot is a drawn cell in each surface. Children in columns past the cap are kept, drawn
   after the declared columns, and folded into the last column on the builder's next edit.

### Tracks

10. **Equal columns wrap on a narrow form.** With one cell per declared column, a wide form shows
    N equal columns, while a form narrower than the columns need stacks the cells one per row
    instead of squeezing the controls. The minimum column width is a token
    (`layout-grid-column-min`) so a host can set its own breakpoint; the count is on the element as
    `data-columns` for a stylesheet to key off.

11. **A sized grid is a fixed twelve-track row.** Datum's adapter writes `data-column-widths` (the
    normalized `"6,4,2"`) on the grid and sets `--datum-grid-span: N` on each cell through the CSSOM
    (never an inline `style` attribute); the stylesheet gives each cell that many of the twelve
    tracks. A trailing cell for an undeclared slot has no span and takes the whole row.

12. **A sized grid stacks by container query, not viewport.** Fixed tracks cannot `auto-fit`, so a
    sized grid is its own query container and, below 600px of its own inline size, gives every cell
    the whole row. Keying off the grid rather than the viewport is what makes the builder's
    preview-width picker show the stacked layout at a phone width on a desktop screen. The
    breakpoint is a stylesheet constant rather than a token because a container query's condition
    cannot read a custom property. The rules are in `render/live/datum/groups.ts`
    (`DATUM_CONTAINER_CSS`) and `render/live/datum/css.ts`.

## Reasoning

A slot per column, rather than one `content` slot with auto-placement, makes "drop into the
third column", "leave the second empty" and "two components in one column" the same
`{ parentId, slotId }` address every other container is edited through.

One property rather than a count plus a separate width list: the list already says how many
columns there are, so a count beside it is redundant and the two can disagree. When they
disagreed the only honest renderings were equal columns (a silent re-layout of what the
author wrote) or guessing which column gained or lost a share. Making `6/6` read as the count
2 keeps the common case on the simple wrapping path instead of the fixed-track path with its
600px breakpoint.

## Consequences

- `grid` is the only layout container. `insertionAxisForLayout` and the layout-element drop
  zone read its columns, and any other container stacks its children one per row.
