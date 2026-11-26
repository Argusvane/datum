import type { ComponentNode } from "./types.js";

/** Component type of the multi-column layout container. */
export const GRID_COMPONENT_TYPE = "grid";

/** Column count a `grid` has when `configuration.columns` is absent or unusable. */
export const DEFAULT_GRID_COLUMNS = 2;

/** Tracks in a sized grid's row: authored column spans are out of this many. */
export const GRID_TRACK_COUNT = 12;

/**
 * The most columns a grid reads from its configuration, whichever form it is written in: an
 * equal-column count or a span list. It is the track count, so a sized grid and an equal one
 * top out together. A definition is untrusted input, and every slot is a child map entry and a
 * drawn cell in each surface that reads the list; children kept in a column past the cap are
 * not lost, they trail as undeclared slots and fold into the last column on the next edit.
 */
export const GRID_MAX_COLUMNS = GRID_TRACK_COUNT;

/**
 * A grid's columns are its child slots: `column_1` … `column_N`, one per configured column.
 *
 * An author reaching for a grid expects to drop into a specific column, leave a column empty,
 * and stack two components in the same column. With a slot per column each of those is just a
 * slot address — the same `{ parentId, slotId }` every other container is edited through, and a
 * column's children stack the way a stack container's do.
 *
 * The slot list is a function of `configuration.columns` rather than a static declaration on
 * the component definition (the way a `tabs` container's slots follow `configuration.tabs`),
 * so changing the columns changes the slots, and the canvas shows a drop target for a new
 * column the moment it is configured.
 */

/**
 * What `configuration.columns` says about a grid's columns: how many, and — when they are
 * not all the same width — the span each takes of a {@link GRID_TRACK_COUNT}-track row.
 */
export interface GridColumnSpec {
  count: number;
  /** One span per column, left to right; absent for equal columns. */
  spans: number[] | undefined;
}

function clampColumnCount(value: number): number {
  if (!Number.isFinite(value)) {
    return DEFAULT_GRID_COLUMNS;
  }
  // A count below one is not a grid; `Math.floor` because a slot id has no fractional part.
  return Math.min(GRID_MAX_COLUMNS, Math.max(1, Math.floor(value)));
}

/**
 * Reads `configuration.columns`, which is one property doing two jobs so that an author never
 * has to keep a count and a width list in step:
 *
 * - A count — `3`, or `"3"` as the builder's text box stores it — gives that many equal
 *   columns.
 * - A span list — `"8/4"`, `"3 / 6 / 3"`, `[8, 4]` — sizes the columns on a twelve-track row
 *   and implies their number: two spans, two columns. Equal spans (`"6/6"`, `"4/4/4"`) are
 *   simply equal columns, so they lay out and wrap exactly as the counts `2` and `3` do
 *   rather than taking the fixed-track path a sized grid needs.
 *
 * Either form stops at {@link GRID_MAX_COLUMNS} columns: a larger count is cut to it and a longer
 * span list is read up to its twelfth entry.
 *
 * Anything else — blank, a word, a span outside 1..12 — falls back to the default count with
 * equal columns, so a half-typed value never leaves a grid with no columns to drop into.
 */
export function readGridColumnSpec(configuration: unknown): GridColumnSpec {
  const equal = (count: number): GridColumnSpec => ({ count, spans: undefined });
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) {
    return equal(DEFAULT_GRID_COLUMNS);
  }
  const raw = (configuration as { columns?: unknown }).columns;
  if (typeof raw === "number") {
    return equal(clampColumnCount(raw));
  }
  if (typeof raw === "string" && /^\s*\d+\s*$/.test(raw)) {
    return equal(clampColumnCount(Number(raw)));
  }
  const spans = parseGridColumnWidths(raw);
  if (!spans) {
    return equal(DEFAULT_GRID_COLUMNS);
  }
  return spans.every((span) => span === spans[0])
    ? equal(spans.length)
    : { count: spans.length, spans };
}

/** How many columns a grid has — see {@link readGridColumnSpec}. */
export function readGridColumnCount(configuration: unknown): number {
  return readGridColumnSpec(configuration).count;
}

/**
 * The spans a grid's columns render with, or `undefined` for equal columns — see
 * {@link readGridColumnSpec}.
 */
export function readGridColumnWidths(configuration: unknown): number[] | undefined {
  return readGridColumnSpec(configuration).spans;
}

/** The slot id of the `index`-th column, 1-based — `column_1` is the leftmost. */
export function gridColumnSlotId(index: number): string {
  return `column_${index}`;
}

/** The slot ids a grid declares through its configuration, left to right. */
export function gridColumnSlotIds(configuration: unknown): string[] {
  const count = readGridColumnCount(configuration);
  const out: string[] = [];
  for (let index = 1; index <= count; index += 1) {
    out.push(gridColumnSlotId(index));
  }
  return out;
}

/** An empty children map with one key per column, for a freshly created grid. */
export function emptyGridChildren(configuration: unknown): Record<string, ComponentNode[]> {
  return Object.fromEntries(gridColumnSlotIds(configuration).map((slotId) => [slotId, []]));
}

/**
 * A span list as authored — `[6, 4, 2]`, or the text form `"6,4,2"` the builder's one-line
 * editor stores (`/` and spaces work too, so "6 / 4 / 2" reads as it is said). Each entry is
 * a span of 1..{@link GRID_TRACK_COUNT} tracks, floored; anything else, or an empty list, is
 * not a span list at all.
 */
export function parseGridColumnWidths(raw: unknown): number[] | undefined {
  // Only the first GRID_MAX_COLUMNS entries are read, so a list of any length costs the same.
  const entries: unknown[] | undefined = Array.isArray(raw)
    ? raw.slice(0, GRID_MAX_COLUMNS)
    : typeof raw === "string"
      ? raw
          .split(/[\s,/]+/)
          .filter((part) => part.length > 0)
          .slice(0, GRID_MAX_COLUMNS)
          .map((part) => Number(part))
      : undefined;
  if (!entries || entries.length === 0) {
    return undefined;
  }
  const widths: number[] = [];
  for (const entry of entries) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      return undefined;
    }
    const span = Math.floor(entry);
    if (span < 1 || span > GRID_TRACK_COUNT) {
      return undefined;
    }
    widths.push(span);
  }
  return widths;
}

/** The text form of a span list, as the builder shows it and the markup reports it. */
export function formatGridColumnWidths(widths: readonly number[]): string {
  return widths.join(",");
}

/**
 * Re-files children left in slots the grid does not declare — a column removed when the
 * count was reduced, or any other slot id — into the last remaining column, after whatever is
 * already there.
 *
 * Returns `undefined` when every occupied slot is a declared column and there is nothing to
 * do, so a caller can skip recording an edit. Nothing is ever dropped: reducing a grid from
 * three columns to two moves the third column's fields rather than losing them, and the
 * author can drag them elsewhere from there.
 */
export function foldGridChildrenIntoColumns(
  children: Record<string, ComponentNode[]> | undefined,
  columnIds: readonly string[]
): Record<string, ComponentNode[]> | undefined {
  const lastColumn = columnIds[columnIds.length - 1];
  if (!children || lastColumn === undefined) {
    return undefined;
  }
  const declared = new Set(columnIds);
  const stray = Object.keys(children).filter((slotId) => !declared.has(slotId));
  if (stray.length === 0) {
    return undefined;
  }
  const next: Record<string, ComponentNode[]> = {};
  for (const slotId of columnIds) {
    next[slotId] = [...(children[slotId] ?? [])];
  }
  for (const slotId of stray) {
    next[lastColumn]!.push(...(children[slotId] ?? []));
  }
  return next;
}
