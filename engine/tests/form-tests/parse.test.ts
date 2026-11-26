import { describe, expect, it } from "vitest";

import { kernelParseFormula } from "../../form-engine/core/expressions/formula.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import {
  FORM_TEST_PARSE_FUNCTIONS,
  kernelFormTestMessage,
  kernelParseFormTests
} from "../../form-engine/core/form-tests/form-test-parse.js";
import type {
  FormTestGiven,
  FormTestParseResult,
  FormTestProblem,
  FormTestProblemCode,
  FormTestScenario,
  FormTestStatement
} from "../../form-engine/core/form-tests/form-test-types.js";

// The form-test parser. Source text in, scenarios and problems out;
// the formula fallback leans on the real formula parser with the real function table.

const signatures = formulaFunctionSignatures();

function parse(text: string): FormTestParseResult {
  return kernelParseFormTests(text, signatures);
}

/** The one scenario of a source under a header `test "t"` on line 1; the statement lines start at line 2. */
function body(...lines: string[]): FormTestParseResult {
  return parse(['test "t"', ...lines].join("\n"));
}

function steps(...lines: string[]): FormTestStatement[] {
  const result = body(...lines);
  expect(result.problems).toEqual([]);
  expect(result.ok).toBe(true);
  return result.scenarios[0]!.steps;
}

function problem(result: FormTestParseResult): FormTestProblem {
  expect(result.ok).toBe(false);
  expect(result.problems.length).toBeGreaterThan(0);
  return result.problems[0]!;
}

describe("the header, skip and comments", () => {
  it("reads a header, its name span and the block span", () => {
    const source = 'test "adult applies"\nset age = 30';
    const result = parse(source);
    expect(result.ok).toBe(true);
    const scenario = result.scenarios[0]!;
    expect(scenario.name).toBe("adult applies");
    expect(scenario.line).toBe(1);
    expect(scenario.nameSpan).toEqual({ line: 1, start: 5, end: 20 });
    expect(source.slice(scenario.nameSpan.start, scenario.nameSpan.end)).toBe('"adult applies"');
    expect(scenario.span).toEqual({ line: 1, start: 0, end: source.length });
    expect(scenario.givens).toEqual([]);
  });

  it("reads a name in single quotes with escapes", () => {
    expect(parse("test 'it\\'s \\\"fine\\\"'").scenarios[0]!.name).toBe('it\'s "fine"');
  });

  it("reads skip directly under the header", () => {
    const result = parse('test "t"\nskip "waiting on the rule"\nset a = 1');
    expect(result.ok).toBe(true);
    expect(result.scenarios[0]!.skip).toBe("waiting on the rule");
    expect(result.scenarios[0]!.steps).toHaveLength(1);
  });

  it("ignores comments, blank lines and indentation, and keeps a hash inside a string", () => {
    const result = parse(
      ['# a file comment', '', 'test "a # not a comment"   # trailing', '    set   x   =   "has # inside"  # note', '\t\t', '  continue # go'].join("\n")
    );
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.name).toBe("a # not a comment");
    expect(result.scenarios[0]!.steps).toEqual([
      { kind: "set", path: "x", value: "has # inside", line: 4 },
      { kind: "continue", line: 6 }
    ]);
  });

  it("reads keywords in any case but keeps names as written", () => {
    const result = parse(
      ['TEST "Mixed"', 'Given TODAY = @"2026-01-01"', 'GIVEN Host.Role = "admin"', 'SET Age = 3', 'Expect AGE VISIBLE'].join("\n")
    );
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.givens).toEqual([
      { kind: "given", key: "today", value: "2026-01-01", line: 2 },
      { kind: "given", key: "host", name: "Role", value: "admin", line: 3 }
    ]);
    expect(result.scenarios[0]!.steps).toEqual([
      { kind: "set", path: "Age", value: 3, line: 4 },
      { kind: "expectState", path: "AGE", state: "visible", line: 5 }
    ]);
  });

  it("reads two blocks from one source and gives each its own refs and lines", () => {
    const source = ['test "one"', "set a = 1", "", 'test "two"', "set b = 2", "expect b visible"].join("\n");
    const result = parse(source);
    expect(result.ok).toBe(true);
    expect(result.scenarios.map((s) => s.name)).toEqual(["one", "two"]);
    expect(result.scenarios[0]!.steps).toHaveLength(1);
    expect(result.scenarios[1]!.steps).toHaveLength(2);
    expect(result.scenarios[0]!.refs.map((r) => r.text)).toEqual(["a"]);
    expect(result.scenarios[1]!.refs.map((r) => r.text)).toEqual(["b", "b"]);
    expect(result.scenarios[0]!.span).toEqual({ line: 1, start: 0, end: source.indexOf("\n\ntest") });
    expect(result.scenarios[1]!.line).toBe(4);
    // A new header gives the next block its own given keys.
    const again = parse('test "a"\ngiven locale = "fr-CA"\ntest "b"\ngiven locale = "en-CA"');
    expect(again.problems).toEqual([]);
  });

  it("copes with CRLF line ends and an empty source", () => {
    expect(parse('test "t"\r\nset a = 1\r\ncontinue\r\n').scenarios[0]!.steps).toHaveLength(2);
    expect(parse("")).toEqual({ ok: true, scenarios: [], problems: [] });
    expect(parse("# nothing\n\n")).toEqual({ ok: true, scenarios: [], problems: [] });
  });
});

describe("givens", () => {
  const givens = (...lines: string[]): FormTestGiven[] => {
    const result = body(...lines);
    expect(result.problems).toEqual([]);
    return result.scenarios[0]!.givens;
  };

  it("reads each given form", () => {
    expect(
      givens(
        'given today = @"2026-03-14"',
        'given locale = "fr-CA"',
        "given journey = main",
        'given host.role = "admin"',
        'given options for province = ("ON", "QC")',
        'given options for items[0].kind = ()'
      )
    ).toEqual([
      { kind: "given", key: "today", value: "2026-03-14", line: 2 },
      { kind: "given", key: "locale", value: "fr-CA", line: 3 },
      { kind: "given", key: "journey", value: "main", line: 4 },
      { kind: "given", key: "host", name: "role", value: "admin", line: 5 },
      { kind: "given", key: "options", path: "province", values: ["ON", "QC"], line: 6 },
      { kind: "given", key: "options", path: "items[0].kind", values: [], line: 7 }
    ]);
  });

  it("accepts a plain string for today and journey none", () => {
    expect(givens('given today = "2026-03-14"', "given journey = none")).toEqual([
      { kind: "given", key: "today", value: "2026-03-14", line: 2 },
      { kind: "given", key: "journey", value: "none", line: 3 }
    ]);
  });

  it("notes the journey, host key and options path as refs, but not none", () => {
    const refs = (line: string): string[] => body(line).scenarios[0]!.refs.map((r) => `${r.kind}:${r.text}`);
    expect(refs("given journey = main")).toEqual(["journey:main"]);
    expect(refs("given journey = none")).toEqual([]);
    expect(refs('given host.role = "a"')).toEqual(["host:role"]);
    expect(refs("given options for province = (1)")).toEqual(["path:province"]);
  });

  it("holds a host value of any literal shape", () => {
    expect(givens("given host.limits = (1, 2.5, -3, true, null)")[0]).toEqual({
      kind: "given",
      key: "host",
      name: "limits",
      value: [1, 2.5, -3, true, null],
      line: 2
    });
  });
});

describe("actions", () => {
  const table: Array<[string, FormTestStatement]> = [
    ['set name = "Ada"', { kind: "set", path: "name", value: "Ada", line: 2 }],
    ["set name = 'Ada'", { kind: "set", path: "name", value: "Ada", line: 2 }],
    ["set age = 42", { kind: "set", path: "age", value: 42, line: 2 }],
    ["set delta = -3.5", { kind: "set", path: "delta", value: -3.5, line: 2 }],
    ["set tiny = 1e3", { kind: "set", path: "tiny", value: 1000, line: 2 }],
    ["set zero = -0", { kind: "set", path: "zero", value: 0, line: 2 }],
    ["set agree = true", { kind: "set", path: "agree", value: true, line: 2 }],
    ["set agree = false", { kind: "set", path: "agree", value: false, line: 2 }],
    ["set note = null", { kind: "set", path: "note", value: null, line: 2 }],
    ['set born = @"2000-02-29"', { kind: "set", path: "born", value: "2000-02-29", line: 2 }],
    ['set topics = ("a", "b")', { kind: "set", path: "topics", value: ["a", "b"], line: 2 }],
    ["set topics = ()", { kind: "set", path: "topics", value: [], line: 2 }],
    ['set grid = (("a", 1), (true, null))', { kind: "set", path: "grid", value: [["a", 1], [true, null]], line: 2 }],
    ['set q = "line\\nbreak \\"quoted\\""', { kind: "set", path: "q", value: 'line\nbreak "quoted"', line: 2 }],
    ["set x=5", { kind: "set", path: "x", value: 5, line: 2 }],
    ['set items[0].qty = 3', { kind: "set", path: "items[0].qty", value: 3, line: 2 }],
    ['set a.b.c = "deep"', { kind: "set", path: "a.b.c", value: "deep", line: 2 }],
    ['set @pres.field = "x"', { kind: "set", path: "@pres.field", value: "x", line: 2 }],
    ["clear name", { kind: "clear", path: "name", line: 2 }],
    ["clear items[2].qty", { kind: "clear", path: "items[2].qty", line: 2 }],
    ["add row to items", { kind: "addRow", path: "items", line: 2 }],
    ["add row to a.items", { kind: "addRow", path: "a.items", line: 2 }],
    ['add row to items with qty = 2, label = "x"', { kind: "addRow", path: "items", values: { qty: 2, label: "x" }, line: 2 }],
    ["add row to items with address.city = 'Ottawa'", { kind: "addRow", path: "items", values: { "address.city": "Ottawa" }, line: 2 }],
    ["remove row 0 of items", { kind: "removeRow", path: "items", index: 0, line: 2 }],
    ["remove row 12 of group.items", { kind: "removeRow", path: "group.items", index: 12, line: 2 }],
    ["continue", { kind: "continue", line: 2 }],
    ["back", { kind: "back", line: 2 }],
    ["go to review", { kind: "goTo", page: "review", line: 2 }],
    ["go to page-2.a", { kind: "goTo", page: "page-2.a", line: 2 }],
    ["change name", { kind: "change", path: "name", line: 2 }],
    ["change items[1].qty", { kind: "change", path: "items[1].qty", line: 2 }],
    ["check", { kind: "check", line: 2 }],
    ["submit", { kind: "submit", line: 2 }]
  ];

  it.each(table)("parses %s", (line, expected) => {
    expect(steps(line)).toEqual([expected]);
  });

  it("builds an add-row record without a prototype, so a key named __proto__ is just a key", () => {
    const [step] = steps('add row to items with __proto__ = 1, constructor = 2');
    expect(step!.kind).toBe("addRow");
    const values = (step as { values: Record<string, unknown> }).values;
    expect(Object.keys(values)).toEqual(["__proto__", "constructor"]);
    expect(Object.getPrototypeOf(values)).toBeNull();
  });

  it("keeps a given before the first step and the order of the steps", () => {
    const result = body('given locale = "en-CA"', "set a = 1", "clear a", "submit");
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.steps.map((s) => s.kind)).toEqual(["set", "clear", "submit"]);
  });
});

describe("expectations", () => {
  const table: Array<[string, FormTestStatement]> = [
    ["expect accepted", { kind: "expectVerdict", verdict: "accepted", line: 2 }],
    ["expect REFUSED", { kind: "expectVerdict", verdict: "refused", line: 2 }],
    ["expect no errors", { kind: "expectNoError", line: 2 }],
    ["expect no error on email", { kind: "expectNoError", path: "email", line: 2 }],
    ["expect error on email", { kind: "expectError", path: "email", line: 2 }],
    ["expect error on items[0].qty: required", { kind: "expectError", path: "items[0].qty", code: "required", line: 2 }],
    ["expect error on email:format.email", { kind: "expectError", path: "email", code: "format.email", line: 2 }],
    ["expect error on email : rows.min", { kind: "expectError", path: "email", code: "rows.min", line: 2 }],
    ['expect message on email = "Enter an email."', { kind: "expectMessage", path: "email", message: "Enter an email.", line: 2 }],
    ["expect page = review", { kind: "expectPage", page: "review", line: 2 }],
    ["expect path = (start, review, done)", { kind: "expectPath", pages: ["start", "review", "done"], line: 2 }],
    ["expect path = ()", { kind: "expectPath", pages: [], line: 2 }],
    ["expect path ends", { kind: "expectPathEnd", line: 2 }],
    ["expect path ends at stop", { kind: "expectPathEnd", exit: "stop", line: 2 }],
    ["expect review on path", { kind: "expectOnPath", page: "review", on: true, line: 2 }],
    ["expect review off path", { kind: "expectOnPath", page: "review", on: false, line: 2 }],
    ['expect submitted email = "a@b.ca"', { kind: "expectSubmitted", path: "email", value: "a@b.ca", line: 2 }],
    ["expect submitted topics = (1, 2)", { kind: "expectSubmitted", path: "topics", value: [1, 2], line: 2 }],
    ["expect secret withheld", { kind: "expectWithheld", path: "secret", line: 2 }],
    ["expect rows of items = 3", { kind: "expectRows", path: "items", count: 3, line: 2 }],
    ["expect layout = summary", { kind: "expectLayout", layout: "summary", line: 2 }],
    ["expect email visible", { kind: "expectState", path: "email", state: "visible", line: 2 }],
    ["expect email hidden", { kind: "expectState", path: "email", state: "hidden", line: 2 }],
    ["expect email required", { kind: "expectState", path: "email", state: "required", line: 2 }],
    ["expect email optional", { kind: "expectState", path: "email", state: "optional", line: 2 }],
    ["expect email enabled", { kind: "expectState", path: "email", state: "enabled", line: 2 }],
    ["expect email disabled", { kind: "expectState", path: "email", state: "disabled", line: 2 }],
    ["expect email readonly", { kind: "expectState", path: "email", state: "readonly", line: 2 }],
    ["expect email editable", { kind: "expectState", path: "email", state: "editable", line: 2 }],
    ["expect email empty", { kind: "expectState", path: "email", state: "empty", line: 2 }],
    ["expect email not empty", { kind: "expectState", path: "email", state: "notEmpty", line: 2 }],
    ["expect items[0].qty required", { kind: "expectState", path: "items[0].qty", state: "required", line: 2 }],
    ["expect total = 5", { kind: "expectValue", path: "total", op: "eq", value: 5, line: 2 }],
    ["expect total=5", { kind: "expectValue", path: "total", op: "eq", value: 5, line: 2 }],
    ['expect name != "Ada"', { kind: "expectValue", path: "name", op: "ne", value: "Ada", line: 2 }],
    ["expect agree = true", { kind: "expectValue", path: "agree", op: "eq", value: true, line: 2 }],
    ["expect note = null", { kind: "expectValue", path: "note", op: "eq", value: null, line: 2 }],
    ['expect born = @"2000-02-29"', { kind: "expectValue", path: "born", op: "eq", value: "2000-02-29", line: 2 }],
    ['expect topics = ("a", "b")', { kind: "expectValue", path: "topics", op: "eq", value: ["a", "b"], line: 2 }],
    ["expect items[0].qty = 2", { kind: "expectValue", path: "items[0].qty", op: "eq", value: 2, line: 2 }]
  ];

  it.each(table)("parses %s", (line, expected) => {
    expect(steps(line)).toEqual([expected]);
  });

  it("reads expect-like words as a field when the words after them say so", () => {
    // `accepted`, `page`, `path` and `layout` are verdict and journey words only in their own shapes.
    expect(steps("expect accepted visible")).toEqual([{ kind: "expectState", path: "accepted", state: "visible", line: 2 }]);
    expect(steps("expect page != 3")).toEqual([{ kind: "expectValue", path: "page", op: "ne", value: 3, line: 2 }]);
    expect(steps("expect submitted visible")).toEqual([{ kind: "expectState", path: "submitted", state: "visible", line: 2 }]);
    expect(steps("expect layout != 1")).toEqual([{ kind: "expectValue", path: "layout", op: "ne", value: 1, line: 2 }]);
  });

  it("falls back to the formula parser, and keeps one literal on the value form", () => {
    const [value, formula] = steps("expect total = 5", "expect total = subtotal * 1.13");
    expect(value).toMatchObject({ kind: "expectValue", value: 5 });
    expect(formula).toMatchObject({ kind: "expectFormula", formula: "total = subtotal * 1.13", line: 3 });
    const parsed = kernelParseFormula("total = subtotal * 1.13", signatures);
    expect(parsed.ok && (formula as { expression: unknown }).expression).toEqual(parsed.ok && parsed.expression);
  });

  it("reads a call, a comparison and a membership test as formulas", () => {
    for (const line of [
      "expect count(selected(services)) <= 3",
      "expect total > 5",
      "expect age in (18, 19)",
      "expect age between 18 and 65",
      "expect not(agree)",
      "expect (1 + 2) * 3 = 9",
      "expect total = 5 + 1",
      "expect agree",
      "expect -5 < total"
    ]) {
      const [step] = steps(line);
      expect(step!.kind, line).toBe("expectFormula");
      expect((step as { formula: string }).formula).toBe(line.slice("expect ".length));
    }
  });

  it("gives the formula's own span back for a bad formula, shifted into the source", () => {
    const source = 'test "t"\nexpect total > 5 +';
    const result = parse(source);
    const found = problem(result);
    expect(found.code).toBe("badFormula");
    expect(found.params?.formulaCode).toBe("expectedValue");
    expect(found.line).toBe(2);
    expect(found.start).toBe(source.length);
    expect(found.end).toBe(source.length);
  });
});

describe("literals", () => {
  it("rejects a curly quote and an unterminated string, with the curly marker", () => {
    expect(problem(body("set a = “hi”"))).toMatchObject({ code: "unterminatedString", params: { curly: 1 }, line: 2 });
    expect(problem(body('set a = "open'))).toMatchObject({ code: "unterminatedString", line: 2 });
    expect(problem(body('set a = @"2026'))).toMatchObject({ code: "unterminatedString" });
  });

  it("keeps a closing quote that follows an escaped backslash", () => {
    expect(steps('set a = "x\\\\"')).toEqual([{ kind: "set", path: "a", value: "x\\", line: 2 }]);
  });

  it("reports a malformed number or word as expectedValue", () => {
    expect(problem(body("set a = 12abc"))).toMatchObject({ code: "expectedValue", params: { token: "12abc" } });
    expect(problem(body("set a = 1e999"))).toMatchObject({ code: "expectedValue" });
    expect(problem(body("set a = truee"))).toMatchObject({ code: "expectedValue", params: { token: "truee" } });
    expect(problem(body("set a ="))).toMatchObject({ code: "expectedValue" });
  });

  it("reports lists that never close", () => {
    expect(problem(body('set a = ("a", "b"'))).toMatchObject({ code: "unclosedList" });
    expect(problem(body("set a = ("))).toMatchObject({ code: "unclosedList" });
    expect(problem(body("set a = (1 2)"))).toMatchObject({ code: "unclosedList" });
    expect(problem(body("set a = (1,)"))).toMatchObject({ code: "expectedValue" });
  });

  it("stops nesting lists at 32 levels without recursing further", () => {
    const deep = "(".repeat(40) + ")".repeat(40);
    expect(problem(body(`set a = ${deep}`))).toMatchObject({ code: "unclosedList", params: { tooDeep: 1 } });
    const fine = "(".repeat(30) + ")".repeat(30);
    expect(body(`set a = ${fine}`).problems).toEqual([]);
  });
});

describe("refs", () => {
  it("lists every name in source order with its span and line", () => {
    const source = [
      'test "mixed"',
      'given journey = main',
      "given host.role = 1",
      "set items[0].qty = 2",
      "add row to items",
      "go to review",
      "expect error on email: format.email",
      "expect rows of items = 1",
      "expect layout = summary",
      "expect review on path",
      "expect secret withheld"
    ].join("\n");
    const result = parse(source);
    expect(result.problems).toEqual([]);
    const refs = result.scenarios[0]!.refs;
    expect(refs.map((r) => `${r.kind}:${r.text}`)).toEqual([
      "journey:main",
      "host:role",
      "path:items[0].qty",
      "collection:items",
      "page:review",
      "path:email",
      "code:format.email",
      "collection:items",
      "layout:summary",
      "page:review",
      "path:secret"
    ]);
    for (const ref of refs) {
      expect(source.slice(ref.span.start, ref.span.end)).toBe(ref.text);
      expect(source.split("\n")[ref.span.line - 1]).toContain(ref.text);
    }
    const starts = refs.map((r) => r.span.start);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(refs[2]!.span.line).toBe(4);
  });

  it("notes the keys of `add row ... with` as rowKey refs on their collection", () => {
    const source = 'test "t"\nadd row to items with qty = 2, address.city = "Ottawa"\nadd row to items';
    const result = parse(source);
    expect(result.problems).toEqual([]);
    const refs = result.scenarios[0]!.refs;
    expect(refs.map((r) => `${r.kind}:${r.text}`)).toEqual(["collection:items", "rowKey:qty", "rowKey:address.city", "collection:items"]);
    expect(refs.map((r) => r.collection)).toEqual([undefined, "items", "items", undefined]);
    for (const ref of refs) {
      expect(source.slice(ref.span.start, ref.span.end)).toBe(ref.text);
      expect(ref.span.line).toBe(2 + (ref === refs[3] ? 1 : 0));
    }
    // A collection ref has no `collection` key at all.
    expect("collection" in refs[0]!).toBe(false);
  });

  it("lists the paths a formula reads, shifted into the source", () => {
    const source = 'test "t"\nexpect total = subtotal * 1.13';
    const refs = parse(source).scenarios[0]!.refs;
    expect(refs.map((r) => r.text)).toEqual(["total", "subtotal"]);
    for (const ref of refs) {
      expect(ref.kind).toBe("path");
      expect(source.slice(ref.span.start, ref.span.end)).toBe(ref.text);
    }
  });
});

describe("problems", () => {
  /** Every code with a source that produces it, the line it sits on and (where checked) the text it underlines. */
  const cases: Array<[FormTestProblemCode, string[], number, string?]> = [
    ["unknownStatement", ["wibble x"], 2, "wibble"],
    ["expectedName", ["test"], 1],
    ["expectedPath", ["set = 1"], 2],
    ["expectedValue", ["set a ="], 2],
    ["expectedPage", ["go to"], 2],
    ["expectedPath", ["change"], 2],
    ["trailingText", ["change name extra"], 2],
    ["expectedNumber", ["remove row x of items"], 2, "x"],
    ["expectedEquals", ["set a 1"], 2, "1"],
    ["expectedKeyword", ["add items"], 2, "items"],
    ["badState", ["expect email wibble"], 2, "wibble"],
    ["badCode", ["expect error on email: re!quired"], 2, "re!quired"],
    ["duplicateName", ['test "t"'], 2, '"t"'],
    ["badGiven", ["given weather = 1"], 2, "weather"],
    ["givenAfterStep", ["set a = 1", 'given locale = "en"'], 3],
    ["duplicateGiven", ['given locale = "en"', 'given locale = "fr"'], 3],
    ["skipAfterStep", ["set a = 1", 'skip "later"'], 3],
    ["unterminatedString", ['set a = "x'], 2],
    ["unclosedList", ["set a = (1"], 2],
    ["badFormula", ["expect total >"], 2],
    ["trailingText", ["continue now"], 2, "now"]
  ];

  it.each(cases)("produces %s", (code, lines, line, underlined) => {
    const header = lines[0] === "test" ? "" : 'test "t"\n';
    const source = header + lines.join("\n");
    const found = problem(parse(source));
    expect(found.code).toBe(code);
    expect(found.line).toBe(line);
    expect(found.start).toBeLessThanOrEqual(found.end);
    if (underlined !== undefined) {
      expect(source.slice(found.start, found.end)).toBe(underlined);
    }
  });

  it("produces stepOutsideTest before the first header and tooLong past the limit", () => {
    const stray = parse('set a = 1\ntest "t"');
    expect(stray.problems).toEqual([{ code: "stepOutsideTest", line: 1, start: 0, end: 9 }]);
    expect(stray.scenarios).toHaveLength(1);
    const long = parse('test "t"\n' + "# x".repeat(70000));
    expect(long.ok).toBe(false);
    expect(long.scenarios).toEqual([]);
    expect(long.problems).toEqual([{ code: "tooLong", line: 1, start: 0, end: 9 + 3 * 70000, params: { max: 200000 } }]);
    // At the limit it still parses.
    expect(parse(`test "t"\n#${"x".repeat(200000 - 11)}`).ok).toBe(true);
  });

  it("covers every code the types name", () => {
    const covered = new Set<string>(cases.map(([code]) => code));
    covered.add("stepOutsideTest");
    covered.add("tooLong");
    const all: FormTestProblemCode[] = [
      "unknownStatement", "expectedName", "duplicateName", "expectedPath", "expectedValue", "expectedPage", "expectedNumber", "expectedEquals",
      "expectedKeyword", "badState", "badCode", "badGiven", "givenAfterStep", "duplicateGiven", "skipAfterStep",
      "stepOutsideTest", "unterminatedString", "unclosedList", "badFormula", "trailingText", "tooLong"
    ];
    for (const code of all) {
      expect(covered.has(code), code).toBe(true);
    }
  });

  it("puts the formula's code and its placeholders on badFormula", () => {
    const found = problem(body("expect nosuchfn(1) = 2"));
    expect(found).toMatchObject({ code: "badFormula", params: { formulaCode: "unknownFunction", name: "nosuchfn" } });
  });

  it("flags a badly shaped today and an empty locale as badGiven", () => {
    expect(problem(body('given today = "tomorrow"'))).toMatchObject({ code: "badGiven", params: { key: "today" } });
    expect(problem(body('given today = @"2026-13-01"'))).toMatchObject({ code: "badGiven" });
    expect(problem(body("given today = 5"))).toMatchObject({ code: "badGiven" });
    expect(problem(body('given locale = ""'))).toMatchObject({ code: "badGiven" });
    expect(problem(body("given host. = 1"))).toMatchObject({ code: "badGiven" });
  });

  it("holds a given day to the calendar, leap years included", () => {
    const bad = (day: string) => problem(body(`given today = @"${day}"`));
    expect(bad("2026-02-31")).toMatchObject({ code: "badGiven", params: { key: "today" } });
    expect(bad("2027-02-29")).toMatchObject({ code: "badGiven" });
    expect(bad("1900-02-29")).toMatchObject({ code: "badGiven" });
    expect(bad("2026-04-31")).toMatchObject({ code: "badGiven" });
    expect(bad("2026-06-31")).toMatchObject({ code: "badGiven" });
    expect(bad("2026-09-31")).toMatchObject({ code: "badGiven" });
    expect(bad("2026-11-31")).toMatchObject({ code: "badGiven" });
    expect(bad("2026-01-00")).toMatchObject({ code: "badGiven" });
    expect(bad("2026-00-10")).toMatchObject({ code: "badGiven" });
    for (const day of ["2028-02-29", "2000-02-29", "2026-02-28", "2026-01-31", "2026-04-30", "2026-12-31"]) {
      expect(body(`given today = @"${day}"`).problems, day).toEqual([]);
    }
  });

  it("keys duplicate givens by host name and options path", () => {
    expect(body('given host.a = 1', 'given host.b = 2', 'given options for x = (1)', 'given options for y = (1)').problems).toEqual([]);
    expect(problem(body("given host.a = 1", "given host.a = 2"))).toMatchObject({ code: "duplicateGiven", params: { key: "host.a" } });
    expect(problem(body("given options for x = (1)", "given options for x = (2)"))).toMatchObject({ code: "duplicateGiven" });
  });

  it("refuses a second skip, and a skip after a given", () => {
    expect(problem(body('skip "a"', 'skip "b"')).code).toBe("skipAfterStep");
    expect(problem(body('given locale = "en"', 'skip "b"')).code).toBe("skipAfterStep");
  });

  it("keeps the statements that parsed, and the ones after the bad line", () => {
    const result = body("set a = 1", "set b =", "set c = 3");
    expect(result.ok).toBe(false);
    expect(result.problems).toHaveLength(1);
    expect(result.scenarios[0]!.steps).toEqual([
      { kind: "set", path: "a", value: 1, line: 2 },
      { kind: "set", path: "c", value: 3, line: 4 }
    ]);
  });

  it("opens a block even when its header is wrong, so its lines are not strays", () => {
    const result = parse("test\nset a = 1");
    expect(result.problems.map((p) => p.code)).toEqual(["expectedName"]);
    expect(result.scenarios[0]!.name).toBe("");
    expect(result.scenarios[0]!.steps).toHaveLength(1);
  });

  it("refuses a path that is not the engine's syntax", () => {
    for (const line of ["set a..b = 1", "set a[x] = 1", "set a.[0] = 1", "set a. = 1", "set a b = 1", "clear .a", "clear a.@b"]) {
      expect(problem(body(line)).code, line).toMatch(/^(expectedPath|expectedEquals)$/);
    }
    expect(problem(body("remove row -1 of items")).code).toBe("expectedNumber");
    expect(problem(body("remove row 1.5 of items")).code).toBe("expectedNumber");
    expect(problem(body("expect rows of items = many")).code).toBe("expectedNumber");
  });

  it("explains each code with a sentence", () => {
    const codes: FormTestProblemCode[] = [
      "unknownStatement", "expectedName", "duplicateName", "expectedPath", "expectedValue", "expectedPage", "expectedNumber", "expectedEquals",
      "expectedKeyword", "badState", "badCode", "badGiven", "givenAfterStep", "duplicateGiven", "skipAfterStep",
      "stepOutsideTest", "unterminatedString", "unclosedList", "badFormula", "trailingText", "tooLong"
    ];
    for (const code of codes) {
      const sentence = kernelFormTestMessage(code, { word: "w", token: "t", expected: "to", code: "c", key: "k", formulaCode: "badChar", char: "~", max: 200000 });
      expect(sentence.length, code).toBeGreaterThan(10);
      expect(sentence, code).not.toBe(kernelFormTestMessage("nonsense", undefined));
    }
    expect(kernelFormTestMessage("unterminatedString", { curly: 1 })).toContain("curly");
    expect(kernelFormTestMessage("trailingText", undefined)).toContain("after the end");
  });
});

describe("statement order and the language edges", () => {
  it("allows a given only before the first step, even after an expectation", () => {
    expect(problem(body("expect accepted", 'given locale = "en"')).code).toBe("givenAfterStep");
  });

  it("treats a field named like a keyword as a field wherever the shape allows it", () => {
    expect(steps("set path = 1", "set page = 2", "clear layout")).toHaveLength(3);
  });

  it("lists its own functions for the kernel, all named kernel*", () => {
    for (const fn of FORM_TEST_PARSE_FUNCTIONS) {
      expect(fn.name).toMatch(/^kernel/);
    }
    expect(new Set(FORM_TEST_PARSE_FUNCTIONS).size).toBe(FORM_TEST_PARSE_FUNCTIONS.length);
  });

  it("returns a fresh result each call and never shares state between calls", () => {
    const one = parse('test "a"\nset x = 1');
    const two = parse('test "b"');
    expect(one.scenarios[0]!.steps).toHaveLength(1);
    expect(two.scenarios[0]!.steps).toHaveLength(0);
  });

  it("does not trust a __proto__ given key or a constructor path", () => {
    const result = body("given host.__proto__ = 1", "given host.constructor = 2", "set constructor = 3", "set __proto__ = 4");
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.givens).toHaveLength(2);
    expect(problem(body("given host.constructor = 1", "given host.constructor = 2")).code).toBe("duplicateGiven");
  });

  it("is deterministic and keeps scenarios in source order", () => {
    const text = 'test "z"\nset a = 1\ntest "a"\nset b = 2';
    const a: FormTestScenario[] = parse(text).scenarios;
    expect(a.map((s) => s.name)).toEqual(["z", "a"]);
    expect(parse(text)).toEqual(parse(text));
  });
});

// --- Grammar edge cases ---

describe("a formula problem is worded for every code the formula parser has", () => {
  const cases: Array<[string, Record<string, string | number>, RegExp]> = [
    ["arity", { name: "abs", min: 1, max: 1, got: 2 }, /abs takes 1 argument but was given 2/],
    ["arityMin", { name: "sum", min: 1, got: 0 }, /sum needs at least 1 argument/],
    ["intervalDots", { token: "5" }, /\.\./],
    ["curlyQuote", { token: "“" }, /curly quote/],
    ["chainedCompare", {}, /cannot be chained/],
    ["betweenAnd", {}, /between/],
    ["tooDeep", { max: 64 }, /64 levels/]
  ];
  for (const [code, params, pattern] of cases) {
    it(code, () => {
      const message = kernelFormTestMessage("badFormula", { ...params, formulaCode: code });
      expect(message).toMatch(pattern);
      expect(message).not.toMatch(/code \w+\.$/);
    });
  }

  it("a real chained comparison reads the formula parser's own sentence", () => {
    const result = body("expect 1 < 2 < 3");
    expect(result.problems[0]).toMatchObject({ code: "badFormula" });
    expect(kernelFormTestMessage(result.problems[0]!.code, result.problems[0]!.params)).toContain("cannot be chained");
  });
});

describe("a formula's scope reads are not field refs", () => {
  const refs = (line: string) => body(line).scenarios[0]!.refs;

  it("host.role is a host ref on role, its span inside the path", () => {
    const source = 'test "t"\nexpect host.role = "admin"';
    const found = parse(source).scenarios[0]!.refs;
    expect(found.map((ref) => `${ref.kind}:${ref.text}`)).toEqual(["host:role"]);
    expect(source.slice(found[0]!.span.start, found[0]!.span.end)).toBe("role");
  });

  it("a nested host key keeps its dots", () => {
    expect(refs('expect host.limits.max > 1').map((ref) => `${ref.kind}:${ref.text}`)).toEqual(["host:limits.max"]);
  });

  it("row. and ancestor. reads name no field and note no ref", () => {
    expect(refs("expect row.qty = 1")).toEqual([]);
    expect(refs("expect ancestor.total > 2")).toEqual([]);
  });

  it("a field read beside a scope read is still a path ref", () => {
    expect(refs('expect total > 1 and host.role = "a"').map((ref) => `${ref.kind}:${ref.text}`)).toEqual(["path:total", "host:role"]);
  });
});

describe("a backticked name is one name", () => {
  it("a # inside backticks does not start a comment", () => {
    const result = body("expect `a # b` = 1");
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.steps[0]).toMatchObject({ kind: "expectFormula" });
  });

  it("a # after the closing backtick still does", () => {
    expect(body("expect `a b` = 1 # note").problems).toEqual([]);
  });

  it("the ref's span covers the name, the backticks outside it", () => {
    const source = 'test "t"\nexpect `a b` = 1';
    const ref = parse(source).scenarios[0]!.refs[0]!;
    expect(ref.text).toBe("a b");
    expect(source.slice(ref.span.start, ref.span.end)).toBe("a b");
  });
});

describe("other line ends and a mark mid-file", () => {
  it("a carriage return alone ends a line", () => {
    const result = parse('test "a"\rexpect x visible\r');
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.steps).toHaveLength(1);
    expect(result.scenarios[0]!.steps[0]).toMatchObject({ kind: "expectState", line: 2 });
  });

  it("a carriage return and a line feed are still one line end", () => {
    const result = parse('test "a"\r\nexpect x visible\r\nexpect y hidden');
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.steps.map((step) => step.line)).toEqual([2, 3]);
  });

  it("a byte-order mark at the start of a later line is skipped", () => {
    const source = 'test "a"\n﻿expect x visible';
    const result = parse(source);
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.steps).toHaveLength(1);
    const ref = result.scenarios[0]!.refs[0]!;
    expect(source.slice(ref.span.start, ref.span.end)).toBe("x");
  });
});

describe("a no-break space inside a formula is a blank", () => {
  it("expect x > 5 with one parses as a formula", () => {
    const result = body("expect x > 5");
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.steps[0]).toMatchObject({ kind: "expectFormula" });
  });

  it("the spans of the refs stay where they were", () => {
    const source = 'test "t"\nexpect x > y';
    const refs = parse(source).scenarios[0]!.refs;
    expect(refs.map((ref) => source.slice(ref.span.start, ref.span.end))).toEqual(["x", "y"]);
  });
});

describe("none is a keyword in any case", () => {
  it("given journey = None is the whole form, stored as none, with no journey ref", () => {
    const result = body("given journey = None");
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.givens[0]).toMatchObject({ key: "journey", value: "none" });
    expect(result.scenarios[0]!.refs).toEqual([]);
  });

  it("another journey id keeps its case", () => {
    expect(body("given journey = Main").scenarios[0]!.givens[0]).toMatchObject({ key: "journey", value: "Main" });
  });
});

describe("a key named twice in one added row", () => {
  it("is a duplicateGiven on the key and adds no action", () => {
    const result = body("add row to items with a = 1, a = 2");
    expect(result.problems.map((entry) => [entry.code, entry.params])).toEqual([["duplicateGiven", { key: "a" }]]);
    expect(result.scenarios[0]!.steps).toEqual([]);
  });

  it("different keys are fine", () => {
    expect(body("add row to items with a = 1, b = 2").problems).toEqual([]);
  });
});

describe("the name check does not scan every earlier block", () => {
  it("reads 12,000 distinct names quickly", () => {
    const source = Array.from({ length: 12000 }, (_, at) => `test "n${at}"`).join("\n");
    const started = Date.now();
    const result = parse(source);
    const took = Date.now() - started;
    expect(result.problems).toEqual([]);
    expect(result.scenarios).toHaveLength(12000);
    // Linear takes a few milliseconds; the quadratic scan took about half a second here.
    expect(took).toBeLessThan(300);
  });

  it("still finds a repeat far from its first use, and a name spelled like a prototype member", () => {
    const result = parse('test "constructor"\ntest "__proto__"\ntest "x"\ntest "constructor"\ntest "__proto__"');
    expect(result.problems.map((entry) => [entry.code, entry.line])).toEqual([
      ["duplicateName", 4],
      ["duplicateName", 5]
    ]);
  });
});

describe("true, false and null are literals in any case", () => {
  it("reads TRUE, False and NULL as the values, as the keywords are read", () => {
    expect(steps("set a = TRUE", "set b = False", "set c = Null")).toEqual([
      { kind: "set", path: "a", value: true, line: 2 },
      { kind: "set", path: "b", value: false, line: 3 },
      { kind: "set", path: "c", value: null, line: 4 }
    ]);
  });

  it("makes `expect w = TRUE` a value check, not a formula over a field called TRUE", () => {
    const [step] = steps("expect w = TRUE");
    expect(step).toEqual({ kind: "expectValue", path: "w", op: "eq", value: true, line: 2 });
    const [other] = steps("expect w != NULL");
    expect(other).toEqual({ kind: "expectValue", path: "w", op: "ne", value: null, line: 2 });
  });

  it("reads them inside a list and in a given or an added row", () => {
    const result = body("given host.flag = TRUE", "set a = (TRUE, False, Null)", "add row to items with ok = TRUE");
    expect(result.problems).toEqual([]);
    expect(result.scenarios[0]!.givens[0]).toMatchObject({ key: "host", name: "flag", value: true });
    expect(result.scenarios[0]!.steps[0]).toMatchObject({ kind: "set", value: [true, false, null] });
    expect(result.scenarios[0]!.steps[1]).toMatchObject({ kind: "addRow", values: { ok: true } });
  });

  it("still refuses a word that is not one of the three", () => {
    expect(problem(body("set a = truthy"))).toMatchObject({ code: "expectedValue", params: { token: "truthy" } });
  });
});

describe("true, false and null lead or sit inside a formula in any case", () => {
  const expressionOf = (line: string) => (steps(line)[0] as { expression: unknown }).expression;
  const lowered = (text: string) => {
    const parsed = kernelParseFormula(text, signatures);
    expect(parsed.ok).toBe(true);
    return parsed.ok ? parsed.expression : undefined;
  };

  it("`expect TRUE = x` is the formula `true = x`, with x the only field ref", () => {
    const source = 'test "t"\nexpect TRUE = x';
    const parsed = parse(source);
    expect(parsed.problems).toEqual([]);
    expect((parsed.scenarios[0]!.steps[0] as { expression: unknown }).expression).toEqual(lowered("true = x"));
    expect(parsed.scenarios[0]!.refs.map((ref) => source.slice(ref.span.start, ref.span.end))).toEqual(["x"]);
  });

  it("reads False and Null the same way, mid-formula", () => {
    expect(expressionOf("expect x = TRUE and y = NULL")).toEqual(lowered("x = true and y = null"));
    expect(expressionOf("expect not(False) and z != Null")).toEqual(lowered("not(false) and z != null"));
  });

  it("keeps the formula text as the author typed it", () => {
    expect(steps("expect TRUE = x")[0]).toMatchObject({ kind: "expectFormula", formula: "TRUE = x" });
  });

  it("leaves a string, a backticked name and a longer name alone", () => {
    expect(expressionOf('expect "TRUE" = x')).toEqual(lowered('"TRUE" = x'));
    expect(expressionOf("expect 'Null' = x")).toEqual(lowered("'Null' = x"));
    expect(expressionOf("expect `TRUE` = x")).toEqual(lowered("`TRUE` = x"));
    expect(expressionOf("expect TRUE_FLAG = x")).toEqual(lowered("TRUE_FLAG = x"));
    expect(expressionOf("expect a.TRUE = x")).toEqual(lowered("a.TRUE = x"));
  });

  it("keeps the offsets of a bad formula after the lowering", () => {
    const source = 'test "t"\nexpect TRUE = x +';
    const parsed = parse(source);
    expect(parsed.problems[0]).toMatchObject({ code: "badFormula", start: source.length, end: source.length });
  });
});
