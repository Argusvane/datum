# ADR 0153: A data grid container

## Status

Accepted.

## Context

A form often asks for a list of similar things: dependants, employers, line items, previous
addresses. The engine carries the pieces of a repeating section: a `collection`
binding on a container, entries stored as `items[0].sku`, a `CollectionRuntime` with
add/remove/reorder, per-entry required and format checks in the browser and the kernel, per-entry
calculations in the kernel, table and stacked PDF renditions, the variables panel's `row.`
aliases, and journeys that keep a section whole on one page.

What an author wants is one thing: a container they drop fields into, whose fields become the
columns of a grid, with a configurable Add row, Remove row and reorder, and bounds on how many
rows a submission may carry. What a person filling the form wants is a table where it fits and a
stacked list of rows where it does not, with the same controls they use everywhere else.

A second representation of the same thing, a row template given as a list of column definitions in
`configuration.columns`, would need a special case next to `collection` in every walker (the data
paths, the fold, the kernel, the journeys, the data model). The grid is therefore the collection
binding, not a parallel shape. It is not the layout `grid` of ADR 0033, which only places
components side by side and adds nothing to the data.

## Decision

1. **One type, `dataGrid`, is the data grid, and it is a container.** It has one slot, `content`,
   and the children in that slot are the template of one row. Its rows are a collection in the
   repeating-section sense: the node carries `collection: { collectionPath }` (the path else the grid's id;
   the builder shows it read-only under "Saved as" and carries it along when the grid's id is
   renamed, as for any repeating section, ADR 0109), each row is one entry at that path, and each
   child's answer is keyed in the entry by its data key (`items[0].sku`, `items[0].address.city`
   under a data-scoping container). Every seam that reads `node.collection` therefore reads a grid
   without a case of its own: `collectionPathOf`, `buildDataPaths`, `buildRowKeys`, the
   hidden-value policy, `kernelFoldInSection`, the kernel's known-key shapes and per-entry checks,
   the PDF renditions, the variables panel and the data model, the journey walkers.

2. **A grid with no binding is bound at its id.** `normalizeDataGrids` (`core/schema/data-grid.ts`)
   gives every `dataGrid` that carries no `collection` the binding `{ collectionPath: <its id> }`.
   The browser applies it where it compiles the definition (`compileFormDefinition`); the kernel
   applies its own mirror at the top of `runKernel`, before anything walks the definition, so both
   read a grid's rows at one path. A grid with no children is an empty grid.

3. **What is the grid's own lives in `configuration`.** The layout (`auto`, `table` or
   `stacked`), whether the column headings and each row's number are drawn, which row operations are
   offered, the row-count bounds and the captions (`addLabel`, `removeLabel`, `rowLabel`,
   `emptyText`, each falling back to a form text). The settings and their defaults are in
   `docs/data-model.md` ("Data grids"). `dataGridSettingsOf` applies the defaults and clamps: a bound
   below 0 or not a number reads as its default, one above 500 reads as 500, `maxRows` below
   `minRows` reads as `minRows`, `initialRows` is kept within the bounds.

   A grid with no `maxRows` is held to 500 rows in the browser, the kernel and field constraints
   alike (`DATA_GRID_ROWS_CAP`), so a client cannot post more rows than a person could add; a
   hidden grid with no `maxRows` is held to the same cap in the kernel.

   A bound may also be a formula: `rules.minRows` and `rules.maxRows` are rule sources
   like `requiredWhen`, evaluated form-scoped (a `row.`, `ancestor.`, `rowIndex()` or `rowCount()`
   read is `rule.unsupportedScope` and the formula is never evaluated: the bound belongs to the
   whole grid) to a number; a finite whole number wins over the fixed bound, anything else leaves
   the fixed bound in force. Both the browser and the kernel evaluate it, so the bound buttons and
   the row-count codes agree with the server.

   `collection.operations` is derived from the configuration for a grid (`rowOperationsOf`), never
   authored; for any other collection-bound container it is read as written, and an absent flag
   defaults to add and remove on, reorder off (a host calling `reorderRow` on such a section must
   set the flag). A grid with one child is a one-column grid; its rows are still objects.

4. **The browser draws rows from one DOM, whatever the layout.** A grid is a fieldset with its
   legend and description around a scroll region (`part="datagrid-scroll"`, `overflow-x: auto`, so a
   table forced wider than the form scrolls in its own region and the caption stays as wide as the
   region) holding a table: a column heading per template child, one row per entry with a row
   header cell holding the row number, one cell per child holding that child rendered at
   `collectionPath[i].rowKey` exactly as it renders anywhere else (same control, same error message
   under it, ids made unique per row), and an actions cell with Remove, Move up and Move down as the
   settings allow. An Add button follows the table; an empty grid shows `emptyText` in place of the
   body. Buttons at a bound are disabled: Add at `maxRows`, Remove at `minRows`, Move up on the
   first row, Move down on the last. Each row's buttons carry `aria-describedby` pointing at the
   row's name (the row-number header cell, or a visually hidden span when row numbers are off), so a
   screen reader says which row a button acts on.

   The stacked layout is the same DOM restyled: each row a block headed by its row number, each
   cell's label shown. Under `auto` a container query switches to stacked below the
   width the grid's column count needs (`docs/data-model.md`, Data grids). A
   collection-bound container that is not a grid (a converted section, a `repeatingSection`) is
   drawn the same way in the stacked layout, so those sections are fillable too. The captions are
   form texts, overridable per grid and per page (`docs/translation-support.md`, "Data grids"). Styling
   uses the existing tokens; a design-system binding draws the table through its own `grid` adapter.

5. **Row actions go through the runtime.** The renderer's grid module (`render/live/data-grid.ts`) hands the
   grid adapter add, remove and move actions per row, which call `FormRuntime.addRow`,
   `removeRow` and `reorderRow`; a draw follows the `COLLECTION_CHANGED` event; focus lands on the new row's first control after Add, on the same row position (else the
   Add button) after Remove, and stays on the moved row's button after a move.

   The runtime seeds
   `initialRows` empty entries when a grid has none at construction, keeps restored entries (a
   draft, a prefill) and seeds its collection runtime from them, and derives a grid's item fields
   from its children when the binding lists none.

   Calculations inside a grid are evaluated per row
   in the browser with `row.`, `rowIndex()` and `rowCount()` in scope and written into the entry,
   mirroring the kernel's per-entry loop, so a line total computes in the browser as it does on the
   server.

6. **The row count is checked, on both sides.** The codes `rows.min` and `rows.max` (parameters
   `{ min | max, count }`, reported against the grid at its collection path) are raised by
   `field-constraints.ts` and the kernel alike; the browser's submitted document carries every row
   the person saw, an empty one included, so the kernel counts what the browser counted. Each cell
   is held to its own field's checks per entry (`docs/reference/sandbox-abi.md`).
   `validWhen`, `requiredWhen` and `visibleWhen` are never read inside a row (ADR 0120 decision 3).
   The kernel, field constraints and the browser's fold share one walk that reaches a grid's fields
   through any container inside a row and through grids nested in rows, so a blank required field
   in a nested grid's row is a refusal on the server as it is in the browser. The error summary
   names a row's error "Row n: Label".

7. **The builder offers it as a container.** "Data grid" joins the Layout palette group; its
   definition declares the `content` slot (empty hint "Drop the fields of one row here"). No type
   is refused in a row beyond `form`, which no slot takes: a data grid, a button, a file upload and
   a steps container may sit in a row, directly or inside a container within it. A new grid is
   seeded with `collection: { collectionPath: <id> }` and an empty slot.

   The inspector has a Rows section for the settings of decision 3, with problems under the box
   when a maximum is below the minimum or a bound is past 500 (ADR 0111: never blocking Save).
   Required, Calculated and Validate are offered for fields in a grid as for any repeating section
   (not enforced per row, with the existing note); the grid itself offers no Required.

   The canvas draws a grid as its header and
   one template row of drop zones, no actions (`dataGridRows: "template"` on the render options);
   Try it draws real rows. The data model, drawn and imported in the builder's Data workspace, maps
   a list of objects to a data grid and reads a grid's rows as it reads a section's; the variables
   panel lists its fields under "In <label>" as `row.<id>`; journeys keep a grid whole on one page.

8. **The PDF prints a grid as a collection.** `dataGrid` is in the rendition catalog with the
   collection renditions: `table` (header from the children's labels, one body row per entry,
   repeated header, kept-together rows, tagged Table/TR/TH/TD) by default and under `layout:
   "table"` or `"auto"`, `sections` (one labelled group per row, headed as the screen heads it: `rowLabel` with `{{n}}` filled, else "Row n") under `layout: "stacked"`; a
   layout may choose either. The derived default layout binds the grid as one field; the template
   designer offers the grid's path as it offers a section's.

9. **Hosts need no code for it.** A grid's children are walked as any container's and its rows are
   entries as a section's. The UI assets manifest's `knownComponentTypes`, which a host hands the
   kernel's `check`, is built from `ENGINE_COMPONENT_TYPES` and lists `dataGrid`, so the grid is
   never reported as an unknown type.

## Consequences

- An author can build a list of similar things without JSON, and a person can fill it in the
  browser, on paper and through a host, with the same checks everywhere.
- Every walker treats a grid and a collection-bound section as one concept.
- The browser posts a collection-bound container's entries as one list at its collection path
  (`items: [{…}, {}]`, an empty one included) instead of flat `items[i].k` keys, so the kernel
  counts the rows the person saw; the kernel flattens the list, so hosts read the same canonical
  keys. The digest of a form with no collection is unchanged.
- Reorder is Move up / Move down only; a row's own `visibleWhen` / `requiredWhen` / `validWhen` are
  not read (ADR 0120); a row list is one JSON cell in a CSV export; a PDF cell is the formatted
  value, not delegated to each child's own rendition.
