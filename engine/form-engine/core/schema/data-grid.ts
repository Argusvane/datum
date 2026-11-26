import type { CollectionOperations } from "./collection.js";
import type { ComponentNode } from "./types.js";

/**
 * A data grid: a container whose children are the template of one row. The person
 * filling the form adds rows, removes them and moves them; each row is one entry at the grid's
 * collection path (`collection.collectionPath`, else the grid's id), its answers keyed by the
 * children's data keys, exactly as a repeating section's entries are.
 * So every seam that already reads `node.collection` — the data paths, the fold, the sandbox
 * kernel, the PDF renditions, the variables and data model panels, the journeys — reads a grid
 * with no case of its own.
 *
 * What is the grid's own is in `configuration`: how the rows are laid out, which row
 * operations the form offers, the row-count bounds and the captions. The builder's "Saved
 * as" box edits the collection path; `collection.operations` is derived from the
 * configuration, never authored (see {@link rowOperationsOf}). A grid with no collection binding
 * keeps its rows at its id ({@link normalizeDataGrids}), in the browser and in the kernel alike.
 */
export const DATA_GRID_COMPONENT_TYPE = "dataGrid";

/** The grid's one slot: the row template. */
export const DATA_GRID_SLOT_ID = "content";

/**
 * How rows are drawn. `table` is one row per table row with the children's labels as the
 * header; `stacked` is one labelled group per row with each child drawn as it is anywhere
 * else; `auto` (the default) is the table where the grid is wide enough and the stacked form
 * under the fold — one DOM, switched by CSS.
 */
export type DataGridLayout = "auto" | "table" | "stacked";

export const DATA_GRID_LAYOUTS: readonly DataGridLayout[] = ["auto", "table", "stacked"];

/**
 * The most rows a grid may be configured to hold or seed, whatever the author types, and the
 * most any grid holds: one with no `maxRows` is held to it when a row is added, by the
 * field-constraints stage and by the kernel (`rows.max`), so a client cannot post more rows
 * than a person could add.
 */
export const DATA_GRID_ROWS_CAP = 500;

/** What `configuration` may carry on a `dataGrid`. Every key is optional. */
export interface DataGridConfiguration {
  label?: string;
  hideLabel?: boolean;
  description?: string;
  layout?: DataGridLayout;
  /**
   * Whether the column headings row is drawn. Default true. Off, the table has no `<thead>` and
   * each cell's own label does the naming: still visually hidden under the table layout (read
   * by assistive technology), shown under the stacked one.
   */
  showHeader?: boolean;
  /**
   * Whether each row is headed by its number ("Row 1"). Default true. Off, no row header cell
   * is drawn; the row's name is kept hidden from view for assistive technology (it names the
   * row's buttons).
   */
  showRowNumbers?: boolean;
  /** Whether the form offers an Add row button. Default true. */
  canAdd?: boolean;
  /** Whether each row offers a Remove button. Default true. */
  canRemove?: boolean;
  /** Whether each row offers Move up / Move down. Default false. */
  canReorder?: boolean;
  /** Fewest rows a submission may carry (`rows.min`). Default 0. */
  minRows?: number;
  /** Most rows a submission may carry (`rows.max`); absent means no bound. */
  maxRows?: number;
  /** Rows the form opens with when the grid has no entries yet. Default 1. */
  initialRows?: number;
  /** Caption of the Add button; the form text `dataGridAdd` when absent. */
  addLabel?: string;
  /** Caption of each row's Remove button; the form text `dataGridRemove` when absent. */
  removeLabel?: string;
  /** Each row's heading; `{{n}}` is the row's 1-based number. The form text `dataGridRow` ("Row {{n}}") when absent. */
  rowLabel?: string;
  /** Shown in place of the rows when there are none; the form text `dataGridEmpty` when absent. */
  emptyText?: string;
}

/** The grid's settings with every default applied and every bound clamped. */
export interface DataGridSettings {
  layout: DataGridLayout;
  showHeader: boolean;
  showRowNumbers: boolean;
  canAdd: boolean;
  canRemove: boolean;
  canReorder: boolean;
  minRows: number;
  maxRows: number | undefined;
  initialRows: number;
}

export function isDataGrid(node: ComponentNode): boolean {
  return node.type === DATA_GRID_COMPONENT_TYPE;
}

function configurationOf(node: ComponentNode): DataGridConfiguration {
  const configuration = node.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration)
    ? (configuration as DataGridConfiguration)
    : {};
}

function wholeNumber(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !isFinite(value) || value < 0) {
    return fallback;
  }
  const whole = Math.floor(value);
  return whole > DATA_GRID_ROWS_CAP ? DATA_GRID_ROWS_CAP : whole;
}

/**
 * The settings a grid runs with. A bound outside its range reads as its default, `maxRows`
 * below `minRows` reads as `minRows` (the builder flags both as problems; the form still
 * works), and the opening row count is kept within the bounds.
 */
export function dataGridSettingsOf(node: ComponentNode): DataGridSettings {
  const configuration = configurationOf(node);
  const layout: DataGridLayout =
    configuration.layout !== undefined && DATA_GRID_LAYOUTS.indexOf(configuration.layout) >= 0
      ? configuration.layout
      : "auto";
  const minRows = wholeNumber(configuration.minRows, 0);
  const configuredMax = configuration.maxRows === undefined ? undefined : wholeNumber(configuration.maxRows, Number.NaN);
  const maxRows = configuredMax === undefined || isNaN(configuredMax) ? undefined : Math.max(configuredMax, minRows);
  let initialRows = wholeNumber(configuration.initialRows, 1);
  if (initialRows < minRows) {
    initialRows = minRows;
  }
  if (maxRows !== undefined && initialRows > maxRows) {
    initialRows = maxRows;
  }
  return {
    layout,
    showHeader: configuration.showHeader !== false,
    showRowNumbers: configuration.showRowNumbers !== false,
    canAdd: configuration.canAdd !== false,
    canRemove: configuration.canRemove !== false,
    canReorder: configuration.canReorder === true,
    minRows,
    maxRows,
    initialRows
  };
}

/**
 * The row operations a collection-bound node offers. A data grid's come from its configuration;
 * a repeating section's from `collection.operations`, else everything but reorder — the shape
 * the runtime has always defaulted to, minus the reorder no form has had controls for.
 */
export function rowOperationsOf(node: ComponentNode): Required<CollectionOperations> {
  if (isDataGrid(node)) {
    const settings = dataGridSettingsOf(node);
    return { add: settings.canAdd, remove: settings.canRemove, reorder: settings.canReorder };
  }
  const operations = node.collection?.operations;
  return {
    add: operations?.add !== false,
    remove: operations?.remove !== false,
    reorder: operations?.reorder === true
  };
}

/**
 * How deep {@link normalizeDataGrids} reads a tree, counting the root as level 1: one level past
 * the deepest a definition may nest (`kernelMaxComponentDepth()`, 32, core/expressions/compile.ts),
 * where the sandbox kernel's mirror stops too. A deeper tree is refused before it is read
 * (`compileFormDefinition`, `runKernel`), so a grid below the line is never one anybody draws;
 * stopping there keeps the two normalizers equal and a tree of any depth off the call stack.
 * Written out rather than imported because compile.ts reads this module; a test holds the two
 * numbers equal.
 */
export const DATA_GRID_NORMALIZE_DEPTH = 33;

/**
 * Defines `key` on `target` as an own enumerable property, never through an assignment: a key
 * read from JSON may be `__proto__`, and an assignment would set the object's prototype instead
 * of a key (the kernel's mirror copies the same way, so both read one shape).
 */
function defineOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, enumerable: true, configurable: true });
}

/** A data grid the normalizer reads: type `dataGrid` with a text id. A grid with any other id (a definition `check` refuses) has no key its rows could live at, and is left as written, as the kernel leaves it. */
function isNormalizableGrid(node: ComponentNode): boolean {
  return isDataGrid(node) && typeof node.id === "string";
}

/** One node of the tree as {@link normalizeDataGrids} reads it: a grid with no binding bound at its id. */
function normalizedNode(node: ComponentNode): ComponentNode {
  if (!isNormalizableGrid(node) || node.collection !== undefined) {
    return node;
  }
  return { ...node, collection: { collectionPath: node.id } };
}

/**
 * Every grid in the tree given a collection binding when it has none (its rows live at its id).
 * Returns the same root object
 * when nothing needed rewriting, so a caller can keep an untouched definition by identity;
 * otherwise a copy that shares every subtree it did not change. Walked with an explicit stack
 * (children before their parent) and no deeper than {@link DATA_GRID_NORMALIZE_DEPTH}, exactly as
 * the sandbox kernel's mirror (`kernelNormalizeDataGrids`) walks it, so a tree of any depth
 * cannot exhaust the call stack and the depth refusal that follows (`compileFormDefinition`) is
 * the one the kernel gives. A child that is not an object and a slot that is not a list are kept
 * as written.
 */
export function normalizeDataGrids(root: ComponentNode): ComponentNode {
  if (root === null || typeof root !== "object") {
    return root;
  }
  interface Frame {
    node: ComponentNode;
    next: ComponentNode;
    level: number;
    into: unknown[];
    at: number;
    open: boolean;
    slots: string[];
    lists: Array<unknown[] | undefined>;
  }
  const holder: unknown[] = [root];
  const stack: Frame[] = [{ node: root, next: root, level: 1, into: holder, at: 0, open: false, slots: [], lists: [] }];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1] as Frame;
    if (!frame.open) {
      frame.open = true;
      frame.next = normalizedNode(frame.node);
      const children: unknown = frame.next.children;
      if (frame.level < DATA_GRID_NORMALIZE_DEPTH && children !== null && typeof children === "object" && !Array.isArray(children)) {
        for (const slotId of Object.keys(children)) {
          const group: unknown = (children as Record<string, unknown>)[slotId];
          frame.slots.push(slotId);
          if (!Array.isArray(group)) {
            frame.lists.push(undefined);
            continue;
          }
          const walked = group.slice();
          frame.lists.push(walked);
          for (let at = walked.length - 1; at >= 0; at -= 1) {
            const child: unknown = walked[at];
            if (child !== null && typeof child === "object") {
              stack.push({ node: child as ComponentNode, next: child as ComponentNode, level: frame.level + 1, into: walked, at, open: false, slots: [], lists: [] });
            }
          }
        }
      }
      continue;
    }
    stack.pop();
    let next = frame.next;
    const children = next.children as Record<string, unknown> | undefined;
    let changed = false;
    for (let s = 0; s < frame.slots.length && !changed; s += 1) {
      const walked = frame.lists[s];
      const group = children !== undefined ? (children[frame.slots[s] as string] as unknown[]) : undefined;
      if (walked !== undefined && group !== undefined) {
        changed = walked.some((child, index) => child !== group[index]);
      }
    }
    if (changed && children !== undefined) {
      const groups: Record<string, unknown> = {};
      for (let s = 0; s < frame.slots.length; s += 1) {
        const slotId = frame.slots[s] as string;
        const walked = frame.lists[s];
        defineOwn(groups, slotId, walked !== undefined ? walked : children[slotId]);
      }
      next = { ...next, children: groups as Record<string, ComponentNode[]> };
    }
    frame.into[frame.at] = next;
  }
  return holder[0] as ComponentNode;
}

/**
 * A grid's row-count bounds once its formulas have spoken: `rules.minRows` and
 * `rules.maxRows` are evaluated form-scoped to a value each (`formula.min`, `formula.max`;
 * absent when the grid has no such rule, the rule reads `row.`, the side does not run it, or it
 * failed). A finite whole number from 0 wins over the fixed bound in `settings`, one past the
 * cap read as the cap; anything else (a fraction, a negative, a text, no answer) leaves the
 * fixed bound in force. A maximum below the resolved minimum reads as the minimum, as the fixed
 * pair does. The browser's orchestrator and the field-constraints stage read it; the sandbox
 * kernel mirrors it (`kernelResolveDataGridRowBounds`), and a test holds the two equal.
 */
export function resolveDataGridRowBounds(
  settings: Pick<DataGridSettings, "minRows" | "maxRows">,
  formula: { min?: unknown; max?: unknown }
): { minRows: number; maxRows: number | undefined } {
  const read = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isInteger(value) && value >= 0
      ? value > DATA_GRID_ROWS_CAP
        ? DATA_GRID_ROWS_CAP
        : value === 0
          ? 0
          : value
      : undefined;
  const minRows = read(formula.min) ?? settings.minRows;
  const max = read(formula.max) ?? settings.maxRows;
  return { minRows, maxRows: max === undefined ? undefined : Math.max(max, minRows) };
}
