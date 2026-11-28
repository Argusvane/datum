import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import type { FormTestScenarioResult, FormTestStepResult } from "../../form-engine/core/form-tests/form-test-types.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { acceptNewBehaviour, testsLiteral } from "../../form-engine/builder/form-tests/tests-accept.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import {
  runFormTestsOnRuntime,
  type FormTestRuntimeFactory,
  type FormTestRuntimeGivens
} from "../../form-engine/runtime/browser/form-test-runtime-driver.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

// Accept new behaviour. The point of the feature is that the rewritten
// line is true of the form as it is, so every rewrite below is run: the source goes through the
// browser runtime, the step fails, the line is accepted, and the new source passes on the same
// form. The step data is what the runtime really reports, not a guess.

const makeRuntime: FormTestRuntimeFactory = (definition: FormDefinition, givens: FormTestRuntimeGivens) => {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, {
    submissionModes: modes,
    validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]),
    journeyEngine: EagerJourneyEngine,
    wasmValidationHost: createInProcessWasmValidationHost([]),
    ...givens
  });
};

const NONE = "given journey = none";

async function runSource(source: string): Promise<FormTestScenarioResult> {
  const run = await runFormTestsOnRuntime(FORM_TESTS_FIXTURE, makeRuntime, [source]);
  expect(run.problems).toEqual([]);
  return run.results[0]!;
}

function sourceOf(lines: string[]): string {
  return ['test "one"', ...lines.map((line) => `  ${line}`)].join("\n");
}

/** Runs a block, accepts its failing step, and runs the rewritten source. */
async function accepted(lines: string[]) {
  const source = sourceOf(lines);
  const result = await runSource(source);
  const step = result.steps.find((entry) => entry.status === "failed")!;
  expect(step, "the block must fail somewhere").toBeDefined();
  const scenario = kernelParseFormTests(source, []).scenarios[0]!;
  const outcome = acceptNewBehaviour(source, scenario, step);
  if (!("source" in outcome)) {
    return { outcome, source, step };
  }
  const after = await runSource(outcome.source);
  return { outcome, source, step, after };
}

/** The accepted line, as `{ text }` with the rewritten source known to pass. */
async function line(lines: string[]): Promise<string> {
  const done = await accepted(lines);
  if (!("source" in done.outcome)) {
    throw new Error(`refused: ${done.outcome.refused}`);
  }
  expect(done.after!.status, JSON.stringify(done.after!.steps)).toBe("passed");
  expect(done.after!.steps.find((entry) => entry.line === (done.outcome as { line: number }).line)!.status).toBe("passed");
  return done.outcome.text;
}

describe("the rewrites, each run against the form", () => {
  it.each([
    ["visible to hidden", [NONE, "expect pet_name visible"], "  expect pet_name hidden"],
    ["hidden to visible", [NONE, "set has_pet = true", "expect pet_name hidden"], "  expect pet_name visible"],
    ["required to optional", [NONE, "expect email required"], "  expect email optional"],
    ["optional to required", [NONE, 'set contact_method = "email"', "expect email optional"], "  expect email required"],
    ["enabled to disabled", [NONE, "expect nickname enabled"], "  expect nickname disabled"],
    ["disabled to enabled", [NONE, "set wants_details = true", "expect nickname disabled"], "  expect nickname enabled"],
    ["readonly to editable", [NONE, "expect nickname readonly"], "  expect nickname editable"],
    ["editable to readonly", [NONE, 'set applicant_name = "Locked"', "expect nickname editable"], "  expect nickname readonly"],
    ["empty to not empty", [NONE, 'set applicant_name = "Jane"', "expect applicant_name empty"], "  expect applicant_name not empty"],
    ["not empty to empty", [NONE, "expect applicant_name not empty"], "  expect applicant_name empty"],
    ["a number", [NONE, "set age = 30", "expect age_next_year = 12"], "  expect age_next_year = 31"],
    ["!= becomes =", [NONE, "set age = 30", "expect age_next_year != 31"], "  expect age_next_year = 31"],
    ["no answer becomes null", [NONE, "expect age = 5"], "  expect age = null"],
    ["a string", [NONE, 'set applicant_name = "Jane"', 'expect applicant_name = "Joe"'], '  expect applicant_name = "Jane"'],
    ["a date", [NONE, 'set applicant_name = "2026-01-31"', 'expect applicant_name = "x"'], '  expect applicant_name = @"2026-01-31"'],
    ["a string with quotes, a backslash and a line break", [NONE, 'set applicant_name = "a \\"b\\" \\\\ c\\nd"', 'expect applicant_name = "x"'], '  expect applicant_name = "a \\"b\\" \\\\ c\\nd"'],
    ["a checkbox group is the list of its ticked options", [NONE, 'set topics = ("news", "events")', 'expect topics = ("news")'], '  expect topics = ("news", "events")'],
    ["no error raised", [NONE, "expect error on age: min"], "  expect no error on age"],
    ["no error raised, any code", [NONE, "expect error on applicant_name"], "  expect no error on applicant_name"],
    ["another error raised", [NONE, "check", "expect error on applicant_name: pattern"], "  expect error on applicant_name: required"],
    ["a message", [NONE, "check", 'expect message on applicant_name = "Nope"'], '  expect message on applicant_name = "This field is required"'],
    ["an error on a field that should have none", [NONE, "check", "expect no error on applicant_name"], "  expect error on applicant_name: required"],
    ["errors where there should be none", [NONE, "check", "expect no errors"], "  expect error on applicant_name: required"],
    ["refused where accepted was expected", [NONE, "submit", "expect accepted"], "  expect refused"],
    ["a submitted answer", [NONE, 'set applicant_name = "Jane"', "submit", 'expect submitted applicant_name = "Joe"'], '  expect submitted applicant_name = "Jane"'],
    ["a row count", [NONE, "add row to items", "expect rows of items = 3"], "  expect rows of items = 1"],
    ["a layout", [NONE, "expect layout = pets"], "  expect layout = standard"],
    ["a page", ["expect page = contact"], "  expect page = intro"],
    ["a path", ["expect path = (intro, contact, details)"], "  expect path = (intro, contact, review)"],
    ["a path that ends at the end", ["expect path ends at stop"], "  expect path ends"],
    ["on path to off path", ["expect details on path"], "  expect details off path"],
    ["off path to on path", ["set wants_details = true", "expect details off path"], "  expect details on path"]
  ] as Array<[string, string[], string]>)("%s", async (_name, lines, text) => {
    expect(await line(lines)).toBe(text);
  });

  it("writes a withheld answer as the submitted value when the side says what was sent", async () => {
    const source = sourceOf([NONE, 'set applicant_name = "Jane"', "submit", "expect applicant_name withheld"]);
    const result = await runSource(source);
    const step = result.steps.find((entry) => entry.status === "failed")!;
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    // The judge carries `params.sent` when the submitted record holds the answer, so the rewrite exists as it stands.
    expect(step.params).toMatchObject({ sent: "Jane" });
    const outcome = acceptNewBehaviour(source, scenario, step);
    expect(outcome).toMatchObject({ line: 5, text: '  expect submitted applicant_name = "Jane"' });
    // A step without it (the side could not say what was sent) is refused: there is no value to write.
    const { sent: _sent, ...without } = (step.params ?? {}) as Record<string, unknown>;
    expect(acceptNewBehaviour(source, scenario, { ...step, params: without })).toEqual({ refused: "noActual" });
    const after = await runSource((outcome as { source: string }).source);
    expect(after.status).toBe("passed");
  });
});

describe("a path that ends at an exit", () => {
  const lines = ['set stop_code = "STOP"', "expect path ends"];

  it("names the exit page when the step says where the path stopped", async () => {
    const source = sourceOf(lines);
    const step = (await runSource(source)).steps.find((entry) => entry.status === "failed")!;
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    // The judge always reports the path's last page (`actual.last`), so the rewrite is
    // `path ends at <page>` as the step stands, and it passes.
    expect(step.actual).toMatchObject({ end: "exit", last: "stop" });
    const outcome = acceptNewBehaviour(source, scenario, step);
    expect(outcome).toMatchObject({ text: "  expect path ends at stop" });
    expect((await runSource((outcome as { source: string }).source)).status).toBe("passed");
  });

  it("refuses when the step does not say which exit page", async () => {
    const source = sourceOf(lines);
    const step = (await runSource(source)).steps.find((entry) => entry.status === "failed")!;
    const { last: _last, ...actual } = (step.actual ?? {}) as Record<string, unknown>;
    expect(acceptNewBehaviour(source, kernelParseFormTests(source, []).scenarios[0]!, { ...step, actual })).toEqual({ refused: "noActual" });
  });
});

describe("what the rewrite keeps", () => {
  it("keeps the indentation, the keyword as written, and the comment, and changes only that line", async () => {
    const source = ['test "one"', "\tgiven journey = none  # whole form", '\tset applicant_name = "Jane" # a name', "\t  EXPECT   pet_name   visible    # the pet", "\tsubmit"].join("\n");
    const result = await runSource(source);
    const step = result.steps.find((entry) => entry.status === "failed")!;
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    const outcome = acceptNewBehaviour(source, scenario, step);
    expect(outcome).toEqual({
      source: ['test "one"', "\tgiven journey = none  # whole form", '\tset applicant_name = "Jane" # a name', "\t  EXPECT pet_name hidden    # the pet", "\tsubmit"].join("\n"),
      line: 4,
      text: "\t  EXPECT pet_name hidden    # the pet"
    });
    const after = await runSource((outcome as { source: string }).source);
    expect(after.status).toBe("passed");
  });

  it("keeps a # inside a quoted value out of the comment, and each line ending as it was", async () => {
    const source = 'test "one"\r\n  given journey = none\r\n  set applicant_name = "a # b"\r\n  expect applicant_name = "z" # why\r\n';
    const result = await runSource(source);
    const step = result.steps.find((entry) => entry.status === "failed")!;
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    const outcome = acceptNewBehaviour(source, scenario, step);
    expect(outcome).toEqual({
      source: 'test "one"\r\n  given journey = none\r\n  set applicant_name = "a # b"\r\n  expect applicant_name = "a # b" # why\r\n',
      line: 4,
      text: '  expect applicant_name = "a # b" # why'
    });
    expect((await runSource((outcome as { source: string }).source)).status).toBe("passed");
  });

  it("rewrites the second block's line by its line in the entry's source", async () => {
    const done = await accepted([NONE, "expect pet_name visible", "expect pet_name visible"]);
    // The first failing step ends the story the author fixes first; later lines stay as they were.
    expect((done.outcome as { source: string }).source.split("\n")).toEqual(['test "one"', "  given journey = none", "  expect pet_name hidden", "  expect pet_name visible"]);
  });
});

describe("what is refused", () => {
  it("refuses a formula expectation", async () => {
    const done = await accepted([NONE, "set age = 30", "expect age_next_year > 100"]);
    expect(done.outcome).toEqual({ refused: "formula" });
  });

  it("refuses an action that could not run", async () => {
    const source = sourceOf([NONE, "remove row 3 of items"]);
    const result = await runSource(source);
    const step = result.steps.find((entry) => entry.status === "error")!;
    expect(step.code).toBe("action.refused");
    expect(acceptNewBehaviour(source, kernelParseFormTests(source, []).scenarios[0]!, step)).toEqual({ refused: "action" });
    expect(acceptNewBehaviour(source, kernelParseFormTests(source, []).scenarios[0]!, { line: 3, status: "error", code: "action.failed" })).toEqual({ refused: "action" });
  });

  it("refuses a line that is not an expectation", () => {
    const source = sourceOf([NONE, 'set applicant_name = "Jane"']);
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    expect(acceptNewBehaviour(source, scenario, { line: 3, status: "failed", code: "expect.visible" })).toEqual({ refused: "notExpectation" });
    expect(acceptNewBehaviour(source, scenario, { line: 99, status: "failed", code: "expect.visible" })).toEqual({ refused: "notExpectation" });
  });

  it("refuses a record actual that is not a checkbox group's flags", () => {
    const source = sourceOf([NONE, "expect age = 1"]);
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    const step = (actual: unknown): FormTestStepResult => ({ line: 3, status: "failed", code: "expect.value", expected: 1, actual, params: { path: "age", op: "eq" } });
    expect(acceptNewBehaviour(source, scenario, step({ a: 1 }))).toEqual({ refused: "noActual" });
    expect(acceptNewBehaviour(source, scenario, step({}))).toEqual({ refused: "noActual" });
    expect(acceptNewBehaviour(source, scenario, step(Number.POSITIVE_INFINITY))).toEqual({ refused: "noActual" });
    expect(acceptNewBehaviour(source, scenario, step({ a: true, b: false }))).toMatchObject({ text: "  expect age = (\"a\")" });
  });

  it("refuses the expectations that are about the test, not the form", async () => {
    for (const lines of [[NONE, "expect nothing_here visible"], [NONE, "expect accepted"], [NONE, 'expect submitted applicant_name = "x"'], [NONE, "expect page = intro"]]) {
      const done = await accepted(lines);
      expect(done.outcome, lines.join(" / ")).toEqual({ refused: "noActual" });
    }
  });

  it("refuses a step that did not fail", () => {
    const source = sourceOf([NONE, "expect pet_name hidden"]);
    const scenario = kernelParseFormTests(source, []).scenarios[0]!;
    expect(acceptNewBehaviour(source, scenario, { line: 3, status: "passed" })).toEqual({ refused: "noActual" });
    expect(acceptNewBehaviour(source, scenario, { line: 3, status: "skipped", code: "unreplayable.server" })).toEqual({ refused: "noActual" });
  });
});

describe("testsLiteral", () => {
  it("spells values as the language does", () => {
    expect(testsLiteral("Jane")).toBe('"Jane"');
    expect(testsLiteral("2026-02-28")).toBe('@"2026-02-28"');
    expect(testsLiteral("2026-02-31")).toBe('"2026-02-31"');
    expect(testsLiteral(0)).toBe("0");
    expect(testsLiteral(-0)).toBe("0");
    expect(testsLiteral(1.5)).toBe("1.5");
    expect(testsLiteral(true)).toBe("true");
    expect(testsLiteral(null)).toBe("null");
    expect(testsLiteral(["a", 1, null, ["b"]])).toBe('("a", 1, null, ("b"))');
    expect(testsLiteral([])).toBe("()");
    expect(testsLiteral({ a: true, b: false, c: true })).toBe('("a", "c")');
    expect(testsLiteral({ a: 1 })).toBeUndefined();
    expect(testsLiteral(["a", { a: 1 }])).toBeUndefined();
  });
});
