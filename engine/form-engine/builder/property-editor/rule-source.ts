import { kernelRuleExpression, kernelRuleRun } from "../../core/expressions/compile.js";
import type { Expression } from "../../core/expressions/expression.js";
import { formulaFunctionSignatures } from "../../core/expressions/function-table.js";
import { kernelParseFormula } from "../../core/expressions/formula.js";
import type { RunScope } from "../../core/expressions/expression.js";

/** The tree a stored rule stands for: a tree as is, a formula string parsed, an unparseable one absent. */
export function ruleExpression(source: unknown): Expression | undefined {
  return kernelRuleExpression(source, kernelParseFormula, formulaFunctionSignatures());
}

/** Where a stored rule runs; `"both"` when it says nothing. */
export function ruleRun(source: unknown): RunScope {
  return kernelRuleRun(source);
}

/** The formula string a stored rule holds (bare or in the object form), else `undefined`. */
export function ruleText(source: unknown): string | undefined {
  if (typeof source === "string") {
    return source;
  }
  if (typeof source === "object" && source !== null && !Array.isArray(source)) {
    const formula = (source as { formula?: unknown }).formula;
    return typeof formula === "string" ? formula : undefined;
  }
  return undefined;
}
