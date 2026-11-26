import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import { kernelParseFormula } from "../form-engine/core/expressions/formula.js";
import type { FormulaFunctionSignature } from "../form-engine/core/expressions/formula-types.js";
import { FORMULA_FUNCTION_TABLE, formulaFunctionSignatures, type FormulaFunctionRow } from "../form-engine/core/expressions/function-table.js";
import { printFormula, printFormulaTokens, sameExpression, spellFormulaNumber, spellFormulaString } from "../form-engine/builder/formula/feel-print.js";

const PLUGIN_SIGNATURES: FormulaFunctionSignature[] = [
  { name: "pluginFn", min: 2, max: 2 },
  { name: "myPlugin_x", min: 1, max: Number.POSITIVE_INFINITY }
];

const signatures = (): FormulaFunctionSignature[] => [...formulaFunctionSignatures(), ...PLUGIN_SIGNATURES];

function parse(text: string): Expression | undefined {
  const result = kernelParseFormula(text, signatures());
  if (!result.ok) {
    throw new Error(`${text}\n  -> ${result.code} at ${String(result.start)}-${String(result.end)}: ${result.message}`);
  }
  return result.expression;
}

const path = (name: string): Expression => ({ kind: "path", path: name });
const lit = (value: string | number | boolean | null): Expression => ({ kind: "literal", value });
const bin = (operator: "eq" | "neq" | "gt" | "gte" | "lt" | "lte", left: Expression, right: Expression): Expression => ({
  kind: "binary",
  operator,
  left,
  right
});
const and = (left: Expression, right: Expression): Expression => ({ kind: "logical", operator: "and", left, right });
const or = (left: Expression, right: Expression): Expression => ({ kind: "logical", operator: "or", left, right });
const arith = (operator: "add" | "subtract" | "multiply" | "divide", left: Expression, right: Expression): Expression => ({
  kind: "arithmetic",
  operator,
  left,
  right
});
const not = (operand: Expression): Expression => ({ kind: "unary", operator: "not", operand });
const call = (name: string, ...args: Expression[]): Expression => ({ kind: "call", name, args });

describe("printFormula: canonical spelling", () => {
  const table: Array<[string, Expression, string]> = [
    ["a comparison", bin("eq", path("province"), lit("QC")), 'province = "QC"'],
    ["every comparison operator", and(and(bin("neq", path("a"), lit(1)), bin("gt", path("b"), lit(2))), and(bin("lt", path("c"), lit(3)), bin("lte", path("d"), lit(4)))), "a != 1 and b > 2 and (c < 3 and d <= 4)"],
    ["not as a call", not(call("empty", path("email"))), "not(empty(email))"],
    ["not over a comparison", not(bin("eq", path("a"), lit(1))), "not(a = 1)"],
    ["between recovered", and(bin("gte", path("age"), lit(18)), bin("lte", path("age"), lit(65))), "age between 18 and 65"],
    ["a half-open interval recovered", and(bin("gte", path("n"), lit(1)), bin("lt", path("n"), lit(10))), "n in [1..10)"],
    ["an open interval recovered", and(bin("gt", path("n"), lit(1)), bin("lt", path("n"), lit(10))), "n in (1..10)"],
    ["in recovered from a left-folded or of eq", or(or(bin("eq", path("s"), lit("a")), bin("eq", path("s"), lit("b"))), bin("eq", path("s"), lit("c"))), 's in ("a", "b", "c")'],
    ["in only when every leaf shares the left", or(bin("eq", path("s"), lit("a")), bin("eq", path("t"), lit("b"))), 's = "a" or t = "b"'],
    ["a prefix in-run then more", or(or(bin("eq", path("s"), lit("a")), bin("eq", path("s"), lit("b"))), path("x")), 's in ("a", "b") or x'],
    ["an in-run on the right of an or", or(path("x"), or(bin("eq", path("s"), lit("a")), bin("eq", path("s"), lit("b")))), 'x or s in ("a", "b")'],
    ["a flat or chain", or(or(path("a"), path("b")), path("c")), "a or b or c"],
    ["a right-nested or keeps its parentheses", or(path("a"), or(path("b"), path("c"))), "a or (b or c)"],
    ["and inside or is parenthesised for the reader", or(and(path("a"), path("b")), path("c")), "(a and b) or c"],
    ["or inside and must be parenthesised", and(or(path("a"), path("b")), path("c")), "(a or b) and c"],
    ["flat left-folded arithmetic", arith("subtract", arith("add", path("a"), path("b")), path("c")), "a + b - c"],
    ["right-nested subtraction keeps its parentheses", arith("subtract", path("a"), arith("subtract", path("b"), path("c"))), "a - (b - c)"],
    ["multiplication binds tighter", arith("multiply", arith("add", path("a"), path("b")), path("c")), "(a + b) * c"],
    ["a product inside a sum needs no parentheses", arith("add", path("a"), arith("multiply", path("b"), path("c"))), "a + b * c"],
    ["unary minus", arith("subtract", lit(0), path("x")), "-x"],
    ["unary minus over a product", arith("subtract", lit(0), arith("multiply", path("a"), path("b"))), "-(a * b)"],
    ["zero minus a number stays a subtraction", arith("subtract", lit(0), lit(5)), "0 - 5"],
    ["a negative literal", bin("lt", path("balance"), lit(-5)), "balance < -5"],
    ["a negative literal after minus", arith("subtract", path("a"), lit(-5)), "a - -5"],
    ["strings use double quotes with escapes", bin("eq", path("s"), lit('say "hi"\\\n')), 's = "say \\"hi\\"\\\\\\n"'],
    ["booleans and null", or(bin("eq", path("a"), lit(true)), bin("eq", path("b"), lit(null))), "a = true or b = null"],
    ["a date literal", bin("lt", path("start"), call("date", lit("2026-01-01"))), 'start < @"2026-01-01"'],
    ["date of a non-day stays a call", call("date", lit("tomorrow")), 'date("tomorrow")'],
    ["calls with arguments", call("substring", path("sin"), lit(1), lit(3)), "substring(sin, 1, 3)"],
    ["a call with no arguments", bin("gt", call("today"), path("start")), "today() > start"],
    ["a plugin call", call("pluginFn", path("a"), lit(2)), "pluginFn(a, 2)"],
    ["an if ladder", { kind: "if", cases: [{ when: bin("eq", path("s"), lit("a")), then: lit(250) }, { when: bin("eq", path("s"), lit("b")), then: lit(180) }], else: lit(120) }, 'if s = "a" then 250 else if s = "b" then 180 else 120'],
    ["an if without else", { kind: "if", cases: [{ when: path("a"), then: lit(1) }] }, "if a then 1"],
    ["a nested if in else keeps its parentheses", { kind: "if", cases: [{ when: path("a"), then: lit(1) }], else: { kind: "if", cases: [{ when: path("b"), then: lit(2) }] } }, "if a then 1 else (if b then 2)"],
    ["a nested if in then keeps its parentheses", { kind: "if", cases: [{ when: path("a"), then: { kind: "if", cases: [{ when: path("b"), then: lit(2) }] } }], else: lit(3) }, "if a then (if b then 2) else 3"],
    ["an if as an operand", arith("add", { kind: "if", cases: [{ when: path("a"), then: lit(1) }], else: lit(2) }, lit(3)), "(if a then 1 else 2) + 3"],
    ["an if as a call argument", call("sum", { kind: "if", cases: [{ when: path("a"), then: lit(1) }], else: lit(2) }, lit(3)), "sum(if a then 1 else 2, 3)"],
    ["hyphenated and dotted ids stay bare", bin("gt", path("first-name"), path("row.amount")), "first-name > row.amount"],
    ["odd ids are backticked", bin("eq", path("my field"), path("if")), "`my field` = `if`"],
    ["an id that is a function name stays bare", arith("add", path("sum"), lit(1)), "sum + 1"],
    ["scoped paths", and(path("component"), bin("eq", path("host.role"), path("ancestor.kind"))), "component and host.role = ancestor.kind"]
  ];

  for (const [name, tree, text] of table) {
    it(name, () => {
      expect(printFormula(tree)).toBe(text);
      expect(parse(text)).toEqual(tree);
    });
  }

  it("prints a top-level if one case per line when multiline, the then indented", () => {
    const tree: Expression = {
      kind: "if",
      cases: [
        { when: and(bin("eq", path("s"), lit("Corporation")), bin("gt", path("n"), lit(50))), then: lit(400) },
        { when: or(bin("eq", path("s"), lit("Partnership")), bin("eq", path("s"), lit("Corporation"))), then: lit(250) }
      ],
      else: lit(120)
    };
    const text = printFormula(tree, { multiline: true });
    expect(text).toBe('if s = "Corporation" and n > 50\n  then 400\nelse if s in ("Partnership", "Corporation")\n  then 250\nelse 120');
    expect(parse(text)).toEqual(tree);
    expect(printFormula(bin("eq", path("a"), lit(1)), { multiline: true })).toBe("a = 1");
  });

  it("reads with labels and option names as tokens", () => {
    const tree = and(bin("eq", path("province"), lit("QC")), bin("gt", path("n"), lit(10)));
    const labelOf = (id: string): string | undefined => ({ province: "Province", n: "Number of employees" })[id];
    const optionLabelOf = (id: string, value: string): string | undefined => (id === "province" && value === "QC" ? "Quebec" : undefined);
    expect(printFormula(tree, { labelOf, optionLabelOf })).toBe('Province = "Quebec" and Number of employees > 10');
    const tokens = printFormulaTokens(tree, { labelOf, optionLabelOf }).filter((token) => token.kind !== "text");
    expect(tokens).toEqual([
      { kind: "field", text: "Province", path: "province" },
      { kind: "operator", text: "=" },
      { kind: "value", text: '"Quebec"', value: "Quebec" },
      { kind: "keyword", text: "and" },
      { kind: "field", text: "Number of employees", path: "n" },
      { kind: "operator", text: ">" },
      { kind: "value", text: "10", value: "10" }
    ]);
    const list = printFormulaTokens(or(bin("eq", path("province"), lit("QC")), bin("eq", path("province"), lit("ON"))), { labelOf, optionLabelOf });
    expect(list.map((token) => token.text).join("")).toBe('Province in ("Quebec", "ON")');
  });

  it("spells numbers and strings the grammar reads back", () => {
    for (const value of [0, 1, 3.5, 0.1, 1e21, 1e-7, 123456789, -5, -0.25, 5e-324]) {
      expect(parse(spellFormulaNumber(value))).toEqual(lit(value));
    }
    expect(spellFormulaNumber(Number.NaN)).toBe("null");
    for (const value of ["", "QC", 'say "hi"', "it's", "back\\slash", "tab\tnew\nline\r", "`@'"]) {
      expect(parse(spellFormulaString(value))).toEqual(lit(value));
    }
  });

  it("compares trees structurally, key order aside", () => {
    expect(sameExpression({ kind: "path", path: "a" }, { path: "a", kind: "path" })).toBe(true);
    expect(sameExpression(lit(1), lit("1"))).toBe(false);
    expect(sameExpression({ kind: "if", cases: [] }, { kind: "if", cases: [], else: undefined })).toBe(true);
  });

  it("compares two 20,000-term chains without recursing down the spine", () => {
    const build = (last: number): Expression => {
      let tree: Expression = lit(0);
      for (let at = 1; at <= 20_000; at += 1) {
        tree = { kind: "arithmetic", operator: "add", left: tree, right: lit(at === 20_000 ? last : at) };
      }
      return tree;
    };
    expect(sameExpression(build(1), build(1))).toBe(true);
    expect(sameExpression(build(1), build(2))).toBe(false);
  });
});

// --- the seeded random-tree round trip ---------------------------------------------------------

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PATHS = [
  "a",
  "first-name",
  "row.amount",
  "ancestor.total",
  "host.user",
  "component",
  "component.value",
  "if",
  "then",
  "my field",
  "2nd",
  "prénom",
  "a.b.c",
  "line-2",
  "x_1",
  "true",
  "null",
  "sum",
  "date",
  "Province",
  "weird-name_x.y",
  "it's",
  'say "no"',
  "a--b",
  "trailing.",
  "-lead",
  "in"
];
const STRINGS = ["", "QC", 'say "hi"', "it's", "back\\slash", "tab\tnew\nline", 'mixed "\'\\ \r', "2026-01-01", "`tick`", "@at"];
const NUMBERS = [0, 1, 3.5, 0.1, 1e21, 1e-7, 123456789, -5, -0.25, 42, 7];
const COMPARISONS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
const ARITHMETIC = ["add", "subtract", "multiply", "divide"] as const;
const CALLABLE = [
  ...(FORMULA_FUNCTION_TABLE as readonly FormulaFunctionRow[]).map((row) => {
    const required = row.params.filter((param) => !param.endsWith("?")).length;
    const min = row.min ?? (row.variadic ? 0 : required);
    const max = row.variadic ? 4 : row.params.length;
    return { name: row.name, min, max };
  }),
  { name: "pluginFn", min: 2, max: 2 },
  { name: "myPlugin_x", min: 1, max: 4 }
];

function generate(random: () => number, depth: number): Expression {
  const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)] as T;
  const leaf = (): Expression => {
    const roll = random();
    if (roll < 0.45) return path(pick(PATHS));
    if (roll < 0.65) return lit(pick(NUMBERS));
    if (roll < 0.85) return lit(pick(STRINGS));
    if (roll < 0.95) return lit(random() < 0.5);
    return lit(null);
  };
  if (depth <= 0) {
    return leaf();
  }
  const next = depth - 1;
  const roll = random();
  if (roll < 0.15) return leaf();
  if (roll < 0.3) return bin(pick(COMPARISONS), generate(random, next), generate(random, next));
  if (roll < 0.42) return and(generate(random, next), generate(random, next));
  if (roll < 0.54) return or(generate(random, next), generate(random, next));
  if (roll < 0.66) return arith(pick(ARITHMETIC), generate(random, next), generate(random, next));
  if (roll < 0.72) return not(generate(random, next));
  if (roll < 0.76) return arith("subtract", lit(0), generate(random, next));
  if (roll < 0.8) {
    // The shapes the parser lowers: between, in and a date literal, so the recoveries are exercised.
    const left = generate(random, next);
    const shape = random();
    if (shape < 0.3) return and(bin("gte", left, generate(random, next)), bin("lte", JSON.parse(JSON.stringify(left)) as Expression, generate(random, next)));
    if (shape < 0.5) return and(bin("gt", left, generate(random, next)), bin("lte", JSON.parse(JSON.stringify(left)) as Expression, generate(random, next)));
    if (shape < 0.85) {
      const count = 2 + Math.floor(random() * 3);
      let run = bin("eq", left, generate(random, next));
      for (let at = 1; at < count; at += 1) {
        run = or(run, bin("eq", JSON.parse(JSON.stringify(left)) as Expression, generate(random, next)));
      }
      return run;
    }
    return call("date", lit("2026-01-01"));
  }
  if (roll < 0.9) {
    const row = pick(CALLABLE);
    const count = row.min + Math.floor(random() * (row.max - row.min + 1));
    const args: Expression[] = [];
    for (let at = 0; at < count; at += 1) {
      // A literal unit of dateAdd and dateDiff must be a real one, or the parser refuses the call (badUnit).
      args.push(at === 2 && (row.name === "dateAdd" || row.name === "dateDiff") ? lit("months") : generate(random, next));
    }
    return call(row.name, ...args);
  }
  const cases: Array<{ when: Expression; then: Expression }> = [];
  const count = 1 + Math.floor(random() * 3);
  for (let at = 0; at < count; at += 1) {
    cases.push({ when: generate(random, next), then: generate(random, next) });
  }
  const node: Expression = { kind: "if", cases };
  if (random() < 0.6) {
    node.else = generate(random, next);
  }
  return node;
}

describe("printFormula: lossless by structure", () => {
  it("parses back to the same tree for 300 seeded random trees", () => {
    const random = mulberry32(20261007);
    const kinds = new Set<string>();
    for (let at = 0; at < 300; at += 1) {
      const tree = generate(random, 1 + (at % 5));
      const text = printFormula(tree);
      const back = parse(text);
      expect(back, text).toEqual(tree);
      const stamp = (node: Expression): void => {
        kinds.add(node.kind);
        if (node.kind === "if") {
          node.cases.forEach((entry) => {
            stamp(entry.when);
            stamp(entry.then);
          });
          if (node.else) stamp(node.else);
        } else if ("left" in node) {
          stamp(node.left);
          stamp(node.right);
        } else if (node.kind === "unary") {
          stamp(node.operand);
        } else if (node.kind === "call") {
          node.args.forEach(stamp);
        }
      };
      stamp(tree);
    }
    expect([...kinds].sort()).toEqual(["arithmetic", "binary", "call", "if", "literal", "logical", "path", "unary"]);
  });

  it("round-trips every tree twice: printing the parsed tree gives the same text", () => {
    const random = mulberry32(7);
    for (let at = 0; at < 60; at += 1) {
      const tree = generate(random, 3);
      const text = printFormula(tree);
      expect(printFormula(parse(text) as Expression)).toBe(text);
      const multiline = printFormula(tree, { multiline: true });
      expect(parse(multiline)).toEqual(tree);
    }
  });
});

// --- the names and snippets the printer and the editor share ----------------------------------

describe("feel-functions", () => {
  it("backticks an id the grammar cannot take bare", async () => {
    const { feelName, isBareFormulaName } = await import("../form-engine/builder/formula/feel-functions.js");
    for (const id of ["a", "first-name", "row.amount", "x_1", "Province", "sum", "If"]) {
      expect(feelName(id), id).toBe(id);
      expect(isBareFormulaName(id)).toBe(true);
    }
    for (const id of ["my field", "2nd", "if", "true", "null", "prénom", "a--b", "trailing.", "-lead", ""]) {
      expect(feelName(id), id).toBe("`" + id + "`");
      expect(isBareFormulaName(id)).toBe(false);
    }
  });

  it("merges every built-in with its words, group key, signature and snippet", async () => {
    const { FORMULA_FUNCTION_ROWS, functionRowByName } = await import("../form-engine/builder/formula/feel-functions.js");
    expect(FORMULA_FUNCTION_ROWS).toHaveLength(FORMULA_FUNCTION_TABLE.length);
    for (const row of FORMULA_FUNCTION_ROWS) {
      expect(row.summary, row.name).not.toBe("");
      expect(row.example, row.name).toContain(row.name);
      expect(row.groupKey).toBe(`fn.group.${row.group}`);
      expect(parse(row.snippet.replace(/\$\{\d+\}/g, "1")), row.snippet).toBeDefined();
    }
    expect(functionRowByName("substring")?.signature).toBe("substring(text, start, length?)");
    expect(functionRowByName("substring")?.snippet).toBe("substring(${1}, ${2})");
    expect(functionRowByName("sum")?.signature).toBe("sum(value…)");
    expect(functionRowByName("sum")?.snippet).toBe("sum(${1})");
    expect(functionRowByName("today")?.snippet).toBe("today()");
    expect(functionRowByName("roundUp")?.snippet).toBe("roundUp(${1})");
    expect(functionRowByName("len")?.feelName).toBe("string length");
  });

  it("joins the plugin functions a host wired, their signatures and their snippets", async () => {
    const { formulaFunctionRows, formulaSignatures, pluginSnippets, snippetLabel, FORMULA_SNIPPETS, FORMULA_SNIPPET_GROUPS, snippetBlanks } = await import(
      "../form-engine/builder/formula/feel-functions.js"
    );
    const table = [
      {
        name: "pluginFn",
        params: ["a", "b"],
        returns: "number" as const,
        summary: "Adds things.",
        example: "pluginFn(1, 2)",
        plugin: "acme",
        snippets: [{ label: "Acme sum", insert: "pluginFn(${1}, ${2})" }]
      }
    ];
    const rows = formulaFunctionRows(table);
    expect(rows).toHaveLength(FORMULA_FUNCTION_TABLE.length + 1);
    const plugin = rows[rows.length - 1];
    expect(plugin).toMatchObject({ name: "pluginFn", group: "plugin", groupKey: "fn.group.plugin", plugin: "acme", signature: "pluginFn(a, b)", snippet: "pluginFn(${1}, ${2})" });
    expect(formulaFunctionRows({ table: () => table })).toHaveLength(rows.length);
    expect(formulaFunctionRows()).toHaveLength(FORMULA_FUNCTION_TABLE.length);
    const signatures = formulaSignatures({ signatures: () => [{ name: "pluginFn", min: 2, max: 2 }] });
    expect(signatures[signatures.length - 1]).toEqual({ name: "pluginFn", min: 2, max: 2 });
    const extra = pluginSnippets(rows);
    expect(extra).toEqual([
      { id: "acme.pluginFn.0", group: "plugin", labelKey: "snippet.group.plugin", label: "Acme sum", insert: "pluginFn(${1}, ${2})", blanks: ["value", "value"], preview: "pluginFn(…, …)" }
    ]);
    expect(snippetLabel(extra[0] as (typeof extra)[number])).toBe("Acme sum");
    expect(snippetLabel(FORMULA_SNIPPETS[0] as (typeof FORMULA_SNIPPETS)[number])).toBe("Is answered");
    expect(FORMULA_SNIPPET_GROUPS.map((group) => group.id)).toEqual(["answers", "choices", "dates", "cases", "plugin"]);
    expect(FORMULA_SNIPPETS.map((entry) => entry.id)).toEqual([
      "isAnswered",
      "isEmpty",
      "anyOf",
      "between",
      "allTicked",
      "anyTicked",
      "noneTicked",
      "atLeastTicked",
      "withinDays",
      "beforeDate",
      "ageAtLeast",
      "weekend",
      "ifThenElse",
      "cases"
    ]);
    for (const entry of FORMULA_SNIPPETS) {
      expect(snippetBlanks(entry.insert), entry.id).toBe(entry.blanks.length);
      // Every helper parses once its blanks are filled with a field name.
      expect(parse(entry.insert.replace(/\$\{\d+\}/g, "a")), entry.id).toBeDefined();
    }
  });
});

describe("printFormula: long chains", () => {
  const chain = (term: (index: number) => string, joiner: string, count: number): string => Array.from({ length: count }, (_, index) => term(index)).join(joiner);

  it.each([
    ["or of different fields", (i: number) => `a${i} = 1`, " or ", 8000],
    ["or of one field (an in list)", () => "a = 1", " or ", 8000],
    ["or closing on another field", (i: number) => (i === 7999 ? "z = 1" : "a = 1"), " or ", 8000],
    ["and", (i: number) => `a${i} > 1`, " and ", 8000],
    ["plus", (i: number) => `a${i}`, " + ", 20000],
    ["times", (i: number) => `a${i}`, " * ", 20000]
  ])("%s prints in linear time, without a RangeError, and reads back as the same tree", (_label, term, joiner, count) => {
    const text = chain(term, joiner, count);
    const tree = parse(text);
    const started = Date.now();
    const printed = printFormula(tree as Expression);
    expect(Date.now() - started).toBeLessThan(2000);
    // Not sameExpression, which recurses along the chain: the printed text is a fixed point instead.
    expect(printFormula(parse(printed) as Expression)).toBe(printed);
  });

  it("keeps the spellings of short chains", () => {
    expect(printFormula(parse("a = 1 or a = 2 or b = 3") as Expression)).toBe("a in (1, 2) or b = 3");
    expect(printFormula(parse("a + b + c - d") as Expression)).toBe("a + b + c - d");
    expect(printFormula(parse("a - (b - c)") as Expression)).toBe("a - (b - c)");
    expect(printFormula(parse("a and b and (c or d)") as Expression)).toBe("a and b and (c or d)");
  });
});
