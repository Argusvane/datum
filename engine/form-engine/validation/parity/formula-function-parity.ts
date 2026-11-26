import type { FormulaFunctionContribution } from "../../core/schema/contracts.js";

export interface FormulaFunctionVector {
  args: unknown[];
  expected: unknown;
}

export interface FormulaFunctionParityMismatch {
  index: number;
  args: unknown[];
  expected: unknown;
  inProcess: unknown;
  sandbox: unknown;
}

export interface FormulaFunctionParityReport {
  checked: number;
  mismatches: FormulaFunctionParityMismatch[];
}

/**
 * Runs a sandbox-side call of the function: given its name and the arguments, returns what
 * the sandbox's evaluator produced. The host that owns a QuickJS program supplies it, so
 * this module never reaches the sandbox itself.
 */
export type FormulaFunctionSandboxRunner = (name: string, args: unknown[]) => unknown | Promise<unknown>;

/** Values compare as the ABI sees them: canonical JSON, `undefined` as absent. */
function canonical(value: unknown): string {
  return JSON.stringify(value === undefined ? null : value, (_key, inner: unknown) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const record = inner as Record<string, unknown>;
      return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
    }
    return inner;
  });
}

/**
 * Checks that a plugin formula function answers each vector the same in process and in the
 * sandbox, and answers what the vector expects. A mismatch lists both results.
 */
export async function formulaFunctionParity(
  contribution: FormulaFunctionContribution,
  vectors: FormulaFunctionVector[],
  runSandbox: FormulaFunctionSandboxRunner
): Promise<FormulaFunctionParityReport> {
  const mismatches: FormulaFunctionParityMismatch[] = [];
  for (const [index, vector] of vectors.entries()) {
    const inProcess = contribution.evaluate(structuredClone(vector.args));
    const sandbox = await runSandbox(contribution.name, structuredClone(vector.args));
    const want = canonical(vector.expected);
    if (canonical(inProcess) !== want || canonical(sandbox) !== want) {
      mismatches.push({ index, args: vector.args, expected: vector.expected, inProcess, sandbox });
    }
  }
  return { checked: vectors.length, mismatches };
}
