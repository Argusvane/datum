import { describe, expect, it } from "vitest";

import type { Expression } from "../../form-engine/core/expressions/expression.js";
import { kernelFormTestJudge, runFormTestScenario, runFormTestScenarios, FORM_TEST_RUN_FUNCTIONS } from "../../form-engine/core/form-tests/form-test-run.js";
import {
  FORM_TEST_MAX_STEPS,
  type FormTestDriver,
  type FormTestExpectation,
  type FormTestGiven,
  type FormTestRefusal,
  type FormTestScenario,
  type FormTestSnapshot,
  type FormTestStartError,
  type FormTestStatement
} from "../../form-engine/core/form-tests/form-test-types.js";
import { evaluateExpression } from "../../form-engine/rules/evaluator/evaluator.js";

// The judge and the runner of form tests. Scenarios are literal data here: the
// parser is another stage's, so nothing below depends on it.

const ids: Record<string, string> = {
  age: "c_age",
  name: "c_name",
  "items": "c_items",
  "items[0].qty": "c_qty",
  topics: "c_topics",
  agree: "c_agree",
  constructor: "c_constructor"
};

function snapshot(patch: Partial<FormTestSnapshot> = {}): FormTestSnapshot {
  const base: FormTestSnapshot = {
    effective: {
      c_age: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: true, clearValue: false },
      c_name: { visible: false, disabled: true, readonly: true, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false },
      c_items: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: true, clearValue: false },
      c_qty: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: true, clearValue: false },
      c_topics: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: true, clearValue: false },
      c_agree: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: true, clearValue: false },
      c_constructor: { visible: true, disabled: false, readonly: false, runValidation: true, requiredApplies: true, submitValue: true, clearValue: false }
    },
    required: { c_age: true, c_name: false },
    values: { c_age: 20 },
    byPath: { age: 20, name: "  ", topics: { a: false, b: false }, agree: false },
    errors: [],
    rows: { items: 2 },
    pages: []
  };
  return { ...base, ...patch };
}

const context = {
  componentIdOf: (path: string) => (Object.prototype.hasOwnProperty.call(ids, path) ? ids[path] : undefined),
  typeOf: (id: string) => (id === "c_topics" ? "checkboxes" : id === "c_agree" ? "checkbox" : "text"),
  evaluate: (expression: Expression, values: Record<string, unknown>) => evaluateExpression(expression, { values })
};

function judge(statement: FormTestExpectation, snap: FormTestSnapshot = snapshot()) {
  return kernelFormTestJudge(statement, snap, context);
}

describe("kernelFormTestJudge: states", () => {
  const cases: Array<[string, string, boolean]> = [
    ["visible", "age", true],
    ["visible", "name", false],
    ["hidden", "name", true],
    ["hidden", "age", false],
    ["required", "age", true],
    ["required", "name", false],
    ["optional", "name", true],
    ["optional", "age", false],
    ["enabled", "age", true],
    ["enabled", "name", false],
    ["disabled", "name", true],
    ["disabled", "age", false],
    ["readonly", "name", true],
    ["readonly", "age", false],
    ["editable", "age", true],
    ["editable", "name", false],
    // Blank text, a checkbox group with nothing ticked and an unchecked box are all empty.
    ["empty", "name", true],
    ["empty", "topics", true],
    ["empty", "agree", true],
    ["empty", "age", false],
    ["notEmpty", "age", true],
    ["notEmpty", "name", false]
  ];
  for (const [state, path, holds] of cases) {
    it(`${state} ${path} ${holds ? "passes" : "fails"}`, () => {
      const result = judge({ kind: "expectState", path, state: state as never, line: 7 });
      expect(result.line).toBe(7);
      if (holds) {
        expect(result).toEqual({ line: 7, status: "passed" });
      } else {
        expect(result).toEqual({ line: 7, status: "failed", code: `expect.${state}`, expected: true, actual: false, params: { path } });
      }
    });
  }

  it("reads emptiness by the value alone when the driver gives no type", () => {
    const result = kernelFormTestJudge({ kind: "expectState", path: "topics", state: "empty", line: 1 }, snapshot(), {
      componentIdOf: context.componentIdOf,
      evaluate: context.evaluate
    });
    expect(result.status).toBe("failed");
  });

  it("fails with expect.unknownField for a path no component owns", () => {
    expect(judge({ kind: "expectState", path: "nope", state: "visible", line: 3 })).toEqual({
      line: 3,
      status: "failed",
      code: "expect.unknownField",
      params: { path: "nope" }
    });
    expect(judge({ kind: "expectValue", path: "nope", op: "eq", value: 1, line: 4 }).code).toBe("expect.unknownField");
    expect(judge({ kind: "expectRows", path: "nope", count: 1, line: 5 }).code).toBe("expect.unknownField");
  });

  it("fails with expect.unknownField when the snapshot has no effective state for the component", () => {
    const result = judge({ kind: "expectState", path: "age", state: "visible", line: 2 }, snapshot({ effective: {} }));
    expect(result.code).toBe("expect.unknownField");
  });

  it("treats a component named like an Object.prototype member as any other", () => {
    expect(judge({ kind: "expectState", path: "constructor", state: "visible", line: 1 }).status).toBe("passed");
    // `toString` is no component and its snapshot lookups must not find the inherited member.
    expect(judge({ kind: "expectState", path: "toString", state: "visible", line: 1 }).code).toBe("expect.unknownField");
  });

  it("skips an expectation on a field the snapshot could not replay, with that reason", () => {
    const snap = snapshot({ unreplayable: { c_age: "unreplayable.host" } });
    expect(judge({ kind: "expectState", path: "age", state: "required", line: 9 }, snap)).toEqual({
      line: 9,
      status: "skipped",
      code: "unreplayable.host"
    });
    expect(judge({ kind: "expectValue", path: "age", op: "eq", value: 1, line: 9 }, snap).status).toBe("skipped");
    // Another field is judged as usual.
    expect(judge({ kind: "expectState", path: "name", state: "hidden", line: 9 }, snap).status).toBe("passed");
  });
});

describe("kernelFormTestJudge: values", () => {
  it("compares numbers by value, strings exactly and null as absent", () => {
    const snap = snapshot({ byPath: { age: 20, name: "Ada", note: null, list: [1, "a", [true]], obj: { a: 1, b: { c: null } } } });
    const eq = (path: string, value: never) => judge({ kind: "expectValue", path, op: "eq", value, line: 1 }, snap);
    expect(eq("age", 20 as never).status).toBe("passed");
    expect(eq("age", 20.0 as never).status).toBe("passed");
    expect(eq("name", "Ada" as never).status).toBe("passed");
    expect(eq("name", "ada" as never).status).toBe("failed");
    expect(eq("age", "20" as never).status).toBe("failed");
  });

  it("reports expected and actual, absent as null", () => {
    expect(judge({ kind: "expectValue", path: "age", op: "eq", value: 21, line: 2 })).toEqual({
      line: 2,
      status: "failed",
      code: "expect.value",
      expected: 21,
      actual: 20,
      params: { path: "age", op: "eq" }
    });
    const absent = judge({ kind: "expectValue", path: "agree", op: "eq", value: true, line: 2 }, snapshot({ byPath: {} }));
    expect(absent.actual).toBeNull();
    expect(absent.expected).toBe(true);
  });

  it("treats null and absent as equal", () => {
    expect(judge({ kind: "expectValue", path: "age", op: "eq", value: null, line: 1 }, snapshot({ byPath: {} })).status).toBe("passed");
    expect(judge({ kind: "expectValue", path: "age", op: "eq", value: null, line: 1 }, snapshot({ byPath: { age: null } })).status).toBe("passed");
    expect(judge({ kind: "expectValue", path: "age", op: "eq", value: null, line: 1 }, snapshot({ byPath: { age: 0 } })).status).toBe("failed");
  });

  it("compares lists item by item in order and records key by key", () => {
    const snap = snapshot({ byPath: { topics: ["a", "b"], age: 1 } });
    const topics = (value: never) => judge({ kind: "expectValue", path: "topics", op: "eq", value, line: 1 }, snap).status;
    expect(topics(["a", "b"] as never)).toBe("passed");
    expect(topics(["b", "a"] as never)).toBe("failed");
    expect(topics(["a"] as never)).toBe("failed");
    expect(topics("a" as never)).toBe("failed");
    const recordSnap = snapshot({ byPath: { topics: { a: 1, b: [null, 2] } } });
    expect(judge({ kind: "expectValue", path: "topics", op: "eq", value: { b: [null, 2], a: 1 } as never, line: 1 }, recordSnap).status).toBe("passed");
    expect(judge({ kind: "expectValue", path: "topics", op: "eq", value: { a: 1 } as never, line: 1 }, recordSnap).status).toBe("failed");
  });

  describe("a list literal against a checkbox group's flags record", () => {
    const groupSnap = (topics: unknown) => snapshot({ byPath: { topics }, submitted: { topics } });
    const read = (topics: unknown, value: unknown, op: "eq" | "ne" = "eq") =>
      judge({ kind: "expectValue", path: "topics", op, value: value as never, line: 1 }, groupSnap(topics)).status;

    it("compares the set of true keys, in any order", () => {
      const flags = { news: true, offers: false, events: true };
      expect(read(flags, ["news", "events"])).toBe("passed");
      expect(read(flags, ["events", "news"])).toBe("passed");
      expect(read(flags, ["news"])).toBe("failed");
      expect(read(flags, ["news", "events", "offers"])).toBe("failed");
      expect(read(flags, ["news", "other"])).toBe("failed");
      expect(read(flags, [])).toBe("failed");
      expect(read({ news: false }, [])).toBe("passed");
      expect(read({}, [])).toBe("passed");
    });

    it("does not count a repeated item as another option", () => {
      expect(read({ news: true, events: true }, ["news", "news", "events"])).toBe("passed");
      expect(read({ news: true, events: true }, ["news", "news"])).toBe("failed");
    });

    it("reads a number item as its text, anything else as no option", () => {
      expect(read({ 1: true }, [1])).toBe("passed");
      expect(read({ news: true }, [null])).toBe("failed");
      expect(read({ news: true }, [["news"]])).toBe("failed");
    });

    it("ne inverts it", () => {
      expect(read({ news: true }, ["news"], "ne")).toBe("failed");
      expect(read({ news: true }, ["offers"], "ne")).toBe("passed");
    });

    it("applies to a submitted record too", () => {
      const submitted = (value: unknown) =>
        judge({ kind: "expectSubmitted", path: "topics", value: value as never, line: 1 }, groupSnap({ events: false, news: true })).status;
      expect(submitted(["news"])).toBe("passed");
      expect(submitted(["events"])).toBe("failed");
    });

    it("reads a record by its shape when the context has no type, only when every value is a boolean", () => {
      const untyped = { componentIdOf: context.componentIdOf, evaluate: context.evaluate };
      const verdict = (topics: unknown, value: unknown) =>
        kernelFormTestJudge({ kind: "expectValue", path: "topics", op: "eq", value: value as never, line: 1 }, groupSnap(topics), untyped).status;
      expect(verdict({ news: true, offers: false }, ["news"])).toBe("passed");
      expect(verdict({ news: 1 }, ["news"])).toBe("failed");
      // A typed group reads any record: only a true ticks.
      expect(read({ news: true, count: 3 }, ["news"])).toBe("passed");
    });

    it("leaves a list against a list, and a record against a record, as the envelope compares them", () => {
      expect(read(["a", "b"], ["b", "a"])).toBe("failed");
      expect(read({ news: true }, { news: true })).toBe("passed");
      expect(read({ news: true, offers: false }, { news: true })).toBe("failed");
    });
  });

  it("ne inverts the comparison", () => {
    expect(judge({ kind: "expectValue", path: "age", op: "ne", value: 21, line: 1 }).status).toBe("passed");
    const failing = judge({ kind: "expectValue", path: "age", op: "ne", value: 20, line: 1 });
    expect(failing).toMatchObject({ status: "failed", code: "expect.value", params: { op: "ne" } });
  });

  it("reads the value of an own key only", () => {
    const snap = snapshot({ byPath: {} });
    expect(judge({ kind: "expectValue", path: "constructor", op: "eq", value: null, line: 1 }, snap).status).toBe("passed");
  });
});

describe("kernelFormTestJudge: formulas", () => {
  const over = (value: number): Expression => ({
    kind: "binary",
    operator: "gt",
    left: { kind: "path", path: "c_age" },
    right: { kind: "literal", value }
  });

  it("passes when the formula comes to true", () => {
    expect(judge({ kind: "expectFormula", formula: "age > 1", expression: over(1), line: 4 })).toEqual({ line: 4, status: "passed" });
  });

  it("fails otherwise with the result and the formula text", () => {
    expect(judge({ kind: "expectFormula", formula: "age > 30", expression: over(30), line: 4 })).toEqual({
      line: 4,
      status: "failed",
      code: "expect.formula",
      expected: true,
      actual: false,
      params: { formula: "age > 30" }
    });
  });

  it("reads a result that is not a yes-or-no as the rules read it: only true holds", () => {
    const text: Expression = { kind: "literal", value: "yes" };
    const result = judge({ kind: "expectFormula", formula: '"yes"', expression: text, line: 1 });
    expect(result).toMatchObject({ status: "failed", code: "expect.formula", actual: "yes" });
  });

  it("fails, not crashes, when the evaluator breaks", () => {
    const result = kernelFormTestJudge({ kind: "expectFormula", formula: "x", expression: over(1), line: 6 }, snapshot(), {
      componentIdOf: context.componentIdOf,
      evaluate: () => {
        throw new Error("boom");
      }
    });
    expect(result).toMatchObject({ line: 6, status: "failed", code: "expect.formula", params: { formula: "x", evaluated: false } });
  });
});

describe("kernelFormTestJudge: errors", () => {
  const errors = [
    { componentId: "c_age", path: "age", code: "required", stage: "required", message: "Enter your age" },
    { path: "name", code: "pattern", stage: "pattern", message: "Letters only" }
  ];

  it("expectError passes on a code, or any code when none is asked", () => {
    const snap = snapshot({ errors });
    expect(judge({ kind: "expectError", path: "age", code: "required", line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectError", path: "age", line: 1 }, snap).status).toBe("passed");
    // A match by path alone counts, as a server's error carries no component id.
    expect(judge({ kind: "expectError", path: "name", code: "pattern", line: 1 }, snap).status).toBe("passed");
  });

  it("expectError fails with the codes found on the field", () => {
    const snap = snapshot({ errors });
    expect(judge({ kind: "expectError", path: "age", code: "min", line: 2 }, snap)).toEqual({
      line: 2,
      status: "failed",
      code: "expect.error",
      expected: "min",
      actual: ["required"],
      params: { path: "age" }
    });
    expect(judge({ kind: "expectError", path: "topics", line: 2 }, snap)).toMatchObject({ expected: null, actual: [] });
  });

  it("expectMessage matches the message text exactly", () => {
    const snap = snapshot({ errors });
    expect(judge({ kind: "expectMessage", path: "age", message: "Enter your age", line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectMessage", path: "age", message: "enter your age", line: 3 }, snap)).toEqual({
      line: 3,
      status: "failed",
      code: "expect.message",
      expected: "enter your age",
      actual: ["Enter your age"],
      params: { path: "age" }
    });
  });

  it("expectNoError with a path looks at that field only", () => {
    const snap = snapshot({ errors });
    expect(judge({ kind: "expectNoError", path: "topics", line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectNoError", path: "age", line: 5 }, snap)).toEqual({
      line: 5,
      status: "failed",
      code: "expect.noError",
      expected: [],
      actual: [{ path: "age", code: "required" }],
      params: { path: "age" }
    });
  });

  it("expectNoError without a path wants no errors at all", () => {
    expect(judge({ kind: "expectNoError", line: 1 }).status).toBe("passed");
    const result = judge({ kind: "expectNoError", line: 6 }, snapshot({ errors: [{ componentId: "c_x", code: "server", stage: "server" }] }));
    expect(result).toEqual({
      line: 6,
      status: "failed",
      code: "expect.noError",
      expected: [],
      actual: [{ componentId: "c_x", code: "server" }]
    });
  });
});

describe("kernelFormTestJudge: verdict, submission and layout", () => {
  it("expectVerdict", () => {
    expect(judge({ kind: "expectVerdict", verdict: "accepted", line: 1 }, snapshot({ verdict: "accepted" })).status).toBe("passed");
    expect(judge({ kind: "expectVerdict", verdict: "accepted", line: 2 }, snapshot({ verdict: "refused" }))).toEqual({
      line: 2,
      status: "failed",
      code: "expect.verdict",
      expected: "accepted",
      actual: "refused"
    });
    expect(judge({ kind: "expectVerdict", verdict: "refused", line: 3 })).toEqual({
      line: 3,
      status: "failed",
      code: "expect.noVerdict",
      expected: "refused"
    });
  });

  it("expectSubmitted", () => {
    const snap = snapshot({ submitted: { age: 20, name: "Ada" } });
    expect(judge({ kind: "expectSubmitted", path: "age", value: 20, line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectSubmitted", path: "age", value: 21, line: 2 }, snap)).toEqual({
      line: 2,
      status: "failed",
      code: "expect.submitted",
      expected: 21,
      actual: 20,
      params: { path: "age" }
    });
    expect(judge({ kind: "expectSubmitted", path: "topics", value: null, line: 3 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectSubmitted", path: "age", value: 20, line: 4 })).toMatchObject({ status: "failed", code: "expect.notSubmitted" });
  });

  it("expectWithheld", () => {
    expect(judge({ kind: "expectWithheld", path: "name", line: 1 }, snapshot({ withheld: ["name"] })).status).toBe("passed");
    expect(judge({ kind: "expectWithheld", path: "age", line: 2 }, snapshot({ withheld: ["name"] }))).toEqual({
      line: 2,
      status: "failed",
      code: "expect.withheld",
      expected: true,
      actual: false,
      params: { path: "age" }
    });
    expect(judge({ kind: "expectWithheld", path: "age", line: 3 }).code).toBe("expect.notSubmitted");
  });

  it("expectWithheld reports what the accepted submission carried instead as params.sent", () => {
    const sent = snapshot({ withheld: ["name"], submitted: { age: 20, topics: ["a"] } });
    expect(judge({ kind: "expectWithheld", path: "age", line: 1 }, sent)).toEqual({
      line: 1,
      status: "failed",
      code: "expect.withheld",
      expected: true,
      actual: false,
      params: { path: "age", sent: 20 }
    });
    expect(judge({ kind: "expectWithheld", path: "topics", line: 2 }, sent).params).toEqual({ path: "topics", sent: ["a"] });
    // Neither withheld nor carried (never answered): nothing to report as sent.
    expect(judge({ kind: "expectWithheld", path: "items[0].qty", line: 3 }, sent).params).toEqual({ path: "items[0].qty" });
    // Withheld after a check, with no envelope: no `sent`, the submission is not known.
    expect(judge({ kind: "expectWithheld", path: "age", line: 4 }, snapshot({ withheld: [] })).params).toEqual({ path: "age" });
    // A carried null is reported, as JSON carries it; a key spelled like a prototype member is read as its own.
    expect(judge({ kind: "expectWithheld", path: "age", line: 5 }, snapshot({ withheld: [], submitted: { age: null } })).params).toEqual({ path: "age", sent: null });
    expect(judge({ kind: "expectWithheld", path: "constructor", line: 6 }, snapshot({ withheld: [], submitted: {} })).params).toEqual({ path: "constructor" });
  });

  it("expectRows counts the rows the snapshot lists, and a path it does not list is not a collection", () => {
    expect(judge({ kind: "expectRows", path: "items", count: 2, line: 1 }).status).toBe("passed");
    expect(judge({ kind: "expectRows", path: "items", count: 3, line: 2 })).toEqual({
      line: 2,
      status: "failed",
      code: "expect.rows",
      expected: 3,
      actual: 2,
      params: { path: "items" }
    });
    // A listed collection with no row counts 0; one the snapshot does not list is an unknown field.
    expect(judge({ kind: "expectRows", path: "items", count: 0, line: 3 }, snapshot({ rows: { items: 0 } })).status).toBe("passed");
    expect(judge({ kind: "expectRows", path: "items", count: 0, line: 3 }, snapshot({ rows: {} }))).toEqual({
      line: 3,
      status: "failed",
      code: "expect.unknownField",
      params: { path: "items" }
    });
    expect(judge({ kind: "expectRows", path: "age", count: 0, line: 4 }).code).toBe("expect.unknownField");
  });

  it("expectLayout", () => {
    expect(judge({ kind: "expectLayout", layout: "short", line: 1 }, snapshot({ layout: "short" })).status).toBe("passed");
    expect(judge({ kind: "expectLayout", layout: "long", line: 2 }, snapshot({ layout: "short" }))).toEqual({
      line: 2,
      status: "failed",
      code: "expect.layout",
      expected: "long",
      actual: "short"
    });
  });
});

describe("kernelFormTestJudge: journeys", () => {
  const trace = (pages: string[], end: "end" | "exit" = "end") => ({ pages, end, decisions: [] });

  it("expectPage", () => {
    expect(judge({ kind: "expectPage", page: "b", line: 1 }, snapshot({ page: "b" })).status).toBe("passed");
    expect(judge({ kind: "expectPage", page: "b", line: 2 }, snapshot({ page: "a" }))).toEqual({
      line: 2,
      status: "failed",
      code: "expect.page",
      expected: "b",
      actual: "a"
    });
    expect(judge({ kind: "expectPage", page: "b", line: 3 }).code).toBe("expect.noJourney");
  });

  it("expectPath wants the pages equal and in order", () => {
    const snap = snapshot({ trace: trace(["a", "b", "c"]) });
    expect(judge({ kind: "expectPath", pages: ["a", "b", "c"], line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectPath", pages: ["a", "c", "b"], line: 2 }, snap)).toEqual({
      line: 2,
      status: "failed",
      code: "expect.path",
      expected: ["a", "c", "b"],
      actual: ["a", "b", "c"]
    });
    expect(judge({ kind: "expectPath", pages: ["a"], line: 3 }).code).toBe("expect.noJourney");
  });

  it("expectPathEnd distinguishes running off the end from an exit page", () => {
    const ended = snapshot({ trace: trace(["a", "b"]) });
    const exited = snapshot({ trace: trace(["a", "stop"], "exit") });
    expect(judge({ kind: "expectPathEnd", line: 1 }, ended).status).toBe("passed");
    expect(judge({ kind: "expectPathEnd", exit: "stop", line: 1 }, exited).status).toBe("passed");
    expect(judge({ kind: "expectPathEnd", line: 2 }, exited)).toEqual({
      line: 2,
      status: "failed",
      code: "expect.pathEnd",
      expected: { end: "end" },
      // The last page always, so Accept can write `path ends at stop`.
      actual: { end: "exit", last: "stop" }
    });
    expect(judge({ kind: "expectPathEnd", exit: "stop", line: 6 }, ended)).toEqual({
      line: 6,
      status: "failed",
      code: "expect.pathEnd",
      expected: { end: "exit", last: "stop" },
      actual: { end: "end", last: "b" }
    });
    // A path with no page has no last page: `null` only where an exit was expected.
    const empty = snapshot({ trace: trace([]) });
    expect(judge({ kind: "expectPathEnd", exit: "stop", line: 7 }, empty)).toMatchObject({ actual: { end: "end", last: null } });
    expect(judge({ kind: "expectPathEnd", line: 8 }, snapshot({ trace: trace([], "exit") }))).toEqual({
      line: 8,
      status: "failed",
      code: "expect.pathEnd",
      expected: { end: "end" },
      actual: { end: "exit" }
    });
    expect(judge({ kind: "expectPathEnd", exit: "other", line: 3 }, exited)).toMatchObject({
      status: "failed",
      code: "expect.pathEnd",
      expected: { end: "exit", last: "other" },
      actual: { end: "exit", last: "stop" }
    });
    expect(judge({ kind: "expectPathEnd", exit: "stop", line: 4 }, ended).status).toBe("failed");
    expect(judge({ kind: "expectPathEnd", line: 5 }).code).toBe("expect.noJourney");
  });

  it("expectOnPath compares membership with on", () => {
    const snap = snapshot({ trace: trace(["a", "b"]), pages: ["a", "b", "c"] });
    expect(judge({ kind: "expectOnPath", page: "b", on: true, line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectOnPath", page: "c", on: false, line: 1 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectOnPath", page: "c", on: true, line: 2 }, snap)).toEqual({
      line: 2,
      status: "failed",
      code: "expect.onPath",
      expected: true,
      actual: false,
      params: { page: "c" }
    });
    expect(judge({ kind: "expectOnPath", page: "a", on: false, line: 3 }, snap).status).toBe("failed");
    expect(judge({ kind: "expectOnPath", page: "a", on: true, line: 4 }).code).toBe("expect.noJourney");
  });
});

describe("kernel shape of the judge", () => {
  it("lists every kernel function in the module's list", () => {
    for (const fn of FORM_TEST_RUN_FUNCTIONS) {
      expect(fn.name).toMatch(/^kernel/);
    }
    expect(FORM_TEST_RUN_FUNCTIONS).toContain(kernelFormTestJudge);
  });
});

// --- The runner ---

interface FakeOptions {
  snapshots?: FormTestSnapshot[];
  startResult?: { error: FormTestStartError } | undefined;
  startThrows?: boolean;
  failOn?: string;
  snapshotThrows?: boolean;
  asyncActions?: boolean;
  /** What a row action answers with: a coded refusal, as a driver reports one. */
  rowResult?: FormTestRefusal;
}

function fakeDriver(options: FakeOptions = {}) {
  const calls: string[] = [];
  const queue = [...(options.snapshots ?? [snapshot()])];
  let disposed = 0;
  const act = async (name: string): Promise<void> => {
    calls.push(name);
    if (options.asyncActions === true) {
      await Promise.resolve();
    }
    if (options.failOn === name.split(" ")[0]) {
      throw new Error(`${name} broke`);
    }
  };
  const driver: FormTestDriver = {
    start: (givens: FormTestGiven[]) => {
      calls.push(`start ${givens.length}`);
      if (options.startThrows === true) {
        throw new Error("start broke");
      }
      return options.startResult;
    },
    set: (path, value) => act(`set ${path} ${JSON.stringify(value)}`),
    clear: (path) => act(`clear ${path}`),
    addRow: async (path) => {
      await act(`addRow ${path}`);
      return options.rowResult;
    },
    removeRow: async (path, index) => {
      await act(`removeRow ${path} ${index}`);
      return options.rowResult;
    },
    continue: () => act("continue"),
    back: () => act("back"),
    goTo: (page) => act(`goTo ${page}`),
    change: (path) => act(`change ${path}`),
    check: () => act("check"),
    submit: () => act("submit"),
    snapshot: () => {
      calls.push("snapshot");
      if (options.snapshotThrows === true) {
        throw new Error("snapshot broke");
      }
      const next = queue.length > 1 ? queue.shift() : queue[0];
      return next as FormTestSnapshot;
    },
    evaluate: context.evaluate,
    componentIdOf: context.componentIdOf,
    typeOf: context.typeOf,
    dispose: () => {
      disposed += 1;
    }
  };
  return { driver, calls, disposed: () => disposed };
}

function scenario(steps: FormTestStatement[], patch: Partial<FormTestScenario> = {}): FormTestScenario {
  const span = { line: 1, start: 0, end: 0 };
  return { name: "adult", nameSpan: span, givens: [], steps, refs: [], line: 1, span, ...patch };
}

const set = (line: number): FormTestStatement => ({ kind: "set", path: "age", value: 20, line });
const visible = (line: number, path = "age"): FormTestStatement => ({ kind: "expectState", path, state: "visible", line });

describe("runFormTestScenario", () => {
  it("passes a scenario whose expectations pass, recording each action as ran", async () => {
    const { driver, calls, disposed } = fakeDriver();
    const result = await runFormTestScenario(scenario([set(2), visible(3)]), driver);
    expect(result).toEqual({
      name: "adult",
      status: "passed",
      steps: [
        { line: 2, status: "ran" },
        { line: 3, status: "passed" }
      ]
    });
    expect(calls).toEqual(["start 0", 'set age 20', "snapshot"]);
    expect(disposed()).toBe(1);
  });

  it("passes the givens to start", async () => {
    const { driver, calls } = fakeDriver();
    await runFormTestScenario(scenario([], { givens: [{ kind: "given", key: "today", value: "2026-01-01", line: 2 }] }), driver);
    expect(calls[0]).toBe("start 1");
  });

  it("fails when any expectation fails and keeps going to the end", async () => {
    const { driver } = fakeDriver();
    const result = await runFormTestScenario(scenario([visible(2, "name"), visible(3)]), driver);
    expect(result.status).toBe("failed");
    expect(result.reason).toBeUndefined();
    expect(result.steps.map((step) => step.status)).toEqual(["failed", "passed"]);
  });

  it("takes one snapshot per run of consecutive expectations", async () => {
    const { driver, calls } = fakeDriver({ asyncActions: true });
    await runFormTestScenario(scenario([visible(2), visible(3), set(4), visible(5), visible(6), set(7), set(8), visible(9)]), driver);
    expect(calls.filter((call) => call === "snapshot")).toHaveLength(3);
    expect(calls).toEqual([
      "start 0",
      "snapshot",
      "set age 20",
      "snapshot",
      "set age 20",
      "set age 20",
      "snapshot"
    ]);
  });

  it("judges after an action against the snapshot taken after it", async () => {
    const first = snapshot({ byPath: { age: 1 } });
    const second = snapshot({ byPath: { age: 20 } });
    const { driver } = fakeDriver({ snapshots: [first, second] });
    const result = await runFormTestScenario(
      scenario([
        { kind: "expectValue", path: "age", op: "eq", value: 1, line: 2 },
        set(3),
        { kind: "expectValue", path: "age", op: "eq", value: 20, line: 4 }
      ]),
      driver
    );
    expect(result.status).toBe("passed");
  });

  it("calls every action kind on the driver", async () => {
    const { driver, calls } = fakeDriver();
    await runFormTestScenario(
      scenario([
        { kind: "set", path: "age", value: "x", line: 2 },
        { kind: "clear", path: "age", line: 3 },
        { kind: "addRow", path: "items", line: 4 },
        { kind: "removeRow", path: "items", index: 1, line: 5 },
        { kind: "continue", line: 6 },
        { kind: "back", line: 7 },
        { kind: "goTo", page: "b", line: 8 },
        { kind: "check", line: 9 },
        { kind: "submit", line: 10 }
      ]),
      driver
    );
    expect(calls.slice(1)).toEqual(['set age "x"', "clear age", "addRow items", "removeRow items 1", "continue", "back", "goTo b", "check", "submit"]);
  });

  it("passes a scenario with no expectations", async () => {
    const { driver } = fakeDriver();
    const result = await runFormTestScenario(scenario([set(2)]), driver);
    expect(result.status).toBe("passed");
  });

  it("skips a scenario whose every expectation skipped, with the first skip code", async () => {
    const snap = snapshot({ unreplayable: { c_age: "unreplayable.clock", c_name: "unreplayable.host" } });
    const { driver } = fakeDriver({ snapshots: [snap] });
    const result = await runFormTestScenario(scenario([set(2), visible(3), visible(4, "name")]), driver);
    expect(result.status).toBe("skipped");
    expect(result.reason).toBe("unreplayable.clock");
    expect(result.steps.map((step) => step.status)).toEqual(["ran", "skipped", "skipped"]);
  });

  it("passes when some expectations skipped and the rest passed", async () => {
    const snap = snapshot({ unreplayable: { c_name: "unreplayable.host" } });
    const { driver } = fakeDriver({ snapshots: [snap] });
    const result = await runFormTestScenario(scenario([visible(2), visible(3, "name")]), driver);
    expect(result.status).toBe("passed");
  });

  it("fails over skipped when one expectation failed", async () => {
    const snap = snapshot({ unreplayable: { c_age: "unreplayable.host" } });
    const { driver } = fakeDriver({ snapshots: [snap] });
    const result = await runFormTestScenario(scenario([visible(2), visible(3, "name")]), driver);
    expect(result.status).toBe("failed");
  });

  it("ends as an error when an action throws, recording action.failed and stopping the walk", async () => {
    const { driver, calls, disposed } = fakeDriver({ failOn: "continue" });
    const result = await runFormTestScenario(scenario([set(2), { kind: "continue", line: 3 }, visible(4)]), driver);
    expect(result.status).toBe("error");
    expect(result.steps).toEqual([
      { line: 2, status: "ran" },
      { line: 3, status: "error", code: "action.failed", params: { message: "continue broke" } }
    ]);
    expect(calls).not.toContain("snapshot");
    expect(disposed()).toBe(1);
  });

  it("treats a rejected action the same as a thrown one", async () => {
    const { driver } = fakeDriver({ failOn: "set", asyncActions: true });
    const result = await runFormTestScenario(scenario([set(2)]), driver);
    expect(result.status).toBe("error");
    expect(result.steps[0]).toMatchObject({ status: "error", code: "action.failed" });
  });

  it("makes a snapshot failure an error too", async () => {
    const { driver, disposed } = fakeDriver({ snapshotThrows: true });
    const result = await runFormTestScenario(scenario([visible(2), visible(3)]), driver);
    expect(result.status).toBe("error");
    // No action failed: the code says the snapshot did.
    expect(result.steps).toEqual([{ line: 2, status: "error", code: "snapshot.failed", params: { message: "snapshot broke" } }]);
    expect(disposed()).toBe(1);
  });

  it("keeps a failed expectation over a later error", async () => {
    const { driver } = fakeDriver({ failOn: "submit" });
    const result = await runFormTestScenario(scenario([visible(2, "name"), { kind: "submit", line: 3 }]), driver);
    // The walk ended at the error, but the failure before it stands.
    expect(result.status).toBe("failed");
  });

  it("ends as an error with the code when start returns one, running no step", async () => {
    const { driver, calls, disposed } = fakeDriver({ startResult: { error: "scenario.clockUnset" } });
    const result = await runFormTestScenario(scenario([set(2), visible(3)]), driver);
    expect(result).toEqual({ name: "adult", status: "error", reason: "scenario.clockUnset", steps: [] });
    expect(calls).toEqual(["start 0"]);
    expect(disposed()).toBe(1);
  });

  it("ends as an error when start throws", async () => {
    const { driver, disposed } = fakeDriver({ startThrows: true });
    const result = await runFormTestScenario(scenario([set(2)]), driver);
    expect(result).toEqual({ name: "adult", status: "error", reason: "action.failed", steps: [] });
    expect(disposed()).toBe(1);
  });

  it("skips a scenario marked skip without starting the driver", async () => {
    const { driver, calls } = fakeDriver();
    const result = await runFormTestScenario(scenario([set(2)], { skip: "waiting on the clock" }), driver);
    expect(result).toEqual({ name: "adult", status: "skipped", reason: "waiting on the clock", steps: [] });
    expect(calls).toEqual([]);
  });

  it("refuses a scenario over the step bound, running nothing", async () => {
    const { driver, calls } = fakeDriver();
    const steps = Array.from({ length: FORM_TEST_MAX_STEPS + 1 }, (_, index) => set(index + 2));
    const result = await runFormTestScenario(scenario(steps), driver);
    expect(result).toEqual({ name: "adult", status: "error", reason: "scenario.tooManySteps", steps: [] });
    expect(calls).toEqual([]);
    const atBound = await runFormTestScenario(scenario(steps.slice(0, FORM_TEST_MAX_STEPS)), fakeDriver().driver);
    expect(atBound.status).toBe("passed");
  });

  it("does not let a failing dispose hide the result", async () => {
    const { driver } = fakeDriver();
    driver.dispose = () => {
      throw new Error("dispose broke");
    };
    const result = await runFormTestScenario(scenario([visible(2)]), driver);
    expect(result.status).toBe("passed");
  });
});

describe("runFormTestScenarios", () => {
  it("makes a driver per scenario and disposes each", async () => {
    const made: ReturnType<typeof fakeDriver>[] = [];
    const results = await runFormTestScenarios(
      [scenario([visible(2)], { name: "one" }), scenario([visible(2, "name")], { name: "two" }), scenario([set(2)], { name: "three" })],
      () => {
        const fake = fakeDriver();
        made.push(fake);
        return fake.driver;
      }
    );
    expect(results.map((entry) => [entry.name, entry.status])).toEqual([
      ["one", "passed"],
      ["two", "failed"],
      ["three", "passed"]
    ]);
    expect(made).toHaveLength(3);
    expect(made.map((fake) => fake.disposed())).toEqual([1, 1, 1]);
  });

  it("awaits a driver made asynchronously", async () => {
    const results = await runFormTestScenarios([scenario([visible(2)])], async () => fakeDriver().driver);
    expect(results[0]?.status).toBe("passed");
  });

  it("makes no driver for a skipped scenario or one over the bound", async () => {
    let made = 0;
    const tooMany = Array.from({ length: FORM_TEST_MAX_STEPS + 1 }, (_, index) => set(index + 2));
    const results = await runFormTestScenarios(
      [scenario([], { name: "a", skip: "later" }), scenario(tooMany, { name: "b" }), scenario([visible(2)], { name: "c" })],
      () => {
        made += 1;
        return fakeDriver().driver;
      }
    );
    expect(made).toBe(1);
    expect(results.map((entry) => entry.status)).toEqual(["skipped", "error", "passed"]);
  });

  it("carries on after a scenario that errors, with a fresh driver for the next", async () => {
    const drivers: ReturnType<typeof fakeDriver>[] = [];
    const results = await runFormTestScenarios([scenario([set(2)], { name: "a" }), scenario([visible(2)], { name: "b" })], () => {
      const fake = fakeDriver(drivers.length === 0 ? { failOn: "set" } : {});
      drivers.push(fake);
      return fake.driver;
    });
    expect(results.map((entry) => entry.status)).toEqual(["error", "passed"]);
    expect(drivers.map((fake) => fake.disposed())).toEqual([1, 1]);
  });

  it("reports a driver that cannot be made as an error for that scenario only", async () => {
    let count = 0;
    const results = await runFormTestScenarios([scenario([visible(2)], { name: "a" }), scenario([visible(2)], { name: "b" })], () => {
      count += 1;
      if (count === 1) {
        throw new Error("no browser");
      }
      return fakeDriver().driver;
    });
    expect(results.map((entry) => entry.status)).toEqual(["error", "passed"]);
    expect(results[0]?.reason).toBe("scenario.driverFailed");
  });
});

// --- Judge edge cases ---

describe("an expect <formula> skips when it reads a component this side could not replay", () => {
  const reads = (path: string): Expression => ({
    kind: "binary",
    operator: "gt",
    left: { kind: "path", path },
    right: { kind: "literal", value: 5 }
  });
  const formula = (path: string) => ({ kind: "expectFormula" as const, formula: `${path} > 5`, expression: reads(path), line: 4 });

  it("skips with the reason of the first read component that has one", () => {
    const snap = snapshot({ unreplayable: { c_age: "unreplayable.browser" } });
    expect(judge(formula("c_age"), snap)).toEqual({ line: 4, status: "skipped", code: "unreplayable.browser" });
  });

  it("reads components by id: a value path that is no id is unknown before any skip", () => {
    const snap = snapshot({ unreplayable: { c_age: "unreplayable.clientDerived" } });
    expect(judge(formula("age"), snap)).toMatchObject({ status: "failed", code: "expect.unknownField" });
    expect(judge(formula("c_age"), snap)).toEqual({ line: 4, status: "skipped", code: "unreplayable.clientDerived" });
  });

  it("does not evaluate a formula it skips", () => {
    let called = 0;
    const result = kernelFormTestJudge(formula("c_age"), snapshot({ unreplayable: { c_age: "unreplayable.server" } }), {
      componentIdOf: context.componentIdOf,
      evaluate: () => {
        called += 1;
        return true;
      }
    });
    expect(result.status).toBe("skipped");
    expect(called).toBe(0);
  });

  it("judges a formula that reads only components it could replay", () => {
    const snap = snapshot({ unreplayable: { c_name: "unreplayable.host" } });
    // c_age holds 20, so `> 5` is true: judged, and it holds.
    expect(judge(formula("c_age"), snap).status).toBe("passed");
  });

  it("reads every branch of the formula, as the evaluator's read list does", () => {
    const snap = snapshot({ unreplayable: { c_name: "unreplayable.host" } });
    const expression: Expression = { kind: "logical", operator: "or", left: reads("c_age"), right: reads("c_name") };
    expect(judge({ kind: "expectFormula", formula: "x", expression, line: 4 }, snap)).toEqual({ line: 4, status: "skipped", code: "unreplayable.host" });
  });

  it("does not take a host. read for a component", () => {
    const snap = snapshot({ unreplayable: { host: "unreplayable.host" } });
    const expression: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "host.role" }, right: { kind: "literal", value: "a" } };
    expect(judge({ kind: "expectFormula", formula: "host.role = 'a'", expression, line: 4 }, snap).status).toBe("failed");
  });
});

describe("a checkbox group with nothing ticked reads as an empty list", () => {
  const group = (byPath: Record<string, unknown>, op: "eq" | "ne", value: never) =>
    judge({ kind: "expectValue", path: "topics", op, value, line: 1 }, snapshot({ byPath })).status;

  it("an untouched group, no value at all, equals ()", () => {
    expect(group({}, "eq", [] as never)).toBe("passed");
    expect(group({ topics: null }, "eq", [] as never)).toBe("passed");
    expect(group({}, "ne", [] as never)).toBe("failed");
  });

  it("an untouched group does not equal a list that names an option", () => {
    expect(group({}, "eq", ["a"] as never)).toBe("failed");
  });

  it("a group emptied after a pick reads the same as one never touched", () => {
    expect(group({ topics: { a: false, b: false } }, "eq", [] as never)).toBe("passed");
  });

  it("a field that is not a checkbox group keeps null apart from ()", () => {
    const text = judge({ kind: "expectValue", path: "name", op: "eq", value: [] as never, line: 1 }, snapshot({ byPath: {} }));
    expect(text.status).toBe("failed");
  });

  it("applies to the submitted record too", () => {
    const result = judge({ kind: "expectSubmitted", path: "topics", value: [] as never, line: 1 }, snapshot({ byPath: {}, submitted: {} }));
    expect(result.status).toBe("passed");
  });
});

describe("a journey the snapshot could not replay skips what reads the path", () => {
  const snap = snapshot({ traceUnreplayable: "unreplayable.browser", trace: { pages: ["one", "three"], end: "end", decisions: [] }, page: "three", pages: ["one", "two", "three"], withheld: [], submitted: { age: 1 } });
  const skipped = { status: "skipped", code: "unreplayable.browser" };

  it("skips the page, the path, where it ends and a page on or off it", () => {
    expect(judge({ kind: "expectPage", page: "two", line: 2 }, snap)).toMatchObject(skipped);
    expect(judge({ kind: "expectPath", pages: ["one", "two"], line: 2 }, snap)).toMatchObject(skipped);
    expect(judge({ kind: "expectPathEnd", line: 2 }, snap)).toMatchObject(skipped);
    expect(judge({ kind: "expectOnPath", page: "two", on: true, line: 2 }, snap)).toMatchObject(skipped);
  });

  it("skips withheld and submitted, which the path decides", () => {
    expect(judge({ kind: "expectWithheld", path: "age", line: 2 }, snap)).toMatchObject(skipped);
    expect(judge({ kind: "expectSubmitted", path: "age", value: 1, line: 2 }, snap)).toMatchObject(skipped);
  });

  it("leaves a plain value or state expectation alone", () => {
    expect(judge({ kind: "expectState", path: "age", state: "visible", line: 2 }, snap).status).toBe("passed");
    expect(judge({ kind: "expectValue", path: "age", op: "eq", value: 20, line: 2 }, snap).status).toBe("passed");
  });

  it("judges the path as usual when the snapshot says nothing", () => {
    const plain = snapshot({ trace: { pages: ["one", "three"], end: "end", decisions: [] }, page: "three", pages: ["one", "two", "three"] });
    expect(judge({ kind: "expectOnPath", page: "two", on: false, line: 2 }, plain).status).toBe("passed");
  });
});

describe("an expect <formula> over a field the form lacks fails", () => {
  const reads = (path: string): Expression => ({
    kind: "binary",
    operator: "eq",
    left: { kind: "path", path },
    right: { kind: "literal", value: null }
  });
  const formula = (path: string) => ({ kind: "expectFormula" as const, formula: `${path} = null`, expression: reads(path), line: 4 });

  it("fails expect.unknownField with the name, instead of comparing nothing to nothing", () => {
    expect(judge(formula("nosuchfield"))).toEqual({
      line: 4,
      status: "failed",
      code: "expect.unknownField",
      params: { path: "nosuchfield" }
    });
  });

  it("does not evaluate a formula it fails on a missing name", () => {
    let called = 0;
    const result = kernelFormTestJudge(formula("nosuchfield"), snapshot(), {
      componentIdOf: context.componentIdOf,
      evaluate: () => {
        called += 1;
        return true;
      }
    });
    expect(result.code).toBe("expect.unknownField");
    expect(called).toBe(0);
  });

  it("accepts a read that is a component id the snapshot lists (formulas read ids, as rules do)", () => {
    // `c_age` is no value path in this form, but it is a component the snapshot lists.
    expect(judge(formula("c_age")).code).not.toBe("expect.unknownField");
  });

  it("fails a read that is a value path but no id, with the id as the hint", () => {
    // The snapshot's values are keyed by id, so `age` would read nothing: a vacuous pass.
    expect(judge(formula("age"))).toEqual({
      line: 4,
      status: "failed",
      code: "expect.unknownField",
      params: { path: "age", id: "c_age" }
    });
  });

  it("gives no hint for a read that resolves to nothing", () => {
    expect(judge(formula("nosuchfield"))).toEqual({ line: 4, status: "failed", code: "expect.unknownField", params: { path: "nosuchfield" } });
  });

  it("names the first missing read of a formula that reads several", () => {
    const expression: Expression = { kind: "logical", operator: "and", left: reads("c_age"), right: { kind: "logical", operator: "and", left: reads("typo"), right: reads("other") } };
    expect(judge({ kind: "expectFormula", formula: "x", expression, line: 4 })).toMatchObject({ code: "expect.unknownField", params: { path: "typo" } });
  });

  it("leaves a host. read to the evaluator: it is no component", () => {
    expect(judge(formula("host.role")).code).not.toBe("expect.unknownField");
  });

  it("fails a row. or ancestor. read: no scenario has a row scope, so it would read null", () => {
    for (const path of ["row.qty", "ancestor.total"]) {
      expect(judge(formula(path)), path).toEqual({
        line: 4,
        status: "failed",
        code: "expect.unknownField",
        params: { path, reason: "noRowScope" }
      });
    }
  });

  it("names the first offending read in source order, a row scope or an unknown name alike", () => {
    const expression: Expression = { kind: "logical", operator: "and", left: reads("typo"), right: reads("row.qty") };
    expect(judge({ kind: "expectFormula", formula: "x", expression, line: 4 })).toMatchObject({ params: { path: "typo" } });
  });

  it("fails on an unknown name before it skips for an unreplayable one", () => {
    const snap = snapshot({ unreplayable: { c_age: "unreplayable.host" } });
    const expression: Expression = { kind: "logical", operator: "and", left: reads("c_age"), right: reads("typo") };
    expect(judge({ kind: "expectFormula", formula: "x", expression, line: 4 }, snap).code).toBe("expect.unknownField");
  });
});

describe("an expectation on a page the journey lacks, or a row it lacks, fails", () => {
  const journeySnap = (patch: Partial<FormTestSnapshot> = {}) =>
    snapshot({ trace: { pages: ["one", "three"], end: "end", decisions: [] }, page: "one", pages: ["one", "two", "three"], ...patch });

  it("expect <page> off path fails expect.unknownPage for a page the journey does not have", () => {
    expect(judge({ kind: "expectOnPath", page: "tow", on: false, line: 2 }, journeySnap())).toEqual({
      line: 2,
      status: "failed",
      code: "expect.unknownPage",
      params: { page: "tow" }
    });
    expect(judge({ kind: "expectOnPath", page: "tow", on: true, line: 2 }, journeySnap()).code).toBe("expect.unknownPage");
  });

  it("a page the journey has but the path skips is simply off the path", () => {
    expect(judge({ kind: "expectOnPath", page: "two", on: false, line: 2 }, journeySnap()).status).toBe("passed");
    expect(judge({ kind: "expectOnPath", page: "two", on: true, line: 2 }, journeySnap())).toMatchObject({ status: "failed", code: "expect.onPath" });
    expect(judge({ kind: "expectOnPath", page: "three", on: true, line: 2 }, journeySnap()).status).toBe("passed");
  });

  // A driver resolves a row field at any index to its component (`items[2].qty` is `c_qty`).
  const rowContext = {
    ...context,
    componentIdOf: (path: string) => (/^items\[\d+\]\.qty$/.test(path) ? "c_qty" : context.componentIdOf(path))
  };
  const judgeRows = (statement: FormTestExpectation, snap: FormTestSnapshot = snapshot()) => kernelFormTestJudge(statement, snap, rowContext);

  it("a row index at or past the row count is an unknown field with the reason", () => {
    const rowOut = { status: "failed", code: "expect.unknownField", params: { path: "items[2].qty", reason: "rowOutOfRange" } };
    expect(judgeRows({ kind: "expectState", path: "items[2].qty", state: "visible", line: 1 })).toMatchObject(rowOut);
    expect(judgeRows({ kind: "expectValue", path: "items[2].qty", op: "eq", value: null, line: 1 })).toMatchObject(rowOut);
    expect(judgeRows({ kind: "expectError", path: "items[2].qty", line: 1 })).toMatchObject(rowOut);
    expect(judgeRows({ kind: "expectMessage", path: "items[2].qty", message: "m", line: 1 })).toMatchObject(rowOut);
    expect(judgeRows({ kind: "expectNoError", path: "items[2].qty", line: 1 })).toMatchObject(rowOut);
  });

  it("so is a submitted or withheld expectation on a row past the count", () => {
    const rowOut = { status: "failed", code: "expect.unknownField", params: { path: "items[2].qty", reason: "rowOutOfRange" } };
    const submitted = snapshot({ submitted: {}, withheld: [] });
    expect(judgeRows({ kind: "expectSubmitted", path: "items[2].qty", value: null, line: 1 }, submitted)).toMatchObject(rowOut);
    expect(judgeRows({ kind: "expectWithheld", path: "items[2].qty", line: 1 }, submitted)).toMatchObject(rowOut);
    // A row that is there is judged on the record as before.
    expect(judgeRows({ kind: "expectSubmitted", path: "items[1].qty", value: null, line: 1 }, submitted).status).toBe("passed");
  });

  it("a row that is there is judged, and so is a snapshot that counts none of the collection", () => {
    // The base snapshot counts two rows of items: index 1 is the last, and exists.
    expect(judgeRows({ kind: "expectNoError", path: "items[1].qty", line: 1 }, snapshot({ rows: { items: 2 } }))).toMatchObject({ status: "passed" });
    expect(judgeRows({ kind: "expectNoError", path: "items[0].qty", line: 1 }, snapshot({ rows: {} })).code).not.toBe("expect.unknownField");
  });

  it("with no rows at all, row 0 is out of range", () => {
    expect(judgeRows({ kind: "expectNoError", path: "items[0].qty", line: 1 }, snapshot({ rows: { items: 0 } }))).toMatchObject({
      code: "expect.unknownField",
      params: { reason: "rowOutOfRange" }
    });
  });
});

describe("a refused row action is a coded refusal, not a thrown sentence", () => {
  const add = (line: number): FormTestStatement => ({ kind: "addRow", path: "items", line });
  const remove = (line: number): FormTestStatement => ({ kind: "removeRow", path: "items", index: 3, line });

  it("records action.refused with the action, the reason and the driver's params, and ends the walk", async () => {
    const { driver, calls, disposed } = fakeDriver({ rowResult: { refused: "rows.max", params: { path: "items", max: 2 } } });
    const result = await runFormTestScenario(scenario([set(2), add(3), visible(4)]), driver);
    expect(result.status).toBe("error");
    expect(result.steps).toEqual([
      { line: 2, status: "ran" },
      { line: 3, status: "error", code: "action.refused", params: { action: "addRow", reason: "rows.max", path: "items", max: 2 } }
    ]);
    expect(calls).not.toContain("snapshot");
    expect(disposed()).toBe(1);
  });

  it("names a removal as removeRow", async () => {
    const { driver } = fakeDriver({ rowResult: { refused: "rowOutOfRange" } });
    const result = await runFormTestScenario(scenario([remove(2)]), driver);
    expect(result.steps).toEqual([{ line: 2, status: "error", code: "action.refused", params: { action: "removeRow", reason: "rowOutOfRange" } }]);
  });

  it("keeps a failure before the refusal as the scenario's status", async () => {
    const { driver } = fakeDriver({ rowResult: { refused: "operations.add" } });
    const result = await runFormTestScenario(scenario([visible(2, "name"), add(3)]), driver);
    expect(result.status).toBe("failed");
    expect(result.steps.at(-1)).toMatchObject({ code: "action.refused", params: { reason: "operations.add" } });
  });

  it("params of the driver cannot overwrite the action or the reason", async () => {
    const { driver } = fakeDriver({ rowResult: { refused: "rows.max", params: { action: "x", reason: "y" } } });
    const result = await runFormTestScenario(scenario([add(2)]), driver);
    expect(result.steps[0]?.params).toEqual({ action: "addRow", reason: "rows.max" });
  });

  it("a row action that answers nothing is simply ran", async () => {
    const { driver } = fakeDriver();
    const result = await runFormTestScenario(scenario([add(2)]), driver);
    expect(result.steps).toEqual([{ line: 2, status: "ran" }]);
    expect(result.status).toBe("passed");
  });
});
