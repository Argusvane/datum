/**
 * The formula editor's English (a lazy chunk), kept out of the eager table in `logic/builder-texts.ts` so the builder entry
 * carries none of it (to keep the eager bundle small). Every key here is read only by code
 * in that chunk, through this module's `builderText` and its kin (or `areaWords`, the builder words reading this table): the lookup is the builder's
 * one (`builderText`), this table only supplies the English. `engine/tests/builder-texts.test.ts`
 * holds each key to exactly one table and each table to its own readers.
 */
import { areaText } from "../logic/builder-texts.js";

export const FORMULA_EN = {
  // Formula parse errors, one per `FormulaErrorCode` (`core/expressions/formula-types.ts`); the
  // `.end` form words the same code at the end of the formula, where there is no token.
  "formula.err.pattern.risky": "The pattern {pattern} repeats a repeat (or a back-reference), which can take very long on some text; the form refuses it unless the host allows risky patterns.",
  "formula.lint.reversedRange": "This range is never true: the lower bound is above the upper one.",
  "formula.lint.mixedRange": "This range mixes {low} and {high} bounds, so it is never true.",
  "formula.lint.backslash": "A backslash before the letter {letter} is not an escape; only \\n, \\t and \\r are.",
  "formula.lint.decimalEquals": "A calculated number is rarely exactly {value}; wrap the calculation in roundTo(..., 2) before comparing.",
  "formula.lint.notBoolean": "A condition holds only when it comes to yes. This one comes to a number or text, so it never holds; compare it, for example with > 0 or = \"yes\".",
  // The formula editor's words.
  "editor.field": "Field",
  "editor.function": "Function",
  "editor.helpers": "Helpers",
  "editor.reference": "Formula reference",
  "editor.suggest.footer": "↑↓ to move · Tab to insert · Esc to close",
  "editor.suggest.fields": "Fields",
  "editor.suggest.functions": "Functions",
  "editor.suggest.keywords": "Keywords",
  "editor.suggest.options": "Options"
} as const;

export const { builderText, builderPlural, builderTemplateParts, formatListText, areaWords } = /* @__PURE__ */ areaText(FORMULA_EN);
