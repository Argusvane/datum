import { describe, expect, it } from "vitest";
import { formulaFunctionParity } from "../form-engine/validation/parity/index.js";
import type { FormulaFunctionContribution } from "../form-engine/core/schema/contracts.js";

const double: FormulaFunctionContribution = {
  name: "double",
  params: ["n"],
  summary: "Twice n",
  example: "double(2)",
  returns: "number",
  evaluate: ([n]) => (typeof n === "number" ? n * 2 : undefined)
};

const vectors = [
  { args: [2], expected: 4 },
  { args: ["x"], expected: undefined }
];

describe("formulaFunctionParity", () => {
  it("passes when the sandbox answers as the function does", async () => {
    const report = await formulaFunctionParity(double, vectors, (_name, args) => double.evaluate(args));
    expect(report).toEqual({ checked: 2, mismatches: [] });
  });

  it("names the vector the sandbox answers differently", async () => {
    const report = await formulaFunctionParity(double, vectors, (_name, args) =>
      typeof args[0] === "number" ? (args[0] as number) + 2 + (args[0] === 2 ? 1 : 0) : undefined
    );
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({ index: 0, args: [2], expected: 4, inProcess: 4, sandbox: 5 });
  });

  it("fails a function whose own result is not what the vector expects", async () => {
    const wrong = { ...double, evaluate: () => 0 };
    const report = await formulaFunctionParity(wrong, vectors, (_n, args) => double.evaluate(args));
    expect(report.mismatches.map((m) => m.index)).toEqual([0, 1]);
  });
});
