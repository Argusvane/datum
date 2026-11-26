import { describe, expect, it } from "vitest";

import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import type {
  FormTestProblem,
  FormTestProblemCode,
  FormTestScenario,
  FormTestScenarioResult,
  FormTestStepResult
} from "../../form-engine/core/form-tests/form-test-types.js";
import { FORM_TEST_MAX_STEPS } from "../../form-engine/core/form-tests/form-test-types.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { createTestsNaming, createTestsWords } from "../../form-engine/builder/form-tests/tests-words.js";
import type { TestsEntryModel, TestsEntryStatus } from "../../form-engine/builder/form-tests/tests-model.js";
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
import { FORM_TESTS_CLOCK_FIXTURE, FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

// The words of the Tests panel. The step data is not guessed: every
// sentence below is read off a scenario the browser runtime really ran on the fixture, so a
// change in what the judge reports moves a test here. Shapes the fixture cannot produce (a
// thrown action, a snapshot that failed) are written out by hand from the runner's source.

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

/** Runs one block and returns the scenario that parsed and what came of it. */
async function ran(lines: string[], definition: FormDefinition = FORM_TESTS_FIXTURE) {
  const source = ['test "one"', ...lines.map((line) => `  ${line}`)].join("\n");
  const run = await runFormTestsOnRuntime(definition, makeRuntime, [source]);
  expect(run.problems).toEqual([]);
  const result = run.results[0]!;
  const parsed = kernelParseFormTests(source, []);
  return { result, scenario: parsed.scenarios[0]!, step: result.steps.find((step) => step.status !== "passed" && step.status !== "ran")! };
}

const naming = createTestsNaming(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE);
const words = createTestsWords({ naming, text: undefined });

describe("createTestsNaming", () => {
  it("names a field by its label, found by id, by value path and by a row path", () => {
    expect(naming.labelOf("applicant_name")).toBe("Name");
    expect(naming.labelOf("age_next_year")).toBe("Age next year");
    expect(naming.labelOf("items[1].qty")).toBe("Quantity");
    expect(naming.labelOf("items")).toBe("Items");
  });

  it("is undefined for a path the form lacks", () => {
    expect(naming.labelOf("nothing_here")).toBeUndefined();
  });

  it("falls back to the id for a field with no label, and reads a localized label's default", () => {
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "bare", type: "text", configuration: {} },
          { id: "worded", type: "text", configuration: { label: { default: "Worded", locales: { fr: "Mot" } } } }
        ]
      }
    } as unknown as FormDefinition["root"];
    const small = createTestsNaming(root);
    expect(small.labelOf("bare")).toBe("bare");
    expect(small.labelOf("worded")).toBe("Worded");
  });

  it("names a data-keyed field by the path a test writes", () => {
    const root = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "first_name_field", type: "text", configuration: { label: "First name", dataKey: "firstName" } }] }
    } as unknown as FormDefinition["root"];
    expect(createTestsNaming(root).labelOf("firstName")).toBe("First name");
    expect(createTestsNaming(root).labelOf("first_name_field")).toBe("First name");
  });

  it("names pages by title and layouts by name, else leaves them to the id", () => {
    expect(naming.pageLabelOf("stop")).toBe("Not eligible");
    expect(naming.pageLabelOf("intro")).toBeUndefined();
    expect(naming.pageLabelOf("nowhere")).toBeUndefined();
    expect(naming.layoutLabelOf("standard")).toBeUndefined();
    const named = createTestsNaming(FORM_TESTS_FIXTURE.root, {
      ...FORM_TESTS_FIXTURE,
      pdf: { layouts: [{ id: "standard", kind: "generated", name: "Applicant copy", root: { id: "document", type: "pdf-document", configuration: {} } }] }
    } as unknown as FormDefinition);
    expect(named.layoutLabelOf("standard")).toBe("Applicant copy");
  });
});

describe("step: the failed expectations the browser runtime really reports", () => {
  // [lines, the sentence the author reads]
  const CASES: Array<[string, string[], string]> = [
    ["visible", [NONE, "expect pet_name visible"], "Expected Pet name to be shown; it is hidden."],
    ["hidden", [NONE, "set has_pet = true", "expect pet_name hidden"], "Expected Pet name to be hidden; it is shown."],
    ["required", [NONE, "expect email required"], "Expected Email to be required; it is optional."],
    ["optional", [NONE, 'set contact_method = "email"', "expect email optional"], "Expected Email to be optional; it is required."],
    ["enabled", [NONE, "expect nickname enabled"], "Expected Nickname to be enabled; it is disabled."],
    ["disabled", [NONE, "set wants_details = true", "expect nickname disabled"], "Expected Nickname to be disabled; it is enabled."],
    ["readonly", [NONE, "expect nickname readonly"], "Expected Nickname to be read only; it is editable."],
    ["editable", [NONE, 'set applicant_name = "Locked"', "expect nickname editable"], "Expected Nickname to be editable; it is read only."],
    ["empty", [NONE, 'set applicant_name = "Jane"', "expect applicant_name empty"], "Expected Name to be empty; it has an answer."],
    ["notEmpty", [NONE, "expect applicant_name not empty"], "Expected Name to have an answer; it is empty."],
    ["value", [NONE, "set age = 30", "expect age_next_year = 12"], "Expected Age next year to be 12; it is 31."],
    ["value !=", [NONE, "set age = 30", "expect age_next_year != 31"], "Expected Age next year not to be 31; it is."],
    ["value, no answer", [NONE, "expect age = 5"], "Expected Age to be 5; it has no answer."],
    ["value, text", [NONE, 'set applicant_name = "Jane"', 'expect applicant_name = "Joe"'], 'Expected Name to be "Joe"; it is "Jane".'],
    ["value, a checkbox group reads as its ticked options", [NONE, 'set topics = ("news", "events")', 'expect topics = ("news")'], 'Expected Topics to be ("news"); it is ("news", "events").'],
    ["formula", [NONE, "set age = 30", "expect age_next_year > 100"], "Expected age_next_year > 100 to hold; it came to false."],
    ["error, none raised", [NONE, "expect error on age: min"], "Expected an error on Age (min); there was none."],
    ["error, another code", [NONE, "check", "expect error on applicant_name: pattern"], "Expected an error on Name (pattern); it has required."],
    ["error, any code", [NONE, "expect error on applicant_name"], "Expected an error on Name; there was none."],
    ["message", [NONE, "check", 'expect message on applicant_name = "Nope"'], 'Expected the message "Nope" on Name; it shows "This field is required".'],
    ["no error on a field", [NONE, "check", "expect no error on applicant_name"], "Expected no error on Name; it has Name (required)."],
    ["no errors", [NONE, "check", "expect no errors"], "Expected no errors; found Name (required)."],
    ["verdict", [NONE, "submit", "expect accepted"], "Expected the form to be accepted; it was refused."],
    ["verdict before any submit", [NONE, "expect accepted"], "Expected the form to be accepted; nothing was submitted or checked before this line."],
    ["submitted before any submit", [NONE, 'expect submitted applicant_name = "x"'], "Nothing was submitted or checked before this line, so there is nothing to compare."],
    ["submitted", [NONE, 'set applicant_name = "Jane"', "submit", 'expect submitted applicant_name = "Joe"'], 'Expected Name to be sent as "Joe"; it was sent as "Jane".'],
    ["withheld", [NONE, 'set applicant_name = "Jane"', "submit", "expect applicant_name withheld"], "Expected Name to be left out of the submission; it was sent as \"Jane\"."],
    ["rows", [NONE, "add row to items", "expect rows of items = 3"], "Expected Items to have 3 rows; it has 1 row."],
    ["page", ["expect page = contact"], "Expected page contact; the form is on intro."],
    ["path", ["expect path = (intro, contact, details)"], "Expected the path intro, contact, details; it was intro, contact, review."],
    ["path end", ["expect path ends at stop"], "Expected the path to end by stopping at Not eligible; it ends by running off the end."],
    ["on path", ["expect details on path"], "Expected page details to be on the path; it is off it."],
    ["off path", ["set wants_details = true", "expect details off path"], "Expected page details to be off the path; it is on it."],
    ["a page the journey lacks", ["expect nopage on path"], "The journey has no page nopage."],
    ["no journey", [NONE, "expect page = intro"], "This test expects a page or path, but the form is not running a journey. Add a `given journey` line."],
    ["layout", [NONE, "expect layout = pets"], "Expected the PDF layout pets; the answers choose standard."],
    ["a field the form lacks", [NONE, "expect nothing_here visible"], "The form has no field nothing_here."],
    ["a row that is not there", [NONE, "expect items[3].qty empty"], "items[3].qty names a row the form does not have."],
    ["a row read in a formula", [NONE, "expect row.qty = 1"], "The formula reads row.qty, but a test has no row to read it from."],
    ["a refused row action", [NONE, "remove row 3 of items"], "Step could not run: that row is not there."]
  ];

  it.each(CASES)("%s", async (_name, lines, sentence) => {
    const { step, scenario } = await ran(lines);
    expect(words.step(step, scenario)).toBe(sentence);
  });

  it("names a row by its number when the path names one", () => {
    const step: FormTestStepResult = { line: 3, status: "failed", code: "expect.empty", expected: true, actual: false, params: { path: "items[1].qty" } };
    expect(words.step(step, undefined)).toBe("Expected Quantity (row 2) to be empty; it has an answer.");
  });

  it("says nothing for a step that went well", () => {
    expect(words.step({ line: 2, status: "passed" }, undefined)).toBe("");
    expect(words.step({ line: 2, status: "ran" }, undefined)).toBe("");
  });

  it("says an expectation that came to no answer in the language's word", () => {
    const step: FormTestStepResult = { line: 3, status: "failed", code: "expect.value", expected: "x", actual: null, params: { path: "applicant_name", op: "eq" } };
    expect(words.step(step, undefined)).toBe('Expected Name to be "x"; it has no answer.');
    const none: FormTestStepResult = { line: 3, status: "failed", code: "expect.value", expected: null, actual: 4, params: { path: "age", op: "eq" } };
    expect(words.step(none, undefined)).toBe("Expected Age to have no answer; it is 4.");
  });

  it("words a date as the language spells it, a long record cut at 80 characters, a list in parentheses", () => {
    const date: FormTestStepResult = { line: 3, status: "failed", code: "expect.value", expected: "2026-01-31", actual: "2026-02-01", params: { path: "age", op: "eq" } };
    expect(words.step(date, undefined)).toBe('Expected Age to be @"2026-01-31"; it is @"2026-02-01".');
    const record: Record<string, unknown> = {};
    for (let index = 0; index < 20; index += 1) {
      record[`key${index}`] = index;
    }
    const long: FormTestStepResult = { line: 3, status: "failed", code: "expect.value", expected: 1, actual: record, params: { path: "age", op: "eq" } };
    const sentence = words.step(long, undefined);
    const shown = /it is (.*)\.$/.exec(sentence)![1]!;
    expect(shown.startsWith('{"key0":0,"key1":1')).toBe(true);
    expect(shown).toHaveLength(80);
    expect(shown.endsWith("…")).toBe(true);
    const list: FormTestStepResult = { line: 3, status: "failed", code: "expect.value", expected: [1, 2], actual: ["a", null], params: { path: "topics", op: "eq" } };
    expect(words.step(list, undefined)).toBe('Expected Topics to be (1, 2); it is ("a", null).');
  });

  it("words the formula that could not be worked out, and the value that went out with a withheld answer", () => {
    expect(words.step({ line: 2, status: "failed", code: "expect.formula", expected: true, actual: null, params: { formula: "x > 1", evaluated: false } }, undefined)).toBe("Could not work out x > 1.");
    const sent: FormTestStepResult = { line: 2, status: "failed", code: "expect.withheld", expected: true, actual: false, params: { path: "phone", sent: "555" } };
    expect(words.step(sent, undefined)).toBe('Expected Phone to be left out of the submission; it was sent as "555".');
  });

  it("names the component of an error that has no path, and a layout by its name", () => {
    const step: FormTestStepResult = { line: 2, status: "failed", code: "expect.noError", expected: [], actual: [{ componentId: "email", code: "required" }, { path: "age", code: "min" }] };
    expect(words.step(step, undefined)).toBe("Expected no errors; found Email (required) and Age (min).");
    const named = createTestsWords({
      naming: createTestsNaming(FORM_TESTS_FIXTURE.root, {
        ...FORM_TESTS_FIXTURE,
        pdf: { layouts: [{ id: "pets", kind: "generated", name: "Pet copy", root: { id: "document", type: "pdf-document", configuration: {} } }] }
      } as unknown as FormDefinition),
      text: undefined
    });
    expect(named.step({ line: 2, status: "failed", code: "expect.layout", expected: "pets", actual: null }, undefined)).toBe("Expected the PDF layout Pet copy; the answers choose none.");
  });

  it("words an action that failed, a snapshot that could not be read, and a refusal by its reason", () => {
    expect(words.step({ line: 2, status: "error", code: "action.failed", params: { message: "boom" } }, undefined)).toBe("Step could not run: an action failed: boom.");
    expect(words.step({ line: 2, status: "error", code: "action.failed" }, undefined)).toBe("Step could not run: an action failed before the test could run.");
    expect(words.step({ line: 2, status: "error", code: "snapshot.failed", params: { message: "no view" } }, undefined)).toBe(
      "Step could not run: the form's state could not be read after the last action: no view."
    );
    expect(words.step({ line: 2, status: "error", code: "action.refused", params: { action: "addRow", reason: "rows.max", path: "items", max: 3 } }, undefined)).toBe(
      "Step could not run: the section already holds the most rows it may."
    );
    expect(words.step({ line: 2, status: "error", code: "action.refused", params: { action: "addRow", reason: "somethingNew" } }, undefined)).toBe(
      "Step could not run: the form turned it down (somethingNew)."
    );
    expect(words.step({ line: 2, status: "error", code: "action.refused", params: { action: "change", reason: "change.notReview", path: "name" } }, undefined)).toBe(
      "Step could not run: the test is not on a Check answers step."
    );
    expect(words.step({ line: 2, status: "error", code: "action.refused", params: { action: "change", reason: "change.notListed", path: "name" } }, undefined)).toBe(
      "Step could not run: the Check answers step does not list that answer."
    );
    expect(words.step({ line: 2, status: "error", code: "scenario.tooManySteps" }, undefined)).toBe(`Step could not run: A test may have at most ${FORM_TEST_MAX_STEPS} statements.`);
  });

  it("words a code this version does not know instead of dropping it", () => {
    expect(words.step({ line: 2, status: "failed", code: "expect.future" }, undefined)).toBe("This step came to expect.future.");
  });

  it("words every skip reason as 'Not judged here', for a step", () => {
    const reasons: Record<string, string> = {
      "unreplayable.host": "its rule reads a host value; add a `given host.` line",
      "unreplayable.server": "its rule runs only on the server",
      "unreplayable.secret": "its rule uses a server secret",
      "unreplayable.clock": "its rule reads today's date; add a `given today` line",
      "unreplayable.browser": "its rule runs only in the browser",
      "unreplayable.clientDerived": "a calculation reads an answer the server was not sent"
    };
    for (const [code, why] of Object.entries(reasons)) {
      expect(words.step({ line: 4, status: "skipped", code }, undefined)).toBe(`Not judged here: ${why}.`);
    }
    expect(words.step({ line: 4, status: "skipped" }, undefined)).toBe("Not judged here.");
  });

  it("words a real skip: a server-only rule", async () => {
    const { step } = await ran([NONE, 'set ref_number = "BAD"', "check", "expect error on ref_number: rule"]);
    expect(step.status).toBe("skipped");
    expect(words.step(step, undefined)).toBe("Not judged here: its rule runs only on the server.");
  });
});

describe("stepSides: the expected and actual halves of the failure card", () => {
  it("words each as the state or value alone", async () => {
    const sides = async (lines: string[]) => {
      const { step, scenario } = await ran(lines);
      return words.stepSides(step, scenario);
    };
    expect(await sides([NONE, "expect pet_name visible"])).toEqual({ expected: "shown", actual: "hidden" });
    expect(await sides([NONE, "expect nickname readonly"])).toEqual({ expected: "read only", actual: "editable" });
    expect(await sides([NONE, 'set applicant_name = "Jane"', "expect applicant_name empty"])).toEqual({ expected: "empty", actual: "has an answer" });
    expect(await sides([NONE, "set age = 30", "expect age_next_year = 12"])).toEqual({ expected: "12", actual: "31" });
    expect(await sides([NONE, 'set applicant_name = "Jane"', 'expect applicant_name = "Joe"'])).toEqual({ expected: '"Joe"', actual: '"Jane"' });
    expect(await sides([NONE, "expect age = 5"])).toEqual({ expected: "5", actual: "nothing" });
    expect(await sides([NONE, "expect error on age: min"])).toEqual({ expected: "an error (min)", actual: "no error" });
    expect(await sides([NONE, "check", "expect error on applicant_name: pattern"])).toEqual({ expected: "an error (pattern)", actual: "required" });
    expect(await sides([NONE, "submit", "expect accepted"])).toEqual({ expected: "accepted", actual: "refused" });
    expect(await sides([NONE, 'set applicant_name = "Jane"', "submit", 'expect submitted applicant_name = "Joe"'])).toEqual({ expected: 'sent as "Joe"', actual: 'sent as "Jane"' });
    expect(await sides([NONE, 'set applicant_name = "Jane"', "submit", "expect applicant_name withheld"])).toEqual({ expected: "left out of the submission", actual: 'sent as "Jane"' });
    expect(await sides([NONE, "add row to items", "expect rows of items = 3"])).toEqual({ expected: "3 rows", actual: "1 row" });
    expect(await sides(["expect page = contact"])).toEqual({ expected: "contact", actual: "intro" });
    expect(await sides(["expect path = (intro, contact, details)"])).toEqual({ expected: "intro, contact, details", actual: "intro, contact, review" });
    expect(await sides(["expect path ends at stop"])).toEqual({ expected: "stopping at Not eligible", actual: "running off the end" });
    expect(await sides(["expect details on path"])).toEqual({ expected: "on the path", actual: "off the path" });
    expect(await sides([NONE, "expect layout = pets"])).toEqual({ expected: "pets", actual: "standard" });
  });

  it("says the value that went out with a withheld answer, and 'not x' for a failed !=", () => {
    expect(words.stepSides({ line: 2, status: "failed", code: "expect.withheld", expected: true, actual: false, params: { path: "phone", sent: "555" } }, undefined)).toEqual({
      expected: "left out of the submission",
      actual: 'sent as "555"'
    });
    expect(words.stepSides({ line: 2, status: "failed", code: "expect.value", expected: 31, actual: 31, params: { path: "age", op: "ne" } }, undefined)).toEqual({ expected: "not 31", actual: "31" });
  });

  it("has none for a step that carries neither half", async () => {
    const { step, scenario } = await ran([NONE, "expect nothing_here visible"]);
    expect(words.stepSides(step, scenario)).toBeUndefined();
  });
});

describe("problem", () => {
  const PROBLEMS: Record<FormTestProblemCode, FormTestProblem> = {
    unknownStatement: { code: "unknownStatement", line: 3, start: 0, end: 4, params: { word: "sett" } },
    expectedName: { code: "expectedName", line: 3, start: 0, end: 4 },
    duplicateName: { code: "duplicateName", line: 3, start: 0, end: 4, params: { name: "twice" } },
    expectedPath: { code: "expectedPath", line: 3, start: 0, end: 4, params: { token: "3x" } },
    expectedValue: { code: "expectedValue", line: 3, start: 0, end: 4, params: { token: "abc" } },
    expectedPage: { code: "expectedPage", line: 3, start: 0, end: 4 },
    expectedNumber: { code: "expectedNumber", line: 3, start: 0, end: 4, params: { token: "x" } },
    expectedEquals: { code: "expectedEquals", line: 3, start: 0, end: 4 },
    expectedKeyword: { code: "expectedKeyword", line: 3, start: 0, end: 4, params: { expected: "to", token: "too" } },
    badState: { code: "badState", line: 3, start: 0, end: 4, params: { word: "shown" } },
    badCode: { code: "badCode", line: 3, start: 0, end: 4, params: { code: "a b" } },
    badGiven: { code: "badGiven", line: 3, start: 0, end: 4, params: { key: "today" } },
    givenAfterStep: { code: "givenAfterStep", line: 3, start: 0, end: 4 },
    duplicateGiven: { code: "duplicateGiven", line: 3, start: 0, end: 4, params: { key: "today" } },
    skipAfterStep: { code: "skipAfterStep", line: 3, start: 0, end: 4 },
    stepOutsideTest: { code: "stepOutsideTest", line: 3, start: 0, end: 4 },
    unterminatedString: { code: "unterminatedString", line: 3, start: 0, end: 4 },
    unclosedList: { code: "unclosedList", line: 3, start: 0, end: 4 },
    badFormula: { code: "badFormula", line: 3, start: 0, end: 4, params: { formulaCode: "unexpectedToken", token: ")" } },
    trailingText: { code: "trailingText", line: 3, start: 0, end: 4, params: { token: "more" } },
    tooLong: { code: "tooLong", line: 3, start: 0, end: 4, params: { max: 200000 } }
  };

  it.each(Object.entries(PROBLEMS))("words %s with the line in front, not the parser's fallback", (_code, problem) => {
    const said = words.problem(problem);
    expect(said.startsWith("Line 3: ")).toBe(true);
    expect(said.length).toBeGreaterThan("Line 3: ".length + 8);
    expect(said).not.toContain("could not be read");
    expect(said).not.toContain("{");
  });

  it("words the ones that carry data with it", () => {
    expect(words.problem(PROBLEMS.unknownStatement)).toBe('Line 3: Unknown statement "sett".');
    expect(words.problem(PROBLEMS.duplicateName)).toBe('Line 3: Another test is already called "twice"; give each test its own name.');
    expect(words.problem(PROBLEMS.expectedKeyword)).toBe('Line 3: Expected the word "to" but found "too".');
    expect(words.problem({ code: "unterminatedString", line: 2, start: 0, end: 1, params: { curly: 1 } })).toBe("Line 2: A curly quote is not a quote here; use straight quotes.");
    expect(words.problem({ code: "unclosedList", line: 2, start: 0, end: 1, params: { tooDeep: 1 } })).toBe("Line 2: The list nests too deeply.");
    expect(words.problem({ code: "expectedValue", line: 2, start: 0, end: 1, params: { expected: "list" } })).toBe("Line 2: Expected a list in brackets, like (1, 2).");
  });

  it("words a formula problem through the builder's formula wording", () => {
    const parsed = kernelParseFormTests('test "x"\n  expect age_next_year >', []);
    expect(parsed.problems).toHaveLength(1);
    const said = words.problem(parsed.problems[0]!);
    expect(said.startsWith("Line 2: This is not a formula the language reads: ")).toBe(true);
  });

  it("words every problem a real parse reports", () => {
    const sources = [
      'sett "x"',
      'test ""',
      'test "a"\n  set a..b = 1',
      'test "a"\n  set age = ',
      'test "a"\n  go to',
      'test "a"\n  remove row x of items',
      'test "a"\n  set age 1',
      'test "a"\n  add rows to items',
      'test "a"\n  expect age shown',
      'test "a"\n  expect error on age: a b',
      'test "a"\n  given today = "nope"\n  given today = @"2026-01-01"',
      'test "a"\n  set age = 1\n  given today = @"2026-01-01"',
      'test "a"\n  set age = 1\n  skip "later"',
      'test "a"\n  set name = "open',
      'test "a"\n  set topics = ("a"',
      'test "a"\n  expect age > ',
      'test "a"\n  continue now',
      'test "a"\ntest "a"'
    ];
    for (const source of sources) {
      const parsed = kernelParseFormTests(source, []);
      expect(parsed.problems.length, source).toBeGreaterThan(0);
      for (const problem of parsed.problems) {
        const said = words.problem(problem);
        expect(said, source).toMatch(/^Line \d+: \S/);
        expect(said, source).not.toContain("could not be read");
        expect(said, source).not.toMatch(/\{[a-z]+\}/);
      }
    }
  });

  it("falls back to the parser's English for a code a newer parser added", () => {
    const said = words.problem({ code: "somethingNew" as FormTestProblemCode, line: 5, start: 0, end: 1 });
    expect(said).toBe("Line 5: This line could not be read.");
  });
});

describe("reason: a scenario that was skipped or could not start", () => {
  const result = (status: FormTestScenarioResult["status"], reason: string | undefined, params?: Record<string, unknown>): FormTestScenarioResult => ({
    name: "n",
    status,
    ...(reason === undefined ? {} : { reason }),
    ...(params === undefined ? {} : { params }),
    steps: []
  });

  it("needs a day for a clock reader with no given today", async () => {
    const run = await runFormTestsOnRuntime(FORM_TESTS_CLOCK_FIXTURE, makeRuntime, ['test "clock"\n  expect age_group = "x"']);
    const clock = run.results[0]!;
    expect(clock.reason).toBe("scenario.clockUnset");
    expect(words.reason(clock)).toBe("Needs a day: add a `given today` line");
  });

  it("words the start errors the browser driver really reports", async () => {
    const reasonOf = async (lines: string[]) => words.reason((await ran(lines)).result);
    expect(await reasonOf(["given journey = elsewhere", "expect applicant_name visible"])).toBe("The form has no journey elsewhere.");
    expect(await reasonOf([NONE, 'given locale = "de"', "expect applicant_name visible"])).toBe("The form does not offer the language de.");
    expect(await reasonOf([NONE, 'given options for applicant_name = ("a")', "expect applicant_name visible"])).toBe(
      "The choices of Name do not come from a data source, so options cannot be given for it."
    );
    expect(await reasonOf([NONE, 'given options for nothing = ("a")', "expect applicant_name visible"])).toBe("Given options names nothing, which the form does not have.");
  });

  it("words a given by name and path, and one with neither", () => {
    expect(words.reason(result("error", "scenario.badGiven", { given: "host", path: "role" }))).toBe("The given host for role could not be applied.");
    expect(words.reason(result("error", "scenario.badGiven", { given: "host" }))).toBe("The given host could not be applied.");
    expect(words.reason(result("error", "scenario.badGiven"))).toBe("A given could not be applied.");
  });

  it("counts the formulas that do not compile", () => {
    expect(words.reason(result("error", "scenario.formulaInvalid", { problems: [{ code: "x", where: "a" }] }))).toBe("A formula in the form does not compile, so there is nothing to test.");
    expect(words.reason(result("error", "scenario.formulaInvalid", { problems: [{}, {}, {}] }))).toBe("3 formulas in the form do not compile, so there is nothing to test.");
  });

  it("words the driver and runner errors", () => {
    expect(words.reason(result("error", "scenario.driverFailed"))).toBe("The form could not be set up to run this test.");
    expect(words.reason(result("error", "scenario.tooManySteps"))).toBe(`A test may have at most ${FORM_TEST_MAX_STEPS} statements.`);
    expect(words.reason(result("error", "action.failed"))).toBe("The test could not start.");
  });

  it("words a skipped scenario by its reason, the author's own skip as written", () => {
    expect(words.reason(result("skipped", "unreplayable.host"))).toBe("Not judged here: its rule reads a host value; add a `given host.` line.");
    expect(words.reason(result("skipped", "waiting for the API"))).toBe("Skipped: waiting for the API");
    expect(words.reason(result("skipped", undefined))).toBe("Skipped.");
  });

  it("falls back to the failing step for an error that carries no reason, and says nothing for a pass", () => {
    const refused: FormTestScenarioResult = {
      name: "n",
      status: "error",
      steps: [{ line: 3, status: "error", code: "action.refused", params: { action: "removeRow", reason: "rowOutOfRange", path: "items" } }]
    };
    expect(words.reason(refused)).toBe("Step could not run: that row is not there.");
    expect(words.reason({ name: "n", status: "error", steps: [] })).toBe("The test ended in an error.");
    expect(words.reason({ name: "n", status: "passed", steps: [] })).toBe("");
  });
});

describe("summary and status", () => {
  const entry = (status: TestsEntryStatus, extra: Partial<TestsEntryModel> = {}): TestsEntryModel => ({ id: "test-1", source: "", problems: [], name: "n", status, ...extra });

  it("says one line per status", async () => {
    expect(words.summary(entry("unrun"))).toBe("Not run yet");
    expect(words.summary(entry("running"))).toBe("Running…");
    expect(words.summary(entry("passed"))).toBe("Passes");
    expect(words.summary(entry("stale"))).toBe("Not run since the last change");
  });

  it("puts the first problem of an entry that does not parse", () => {
    const parsed = kernelParseFormTests('test "a"\n  sett x = 1', []);
    expect(words.summary(entry("invalid", { problems: parsed.problems }))).toBe('Line 2: Unknown statement "sett".');
    expect(words.summary(entry("invalid"))).toBe("Does not parse");
  });

  it("gives a failed entry the line and the sentence without its frame", async () => {
    const { result } = await ran([NONE, 'set applicant_name = "Jane"', "submit", "expect applicant_name withheld"]);
    expect(words.summary(entry("failed", { result }))).toBe('Line 5: Name to be left out of the submission; it was sent as "Jane".');
    const missing = await ran([NONE, "expect nothing_here visible"]);
    expect(words.summary(entry("failed", { result: missing.result }))).toBe("Line 3: The form has no field nothing_here.");
  });

  it("gives a skipped or errored entry its reason", async () => {
    const clock = await runFormTestsOnRuntime(FORM_TESTS_CLOCK_FIXTURE, makeRuntime, ['test "clock"\n  expect age_group = "x"']);
    expect(words.summary(entry("error", { result: clock.results[0]! }))).toBe("Needs a day: add a `given today` line");
    expect(words.summary(entry("skipped", { result: { name: "n", status: "skipped", reason: "unreplayable.server", steps: [] } }))).toBe(
      "Not judged here: its rule runs only on the server."
    );
    const refused = await ran([NONE, "remove row 3 of items"]);
    expect(words.summary(entry("error", { result: refused.result }))).toBe("Line 3: Step could not run: that row is not there.");
    expect(words.summary(entry("skipped"))).toBe("Skipped");
    expect(words.summary(entry("error"))).toBe("Could not run");
  });

  it("has one word per status", () => {
    const statuses: TestsEntryStatus[] = ["invalid", "unrun", "running", "stale", "passed", "failed", "skipped", "error"];
    const said = statuses.map((status) => words.status(status));
    expect(said).toEqual(["Does not parse", "Not run yet", "Running", "Out of date", "Passed", "Failed", "Skipped", "Could not run"]);
    expect(new Set(said).size).toBe(statuses.length);
  });
});

describe("a host's catalog", () => {
  it("overrides one key and leaves the rest in English", async () => {
    const french = createTestsWords({
      naming,
      text: { locale: "fr", catalog: { fr: { "tests.word.expected": "Attendu : {what} ; {found}.", "tests.word.state.visible": "affiché" } } }
    });
    const { step, scenario } = await ran([NONE, "expect pet_name visible"]);
    expect(french.step(step, scenario)).toBe("Attendu : Pet name to be affiché ; it is hidden.");
    expect(french.status("passed")).toBe("Passed");
    expect(words.step(step, scenario)).toBe("Expected Pet name to be shown; it is hidden.");
  });

  it("capitalizes the short form for the locale", () => {
    const turkish = createTestsWords({ naming: createTestsNaming({ id: "form", type: "form", configuration: {}, children: { content: [{ id: "x", type: "text", configuration: { label: "ışık" } }] } } as unknown as FormDefinition["root"]), text: { locale: "tr" } });
    const entry: TestsEntryModel = {
      id: "t",
      source: "",
      problems: [],
      name: "n",
      status: "failed",
      result: { name: "n", status: "failed", steps: [{ line: 2, status: "failed", code: "expect.visible", expected: true, actual: false, params: { path: "x" } }] }
    };
    expect(turkish.summary(entry)).toBe("Line 2: Işık to be shown; it is hidden.");
  });
});

describe("the scenario argument", () => {
  it("is optional context: a missing scenario words the same", async () => {
    const { step, scenario } = await ran([NONE, "expect pet_name visible"]);
    expect(words.step(step, undefined)).toBe(words.step(step, scenario as FormTestScenario));
  });

  it("names the pages and layouts the naming gives, and the id otherwise", () => {
    const custom = createTestsWords({
      naming: { labelOf: () => undefined, pageLabelOf: (id) => (id === "contact" ? "Contact" : undefined), layoutLabelOf: () => undefined },
      text: undefined
    });
    expect(custom.step({ line: 2, status: "failed", code: "expect.page", expected: "contact", actual: "details" }, undefined)).toBe("Expected page Contact; the form is on details.");
    expect(custom.step({ line: 2, status: "failed", code: "expect.path", expected: ["intro", "contact", "details"], actual: ["intro", "details"] }, undefined)).toBe(
      "Expected the path intro, Contact, details; it was intro, details."
    );
  });
});
