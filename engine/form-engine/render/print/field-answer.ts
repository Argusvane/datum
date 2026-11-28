/**
 * A field's answer, worded: what paper prints for one field (`fieldOf`) and the answer
 * as one line of text (`answerTextOf`). The print model (`model.ts`) builds its fields here, and
 * a journey's Check answers page (`render/core/journey-review.ts`) lists the same words: an
 * option's label, a date and a number in the locale's words, a file's name. Its own module so the
 * journeys chunk takes it without the print model, which loads with `print()`.
 */
import type { FormTextKey } from "../../core/localization/form-texts.js";
import { kernelIsDateAnswer } from "../../core/schema/answer-kinds.js";
import type { ComponentNode } from "../../core/schema/types.js";
import type { RenderComponentModel } from "../core/component-model.js";
import { printAnswerText } from "./answer-text.js";
import type { PrintAnswer, PrintField, PrintOption, PrintRendition } from "./model.js";

/** A configuration as a record (never `null`, never an array). */
function configurationOf(node: ComponentNode | undefined): Record<string, unknown> {
  const configuration = node?.configuration;
  return configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>) : {};
}

/** No answer given, as validation reads one (`isEmptyValue`): text of spaces alone is none. */
function isBlankAnswer(value: unknown): boolean {
  if (value === undefined || value === null) {
    return true;
  }
  if (typeof value === "string") {
    return value.trim() === "";
  }
  if (typeof value === "number") {
    return !Number.isFinite(value);
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value === "object") {
    // A checkboxes group: nothing ticked.
    return Object.values(value as Record<string, unknown>).every((entry) => entry !== true);
  }
  return false;
}

/**
 * A prefix or suffix beside the answer: a space for a word (kg); for a sign ($, %, €) the space
 * the locale sets between a number and its currency sign (none in English, a no-break one in
 * French: "1250,5 $").
 */
function withAffixes(text: string, signGap: string, prefix?: string, suffix?: string): string {
  const before = prefix ? (/\p{L}$/u.test(prefix) ? `${prefix} ` : `${prefix}${signGap}`) : "";
  const after = suffix ? (/^\p{L}/u.test(suffix) ? ` ${suffix}` : `${signGap}${suffix}`) : "";
  return `${before}${text}${after}`;
}

const intlTag = (locale: string): string => locale.replace(/_/g, "-");

/** The space `locale` writes between a number and a sign, read from Intl's currency format; "" for none. */
export function signGapOf(locale: string): string {
  try {
    const parts = new Intl.NumberFormat(intlTag(locale), { style: "currency", currency: "EUR" }).formatToParts(1);
    const at = parts.findIndex((part) => part.type === "currency");
    const beside = [parts[at - 1], parts[at + 1]].find((part) => part?.type === "literal");
    return beside !== undefined && /^\s+$/u.test(beside.value) ? beside.value : "";
  } catch {
    return "";
  }
}

/**
 * A stored number in the locale's words: its decimal mark, minus sign and digits, at the precision
 * it was stored with ("1250.5" → "1250,5" in French). No grouping: a year or a reference number
 * reads as typed. Anything that is not a plain decimal is left as stored.
 */
export function formatPrintNumber(value: string, locale: string): string {
  const trimmed = value.trim();
  const match = /^-?\d+(?:\.(\d+))?$/.exec(trimmed);
  if (!match || (match[1]?.length ?? 0) > 20) {
    return value;
  }
  const digits = match[1]?.length ?? 0;
  try {
    const format = new Intl.NumberFormat(intlTag(locale), { useGrouping: false, minimumFractionDigits: digits, maximumFractionDigits: digits });
    // A decimal string is formatted exactly (Intl.NumberFormat v3), past a double's precision.
    return format.format(trimmed as unknown as number);
  } catch {
    return value;
  }
}

/**
 * A stored `YYYY-MM-DD` in the locale's words ("March 15, 2026", "15 mars 2026"); anything else as
 * stored. The words follow the calendar the locale writes by default (`fa` words it Persian).
 * `gregorian` keeps them in the calendar the date is stored in: the filled rendition asks for it,
 * so the words name the same date as the day, month and year boxes beside them.
 */
export function formatPrintDate(value: string, locale: string, gregorian = false): string {
  const date = calendarDateOf(value);
  if (date === undefined) {
    return value;
  }
  try {
    return new Intl.DateTimeFormat(locale.replace(/_/g, "-"), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC", ...(gregorian ? { calendar: "gregory" } : {}) }).format(date);
  } catch {
    return value;
  }
}

/**
 * A stored `YYYY-MM-DD` as the UTC midnight it names, or `undefined` for anything that is not a real
 * calendar date (`kernelIsDateAnswer`: a 30 February or a 13th month is no date, not one rolled
 * over). The year is set on its own: `Date.UTC` reads a year below 100 as 19xx.
 */
function calendarDateOf(value: string): Date | undefined {
  if (!kernelIsDateAnswer(value)) {
    return undefined;
  }
  const date = new Date(Date.UTC(2000, Number(value.slice(5, 7)) - 1, Number(value.slice(8, 10))));
  date.setUTCFullYear(Number(value.slice(0, 4)));
  return date;
}

/** The order a locale writes a date's parts in, read from Intl (en-US: month day year; fr: day month year), in the Gregorian calendar the stored date is in. */
function datePartOrder(locale: string): Array<"day" | "month" | "year"> {
  try {
    const parts = new Intl.DateTimeFormat(locale.replace(/_/g, "-"), { year: "numeric", month: "long", day: "numeric", timeZone: "UTC", calendar: "gregory" }).formatToParts(
      new Date(Date.UTC(2026, 2, 15))
    );
    const order = parts.map((part) => part.type).filter((type): type is "day" | "month" | "year" => type === "day" || type === "month" || type === "year");
    return order.length === 3 ? order : ["day", "month", "year"];
  } catch {
    return ["day", "month", "year"];
  }
}

/**
 * A stored `YYYY-MM-DD` as the words its three boxes carry, in the locale's own words and the
 * Gregorian calendar: the month as the locale's name for it when the locale words a date that way
 * ("March", "mars"), otherwise as digits; the day and the year as digits. The month is read on its
 * own, so it is the name a box stands for (ru "март", never the "марта" a full date inflects it
 * to). `undefined` for anything that is not a real calendar date, which leaves the boxes empty.
 */
function datePartValues(value: string, locale: string): { day: string; month: string; year: string } | undefined {
  const date = calendarDateOf(value);
  if (date === undefined) {
    return undefined;
  }
  const [year, month, day] = [date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()];
  let named: string | undefined;
  try {
    const parts = new Intl.DateTimeFormat(locale.replace(/_/g, "-"), { month: "long", timeZone: "UTC", calendar: "gregory" }).formatToParts(date);
    const worded = parts.find((part) => part.type === "month")?.value;
    // A locale that writes the month as a number ("3月") has no name to give: digits.
    named = worded !== undefined && !/\d/u.test(worded) ? worded : undefined;
  } catch {
    named = undefined;
  }
  return { day: String(day), month: named ?? String(month), year: String(year) };
}

function storedText(value: unknown): string {
  if (value === undefined || value === null) {
    return "";
  }
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : "";
}

export interface FieldContext {
  rendition: PrintRendition;
  locale: string;
  /** The form's words: a blank date's part names are the only ones a field reads. */
  text: (key: FormTextKey) => string;
  /** {@link signGapOf} the locale. */
  signGap: string;
}

/** The types whose answer is a secret, shown as {@link ANSWER_MASK} wherever an answer is worded (print, Check answers). */
export const MASKED_ANSWER_TYPES: ReadonlySet<string> = new Set(["password"]);

/** What a given secret answer shows in its place. */
export const ANSWER_MASK = "••••••••";

/** Whether a component of `type` (with base type `base`) holds a secret answer. */
export function isMaskedAnswerType(type: string, base: string): boolean {
  return MASKED_ANSWER_TYPES.has(base) || MASKED_ANSWER_TYPES.has(type);
}

/** The base types print draws no field for: nothing to answer on paper (a button, a picture), or not covered yet (a signature). */
const NOT_PRINTED: ReadonlySet<string> = new Set(["button", "button-group", "image", "signature", "pdf-signature"]);

/** One field as paper shows it; `undefined` for one that prints nothing. */
export function fieldOf(model: RenderComponentModel, base: string, context: FieldContext, note?: string): PrintField | undefined {
  if (NOT_PRINTED.has(base) || model.buttonAction !== undefined) {
    return undefined;
  }
  const blank = context.rendition === "blank";
  // The paper form's look with the answers in it: boxes, every option of a select, date parts.
  const filled = context.rendition === "filled";
  const value = blank ? undefined : model.value;
  const stored = storedText(value);
  const options = (chosen: (value: string) => boolean): PrintOption[] =>
    model.optionState.items.map((item) => {
      const option: PrintOption = { label: item.label, chosen: chosen(item.value) };
      const hint = typeof item.description === "string" ? item.description.trim() : "";
      if (hint !== "") {
        option.hint = hint;
      }
      return option;
    });
  // A stored value no option lists (an answer from before the list changed) still stands, as a
  // chosen option of its own worded as stored: the answer is never dropped for want of a label.
  const withStored = (listed: PrintOption[], given: readonly string[]): PrintOption[] => {
    const values = new Set(model.optionState.items.map((item) => item.value));
    const unlisted = given.filter((entry) => entry !== "" && !values.has(entry));
    return unlisted.length > 0 ? [...listed, ...unlisted.map((entry) => ({ label: entry, chosen: true }))] : listed;
  };
  let answer: PrintAnswer;
  let empty = blank || isBlankAnswer(value);
  switch (base) {
    case "radio":
      answer = { shape: "choices", multiple: false, single: false, options: withStored(options((option) => option === stored), [stored]) };
      break;
    case "checkboxes": {
      const picked = Array.isArray(value)
        ? new Set(value.map((entry) => String(entry)))
        : value && typeof value === "object"
          ? new Set(Object.entries(value as Record<string, unknown>).flatMap(([key, on]) => (on === true ? [key] : [])))
          : new Set<string>();
      answer = { shape: "choices", multiple: true, single: false, options: withStored(options((option) => picked.has(option)), [...picked]) };
      empty = blank || picked.size === 0;
      break;
    }
    case "checkbox":
      answer = { shape: "choices", multiple: true, single: true, options: [{ label: model.label, chosen: value === true }] };
      empty = blank || value !== true;
      break;
    case "select":
      answer = blank
        ? { shape: "choices", multiple: false, single: false, options: options(() => false) }
        : filled
          ? { shape: "choices", multiple: false, single: false, options: withStored(options((option) => option === stored), [stored]) }
          : { shape: "text", text: model.optionState.items.find((item) => item.value === stored)?.label ?? stored, lines: 1, multiline: false };
      break;
    case "date": {
      if (blank || filled) {
        const values = filled ? datePartValues(stored, context.locale) : undefined;
        answer = {
          shape: "date-parts",
          parts: datePartOrder(context.locale).map((part) => ({
            part,
            label: context.text(part === "day" ? "dateDay" : part === "month" ? "dateMonth" : "dateYear"),
            size: part === "year" ? 4 : 2,
            ...(values ? { value: values[part] } : {})
          })),
          // The date as one line for a table cell, which has no boxes to put its parts in.
          ...(values ? { text: formatPrintDate(stored, context.locale, true) } : {})
        };
      } else {
        answer = { shape: "text", text: formatPrintDate(stored, context.locale), lines: 1, multiline: false };
      }
      break;
    }
    case "file": {
      const names = blank ? [] : (model.file?.attachments ?? []).map((attachment) => attachment.name);
      answer = { shape: "files", names };
      empty = blank || names.length === 0;
      break;
    }
    case "textarea": {
      const rows = configurationOf(model.node)["rows"];
      answer = { shape: "text", text: stored, lines: typeof rows === "number" && rows > 0 ? Math.min(20, Math.round(rows)) : 4, multiline: true };
      break;
    }
    case "text":
    case "number":
      answer = {
        shape: "text",
        // A filled box keeps its affixes beside it, as the blank box does: the text is the value alone.
        text:
          stored === ""
            ? ""
            : filled
              ? base === "number"
                ? formatPrintNumber(stored, context.locale)
                : stored
              : withAffixes(base === "number" ? formatPrintNumber(stored, context.locale) : stored, context.signGap, model.prefix, model.suffix),
        lines: 1,
        multiline: false,
        ...(model.prefix ? { prefix: model.prefix } : {}),
        ...(model.suffix ? { suffix: model.suffix } : {})
      };
      break;
    default:
      // A type print does not know (a plugin's, which may hold no answer at all): its answer as
      // text when it holds a plain one, and nothing on a blank form.
      if (blank || stored === "") {
        return undefined;
      }
      answer = { shape: "text", text: stored, lines: 1, multiline: false };
  }
  // A secret's answer is never printed: a mask stands in its place, as on Check answers.
  if (!empty && answer.shape === "text" && isMaskedAnswerType(model.type, base)) {
    answer = { shape: "text", text: ANSWER_MASK, lines: answer.lines, multiline: answer.multiline };
  }
  const field: PrintField = { kind: "field", id: model.id, type: model.type, base, label: model.label, required: model.accessibility.required, empty, answer };
  if (model.description) {
    field.hint = model.description;
  }
  if (note) {
    field.note = note;
  }
  return field;
}

/** What a field's answer reads as, on one line: `text`, and whether nothing was given (`empty`). */
export interface AnswerText {
  text: string;
  empty: boolean;
}

/** The space between a number and a sign, by locale (one Intl read each). */
const signGaps = new Map<string, string>();

/**
 * A field's answer as one line of text, as print words it (`fieldOf` read by `printAnswerText`): a
 * choice's label, the chosen boxes' labels, a date and a number in the locale's words with the
 * field's affixes, the files by name. `undefined` for a component that holds no answer print
 * shows (a button, a picture, a signature, an empty answer of a type print does not know).
 */
export function answerTextOf(model: RenderComponentModel, base: string, locale: string): AnswerText | undefined {
  let signGap = signGaps.get(locale);
  if (signGap === undefined) {
    signGap = signGapOf(locale);
    signGaps.set(locale, signGap);
  }
  // A blank form's date parts are the one thing worded from the texts: an answer needs none.
  const field = fieldOf(model, base, { rendition: "answers", locale, text: (key) => key, signGap });
  return field ? { text: printAnswerText(field), empty: field.empty } : undefined;
}
