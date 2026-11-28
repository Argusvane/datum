/**
 * What reading an answer can go wrong with, as data:
 * a code, the path, and the details a refusal carries, never a message or a hint. Each
 * catalogue words a problem in its own voice: the renderer's `agent/form/coerce.ts` rewords it
 * into the renderer's refusal byte for byte, the builder's Try it tool into its own.
 */

import type { FieldKind } from "../../registry/kinds.js";

export type AnswerProblemCode = "invalid-value" | "too-large" | "options-loading" | "options-failed" | "option-ambiguous" | "no-such-option";

export interface AnswerProblem {
  code: AnswerProblemCode;
  /** The value path the answer was meant for (a row cell's `items[0].qty` for a cell). */
  path: string;
  /** `invalid-value`: the kind the value was read as. */
  kind?: FieldKind;
  /** `invalid-value`: what the field takes, in words ("a number", "a date as YYYY-MM-DD"). */
  expected?: string;
  /** The value echoed as `details.got` carries it: scalars as they are (long strings cut), anything else by shape. */
  got?: unknown;
  /**
   * `invalid-value`: the value that did not read, as given, for the caller's wording only (a
   * message may describe it); never put it in a result whole. Absent when it was `undefined`.
   */
  input?: unknown;
  /** Exactly the details the renderer's refusal carries for this problem (JSON-safe). */
  details?: Record<string, unknown>;
}

export type AnswerResult = { ok: true; value: unknown; matched?: "value" | "label" | "free"; coerced?: true } | { ok: false; problem: AnswerProblem };

/** What `details.got` echoes: scalars as they are, anything else by shape (never the whole payload). */
export function echoValue(got: unknown): unknown {
  if (got === null || typeof got !== "object") {
    return typeof got === "string" && got.length > 200 ? `${got.slice(0, 197)}…` : got;
  }
  return Array.isArray(got) ? `an array of ${got.length}` : "an object";
}

/** A value that does not read as `expected` for a field of `kind`. */
export function invalidValueProblem(path: string, kind: FieldKind, expected: string, got: unknown): { ok: false; problem: AnswerProblem } {
  const echoed = echoValue(got);
  const problem: AnswerProblem = { code: "invalid-value", path, kind, expected, got: echoed, details: { path, kind, expected, got: echoed } };
  if (got !== undefined) {
    problem.input = got;
  }
  return { ok: false, problem };
}
