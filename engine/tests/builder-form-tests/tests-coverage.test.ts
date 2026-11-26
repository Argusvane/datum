import { describe, expect, it } from "vitest";

import { testsPinsOf, untestedRules } from "../../form-engine/builder/form-tests/tests-coverage.js";
import type { TestsEntryModel } from "../../form-engine/builder/form-tests/tests-model.js";
import { createTestsRunner } from "../../form-engine/builder/form-tests/tests-runner.js";
import { buildLogicModel } from "../../form-engine/builder/logic/logic-model.js";
import { COVERABLE_KINDS } from "../../form-engine/builder/logic/coverage.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { FORM_TESTS_FIXTURE, fixtureWithTests } from "../form-tests/fixtures/form-tests-fixture.js";

// Which tests pin which rules: the Untested list and the Logic
// editor's "Pinned by" line, over the parsed entries with the panel's reach (every parsed
// scenario counts, run or not).

const SIGNATURES = formulaFunctionSignatures();

function entriesOf(sources: ReadonlyArray<[string, string]>, form: FormDefinition = FORM_TESTS_FIXTURE): TestsEntryModel[] {
  const definition = { ...form, tests: { scenarios: sources.map(([id, source]) => ({ id, source })) } } as FormDefinition;
  const runner = createTestsRunner({ definition: () => definition, root: () => definition.root });
  return runner.parse(definition.tests);
}

const PHONE = "form:phone:visibleWhen";
const PET = "form:pet_name:visibleWhen";

describe("testsPinsOf", () => {
  it("is empty with no tests", () => {
    expect(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, [], SIGNATURES).size).toBe(0);
  });

  it("maps a rule to the entries whose expectations read what it decides, by id and name", () => {
    const entries = entriesOf([
      ["a", 'test "phone shows"\n  set contact_method = "phone"\n  expect phone visible'],
      ["b", 'test "pet shows"\n  expect pet_name visible'],
      ["c", 'test "both"\n  expect phone hidden\n  expect pet_name hidden']
    ]);
    const pins = testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES);
    expect(pins.get(PHONE)).toEqual([
      { id: "a", name: "phone shows" },
      { id: "c", name: "both" }
    ]);
    expect(pins.get(PET)).toEqual([
      { id: "b", name: "pet shows" },
      { id: "c", name: "both" }
    ]);
  });

  it("counts a scenario that has not run, and one that skips itself: a pin says what the author meant to check", () => {
    const entries = entriesOf([["a", 'test "later"\n  skip "not ready"\n  expect phone visible']]);
    expect(entries[0]!.status).toBe("unrun");
    expect(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES).get(PHONE)).toEqual([{ id: "a", name: "later" }]);
  });

  it("counts a failed or errored result as well; the status is not looked at", () => {
    const entries = entriesOf([["a", 'test "t"\n  expect phone visible']]).map((entry) => ({ ...entry, status: "error" as const }));
    expect(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES).get(PHONE)).toHaveLength(1);
  });

  it("gives an entry without a scenario no pins", () => {
    const entries = entriesOf([
      ["bad", 'test "broken"\n  set phone =\n  expect phone visible'],
      ["ok", 'test "fine"\n  expect phone visible']
    ]);
    expect(entries[0]!.scenario).toBeUndefined();
    expect(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES).get(PHONE)).toEqual([{ id: "ok", name: "fine" }]);
  });

  it("tells two entries of one name apart: the later is reported duplicateName and still pins", () => {
    const entries = entriesOf([
      ["a", 'test "same"\n  expect phone visible'],
      ["b", 'test "same"\n  expect phone hidden']
    ]);
    expect(entries[1]!.problems.map((problem) => problem.code)).toContain("duplicateName");
    expect(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES).get(PHONE)).toEqual([
      { id: "a", name: "same" },
      { id: "b", name: "same" }
    ]);
  });

  it("reads the rules of the root it is handed, which may be ahead of the definition's own copy", () => {
    const root = {
      ...FORM_TESTS_FIXTURE.root,
      children: {
        content: [
          ...(FORM_TESTS_FIXTURE.root.children?.["content"] ?? []),
          { id: "fresh", type: "text", configuration: { label: "Fresh" }, rules: { visibleWhen: "has_pet = true" } }
        ]
      }
    } as FormDefinition["root"];
    const entries = entriesOf([["a", 'test "fresh"\n  expect fresh visible']]);
    expect(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES).get("form:fresh:visibleWhen")).toBeUndefined();
    expect(testsPinsOf(root, FORM_TESTS_FIXTURE, entries, SIGNATURES).get("form:fresh:visibleWhen")).toEqual([{ id: "a", name: "fresh" }]);
  });

  it("pins the journey rules by the journey the scenario runs", () => {
    const entries = entriesOf([
      ["a", 'test "past the details"\n  given journey = main\n  expect path = (intro, contact, review)'],
      ["b", 'test "elsewhere"\n  given journey = none\n  expect path = (intro, contact, review)']
    ]);
    const pins = testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES);
    expect(pins.get("journeys:main:contact:route:1")?.map((pin) => pin.id)).toEqual(["a"]);
  });
});

describe("untestedRules", () => {
  const model = buildLogicModel(FORM_TESTS_FIXTURE.root, { definition: FORM_TESTS_FIXTURE });
  const coverable = model.rules.filter((rule) => COVERABLE_KINDS.includes(rule.kind));

  it("lists every coverable rule in the model's order, each as its Logic sentence, none of them tested without tests", () => {
    const view = untestedRules(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, [], SIGNATURES);
    expect(view.rules.map((rule) => rule.id)).toEqual(coverable.map((rule) => rule.id));
    expect(view.tested).toBe(0);
    expect(view.untested).toBe(coverable.length);
    expect(view.pins.size).toBe(0);
    const phone = view.rules.find((rule) => rule.id === PHONE)!;
    expect(phone.kind).toBe("show");
    expect(phone.sentence).toMatch(/^Show Phone when /);
    expect(phone.scenarios).toEqual([]);
  });

  it("leaves out the kinds the language cannot read (a start value, an option filter)", () => {
    const form = {
      ...FORM_TESTS_FIXTURE,
      root: { ...FORM_TESTS_FIXTURE.root, children: { content: [{ id: "q", type: "text", configuration: { label: "Q" }, rules: { defaultValue: "start" } }] } }
    } as FormDefinition;
    expect(buildLogicModel(form.root, { definition: form }).rules.some((rule) => rule.kind === "default")).toBe(true);
    expect(untestedRules(form.root, form, [], SIGNATURES).rules.some((rule) => rule.kind === "default")).toBe(false);
  });

  it("counts what the tests pin, and names them on the rule", () => {
    const entries = entriesOf([
      ["a", 'test "phone shows"\n  expect phone visible'],
      ["b", 'test "also phone"\n  expect phone hidden']
    ]);
    const view = untestedRules(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES);
    expect(view.tested).toBe(1);
    expect(view.untested).toBe(coverable.length - 1);
    expect(view.rules.find((rule) => rule.id === PHONE)!.scenarios).toEqual(["phone shows", "also phone"]);
    expect([...view.pins.keys()]).toEqual([PHONE]);
    expect(view.pins).toEqual(testsPinsOf(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES));
  });

  it("finds the fixture's own scenarios pinning some of its rules, and leaving others", () => {
    const entries = createTestsRunner({ definition: () => FORM_TESTS_FIXTURE, root: () => FORM_TESTS_FIXTURE.root }).parse(fixtureWithTests("main").tests);
    const view = untestedRules(FORM_TESTS_FIXTURE.root, FORM_TESTS_FIXTURE, entries, SIGNATURES);
    expect(view.tested).toBeGreaterThan(0);
    expect(view.tested + view.untested).toBe(view.rules.length);
    expect(view.rules.filter((rule) => rule.scenarios.length > 0)).toHaveLength(view.tested);
  });
});
