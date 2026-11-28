/**
 * The data grid and the repeating section: a collection-bound container whose
 * children are the template of one row. A {@link LiveFeature} (`createDataGridFeature()`) the host
 * lists in `features`; the adapter draws the rows and their buttons, and the renderer owns:
 *
 * - the rows, from the presentation fold: keyed by the row's identity (`PresentationGridRow.key`,
 *   the runtime's stable entry key), so a removal or a move leaves each remaining row's nodes, its
 *   answers and its focus with it. `GridState.eachRow` draws them keyed; an adapter never maps `rows`;
 * - the buttons: `add`, `remove`, `moveUp` and `moveDown` are present only when pressing them
 *   would be accepted now (the fold has applied the grid's offers, its bounds and a lock);
 *   `offers` says which the grid has at all, so an adapter draws the others disabled and a button
 *   the grid does not offer not at all. Each press goes to the runtime (`addRow`, `removeRow`,
 *   `reorderRow`); a refusal is reported as `datum-binding-error {hook:"grid"}`;
 * - focus after a row button, once the draw that shows the rows it left has landed and the new
 *   fields are ready: the new row's first control after Add; the row now in a removed one's place
 *   (the previous row after the last was removed), the Add button when none is left; the moved
 *   row's button that was pressed (its first control where that button is now disabled);
 * - the layout: `table` for `auto` and `table`, `stacked` for `stacked` and a repeating section
 *   (`GridState.responsive` says the author left it to the form: `auto`), and `stacked` whatever
 *   the author chose for an adapter that draws no table (`GridAdapter.layouts`), which is chosen
 *   before the rows are drawn. In the table layout the cells' labels are hidden (the column
 *   heading names them, and a hidden label still names the control); a cell that holds a
 *   container keeps its labels (`GridCell.group`). Under `auto` the labels are kept and the
 *   binding's stylesheet hides them while the grid is wide;
 * - the grid's own errors, shown when the form shows inline errors.
 *
 * The Add button carries `GridState.addId`; `gridAddId` names it for the summary, whose entry for a
 * cell error no row owns goes there. `defaultGridAdapter` is the look Datum draws when neither the
 * binding nor the Datum binding has a grid adapter.
 */
import { gridLayoutFor, usedContainerCapabilities, type GridAdapter, type GridColumn, type GridRow, type GridState } from "./contract.js";
import { componentTextOf } from "./component-text.js";
import { datumGridAdapter } from "./datum/grid.js";
import type { PresentationGrid, PresentationGridRow } from "../core/presentation-tree.js";
import { html, repeat, type TemplateResult } from "./lit.js";
import type { DrawContext, DrawnField, LiveContext, LiveFeature, LiveRuntime } from "./mount.js";

const OWNER = "data-grid";

/** The look Datum draws a data grid with when neither the binding nor the Datum binding has a grid adapter (`datum/grid.ts`). */
export const defaultGridAdapter: GridAdapter = datumGridAdapter;

/** The id of a grid's Add button: what a summary entry for a cell error no row owns focuses. */
export const gridAddId = (gridId: string): string => `${gridId}__add`;

/** What the renderer needs of the runtime for a grid's buttons. */
export interface GridRuntime {
  /** Appends a row; returns its index. Throws when the grid refuses (a bound). */
  addRow?(collectionPath: string, row?: Record<string, unknown>): number;
  removeRow?(collectionPath: string, rowIndex: number): void;
  reorderRow?(collectionPath: string, fromIndex: number, toIndex: number): void;
}

/** Where focus goes once the draw that shows the rows a button left has landed. */
interface PendingFocus {
  gridId: string;
  /** How many rows that draw shows; a draw of another count is a stale one and leaves the move queued. */
  rows: number;
  /** The row to focus (its first control), or the Add button. */
  target: number | "add";
  /** A moved row: focus goes back to the button that was pressed, where it is still enabled. */
  keepButton: boolean;
  /** The button that was pressed (`keepButton` rows only). */
  restore?: HTMLElement | undefined;
}

interface GridMemory {
  /** The rows each grid showed in the draw in progress. */
  rows: Map<string, number>;
  /** The keys of the fields a table cell holds directly, by grid: their labels are hidden. */
  tableCells: Map<string, Set<string>>;
  pending: PendingFocus | undefined;
}

function memoryOf(live: LiveContext): GridMemory {
  return live.memory<GridMemory>(OWNER, () => ({ rows: new Map(), tableCells: new Map(), pending: undefined }));
}

const messageOf = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : String(thrown));

function isDisabled(element: HTMLElement): boolean {
  return (element as HTMLButtonElement).disabled === true || element.getAttribute("aria-disabled") === "true";
}

// ── Drawing ────────────────────────────────────────────────────────────────────────────────

/** A column's width hint: the column component's `configuration.width`, when the author gave one. */
function widthOf(column: PresentationGrid["columns"][number]): string | undefined {
  const configuration = column.model.node.configuration;
  const width = configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>)["width"] : undefined;
  const text = typeof width === "string" ? width.trim() : typeof width === "number" && Number.isFinite(width) ? `${width}px` : "";
  // Only a length or a fraction: the hint ends up in a style attribute.
  return /^\d+(\.\d+)?(px|em|rem|%|ch|fr|vw)$/.test(text) ? text : undefined;
}

function drawGrid(node: PresentationGrid, draw: DrawContext): TemplateResult {
  const live = draw.live;
  const memory = memoryOf(live);
  const runtime = live.runtime as LiveRuntime & GridRuntime;
  const wanted: GridState["layout"] = node.layout === "stacked" ? "stacked" : "table";
  const interactive = live.mode === "interactive";
  const path = node.collectionPath;
  const count = node.rows.length;
  memory.rows.set(node.id, count);

  // The adapter is chosen before the rows are drawn: whether it draws a table decides whether the
  // cells' labels are hidden, which each cell's field reads as it is drawn. Its `when` sees the
  // state with every cell still empty.
  const a11y = node.model.accessibility;
  const errors = draw.output.meta.presentation.showInlineErrors ? [...node.errorMessages] : [];
  const errorId = errors.length > 0 ? (a11y.errorId ?? `${a11y.fieldId}__error`) : undefined;
  const hintId = node.hint !== undefined ? `${a11y.fieldId}__description` : undefined;
  const columns: GridColumn[] = node.columns.map((column) => {
    const width = widthOf(column);
    return { id: column.id, label: column.label, required: column.required, ...(width !== undefined ? { width } : {}) };
  });
  const stateOf = (layout: GridState["layout"], rows: GridRow[]): GridState => ({
    id: node.id,
    key: node.key,
    type: node.type,
    base: node.base,
    ...(node.legend !== undefined ? { legend: node.legend } : {}),
    ...(node.hint !== undefined ? { hint: node.hint } : {}),
    ...(hintId !== undefined ? { hintId } : {}),
    hideLegend: node.hideLegend,
    ...(node.legendMark !== undefined ? { legendMark: node.legendMark } : {}),
    level: node.level,
    classNames: node.classNames,
    locale: draw.form.locale,
    dir: draw.form.dir,
    words: draw.words,
    text: componentTextOf(node.model.node, draw.form.locale, draw.words.words),
    layout,
    responsive: node.layout === "auto" && layout === "table",
    columns,
    showHeader: node.showHeader,
    showRowNumbers: node.showRowNumbers,
    rows,
    eachRow: (drawRow) => html`${repeat(rows, (row) => row.key, drawRow)}`,
    offers: node.actions,
    addId: gridAddId(node.id),
    captions: node.captions,
    errors,
    ...(errorId !== undefined ? { errorId } : {})
  });
  const empty = html``;
  const unfilled: GridRow[] = node.rows.map((row) => ({ index: row.index, key: row.key, label: row.label, cells: row.cells.map((cell) => ({ columnId: cell.columnId, content: empty })) }));
  const resolved = live.resolve<GridAdapter>("grid", node.type, node.base, stateOf(wanted, unfilled));
  const layout = gridLayoutFor(resolved?.adapter ?? defaultGridAdapter, wanted);

  // A table cell that holds a field directly: its label is hidden, the column heading names it.
  const hidden = new Set<string>();
  // Left to the form (`auto`), a table while wide: the binding's stylesheet hides the labels then, and shows them stacked.
  if (layout === "table" && node.layout !== "auto") {
    for (const row of node.rows) {
      for (const cell of row.cells) {
        for (const child of cell.children) {
          if (child.kind === "field") {
            hidden.add(child.key);
          }
        }
      }
    }
  }
  memory.tableCells.set(node.id, hidden);

  /** A button press: remembered for the draw that shows what it left; a refusal is reported. */
  const press = (pending: PendingFocus, run: () => void): (() => void) => () => {
    if (!live.mounted() || !interactive || node.locked) {
      return;
    }
    const active = live.root.activeElement;
    memory.pending = { ...pending, ...(pending.keepButton && active instanceof HTMLElement ? { restore: active } : {}) };
    try {
      run();
    } catch (thrown) {
      memory.pending = undefined;
      live.error({ hook: "grid", id: node.id, message: messageOf(thrown) });
    }
  };

  const rows: GridRow[] = node.rows.map((row: PresentationGridRow) => {
    const out: GridRow = {
      index: row.index,
      key: row.key,
      label: row.label,
      cells: row.cells.map((cell) => ({ columnId: cell.columnId, content: draw.nodes(cell.children), ...(cell.children.some((child) => child.kind !== "field") ? { group: true } : {}) }))
    };
    if (interactive && runtime.removeRow && row.canRemove) {
      // After the last row the previous one; the Add button when none is left.
      out.remove = press({ gridId: node.id, rows: count - 1, target: count === 1 ? "add" : Math.min(row.index, count - 2), keepButton: false }, () => runtime.removeRow?.(path, row.index));
    }
    if (interactive && runtime.reorderRow && row.canMoveUp) {
      out.moveUp = press({ gridId: node.id, rows: count, target: row.index - 1, keepButton: true }, () => runtime.reorderRow?.(path, row.index, row.index - 1));
    }
    if (interactive && runtime.reorderRow && row.canMoveDown) {
      out.moveDown = press({ gridId: node.id, rows: count, target: row.index + 1, keepButton: true }, () => runtime.reorderRow?.(path, row.index, row.index + 1));
    }
    return out;
  });
  const state: GridState = stateOf(layout, rows);
  if (interactive && runtime.addRow && node.canAdd) {
    state.add = press({ gridId: node.id, rows: count + 1, target: count, keepButton: false }, () => {
      const added = runtime.addRow?.(path);
      if (memory.pending !== undefined && typeof added === "number") {
        memory.pending = { ...memory.pending, target: added };
      }
    });
  }

  let adapter: GridAdapter = resolved?.adapter ?? defaultGridAdapter;
  let from: "binding" | "binding-base" | "datum" | "datum-base" | "renderer" = resolved?.from ?? "renderer";
  let via = resolved?.via ?? node.type;
  if (resolved === undefined || resolved.from === "datum" || resolved.from === "datum-base") {
    live.report(`${node.id}: component "${node.type}"`);
    live.warnOnce(`type:${node.type}`, `No adapter of this binding draws "${node.type}" (component "${node.id}"): Datum's draws it.`);
  }
  let drawn = live.call("template", node.key, () => adapter.template(state));
  if (drawn === undefined && adapter !== defaultGridAdapter) {
    // The binding's template threw: Datum's draws the container, never nothing.
    adapter = defaultGridAdapter;
    from = "renderer";
    via = node.type;
    drawn = live.call("template", node.key, () => adapter.template(state));
  }
  live.recordAdapter(node.id, { from, via, ...(adapter.name !== undefined ? { name: adapter.name } : {}) });
  live.reportCapabilities(node.id, adapter, usedContainerCapabilities("collection", state));

  let inner: TemplateResult = drawn ?? html`${rows.map((row) => row.cells.map((cell) => cell.content))}`;
  const canvas = live.options.canvasHooks?.renderContainer;
  if (canvas) {
    const base = inner;
    inner = live.call("renderContainer", node.key, () => canvas({ model: node.model, kind: "grid", label: node.legend, slots: new Map() }, base)) ?? base;
  }
  // Datum's look (its adapter, or the renderer's own default, which is Datum's) inside another binding is tinted by its tokens.
  return draw.container(node, node.base, inner, undefined, from !== "binding" && from !== "binding-base");
}

// ── Focus after a row button ───────────────────────────────────────────────────────────────

/** Puts focus where a row button sends it, once the rows are drawn and their new fields are ready. */
function applyFocus(live: LiveContext, pending: PendingFocus): void {
  if (!live.mounted()) {
    return;
  }
  // The moved row's button that was pressed, where it is still there and can be pressed.
  const restore = pending.restore;
  if (restore !== undefined && restore.isConnected && !isDisabled(restore) && live.focusElement(restore)) {
    return;
  }
  if (pending.target !== "add") {
    const target = pending.target;
    const field = live.fields().find((candidate: DrawnField) => candidate.state.row?.ownerId === pending.gridId && candidate.state.row.index === target);
    if (field !== undefined && live.focusField(field.key)) {
      return;
    }
  }
  const add = live.root.getElementById(gridAddId(pending.gridId));
  if (add instanceof HTMLElement && !isDisabled(add)) {
    live.focusElement(add);
  }
}

/**
 * Focus for an error the grid itself owns (its row count, a cell error no row owns): the Add
 * button where it is there and can be pressed, else the grid's first row control. `false` when
 * `gridId` is no grid drawn here, or the grid offers neither.
 */
export function focusGridOwner(live: LiveContext, gridId: string): boolean {
  const add = live.root.getElementById(gridAddId(gridId));
  if (add instanceof HTMLElement && !isDisabled(add) && live.focusElement(add)) {
    return true;
  }
  const first = live.fields().find((candidate: DrawnField) => candidate.state.row?.ownerId === gridId);
  return first !== undefined && live.focusField(first.key);
}

// ── The feature ────────────────────────────────────────────────────────────────────────────

/** The data grid and repeating section as a renderer module. */
export function createDataGridFeature(): LiveFeature {
  return {
    id: OWNER,
    drawNode: (node, draw) => (node.kind === "grid" ? drawGrid(node, draw) : undefined),
    focusOwner: (componentId, live) => focusGridOwner(live, componentId),
    fieldState(state, _node, draw) {
      // In the table layout the column heading names a cell's control, its own label is hidden.
      const owner = state.row?.ownerId;
      if (owner === undefined || state.hideLabel) {
        return undefined;
      }
      return memoryOf(draw.live).tableCells.get(owner)?.has(state.key) === true ? { ...state, hideLabel: true } : undefined;
    },
    afterDraw(_report, live) {
      const memory = memoryOf(live);
      const pending = memory.pending;
      if (pending !== undefined && memory.rows.get(pending.gridId) === pending.rows) {
        memory.pending = undefined;
        // The new fields get ready first (a design system's element cannot take focus before).
        void live.updated().then(() => applyFocus(live, pending));
      }
      memory.rows.clear();
    }
  };
}
