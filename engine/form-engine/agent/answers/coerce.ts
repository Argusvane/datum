/**
 * Reading an answer into the one shape the runtime stores, or a problem: text takes a string (a number or boolean is
 * stringified and reported as coerced), a number a finite number or a numeral written in the
 * caller's locale, a date a real `YYYY-MM-DD`, a boolean `true` / `false` and the four words, a
 * choice an option value or exactly one option whose label equals the input after trim and
 * NFC, a multichoice an array or a record, a table an array of row objects. `null`, `""` and
 * `undefined` clear. The renderer's answer and row writes and the builder's Try it fill read
 * through here; each words the problems itself.
 */

import { kernelIsDateAnswer } from "../../core/schema/answer-kinds.js";
import type { RenderComponentModel } from "../../render/core/component-model.js";
import { readTypedNumber } from "../../render/web-component/typed-answers.js";
import type { FieldColumn, FieldKind } from "./kinds.js";
import { matchOption } from "./match.js";
import { invalidValueProblem, type AnswerProblem, type AnswerResult } from "./problems.js";

/** The longest string value a write takes . */
export const STRING_VALUE_CAP = 10_000;

export interface CoerceOptions {
  /** The language numerals are read in. */
  locale: string;
  /** A choice takes an answer outside its options. */
  acceptsFreeText: boolean;
}

function clears(raw: unknown): boolean {
  return raw === null || raw === "" || raw === undefined;
}

function tooLarge(path: string, got: number): { ok: false; problem: AnswerProblem } {
  return { ok: false, problem: { code: "too-large", path, got, details: { what: "input", limit: STRING_VALUE_CAP, got, key: path } } };
}

/** Reads `raw` into the stored shape of `kind`, or a problem; clearing values become `undefined`. */
export function coerceAnswer(model: RenderComponentModel, kind: FieldKind, raw: unknown, path: string, options: CoerceOptions): AnswerResult {
  if (typeof raw === "string" && raw.length > STRING_VALUE_CAP) {
    return tooLarge(path, raw.length);
  }
  switch (kind) {
    case "text": {
      if (clears(raw)) {
        return { ok: true, value: undefined };
      }
      if (typeof raw === "string") {
        return { ok: true, value: raw };
      }
      if (typeof raw === "number" || typeof raw === "boolean") {
        return { ok: true, value: String(raw), coerced: true };
      }
      return invalidValueProblem(path, kind, "a string", raw);
    }
    case "number": {
      if (clears(raw)) {
        return { ok: true, value: undefined };
      }
      if (typeof raw === "number") {
        return Number.isFinite(raw) ? { ok: true, value: raw } : invalidValueProblem(path, kind, "a number", raw);
      }
      if (typeof raw === "string") {
        const parsed = readTypedNumber(raw, options.locale);
        return parsed !== undefined ? { ok: true, value: parsed, coerced: true } : invalidValueProblem(path, kind, "a number", raw);
      }
      return invalidValueProblem(path, kind, "a number", raw);
    }
    case "date": {
      if (clears(raw)) {
        return { ok: true, value: undefined };
      }
      if (typeof raw === "string" && kernelIsDateAnswer(raw)) {
        return { ok: true, value: raw };
      }
      return invalidValueProblem(path, kind, "a date as YYYY-MM-DD", raw);
    }
    case "boolean": {
      if (clears(raw)) {
        return { ok: true, value: undefined };
      }
      if (typeof raw === "boolean") {
        return { ok: true, value: raw };
      }
      if (typeof raw === "string") {
        const word = raw.trim().toLowerCase();
        if (word === "true" || word === "yes") {
          return { ok: true, value: true, coerced: true };
        }
        if (word === "false" || word === "no") {
          return { ok: true, value: false, coerced: true };
        }
      }
      return invalidValueProblem(path, kind, "true or false", raw);
    }
    case "choice": {
      if (clears(raw)) {
        return { ok: true, value: undefined };
      }
      return matchOption(model, raw, path, options);
    }
    case "multichoice": {
      if (clears(raw)) {
        return { ok: true, value: undefined };
      }
      let picked: unknown[];
      if (Array.isArray(raw)) {
        picked = raw;
      } else if (typeof raw === "object" && raw !== null) {
        picked = Object.entries(raw as Record<string, unknown>)
          .filter(([, on]) => on === true)
          .map(([key]) => key);
      } else if (typeof raw === "string") {
        picked = [raw];
      } else {
        return invalidValueProblem(path, kind, "an array of option values", raw);
      }
      const record: Record<string, boolean> = {};
      for (const item of model.optionState.items) {
        record[item.value] = false;
      }
      let matched: "value" | "label" | "free" | undefined;
      for (const entry of picked) {
        const match = matchOption(model, entry, path, options);
        if (!match.ok) {
          return match;
        }
        record[String(match.value)] = true;
        if (match.matched === "label" || (match.matched === "free" && matched !== "label")) {
          matched = match.matched;
        }
      }
      return matched !== undefined ? { ok: true, value: record, matched } : { ok: true, value: record };
    }
    default:
      return invalidValueProblem(path, kind, "a string", raw);
  }
}

export interface RowsCoerceOptions {
  locale: string;
  /** Whether a column's choice takes free text. */
  acceptsFreeText: (column: FieldColumn) => boolean;
}

/**
 * A table written whole: an array of row objects, each cell read by its column's kind through
 * {@link coerceAnswer} (the cell's path is `<path>[<row>].<key>`). Keys that name no column are
 * dropped; a column whose cell has no model keeps its value as given. The first cell that does
 * not read refuses the whole table.
 */
export function coerceRowsAnswer(
  raw: unknown,
  path: string,
  columns: readonly FieldColumn[],
  cellModel: (column: FieldColumn) => RenderComponentModel | undefined,
  options: RowsCoerceOptions
): { ok: true; rows: Record<string, unknown>[] } | { ok: false; problem: AnswerProblem } {
  if (!Array.isArray(raw) || raw.some((row) => row === null || typeof row !== "object" || Array.isArray(row))) {
    return invalidValueProblem(path, "collection", "an array of row objects", raw);
  }
  const rows: Record<string, unknown>[] = [];
  for (const [index, row] of (raw as Record<string, unknown>[]).entries()) {
    const out: Record<string, unknown> = {};
    for (const column of columns) {
      if (!Object.prototype.hasOwnProperty.call(row, column.key)) {
        continue;
      }
      const model = cellModel(column);
      const cellPath = `${path}[${index}].${column.key}`;
      if (model === undefined) {
        out[column.key] = row[column.key];
        continue;
      }
      const read = coerceAnswer(model, column.kind, row[column.key], cellPath, { locale: options.locale, acceptsFreeText: options.acceptsFreeText(column) });
      if (!read.ok) {
        return read;
      }
      out[column.key] = read.value;
    }
    rows.push(out);
  }
  return { ok: true, rows };
}
