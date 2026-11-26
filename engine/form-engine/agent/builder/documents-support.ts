/**
 * Pure helpers of the `documents` and `remove_part` bodies, imported only by `agentpart-documents.ts`, so they land in its chunk
 * (`datum-builder-agentpart-documents-*.js`).
 *
 * A language's removal is stated here with the controller's own arithmetic
 * (`builder/controller/language-edits.ts`: `withLanguageRemoved`, `defaultAfterRemoval`), a
 * pure module small enough to ship with the documents body, so the tool says what the
 * controller's `localizationActions.removeLocale` will leave.
 *
 * Nothing here runs at import time, keeps state or touches the DOM.
 */
import { defaultAfterRemoval, withLanguageRemoved } from "../../builder/controller/language-edits.js";
import type { JourneyConfiguration } from "../../core/schema/journey.js";
import type { PdfConfiguration } from "../../core/schema/pdf-layout.js";

/** Which designer a document belongs to, in the shell's words (`selectDocument`, the journal). */
export type DocumentSide = "journeys" | "pdf";

/** The declared default keys of each side's catalog (the outside journal reads the same ones). */
const DEFAULT_KEYS: Readonly<Record<DocumentSide, readonly string[]>> = {
  journeys: ["defaultJourneyId", "opensAs"],
  pdf: ["defaultLayoutId"]
};

/** The declared default of a catalog as written: a key present only when the configuration declares it. */
export function declaredDefaults(side: DocumentSide, configuration: JourneyConfiguration | PdfConfiguration | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const record = (configuration ?? {}) as Record<string, unknown>;
  for (const key of DEFAULT_KEYS[side]) {
    if (Object.prototype.hasOwnProperty.call(record, key) && record[key] !== undefined) {
      out[key] = record[key];
    }
  }
  return out;
}

/** `next` with the declared default put back exactly as `defaults` holds it (a key absent there is deleted). */
export function withDefaults(side: DocumentSide, next: Record<string, unknown>, defaults: Record<string, unknown>): void {
  for (const key of DEFAULT_KEYS[side]) {
    if (Object.prototype.hasOwnProperty.call(defaults, key) && defaults[key] !== undefined) {
      next[key] = defaults[key];
    } else {
      delete next[key];
    }
  }
}

/** A place in a list of `length`, clamped (a non-finite index goes last). */
export function clampIndex(index: number, length: number): number {
  return Math.max(0, Math.min(Number.isFinite(index) ? Math.trunc(index) : length, length));
}

/** JSON with object keys sorted, so two reads of the same value compare equal. "" when it cannot be written. */
export function canonicalJson(value: unknown): string {
  const sort = (input: unknown): unknown => {
    if (Array.isArray(input)) {
      return input.map(sort);
    }
    if (typeof input !== "object" || input === null) {
      return input;
    }
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(input as Record<string, unknown>).sort()) {
      const inner = (input as Record<string, unknown>)[key];
      if (inner !== undefined) {
        out[key] = sort(inner);
      }
    }
    return out;
  };
  try {
    return JSON.stringify(sort(value) ?? null);
  } catch {
    return "";
  }
}

/**
 * An answer someone gave: not empty, not a record of unticked choices. The try body's rule
 * (`try-fields.ts` `nonEmpty`), so both bodies count Try it's typed answers alike.
 */
export function nonEmptyAnswer(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return false;
  }
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  if (typeof value === "number") {
    return !Number.isNaN(value);
  }
  if (typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((inner) => inner === true || (inner !== false && nonEmptyAnswer(inner)));
  }
  return true;
}

/** A deep copy of plain data. */
export function copyOf<T>(value: T): T {
  return value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
}

/**
 * `work`'s value, or `undefined` when `ms` pass first (the caller words its own timeout). A
 * rejection passes through. The timer goes when either settles.
 */
export function within<T>(work: Promise<T>, ms: number): Promise<{ value: T } | undefined> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(undefined), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve({ value });
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/**
 * The localization without `code`: the language leaves the list, and a default that goes follows to
 * the first language left (or goes when none is left). The controller's own arithmetic, so the
 * tool states what the removal will leave.
 */
export const localizationWithout = withLanguageRemoved;

/** The language the form starts in once `code` is removed: undefined when the default does not change, or none is left. */
export const defaultAfterRemoving = defaultAfterRemoval;
