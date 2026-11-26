/**
 * Value coercion per field kind: what an agent sends is read
 * strictly into the one shape the runtime stores, or refused with the code, message and exact
 * hint. Text takes a string (a number or boolean is stringified and reported as
 * coerced), a number a finite number or a numeral written in the form's locale, a date a real
 * `YYYY-MM-DD`, a boolean `true` / `false` and the four words, a choice an option value or
 * exactly one option whose label equals the input after trim and NFC, a multichoice an array or
 * a record, a table an array of row objects. `null` and `""` clear.
 *
 * The reading itself lives in the shared answers module (`agent/answers/`), which the builder's Try it tool reads through too and which carries no wording. This
 * module is the renderer's voice over it: each function keeps its name and signature,
 * calls the answers function and words its problem into the renderer's refusal, byte for byte
 * (`engine/tests/agent-answers.test.ts` holds both to the golden outputs captured before the
 * move).
 */

import {
  coerceAnswer,
  coerceRowsAnswer,
  echoValue,
  matchOption as matchAnswerOption,
  STRING_VALUE_CAP,
  type AnswerProblem,
  type AnswerResult,
  type FieldColumn,
  type FieldKind
} from "../answers/index.js";
import type { RenderComponentModel } from "../../render/core/component-model.js";

export { normalizeLabel, STRING_VALUE_CAP } from "../answers/index.js";

/** A refusal as the per-path `refused` entries and `ToolRefusal` carry it. */
export interface Refusal {
  code: string;
  message: string;
  hint: string;
  details?: Record<string, unknown>;
}

export type Coerced =
  | { ok: true; value: unknown; matched?: "value" | "label" | "free"; coerced?: true }
  | { ok: false; refusal: Refusal };

/** The `invalid-value` refusal: `expected` filled into the hint, the value described in the message. */
export function invalidValue(path: string, kind: FieldKind, expected: string, got: unknown, message?: string): Refusal {
  return {
    code: "invalid-value",
    message: message ?? `${describeGot(got)} is not ${expected} for '${path}'.`,
    hint: `Pass ${expected} for \`${path}\`.`,
    details: { path, kind, expected, got: echoValue(got) }
  };
}

function describeGot(got: unknown): string {
  if (typeof got === "string") {
    return `'${got.length > 60 ? `${got.slice(0, 57)}…` : got}'`;
  }
  if (got === null) {
    return "null";
  }
  if (typeof got === "object") {
    return Array.isArray(got) ? "An array" : "An object";
  }
  return String(got);
}

/**
 * The answers module's problem in the renderer's words: the renderer's message and hint,
 * the details as the problem carries them (they are the renderer's details).
 */
export function refusalOf(problem: AnswerProblem): Refusal {
  const details = problem.details ?? { path: problem.path };
  switch (problem.code) {
    case "invalid-value": {
      const kind = problem.kind as FieldKind;
      const expected = problem.expected as string;
      // A date names its format in the message itself; every other kind the generic sentence.
      const message = kind === "date" ? `${describeGot(problem.input)} is not a date in the form YYYY-MM-DD.` : undefined;
      return { ...invalidValue(problem.path, kind, expected, problem.input, message), details };
    }
    case "too-large":
      return {
        code: "too-large",
        message: `The value for '${problem.path}' is ${String(details.got)} characters long, over the ${STRING_VALUE_CAP} character limit.`,
        hint: `Send fewer items per call (at most ${STRING_VALUE_CAP} for ${problem.path}) and call again for the rest.`,
        details
      };
    case "options-loading":
      return {
        code: "options-loading",
        message: `The choices of '${problem.path}' have not loaded yet, so the value cannot be checked.`,
        hint: "Call get_options for this field, then retry.",
        details
      };
    case "options-failed":
      return {
        code: "options-failed",
        message: `The choices of '${problem.path}' failed to load, so the value cannot be checked.`,
        hint: "The field's choices did not load; tell the person and leave the field.",
        details
      };
    case "option-ambiguous":
      return {
        code: "option-ambiguous",
        message: `${(details.candidates as unknown[]).length} options of '${problem.path}' share the label '${String(details.got)}'.`,
        hint: "Send the option's `value` instead of its label.",
        details
      };
    case "no-such-option":
      return {
        code: "no-such-option",
        message: `'${String(details.got)}' matches no option value or label of '${problem.path}'.`,
        hint: `Pick one of the listed option values, or call get_options with a \`query\` to search all ${String(details.total)}.`,
        details
      };
  }
}

function worded(result: AnswerResult): Coerced {
  return result.ok ? result : { ok: false, refusal: refusalOf(result.problem) };
}

/** The option a scalar names: by value first, else by exactly one label; the refusals otherwise. */
export function matchOption(model: RenderComponentModel, raw: unknown, path: string, acceptsFreeText: boolean): Coerced {
  // The model's labels are already in the memo's language; the match never reads another, so no locale is needed here.
  return worded(matchAnswerOption(model, raw, path, { acceptsFreeText, locale: "" }));
}

export interface CoerceOptions {
  locale: string;
  acceptsFreeText: boolean;
}

/** Reads `raw` into the stored shape of `kind`, or the refusal; clearing values become `undefined`. */
export function coerceScalar(model: RenderComponentModel, kind: FieldKind, raw: unknown, path: string, options: CoerceOptions): Coerced {
  return worded(coerceAnswer(model, kind, raw, path, options));
}

export interface CoercedRows {
  rows: Record<string, unknown>[];
  /** The first cell that would not read, when any: the whole table is then refused with it. */
  refusal?: Refusal;
}

/** A table written whole: an array of row objects, each cell read by its column's kind. */
export function coerceRows(
  raw: unknown,
  path: string,
  columns: readonly FieldColumn[],
  cellModel: (column: FieldColumn) => RenderComponentModel | undefined,
  options: Omit<CoerceOptions, "acceptsFreeText"> & { acceptsFreeText: (column: FieldColumn) => boolean }
): CoercedRows | { refusal: Refusal } {
  const read = coerceRowsAnswer(raw, path, columns, cellModel, options);
  return read.ok ? { rows: read.rows } : { refusal: refusalOf(read.problem) };
}
