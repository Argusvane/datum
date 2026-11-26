import { describe, expect, it } from "vitest";

import type { Expression, ExpressionFunctionName } from "../form-engine/core/expressions/expression.js";
import { formulaFunctionSignatures } from "../form-engine/core/expressions/function-table.js";
import type { FormulaFunctionSignature, FormulaParseResult } from "../form-engine/core/expressions/formula-types.js";
import { FORMULA_FUNCTIONS, kernelParseFormula } from "../form-engine/core/expressions/formula.js";

const SIGNATURES = formulaFunctionSignatures();

function parse(text: string, signatures: FormulaFunctionSignature[] = SIGNATURES): FormulaParseResult {
  return kernelParseFormula(text, signatures);
}

function tree(text: string): Expression {
  const result = parse(text);
  if (!result.ok) {
    throw new Error(`${text}: ${result.code} ${result.message} [${result.start}, ${result.end})`);
  }
  if (result.expression === undefined) {
    throw new Error(`${text}: no expression`);
  }
  return result.expression;
}

function failure(text: string) {
  const result = parse(text);
  if (result.ok) {
    throw new Error(`${text}: parsed as ${JSON.stringify(result.expression)}`);
  }
  return result;
}

const lit = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const path = (name: string): Expression => ({ kind: "path", path: name });
const bin = (operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte", left: Expression, right: Expression): Expression => ({ kind: "binary", operator, left, right });
const and = (left: Expression, right: Expression): Expression => ({ kind: "logical", operator: "and", left, right });
const or = (left: Expression, right: Expression): Expression => ({ kind: "logical", operator: "or", left, right });
const not = (operand: Expression): Expression => ({ kind: "unary", operator: "not", operand });
const arith = (operator: "add" | "subtract" | "multiply" | "divide", left: Expression, right: Expression): Expression => ({ kind: "arithmetic", operator, left, right });
const call = (name: ExpressionFunctionName, ...args: Expression[]): Expression => ({ kind: "call", name, args });
const ifNode = (cases: Array<{ when: Expression; then: Expression }>, otherwise?: Expression): Expression =>
  otherwise === undefined ? { kind: "if", cases } : { kind: "if", cases, else: otherwise };

describe("kernelParseFormula: literals and names", () => {
  it("blank text is a formula with no expression", () => {
    expect(parse("")).toStrictEqual({ ok: true, expression: undefined, paths: [] });
    expect(parse("  \n\t ")).toStrictEqual({ ok: true, expression: undefined, paths: [] });
  });

  it("reads numbers, strings with both quotes and escapes, booleans and null", () => {
    expect(tree("12")).toStrictEqual(lit(12));
    expect(tree("3.5")).toStrictEqual(lit(3.5));
    expect(tree(".5")).toStrictEqual(lit(0.5));
    expect(tree("1e3")).toStrictEqual(lit(1000));
    expect(tree('"a b"')).toStrictEqual(lit("a b"));
    expect(tree("'it'")).toStrictEqual(lit("it"));
    expect(tree('"say \\"hi\\"\\n"')).toStrictEqual(lit('say "hi"\n'));
    expect(tree("'it\\'s'")).toStrictEqual(lit("it's"));
    expect(tree('"back\\\\slash"')).toStrictEqual(lit("back\\slash"));
    expect(tree('"tab\\there"')).toStrictEqual(lit("tab\there"));
    expect(tree("true")).toStrictEqual(lit(true));
    expect(tree("false")).toStrictEqual(lit(false));
    expect(tree("null")).toStrictEqual(lit(null));
  });

  it("a negative literal folds without negative zero", () => {
    expect(tree("-5")).toStrictEqual(lit(-5));
    expect(tree("-1.5e2")).toStrictEqual(lit(-150));
    for (const text of ["-0", "-0.0", "-0e5"]) {
      const folded = tree(text);
      expect(folded.kind).toBe("literal");
      expect(Object.is((folded as { value: unknown }).value, 0), text).toBe(true);
    }
  });

  it("a date literal is a call to date", () => {
    expect(tree('@"2026-01-01"')).toStrictEqual(call("date", lit("2026-01-01")));
    expect(tree("@'2026-01-01'")).toStrictEqual(call("date", lit("2026-01-01")));
  });

  it("reads dotted names, glued hyphens, scopes and backticked odd names as paths", () => {
    expect(tree("email")).toStrictEqual(path("email"));
    expect(tree("first-name")).toStrictEqual(path("first-name"));
    expect(tree("line-2")).toStrictEqual(path("line-2"));
    expect(tree("row.amount")).toStrictEqual(path("row.amount"));
    expect(tree("ancestor.household.size")).toStrictEqual(path("ancestor.household.size"));
    expect(tree("host.region")).toStrictEqual(path("host.region"));
    expect(tree("component")).toStrictEqual(path("component"));
    expect(tree("`odd name`")).toStrictEqual(path("odd name"));
    expect(tree("`if`")).toStrictEqual(path("if"));
  });

  it("a hyphen with a space on either side subtracts", () => {
    expect(tree("a - b")).toStrictEqual(arith("subtract", path("a"), path("b")));
    expect(tree("a -b")).toStrictEqual(arith("subtract", path("a"), path("b")));
    expect(tree("a- b")).toStrictEqual(arith("subtract", path("a"), path("b")));
    expect(tree("a-b")).toStrictEqual(path("a-b"));
  });

  it("keywords are case-sensitive", () => {
    expect(tree("TRUE")).toStrictEqual(path("TRUE"));
    expect(tree("Null")).toStrictEqual(path("Null"));
    expect(failure("If a then b").code).toBe("expectedOperator");
  });

  it("lists every path read with its span, in source order, including repeats", () => {
    const result = parse("a + `b c` + a");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paths).toStrictEqual([
        { path: "a", start: 0, end: 1 },
        { path: "b c", start: 4, end: 9 },
        { path: "a", start: 12, end: 13 }
      ]);
    }
  });

  it("lists paths read inside calls, lists and branches", () => {
    const result = parse('if len(x) > 1 then y in ("a", z) else row.w');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paths.map((read) => read.path)).toStrictEqual(["x", "y", "z", "row.w"]);
    }
  });

  it("a backticked name is never a function", () => {
    expect(failure("`len`(a)").code).toBe("expectedOperator");
  });
});

describe("kernelParseFormula: precedence", () => {
  it("or is looser than and", () => {
    expect(tree("a or b and c")).toStrictEqual(or(path("a"), and(path("b"), path("c"))));
    expect(tree("(a or b) and c")).toStrictEqual(and(or(path("a"), path("b")), path("c")));
  });

  it("comparison is tighter than and, arithmetic tighter than comparison", () => {
    expect(tree("a = b and c")).toStrictEqual(and(bin("eq", path("a"), path("b")), path("c")));
    expect(tree("a = b + c * d")).toStrictEqual(bin("eq", path("a"), arith("add", path("b"), arith("multiply", path("c"), path("d")))));
    expect(tree("a == b")).toStrictEqual(bin("eq", path("a"), path("b")));
    expect(tree("a != b")).toStrictEqual(bin("neq", path("a"), path("b")));
    expect(tree("a <= b")).toStrictEqual(bin("lte", path("a"), path("b")));
    expect(tree("a >= b")).toStrictEqual(bin("gte", path("a"), path("b")));
    expect(tree("a < b")).toStrictEqual(bin("lt", path("a"), path("b")));
    expect(tree("a > b")).toStrictEqual(bin("gt", path("a"), path("b")));
  });

  it("arithmetic is left-associative", () => {
    expect(tree("1 - 2 - 3")).toStrictEqual(arith("subtract", arith("subtract", lit(1), lit(2)), lit(3)));
    expect(tree("8 / 2 / 2")).toStrictEqual(arith("divide", arith("divide", lit(8), lit(2)), lit(2)));
  });

  it("unary minus binds tighter than multiplication", () => {
    expect(tree("-a * b")).toStrictEqual(arith("multiply", arith("subtract", lit(0), path("a")), path("b")));
    expect(tree("2 - -3")).toStrictEqual(arith("subtract", lit(2), lit(-3)));
    expect(tree("-(1 + 2)")).toStrictEqual(arith("subtract", lit(0), arith("add", lit(1), lit(2))));
  });

  it("prefix not takes one whole comparison, canonical not(x) is a primary", () => {
    expect(tree("not a = b and c")).toStrictEqual(and(not(bin("eq", path("a"), path("b"))), path("c")));
    expect(tree("not(a = b and c)")).toStrictEqual(not(and(bin("eq", path("a"), path("b")), path("c"))));
    expect(tree("not(a) = b")).toStrictEqual(bin("eq", not(path("a")), path("b")));
    expect(tree("not not a")).toStrictEqual(not(not(path("a"))));
    expect(tree("not x between 1 and 2")).toStrictEqual(not(and(bin("gte", path("x"), lit(1)), bin("lte", path("x"), lit(2)))));
  });

  it("if is the loosest construct and still a value", () => {
    expect(tree("1 + if a then 2 else 3")).toStrictEqual(arith("add", lit(1), ifNode([{ when: path("a"), then: lit(2) }], lit(3))));
  });
});

describe("kernelParseFormula: between, in and intervals", () => {
  it("between lowers to and(gte, lte) and shares no node", () => {
    const result = tree("x between 1 and 5");
    expect(result).toStrictEqual(and(bin("gte", path("x"), lit(1)), bin("lte", path("x"), lit(5))));
    const left = (result as { left: { left: unknown } }).left.left;
    const right = (result as { right: { left: unknown } }).right.left;
    expect(left).not.toBe(right);
  });

  it("between binds its bounds at additive level", () => {
    expect(tree("x between a + 1 and b * 2 and y")).toStrictEqual(and(and(bin("gte", path("x"), arith("add", path("a"), lit(1))), bin("lte", path("x"), arith("multiply", path("b"), lit(2)))), path("y")));
  });

  it("in (list) folds eq over or from the left", () => {
    expect(tree('x in ("a", "b", "c")')).toStrictEqual(or(or(bin("eq", path("x"), lit("a")), bin("eq", path("x"), lit("b"))), bin("eq", path("x"), lit("c"))));
    expect(tree("x in (1)")).toStrictEqual(bin("eq", path("x"), lit(1)));
    expect(tree("x in (a or b, 2)")).toStrictEqual(or(bin("eq", path("x"), or(path("a"), path("b"))), bin("eq", path("x"), lit(2))));
  });

  it("the four interval forms", () => {
    expect(tree("x in [1..5]")).toStrictEqual(and(bin("gte", path("x"), lit(1)), bin("lte", path("x"), lit(5))));
    expect(tree("x in (1..5]")).toStrictEqual(and(bin("gt", path("x"), lit(1)), bin("lte", path("x"), lit(5))));
    expect(tree("x in [1..5)")).toStrictEqual(and(bin("gte", path("x"), lit(1)), bin("lt", path("x"), lit(5))));
    expect(tree("x in ]1..5[")).toStrictEqual(and(bin("gt", path("x"), lit(1)), bin("lt", path("x"), lit(5))));
    expect(tree("x in (1..5)")).toStrictEqual(and(bin("gt", path("x"), lit(1)), bin("lt", path("x"), lit(5))));
    expect(tree("x in [a..b]")).toStrictEqual(and(bin("gte", path("x"), path("a")), bin("lte", path("x"), path("b"))));
  });

  it("a date interval", () => {
    expect(tree('d in [@"2026-01-01"..@"2026-12-31"]')).toStrictEqual(and(bin("gte", path("d"), call("date", lit("2026-01-01"))), bin("lte", path("d"), call("date", lit("2026-12-31")))));
  });
});

describe("kernelParseFormula: if chains", () => {
  it("flattens else if into one node's cases", () => {
    const result = tree("if a then 1 else if b then 2 else if c then 3 else 4");
    expect(result).toStrictEqual({
      kind: "if",
      cases: [
        { when: path("a"), then: lit(1) },
        { when: path("b"), then: lit(2) },
        { when: path("c"), then: lit(3) }
      ],
      else: lit(4)
    });
  });

  it("omits the else key when no else is written", () => {
    const result = tree("if a then 1 else if b then 2");
    expect(result).toStrictEqual({ kind: "if", cases: [{ when: path("a"), then: lit(1) }, { when: path("b"), then: lit(2) }] });
    expect("else" in result).toBe(false);
  });

  it("branches are whole expressions; a nested if keeps its own else", () => {
    expect(tree("if a then if b then 1 else 2 else 3")).toStrictEqual({
      kind: "if",
      cases: [{ when: path("a"), then: { kind: "if", cases: [{ when: path("b"), then: lit(1) }], else: lit(2) } }],
      else: lit(3)
    });
    expect(tree("if a then b else c or d")).toStrictEqual({ kind: "if", cases: [{ when: path("a"), then: path("b") }], else: or(path("c"), path("d")) });
    expect(tree("if a = 1 and b then c + 1")).toStrictEqual({ kind: "if", cases: [{ when: and(bin("eq", path("a"), lit(1)), path("b")), then: arith("add", path("c"), lit(1)) }] });
  });
});

describe("kernelParseFormula: functions and arity", () => {
  it("the table has the rows the other groups lean on", () => {
    const names = new Set(SIGNATURES.map((signature) => signature.name));
    for (const name of ["len", "empty", "contains", "sum", "date", "today"]) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it("every table row parses at its minimum and fails one below and one above", () => {
    expect(SIGNATURES.length).toBeGreaterThan(0);
    for (const signature of SIGNATURES) {
      const { name, min, max } = signature;
      const args = (count: number) => Array.from({ length: count }, (_, index) => (index === 2 && (name === "dateAdd" || name === "dateDiff") ? '"days"' : `"v${index}"`)).join(", ");
      const ok = parse(`${name}(${args(min)})`);
      expect(ok.ok, `${name} with ${min} arguments`).toBe(true);
      if (ok.ok) {
        expect(ok.expression).toMatchObject({ kind: "call", name });
        expect((ok.expression as { args: unknown[] }).args).toHaveLength(min);
      }
      if (Number.isFinite(max)) {
        const atMax = parse(`${name}(${args(max)})`);
        expect(atMax.ok, `${name} with ${max} arguments`).toBe(true);
      }
      if (min > 0) {
        const text = `${name}(${args(min - 1)})`;
        const below = parse(text);
        expect(below.ok, `${name} with ${min - 1} arguments`).toBe(false);
        if (!below.ok) {
          if (Number.isFinite(max)) {
            expect(below.code).toBe("arity");
            expect(below.params).toMatchObject({ name, min, max, got: min - 1 });
          } else {
            expect(below.code).toBe("arityMin");
            expect(below.params).toStrictEqual({ name, min, got: min - 1 });
          }
          expect(below.start).toBe(0);
          expect(below.end).toBe(text.length);
        }
      }
      if (Number.isFinite(max)) {
        const text = `${name}(${args(max + 1)})`;
        const above = parse(text);
        expect(above.ok, `${name} with ${max + 1} arguments`).toBe(false);
        if (!above.ok) {
          expect(above.code).toBe("arity");
          expect(above.params).toMatchObject({ name, min, max, got: max + 1 });
          expect(above.params.expected).toBe(min === max ? max : `${min} to ${max}`);
          expect(above.start).toBe(0);
          expect(above.end).toBe(text.length);
        }
      } else {
        expect(parse(`${name}(${args(min + 5)})`).ok, `${name} variadic`).toBe(true);
      }
    }
  });

  it("an unknown function names the span of its name", () => {
    const result = failure("1 + nope(a, b)");
    expect(result.code).toBe("unknownFunction");
    expect(result.params).toStrictEqual({ name: "nope" });
    expect(result).toMatchObject({ start: 4, end: 8 });
    expect(parse("nope()", []).ok).toBe(false);
    expect(parse("len(a)", []).ok).toBe(false);
  });

  it("a plugin signature passed in is accepted with its own arity", () => {
    const signatures: FormulaFunctionSignature[] = [...SIGNATURES, { name: "postcodeRegion", min: 1, max: 1 }];
    const ok = parse("postcodeRegion(code)", signatures);
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.expression).toStrictEqual({ kind: "call", name: "postcodeRegion", args: [path("code")] });
    }
    const two = kernelParseFormula("postcodeRegion(a, b)", signatures);
    expect(two.ok).toBe(false);
    if (!two.ok) {
      expect(two.code).toBe("arity");
      expect(two.params).toStrictEqual({ name: "postcodeRegion", expected: 1, min: 1, max: 1, got: 2 });
    }
  });

  it("call arguments are whole expressions", () => {
    expect(tree("len(if a then b else c)")).toStrictEqual(call("len", ifNode([{ when: path("a"), then: path("b") }], path("c"))));
    expect(tree('empty(a) or contains(b, "x")')).toStrictEqual(or(call("empty", path("a")), call("contains", path("b"), lit("x"))));
    expect(tree("sum(a, b * 2, -c)")).toStrictEqual(call("sum", path("a"), arith("multiply", path("b"), lit(2)), arith("subtract", lit(0), path("c"))));
  });

  it("not() wants exactly one argument", () => {
    expect(failure("not()").code).toBe("expectedValueHere");
    const two = failure("not(a, b)");
    expect(two.code).toBe("arity");
    expect(two.params).toStrictEqual({ name: "not", expected: 1, min: 1, max: 1, got: 2 });
    expect(two).toMatchObject({ start: 0, end: 9 });
  });
});

describe("kernelParseFormula: errors with spans", () => {
  const table: Array<[string, string, number, number]> = [
    ["a +", "expectedValue", 3, 3],
    ["a + )", "expectedValueHere", 4, 5],
    ["a b", "expectedOperator", 2, 3],
    ["a then b", "expectedOperator", 2, 6],
    ["(a", "unclosedParen", 2, 2],
    ["len(a b)", "unclosedParen", 6, 7],
    ["a)", "unmatchedParen", 1, 2],
    [")", "expectedValueHere", 0, 1],
    ['"abc', "unterminatedString", 0, 4],
    ["'abc\\'", "unterminatedString", 0, 6],
    ["a = “x”", "curlyQuote", 4, 5],
    ["`odd", "unterminatedName", 0, 4],
    ["``", "emptyName", 0, 2],
    ["a # b", "badChar", 2, 3],
    ["@2026", "badChar", 0, 1],
    ["a < b < c", "chainedCompare", 6, 7],
    ["a = b between 1 and 2", "chainedCompare", 6, 13],
    ["x between 1 or 2", "betweenAnd", 12, 14],
    ["x between 1", "betweenAnd", 11, 11],
    ["x in 1", "inList", 5, 6],
    ["x in ()", "inList", 6, 7],
    ["x in [1, 2]", "intervalDots", 7, 8],
    ["x in [1...2]", "intervalDots", 7, 10],
    ["x in [10....20]", "intervalDots", 8, 11],
    ["x < 1e999", "numberTooLarge", 4, 9],
    ["-1e999", "numberTooLarge", 0, 6],
    ["2 * -1e400", "numberTooLarge", 4, 10],
    ["x in [1..1e999]", "numberTooLarge", 9, 14],
    ['dateAdd(@"2026-01-31", 1, "day")', "badUnit", 0, 32],
    ['dateDiff(a, b, "Years")', "badUnit", 0, 23],
    ["x in [1..2", "unclosedParen", 10, 10],
    ["if a b", "ifThen", 5, 6],
    ["if a", "ifThen", 4, 4],
    ["if a then", "expectedValue", 9, 9],
    ["else 1", "expectedValueHere", 0, 4],
    ["a + not b", "expectedValueHere", 4, 7],
    ["é", "badChar", 0, 1],
    ["\u{1F600}", "badChar", 0, 2]
  ];

  it.each(table)("%s → %s [%i, %i)", (text, code, start, end) => {
    const result = failure(text);
    expect(result.code).toBe(code);
    expect(result.start).toBe(start);
    expect(result.end).toBe(end);
    expect(typeof result.message).toBe("string");
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.params).toBeTypeOf("object");
  });

  it("accepts the largest finite literal, a spaced range and a field read as the unit", () => {
    expect(kernelParseFormula("x < 1e308", SIGNATURES).ok).toBe(true);
    expect(kernelParseFormula("x in [1.. .5]", SIGNATURES).ok).toBe(true);
    expect(kernelParseFormula('dateAdd(d, 1, "weeks")', SIGNATURES).ok).toBe(true);
    expect(kernelParseFormula("dateAdd(d, 1, unit)", SIGNATURES).ok).toBe(true);
    expect(failure("x < 1e309").code).toBe("numberTooLarge");
  });

  it("params carry the documented keys", () => {
    expect(failure("x < 1e999").params).toStrictEqual({ token: "1e999" });
    expect(failure("x in [1...2]").params).toStrictEqual({ token: "..." });
    expect(failure('dateAdd(d, 1, "day")').params).toStrictEqual({ name: "dateAdd", unit: "day" });
    expect(failure("a b").params).toStrictEqual({ token: "b" });
    expect(failure("a # b").params).toStrictEqual({ char: "#" });
    expect(failure("\u{1F600}").params).toStrictEqual({ char: "\u{1F600}" });
    expect(failure("a + )").params).toStrictEqual({ token: ")" });
    expect(failure("a +").params).toStrictEqual({});
    expect(failure("len(a b)").params).toStrictEqual({ token: "b", expected: '"," or ")"' });
    expect(failure("(a").params).toStrictEqual({ expected: '")"' });
    expect(failure("a = “x”").params).toStrictEqual({ token: "“" });
  });

  it("only the first error is reported", () => {
    expect(failure("a + ) )").start).toBe(4);
  });
});

describe("kernelParseFormula: the lowered forms as JSON", () => {
  const cases: Array<[string, unknown]> = [
    ["x between 1 and 5", { kind: "logical", operator: "and", left: { kind: "binary", operator: "gte", left: { kind: "path", path: "x" }, right: { kind: "literal", value: 1 } }, right: { kind: "binary", operator: "lte", left: { kind: "path", path: "x" }, right: { kind: "literal", value: 5 } } }],
    ['x in ("a", "b", "c")', { kind: "logical", operator: "or", left: { kind: "logical", operator: "or", left: { kind: "binary", operator: "eq", left: { kind: "path", path: "x" }, right: { kind: "literal", value: "a" } }, right: { kind: "binary", operator: "eq", left: { kind: "path", path: "x" }, right: { kind: "literal", value: "b" } } }, right: { kind: "binary", operator: "eq", left: { kind: "path", path: "x" }, right: { kind: "literal", value: "c" } } }],
    ['x in ("a")', { kind: "binary", operator: "eq", left: { kind: "path", path: "x" }, right: { kind: "literal", value: "a" } }],
    ["x in [1..5)", { kind: "logical", operator: "and", left: { kind: "binary", operator: "gte", left: { kind: "path", path: "x" }, right: { kind: "literal", value: 1 } }, right: { kind: "binary", operator: "lt", left: { kind: "path", path: "x" }, right: { kind: "literal", value: 5 } } }],
    ["-5", { kind: "literal", value: -5 }],
    ["-x", { kind: "arithmetic", operator: "subtract", left: { kind: "literal", value: 0 }, right: { kind: "path", path: "x" } }],
    ['@"2026-01-01"', { kind: "call", name: "date", args: [{ kind: "literal", value: "2026-01-01" }] }],
    ["not a = b", { kind: "unary", operator: "not", operand: { kind: "binary", operator: "eq", left: { kind: "path", path: "a" }, right: { kind: "path", path: "b" } } }],
    ["if a then 1 else if b then 2 else 3", { kind: "if", cases: [{ when: { kind: "path", path: "a" }, then: { kind: "literal", value: 1 } }, { when: { kind: "path", path: "b" }, then: { kind: "literal", value: 2 } }], else: { kind: "literal", value: 3 } }]
  ];

  it.each(cases)("%s", (text, expected) => {
    expect(JSON.parse(JSON.stringify(tree(text)))).toStrictEqual(expected);
  });
});

describe("kernelParseFormula: module shape", () => {
  it("lists every kernel function once with the kernel prefix and reads no clock", () => {
    const names = FORMULA_FUNCTIONS.map((fn) => fn.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.startsWith("kernel"), name).toBe(true);
    }
    expect(names).toContain("kernelParseFormula");
    for (const fn of FORMULA_FUNCTIONS) {
      expect(fn.toString(), fn.name).not.toMatch(/\bDate\b/);
      expect(fn.toString(), fn.name).not.toMatch(/\bIntl\b/);
      expect(fn.toString(), fn.name).not.toMatch(/Math\.random/);
    }
  });

  it("never mutates the signatures it is given", () => {
    const signatures = formulaFunctionSignatures();
    const before = JSON.stringify(signatures);
    parse("len(a) + sum(b, c)", signatures);
    expect(JSON.stringify(signatures)).toBe(before);
  });
});

describe("kernelParseFormula: fuzz", () => {
  const ALPHABET = [
    "a", "first-name", "`odd name`", "row.x", "host.r", "component", "1", "2.5", ".5", "1e3", '"s"', "'t'", '"un', "'esc\\'",
    '@"2026-01-01"', "@", "true", "false", "null", "if", "then", "else", "and", "or", "not", "between", "in",
    "=", "==", "!=", "<", "<=", ">", ">=", "+", "-", "*", "/", "(", ")", "[", "]", ",", "..", "`", "``", "#", "“", "é",
    "len", "sum", "empty", "date", "today", "nope", "len(", "sum(a,", ")"
  ];
  const VALID = [
    "a + b * c",
    "x between 1 and 5",
    'x in ( "a" , "b" , "c" )',
    "x in [ 1 .. 5 )",
    "not a = b and c",
    "not ( a = b )",
    "if a then 1 else if b then 2 else 3",
    "if a then b",
    "len ( first-name ) > 3 or empty ( `odd name` )",
    "- a * ( b - 2 ) / 3 >= - 5",
    'd in [ @"2026-01-01" .. @"2026-12-31" ]',
    "1 + if a then 2 else 3",
    "sum ( a , b , c ) = 10"
  ];

  function lcg(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
  }

  function check(text: string): void {
    let result: FormulaParseResult | undefined;
    expect(() => {
      result = parse(text);
    }, JSON.stringify(text)).not.toThrow();
    expect(result).toBeDefined();
    if (result === undefined) {
      return;
    }
    if (result.ok) {
      for (const read of result.paths) {
        expect(read.start).toBeGreaterThanOrEqual(0);
        expect(read.end).toBeGreaterThan(read.start);
        expect(read.end).toBeLessThanOrEqual(text.length);
      }
    } else {
      expect(typeof result.code).toBe("string");
      expect(typeof result.message).toBe("string");
      expect(result.start).toBeGreaterThanOrEqual(0);
      expect(result.end).toBeGreaterThanOrEqual(result.start);
      expect(result.end).toBeLessThanOrEqual(text.length);
    }
  }

  it("never throws on 2000 random token strings", () => {
    const random = lcg(20261007);
    for (let round = 0; round < 2000; round += 1) {
      const count = 1 + Math.floor(random() * 12);
      const parts: string[] = [];
      for (let index = 0; index < count; index += 1) {
        parts.push(ALPHABET[Math.floor(random() * ALPHABET.length)] as string);
      }
      check(parts.join(random() < 0.8 ? " " : ""));
    }
  });

  it("never throws on 500 mutations of valid formulas", () => {
    const random = lcg(42);
    for (const text of VALID) {
      expect(parse(text).ok, text).toBe(true);
    }
    for (let round = 0; round < 500; round += 1) {
      const tokens = (VALID[Math.floor(random() * VALID.length)] as string).split(" ");
      const at = Math.floor(random() * tokens.length);
      const kind = Math.floor(random() * 3);
      if (kind === 0) {
        tokens.splice(at, 1);
      } else if (kind === 1) {
        tokens.splice(at, 0, tokens[at] as string);
      } else {
        const other = Math.floor(random() * tokens.length);
        const held = tokens[at] as string;
        tokens[at] = tokens[other] as string;
        tokens[other] = held;
      }
      check(tokens.join(" "));
    }
  });

  it("deep nesting is an error, not a throw", () => {
    check("(".repeat(5000) + "a" + ")".repeat(5000));
    check("-".repeat(20000) + "a");
    expect(failure("(".repeat(5000) + "a" + ")".repeat(5000)).code).toBe("tooDeep");
    expect(failure("-".repeat(20000) + "a").code).toBe("tooDeep");
  });
});

describe("kernelParseFormula: nesting depth", () => {
  const MAX = 100;

  it("parses nesting up to the limit and reports the opener past it as tooDeep, before descending", () => {
    expect(parse("(".repeat(MAX) + "a" + ")".repeat(MAX)).ok).toBe(true);
    const text = "(".repeat(MAX + 1) + "a" + ")".repeat(MAX + 1);
    const result = failure(text);
    expect(result.code).toBe("tooDeep");
    expect(result.params).toStrictEqual({ token: "(", max: MAX });
    expect(result.start).toBe(MAX);
    expect(result.end).toBe(MAX + 1);
    expect(result.message).toContain(String(MAX));
  });

  it("counts calls, not(), if, in lists, intervals, unary minus and prefix not as levels", () => {
    expect(parse("len(".repeat(MAX) + "a" + ")".repeat(MAX)).ok).toBe(true);
    expect(failure("len(".repeat(MAX + 1) + "a" + ")".repeat(MAX + 1))).toMatchObject({ code: "tooDeep", params: { token: "len" } });
    expect(parse("not(".repeat(MAX) + "a" + ")".repeat(MAX)).ok).toBe(true);
    expect(failure("not(".repeat(MAX + 1) + "a" + ")".repeat(MAX + 1))).toMatchObject({ code: "tooDeep", params: { token: "not" } });
    expect(parse("if a then ".repeat(MAX) + "b").ok).toBe(true);
    expect(failure("if a then ".repeat(MAX + 1) + "b")).toMatchObject({ code: "tooDeep", params: { token: "if" } });
    expect(parse("x in (".repeat(MAX) + "1" + ")".repeat(MAX)).ok).toBe(true);
    expect(failure("x in (".repeat(MAX + 1) + "1" + ")".repeat(MAX + 1))).toMatchObject({ code: "tooDeep", params: { token: "(" } });
    expect(parse("x in [".repeat(MAX) + "1" + "..2]".repeat(MAX)).ok).toBe(true);
    expect(failure("x in [".repeat(MAX + 1) + "1" + "..2]".repeat(MAX + 1))).toMatchObject({ code: "tooDeep", params: { token: "[" } });
    expect(parse("-".repeat(MAX) + "a").ok).toBe(true);
    expect(failure("-".repeat(MAX + 1) + "a")).toMatchObject({ code: "tooDeep", params: { token: "-" } });
    expect(parse("not ".repeat(MAX) + "a").ok).toBe(true);
    expect(failure("not ".repeat(MAX + 1) + "a")).toMatchObject({ code: "tooDeep", params: { token: "not" } });
  });

  it("leaves a level on the way out, so siblings and long flat chains never add up", () => {
    const siblings = Array.from({ length: 500 }, () => "(a)").join(" + ");
    expect(parse(siblings).ok).toBe(true);
    const calls = Array.from({ length: 500 }, () => "len((a))").join(" + ");
    expect(parse(calls).ok).toBe(true);
    const ifs = Array.from({ length: 300 }, () => "(if a then 1 else 2)").join(" + ");
    expect(parse(ifs).ok).toBe(true);
    const mixed = "(".repeat(99) + "a" + ")".repeat(99) + " + " + "(".repeat(99) + "b" + ")".repeat(99);
    expect(parse(mixed).ok).toBe(true);
  });

  it("the limit is not reached by a depth that only the error path left behind", () => {
    const flat = Array.from({ length: 2000 }, () => "a").join(" + ");
    expect(parse(flat).ok).toBe(true);
    expect(parse(flat + " * (b - c)").ok).toBe(true);
  });
});

describe("kernelParseFormula: time", () => {
  function timed(text: string): { result: FormulaParseResult; ms: number } {
    parse("a + 1");
    const started = performance.now();
    const result = parse(text);
    return { result, ms: performance.now() - started };
  }

  it("100,000 nested parentheses come back as tooDeep well under 50 ms", () => {
    const { result, ms } = timed("(".repeat(100000) + "a" + ")".repeat(100000));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tooDeep");
      expect(result.start).toBe(100);
    }
    expect(ms).toBeLessThan(50);
  });

  it("an 8 KB flat formula parses well under 50 ms (the tokenizer is linear)", () => {
    const terms = Array.from({ length: 1400 }, (_, index) => `f${index}`);
    const text = terms.join(" + ");
    expect(text.length).toBeGreaterThan(8000);
    const { result, ms } = timed(text);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.paths).toHaveLength(1400);
      expect(result.paths[1399]).toStrictEqual({ path: "f1399", start: text.length - 5, end: text.length });
    }
    expect(ms).toBeLessThan(50);
  });

  it("an 8 KB formula of numbers, strings, names and operators tokenizes in one pass", () => {
    const parts: string[] = [];
    for (let index = 0; index < 500; index += 1) {
      parts.push(`len("s${index}") * 2.5 >= row.v${index}`);
    }
    const text = parts.join(" and ");
    expect(text.length).toBeGreaterThan(8000);
    const { result, ms } = timed(text);
    expect(result.ok).toBe(true);
    expect(ms).toBeLessThan(50);
  });
});

describe("plugin function names", () => {
  it("a call to a plugin function is typed without a cast", () => {
    const call: Expression = { kind: "call", name: "regionTax", args: [path("amount")] };
    const signatures: FormulaFunctionSignature[] = [...SIGNATURES, { name: "regionTax", min: 1, max: 1 }];
    expect(failure("regionTax(amount)").code).toBe("unknownFunction");
    const parsed = kernelParseFormula("regionTax(amount)", signatures);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.expression).toStrictEqual(call);
    }
  });
});
