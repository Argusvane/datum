import { describe, expect, it } from "vitest";

import { COVERABLE_KINDS, coverageOf, coversRule, type CoveredScenario, type CoverageScenarioStatus } from "../../form-engine/builder/logic/coverage.js";
import { buildLogicModel } from "../../form-engine/builder/logic/logic-model.js";
import type { LogicRule } from "../../form-engine/builder/logic/logic-types.js";
import { kernelParseFormTests } from "../../form-engine/core/form-tests/form-test-parse.js";
import type { FormTestScenario } from "../../form-engine/core/form-tests/form-test-types.js";
import { formulaFunctionSignatures } from "../../form-engine/core/expressions/function-table.js";
import type { FormDefinition } from "../../form-engine/core/schema/types.js";

// Coverage of the form's tests, including the `reach` option.

// One rule of every coverable kind, plus a default, a filter and a gate that the report must
// leave out (the language has no expectation for them).
const LAYOUT_ROOT = { id: "document", type: "pdf-document", configuration: {}, children: { body: [], header: [], footer: [] } };

const FORM = {
  id: "coverage-form",
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
          rules: {
            requiredWhen: "flag = true",
            enabledWhen: "flag = true",
            readonlyWhen: "flag = true",
            validWhen: 'needed != "bad"',
            defaultValue: "start"
          }
        },
        { id: "total", type: "number", configuration: { label: "Total" }, rules: { value: "count + 1" } },
        { id: "count", type: "number", configuration: { label: "Count" } },
        { id: "region", type: "select", configuration: { label: "Region" }, rules: { filter: 'row.region != "north"' } },
        {
          id: "kids",
          type: "dataGrid",
          configuration: { label: "Kids" },
          collection: { collectionPath: "kids" },
          rules: { minRows: "1", maxRows: "3" },
          children: { content: [{ id: "kid_name", type: "text", configuration: { label: "Kid name" }, rules: { visibleWhen: "flag = true" } }] }
        },
        {
          id: "wizard",
          type: "steps",
          configuration: {},
          children: {
            content: [
              { id: "one", type: "step", configuration: { label: "One" }, children: { content: [] } },
              { id: "two", type: "step", configuration: { label: "Two" }, rules: { visibleWhen: "flag = true" }, children: { content: [] } },
              {
                id: "three",
                type: "step",
                configuration: { label: "Three" },
                rules: { visibleWhen: "not(flag = true)", navigationGating: "flag = true" },
                children: { content: [] }
              }
            ]
          }
        },
        // A stored segment that is not the id: the scenario names the data key.
        { id: "reference_id", type: "text", configuration: { label: "Reference", dataKey: "ref" }, rules: { visibleWhen: "flag = true" } }
      ]
    }
  },
  journey: {
    journeys: [
      {
        id: "main",
        pages: [
          { id: "start", components: ["flag"], routes: [{ when: "flag = true", to: "extra" }, { to: "finish" }] },
          { id: "extra", components: ["shown"] },
          { id: "finish", components: ["total"] }
        ]
      }
    ]
  },
  pdf: {
    layouts: [
      { id: "plain", kind: "generated", root: LAYOUT_ROOT },
      { id: "flagged", kind: "generated", when: "flag = true", root: LAYOUT_ROOT }
    ],
    defaultLayoutId: "plain"
  }
} as unknown as FormDefinition;

/** Every scenario hits exactly the rule its name says, by exactly the expectation the table names. */
const SOURCE = `
test "shows"
  expect shown visible
test "hides"
  expect hidden hidden
test "requires"
  expect needed required
test "enables"
  expect needed disabled
test "locks"
  expect needed readonly
test "validates"
  check
  expect error on needed: rule
test "calculates by value"
  expect total = 1
test "calculates by formula"
  expect total + 1 > 0
test "counts rows"
  expect rows of kids = 0
test "refuses too few rows"
  check
  expect error on kids: rows.min
test "refuses too many rows"
  check
  expect error on kids: rows.max
test "shows a step"
  expect two visible
test "hides a step"
  expect three hidden
test "reaches a page"
  expect page = extra
test "takes the route"
  expect path = (start, extra)
test "takes the unconditional route"
  expect path = (start, finish)
test "picks the layout"
  expect layout = flagged
test "reads a row field"
  expect kids[0].kid_name visible
test "reads a data key"
  expect ref visible
test "unrelated"
  expect count > 0
test "a start value"
  expect needed empty
`;

function scenariosOf(source: string): FormTestScenario[] {
  const parsed = kernelParseFormTests(source, formulaFunctionSignatures());
  expect(parsed.problems).toEqual([]);
  return parsed.scenarios;
}

const ALL = scenariosOf(SOURCE);

function covered(status: CoverageScenarioStatus = "passed", only?: readonly string[]): CoveredScenario[] {
  return ALL.filter((scenario) => only === undefined || only.includes(scenario.name)).map((scenario) => ({ scenario, status }));
}

function ruleOf(report: ReturnType<typeof coverageOf>, id: string) {
  const rule = report.rules.find((candidate) => candidate.id === id);
  if (rule === undefined) {
    throw new Error(`no rule ${id}: ${report.rules.map((candidate) => candidate.id).join(", ")}`);
  }
  return rule;
}

describe("coverageOf", () => {
  const report = coverageOf(FORM, covered());

  it("lists the Logic model's rules of the coverable kinds, in the model's order", () => {
    const model = buildLogicModel(FORM.root, { definition: FORM });
    const expected = model.rules.filter((rule) => COVERABLE_KINDS.includes(rule.kind)).map((rule) => rule.id);
    expect(report.rules.map((rule) => rule.id)).toEqual(expected);
    expect(report.rules.map((rule) => rule.kind)).toEqual(model.rules.filter((rule) => COVERABLE_KINDS.includes(rule.kind)).map((rule) => rule.kind));
  });

  it("covers every kind the table names, journeys and layouts included", () => {
    expect(new Set(report.rules.map((rule) => rule.kind))).toEqual(new Set(COVERABLE_KINDS));
  });

  it("leaves out default, filter and gate rules", () => {
    const ids = report.rules.map((rule) => rule.id);
    expect(ids).not.toContain("form:needed:defaultValue");
    expect(ids).not.toContain("form:region:filter");
    expect(ids).not.toContain("form:three:navigationGating");
    expect(buildLogicModel(FORM.root, { definition: FORM }).rules.map((rule) => rule.kind)).toEqual(expect.arrayContaining(["default", "filter", "gate"]));
  });

  it("names, per rule, the scenarios that reach it by the expectation the table names", () => {
    expect(ruleOf(report, "form:shown:visibleWhen").scenarios).toEqual(["shows"]);
    expect(ruleOf(report, "form:hidden:visibleWhen").scenarios).toEqual(["hides"]);
    expect(ruleOf(report, "form:needed:requiredWhen").scenarios).toEqual(["requires"]);
    expect(ruleOf(report, "form:needed:enabledWhen").scenarios).toEqual(["enables"]);
    expect(ruleOf(report, "form:needed:readonlyWhen").scenarios).toEqual(["locks"]);
    expect(ruleOf(report, "form:needed:validWhen").scenarios).toEqual(["validates"]);
    expect(ruleOf(report, "form:total:value").scenarios).toEqual(["calculates by value", "calculates by formula"]);
    expect(ruleOf(report, "form:kids:minRows").scenarios).toEqual(["counts rows", "refuses too few rows"]);
    expect(ruleOf(report, "form:kids:maxRows").scenarios).toEqual(["counts rows", "refuses too many rows"]);
    expect(ruleOf(report, "form:two:visibleWhen").scenarios).toEqual(["shows a step"]);
    expect(ruleOf(report, "form:three:visibleWhen").scenarios).toEqual(["hides a step"]);
    expect(ruleOf(report, "journeys:main:start:route:0").scenarios).toEqual(["takes the route"]);
    expect(ruleOf(report, "pdf:flagged:when").scenarios).toEqual(["picks the layout"]);
  });

  it("follows a field of a row and a data key to the component that owns the path", () => {
    expect(ruleOf(report, "form:kid_name:visibleWhen").scenarios).toEqual(["reads a row field"]);
    expect(ruleOf(report, "form:reference_id:visibleWhen").scenarios).toEqual(["reads a data key"]);
  });

  it("carries the model's target, formula and a flattened sentence", () => {
    const shown = ruleOf(report, "form:shown:visibleWhen");
    expect(shown).toMatchObject({ kind: "show", ruleKey: "visibleWhen", formula: "flag = true", target: { id: "shown", label: "Shown", type: "text" } });
    expect(typeof shown.sentence).toBe("string");
    expect(shown.sentence).toContain("Shown");
    expect(shown.sentence).toContain("Flag");
    expect(shown.sentence).not.toContain("[object");
  });

  it("counts tested and untested rules; every rule here is tested", () => {
    expect(report.untested).toBe(0);
    expect(report.tested).toBe(report.rules.length);
  });

  it("calls a rule no scenario reaches untested", () => {
    const partial = coverageOf(FORM, covered("passed", ["shows", "hides"]));
    expect(partial.tested).toBe(2);
    expect(partial.untested).toBe(partial.rules.length - 2);
    expect(ruleOf(partial, "form:needed:requiredWhen").scenarios).toEqual([]);
    expect(coverageOf(FORM, []).tested).toBe(0);
  });

  it("an unrelated expectation and an expectation about another field reach nothing", () => {
    const only = coverageOf(FORM, covered("passed", ["unrelated", "a start value"]));
    expect(only.tested).toBe(0);
  });

  it("counts a scenario that ran to failed or parity, never one that was skipped or errored", () => {
    const names = ["shows"];
    expect(ruleOf(coverageOf(FORM, covered("failed", names)), "form:shown:visibleWhen").scenarios).toEqual(["shows"]);
    expect(ruleOf(coverageOf(FORM, covered("parity", names)), "form:shown:visibleWhen").scenarios).toEqual(["shows"]);
    expect(ruleOf(coverageOf(FORM, covered("skipped", names)), "form:shown:visibleWhen").scenarios).toEqual([]);
    expect(ruleOf(coverageOf(FORM, covered("error", names)), "form:shown:visibleWhen").scenarios).toEqual([]);
    expect(coverageOf(FORM, covered("skipped")).tested).toBe(0);
  });

  it("lists scenarios in the order given", () => {
    const reversed = [...covered("passed", ["calculates by value", "calculates by formula"])].reverse();
    expect(ruleOf(coverageOf(FORM, reversed), "form:total:value").scenarios).toEqual(["calculates by formula", "calculates by value"]);
  });
});

describe("coverageOf reach", () => {
  it("defaults to the scenarios that ran, as the command line reads them", () => {
    expect(coverageOf(FORM, covered("skipped")).tested).toBe(0);
    expect(coverageOf(FORM, covered("skipped"), { reach: "ran" }).tested).toBe(0);
  });

  it("counts every parsed scenario whatever its status under written, so pins show before the first run", () => {
    for (const status of ["skipped", "error", "failed", "passed", "parity"] as const) {
      const report = coverageOf(FORM, covered(status), { reach: "written" });
      expect(report.untested, status).toBe(0);
      expect(report.rules.find((rule) => rule.id === "form:shown:visibleWhen")?.scenarios, status).toEqual(["shows"]);
    }
  });

  it("keeps the order and the other readings, only the status filter differs", () => {
    const ran = coverageOf(FORM, covered("passed"));
    const written = coverageOf(FORM, covered("passed"), { reach: "written" });
    expect(written).toEqual(ran);
  });
});

describe("coverageOf text", () => {
  it("words the sentences in the language and catalog given, as the Logic model does; the default stays English", () => {
    const text = { locale: "fr", catalog: { fr: { "rule.show.when": "Afficher {target} quand {condition}" } } };
    const french = coverageOf(FORM, covered("passed"), { text });
    const english = coverageOf(FORM, covered("passed"));
    const shown = (report: ReturnType<typeof coverageOf>): string => report.rules.find((rule) => rule.id === "form:shown:visibleWhen")!.sentence;
    expect(shown(french)).toMatch(/^Afficher Shown quand /);
    expect(shown(english)).toMatch(/^Show Shown when /);
    // Only the words change: the same rules, pins and counts.
    expect(french.rules.map((rule) => [rule.id, rule.scenarios])).toEqual(english.rules.map((rule) => [rule.id, rule.scenarios]));
    expect([french.tested, french.untested]).toEqual([english.tested, english.untested]);
  });
});

describe("coversRule, by kind", () => {
  const model = buildLogicModel(FORM.root, { definition: FORM });
  const rule = (id: string): LogicRule => {
    const found = model.rules.find((candidate) => candidate.id === id);
    if (found === undefined) {
      throw new Error(id);
    }
    return found;
  };
  const one = (lines: string): FormTestScenario => scenariosOf(`test "t"\n${lines.split("\n").map((line) => `  ${line}`).join("\n")}`)[0]!;

  it("reads the visible and hidden states for show, hide and step visibility, either way round", () => {
    expect(coversRule(rule("form:shown:visibleWhen"), one("expect shown hidden"))).toBe(true);
    expect(coversRule(rule("form:shown:visibleWhen"), one("expect shown required"))).toBe(false);
    expect(coversRule(rule("form:two:visibleWhen"), one("expect two hidden"))).toBe(true);
  });

  it("reads required|optional, enabled|disabled and editable|readonly on the target", () => {
    expect(coversRule(rule("form:needed:requiredWhen"), one("expect needed optional"))).toBe(true);
    expect(coversRule(rule("form:needed:requiredWhen"), one("expect shown optional"))).toBe(false);
    expect(coversRule(rule("form:needed:enabledWhen"), one("expect needed enabled"))).toBe(true);
    expect(coversRule(rule("form:needed:readonlyWhen"), one("expect needed editable"))).toBe(true);
    expect(coversRule(rule("form:needed:readonlyWhen"), one("expect needed enabled"))).toBe(false);
  });

  it("reads a rule error or a no-error probe for validate", () => {
    const validate = rule("form:needed:validWhen");
    expect(coversRule(validate, one("check\nexpect error on needed: rule"))).toBe(true);
    expect(coversRule(validate, one("check\nexpect error on needed: required"))).toBe(false);
    expect(coversRule(validate, one("check\nexpect error on needed"))).toBe(false);
    expect(coversRule(validate, one("check\nexpect no error on needed"))).toBe(true);
    expect(coversRule(validate, one("check\nexpect no errors"))).toBe(true);
    expect(coversRule(validate, one("check\nexpect no error on shown"))).toBe(false);
  });

  it("reads a value or a formula that names the target for calculate", () => {
    const calculate = rule("form:total:value");
    expect(coversRule(calculate, one("expect total = 3"))).toBe(true);
    expect(coversRule(calculate, one("expect count = 3"))).toBe(false);
    expect(coversRule(calculate, one("expect total + count > 1"))).toBe(true);
    expect(coversRule(calculate, one("expect count + 1 > 1"))).toBe(false);
  });

  it("reads only the row bound's own code, or a row count, for min-rows and max-rows", () => {
    expect(coversRule(rule("form:kids:minRows"), one("check\nexpect error on kids: rows.max"))).toBe(false);
    expect(coversRule(rule("form:kids:maxRows"), one("check\nexpect error on kids: rows.max"))).toBe(true);
    expect(coversRule(rule("form:kids:minRows"), one("check\nexpect error on kids: rows.min"))).toBe(true);
    // The rule key is not an error code the engine emits, so naming it reaches nothing.
    expect(coversRule(rule("form:kids:maxRows"), one("check\nexpect error on kids: maxRows"))).toBe(false);
    expect(coversRule(rule("form:kids:maxRows"), one("expect rows of kids = 2"))).toBe(true);
  });

  it("wants the route's source page immediately followed by its target", () => {
    const route = rule("journeys:main:start:route:0");
    expect(coversRule(route, one("expect path = (start, extra, finish)"))).toBe(true);
    expect(coversRule(route, one("expect path = (start, finish)"))).toBe(false);
    expect(coversRule(route, one("expect path = (extra, start)"))).toBe(false);
    expect(coversRule(route, one("expect path = (start, finish, extra)"))).toBe(false);
    expect(coversRule(route, one("expect page = extra"))).toBe(false);
  });

  // Two journeys can hold a page of one id with a route each.
  describe("journey rules by journey", () => {
    const TWO: FormDefinition = {
      ...FORM,
      journey: {
        journeys: [
          {
            id: "j1",
            pages: [
              { id: "p1", components: ["flag"], routes: [{ when: "flag = true", to: "p3" }, { when: "flag = false", to: "$end" }] },
              { id: "p2", components: ["shown"] },
              { id: "p3", components: ["total"] }
            ]
          },
          {
            id: "j2",
            pages: [
              { id: "p1", components: ["flag"], routes: [{ when: "flag = false", to: "p3" }] },
              { id: "p2", components: ["shown"] },
              { id: "p3", components: ["total"] }
            ]
          }
        ]
      }
    } as unknown as FormDefinition;
    const twoModel = buildLogicModel(TWO.root, { definition: TWO });
    const ruleIn = (id: string): LogicRule => twoModel.rules.find((candidate) => candidate.id === id) as LogicRule;
    const names = (source: string, rule: string, status: CoverageScenarioStatus = "passed"): string[] =>
      ruleOf(coverageOf(TWO, scenariosOf(source).map((scenario) => ({ scenario, status }))), rule).scenarios;

    it("credits a route rule only to a scenario that ran its journey", () => {
      expect(names('test "a"\n  given journey = j1\n  expect path = (p1, p3)', "journeys:j1:p1:route:0")).toEqual(["a"]);
      expect(names('test "a"\n  given journey = j1\n  expect path = (p1, p3)', "journeys:j2:p1:route:0")).toEqual([]);
      expect(names('test "b"\n  given journey = j2\n  expect path = (p1, p3)', "journeys:j2:p1:route:0")).toEqual(["b"]);
      expect(names('test "b"\n  given journey = j2\n  expect path = (p1, p3)', "journeys:j1:p1:route:0")).toEqual([]);
    });

    it("runs the definition's default journey when the scenario names none, and no journey for none", () => {
      expect(names('test "c"\n  expect path = (p1, p3)', "journeys:j1:p1:route:0")).toEqual(["c"]);
      expect(names('test "c"\n  expect path = (p1, p3)', "journeys:j2:p1:route:0")).toEqual([]);
      expect(names('test "d"\n  given journey = none\n  expect path = (p1, p3)', "journeys:j1:p1:route:0")).toEqual([]);
    });

    it("does not hold a caller with no default against a scenario that names no journey", () => {
      expect(coversRule(ruleIn("journeys:j2:p1:route:0"), one("expect path = (p1, p3)"))).toBe(true);
      expect(coversRule(ruleIn("journeys:j2:p1:route:0"), one("expect path = (p1, p3)"), undefined, "j1")).toBe(false);
    });

    // `$end` is never listed as a page, so the route is reached by the path
    // stopping at its page and then running off the end.
    it("covers a route to the end of the journey by a path that stops at its page and ends", () => {
      const end = "journeys:j1:p1:route:1";
      expect(names('test "e"\n  set flag = true\n  expect path = (p1)\n  expect path ends', end)).toEqual(["e"]);
      expect(names('test "e"\n  expect path = (p1)', end)).toEqual([]);
      expect(names('test "e"\n  expect path ends', end)).toEqual([]);
      expect(names('test "e"\n  expect path = (p1, p2)\n  expect path ends', end)).toEqual([]);
      expect(names('test "e"\n  expect path = (p1)\n  expect path ends at p2', end)).toEqual([]);
    });
  });

  it("reads the layout the answers choose for pdf-layout", () => {
    expect(coversRule(rule("pdf:flagged:when"), one("expect layout = flagged"))).toBe(true);
    expect(coversRule(rule("pdf:flagged:when"), one("expect layout = plain"))).toBe(false);
  });

  it("covers nothing of the kinds the language cannot reach", () => {
    const rules = ["form:needed:defaultValue", "form:region:filter", "form:three:navigationGating"];
    for (const id of rules) {
      expect(coversRule(rule(id), one("expect needed empty\nexpect region visible\nexpect three visible")), id).toBe(false);
    }
  });

  it("ignores actions: only an expectation reaches a rule", () => {
    expect(coversRule(rule("form:shown:visibleWhen"), one("set shown = \"x\""))).toBe(false);
  });
});
