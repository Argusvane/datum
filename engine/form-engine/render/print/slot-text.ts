/**
 * A printed form's header and footer slots (`configuration.print.header.start` and the rest): a
 * line of literal text with `{{placeholders}}`, resolved into what the page box draws. Paths
 * only, never formulas, and only a string or a finite number prints; every value is plain text
 * (answers, the host's receipt and context are the person's or the host's, never markup).
 *
 * The names a slot reads, one resolver for all of them:
 * - `title`: the form's title in the print's locale; `date`: the day of printing in its words.
 * - `page` and `pages` (and `pageNumber`, `pageCount`, as a PDF's template text spells them):
 *   the page counters, which only the printer knows.
 * - `receipt.<path>`: the host's receipt (`FormNotice.data`); it shadows a field stored at `receipt`.
 * - `host.<path>`: the host's context, as the rules read it.
 * - anything else: a field's value path in the form scope a rule reads (`kernelExprReadScopedPath`).
 */
import { scanPlaceholders } from "../../core/text/placeholders.js";
import { kernelExprReadNested, kernelExprReadScopedPath } from "../../rules/evaluator/evaluator.js";

/** What a margin box draws: literal text, or one of the page counters. */
export type PrintSlotPiece = { text: string } | { counter: "page" | "pages" };

/** What a slot's placeholders read. */
export interface PrintSlotScope {
  /** The form's title, worded; absent when it has none. */
  title?: string | undefined;
  /** The day of printing, worded for the print's locale. */
  date: string;
  /** The answers, keyed by value path. */
  values: Readonly<Record<string, unknown>>;
  /** What `host.` reads. */
  hostContext?: Readonly<Record<string, unknown>> | undefined;
  /** What `receipt.` reads: the host's receipt data. */
  receipt?: Readonly<Record<string, unknown>> | undefined;
}

const COUNTERS: ReadonlyMap<string, "page" | "pages"> = new Map([
  ["page", "page"],
  ["pageNumber", "page"],
  ["pages", "pages"],
  ["pageCount", "pages"]
]);

/** A value as slot text: a string as it is, a finite number in digits, anything else nothing. */
function slotTextOf(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return "";
}

function valueAt(path: string, scope: PrintSlotScope): unknown {
  if (path === "title") {
    return scope.title;
  }
  if (path === "date") {
    return scope.date;
  }
  if (path === "receipt" || path.startsWith("receipt.")) {
    return kernelExprReadNested(scope.receipt ?? {}, path.slice("receipt.".length));
  }
  return kernelExprReadScopedPath(path, { values: scope.values as Record<string, unknown>, ...(scope.hostContext ? { hostContext: scope.hostContext as Record<string, unknown> } : {}) });
}

/**
 * The pieces `template` prints, adjacent text joined; `undefined` when it prints nothing. A slot
 * with no placeholders prints its own text (and nothing when that is only whitespace). A slot
 * with placeholders is left off the page when every value placeholder (everything but the page
 * counters) is empty, whatever words surround them: "Reference {{receipt.reference}}" prints
 * nothing until a receipt exists. A page counter is a value only the printer knows, so a slot that
 * holds one always prints.
 */
export function resolvePrintSlot(template: string, scope: PrintSlotScope): PrintSlotPiece[] | undefined {
  const pieces: PrintSlotPiece[] = [];
  const pushText = (text: string): void => {
    if (text.length === 0) {
      return;
    }
    const last = pieces[pieces.length - 1];
    if (last && "text" in last) {
      last.text += text;
    } else {
      pieces.push({ text });
    }
  };
  let placeholders = 0;
  let counters = 0;
  let valued = 0;
  for (const piece of scanPlaceholders(typeof template === "string" ? template : "")) {
    if ("text" in piece) {
      pushText(piece.text);
      continue;
    }
    placeholders += 1;
    const counter = COUNTERS.get(piece.path);
    if (counter !== undefined) {
      counters += 1;
      pieces.push({ counter });
      continue;
    }
    const text = slotTextOf(valueAt(piece.path, scope));
    if (text.trim() !== "") {
      valued += 1;
    }
    pushText(text);
  }
  const prints =
    placeholders === 0 ? pieces.some((piece) => "text" in piece && piece.text.trim() !== "") : counters > 0 || valued > 0;
  return prints ? pieces : undefined;
}

/** The calendar day where the code runs, `YYYY-MM-DD` (never the UTC day `toISOString` names). */
export function localPrintDay(date: Date = new Date()): string {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();
  return `${year < 1000 ? String(year).padStart(4, "0") : year}-${month < 10 ? "0" : ""}${month}-${day < 10 ? "0" : ""}${day}`;
}
