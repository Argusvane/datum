/**
 * The agent change journal and its replay. Every write the
 * agent makes through `set_answers` or `edit_rows` leaves an entry with its pre-image, so
 * `undo_agent_changes`, Stop and `end_session { undo: true }` can put the person's answers
 * back: a value whose current reading still equals what the agent wrote is restored, one the
 * person edited since is kept and named, a row the agent added is removed while nobody typed
 * in it, a row the agent removed is appended and moved back. The journal lives in memory only
 * (never in a draft), holds 200 entries, and is cleared by an accepted submit and by a restored
 * draft.
 *
 * Values are read through {@link valueAt}, so a journey
 * presentation's own answer (an `@` key, which `formValues()` leaves out) has a real pre- and
 * post-image; and every entry records `writersBefore`, the last-writer marks of the paths it
 * touched as they were before the write, which the replay puts back, so a value restored to the
 * person's is the person's again.
 */

import type { CollectionOperations } from "../../core/schema/collection.js";
import type { FormRuntime } from "../../runtime/browser/form-runtime.js";

export type Writer = "agent" | "other";

/**
 * The last-writer marks of the paths an entry touches, as they stood before the write: `null` for a path that carried no mark. Absent on an entry made without it (the
 * replay then leaves the marks as its own writes set them).
 */
export type WritersBefore = Record<string, Writer | null>;

export type JournalEntry =
  | {
      seq: number;
      call: number;
      at: number;
      session?: string;
      kind: "values";
      tool: "set_answers" | "edit_rows" | "undo_agent_changes";
      before: Record<string, unknown>;
      after: Record<string, unknown>;
      writersBefore?: WritersBefore;
    }
  | { seq: number; call: number; at: number; session?: string; kind: "rows-added"; collection: string; indexes: number[]; writersBefore?: WritersBefore }
  | {
      seq: number;
      call: number;
      at: number;
      session?: string;
      kind: "row-removed";
      collection: string;
      index: number;
      values: Record<string, unknown>;
      writersBefore?: WritersBefore;
    }
  | {
      seq: number;
      call: number;
      at: number;
      session?: string;
      kind: "rows-replaced";
      /** `undo_agent_changes` when the entry records a table an undo put back (so `last` can undo the undo). */
      tool: "set_answers" | "undo_agent_changes";
      collection: string;
      before: Record<string, unknown>[];
      after: Record<string, unknown>[];
      writersBefore?: WritersBefore;
    };

/**
 * Every stored answer, own `@` keys included (a copy of the runtime state's values): what
 * {@link valueAt} reads, taken once before a write and once after.
 */
export function storedValues(runtime: FormRuntime): Record<string, unknown> {
  return { ...(runtime.state().values as Record<string, unknown>) };
}

/**
 * The stored answer at a value path: read from the runtime state's
 * values, which hold a journey presentation's own answers under their `@` keys too, where the
 * flat `formValues()` strips them (for every other path the two agree). `undefined` when nothing
 * is stored there. Pass a `storedValues()` snapshot to read the moment it was taken.
 */
export function valueAt(runtime: FormRuntime, path: string, stored: Record<string, unknown> = storedValues(runtime)): unknown {
  return Object.prototype.hasOwnProperty.call(stored, path) ? stored[path] : undefined;
}

/** The marks of `paths` as they stand now (`null` for none): an entry's `writersBefore`. */
export function writersOf(lastWriter: ReadonlyMap<string, Writer>, paths: Iterable<string>): WritersBefore {
  const out: WritersBefore = {};
  for (const path of paths) {
    out[path] = lastWriter.get(path) ?? null;
  }
  return out;
}

/** The marks of a collection and of every cell of it now: a table write's `writersBefore`. */
export function tableWritersOf(lastWriter: ReadonlyMap<string, Writer>, collection: string): WritersBefore {
  const out: WritersBefore = { [collection]: lastWriter.get(collection) ?? null };
  const prefix = `${collection}[`;
  for (const [path, by] of lastWriter) {
    if (path.startsWith(prefix)) {
      out[path] = by;
    }
  }
  return out;
}

/** Puts one recorded mark back: `null` (or no record) removes the path's mark. */
function putWriter(lastWriter: Map<string, Writer>, path: string, by: Writer | null | undefined): void {
  if (by === "agent" || by === "other") {
    lastWriter.set(path, by);
  } else {
    lastWriter.delete(path);
  }
}

export const JOURNAL_CAP = 200;

/** Whether an entry records an undo's own restore (a `values` or `rows-replaced` entry of `undo_agent_changes`). */
export function isUndoEntry(entry: JournalEntry): boolean {
  return (entry.kind === "values" || entry.kind === "rows-replaced") && entry.tool === "undo_agent_changes";
}

/** `Omit` distributed over the entry union, so each kind keeps its own keys. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type JournalInput = DistributiveOmit<JournalEntry, "seq">;

export interface Journal {
  entries: JournalEntry[];
  /** The next entry's sequence number; a session's undo boundary is the value at `begin`. */
  nextSeq: number;
  /** The next write call's number; `scope: "last"` undoes the entries of the highest one. */
  nextCall: number;
}

export function createJournal(): Journal {
  return { entries: [], nextSeq: 0, nextCall: 1 };
}

/** Appends an entry, dropping the oldest past the cap. */
export function record(journal: Journal, entry: JournalInput): JournalEntry {
  const full = { ...entry, seq: journal.nextSeq } as JournalEntry;
  journal.nextSeq += 1;
  journal.entries.push(full);
  if (journal.entries.length > JOURNAL_CAP) {
    journal.entries.splice(0, journal.entries.length - JOURNAL_CAP);
  }
  return full;
}

export type UndoScope = "session" | "all" | "last";

/**
 * The entries a scope covers, newest first. `last` is the most recent write call, an undo
 * included (so an undo can be undone); `session` and `all` restore the agent's writes alone, so an
 * earlier undo's own entry is not replayed back over the person's answers. `until` closes the
 * session scope at the seq the session ended with (the summary banner's Undo all, undoes
 * what the session did and nothing the agent wrote after it).
 */
export function entriesInScope(journal: Journal, scope: UndoScope, boundary: number | undefined, until?: number): JournalEntry[] {
  let picked = journal.entries;
  if (scope === "last") {
    const last = picked.reduce((max, entry) => Math.max(max, entry.call), -1);
    picked = picked.filter((entry) => entry.call === last);
  } else {
    picked = picked.filter((entry) => !isUndoEntry(entry));
    if (scope === "session") {
      picked = picked.filter((entry) => boundary !== undefined && entry.seq >= boundary && (until === undefined || entry.seq < until));
    }
  }
  return [...picked].reverse();
}

/**
 * Moves a collection's per-cell last-writer marks when the agent's own row operation shifts the
 * indexes: a mark is keyed by its cell path, so after `removeRow(c, 1)` the mark of
 * `c[2].x` must become `c[1].x`. `remap` gives the new index of a row, or `undefined` for a row
 * that is gone. Only the agent's operations remap; a person's reshape marks the rows theirs (see
 * the bus handler in tools.ts).
 */
export function remapCellMarks(marks: Map<string, Writer>, collection: string, remap: (index: number) => number | undefined): void {
  const prefix = `${collection}[`;
  const moved: Array<[string, Writer]> = [];
  for (const [path, by] of [...marks.entries()]) {
    if (!path.startsWith(prefix)) {
      continue;
    }
    const match = /^\[(\d+)\](\..+)$/u.exec(path.slice(collection.length));
    if (match === null) {
      continue;
    }
    marks.delete(path);
    const next = remap(Number(match[1]));
    if (next !== undefined) {
      moved.push([`${collection}[${next}]${match[2] as string}`, by]);
    }
  }
  for (const [path, by] of moved) {
    marks.set(path, by);
  }
}

/** The index map after the row at `removed` left: rows above it move down by one. */
export function afterRowRemoved(removed: number): (index: number) => number | undefined {
  return (index) => (index === removed ? undefined : index > removed ? index - 1 : index);
}

/** The index map after the row at `from` moved to `to` (the runtime's `reorderRow`). */
export function afterRowMoved(from: number, to: number): (index: number) => number | undefined {
  return (index) => {
    if (index === from) {
      return to;
    }
    if (from < to && index > from && index <= to) {
      return index - 1;
    }
    if (to < from && index >= to && index < from) {
      return index + 1;
    }
    return index;
  };
}

/** Whether an entry touches one of `paths` (a collection path covers its rows). */
export function entryTouches(entry: JournalEntry, paths: ReadonlySet<string>): boolean {
  if (entry.kind === "values") {
    return Object.keys(entry.after).some((path) => paths.has(path) || [...paths].some((wanted) => path.startsWith(`${wanted}[`)));
  }
  return paths.has(entry.collection);
}

export type KeptReason = "person-edited" | "field-in-use" | "rows-not-addable" | "rows-not-removable" | "not-restorable";

export interface Kept {
  path?: string;
  collection?: string;
  index?: number;
  reason: KeptReason;
}

export interface ReplayOutcome {
  restored: { path: string; value: unknown }[];
  rowsRemoved: { collection: string; index: number }[];
  rowsRestored: { collection: string; index: number }[];
  kept: Kept[];
  undoneCalls: number;
  /** The paths the replay changed, for the highlight and the announcement. */
  touched: string[];
}

export interface ReplayContext {
  runtime: FormRuntime;
  /** The catalogue's last-writer map; the replay remaps its cell marks after its own row operations. */
  lastWriter: Map<string, Writer>;
  /** The caret path the person is typing in, when any and outside a session. */
  focused: string | undefined;
  /**
   * Per collection, the journal seq at the person's last reshape (a remove, reorder or replace
   * of theirs): a `rows-added` entry older than it carries indexes the reshape made stale, so
   * the row found there is kept as the person's.
   */
  reshapedAt: ReadonlyMap<string, number>;
  /** Whether the runtime knows a path (a field, or a cell of a registered collection). */
  knows(path: string): boolean;
  /**
   * Whether a path is a worked-out target of the running presentation: a form field the overlay recomputes from the page's own fields on every write, which
   * nobody edits directly.
   */
  workedOut(path: string): boolean;
  operationsOf(collection: string): Required<CollectionOperations> | undefined;
  maxRowsOf(collection: string): number | undefined;
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return Number.isNaN(a as number) && Number.isNaN(b as number);
  }
  if (Array.isArray(a) !== Array.isArray(b)) {
    return false;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => deepEqual(item, b[index]));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  for (const key of keys) {
    if (!deepEqual(left[key], right[key])) {
      return false;
    }
  }
  return true;
}

function cellsOf(row: Record<string, unknown>): Array<[string, unknown]> {
  return Object.entries(row).filter(([, value]) => value !== undefined && value !== null && value !== "");
}

/**
 * Whether a row holds something the person typed (a row the agent added is removed "only
 * while every non-empty cell's last writer is agent"). A non-empty cell with no mark of its own
 * is the person's: the catalogue marks every cell it fills itself, so an unmarked cell was
 * hydrated before the catalogue subscribed (a draft, a host prefill) or typed by the person. The
 * guard fails safe, never open.
 */
export function rowTypedByPerson(lastWriter: ReadonlyMap<string, Writer>, collection: string, index: number, row: Record<string, unknown>): boolean {
  return cellsOf(row).some(([key]) => lastWriter.get(`${collection}[${index}].${key}`) !== "agent");
}

/** Marks every non-empty cell of `rows` as the agent's: what a whole-table write of its own leaves behind. */
export function markRowsAgent(lastWriter: Map<string, Writer>, collection: string, rows: readonly Record<string, unknown>[]): void {
  rows.forEach((row, index) => {
    for (const [key] of cellsOf(row)) {
      lastWriter.set(`${collection}[${index}].${key}`, "agent");
    }
  });
}

/**
 * Replays `entries` (newest first) through the runtime, one `setValues` per entry.
 * Replayed entries leave the journal, an entry only partly restorable too (its kept
 * paths are reported, the person's value stands), with one exception: a `values` entry whose
 * paths were left out for `field-in-use` (the caret is in the control, the agent's value still
 * stands) or by the `paths` filter (never considered) is narrowed to those paths and stays on
 * record, so a later undo, Stop or Undo all can still put the person's value back. Never throws:
 * a runtime refusal of a row operation becomes a `kept` entry.
 */
export function replay(journal: Journal, entries: readonly JournalEntry[], context: ReplayContext, filter?: ReadonlySet<string>): ReplayOutcome {
  const outcome: ReplayOutcome = { restored: [], rowsRemoved: [], rowsRestored: [], kept: [], undoneCalls: 0, touched: [] };
  const calls = new Set<number>();
  const { runtime } = context;
  for (const entry of entries) {
    if (filter !== undefined && !entryTouches(entry, filter)) {
      continue;
    }
    calls.add(entry.call);
    // The paths of a values entry that stay on record after this pass (see the docblock).
    const pending: string[] = [];
    if (entry.kind === "values") {
      const values = storedValues(runtime);
      const batch: Record<string, unknown> = {};
      for (const [path, after] of Object.entries(entry.after)) {
        if (filter !== undefined && !filter.has(path) && ![...filter].some((wanted) => path.startsWith(`${wanted}[`))) {
          pending.push(path);
          continue;
        }
        // An own answer of a journey presentation (an `@` key) is read from the state.
        const current = valueAt(runtime, path, values);
        if (context.focused !== undefined && context.focused === path) {
          outcome.kept.push({ path, reason: "field-in-use" });
          pending.push(path);
          continue;
        }
        if (!context.knows(path)) {
          outcome.kept.push({ path, reason: "not-restorable" });
          continue;
        }
        if (!deepEqual(current, after)) {
          // A worked-out target journaled with its own fields that moved since was recomputed
          // by the overlay from the person's edit of a source, not edited by them: it is neither
          // restored nor kept here, and follows whatever its sources are left as by this pass.
          if (!context.workedOut(path)) {
            outcome.kept.push({ path, reason: "person-edited" });
          }
          continue;
        }
        batch[path] = Object.prototype.hasOwnProperty.call(entry.before, path) ? entry.before[path] : undefined;
      }
      const paths = Object.keys(batch);
      if (paths.length > 0) {
        const failed = runtime.setValues(batch);
        const failedPaths = new Set(failed.map((failure) => failure.path));
        for (const path of paths) {
          if (failedPaths.has(path)) {
            outcome.kept.push({ path, reason: "not-restorable" });
          } else {
            outcome.restored.push({ path, value: batch[path] === undefined ? null : batch[path] });
            outcome.touched.push(path);
            // The value is back, and so is whoever wrote it: the person's again when it was theirs.
            if (entry.writersBefore !== undefined) {
              putWriter(context.lastWriter, path, entry.writersBefore[path]);
            }
          }
        }
      }
    } else if (entry.kind === "rows-added") {
      const operations = context.operationsOf(entry.collection);
      // The person-typed verdict of every row is taken before the first removal: a removal shifts
      // the rows above it and remaps their marks, so the loop must not read marks it is moving.
      const rowsNow = runtime.rows(entry.collection) as Record<string, unknown>[];
      const typedAt = new Map(entry.indexes.map((index) => [index, index < rowsNow.length && rowTypedByPerson(context.lastWriter, entry.collection, index, rowsNow[index] as Record<string, unknown>)]));
      // The person's reshape since the entry made its indexes stale and the table theirs:
      // the row found at a stale index is kept, an empty row they added included.
      const reshaped = context.reshapedAt.get(entry.collection);
      const stale = reshaped !== undefined && entry.seq < reshaped;
      for (const index of [...entry.indexes].sort((a, b) => b - a)) {
        if (index >= rowsNow.length) {
          continue;
        }
        if (operations?.remove === false) {
          outcome.kept.push({ collection: entry.collection, index, reason: "rows-not-removable" });
          continue;
        }
        if (typedAt.get(index) === true || stale) {
          outcome.kept.push({ collection: entry.collection, index, reason: "person-edited" });
          continue;
        }
        try {
          runtime.removeRow(entry.collection, index);
          remapCellMarks(context.lastWriter, entry.collection, afterRowRemoved(index));
          outcome.rowsRemoved.push({ collection: entry.collection, index });
          outcome.touched.push(entry.collection);
        } catch {
          outcome.kept.push({ collection: entry.collection, index, reason: "rows-not-removable" });
        }
      }
      if (entry.writersBefore !== undefined && outcome.rowsRemoved.some((removed) => removed.collection === entry.collection)) {
        putWriter(context.lastWriter, entry.collection, entry.writersBefore[entry.collection]);
      }
    } else if (entry.kind === "row-removed") {
      const operations = context.operationsOf(entry.collection);
      const rows = runtime.rows(entry.collection).length;
      const max = context.maxRowsOf(entry.collection);
      if (operations?.add === false || (max !== undefined && rows + 1 > max)) {
        outcome.kept.push({ collection: entry.collection, index: entry.index, reason: "rows-not-addable" });
        continue;
      }
      try {
        let index = runtime.addRow(entry.collection, entry.values);
        if (operations?.reorder === true && entry.index < index) {
          runtime.reorderRow(entry.collection, index, entry.index);
          remapCellMarks(context.lastWriter, entry.collection, afterRowMoved(index, entry.index));
          index = entry.index;
        }
        if (entry.writersBefore !== undefined) {
          // The row's cells carry the marks they had when the agent removed it, at the index it
          // landed on; the table's own mark goes back to its writer before the removal.
          const removedAt = `${entry.collection}[${entry.index}].`;
          for (const [path, by] of Object.entries(entry.writersBefore)) {
            if (path.startsWith(removedAt)) {
              putWriter(context.lastWriter, `${entry.collection}[${index}].${path.slice(removedAt.length)}`, by);
            }
          }
          putWriter(context.lastWriter, entry.collection, entry.writersBefore[entry.collection]);
        }
        outcome.rowsRestored.push({ collection: entry.collection, index });
        outcome.touched.push(entry.collection);
      } catch {
        outcome.kept.push({ collection: entry.collection, index: entry.index, reason: "rows-not-addable" });
      }
    } else {
      // The table goes back whole only while no cell has a later write of the person's:
      // a cell marked `other`, or a non-empty cell the catalogue did not mark itself. An undo's
      // own entry (a table an undo put back, so `last` can undo the undo) is judged by its rows
      // instead: the undo gave the cells back to their writers (`writersBefore`), the person's
      // included, so their marks cannot tell a later edit from the restore; the table is the
      // agent's to put back while its rows are exactly what that undo left.
      const rows = runtime.rows(entry.collection) as Record<string, unknown>[];
      const edited =
        entry.tool === "undo_agent_changes" && entry.writersBefore !== undefined
          ? !deepEqual(rows, entry.after)
          : [...context.lastWriter.entries()].some(([path, by]) => by === "other" && path.startsWith(`${entry.collection}[`)) ||
            rows.some((row, index) => rowTypedByPerson(context.lastWriter, entry.collection, index, row));
      if (edited) {
        outcome.kept.push({ collection: entry.collection, reason: "person-edited" });
      } else {
        const failed = runtime.setValues({ [entry.collection]: entry.before });
        if (failed.length > 0) {
          outcome.kept.push({ collection: entry.collection, reason: "not-restorable" });
        } else {
          if (entry.writersBefore !== undefined) {
            // The table and its cells go back to the writers they had before the write:
            // the person's rows are theirs again, so an undo of this undo keeps them.
            const prefix = `${entry.collection}[`;
            for (const path of [...context.lastWriter.keys()]) {
              if (path.startsWith(prefix)) {
                context.lastWriter.delete(path);
              }
            }
            for (const [path, by] of Object.entries(entry.writersBefore)) {
              putWriter(context.lastWriter, path, by);
            }
          } else {
            // The runtime reports the replace at the collection path alone, so the
            // cells this restore filled are marked here, as set_answers marks its own: an undo of
            // the undo (`scope: "last"`) finds the table still the agent's and puts its rows back.
            markRowsAgent(context.lastWriter, entry.collection, entry.before);
          }
          outcome.restored.push({ path: entry.collection, value: entry.before });
          outcome.touched.push(entry.collection);
        }
      }
    }
    const at = journal.entries.indexOf(entry);
    if (at >= 0) {
      if (entry.kind === "values" && pending.length > 0) {
        const keep = new Set(pending);
        const pick = (values: Record<string, unknown>): Record<string, unknown> => Object.fromEntries(Object.entries(values).filter(([path]) => keep.has(path)));
        journal.entries[at] = { ...entry, before: pick(entry.before), after: pick(entry.after) };
      } else {
        journal.entries.splice(at, 1);
      }
    }
  }
  outcome.undoneCalls = calls.size;
  return outcome;
}
