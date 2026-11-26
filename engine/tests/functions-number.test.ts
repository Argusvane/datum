import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import {
  kernelNumberCall,
  kernelNumberHandles
} from "../form-engine/rules/evaluator/functions-number.js";

const cases: Array<[string, unknown[], unknown]> = [
  ["avg", [1, 2, 3], 2],
  ["avg", [[2, 4]], 3],
  ["avg", [], undefined],
  ["avg", [[]], undefined],
  ["avg", [1, "x"], undefined],
  ["avg", ["2", 4], 3],
  ["avg", [1, undefined, null, "", 3], 2],
  ["avg", [[1, undefined, 3]], 2],
  ["avg", [undefined], undefined],
  ["avg", [1, true], undefined],
  // A stored NaN is empty, as `empty()` says, so it is left out like a missing item.
  ["avg", [1, Number.NaN], 1],
  ["roundTo", [1.005, 2], 1.01],
  ["roundTo", [2.5, 0], 3],
  ["roundTo", [-2.5, 0], -3],
  ["roundTo", [1234, -2], 1200],
  ["roundTo", ["x", 2], undefined],
  ["roundTo", [1.5], undefined],
  ["roundUp", [1.21, 1], 1.3],
  ["roundUp", [-1.21, 1], -1.3],
  ["roundUp", [1.2], 2],
  ["roundUp", [3], 3],
  ["roundDown", [1.29, 1], 1.2],
  ["roundDown", [-1.29, 1], -1.2],
  ["roundDown", [-1.9], -1],
  ["modulo", [10, 3], 1],
  ["modulo", [-10, 3], -1],
  ["modulo", [10, 0], undefined],
  ["power", [2, 10], 1024],
  ["power", [-1, 0.5], undefined],
  ["power", ["a", 2], undefined],
  ["sqrt", [9], 3],
  ["sqrt", [-1], undefined],
  ["sqrt", [undefined], undefined],
  ["clamp", [15, 0, 10], 10],
  ["clamp", [-5, 0, 10], 0],
  ["clamp", [5, 0, 10], 5],
  ["clamp", [5, 10, 0], undefined],
  ["clamp", [5, 0], undefined],
  ["number", [" 42.5 "], 42.5],
  ["number", ["abc"], undefined],
  ["number", [""], undefined],
  ["number", [7], undefined],
  ["number", [{}], undefined],
  ["number", ["Infinity"], undefined],
  ["number", ["NaN"], undefined],
  ["power", [10, 400], undefined],
  ["modulo", [10, "x"], undefined],
  ["roundTo", [Number.NaN, 2], undefined],
  ["clamp", [Number.POSITIVE_INFINITY, 0, 10], undefined],
  ["isNumber", ["12"], true],
  ["isNumber", [null], false],
  // Magnitudes below 1e-6 round at the scale asked, not skip it.
  ["roundTo", [0.0000001, 2], 0],
  ["roundTo", [-0.0000001, 2], 0],
  ["roundDown", [0.00000001, 2], 0],
  ["roundUp", [0.0000001, 2], 0.01],
  ["roundUp", [-0.0000001, 2], -0.01],
  ["roundTo", [0.0000001, 8], 0.0000001],
  ["roundTo", [0.000000149, 7], 0.0000001],
  ["roundTo", [1.5e-10, 10], 2e-10],
  ["roundTo", [1e21, -20], 1e21],
  ["roundTo", [1.005, 2], 1.01],
  // Never negative zero; modulo is truncated (the dividend's sign).
  ["roundTo", [-0.4, 0], 0],
  ["modulo", [-6, 3], 0],
  ["modulo", [-7, 3], -1],
  ["modulo", [7, -3], 1],
  ["power", [-1e-200, 3], 0],
  ["clamp", [-0, 0, 5], 0],
  ["number", ["-0"], 0],
  ["sqrt", [0], 0],
  // Text reads as a number only as a decimal numeral.
  ["number", ["0x10"], undefined],
  ["number", ["0b11"], undefined],
  ["number", ["0o7"], undefined],
  ["number", ["1_000"], undefined],
  ["number", ["+Infinity"], undefined],
  ["number", ["1e999"], undefined],
  ["number", ["1e3"], 1000],
  ["number", ["1E-2"], 0.01],
  ["number", [".5"], 0.5],
  ["number", ["5."], 5],
  ["number", ["+3"], 3],
  ["number", ["- 3"], undefined],
  ["number", ["1.2.3"], undefined],
  ["isNumber", ["0x1"], false],
  ["isNumber", ["1e5"], true],
  ["isNumber", ["  "], false],
  ["avg", ["0x10", 2], undefined],
  ["roundTo", ["0b11", 1], undefined]
];

describe("number functions", () => {
  it.each(cases)("%s(%j) = %j", (name, args, expected) => {
    expect(kernelNumberCall(name, args)).toBe(expected);
  });

  it("handles every number-group name in the table", () => {
    for (const row of FORMULA_FUNCTION_TABLE) {
      if (row.group === "number" && !["sum", "min", "max", "abs", "round", "floor", "ceil", "count"].includes(row.name)) {
        expect(kernelNumberHandles(row.name), row.name).toBe(true);
      }
    }
    expect(kernelNumberHandles("sum")).toBe(false);
  });

  it("avg reads lists the way sum does", () => {
    expect(kernelNumberCall("avg", [1, [2, 3]])).toBe(2);
    expect(kernelNumberCall("avg", [[1, "x"]])).toBeUndefined();
  });

  it("never throws on odd input", () => {
    for (const name of ["avg", "roundTo", "modulo", "power", "sqrt", "clamp", "number"]) {
      expect(() => kernelNumberCall(name, [{}, [], null, Symbol.iterator as never])).not.toThrow();
    }
  });
});
