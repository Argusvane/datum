/**
 * Documents that hold form content outside the form's tree — a journey catalog, a PDF layout
 * catalog — and the one way a language change reaches them. Their *translations*
 * are not in them: every text a journey or a layout words is a plain string in the default
 * language, and its translations sit in the definition's one map (`translations.ts`, kinds
 * `journeys` and `pdf`). What a document still owns is the default strings, so it lends the
 * controller two things: the texts it holds with their defaults (for the Languages workspace and
 * for Make default, which needs every text's current default), and a writer for new defaults
 * (Make default rewrites them with the map in one undo step, through the form controller's
 * history, so a single Undo takes the tree, the journeys and the layouts back together).
 * The controller does not know their shape; each mode lends an {@link OutsideDocument} that reads
 * and writes its block as the mode's own catalog actions do.
 */

import type { LocalizationConfiguration } from "../schema/types.js";
import { supportedLocaleEntries } from "./supported-locales.js";
import type { TextAddress } from "./translations.js";

/** One text a document holds: where its translations live, and its string in the default language. */
export interface OutsideText {
  address: TextAddress;
  default: string;
}

/** A new default-language string for the text at `address` (what Make default and an edit of the default write). */
export interface OutsideDefaultEdit {
  address: TextAddress;
  default: string;
}

/** A mode's block of the definition that carries default texts outside the form's tree. */
export interface OutsideDocument {
  /** `"journeys"` or `"pdf"`. */
  id: string;
  /** The block as it stands now (undefined: the form has none). */
  read(): unknown;
  /** Replaces the block, reported as the mode's own catalog changes are. */
  write(value: unknown): void;
  /** Every text the block holds, written or not, with its default; the translations are the map's, never read from the block. */
  texts(): OutsideText[];
  /** The block with the default strings of `edits` written (only those whose address is in this document), or the block itself when none lands. */
  setDefaults(value: unknown, edits: readonly OutsideDefaultEdit[]): unknown;
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Structural equality of plain data (JSON-shaped), identical references short-circuited. */
export function sameData(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a)) {
    return Array.isArray(b) && a.length === b.length && a.every((entry, index) => sameData(entry, b[index]));
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameData(a[key], b[key]));
  }
  return false;
}

/** Whether every entry is a plain object with a string `id`, none repeated: an array the change can be matched in by `id`. */
function identified(list: readonly unknown[]): list is Array<Record<string, unknown>> {
  const seen = new Set<unknown>();
  return list.every((entry) => {
    if (!isPlain(entry) || typeof entry.id !== "string" || seen.has(entry.id)) {
      return false;
    }
    seen.add(entry.id);
    return true;
  });
}

/**
 * `current` with a change taken `from` one state `to` another, wherever `current` still
 * stands as `from` did: the rest — what was edited since — is kept. This is how an Undo (or
 * a Redo) puts a journey or a layout back without discarding what the author did to it in
 * its own tab after the language change. A part `current` has changed itself is left as
 * `current` has it, so a translation edited since is not overwritten by the one restored.
 *
 * Lists whose entries carry an `id` (journeys, layouts, pages) are matched by it, so an entry
 * added, removed or moved since is left alone and the ones the change touched still get it.
 * A list without ids is matched by position, and only while its length has not changed.
 */
export function carryChange(current: unknown, from: unknown, to: unknown): unknown {
  if (sameData(current, from)) {
    return to;
  }
  if (Array.isArray(current) && Array.isArray(from) && Array.isArray(to)) {
    if (identified(current) && identified(from) && identified(to)) {
      const was = new Map(from.map((entry) => [entry.id as string, entry]));
      const now = new Map(to.map((entry) => [entry.id as string, entry]));
      const next = current.map((entry) => {
        const id = entry.id as string;
        return was.has(id) && now.has(id) ? carryChange(entry, was.get(id), now.get(id)) : entry;
      });
      return next.some((entry, index) => entry !== current[index]) ? next : current;
    }
    if (current.length === from.length && from.length === to.length) {
      const next = current.map((entry, index) => carryChange(entry, from[index], to[index]));
      return next.some((entry, index) => entry !== current[index]) ? next : current;
    }
    return current;
  }
  if (isPlain(current) && isPlain(from) && isPlain(to)) {
    const next: Record<string, unknown> = { ...current };
    let touched = false;
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      const out = carryChange(Object.hasOwn(current, key) ? current[key] : undefined, Object.hasOwn(from, key) ? from[key] : undefined, Object.hasOwn(to, key) ? to[key] : undefined);
      if (out === next[key] || (out === undefined && !Object.hasOwn(next, key))) {
        continue;
      }
      touched = true;
      if (out === undefined) {
        delete next[key];
      } else {
        next[key] = out;
      }
    }
    return touched ? next : current;
  }
  return current;
}

/** An id-keyed record in a list: what journeys, pages and layouts are. */
export function hasId(value: unknown): value is { id: string } {
  return typeof value === "object" && value !== null && typeof (value as { id?: unknown }).id === "string";
}

/**
 * `list` with the entries a step removed (in `from`, not in `to`) taken out and the ones it
 * added (in `to`, not in `from`) put in, each after the nearest entry before it in `to` that is
 * there; matched by `id`. What {@link carryChange} leaves alone, so an Undo of a removal brings
 * the journey, page or layout back even when the block has been edited since. The
 * Journeys and PDF modes both carry their block's membership through this one helper.
 */
export function carryMembership(list: readonly unknown[], from: readonly unknown[], to: readonly unknown[]): unknown[] {
  const fromIds = new Set(from.filter(hasId).map((entry) => entry.id));
  const toIds = new Set(to.filter(hasId).map((entry) => entry.id));
  const out = list.filter((entry) => !(hasId(entry) && fromIds.has(entry.id) && !toIds.has(entry.id)));
  to.forEach((entry, index) => {
    if (!hasId(entry) || fromIds.has(entry.id) || out.some((held) => hasId(held) && held.id === entry.id)) {
      return;
    }
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const anchor = to[before];
      const found = hasId(anchor) ? out.findIndex((held) => hasId(held) && held.id === anchor.id) : -1;
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    out.splice(at, 0, structuredClone(entry));
  });
  return out;
}

/**
 * `current` (the form's localization as it stands now) with the change a history entry made
 * `from` one localization `to` another carried onto it: a language the entry took out comes
 * back at its place (after the nearest language before it that is still there), one it added
 * goes, a label it changed is changed where the author has not changed it since, and so is the
 * default. A language added after the entry — which is no history step of its own — is kept.
 */
export function carryLocalization(current: LocalizationConfiguration | undefined, from: LocalizationConfiguration | undefined, to: LocalizationConfiguration | undefined): LocalizationConfiguration | undefined {
  const was = new Map(supportedLocaleEntries(from).map((entry) => [entry.code, entry]));
  const now = supportedLocaleEntries(to);
  const next = new Map(now.map((entry) => [entry.code, entry]));
  // Out with what the change took away; a label it set goes in where the author has not set one since.
  const entries = supportedLocaleEntries(current)
    .filter((entry) => !(was.has(entry.code) && !next.has(entry.code)))
    .map((entry) => {
      const before = was.get(entry.code);
      const after = next.get(entry.code);
      return before && after && sameData(entry, before) ? after : entry;
    });
  // In with what the change gave, each right after the nearest language before it that is there.
  now.forEach((entry, index) => {
    if (was.has(entry.code) || entries.some((held) => held.code === entry.code)) {
      return;
    }
    let at = 0;
    for (let before = index - 1; before >= 0; before -= 1) {
      const found = entries.findIndex((held) => held.code === now[before]!.code);
      if (found >= 0) {
        at = found + 1;
        break;
      }
    }
    entries.splice(at, 0, entry);
  });
  const result: LocalizationConfiguration = { ...current, supportedLocales: entries };
  const defaultLocale = current?.defaultLocale === from?.defaultLocale ? to?.defaultLocale : current?.defaultLocale;
  if (defaultLocale === undefined) {
    delete result.defaultLocale;
  } else {
    result.defaultLocale = defaultLocale;
  }
  return result;
}

/** Writes `value` at the dotted `path` below `target`, making the objects on the way; a numeric part indexes an array. */
export function setPathValue(target: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".").filter(Boolean);
  const last = parts.pop();
  if (last === undefined) {
    return;
  }
  // A path that names a prototype would write through Object.prototype.
  if ([...parts, last].some((part) => part === "__proto__" || part === "constructor" || part === "prototype")) {
    return;
  }
  let cursor: Record<string, unknown> | unknown[] = target;
  for (const part of parts) {
    const slot = cursor as Record<string, unknown>;
    if (!isPlain(slot[part]) && !Array.isArray(slot[part])) {
      slot[part] = {};
    }
    cursor = slot[part] as Record<string, unknown> | unknown[];
  }
  (cursor as Record<string, unknown>)[last] = value;
}
