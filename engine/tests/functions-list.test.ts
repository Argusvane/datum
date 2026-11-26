import { describe, expect, it } from "vitest";
import { FORMULA_FUNCTION_TABLE } from "../form-engine/core/expressions/function-table.js";
import { kernelListCall, kernelListHandles, kernelMaxFormulaListItems } from "../form-engine/rules/evaluator/functions-list.js";

const rows: Array<[string, unknown[], unknown]> = [
  ["first", [[3, 4]], 3],
  ["first", [[]], undefined],
  ["last", [[3, 4]], 4],
  ["last", [[]], undefined],
  ["distinct", [[1, 2, 1, "1", 2]], [1, 2, "1"]],
  ["distinct", [[Number.NaN, Number.NaN, 0, -0, "a", "a", null, null, undefined, undefined]], [Number.NaN, 0, "a", null, undefined]],
  ["sort", [[10, 9, 1]], [1, 9, 10]],
  ["sort", [["b", "B", "a"]], ["B", "a", "b"]],
  ["sort", [[10, "9", 1]], undefined],
  ["sort", [[3, "10", 2, "a", null, true, { a: 1 }, [1]]], undefined],
  ["sort", [[true, false]], undefined],
  ["sort", [[{ a: 2 }, { a: 1 }]], undefined],
  ["sort", [[2, null, 1]], undefined],
  ["sort", [[]], []],
  ["reverse", [[1, 2, 3]], [3, 2, 1]],
  ["append", [[1], 2], [1, 2]],
  ["append", [undefined, 2], [2]],
  ["append", ["x", 2], undefined],
  ["pluck", [[{ a: 1 }, { b: 2 }, { a: 3 }, null, 5], "a"], [1, 3]],
  ["pluck", [[{ a: 1 }], 7], undefined],
  ["pluck", [[{ a: 1 }], undefined], undefined],
  ["pluck", [[{ k: 1 }, { j: 2 }, null, { k: 0 }, { k: null }], "k"], [1, 0, null]],
  ["append", [null, 1], undefined],
  ["any", [[1, "true"]], false],
  ["all", [[1, true]], false],
  ["any", [[false, true]], true],
  ["any", [["true", 1]], false],
  ["any", [[]], false],
  ["all", [[true, true]], true],
  ["all", [[true, false]], false],
  ["all", [[]], true]
];

describe("list functions", () => {
  it.each(rows)("%s %j", (name, args, expected) => {
    expect(kernelListCall(name, args)).toEqual(expected);
  });

  it("returns undefined for a non-array first argument", () => {
    for (const name of ["first", "last", "distinct", "sort", "reverse", "pluck", "any", "all"]) {
      expect(kernelListCall(name, ["x", "k"])).toBeUndefined();
      expect(kernelListCall(name, [undefined, "k"])).toBeUndefined();
    }
  });

  it("distinct keeps objects by identity and runs in linear time", () => {
    const row = { a: 1 };
    expect(kernelListCall("distinct", [[row, row, { a: 1 }]])).toEqual([row, { a: 1 }]);
    expect((kernelListCall("distinct", [[row, row, { a: 1 }]]) as unknown[]).length).toBe(2);
    const big = Array.from({ length: 200000 }, (_, i) => i % 1000);
    const started = Date.now();
    expect((kernelListCall("distinct", [big]) as unknown[]).length).toBe(1000);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("does not mutate its input", () => {
    const input = [3, 1, 2];
    kernelListCall("sort", [input]);
    kernelListCall("reverse", [input]);
    kernelListCall("append", [input, 4]);
    expect(input).toEqual([3, 1, 2]);
  });

  it("handles every list-group row except selected and count", () => {
    for (const row of FORMULA_FUNCTION_TABLE) {
      if (row.group !== "list" || row.name === "selected") {
        continue;
      }
      expect(kernelListHandles(row.name), row.name).toBe(true);
    }
    expect(kernelListHandles("selected")).toBe(false);
    expect(kernelListHandles("indexOf")).toBe(false);
  });
});

describe("list item cap", () => {
  it("is 10,000 items (MAX_FORMULA_LIST_ITEMS), beside the 10,000 character text cap", () => {
    expect(kernelMaxFormulaListItems()).toBe(10000);
  });
});
