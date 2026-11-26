import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import { extractDependencies } from "../form-engine/rules/dependencies/dependency-extractor.js";
import { isEvaluableExpression } from "../form-engine/core/expressions/condition-shape.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import {
  evaluateExpression,
  kernelExprExpandedOver,
  kernelExprListTooLong,
  kernelExprPluginProblem,
  kernelExprReadKeyed,
  kernelExprReadPaths,
  kernelExprReadsClock,
  kernelExprReadsHost,
  type RuleEvaluationContext
} from "../form-engine/rules/evaluator/evaluator.js";

describe("expression evaluator", () => {
  it("evaluates deterministic visibility rule", () => {
    const expression: Expression = {
      kind: "logical",
      operator: "and",
      left: {
        kind: "binary",
        operator: "eq",
        left: { kind: "path", path: "country" },
        right: { kind: "literal", value: "CA" }
      },
      right: {
        kind: "binary",
        operator: "gt",
        left: { kind: "path", path: "age" },
        right: { kind: "literal", value: 17 }
      }
    };

    const result = evaluateExpression(expression, {
      values: { country: "CA", age: 22 }
    });

    expect(result).toBe(true);
  });

  it("supports row and host scoped lookups", () => {
    const expression: Expression = {
      kind: "logical",
      operator: "and",
      left: {
        kind: "binary",
        operator: "eq",
        left: { kind: "path", path: "row.status" },
        right: { kind: "literal", value: "active" }
      },
      right: {
        kind: "binary",
        operator: "eq",
        left: { kind: "path", path: "host.region" },
        right: { kind: "literal", value: "QC" }
      }
    };

    const result = evaluateExpression(expression, {
      values: {},
      rowValues: { status: "active" },
      hostContext: { region: "QC" }
    });

    expect(result).toBe(true);
  });

  it("extracts referenced paths", () => {
    const expression: Expression = {
      kind: "logical",
      operator: "or",
      left: { kind: "path", path: "a" },
      right: {
        kind: "binary",
        operator: "gt",
        left: { kind: "path", path: "b" },
        right: { kind: "literal", value: 1 }
      }
    };

    const deps = extractDependencies(expression);
    expect([...deps]).toEqual(["a", "b"]);
  });
});

describe("expression evaluator: if", () => {
  const ifExpression: Expression = {
    kind: "if",
    cases: [
      {
        when: { kind: "binary", operator: "eq", left: { kind: "path", path: "plan" }, right: { kind: "literal", value: "basic" } },
        then: { kind: "literal", value: 10 }
      },
      {
        when: { kind: "binary", operator: "eq", left: { kind: "path", path: "plan" }, right: { kind: "literal", value: "pro" } },
        then: { kind: "path", path: "proPrice" }
      }
    ]
  };

  it("yields the then of the first case that holds", () => {
    expect(evaluateExpression(ifExpression, { values: { plan: "basic", proPrice: 99 } })).toBe(10);
    expect(evaluateExpression(ifExpression, { values: { plan: "pro", proPrice: 99 } })).toBe(99);
  });

  it("yields undefined when no case holds and there is no else", () => {
    expect(evaluateExpression(ifExpression, { values: { plan: "other" } })).toBeUndefined();
    expect(evaluateExpression({ kind: "if", cases: [] }, { values: {} })).toBeUndefined();
  });

  it("yields the else when no case holds", () => {
    const withElse: Expression = { ...ifExpression, else: { kind: "literal", value: 0 } };
    expect(evaluateExpression(withElse, { values: { plan: "other" } })).toBe(0);
    expect(evaluateExpression(withElse, { values: { plan: "basic" } })).toBe(10);
  });

  it("extracts dependencies from every branch, taken or not", () => {
    const withElse: Expression = { ...ifExpression, else: { kind: "path", path: "fallback" } };
    expect([...extractDependencies(withElse)]).toEqual(["plan", "proPrice", "fallback"]);
  });
});

/**
 * Arithmetic as DMN FEEL has it: an operand that is not a finite number, or a division by
 * zero, gives no answer (`undefined`), never `NaN` or `Infinity`. A calculation that comes to
 * no answer leaves its field empty, on both sides alike.
 */
describe("expression evaluator: arithmetic over no answer", () => {
  const arith = (operator: "add" | "subtract" | "multiply" | "divide", left: Expression, right: Expression): Expression => ({ kind: "arithmetic", operator, left, right });
  const path = (name: string): Expression => ({ kind: "path", path: name });
  const lit = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });

  it.each([
    ["a missing operand", arith("multiply", path("employees"), lit(2)), {}],
    ["a null operand", arith("add", path("n"), lit(1)), { n: null }],
    ["a blank text", arith("add", path("n"), lit(1)), { n: "  " }],
    ["a non-numeric text", arith("subtract", lit(10), path("n")), { n: "ten" }],
    ["a boolean", arith("multiply", path("n"), lit(10)), { n: true }],
    ["a list", arith("add", path("n"), lit(1)), { n: [1] }],
    ["an object", arith("add", path("n"), lit(1)), { n: { a: 1 } }],
    ["a stored NaN", arith("add", path("n"), lit(1)), { n: Number.NaN }],
    ["a stored Infinity", arith("add", path("n"), lit(1)), { n: Number.POSITIVE_INFINITY }],
    ["division by zero", arith("divide", path("income"), path("members")), { income: 1200, members: 0 }],
    ["division by an empty answer", arith("divide", path("income"), path("members")), { income: 1200 }],
    ["a result past the finite range", arith("multiply", lit(1e308), lit(10)), {}],
    ["no answer feeding the next operation", arith("add", arith("multiply", path("employees"), lit(2)), lit(5)), {}]
  ])("%s is no answer", (_label, expression, values) => {
    expect(evaluateExpression(expression, { values })).toBeUndefined();
  });

  it("still computes over numbers and numeric text, zero included", () => {
    expect(evaluateExpression(arith("multiply", path("employees"), lit(2)), { values: { employees: 21 } })).toBe(42);
    expect(evaluateExpression(arith("multiply", path("employees"), lit(2)), { values: { employees: "21" } })).toBe(42);
    expect(evaluateExpression(arith("multiply", path("employees"), lit(2)), { values: { employees: 0 } })).toBe(0);
    expect(evaluateExpression(arith("divide", lit(0), lit(4)), { values: {} })).toBe(0);
    expect(evaluateExpression(arith("divide", path("income"), path("members")), { values: { income: 1200, members: 3 } })).toBe(400);
  });

  it("gives the one-argument number functions no answer over a non-number", () => {
    for (const name of ["abs", "round", "floor", "ceil"] as const) {
      expect(evaluateExpression({ kind: "call", name, args: [path("n")] }, { values: {} }), name).toBeUndefined();
      expect(evaluateExpression({ kind: "call", name, args: [path("n")] }, { values: { n: "x" } }), name).toBeUndefined();
      expect(evaluateExpression({ kind: "call", name, args: [path("n")] }, { values: { n: Number.NaN } }), name).toBeUndefined();
    }
    expect(evaluateExpression({ kind: "call", name: "abs", args: [lit(-2.5)] }, { values: {} })).toBe(2.5);
    expect(evaluateExpression({ kind: "call", name: "round", args: [lit("2.5")] }, { values: {} })).toBe(3);
  });

  it("reads a missing answer and null as the same nothing under = and !=", () => {
    const eq = (left: Expression, right: Expression): Expression => ({ kind: "binary", operator: "eq", left, right });
    const neq = (left: Expression, right: Expression): Expression => ({ kind: "binary", operator: "neq", left, right });
    // A calculation that came to no answer, and a field never filled, both equal null.
    expect(evaluateExpression(eq(path("ratio"), lit(null)), { values: {} })).toBe(true);
    expect(evaluateExpression(eq(path("ratio"), lit(null)), { values: { ratio: null } })).toBe(true);
    expect(evaluateExpression(neq(path("ratio"), lit(null)), { values: {} })).toBe(false);
    expect(evaluateExpression(neq(path("ratio"), lit(null)), { values: { ratio: 400 } })).toBe(true);
    expect(evaluateExpression(eq(arith("divide", lit(1), lit(0)), lit(null)), { values: {} })).toBe(true);
    // Nothing else is nothing: 0, false and "" are answers.
    expect(evaluateExpression(eq(path("n"), lit(null)), { values: { n: 0 } })).toBe(false);
    expect(evaluateExpression(eq(path("n"), lit(null)), { values: { n: false } })).toBe(false);
    expect(evaluateExpression(eq(path("n"), lit(null)), { values: { n: "" } })).toBe(false);
    expect(evaluateExpression(eq(path("a"), path("b")), { values: { a: 1, b: "1" } })).toBe(false);
  });
});

const SIGNATURES = [
  ...formulaFunctionSignatures(),
  { name: "spy", min: 0, max: 0 },
  { name: "odd", min: 0, max: 0 },
  { name: "plugin", min: 0, max: 0 },
  { name: "f", min: 0, max: 5 }
];

function read(text: string): Expression {
  const result = kernelParseFormula(text, SIGNATURES);
  if (!result.ok || result.expression === undefined) {
    throw new Error(`does not parse: ${text}`);
  }
  return result.expression;
}

/** A tree leaning left `terms` deep: `a0 op a1 op a2 ...`, built directly (no parser). */
function chain(kind: "logical" | "arithmetic" | "binary", operator: string, terms: number, leaf: (i: number) => Expression): Expression {
  let tree = leaf(0);
  for (let i = 1; i < terms; i += 1) {
    tree = { kind, operator, left: tree, right: leaf(i) } as Expression;
  }
  return tree;
}

describe("expression evaluator: long chains", () => {
  const TERMS = 20000;
  const leaf = (i: number): Expression => ({ kind: "path", path: `a${i}` });
  const ones: Record<string, unknown> = {};
  for (let i = 0; i < TERMS; i += 1) {
    ones[`a${i}`] = 1;
  }

  it("evaluates a 20,000-term and, or and sum without a stack overflow", () => {
    // Strict truthiness: only the boolean true holds, so the and/or operands are true, not 1.
    const trues: Record<string, unknown> = {};
    for (let i = 0; i < TERMS; i += 1) {
      trues[`a${i}`] = true;
    }
    expect(evaluateExpression(chain("logical", "and", TERMS, leaf), { values: trues })).toBe(true);
    expect(evaluateExpression(chain("logical", "or", TERMS, leaf), { values: { a19999: true } })).toBe(true);
    expect(evaluateExpression(chain("logical", "or", TERMS, leaf), { values: {} })).toBe(false);
    expect(evaluateExpression(chain("arithmetic", "add", TERMS, leaf), { values: ones })).toBe(TERMS);
    expect(evaluateExpression(chain("arithmetic", "subtract", TERMS, leaf), { values: ones })).toBe(2 - TERMS);
  });

  it("keeps the order and the short circuit of the recursive reading", () => {
    // `((a - b) - c)` and a mixed chain read left to right.
    expect(evaluateExpression(read("10 - 3 - 2"), { values: {} })).toBe(5);
    expect(evaluateExpression(read("100 / 5 / 2 + 1 * 3 - 4"), { values: {} })).toBe(9);
    expect(evaluateExpression(read("(1 < 2) = true"), { values: {} })).toBe(true);
    expect(evaluateExpression(read("a = 1 and b = 2 or c = 3"), { values: { a: 1, b: 9, c: 3 } })).toBe(true);
    expect(evaluateExpression(read("a = 1 and b = 2 or c = 3"), { values: { a: 1, b: 9, c: 4 } })).toBe(false);
    // A right operand is not evaluated when the left decides: a plugin that counts its calls.
    let calls = 0;
    const context: RuleEvaluationContext = { values: {}, functions: { spy: () => ((calls += 1), true) } };
    expect(evaluateExpression(read("false and spy() and spy()"), context)).toBe(false);
    expect(evaluateExpression(read("true or spy() or spy()"), context)).toBe(true);
    expect(calls).toBe(0);
    expect(evaluateExpression(read("true and spy() and spy()"), context)).toBe(true);
    expect(calls).toBe(2);
  });

  it("walks a 20,000-term chain for its reads, host, clock and shape", () => {
    const tree = chain("logical", "and", TERMS, leaf);
    const paths = kernelExprReadPaths(tree);
    expect(paths).toHaveLength(TERMS);
    expect(paths[0]).toBe("a0");
    expect(paths[TERMS - 1]).toBe(`a${TERMS - 1}`);
    expect([...extractDependencies(tree)]).toEqual(paths);
    expect(kernelExprReadsHost(tree)).toBe(false);
    expect(kernelExprReadsClock(tree)).toBe(false);
    expect(isEvaluableExpression(tree)).toBe(true);
    const host = chain("logical", "or", TERMS, (i) => ({ kind: "path", path: i === 0 ? "host.region" : `a${i}` }));
    expect(kernelExprReadsHost(host)).toBe(true);
    const clock = chain("arithmetic", "add", TERMS, (i) => (i === 0 ? { kind: "call", name: "today", args: [] } : leaf(i)));
    expect(kernelExprReadsClock(clock)).toBe(true);
    const broken = chain("logical", "and", TERMS, leaf) as { left: Expression };
    let spine: { left: unknown } = broken;
    for (let i = 0; i < TERMS - 2; i += 1) {
      spine = spine.left as { left: unknown };
    }
    spine.left = { kind: "nope" };
    expect(isEvaluableExpression(broken)).toBe(false);
  });

  it("reads the paths of an if, a call and a unary in reading order", () => {
    expect(kernelExprReadPaths(read("if a then b else f(c, d)"))).toEqual(["a", "b", "c", "d"]);
    expect([...extractDependencies(read("if a then b else c + d"))]).toEqual(["a", "b", "c", "d"]);
    expect(kernelExprReadPaths(read("not(x) and y"))).toEqual(["x", "y"]);
  });
});

describe("expression evaluator: functions in a formula", () => {
  const rows: Array<[string, Record<string, unknown>, unknown]> = [
    // Text is a number only as a decimal numeral.
    ['"0x10" * 1', {}, undefined],
    ['"0b11" + 1', {}, undefined],
    ['"1e3" * 1', {}, 1000],
    ['" 12.5 " + 1', {}, 13.5],
    ['".5" + 1', {}, 1.5],
    ['"Infinity" + 1', {}, undefined],
    ['"1_000" + 1', {}, undefined],
    ['n < "0x10"', { n: 1 }, false],
    ['n < "10"', { n: 1 }, true],
    // Never negative zero.
    ["0 * -5", {}, 0],
    ["-0", {}, 0],
    ["z / neg", { z: 0, neg: -4 }, 0],
    ["round(-0.4)", {}, 0],
    ["ceil(-0.5)", {}, 0],
    ["abs(-0)", {}, 0],
    ["sum(z, neg)", { z: 0, neg: 0 }, 0],
    ["min(0, 1)", {}, 0],
    // Min and max over a long list never spread it. The cap
    // is 10,000 items, so these lists stay at the cap and 300,000 items give no answer.
    ["max(l)", { l: Array.from({ length: 10000 }, (_, i) => i) }, 9999],
    ["min(l)", { l: Array.from({ length: 10000 }, (_, i) => 10000 - i) }, 1],
    ["sum(l)", { l: Array.from({ length: 10000 }, () => 1) }, 10000],
    ["sum(l)", { l: Array.from({ length: 300000 }, () => 1) }, undefined],
    ["sum(1e308, 1e308)", {}, undefined],
    // Upper, lower, len and concat read a text, a number or a yes-or-no only.
    ["upper(missing)", {}, undefined],
    ["upper(nothing)", { nothing: null }, undefined],
    ["upper(obj)", { obj: { a: 1 } }, undefined],
    ["lower(list)", { list: [1, 2] }, undefined],
    ['upper("abc")', {}, "ABC"],
    ["upper(5)", {}, "5"],
    ["lower(true)", {}, "true"],
    ["len(missing)", {}, undefined],
    ["len(obj)", { obj: {} }, undefined],
    ["len(list)", { list: [1, 2, 3] }, 3],
    ['len("abc")', {}, 3],
    ["len(emoji)", { emoji: "\u{1F600}" }, 1],
    ["len(12345)", {}, 5],
    ["concat(a, missing, b)", { a: "x", b: 2 }, "x2"],
    ["concat(a, obj)", { a: "x", obj: { k: 1 } }, undefined],
    ["concat(a, list)", { a: "x", list: [1] }, undefined],
    ["concat(a, nan)", { a: "x", nan: Number.NaN }, undefined],
    ["concat()", {}, ""],
    // Contains has no answer for a needle or a haystack it cannot work with.
    ['contains("undefined", missing)', {}, undefined],
    ['contains("null", nothing)', { nothing: null }, undefined],
    ['contains("abc", obj)', { obj: {} }, undefined],
    ["contains(5, 5)", {}, undefined],
    ["contains(missing, 5)", {}, undefined],
    ['contains("abc", "b")', {}, true],
    ['contains("a5", 5)', {}, true],
    ["contains(list, 2)", { list: [1, 2] }, true],
    ["contains(list, 9)", { list: [1, 2] }, false],
    ["contains(list, missing)", { list: [1, 2] }, undefined],
    // The age of someone not yet born is no answer.
    ['age(@"2030-01-01")', {}, undefined],
    ['age(@"2000-02-29")', {}, 26],
    ['age(@"2026-10-08")', {}, 0]
  ];

  it.each(rows)("%s", (formula, values, expected) => {
    expect(evaluateExpression(read(formula), { values, today: "2026-10-08" })).toBe(expected);
  });

  // A list function refuses a list over 10,000 items.
  it("refuses a list over the 10,000 item cap with one warning naming the function", () => {
    const big = Array.from({ length: 10001 }, (_, i) => i);
    const ok = Array.from({ length: 10000 }, () => 1);
    for (const name of ["sum", "min", "max", "count", "first", "last", "distinct", "sort", "reverse", "any", "all", "join"]) {
      const lines: string[] = [];
      const context: RuleEvaluationContext = { values: { big }, warn: (message) => lines.push(message) };
      const args = name === "join" ? "big, \",\"" : "big";
      expect(evaluateExpression(read(`${name}(${args})`), context), name).toBeUndefined();
      expect(lines, name).toEqual([`${name}: the list is over the 10000 item cap; no answer`]);
    }
    expect(evaluateExpression(read("sum(ok)"), { values: { ok } })).toBe(10000);
    expect(evaluateExpression(read("append(big, 1)"), { values: { big } })).toBeUndefined();
    expect(evaluateExpression(read("pluck(big, \"a\")"), { values: { big } })).toBeUndefined();
    const pieces: string[] = [];
    expect(evaluateExpression(read('split(t, "a")'), { values: { t: "a".repeat(10000) }, warn: (m) => pieces.push(m) })).toBeUndefined();
    expect(pieces).toEqual(["split: the result is over the 10000 item cap; no answer"]);
  });

  it("never throws out of a call: a failing function is no answer and a line to warn", () => {
    const lines: string[] = [];
    const list = [1, 2, 3];
    Object.defineProperty(list, 1, { get: () => { throw new Error("unreadable"); } });
    const context: RuleEvaluationContext = { values: { list }, warn: (message) => lines.push(message) };
    expect(evaluateExpression(read("max(list)"), context)).toBeUndefined();
    expect(lines).toEqual(["max: the call failed (unreadable); no answer"]);
    // A warn sink that itself throws changes nothing.
    expect(evaluateExpression(read("max(list)"), { values: { list }, warn: () => { throw new Error("sink"); } })).toBeUndefined();
    // A plugin that throws, or returns a value that cannot be inspected, is no answer either.
    const hostile = new Proxy({}, { getPrototypeOf: () => { throw new Error("no proto"); } });
    expect(evaluateExpression(read("odd()"), { values: {}, functions: { odd: () => hostile } })).toBeUndefined();
    expect(evaluateExpression(read("odd()"), { values: {}, functions: { odd: () => { throw new Error("boom"); } } })).toBeUndefined();
  });
});

describe("expression evaluator: plugin results", () => {
  class Money {
    public readonly cents = 100;
  }
  const results: Array<[string, unknown, boolean]> = [
    ["NaN", Number.NaN, true],
    ["Infinity", Number.POSITIVE_INFINITY, true],
    ["a promise", Promise.resolve(1), true],
    ["a thenable", { then: () => undefined }, true],
    ["a function", () => 1, true],
    ["a date", new Date(0), true],
    ["a class instance", new Money(), true],
    ["a map", new Map(), true],
    ["a symbol", Symbol("x"), true],
    ["a bigint", BigInt(1), true],
    ["a list holding NaN", [1, Number.NaN], true],
    ["an object holding a function", { a: { b: () => 1 } }, true],
    ["a plain object with a null prototype", Object.assign(Object.create(null), { a: 1 }), false],
    ["undefined", undefined, false],
    ["null", null, false],
    ["a number", 3.5, false],
    ["zero", 0, false],
    ["a text", "x", false],
    ["a boolean", false, false],
    ["a list of plain data", [1, "a", null, { b: [true] }], false],
    ["a plain object", { a: 1, then: "later" }, false]
  ];

  it.each(results)("%s", (_label, result, problem) => {
    expect(kernelExprPluginProblem(result) !== undefined).toBe(problem);
    const lines: string[] = [];
    const context: RuleEvaluationContext = { values: {}, functions: { plugin: () => result }, warn: (message) => lines.push(message) };
    const answer = evaluateExpression(read("plugin()"), context);
    if (problem) {
      expect(answer).toBeUndefined();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('"plugin"');
    } else {
      expect(answer).toBe(result);
      expect(lines).toEqual([]);
    }
  });

  it("refuses a value nested too deeply or cyclic", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(kernelExprPluginProblem(loop)).toBe("a value nested too deeply");
  });
});

// A condition holds only for the boolean true, and
// two texts order by UTF-16 code unit.
describe("expression evaluator: strict truthiness", () => {
  const values = { yes: true, no: false, text: "yes", falseText: "false", one: 1, zero: 0, none: null, list: ["a"], emptyList: [], flags: { a: true }, noneTicked: { a: false } };
  const NOT_TRUE = ["no", "text", "falseText", "one", "zero", "none", "missing", "list", "emptyList", "flags", "noneTicked"];

  it("holds for the boolean true alone", () => {
    expect(evaluateExpression(read("if yes then 1 else 2"), { values })).toBe(1);
    expect(evaluateExpression(read("not yes"), { values })).toBe(false);
    expect(evaluateExpression(read("yes and yes"), { values })).toBe(true);
    expect(evaluateExpression(read("no or yes"), { values })).toBe(true);
  });

  it.each(NOT_TRUE)("%s does not hold in if, not, and, or", (name) => {
    expect(evaluateExpression(read(`if ${name} then 1 else 2`), { values }), "if").toBe(2);
    expect(evaluateExpression(read(`not ${name}`), { values }), "not").toBe(true);
    expect(evaluateExpression(read(`${name} and yes`), { values }), "and left").toBe(false);
    expect(evaluateExpression(read(`yes and ${name}`), { values }), "and right").toBe(false);
    expect(evaluateExpression(read(`${name} or no`), { values }), "or left").toBe(false);
    expect(evaluateExpression(read(`no or ${name}`), { values }), "or right").toBe(false);
  });

  it("reads these cases: text, an empty list and an unticked group are no yes", () => {
    expect(evaluateExpression(read("not falseText"), { values })).toBe(true);
    expect(evaluateExpression(read("if emptyList then 1 else 2"), { values })).toBe(2);
    expect(evaluateExpression(read("if noneTicked then 1 else 2"), { values })).toBe(2);
    expect(evaluateExpression(read(`"x" or 0`), { values })).toBe(false);
    expect(evaluateExpression(read("1 and 2"), { values })).toBe(false);
  });

  it("gives and, or and not a boolean always, and an else-less if no answer", () => {
    expect(evaluateExpression(read("text and text"), { values })).toBe(false);
    expect(evaluateExpression(read("text or text"), { values })).toBe(false);
    expect(evaluateExpression(read("if one then 1"), { values })).toBeUndefined();
  });
});

describe("expression evaluator: text ordering by code unit", () => {
  const holds = (text: string, values: Record<string, unknown> = {}): unknown => evaluateExpression(read(text), { values });

  it("orders two texts by UTF-16 code unit, equal texts included", () => {
    expect(holds(`"abc" <= "abc"`)).toBe(true);
    expect(holds(`"abc" >= "abc"`)).toBe(true);
    expect(holds(`"abc" < "abc"`)).toBe(false);
    expect(holds(`"b" > "a"`)).toBe(true);
    expect(holds(`"apple" < "banana"`)).toBe(true);
    expect(holds(`name > "M"`, { name: "Zed" })).toBe(true);
    expect(holds(`name > "M"`, { name: "Adams" })).toBe(false);
    // Code units, not alphabet: every capital sorts before every lower-case letter.
    expect(holds(`"Z" < "a"`)).toBe(true);
    expect(holds(`"a" < "é"`)).toBe(true);
    // Two numeral texts order as numbers: "10" is above "9"; other text by code unit.
    expect(holds(`"10" > "9"`)).toBe(true);
    expect(holds(`"10" < "9"`)).toBe(false);
    expect(holds(`" 10 " >= "9.5"`)).toBe(true);
    expect(holds(`"1e3" > "999"`)).toBe(true);
    expect(holds(`"10a" < "9a"`)).toBe(true);
    expect(holds(`number("10") > number("9")`)).toBe(true);
  });

  it("keeps the day rule, and a non-day is just a text", () => {
    expect(holds(`@"2026-01-05" < @"2026-02-01"`)).toBe(true);
    expect(holds(`d < "2026-02-01"`, { d: "2026-01-05" })).toBe(true);
    // Not padded: "2026-1-5" is no day, so it orders as text against "2026-01-05" ('1' is above '0').
    expect(holds(`d3 > d`, { d: "2026-01-05", d3: "2026-1-5" })).toBe(true);
    // An invalid day (the 30th of February) orders as text too.
    expect(holds(`d2 > d`, { d: "2026-01-01", d2: "2026-02-30" })).toBe(true);
  });

  it("still never orders mixed kinds", () => {
    expect(holds(`"abc" > 5`)).toBe(false);
    expect(holds(`"abc" < 5`)).toBe(false);
    expect(holds(`5 < "abc"`)).toBe(false);
    expect(holds(`flag > "a"`, { flag: true })).toBe(false);
    expect(holds(`u > "a"`)).toBe(false);
    expect(holds(`u <= "a"`)).toBe(false);
    // A numeral text against a number is a number: unchanged.
    expect(holds(`"10" > 9`)).toBe(true);
  });
});

/** The scan the walk of dotted prefixes replaced: every own key, the longest one the path starts with. */
function scanReadKeyed(source: unknown, path: string): unknown {
  if (source === null || typeof source !== "object") {
    return undefined;
  }
  const record = source as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(record, path)) {
    return record[path];
  }
  let longest: string | undefined;
  for (const key of Object.keys(record)) {
    if (path.startsWith(`${key}.`) && (longest === undefined || key.length > longest.length)) {
      longest = key;
    }
  }
  return longest === undefined ? undefined : scanReadKeyed(record[longest], path.slice(longest.length + 1));
}

describe("expression evaluator: keyed reads walk the path's dots", () => {
  const proto = <T extends Record<string, unknown>>(entries: T): Record<string, unknown> => Object.assign(Object.create(null) as Record<string, unknown>, entries);
  const record: Record<string, unknown> = {
    name: "Ada",
    "addr.city": "Paris",
    addr: { city: "Lyon", "geo.lat": 45, geo: { lng: 4 } },
    "order.items": { "0": { sku: "a" } },
    "a.b": { "c.d": 1, c: { d: 2 } },
    "a.b.c": { d: 3 },
    "": { x: "empty key" },
    constructor: "own constructor",
    toString: { valueOf: 7 },
    "__proto__.x": 9,
    list: [10, 20, { n: 30 }],
    deep: { deeper: { deepest: "bottom" } }
  };
  Object.defineProperty(record, "hidden", { value: { inside: "non-enumerable" }, enumerable: false });
  const paths = [
    "name", "name.x", "missing", "missing.deeper", "addr.city", "addr.geo.lat", "addr.geo.lng", "addr.nothing",
    "order.items.0.sku", "order.items.0", "order.items", "order", "a.b.c.d", "a.b.c", "a.b", "a", "a.b.c.d.e",
    ".x", "x", "", ".", "..", "name.", ".name", "a..b", "addr..city", "constructor", "constructor.x", "toString.valueOf",
    "toString", "valueOf", "hasOwnProperty", "__proto__", "__proto__.x", "__proto__.y", "list.0", "list.2.n", "list.length",
    "deep.deeper.deepest", "deep.deeper", "deep.missing.deepest", "hidden.inside", "hidden"
  ];

  it("reads what the scan of every key read, path by path", () => {
    for (const path of paths) {
      expect(kernelExprReadKeyed(record, path), path).toStrictEqual(scanReadKeyed(record, path));
      expect(kernelExprReadKeyed(proto(record), path), `bare ${path}`).toStrictEqual(scanReadKeyed(proto(record), path));
    }
  });

  it("takes the longest key the path starts with, and does not fall back to a shorter one", () => {
    expect(kernelExprReadKeyed(record, "addr.city")).toBe("Paris");
    expect(kernelExprReadKeyed(record, "a.b.c.d")).toBe(3);
    expect(kernelExprReadKeyed(record, "a.b.c.e")).toBeUndefined();
    expect(kernelExprReadKeyed(record, "addr.geo.lat")).toBe(45);
    expect(kernelExprReadKeyed(record, "order.items.0.sku")).toBe("a");
    expect(kernelExprReadKeyed(record, ".x")).toBe("empty key");
  });

  it("reads own keys only: no prototype member, and a wide row reads like a narrow one", () => {
    expect(kernelExprReadKeyed({}, "constructor")).toBeUndefined();
    expect(kernelExprReadKeyed({}, "toString.x")).toBeUndefined();
    expect(kernelExprReadKeyed({ a: 1 }, "a.constructor")).toBeUndefined();
    const wide: Record<string, unknown> = { "addr.city": "Paris" };
    for (let i = 0; i < 500; i += 1) {
      wide[`field${String(i)}`] = i;
    }
    expect(kernelExprReadKeyed(wide, "addr.city")).toBe("Paris");
    expect(kernelExprReadKeyed(wide, "missing")).toBeUndefined();
    expect(kernelExprReadKeyed(wide, "field499")).toBe(499);
  });

  it("reaches it from a row. and an ancestor. path in an expression", () => {
    const read = (path: string, context: Partial<RuleEvaluationContext>): unknown =>
      evaluateExpression({ kind: "path", path }, { values: {}, ...context });
    expect(read("row.addr.city", { rowValues: record })).toBe("Paris");
    expect(read("row.missing", { rowValues: record })).toBeUndefined();
    expect(read("row.constructor", { rowValues: proto({}) })).toBeUndefined();
    expect(read("ancestor.order.items.0.sku", { ancestorValues: record })).toBe("a");
  });
});

describe("expression evaluator: list cap check looks at the arguments first", () => {
  const big = Array.from({ length: 10001 }, (_, i) => i);
  const lines = (): { said: string[]; context: RuleEvaluationContext } => {
    const said: string[] = [];
    return { said, context: { values: {}, warn: (message) => said.push(message) } };
  };

  it("refuses a list function over the cap, saying so once, and no other function", () => {
    for (const name of ["sum", "min", "max", "avg", "count", "contains", "indexOf", "first", "last", "distinct", "sort", "reverse", "append", "pluck", "any", "all", "join", "split"]) {
      const { said, context } = lines();
      expect(kernelExprListTooLong(name, [big], context), name).toBe(true);
      expect(said, name).toEqual([`${name}: the list is over the 10000 item cap; no answer`]);
    }
    for (const name of ["len", "upper", "trim", "nope", "plugin", "empty", "selected", "coalesce", "concat", ""]) {
      const { said, context } = lines();
      expect(kernelExprListTooLong(name, [big], context), name).toBe(false);
      expect(said, name).toEqual([]);
    }
  });

  it("lets a call with no list, or a list at the cap, through", () => {
    const { said, context } = lines();
    expect(kernelExprListTooLong("sum", [], context)).toBe(false);
    expect(kernelExprListTooLong("sum", [1, "2", null, undefined, { a: 1 }], context)).toBe(false);
    expect(kernelExprListTooLong("sum", [big.slice(0, 10000)], context)).toBe(false);
    expect(kernelExprListTooLong("sum", [[], "x", big.slice(0, 10000)], context)).toBe(false);
    expect(said).toEqual([]);
  });

  it("finds the over-long list wherever it sits among the arguments", () => {
    const { said, context } = lines();
    expect(kernelExprListTooLong("join", ["x", 1, [1], big], context)).toBe(true);
    expect(said).toEqual(["join: the list is over the 10000 item cap; no answer"]);
    expect(evaluateExpression({ kind: "call", name: "sum", args: [{ kind: "path", path: "items" }] }, { values: { items: big } })).toBeUndefined();
    expect(evaluateExpression({ kind: "call", name: "len", args: [{ kind: "path", path: "items" }] }, { values: { items: big } })).toBe(10001);
  });
});

describe("expression evaluator: the item cap counts the tree a list expands to", () => {
  const append = (list: Expression, item: Expression): Expression => ({ kind: "call", name: "append", args: [list, item] });
  const path = (name: string): Expression => ({ kind: "path", path: name });

  it("refuses an append chain whose items share structure, at the link that crosses the cap", () => {
    const said: string[] = [];
    const context: RuleEvaluationContext = { values: {}, warn: (message) => said.push(message) };
    let list: unknown = ["a", "b"];
    let links = 0;
    // append(prev, prev) is prev with itself as one more item: a few items, 2^n once expanded.
    while (list !== undefined && links < 40) {
      list = evaluateExpression(append(path("l"), path("l")), { ...context, values: { l: list } });
      links += 1;
    }
    expect(links).toBeLessThan(40);
    expect(said.some((message) => message === "append: the result is over the 10000 item cap; no answer")).toBe(true);
  });

  it("walks at most the cap whatever the structure, and counts each copy of a shared list", () => {
    let shared: unknown[] = ["a", "b"];
    for (let i = 0; i < 60; i += 1) {
      shared = [shared, shared];
    }
    expect(kernelExprExpandedOver(shared, 10000)).toBe(true);
    expect(kernelExprExpandedOver(Array.from({ length: 10000 }, (_, i) => i), 10000)).toBe(false);
    expect(kernelExprExpandedOver(Array.from({ length: 10001 }, (_, i) => i), 10000)).toBe(true);
    expect(kernelExprExpandedOver([[1, 2], { a: [3] }], 10000)).toBe(false);
    expect(kernelExprExpandedOver("text", 1)).toBe(false);
    expect(kernelExprExpandedOver(null, 1)).toBe(false);
  });
});

describe("expression evaluator: one operator over two operands, and call arguments", () => {
  const path = (name: string): Expression => ({ kind: "path", path: name });
  const literal = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });

  it("reads and, or, comparisons and arithmetic as before, short-circuits included", () => {
    let reads = 0;
    const functions = { probe: () => { reads += 1; return true; } };
    const probe: Expression = { kind: "call", name: "probe", args: [] };
    const context: RuleEvaluationContext = { values: { yes: true, no: false, n: 6, text: "6" }, functions };
    expect(evaluateExpression({ kind: "logical", operator: "and", left: path("no"), right: probe }, context)).toBe(false);
    expect(reads).toBe(0);
    expect(evaluateExpression({ kind: "logical", operator: "or", left: path("yes"), right: probe }, context)).toBe(true);
    expect(reads).toBe(0);
    expect(evaluateExpression({ kind: "logical", operator: "and", left: path("yes"), right: probe }, context)).toBe(true);
    expect(evaluateExpression({ kind: "logical", operator: "or", left: path("no"), right: probe }, context)).toBe(true);
    expect(reads).toBe(2);
    expect(evaluateExpression({ kind: "logical", operator: "and", left: path("n"), right: probe }, context)).toBe(false);
    expect(evaluateExpression({ kind: "binary", operator: "eq", left: path("n"), right: literal(6) }, context)).toBe(true);
    expect(evaluateExpression({ kind: "binary", operator: "gt", left: path("text"), right: literal(5) }, context)).toBe(true);
    expect(evaluateExpression({ kind: "arithmetic", operator: "add", left: path("n"), right: literal(1) }, context)).toBe(7);
    expect(evaluateExpression({ kind: "arithmetic", operator: "divide", left: path("n"), right: literal(0) }, context)).toBeUndefined();
  });

  it("gives a chain the value its single operators give, left to right", () => {
    const context: RuleEvaluationContext = { values: { a: 2, b: 3, c: 4 } };
    const sum: Expression = {
      kind: "arithmetic", operator: "add",
      left: { kind: "arithmetic", operator: "multiply", left: path("a"), right: path("b") },
      right: path("c")
    };
    expect(evaluateExpression(sum, context)).toBe(10);
    const nested: Expression = {
      kind: "arithmetic", operator: "multiply",
      left: path("a"),
      right: { kind: "arithmetic", operator: "add", left: path("b"), right: path("c") }
    };
    expect(evaluateExpression(nested, context)).toBe(14);
  });

  it("evaluates a call's arguments in order, once each, and hands them over as a list", () => {
    const order: string[] = [];
    const seen: unknown[][] = [];
    const functions = {
      note: (args: unknown[]) => { order.push(String(args[0])); return args[0]; },
      take: (args: unknown[]) => { seen.push(args); return args.length; }
    };
    const note = (text: string): Expression => ({ kind: "call", name: "note", args: [literal(text)] });
    const call: Expression = { kind: "call", name: "take", args: [note("one"), note("two"), literal(3), path("missing")] };
    expect(evaluateExpression(call, { values: {}, functions })).toBe(4);
    expect(order).toEqual(["one", "two"]);
    expect(seen).toEqual([["one", "two", 3, undefined]]);
    expect(Array.isArray(seen[0])).toBe(true);
    expect(evaluateExpression({ kind: "call", name: "take", args: [] }, { values: {}, functions })).toBe(0);
  });
});
