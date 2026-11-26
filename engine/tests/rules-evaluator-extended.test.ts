import { describe, expect, it } from "vitest";

import type { Expression, ExpressionFunctionName } from "../form-engine/core/expressions/expression.js";
import { evaluateExpression } from "../form-engine/rules/evaluator/evaluator.js";

describe("rules evaluator — extended scopes and operations", () => {
  it("resolves ancestor and component scopes with nested paths", () => {
    const expression: Expression = {
      kind: "logical",
      operator: "and",
      left: {
        kind: "binary",
        operator: "eq",
        left: { kind: "path", path: "ancestor.section.mode" },
        right: { kind: "literal", value: "full" }
      },
      right: {
        kind: "binary",
        operator: "gt",
        left: { kind: "path", path: "component.count" },
        right: { kind: "literal", value: 2 }
      }
    };

    expect(
      evaluateExpression(expression, {
        values: {},
        ancestorValues: { section: { mode: "full" } },
        componentValue: { count: 5 }
      })
    ).toBe(true);
  });

  it("reads bare component value and nested form paths", () => {
    expect(
      evaluateExpression(
        { kind: "path", path: "component" },
        { values: {}, componentValue: 42 }
      )
    ).toBe(42);

    expect(
      evaluateExpression(
        { kind: "path", path: "address.city" },
        { values: { address: { city: "Montreal" } } }
      )
    ).toBe("Montreal");
  });

  it("prefers an exact instance-path key over nested traversal", () => {
    expect(
      evaluateExpression(
        { kind: "path", path: "items[0].qty" },
        { values: { "items[0].qty": 7 } }
      )
    ).toBe(7);
  });

  it("evaluates arithmetic with string coercion", () => {
    const expr: Expression = {
      kind: "arithmetic",
      operator: "multiply",
      left: { kind: "path", path: "price" },
      right: { kind: "path", path: "qty" }
    };
    expect(evaluateExpression(expr, { values: { price: "3", qty: 4 } })).toBe(12);
  });

  it("evaluates whitelisted functions", () => {
    const sum: Expression = {
      kind: "call",
      name: "sum",
      args: [
        { kind: "path", path: "a" },
        { kind: "path", path: "b" },
        { kind: "literal", value: 10 }
      ]
    };
    expect(evaluateExpression(sum, { values: { a: 1, b: 2 } })).toBe(13);

    const contains: Expression = {
      kind: "call",
      name: "contains",
      args: [
        { kind: "path", path: "tags" },
        { kind: "literal", value: "vip" }
      ]
    };
    expect(evaluateExpression(contains, { values: { tags: ["vip", "beta"] } })).toBe(true);

    const coalesce: Expression = {
      kind: "call",
      name: "coalesce",
      args: [
        { kind: "path", path: "missing" },
        { kind: "literal", value: "fallback" }
      ]
    };
    expect(evaluateExpression(coalesce, { values: {} })).toBe("fallback");
  });
});

// --- the formula vocabulary: if, the core functions, the day, the row, plugins ---------------

import {
  kernelExprIsEmpty,
  kernelExprReadPaths,
  kernelExprReadsClock,
  kernelExprReadsHost,
  kernelExprSelected
} from "../form-engine/rules/evaluator/evaluator.js";

const lit = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const call = (name: ExpressionFunctionName, ...args: Expression[]): Expression => ({
  kind: "call",
  name,
  args
});

describe("rules evaluator: if", () => {
  const chain: Expression = {
    kind: "if",
    cases: [
      { when: { kind: "path", path: "a" }, then: lit("A") },
      { when: { kind: "path", path: "b" }, then: lit("B") }
    ]
  };

  it("takes the first case that holds", () => {
    expect(evaluateExpression(chain, { values: { a: true, b: true } })).toBe("A");
    // Strict truthiness: b has to be true, a 1 does not hold.
    expect(evaluateExpression(chain, { values: { a: false, b: true } })).toBe("B");
    expect(evaluateExpression(chain, { values: { a: false, b: 1 } })).toBeUndefined();
  });

  it("is undefined with no match and no else, the else otherwise", () => {
    expect(evaluateExpression(chain, { values: {} })).toBeUndefined();
    expect(evaluateExpression({ ...chain, else: lit("Z") }, { values: {} })).toBe("Z");
  });
});

describe("rules evaluator: empty, selected, count", () => {
  it.each([
    [undefined, true],
    [null, true],
    ["", true],
    ["  ", true],
    [[], true],
    [{}, true],
    [{ a: false }, true],
    [{ a: true }, false],
    [{ a: false, b: true }, false],
    [{ city: "Paris" }, false],
    [0, false],
    [false, false],
    [Number.NaN, true],
    ["x", false],
    [[0], false]
  ])("empty(%j) is %s", (value, expected) => {
    expect(kernelExprIsEmpty(value)).toBe(expected);
    expect(evaluateExpression(call("empty", lit(null)), { values: {} })).toBe(true);
    expect(evaluateExpression(call("empty", { kind: "path", path: "v" }), { values: { v: value } })).toBe(expected);
  });

  it("selects a list as is, a flags object's ticked keys in order, a text alone", () => {
    expect(kernelExprSelected(["b", "a"])).toEqual(["b", "a"]);
    expect(kernelExprSelected({ fr: true, en: false, de: true })).toEqual(["fr", "de"]);
    expect(kernelExprSelected("en")).toEqual(["en"]);
    expect(kernelExprSelected("")).toEqual([]);
    expect(kernelExprSelected(undefined)).toEqual([]);
    expect(kernelExprSelected(3)).toEqual([]);
    expect(evaluateExpression(call("selected", { kind: "path", path: "v" }), { values: { v: { a: true } } })).toEqual(["a"]);
  });

  it("counts what is selected", () => {
    const count = (value: unknown): unknown =>
      evaluateExpression(call("count", { kind: "path", path: "v" }), { values: { v: value } });
    expect(count(["b", "a"])).toBe(2);
    expect(count({ fr: true, en: false, de: true })).toBe(2);
    expect(count("en")).toBe(1);
    expect(count("")).toBe(0);
    expect(count(undefined)).toBe(0);
  });

  it("sums, mins and maxes over a list argument as over the arguments themselves", () => {
    expect(evaluateExpression(call("sum", lit(1), lit(2)), { values: {} })).toBe(3);
    expect(evaluateExpression(call("sum", { kind: "path", path: "v" }), { values: { v: [1, 2, "3"] } })).toBe(6);
    expect(evaluateExpression(call("min", { kind: "path", path: "v" }, lit(0)), { values: { v: [4, 2] } })).toBe(0);
    expect(evaluateExpression(call("max", { kind: "path", path: "v" }), { values: { v: [4, 2] } })).toBe(4);
    expect(evaluateExpression(call("sum"), { values: {} })).toBe(0);
  });

  it("leaves an empty item out of sum, min and max, and gives no answer for one that is not a number", () => {
    const v = { kind: "path", path: "v" } as const;
    // A total over a page's optional fields fills once one is answered.
    expect(evaluateExpression(call("sum", lit(1), { kind: "path", path: "missing" }, lit(null), lit("")), { values: {} })).toBe(1);
    expect(evaluateExpression(call("sum", v), { values: { v: [1, undefined, null, " ", 2] } })).toBe(3);
    expect(evaluateExpression(call("min", v, { kind: "path", path: "missing" }), { values: { v: [4, 2] } })).toBe(2);
    expect(evaluateExpression(call("max", { kind: "path", path: "missing" }), { values: {} })).toBeUndefined();
    // A stored NaN or Infinity is empty (`empty()` says so), so it is left out too.
    expect(evaluateExpression(call("sum", lit(1), v), { values: { v: Number.NaN } })).toBe(1);
    expect(evaluateExpression(call("sum", lit(1), v), { values: { v: [Number.POSITIVE_INFINITY, 2] } })).toBe(3);
    // An item that is there but is not a number: no answer, never NaN.
    for (const bad of ["x", true, { a: 1 }, [["nested"]]]) {
      expect(evaluateExpression(call("sum", lit(1), v), { values: { v: bad } }), String(bad)).toBeUndefined();
      expect(evaluateExpression(call("min", lit(1), v), { values: { v: bad } }), String(bad)).toBeUndefined();
      expect(evaluateExpression(call("max", lit(1), v), { values: { v: bad } }), String(bad)).toBeUndefined();
    }
  });
});

describe("rules evaluator: the day and the row", () => {
  it("today() reads the context's day, nothing without one or with an invalid one", () => {
    expect(evaluateExpression(call("today"), { values: {}, today: "2026-10-07" })).toBe("2026-10-07");
    expect(evaluateExpression(call("today"), { values: {} })).toBeUndefined();
    expect(evaluateExpression(call("today"), { values: {}, today: "2026-02-30" })).toBeUndefined();
    expect(evaluateExpression(call("today"), { values: {}, today: "today" })).toBeUndefined();
  });

  it("age() is undefined without a day or a date of birth", () => {
    expect(evaluateExpression(call("age", lit("2000-05-10")), { values: {} })).toBeUndefined();
    expect(evaluateExpression(call("age", lit("not a date")), { values: {}, today: "2026-10-07" })).toBeUndefined();
    expect(evaluateExpression(call("age"), { values: {}, today: "2026-10-07" })).toBeUndefined();
  });

  it("age() is whole years from the date of birth to the day", () => {
    expect(evaluateExpression(call("age", lit("2000-05-10")), { values: {}, today: "2026-10-07" })).toBe(26);
    expect(evaluateExpression(call("age", lit("2000-10-08")), { values: {}, today: "2026-10-07" })).toBe(25);
  });

  it("built-in guards never throw out of the evaluator", () => {
    const lit = (value: unknown): Expression => ({ kind: "literal", value }) as Expression;
    const huge = evaluateExpression(call("padStart", lit("a"), lit(1000000000), lit("a")), { values: {} });
    expect(huge).toHaveLength(10000);
    // Cut to the first 10,000 characters, not given up.
    expect(evaluateExpression(call("concat", lit("a".repeat(6000)), lit("b".repeat(6000))), { values: {} })).toBe("a".repeat(6000) + "b".repeat(4000));
    expect(evaluateExpression(call("matches", lit("a"), lit("a".repeat(300))), { values: {} })).toBeUndefined();
  });

  it("rowIndex() and rowCount() read the context", () => {
    expect(evaluateExpression(call("rowIndex"), { values: {}, rowIndex: 2, rowCount: 5 })).toBe(2);
    expect(evaluateExpression(call("rowCount"), { values: {}, rowIndex: 2, rowCount: 5 })).toBe(5);
    expect(evaluateExpression(call("rowIndex"), { values: {} })).toBeUndefined();
    expect(evaluateExpression(call("rowCount"), { values: {} })).toBeUndefined();
  });
});

describe("rules evaluator: ordering days", () => {
  const compare = (operator: "gt" | "gte" | "lt" | "lte", left: unknown, right: unknown): unknown =>
    evaluateExpression(
      { kind: "binary", operator, left: { kind: "path", path: "l" }, right: { kind: "path", path: "r" } },
      { values: { l: left, r: right } }
    );

  it.each([
    ["gt", "2026-10-06", "2026-09-30", true],
    ["gte", "2026-10-06", "2026-10-06", true],
    ["lt", "2026-10-06", "2026-10-06", false],
    ["lte", "2026-10-06", "2026-10-06", true],
    ["lt", "2025-12-31", "2026-01-01", true],
    ["gt", "2026-10-06", 5, false],
    ["lt", "2026-10-06", 5, false],
    // Text orders by UTF-16 code unit: every pair of texts, a numeral and a non-day included.
    ["gt", "abc", "abd", false],
    ["lt", "abc", "abd", true],
    ["lte", "abc", "abc", true],
    ["gte", "abc", "abc", true],
    ["gt", "b", "a", true],
    ["gt", "2026-02-30", "2026-01-01", true],
    ["lt", "2026-1-5", "2026-01-05", false],
    // Two numeral texts order as numbers; the rest of the pair rows stay code units.
    ["gt", "10", "9", true],
    ["lt", "10", "9", false],
    ["lt", "10a", "9a", true],
    ["gt", "Z", "a", false],
    ["lt", "a", "é", true],
    // Mixed kinds still never order unless the text reads as a number: a text against a number is numeric.
    ["gt", "abc", 5, false],
    ["lt", "abc", 5, false],
    ["gt", "10", 9, true]
  ] as const)("%s(%j, %j) is %s", (operator, left, right, expected) => {
    expect(compare(operator, left, right)).toBe(expected);
  });

  it("keeps eq strict", () => {
    expect(evaluateExpression({ kind: "binary", operator: "eq", left: lit("2026-10-06"), right: lit("2026-10-06") }, { values: {} })).toBe(true);
    expect(evaluateExpression({ kind: "binary", operator: "neq", left: lit("2026-10-06"), right: lit("2026-10-07") }, { values: {} })).toBe(true);
  });
});

describe("rules evaluator: plugin functions", () => {
  const double = { kind: "call", name: "double", args: [lit(21)] } as unknown as Expression;

  it("falls through to context.functions after every built-in", () => {
    expect(evaluateExpression(double, { values: {}, functions: { double: (args) => Number(args[0]) * 2 } })).toBe(42);
    expect(evaluateExpression(double, { values: {} })).toBeUndefined();
    expect(evaluateExpression(double, { values: {}, functions: {} })).toBeUndefined();
  });

  it("turns a throwing plugin function into undefined", () => {
    expect(
      evaluateExpression(double, {
        values: {},
        functions: {
          double: () => {
            throw new Error("boom");
          }
        }
      })
    ).toBeUndefined();
  });

  it("never lets a plugin shadow a built-in or a context-aware call", () => {
    const functions = { sum: () => 999, today: () => "1999-01-01", empty: () => "no" };
    expect(evaluateExpression(call("sum", lit(1), lit(2)), { values: {}, functions })).toBe(3);
    expect(evaluateExpression(call("today"), { values: {}, functions, today: "2026-10-07" })).toBe("2026-10-07");
    expect(evaluateExpression(call("empty", lit("")), { values: {}, functions })).toBe(true);
  });

  it("reads own properties only", () => {
    const functions = Object.create({ double: () => 1 }) as Record<string, (args: unknown[]) => unknown>;
    expect(evaluateExpression(double, { values: {}, functions })).toBeUndefined();
  });
});

describe("rules evaluator: reads through if branches", () => {
  const tree: Expression = {
    kind: "if",
    cases: [
      { when: { kind: "path", path: "a" }, then: { kind: "path", path: "b" } },
      { when: { kind: "path", path: "host.c" }, then: call("today") }
    ],
    else: { kind: "path", path: "d" }
  };

  it("lists every path in reading order", () => {
    expect(kernelExprReadPaths(tree)).toEqual(["a", "b", "host.c", "d"]);
    expect(kernelExprReadPaths({ kind: "if", cases: [] })).toEqual([]);
  });

  it("finds a host read in any branch", () => {
    expect(kernelExprReadsHost(tree)).toBe(true);
    expect(kernelExprReadsHost({ kind: "if", cases: [{ when: lit(true), then: lit(1) }], else: { kind: "path", path: "host.x" } })).toBe(true);
    expect(kernelExprReadsHost({ kind: "if", cases: [{ when: lit(true), then: lit(1) }], else: lit(2) })).toBe(false);
  });

  it("finds a clock read in any branch, through today and age", () => {
    expect(kernelExprReadsClock(tree)).toBe(true);
    expect(kernelExprReadsClock({ kind: "if", cases: [{ when: lit(true), then: lit(1) }], else: call("age", { kind: "path", path: "dob" }) })).toBe(true);
    expect(kernelExprReadsClock({ kind: "if", cases: [{ when: call("empty", { kind: "path", path: "x" }), then: lit(1) }] })).toBe(false);
    expect(kernelExprReadsClock({ kind: "logical", operator: "and", left: lit(true), right: { kind: "unary", operator: "not", operand: call("today") } })).toBe(true);
    expect(kernelExprReadsClock({ kind: "arithmetic", operator: "add", left: lit(1), right: call("sum", call("today")) })).toBe(true);
    expect(kernelExprReadsClock({ kind: "path", path: "today" })).toBe(false);
  });
});
