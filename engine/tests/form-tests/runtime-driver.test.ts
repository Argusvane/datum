import { describe, expect, it } from "vitest";

import type { FormTestScenarioResult } from "../../form-engine/core/form-tests/form-test-types.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../../form-engine/runtime/browser/form-runtime.js";
import {
  createFormTestRuntimeDriver,
  runFormTestsOnRuntime,
  type FormTestRuntimeFactory,
  type FormTestRuntimeGivens
} from "../../form-engine/runtime/browser/form-test-runtime-driver.js";
import { EagerJourneyEngine } from "../../form-engine/runtime/browser/journey-engine-eager.js";
import { createFieldConstraintsStage } from "../../form-engine/validation/core/field-constraints.js";
import { ValidationPipeline } from "../../form-engine/validation/core/validation-pipeline.js";
import { createInProcessWasmValidationHost } from "../../form-engine/validation/wasm/in-process-host.js";
import {
  FORM_TESTS_CLOCK_FIXTURE,
  FORM_TESTS_FAILING_SCENARIO,
  FORM_TESTS_FIXTURE,
  FORM_TESTS_FIXTURE_SCENARIOS,
  fixtureWithTests
} from "./fixtures/form-tests-fixture.js";

// The browser runtime's driver for form tests: the fixture corpus played on
// a headless FormRuntime wired as a host wires one (the field-constraints stage, a `submit`
// mode, the in-process sandbox, the eager journey engine), the givens spread into its
// dependencies.

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

/** One test block run on the main fixture (or another form), with the result of its one scenario. */
async function runOne(lines: string[], definition: FormDefinition = FORM_TESTS_FIXTURE): Promise<FormTestScenarioResult> {
  const source = ['test "one"', ...lines.map((line) => `  ${line}`)].join("\n");
  const run = await runFormTestsOnRuntime(definition, makeRuntime, [source]);
  expect(run.problems).toEqual([]);
  expect(run.results).toHaveLength(1);
  return run.results[0]!;
}

function failures(result: FormTestScenarioResult) {
  return result.steps.filter((step) => step.status !== "passed" && step.status !== "ran");
}

describe("the fixture corpus on the browser runtime", () => {
  it.each(["main", "clock"] as const)("every %s scenario comes to the status the fixture expects", async (form) => {
    const run = await runFormTestsOnRuntime(fixtureWithTests(form), makeRuntime);
    expect(run.problems).toEqual([]);
    const expected = FORM_TESTS_FIXTURE_SCENARIOS.filter((entry) => entry.form === form);
    expect(run.results.map((result) => result.name)).toEqual(expected.map((entry) => entry.name));
    for (const [index, entry] of expected.entries()) {
      const result = run.results[index]!;
      // The failing steps in the message, so a regression says which expectation moved.
      expect({ name: result.name, status: result.status, failing: entry.expected.runtime === "passed" ? failures(result) : [] }).toEqual({
        name: entry.name,
        status: entry.expected.runtime,
        failing: []
      });
      if (entry.reason?.runtime !== undefined) {
        expect(result.reason).toBe(entry.reason.runtime);
      }
    }
  });

  it("the deliberate failure carries what was expected and what the snapshot held", async () => {
    const run = await runFormTestsOnRuntime(fixtureWithTests("main"), makeRuntime);
    const failing = run.results.find((result) => result.name === FORM_TESTS_FAILING_SCENARIO)!;
    expect(failing.status).toBe("failed");
    expect(failing.steps).toEqual([{ line: 2, status: "failed", code: "expect.optional", expected: true, actual: false, params: { path: "applicant_name" } }]);
  });

  it("the server-only check skips on this side with its reason, the rest of its scenario having run", async () => {
    const run = await runFormTestsOnRuntime(fixtureWithTests("main"), makeRuntime);
    const server = run.results.find((result) => result.name === "a server-only check is not the browser's to judge")!;
    expect(server.steps.map((step) => step.status)).toEqual(["ran", "ran", "skipped"]);
    expect(server.steps[2]).toEqual({ line: 5, status: "skipped", code: "unreplayable.server" });
  });
});

describe("runFormTestsOnRuntime: sources", () => {
  it("a source with parse problems contributes no scenario; its problems come first, by source", async () => {
    const bad = 'test "half read"\n  set applicant_name = \n  expect applicant_name visible';
    const good = 'test "from a file"\n  expect nowhere visible';
    const stored = 'test "stored"\n  expect applicant_name visible';
    const definition = { ...FORM_TESTS_FIXTURE, tests: { scenarios: [{ id: "s1", source: stored }, { id: "s2", source: bad }] } };
    const run = await runFormTestsOnRuntime(definition, makeRuntime, [bad, good]);
    expect(run.problems.map((entry) => entry.source)).toEqual([{ kind: "definition", id: "s2" }, { kind: "extra", index: 0 }]);
    expect(run.problems[0]!.problems.map((problem) => [problem.code, problem.line])).toEqual([["expectedValue", 2]]);
    // The definition's good scenario, then the good extra source; the bad ones ran nothing.
    expect(run.results.map((result) => result.name)).toEqual(["stored", "from a file"]);
    expect(run.results[1]!.steps).toEqual([{ line: 2, status: "failed", code: "expect.unknownField", params: { path: "nowhere" } }]);
  });

  it("a name used by two entries is a duplicateName problem on the later one, and both still run", async () => {
    const first = 'test "same"\n  expect applicant_name visible';
    const second = '\n\ntest "same"\n  expect applicant_name hidden';
    const definition = { ...FORM_TESTS_FIXTURE, tests: { scenarios: [{ id: "s1", source: first }, { id: "s2", source: second }] } };
    const run = await runFormTestsOnRuntime(definition, makeRuntime, ['test "same"\n  expect age visible', 'test "other"\n  expect age visible']);
    expect(run.problems.map((entry) => entry.source)).toEqual([{ kind: "definition", id: "s2" }, { kind: "extra", index: 0 }]);
    const [onSecond, onExtra] = run.problems;
    expect(onSecond!.problems).toEqual([
      { code: "duplicateName", line: 3, start: second.indexOf('"same"'), end: second.indexOf('"same"') + 6, params: { name: "same" } }
    ]);
    expect(onExtra!.problems.map((problem) => [problem.code, problem.line, problem.params])).toEqual([["duplicateName", 1, { name: "same" }]]);
    // All four ran, in source order, each under its own name.
    expect(run.results.map((result) => [result.name, result.status])).toEqual([
      ["same", "passed"],
      ["same", "failed"],
      ["same", "passed"],
      ["other", "passed"]
    ]);
  });

  it("the same name in different entries of one definition is not reported twice for the first", async () => {
    const a = 'test "one"\n  expect age visible\ntest "two"\n  expect age visible';
    const b = 'test "two"\n  expect age visible\ntest "three"\n  expect age visible';
    const definition = { ...FORM_TESTS_FIXTURE, tests: { scenarios: [{ id: "a", source: a }, { id: "b", source: b }] } };
    const run = await runFormTestsOnRuntime(definition, makeRuntime);
    expect(run.problems).toHaveLength(1);
    expect(run.problems[0]!.source).toEqual({ kind: "definition", id: "b" });
    expect(run.problems[0]!.problems.map((problem) => [problem.code, problem.params])).toEqual([["duplicateName", { name: "two" }]]);
    expect(run.results.map((result) => result.name)).toEqual(["one", "two", "two", "three"]);
  });

  it("each scenario has a runtime of its own: one scenario's answers never reach the next", async () => {
    const first = 'test "writes"\n  set applicant_name = "Ada"\n  expect applicant_name = "Ada"';
    const second = 'test "reads"\n  expect applicant_name empty';
    const run = await runFormTestsOnRuntime(FORM_TESTS_FIXTURE, makeRuntime, [first, second]);
    expect(run.results.map((result) => result.status)).toEqual(["passed", "passed"]);
  });
});

describe("the journey moves", () => {
  it("continue off a page with an error stays on the page, and moves once the error is fixed", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    expect(await driver.start([])).toBeUndefined();
    await driver.continue();
    let snapshot = await driver.snapshot();
    expect(snapshot.page).toBe("intro");
    expect(snapshot.errors.filter((error) => error.componentId === "applicant_name").map((error) => error.code)).toEqual(["required"]);
    await driver.set("applicant_name", "Ada");
    await driver.set("age", 30);
    await driver.continue();
    snapshot = await driver.snapshot();
    expect(snapshot.page).toBe("contact");
    expect(snapshot.trace).toEqual({ pages: ["intro", "contact", "review"], end: "end", decisions: [] });
  });

  it("the moves leave a form with no journey as it was (given journey = none)", async () => {
    const result = await runOne(["given journey = none", "continue", "back", "go to review", "expect applicant_name visible", "expect page = intro"]);
    expect(failures(result)).toEqual([{ line: 7, status: "failed", code: "expect.noJourney", expected: "intro" }]);
  });

  it("the journey asked for is honoured even by a factory that drops the choice", async () => {
    const ignoring: FormTestRuntimeFactory = (definition, givens) => {
      const { journey: _dropped, ...rest } = givens;
      return makeRuntime(definition, rest as FormTestRuntimeGivens);
    };
    const none = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime: ignoring });
    await none.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    expect((await none.snapshot()).page).toBeUndefined();
    const main = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime: ignoring });
    await main.start([{ kind: "given", key: "journey", value: "main", line: 2 }]);
    expect((await main.snapshot()).page).toBe("intro");
  });
});

describe("givens", () => {
  it("the locale words the messages: the rule's own and the engine's", async () => {
    const lines = ["given journey = none", 'set email = "a@example.com"', 'set confirm_email = "b@example.com"', "check"];
    const english = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await english.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    const french = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await french.start([
      { kind: "given", key: "journey", value: "none", line: 2 },
      { kind: "given", key: "locale", value: "fr", line: 3 }
    ]);
    for (const driver of [english, french]) {
      await driver.set("email", "a@example.com");
      await driver.set("confirm_email", "b@example.com");
      await driver.check();
    }
    const wording = async (driver: typeof english) =>
      Object.fromEntries((await driver.snapshot()).errors.map((error) => [`${error.componentId}:${error.code}`, error.message]));
    const inEnglish = await wording(english);
    const inFrench = await wording(french);
    expect(inEnglish["confirm_email:rule"]).toBe("The two emails must match.");
    expect(inFrench["confirm_email:rule"]).toBe("Les deux courriels doivent correspondre.");
    // The engine's own wording of `required` follows the locale too.
    expect(inEnglish["applicant_name:required"]).toBeDefined();
    expect(inFrench["applicant_name:required"]).toBeDefined();
    expect(inFrench["applicant_name:required"]).not.toBe(inEnglish["applicant_name:required"]);
    // And the English text does not pass in French.
    const result = await runOne([lines[0]!, 'given locale = "fr"', ...lines.slice(1), 'expect message on confirm_email = "The two emails must match."']);
    expect(result.status).toBe("failed");
    expect(failures(result)[0]).toMatchObject({ code: "expect.message", expected: "The two emails must match.", actual: ["Les deux courriels doivent correspondre."] });
  });

  it("a locale the form does not offer is a bad given", async () => {
    const result = await runOne(['given locale = "de"', "expect applicant_name visible"]);
    expect(result).toMatchObject({ status: "error", reason: "scenario.badGiven" });
  });

  it("a host. given steers a rule that reads the host, and an expect formula reads it as a rule does", async () => {
    // Written literal first: `expect host.role = "admin"` reads as a value check on a field of
    // that path, which the form does not have.
    const admin = await runOne(["given journey = none", 'given host.role = "admin"', "expect role_note visible", 'expect "admin" = host.role']);
    expect(failures(admin)).toEqual([]);
    const user = await runOne(["given journey = none", 'given host.role = "user"', "expect role_note visible"]);
    expect(failures(user)).toEqual([{ line: 4, status: "failed", code: "expect.visible", expected: true, actual: false, params: { path: "role_note" } }]);
  });

  it("given options answer the field's data source: without them the sandbox refuses the province", async () => {
    const lines = ["given journey = none", 'set applicant_name = "Ada"', "set age = 30", 'set province = "QC"', "submit"];
    const without = await runOne([...lines, "expect accepted"]);
    expect(failures(without)).toEqual([{ line: 7, status: "failed", code: "expect.verdict", expected: "accepted", actual: "refused" }]);
    const outside = await runOne([lines[0]!, 'given options for province = ("ON")', ...lines.slice(1), "expect refused", "expect error on province"]);
    expect(outside.status).toBe("passed");
    const unknown = await runOne(['given options for nowhere = ("ON")', "expect applicant_name visible"]);
    expect(unknown).toMatchObject({ status: "error", reason: "scenario.badGiven" });
    const noSource = await runOne(['given options for contact_method = ("email")', "expect applicant_name visible"]);
    expect(noSource).toMatchObject({ status: "error", reason: "scenario.badGiven" });
  });

  it("the day given decides a rule that reads the clock", async () => {
    const lines = ['set event_date = "2026-02-15"', "check"];
    const before = await runOne(['given today = @"2026-02-01"', ...lines, "expect accepted"], FORM_TESTS_CLOCK_FIXTURE);
    expect(before.status).toBe("passed");
    const after = await runOne(['given today = @"2026-03-01"', ...lines, "expect accepted"], FORM_TESTS_CLOCK_FIXTURE);
    expect(failures(after)).toEqual([{ line: 5, status: "failed", code: "expect.verdict", expected: "accepted", actual: "refused" }]);
    const unset = await runOne(lines, FORM_TESTS_CLOCK_FIXTURE);
    expect(unset).toEqual({ name: "one", status: "error", reason: "scenario.clockUnset", steps: [] });
  });
});

describe("the snapshot reads what the runtime holds", () => {
  it.each([
    ["a page off the path", ["expect details on path"], "expect.onPath"],
    ["the default layout", ["given journey = none", "expect layout = pets"], "expect.layout"],
    ["no rows yet", ["given journey = none", "expect rows of items = 1"], "expect.rows"],
    ["a retained hidden answer", ["given journey = none", 'set applicant_name = "Ada"', "set age = 30", 'set pet_name = "Rex"', "submit", "expect pet_name withheld"], "expect.withheld"],
    [
      "a withheld hidden answer",
      ["given journey = none", 'set applicant_name = "Ada"', "set age = 30", 'set contact_method = "phone"', 'set phone = "555"', 'set contact_method = ""', "submit", 'expect submitted phone = "555"'],
      "expect.submitted"
    ],
    ["a verdict before any check", ["given journey = none", 'set applicant_name = "Ada"', "expect accepted"], "expect.noVerdict"],
    ["a check's verdict, which stands until the next check", ["given journey = none", "check", 'set applicant_name = "Ada"', "set age = 30", "expect accepted"], "expect.verdict"],
    ["an envelope after a check alone", ["given journey = none", 'set applicant_name = "Ada"', "set age = 30", "check", 'expect submitted applicant_name = "Ada"'], "expect.notSubmitted"],
    ["a calculation", ["set age = 20", "expect age_next_year = 20"], "expect.value"],
    ["a formula", ["set age = 20", "expect age_next_year = age"], "expect.formula"]
  ])("%s: the opposite expectation fails", async (_name, lines, code) => {
    const result = await runOne(lines);
    expect(result.status).toBe("failed");
    expect(failures(result).map((step) => step.code)).toEqual([code]);
  });

  it("required follows the hidden-required policy, rows are counted by collection path, unreplayable lists the server-only field", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    await driver.addRow("items", { qty: 3 });
    const snapshot = await driver.snapshot();
    expect(snapshot.required.applicant_name).toBe(true);
    expect(snapshot.required.email).toBe(false);
    expect(snapshot.rows).toEqual({ items: 1 });
    expect(snapshot.byPath["items[0].qty"]).toBe(3);
    expect(snapshot.unreplayable).toEqual({ ref_number: "unreplayable.server" });
    expect(snapshot.layout).toBe("standard");
    expect(snapshot.page).toBeUndefined();
    expect(Object.getPrototypeOf(snapshot.effective)).toBeNull();
  });

  it("a checkbox group's list is stored as the group stores it, one boolean per option", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    await driver.set("topics", ["news", "events"]);
    const snapshot = await driver.snapshot();
    expect(snapshot.byPath.topics).toEqual({ news: true, offers: false, events: true });
    expect(snapshot.values.topics).toEqual({ news: true, offers: false, events: true });
  });

  it("componentIdOf and typeOf answer as the runtime does, rows included", () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    expect(driver.componentIdOf("items[0].qty")).toBe("qty");
    expect(driver.componentIdOf("items")).toBe("items");
    expect(driver.componentIdOf("applicant_name")).toBe("applicant_name");
    expect(driver.componentIdOf("nowhere")).toBeUndefined();
    expect(driver.componentIdOf("constructor")).toBeUndefined();
    expect(driver.typeOf?.("topics")).toBe("checkboxes");
  });

  it("an accepted submit lists the envelope's values, entries at their paths and no list beside them", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    await driver.set("applicant_name", "Ada");
    await driver.set("age", 30);
    await driver.addRow("items", { qty: 2 });
    await driver.submit();
    const snapshot = await driver.snapshot();
    expect(snapshot.verdict).toBe("accepted");
    expect(snapshot.submitted?.applicant_name).toBe("Ada");
    // One rule on both sides (the kernel's record has no list key): the entries at their paths.
    expect(snapshot.submitted?.items).toBeUndefined();
    expect(snapshot.submitted?.["items[0].qty"]).toBe(2);
    expect(snapshot.withheld).toEqual([]);
  });
});

describe("the browser driver: start errors and coded refusals (j3)", () => {
  const brokenForm = {
    ...FORM_TESTS_FIXTURE,
    root: {
      ...FORM_TESTS_FIXTURE.root,
      children: {
        content: [
          ...(FORM_TESTS_FIXTURE.root.children?.content ?? []),
          { id: "broken_calc", type: "number", configuration: { label: "Broken" }, rules: { value: "nosuch(age)" } }
        ]
      }
    }
  } as unknown as FormDefinition;

  it("a definition whose formulas do not compile ends the start as scenario.formulaInvalid, with code and where", async () => {
    const driver = createFormTestRuntimeDriver(brokenForm, { makeRuntime });
    const started = await driver.start([]);
    expect(started).toMatchObject({ error: "scenario.formulaInvalid" });
    const problems = (started as unknown as { params: { problems: Array<{ code: string; where: string }> } }).params.problems;
    expect(problems[0]).toEqual({ code: expect.any(String), where: "rules:broken_calc:value" });
    expect(Object.keys(problems[0]!).sort()).toEqual(["code", "where"]);
  });

  it("an error the factory throws that is no FormulaError still propagates", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, {
      makeRuntime: () => {
        throw new Error("factory broke");
      }
    });
    await expect(Promise.resolve().then(() => driver.start([]))).rejects.toThrow("factory broke");
  });

  it("the first bad given in source order is reported", async () => {
    const journeyFirst = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    expect(
      await journeyFirst.start([
        { kind: "given", key: "journey", value: "elsewhere", line: 2 },
        { kind: "given", key: "options", path: "applicant_name", values: ["a"], line: 3 }
      ])
    ).toEqual({ error: "scenario.unknownJourney", params: { journey: "elsewhere" } });
    const optionsFirst = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    expect(
      await optionsFirst.start([
        { kind: "given", key: "options", path: "applicant_name", values: ["a"], line: 2 },
        { kind: "given", key: "journey", value: "elsewhere", line: 3 }
      ])
    ).toEqual({ error: "scenario.badGiven", params: { given: "options", path: "applicant_name", reason: "noSource" } });
  });

  it("row actions the form refuses come back as refusals, and the form is left alone", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await driver.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    await driver.addRow("items", { qty: 1 });
    expect(await driver.removeRow("items", 4)).toEqual({ refused: "rowOutOfRange", params: { path: "items", index: 4, count: 1 } });
    expect(await driver.addRow("applicant_name")).toEqual({ refused: "unknownCollection", params: { path: "applicant_name" } });
    expect(await driver.removeRow("nowhere", 0)).toEqual({ refused: "unknownCollection", params: { path: "nowhere" } });
    expect((await driver.snapshot()).rows.items).toBe(1);
    expect(await driver.removeRow("items", 0)).toBeUndefined();
    expect((await driver.snapshot()).rows.items).toBe(0);
  });

  it("the snapshot lists every page of the journey it runs, and none without one", async () => {
    const driver = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await driver.start([]);
    // In the journey's declared order, an exit page among them (not only those on the path).
    expect((await driver.snapshot()).pages).toEqual(["intro", "contact", "details", "review", "stop"]);
    const flat = createFormTestRuntimeDriver(FORM_TESTS_FIXTURE, { makeRuntime });
    await flat.start([{ kind: "given", key: "journey", value: "none", line: 2 }]);
    expect((await flat.snapshot()).pages).toEqual([]);
  });
});
