import { describe, expect, it } from "vitest";

import { COVERABLE_KINDS } from "../../form-engine/builder/logic/coverage.js";
import { testsPinsOf } from "../../form-engine/builder/form-tests/tests-coverage.js";
import { buildLogicModel } from "../../form-engine/builder/logic/logic-model.js";
import type { LogicRule } from "../../form-engine/builder/logic/logic-types.js";
import { scaffoldableKinds, scaffoldTestsForRule } from "../../form-engine/builder/form-tests/tests-scaffold.js";
import { createTestsRunner } from "../../form-engine/builder/form-tests/tests-runner.js";
import type { TestsEntryModel } from "../../form-engine/builder/form-tests/tests-model.js";
import { createTestsNaming } from "../../form-engine/builder/form-tests/tests-words.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import type { FormTestScenarioResult } from "../../form-engine/core/form-tests/form-test-types.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";
import { FORM_TESTS_CLOCK_FIXTURE, FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

// Write a test: one Logic rule in, the scenarios that pin it out. The
// load-bearing promise is that every source written parses as exactly one scenario with no
// problems, so these tests walk every rule of three forms and parse each source, then run the
// scaffolds on the browser's runtime where the form lets them pass.

const SIGNATURES = formulaFunctionSignatures();
const LAYOUT_ROOT = { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } };

const OPTIONS = [{ value: "bronze" }, { value: "silver" }, { value: "gold" }];

/** A form with one rule of every scaffoldable kind and the condition shapes the solver reads. */
const SCAFFOLD_FORM = {
  id: "scaffold-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "flag", type: "checkbox", configuration: { label: "Flag" } },
        { id: "shown", type: "text", configuration: { label: "Shown" }, rules: { visibleWhen: "flag = true" } },
        { id: "hidden", type: "text", configuration: { label: "Hidden" }, rules: { visibleWhen: "not(flag = true)" } },
        {
          id: "needed",
          type: "text",
          configuration: { label: "Needed" },
          rules: { requiredWhen: "flag = true", enabledWhen: "flag = true", readonlyWhen: "flag = true", validWhen: 'needed != "bad"' }
        },
        { id: "count", type: "number", configuration: { label: "Count" } },
        { id: "total", type: "number", configuration: { label: "Total" }, rules: { value: "count + 1" } },
        { id: "constant", type: "number", configuration: { label: "Constant" }, rules: { value: "7" } },
        { id: "tier", type: "select", configuration: { label: "Tier", options: OPTIONS } },
        { id: "perk", type: "text", configuration: { label: "Perk" }, rules: { visibleWhen: 'tier in ("silver", "gold")' } },
        { id: "plain", type: "text", configuration: { label: "Plain" }, rules: { visibleWhen: 'tier != "bronze" and tier != "silver"' } },
        { id: "score", type: "number", configuration: { label: "Score" } },
        { id: "bonus", type: "text", configuration: { label: "Bonus" }, rules: { visibleWhen: "score between 3 and 5" } },
        { id: "big", type: "text", configuration: { label: "Big" }, rules: { visibleWhen: "score > 10" } },
        { id: "small", type: "text", configuration: { label: "Small" }, rules: { visibleWhen: "10 > score" } },
        { id: "both", type: "text", configuration: { label: "Both" }, rules: { visibleWhen: "flag = true and score >= 1" } },
        { id: "either", type: "text", configuration: { label: "Either" }, rules: { visibleWhen: "flag = true or score >= 1" } },
        { id: "odd", type: "text", configuration: { label: "Odd" }, rules: { visibleWhen: "len(count) > 2" } },
        { id: "admin_note", type: "text", configuration: { label: "Admin note" }, rules: { visibleWhen: 'host.role = "admin"' } },
        { id: "reference_id", type: "text", configuration: { label: "Reference", dataKey: "ref" }, rules: { visibleWhen: "flag = true" } },
        {
          id: "kids",
          type: "dataGrid",
          configuration: { label: "Kids" },
          collection: { collectionPath: "kids" },
          rules: { minRows: "1", maxRows: "3" },
          children: {
            content: [
              { id: "kid_age", type: "number", configuration: { label: "Kid age" } },
              { id: "kid_name", type: "text", configuration: { label: "Kid name" }, rules: { visibleWhen: "row.kid_age > 12" } }
            ]
          }
        },
        {
          id: "pets",
          type: "dataGrid",
          configuration: { label: "Pets" },
          collection: { collectionPath: "pets" },
          rules: { minRows: "count" },
          children: { content: [{ id: "pet_name", type: "text", configuration: { label: "Pet name" } }] }
        },
        {
          id: "wizard",
          type: "steps",
          configuration: {},
          children: {
            content: [
              { id: "one", type: "step", configuration: { label: "One" }, children: { content: [] } },
              { id: "two", type: "step", configuration: { label: "Two" }, rules: { visibleWhen: "flag = true" }, children: { content: [] } },
              { id: "three", type: "step", configuration: { label: "Three" }, rules: { visibleWhen: "not(flag = true)" }, children: { content: [] } }
            ]
          }
        }
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "main",
        validation: { continue: "page" },
        pages: [
          { id: "start", components: ["flag", "score"], routes: [{ when: "flag = true", to: "extra" }, { when: "score > 100", to: "$end" }] },
          { id: "extra", components: ["shown"] },
          { id: "finish", components: ["total"] }
        ]
      }
    ]
  },
  pdf: {
    layouts: [
      { id: "plain", kind: "generated", root: LAYOUT_ROOT },
      { id: "flagged", kind: "generated", when: "flag = true", name: "Flagged print", root: LAYOUT_ROOT }
    ],
    defaultLayoutId: "plain"
  }
} as unknown as FormDefinition;

/** A form that reads the clock in the three ways the scaffold solves: against `today()`, and `age()` it cannot. */
const DAY_FORM = {
  id: "day-form",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "event", type: "date", configuration: { label: "Event" } },
        { id: "soon", type: "text", configuration: { label: "Soon" }, rules: { visibleWhen: "event > today()" } },
        { id: "due", type: "text", configuration: { label: "Due" }, rules: { visibleWhen: "event <= today()" } },
        { id: "aged", type: "text", configuration: { label: "Aged" }, rules: { visibleWhen: "age(event) >= 18" } }
      ]
    }
  }
} as unknown as FormDefinition;

const FORMS: Array<[string, FormDefinition]> = [
  ["the scaffold form", SCAFFOLD_FORM],
  ["the day form", DAY_FORM],
  ["the main fixture", FORM_TESTS_FIXTURE],
  ["the clock fixture", FORM_TESTS_CLOCK_FIXTURE]
];

function ruleOf(form: FormDefinition, id: string): LogicRule {
  const rule = buildLogicModel(form.root, { definition: form }).rules.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`no rule ${id}`);
  }
  return rule;
}

function scaffold(form: FormDefinition, id: string) {
  return scaffoldTestsForRule(ruleOf(form, id), form.root, form, createTestsNaming(form.root, form), SIGNATURES);
}

function sources(form: FormDefinition, id: string): string[] {
  return scaffold(form, id).entries.map((entry) => entry.source);
}

/** Runs scaffolded entries on the browser's runtime, by position. */
async function run(form: FormDefinition, texts: readonly string[]): Promise<FormTestScenarioResult[]> {
  const entries = texts.map((source, at) => ({ id: `s${at}`, source }));
  const definition = { ...form, tests: { scenarios: entries } } as FormDefinition;
  const runner = createTestsRunner({ definition: () => definition, root: () => definition.root });
  const outcome = await runner.run(runner.parse(definition.tests));
  return entries.map((entry) => outcome.results.get(entry.id) as FormTestScenarioResult);
}

function allRules(form: FormDefinition): LogicRule[] {
  return buildLogicModel(form.root, { definition: form }).rules;
}

function asEntries(form: FormDefinition, texts: readonly string[]): TestsEntryModel[] {
  const runner = createTestsRunner({ definition: () => form, root: () => form.root });
  return runner.parse({ scenarios: texts.map((source, at) => ({ id: `e${at}`, source })) });
}

describe("scaffoldableKinds", () => {
  it("is the kinds coverage can see", () => {
    expect([...scaffoldableKinds]).toEqual([...COVERABLE_KINDS]);
  });

  it("writes nothing, and says so, for a kind the language has no statement for", () => {
    const form = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: { content: [{ id: "a", type: "text", configuration: { label: "A" }, rules: { defaultValue: "start", filter: 'row.a != "x"' } }, { id: "b", type: "text", configuration: {} }] }
      }
    } as unknown as FormDefinition;
    const kinds = allRules(form).map((rule) => rule.kind);
    expect(kinds).toContain("default");
    for (const rule of allRules(form)) {
      const scaffolded = scaffoldTestsForRule(rule, form.root, form, createTestsNaming(form.root, form), SIGNATURES);
      expect(scaffolded.entries, rule.id).toEqual([]);
      expect(scaffolded.note, rule.id).toBe("This rule has nothing a test can read yet; no test was written.");
    }
  });
});

describe.each(FORMS)("every rule of %s", (_label, form) => {
  const rules = allRules(form).filter((rule) => scaffoldableKinds.includes(rule.kind));

  it("has rules to scaffold", () => {
    expect(rules.length).toBeGreaterThan(0);
  });

  it("is written as sources that parse as exactly one scenario with no problems", () => {
    for (const rule of rules) {
      const scaffolded = scaffold(form, rule.id);
      expect(scaffolded.entries.length, rule.id).toBeGreaterThan(0);
      for (const entry of scaffolded.entries) {
        const parsed = kernelParseFormTests(entry.source, SIGNATURES);
        expect(parsed.problems, `${rule.id}\n${entry.source}`).toEqual([]);
        expect(parsed.scenarios, rule.id).toHaveLength(1);
        // The block's header names the scenario the panel will list.
        expect(parsed.scenarios[0]!.name, rule.id).toBe(entry.name);
      }
    }
  });

  it("names its scenarios on one line, each once", () => {
    for (const rule of rules) {
      const names = scaffold(form, rule.id).entries.map((entry) => entry.name);
      expect(new Set(names).size, rule.id).toBe(names.length);
      for (const name of names) {
        expect(name, rule.id).toMatch(/^[^\r\n]+$/);
        expect(name.length, rule.id).toBeLessThanOrEqual(112);
      }
    }
  });

  it("is pinned by the entries it writes: a scaffold covers its own rule", () => {
    for (const rule of rules) {
      const entries = asEntries(form, scaffold(form, rule.id).entries.map((entry) => entry.source));
      const pins = testsPinsOf(form.root, form, entries, SIGNATURES);
      expect(pins.get(rule.id)?.map((pin) => pin.id), rule.id).toBeDefined();
      expect(pins.get(rule.id)!.length, rule.id).toBeGreaterThan(0);
    }
  });
});

describe("the sources written for the fixture form", () => {
  it("sets the answer a comparison asks for, and the one that refuses it", () => {
    expect(sources(FORM_TESTS_FIXTURE, "form:phone:visibleWhen")).toEqual([
      'test "Phone is shown when How to reach you is Phone"\n  given journey = none\n  set contact_method = "phone"\n  expect phone visible',
      'test "Phone is hidden unless How to reach you is Phone"\n  given journey = none\n  set contact_method = "email"\n  expect phone hidden'
    ]);
  });

  it("gives a boolean its negation and writes the host's value as a given", () => {
    expect(sources(FORM_TESTS_FIXTURE, "form:pet_name:visibleWhen")[1]).toContain("set has_pet = false");
    expect(sources(FORM_TESTS_FIXTURE, "form:role_note:visibleWhen")).toEqual([
      'test "Admin note is shown when host.role is admin"\n  given journey = none\n  given host.role = "admin"\n  expect role_note visible',
      'test "Admin note is hidden unless host.role is admin"\n  given journey = none\n  given host.role = "x"\n  expect role_note hidden'
    ]);
  });

  it("checks a validation with a check and the rule error, or no error", () => {
    expect(sources(FORM_TESTS_FIXTURE, "form:ref_number:validWhen")).toEqual([
      'test "Reference is accepted when Reference is not BAD"\n  given journey = none\n  set ref_number = "x"\n  check\n  expect no error on ref_number',
      'test "Reference is refused unless Reference is not BAD"\n  given journey = none\n  set ref_number = "BAD"\n  check\n  expect error on ref_number: rule'
    ]);
  });

  it("writes a calculation once, giving the numbers it reads a value", () => {
    expect(sources(FORM_TESTS_FIXTURE, "form:age_next_year:value")).toEqual([
      'test "Age next year is calculated as age + 1"\n  given journey = none\n  set age = 2\n  expect age_next_year = age + 1'
    ]);
  });

  it("runs the journey a route rule belongs to and leaves `given journey = none` off", () => {
    expect(sources(FORM_TESTS_FIXTURE, "journeys:main:contact:route:1")).toEqual([
      'test "contact goes on to Items when not(Tell us more = true)"\n  given journey = main\n  set wants_details = false\n  go to contact\n  continue\n  expect page = review\n  expect path = (intro, contact, review)'
    ]);
    expect(sources(FORM_TESTS_FIXTURE, "journeys:main:contact:route:0")).toEqual([
      'test "contact goes on to Not eligible when Code is STOP"\n  given journey = main\n  set stop_code = "STOP"\n  go to contact\n  continue\n  expect page = stop\n  expect path = (intro, contact, stop)'
    ]);
  });

  it("expects the layout a PDF rule chooses", () => {
    expect(sources(FORM_TESTS_FIXTURE, "pdf:pets:when")).toEqual([
      'test "pets is printed when I have a pet is true"\n  given journey = none\n  set has_pet = true\n  expect layout = pets'
    ]);
  });

  it("names pages and layouts from the form's own words, when it has them", () => {
    const flagged = scaffold(SCAFFOLD_FORM, "pdf:flagged:when");
    expect(flagged.entries[0]!.name).toBe("Flagged print is printed when Flag is true");
  });
});

describe("solving a condition", () => {
  const set = (form: FormDefinition, id: string): string[][] =>
    sources(form, id).map((source) => source.split("\n").filter((line) => /^\s+(set|given|add|remove) /.test(line)).map((line) => line.trim()));

  it("picks a listed value for `in`, and an option outside the list for the other truth", () => {
    expect(set(SCAFFOLD_FORM, "form:perk:visibleWhen")).toEqual([["given journey = none", 'set tier = "silver"'].slice(1), ['set tier = "bronze"']].map((lines, at) => (at === 0 ? ['given journey = none', ...lines] : ['given journey = none', ...lines])));
  });

  it("keeps several comparisons of one field together (`not` of both, and `between`)", () => {
    expect(set(SCAFFOLD_FORM, "form:plain:visibleWhen")).toEqual([
      ["given journey = none", 'set tier = "gold"'],
      ["given journey = none", 'set tier = "bronze"']
    ]);
    expect(set(SCAFFOLD_FORM, "form:bonus:visibleWhen")).toEqual([
      ["given journey = none", "set score = 3"],
      ["given journey = none", "set score = 2"]
    ]);
  });

  it("steps one beside an exclusive bound, and reads a literal on the left", () => {
    expect(set(SCAFFOLD_FORM, "form:big:visibleWhen")).toEqual([
      ["given journey = none", "set score = 11"],
      ["given journey = none", "set score = 10"]
    ]);
    expect(set(SCAFFOLD_FORM, "form:small:visibleWhen")).toEqual([
      ["given journey = none", "set score = 9"],
      ["given journey = none", "set score = 10"]
    ]);
  });

  it("makes both sides of an `and` true, one side of it false; one side of an `or` true, both false", () => {
    expect(set(SCAFFOLD_FORM, "form:both:visibleWhen")).toEqual([
      ["given journey = none", "set flag = true", "set score = 1"],
      ["given journey = none", "set flag = false"]
    ]);
    expect(set(SCAFFOLD_FORM, "form:either:visibleWhen")).toEqual([
      ["given journey = none", "set flag = true"],
      ["given journey = none", "set flag = false", "set score = 0"]
    ]);
  });

  it("follows a data key to the stored path", () => {
    expect(sources(SCAFFOLD_FORM, "form:reference_id:visibleWhen")[0]).toContain("expect ref visible");
  });

  it("sets a sibling in the first row for a row-scoped condition, and does not add the row a grid opens with", () => {
    expect(sources(SCAFFOLD_FORM, "form:kid_name:visibleWhen")).toEqual([
      'test "Kid name is shown when row.kid_age is more than 12"\n  given journey = none\n  set kids[0].kid_age = 13\n  expect kids[0].kid_name visible',
      'test "Kid name is hidden unless row.kid_age is more than 12"\n  given journey = none\n  set kids[0].kid_age = 12\n  expect kids[0].kid_name hidden'
    ]);
  });

  it("adds the first row of a repeating section, which opens empty", () => {
    const form = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            {
              id: "items",
              type: "repeatingSection",
              configuration: { label: "Items" },
              collection: { itemFields: ["qty", "note"] },
              children: {
                content: [
                  { id: "qty", type: "number", configuration: { label: "Qty" } },
                  { id: "note", type: "text", configuration: { label: "Note" }, rules: { visibleWhen: "row.qty > 1" } }
                ]
              }
            }
          ]
        }
      }
    } as unknown as FormDefinition;
    expect(sources(form, "form:note:visibleWhen")[0]).toBe(
      'test "Note is shown when row.qty is more than 1"\n  add row to items\n  set items[0].qty = 2\n  expect items[0].note visible'
    );
  });

  it("fixes the day when a condition reads the clock, and solves a date against it", () => {
    expect(sources(DAY_FORM, "form:soon:visibleWhen")).toEqual([
      'test "Soon is shown when Event > today()"\n  given today = @"2026-01-01"\n  set event = @"2026-01-02"\n  expect soon visible',
      'test "Soon is hidden unless Event > today()"\n  given today = @"2026-01-01"\n  set event = @"2026-01-01"\n  expect soon hidden'
    ]);
    expect(sources(DAY_FORM, "form:due:visibleWhen")[1]).toContain('set event = @"2026-01-02"');
  });

  it("marks what it could not choose, with the empty text and the pick-a-value comment, and says so in the note", () => {
    const odd = scaffold(SCAFFOLD_FORM, "form:odd:visibleWhen");
    expect(odd.entries.map((entry) => entry.source)).toEqual([
      'test "Odd is shown when len(Count) > 2"\n  given journey = none\n  set count = ""  # pick a value that makes "len(count) > 2" true\n  expect odd visible',
      'test "Odd is hidden unless len(Count) > 2"\n  given journey = none\n  set count = ""  # pick a value that makes "len(count) > 2" false\n  expect odd hidden'
    ]);
    expect(odd.note).toBe("Some values could not be chosen from the rule; fill in the lines marked with a comment.");
    // A path compared with another path has no literal to choose.
    const confirm = scaffold(FORM_TESTS_FIXTURE, "form:confirm_email:validWhen");
    expect(confirm.entries[0]!.source).toContain('set confirm_email = ""  # pick a value that makes "confirm_email = email" true');
    expect(confirm.note).toBeDefined();
    // A condition the scaffold solved says nothing.
    expect(scaffold(SCAFFOLD_FORM, "form:perk:visibleWhen").note).toBeUndefined();
  });

  it("gives a clock-reading condition it cannot solve the day as well", () => {
    expect(sources(DAY_FORM, "form:aged:visibleWhen")[0]).toContain('given today = @"2026-01-01"');
  });
});

describe("row limits", () => {
  it("brings the count to the limit from the rows the grid opens with, and checks it", () => {
    expect(sources(SCAFFOLD_FORM, "form:kids:minRows")).toEqual([
      'test "Kids is accepted at the minimum of 1"\n  given journey = none\n  expect rows of kids = 1\n  check\n  expect no error on kids',
      'test "Kids is refused below the minimum of 1"\n  given journey = none\n  remove row 0 of kids\n  expect rows of kids = 0\n  check\n  expect error on kids: rows.min'
    ]);
  });

  it("writes only the case at a maximum, because the form refuses a row past it", () => {
    const max = scaffold(SCAFFOLD_FORM, "form:kids:maxRows");
    expect(max.entries.map((entry) => entry.source)).toEqual([
      'test "Kids is accepted at the maximum of 3"\n  given journey = none\n  add row to kids\n  add row to kids\n  expect rows of kids = 3\n  check\n  expect no error on kids'
    ]);
    expect(max.note).toBe("The form refuses a row past the maximum, so a test cannot reach the error; only the case at the limit is written.");
  });

  it("gives a limit that is one number answer a value, and the limit is that value", () => {
    expect(sources(SCAFFOLD_FORM, "form:pets:minRows")).toEqual([
      'test "Pets is accepted at the minimum of count"\n  given journey = none\n  set count = 1\n  expect rows of pets = 1\n  check\n  expect no error on pets',
      'test "Pets is refused below the minimum of count"\n  given journey = none\n  set count = 1\n  remove row 0 of pets\n  expect rows of pets = 0\n  check\n  expect error on pets: rows.min'
    ]);
  });
});

describe("the words", () => {
  it("follow a host's catalog for the names and the notes", () => {
    const rule = ruleOf(SCAFFOLD_FORM, "form:perk:visibleWhen");
    const scaffolded = scaffoldTestsForRule(rule, SCAFFOLD_FORM.root, SCAFFOLD_FORM, createTestsNaming(SCAFFOLD_FORM.root, SCAFFOLD_FORM), SIGNATURES, {
      locale: "fr",
      catalog: { fr: { "tests.scaffold.name.show.holds": "{target} est affiche quand {condition}" } }
    });
    expect(scaffolded.entries[0]!.name).toMatch(/^Perk est affiche quand /);
    // The other name has no French entry and falls back to English.
    expect(scaffolded.entries[1]!.name).toMatch(/^Perk is hidden unless /);
  });

  it("escapes a quote in a name so the header still parses", () => {
    const form = {
      id: "f",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "form",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "a", type: "text", configuration: { label: 'The "big" one' } },
            { id: "b", type: "text", configuration: { label: 'Say "hi"' }, rules: { visibleWhen: "a = \"x\"" } }
          ]
        }
      }
    } as unknown as FormDefinition;
    const entry = scaffold(form, "form:b:visibleWhen").entries[0]!;
    const parsed = kernelParseFormTests(entry.source, SIGNATURES);
    expect(parsed.problems).toEqual([]);
    expect(parsed.scenarios[0]!.name).toBe(entry.name);
    expect(entry.name).toContain('Say "hi"');
  });
});

// The scaffolds are run on the browser's runtime, so the promise is checked end to end: the
// ones a form lets pass do. What cannot yet is named, with the reason, so a fix elsewhere shows
// up here as a test to move.
describe("running the scaffolds", () => {
  const statuses = async (form: FormDefinition, id: string): Promise<string[]> => {
    const results = await run(form, sources(form, id));
    return results.map((result) => result.status);
  };

  it("passes for the rules whose cases a form can reach", async () => {
    const passing = [
      "form:shown:visibleWhen",
      "form:hidden:visibleWhen",
      "form:needed:requiredWhen",
      "form:needed:enabledWhen",
      "form:needed:readonlyWhen",
      "form:needed:validWhen",
      "form:total:value",
      "form:constant:value",
      "form:perk:visibleWhen",
      "form:plain:visibleWhen",
      "form:bonus:visibleWhen",
      "form:big:visibleWhen",
      "form:small:visibleWhen",
      "form:both:visibleWhen",
      "form:either:visibleWhen",
      "form:admin_note:visibleWhen",
      "form:reference_id:visibleWhen",
      "form:kids:minRows",
      "form:kids:maxRows",
      "form:pets:minRows",
      "journeys:main:start:route:0",
      "journeys:main:start:route:1",
      "pdf:flagged:when"
    ];
    for (const id of passing) {
      expect(await statuses(SCAFFOLD_FORM, id), id).toEqual(expect.arrayContaining(["passed"]));
      expect((await statuses(SCAFFOLD_FORM, id)).every((status) => status === "passed"), id).toBe(true);
    }
  });

  it("passes for the day-solved rules", async () => {
    for (const id of ["form:soon:visibleWhen", "form:due:visibleWhen"]) {
      expect(await statuses(DAY_FORM, id), id).toEqual(["passed", "passed"]);
    }
  });

  it("passes for the fixture rules a browser can judge, and skips the server's own", async () => {
    for (const id of [
      "form:age_next_year:value",
      "form:nickname:enabledWhen",
      "form:nickname:readonlyWhen",
      "form:email:requiredWhen",
      "form:phone:visibleWhen",
      "form:pet_name:visibleWhen",
      "form:role_note:visibleWhen",
      "pdf:pets:when"
    ]) {
      expect((await statuses(FORM_TESTS_FIXTURE, id)).every((status) => status === "passed"), id).toBe(true);
    }
    expect(await statuses(FORM_TESTS_FIXTURE, "form:ref_number:validWhen")).toEqual(["skipped", "skipped"]);
  });

  it("leaves the marked lines to the author: the unsolved case does not pass by itself", async () => {
    expect(await statuses(SCAFFOLD_FORM, "form:odd:visibleWhen")).toEqual(["failed", "passed"]);
  });

  it("reaches the route once the pages before it are answered", async () => {
    const [source] = sources(FORM_TESTS_FIXTURE, "journeys:main:contact:route:0");
    // The author's part: the answers the first page needs, then Continue, above the scaffold's own.
    const answered = source!.replace("  set stop_code", '  set applicant_name = "Ada"\n  set age = 30\n  continue\n  set stop_code').replace("  go to contact\n", "");
    expect((await run(FORM_TESTS_FIXTURE, [answered]))[0]!.status).toBe("passed");
  });

  it("reaches the other route of the same page, once the pages before it are answered", async () => {
    const [source] = sources(FORM_TESTS_FIXTURE, "journeys:main:contact:route:1");
    // As above: alone, `go to contact` is held at the first page's required name, so `expect page`
    // fails (the path, worked out from the answers, already holds).
    const alone = (await run(FORM_TESTS_FIXTURE, [source!]))[0]!;
    expect(alone.status).toBe("failed");
    expect(alone.steps.find((step) => step.status === "failed")).toMatchObject({ code: "expect.page", actual: "intro", expected: "review" });
    const answered = source!.replace("  set wants_details", '  set applicant_name = "Ada"\n  set age = 30\n  continue\n  set wants_details').replace("  go to contact\n", "");
    expect((await run(FORM_TESTS_FIXTURE, [answered]))[0]!.status).toBe("passed");
  });

  it("is known not to pass where the engine cannot say: a row's own state, and a step's", async () => {
    // Left open: the runtime driver reads one state for a row-scoped rule's
    // field whatever the row holds, and does not know step ids as fields. When either is fixed,
    // these go red: move the rules to the passing list above.
    expect(await statuses(SCAFFOLD_FORM, "form:kid_name:visibleWhen")).toEqual(["failed", "passed"]);
    expect(await statuses(SCAFFOLD_FORM, "form:two:visibleWhen")).toEqual(["failed", "failed"]);
    expect(await statuses(SCAFFOLD_FORM, "form:three:visibleWhen")).toEqual(["failed", "failed"]);
  });
});

describe("edge cases of the scaffold", () => {
  const FIX_FORM = {
    id: "fix-form",
    version: "1.0.0",
    schemaVersion: "1.0.0",
    root: {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "items",
            type: "dataGrid",
            configuration: { label: "Items" },
            collection: { collectionPath: "items" },
            children: {
              content: [
                { id: "qty", type: "number", configuration: { label: "Qty" } },
                { id: "line", type: "number", configuration: { label: "Line" }, rules: { value: "row.qty * 2" } }
              ]
            }
          },
          { id: "name", type: "text", configuration: { label: "Name" } },
          { id: "other", type: "text", configuration: { label: "Other" }, rules: { validWhen: 'name != "bad"' } },
          { id: "kind", type: "radio", configuration: { label: "Kind", options: [{ value: "1" }, { value: "2" }] } },
          { id: "extra", type: "text", configuration: { label: "Extra" }, rules: { visibleWhen: "kind = 2" } }
        ]
      }
    }
  } as unknown as FormDefinition;
  const statusesOf = async (id: string): Promise<string[]> => (await run(FIX_FORM, sources(FIX_FORM, id))).map((result) => result.status);

  it("checks a row's calculation at the row's path, against the value its answers give", async () => {
    expect(sources(FIX_FORM, "form:line:value")).toEqual(['test "Line is calculated as row.qty * 2"\n  set items[0].qty = 2\n  expect items[0].line = 4']);
    expect(await statusesOf("form:line:value")).toEqual(["passed"]);
  });

  it("answers the field a validation guards when its condition reads another one", async () => {
    const [accepted, refused] = sources(FIX_FORM, "form:other:validWhen");
    expect(accepted).toContain('  set other = "x"\n  check\n  expect no error on other');
    expect(refused).toContain('  set name = "bad"\n  set other = "x"\n  check\n  expect error on other: rule');
    expect(await statusesOf("form:other:validWhen")).toEqual(["passed", "passed"]);
  });

  it("takes another option of a choice for the case that does not hold, never a value beside the bound", async () => {
    const [, fails] = sources(FIX_FORM, "form:extra:visibleWhen");
    expect(fails).toContain('  set kind = "1"');
    expect(await statusesOf("form:extra:visibleWhen")).toEqual(["passed", "passed"]);
  });
});
