import { describe, expect, it } from "vitest";

import type { FormTestStepResult } from "../../form-engine/core/form-tests/form-test-types.js";
import type { ComponentNode } from "../../form-engine/core/schema/types.js";
import { componentIdOfPath, decidingRule, decidingRuleKind, decidingRuleOf } from "../../form-engine/builder/form-tests/tests-rules.js";
import { FORM_TESTS_FIXTURE } from "../form-tests/fixtures/form-tests-fixture.js";

// Open rule: which rule of a component decides an expectation, and
// whether the component has one to open.

const tree = {
  id: "form",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "x", type: "text", configuration: { label: "X" }, rules: { visibleWhen: "y = true" } },
      { id: "y", type: "checkbox", configuration: { label: "Y" } },
      { id: "z", type: "number", configuration: { label: "Z" }, rules: { value: "1 + 1", validWhen: null } },
      {
        id: "section",
        type: "fieldset",
        configuration: {},
        children: { content: [{ id: "nested", type: "text", configuration: {}, rules: { requiredWhen: "y = true" } }] }
      }
    ]
  }
} as unknown as ComponentNode;

describe("decidingRuleKind", () => {
  it("maps each state code to the rule that decides it", () => {
    expect(decidingRuleKind("expect.visible")).toBe("visibleWhen");
    expect(decidingRuleKind("expect.hidden")).toBe("visibleWhen");
    expect(decidingRuleKind("expect.required")).toBe("requiredWhen");
    expect(decidingRuleKind("expect.optional")).toBe("requiredWhen");
    expect(decidingRuleKind("expect.enabled")).toBe("enabledWhen");
    expect(decidingRuleKind("expect.disabled")).toBe("enabledWhen");
    expect(decidingRuleKind("expect.readonly")).toBe("readonlyWhen");
    expect(decidingRuleKind("expect.editable")).toBe("readonlyWhen");
    expect(decidingRuleKind("expect.value")).toBe("calculate");
    expect(decidingRuleKind("expect.formula")).toBe("calculate");
  });

  it("reads an error as a validWhen only when its code is rule", () => {
    expect(decidingRuleKind("expect.error", { code: "rule" })).toBe("validWhen");
    expect(decidingRuleKind("expect.noError", { code: "rule" })).toBe("validWhen");
    expect(decidingRuleKind("expect.error", { code: "required" })).toBeUndefined();
    expect(decidingRuleKind("expect.error", {})).toBeUndefined();
    expect(decidingRuleKind("expect.error")).toBeUndefined();
    expect(decidingRuleKind("expect.noError")).toBeUndefined();
  });

  it("has no rule for what no rule of a component decides", () => {
    for (const code of ["expect.page", "expect.path", "expect.verdict", "expect.rows", "expect.layout", "expect.submitted", "expect.withheld", "expect.message", "expect.empty", "action.failed", "unreplayable.host", ""]) {
      expect(decidingRuleKind(code), code).toBeUndefined();
    }
  });
});

describe("decidingRule", () => {
  it("is true when the component carries a rule of the kind", () => {
    expect(decidingRule(tree, "x", "visibleWhen")).toBe(true);
    expect(decidingRule(tree, "x", "requiredWhen")).toBe(false);
    expect(decidingRule(tree, "z", "calculate")).toBe(true);
    expect(decidingRule(tree, "nested", "requiredWhen")).toBe(true);
  });

  it("reads a rule that is null as no rule, and an unknown component as none", () => {
    expect(decidingRule(tree, "z", "validWhen")).toBe(false);
    expect(decidingRule(tree, "y", "visibleWhen")).toBe(false);
    expect(decidingRule(tree, "missing", "visibleWhen")).toBe(false);
  });

  it("agrees with the fixture's own rules", () => {
    const root = FORM_TESTS_FIXTURE.root;
    expect(decidingRule(root, "pet_name", "visibleWhen")).toBe(true);
    expect(decidingRule(root, "email", "requiredWhen")).toBe(true);
    expect(decidingRule(root, "nickname", "enabledWhen")).toBe(true);
    expect(decidingRule(root, "nickname", "readonlyWhen")).toBe(true);
    expect(decidingRule(root, "confirm_email", "validWhen")).toBe(true);
    expect(decidingRule(root, "age_next_year", "calculate")).toBe(true);
    expect(decidingRule(root, "applicant_name", "requiredWhen")).toBe(false);
  });
});

describe("decidingRuleOf: the component and kind a failed step opens", () => {
  const root = FORM_TESTS_FIXTURE.root;
  const step = (code: string, extra: Partial<FormTestStepResult> = {}): FormTestStepResult => ({ line: 2, status: "failed", code, ...extra });

  it("finds the component by the step's path", () => {
    expect(decidingRuleOf(root, step("expect.visible", { params: { path: "pet_name" } }))).toEqual({ componentId: "pet_name", kind: "visibleWhen" });
    expect(decidingRuleOf(root, step("expect.value", { params: { path: "age_next_year", op: "eq" } }))).toEqual({ componentId: "age_next_year", kind: "calculate" });
  });

  it("offers nothing where the component has no rule of that kind", () => {
    // Required by its setting, not by a rule.
    expect(decidingRuleOf(root, step("expect.required", { params: { path: "applicant_name" } }))).toBeUndefined();
    expect(decidingRuleOf(root, step("expect.visible", { params: { path: "nothing_here" } }))).toBeUndefined();
  });

  it("opens a validWhen for an error whose code is rule, from what was expected or what stands", () => {
    expect(decidingRuleOf(root, step("expect.error", { expected: "rule", actual: [], params: { path: "confirm_email" } }))).toEqual({ componentId: "confirm_email", kind: "validWhen" });
    expect(decidingRuleOf(root, step("expect.error", { expected: "required", actual: [], params: { path: "confirm_email" } }))).toBeUndefined();
    expect(decidingRuleOf(root, step("expect.noError", { expected: [], actual: [{ path: "confirm_email", code: "rule" }], params: { path: "confirm_email" } }))).toEqual({
      componentId: "confirm_email",
      kind: "validWhen"
    });
    expect(decidingRuleOf(root, step("expect.noError", { expected: [], actual: [{ path: "confirm_email", code: "rule" }] }))).toEqual({ componentId: "confirm_email", kind: "validWhen" });
    expect(decidingRuleOf(root, step("expect.noError", { expected: [], actual: [{ path: "email", code: "required" }] }))).toBeUndefined();
  });

  it("has none for a formula (it names no component) or a step with no code", () => {
    expect(decidingRuleOf(root, step("expect.formula", { params: { formula: "age > 1" } }))).toBeUndefined();
    expect(decidingRuleOf(root, { line: 2, status: "ran" })).toBeUndefined();
  });
});

describe("componentIdOfPath", () => {
  it("finds a field by value path, a row field with its index dropped, and a component by id", () => {
    expect(componentIdOfPath(FORM_TESTS_FIXTURE.root, "pet_name")).toBe("pet_name");
    expect(componentIdOfPath(FORM_TESTS_FIXTURE.root, "items")).toBe("items");
    expect(componentIdOfPath(FORM_TESTS_FIXTURE.root, "nothing_here")).toBeUndefined();
  });

  it("follows a data key to its component", () => {
    const keyed = {
      id: "form",
      type: "form",
      configuration: {},
      children: { content: [{ id: "first_name_field", type: "text", configuration: { dataKey: "firstName" }, rules: { visibleWhen: "true" } }] }
    } as unknown as ComponentNode;
    expect(componentIdOfPath(keyed, "firstName")).toBe("first_name_field");
    expect(decidingRuleOf(keyed, { line: 2, status: "failed", code: "expect.visible", params: { path: "firstName" } })).toEqual({ componentId: "first_name_field", kind: "visibleWhen" });
  });

  it("finds a row's field by the path a test names it by, with its row (`items[0].qty`)", () => {
    const rows = {
      id: "form",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "items",
            type: "repeatingSection",
            collection: {},
            children: {
              content: [
                { id: "qty", type: "number", configuration: {}, rules: { visibleWhen: "true" } },
                { id: "note_field", type: "text", configuration: { dataKey: "note" }, rules: { requiredWhen: "true" } }
              ]
            }
          }
        ]
      }
    } as unknown as ComponentNode;
    expect(componentIdOfPath(rows, "items[0].qty")).toBe("qty");
    expect(componentIdOfPath(rows, "items[12].note")).toBe("note_field");
    expect(componentIdOfPath(rows, "items[0].missing")).toBeUndefined();
    expect(decidingRuleOf(rows, { line: 2, status: "failed", code: "expect.visible", params: { path: "items[0].qty" } })).toEqual({ componentId: "qty", kind: "visibleWhen" });
    expect(decidingRuleOf(rows, { line: 2, status: "failed", code: "expect.required", params: { path: "items[1].note" } })).toEqual({ componentId: "note_field", kind: "requiredWhen" });
  });
});
