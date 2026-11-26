import { describe, expect, it } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import {
  applicableRuleDescriptors,
  buildRuleEditorState,
  composeRuleSource,
  isExpression,
  isRuleSourceShape,
  parseConditionValue,
  parseExpressionJson,
  RULE_DESCRIPTORS,
  ruleEditorText,
  ruleRunControl,
  withRule
} from "../form-engine/builder/property-editor/rules-model.js";

describe("values as typed", () => {
  it("types a value box's text the way the evaluator compares it", () => {
    expect(parseConditionValue("true")).toBe(true);
    expect(parseConditionValue("false")).toBe(false);
    expect(parseConditionValue("null")).toBeNull();
    expect(parseConditionValue("42")).toBe(42);
    expect(parseConditionValue(" 42 ")).toBe(42);
    expect(parseConditionValue("QC")).toBe("QC");
    expect(parseConditionValue("")).toBe("");
  });
});

describe("a data grid's row-bound formulas", () => {
  it("offers Minimum rows formula and Maximum rows formula on a dataGrid alone, as values", () => {
    const grid = applicableRuleDescriptors("dataGrid", { offersRequired: false });
    expect(grid.slice(-2).map((descriptor) => descriptor.key)).toEqual(["minRows", "maxRows"]);
    expect(grid.slice(-2).map((descriptor) => descriptor.label)).toEqual(["Minimum rows formula", "Maximum rows formula"]);
    expect(grid.slice(-2).every((descriptor) => descriptor.kind === "value")).toBe(true);
    expect(grid.slice(-2)[0]!.description).toContain("never row.");
    expect(grid.some((descriptor) => descriptor.key === "requiredWhen")).toBe(false);
    for (const type of ["text", "panel", "form", "repeatingSection"]) {
      expect(applicableRuleDescriptors(type).some((descriptor) => descriptor.key === "minRows" || descriptor.key === "maxRows")).toBe(false);
    }
  });
});

describe("applicable rules", () => {
  it("offers a field every rule, and the form root only the gates that cascade", () => {
    expect(applicableRuleDescriptors("text")).toBe(RULE_DESCRIPTORS);
    // The root holds no value, has no options and is no wizard step: only visibility,
    // enablement and read-only state reach its descendants (core/state/effective-state.ts).
    expect(applicableRuleDescriptors("form").map((descriptor) => descriptor.key)).toEqual([
      "visibleWhen",
      "enabledWhen",
      "readonlyWhen"
    ]);
    // A rule authored under another key is the panel's to leave alone, not to drop.
    expect(withRule({ requiredWhen: { kind: "path", path: "a" } }, "visibleWhen", { kind: "path", path: "b" })).toEqual({
      requiredWhen: { kind: "path", path: "a" },
      visibleWhen: { kind: "path", path: "b" }
    });
  });

  it("leaves Required when out for a component that cannot be required, and offers everything else as before", () => {
    // A plugin's display component (a link, a notice), a group, a static block: the fold never
    // reads a `requiredWhen` there, so the tab does not promise a check that is not made.
    const withoutRequired = applicableRuleDescriptors("gcds-link", { offersRequired: false }).map((descriptor) => descriptor.key);
    expect(withoutRequired).toEqual(RULE_DESCRIPTORS.map((descriptor) => descriptor.key).filter((key) => key !== "requiredWhen"));
    expect(applicableRuleDescriptors("gcds-link", { offersRequired: true })).toBe(RULE_DESCRIPTORS);
    expect(applicableRuleDescriptors("gcds-link", {})).toBe(RULE_DESCRIPTORS);
    // The root's three gates are what they were, whatever the option says.
    expect(applicableRuleDescriptors("form", { offersRequired: false }).map((descriptor) => descriptor.key)).toEqual(["visibleWhen", "enabledWhen", "readonlyWhen"]);
  });

  it("leaves Calculated value and Default value out for a component that holds no data, alone or with Required when", () => {
    const keys = (options: Parameters<typeof applicableRuleDescriptors>[1]): string[] => applicableRuleDescriptors("html", options).map((descriptor) => descriptor.key);
    const all = RULE_DESCRIPTORS.map((descriptor) => descriptor.key);
    expect(keys({ holdsData: false })).toEqual(all.filter((key) => key !== "value" && key !== "defaultValue"));
    expect(keys({ holdsData: false, offersRequired: false })).toEqual(all.filter((key) => key !== "value" && key !== "defaultValue" && key !== "requiredWhen"));
    expect(keys({ holdsData: false, offersRequired: true })).toEqual(all.filter((key) => key !== "value" && key !== "defaultValue"));
    expect(applicableRuleDescriptors("text", { holdsData: true })).toBe(RULE_DESCRIPTORS);
    expect(applicableRuleDescriptors("form", { holdsData: false }).map((descriptor) => descriptor.key)).toEqual(["visibleWhen", "enabledWhen", "readonlyWhen"]);
  });

  it("lists Valid when after Required when only where the caller offers it, and never on the root", () => {
    const keys = (options: Parameters<typeof applicableRuleDescriptors>[1], type = "text"): string[] =>
      applicableRuleDescriptors(type, options).map((descriptor) => descriptor.key);
    const all = RULE_DESCRIPTORS.map((descriptor) => descriptor.key);
    // Not in the engine table the Logic list reads (it places validWhen itself), and off by default.
    expect(all).not.toContain("validWhen");
    expect(keys({})).toEqual(all);
    expect(keys({ offersValid: true })).toEqual(["visibleWhen", "requiredWhen", "validWhen", ...all.slice(2)]);
    // Without Required when, after the visibility rule.
    expect(keys({ offersValid: true, offersRequired: false })).toEqual(["visibleWhen", "validWhen", ...all.slice(2)]);
    expect(keys({ offersValid: true }, "form")).toEqual(["visibleWhen", "enabledWhen", "readonlyWhen"]);
    const valid = applicableRuleDescriptors("text", { offersValid: true }).find((descriptor) => descriptor.key === "validWhen")!;
    expect(valid.kind).toBe("condition");
    expect(valid.target).toBeUndefined();
    expect(ruleRunControl(valid)).toBe("choice");
    expect(valid.description).toContain("configuration.messages.rule");
  });
});

describe("expression JSON", () => {
  it("accepts a well-formed expression and clears on blank", () => {
    const parsed = parseExpressionJson('{"kind":"path","path":"a"}');
    expect(parsed).toEqual({ ok: true, expression: { kind: "path", path: "a" } });
    expect(parseExpressionJson("   ")).toEqual({ ok: true, expression: undefined });
  });

  it("reports a typo instead of storing something the evaluator will ignore", () => {
    // `{"kind":"pathh"}` evaluates to `undefined` at runtime with no complaint, which is the
    // worst possible outcome for a rule — a form that silently never shows a field.
    const parsed = parseExpressionJson('{"kind":"pathh","path":"a"}');
    expect(parsed.ok).toBe(false);
    expect(parseExpressionJson("{not json").ok).toBe(false);
  });

  it("validates nested operands, not just the outermost node", () => {
    expect(
      isExpression({
        kind: "logical",
        operator: "and",
        left: { kind: "path", path: "a" },
        right: { kind: "nope" }
      })
    ).toBe(false);
    expect(isExpression({ kind: "call", name: "sum", args: [{ kind: "literal", value: 1 }] })).toBe(
      true
    );
    expect(isExpression({ kind: "path", path: "" })).toBe(false);
  });
});

const CONTAINS: Expression = {
  kind: "call",
  name: "contains",
  args: [{ kind: "path", path: "tags" }, { kind: "literal", value: "x" }]
};

describe("rule editor state", () => {
  it("covers every rule the engine evaluates", () => {
    expect(RULE_DESCRIPTORS.map((entry) => entry.key)).toEqual([
      "visibleWhen",
      "requiredWhen",
      "enabledWhen",
      "readonlyWhen",
      "value",
      "defaultValue",
      "filter",
      "navigationGating"
    ]);
  });

  it("starts off with no rule, and as a formula over a stored string, read as written", () => {
    expect(buildRuleEditorState("visibleWhen", undefined)).toMatchObject({ mode: "off", text: "", run: "both", problem: undefined });
    const state = buildRuleEditorState("visibleWhen", 'province = "QC"  or  consent');
    expect(state.mode).toBe("formula");
    expect(state.text).toBe('province = "QC"  or  consent');
    expect(state.run).toBe("both");
  });

  it("reads the object form: its formula and where it runs", () => {
    expect(buildRuleEditorState("requiredWhen", { formula: "amount > 100", run: "server-secret" })).toMatchObject({
      mode: "formula",
      text: "amount > 100",
      run: "server-secret"
    });
    expect(buildRuleEditorState("value", { expression: { kind: "path", path: "a" }, run: "server" })).toMatchObject({ text: "a", run: "server" });
  });

  it("opens a legacy tree printed with ids, never labels, and a value rule's cases one per line", () => {
    expect(buildRuleEditorState("visibleWhen", { kind: "path", path: "a" }).text).toBe("a");
    expect(buildRuleEditorState("visibleWhen", CONTAINS).text).toBe('contains(tags, "x")');
    const cases: Expression = {
      kind: "if",
      cases: [{ when: { kind: "binary", operator: "eq", left: { kind: "path", path: "size" }, right: { kind: "literal", value: "L" } }, then: { kind: "literal", value: 250 } }],
      else: { kind: "literal", value: 120 }
    };
    expect(buildRuleEditorState("value", cases).text).toBe('if size = "L"\n  then 250\nelse 120');
    expect(ruleEditorText(cases, RULE_DESCRIPTORS[0]!)).toBe('if size = "L" then 250 else 120');
  });

  it("lays the panel's working copy over the draft: the mode chosen, the text typed, the problem said", () => {
    expect(buildRuleEditorState("visibleWhen", undefined, { mode: "formula" })).toMatchObject({ mode: "formula", text: "" });
    expect(buildRuleEditorState("visibleWhen", "a", { mode: "off" }).mode).toBe("off");
    expect(buildRuleEditorState("visibleWhen", "a", { text: "a +", problem: "Expected a value." })).toMatchObject({
      mode: "formula",
      text: "a +",
      problem: "Expected a value."
    });
  });

  it("gives a rule a Runs choice, the browser-only keys a fixed chip, and a mode's own rule none", () => {
    expect(ruleRunControl(RULE_DESCRIPTORS.find((entry) => entry.key === "visibleWhen")!)).toBe("choice");
    expect(ruleRunControl(RULE_DESCRIPTORS.find((entry) => entry.key === "value")!)).toBe("choice");
    for (const key of ["defaultValue", "filter", "navigationGating"]) {
      expect(ruleRunControl(RULE_DESCRIPTORS.find((entry) => entry.key === key)!)).toBe("browser");
    }
    expect(ruleRunControl({ key: "when", label: "When", description: "", kind: "condition", target: { propertyPath: "when" } })).toBe("none");
  });
});

describe("what the draft gets", () => {
  it("writes the text as a string, or the object form for a scope other than both, and nothing for a blank box", () => {
    expect(composeRuleSource(undefined, "a > 1", "both")).toBe("a > 1");
    expect(composeRuleSource(undefined, "a > 1", "server")).toEqual({ formula: "a > 1", run: "server" });
    expect(composeRuleSource("old", "   ", "both")).toBeUndefined();
    expect(composeRuleSource({ formula: "old", run: "server" }, "", "server")).toBeUndefined();
  });

  it("keeps a stored tree byte for byte while the text still prints it, and carries its scope", () => {
    expect(composeRuleSource(CONTAINS, 'contains(tags, "x")', "both")).toBe(CONTAINS);
    expect(composeRuleSource(CONTAINS, 'contains(tags, "x")', "server-secret")).toEqual({ expression: CONTAINS, run: "server-secret" });
    expect(composeRuleSource({ expression: CONTAINS, run: "server" }, 'contains(tags, "x")', "both")).toBe(CONTAINS);
    // Edited, it is a string from then on.
    expect(composeRuleSource(CONTAINS, 'contains(tags, "y")', "both")).toBe('contains(tags, "y")');
  });

  it("compares against what the form holds, never the draft: a tree typed into and typed back is the tree again", () => {
    // The first keystroke turned the draft into a string; the comparison is still against the stored tree.
    expect(composeRuleSource(CONTAINS, 'contains(tags, "y")', "both")).toBe('contains(tags, "y")');
    expect(composeRuleSource(CONTAINS, 'contains(tags, "x")', "both")).toBe(CONTAINS);
    // A run scope chosen over an untouched tree carries the tree; over a stored string, the string.
    expect(composeRuleSource(CONTAINS, 'contains(tags, "x")', "server")).toEqual({ expression: CONTAINS, run: "server" });
    expect(composeRuleSource('contains(tags, "x")', 'contains(tags, "x")', "server")).toEqual({ formula: 'contains(tags, "x")', run: "server" });
    // Text that does not parse is written as typed all the same: the draft equals the box.
    expect(composeRuleSource(CONTAINS, "contains(tags, +", "both")).toBe("contains(tags, +");
  });

  it("knows the three stored shapes, and refuses the rest", () => {
    expect(isRuleSourceShape("a > 1")).toBe(true);
    expect(isRuleSourceShape(CONTAINS)).toBe(true);
    expect(isRuleSourceShape({ formula: "a", run: "browser" })).toBe(true);
    expect(isRuleSourceShape({ expression: CONTAINS })).toBe(true);
    expect(isRuleSourceShape({ formula: "a", run: "sometimes" })).toBe(false);
    expect(isRuleSourceShape({ run: "server" })).toBe(false);
    expect(isRuleSourceShape({ expression: { kind: "pathh", path: "a" } })).toBe(false);
    expect(isRuleSourceShape(7)).toBe(false);
    expect(isRuleSourceShape([])).toBe(false);
    // A call to a plugin function is a tree when the name is known.
    expect(isRuleSourceShape({ kind: "call", name: "regionTax", args: [] })).toBe(false);
    expect(isRuleSourceShape({ kind: "call", name: "regionTax", args: [] }, ["regionTax"])).toBe(true);
  });
});

describe("a builder mode's own rule", () => {
  const when = {
    key: "when",
    label: "Take this route when",
    description: "Reads the answers on earlier pages.",
    kind: "condition" as const,
    target: { propertyPath: "when" }
  };

  it("builds its editor state from the descriptor itself, under its own key", () => {
    const state = buildRuleEditorState(when, { kind: "path", path: "contactMethod" });
    expect(state.key).toBe("when");
    expect(state.descriptor).toBe(when);
    expect(state.mode).toBe("formula");
    expect(state.text).toBe("contactMethod");
    expect(buildRuleEditorState(when, undefined).mode).toBe("off");
    expect(buildRuleEditorState(when, "contactMethod = \"mail\"").text).toBe('contactMethod = "mail"');
  });

  it("still refuses a key the engine does not evaluate when only the key is given", () => {
    expect(() => buildRuleEditorState("when", undefined)).toThrow(/Unknown rule: when/);
  });
});

describe("withRule", () => {
  it("writes one rule and leaves the others alone, strings and object forms alike", () => {
    const rules = withRule({ visibleWhen: { kind: "path", path: "a" } }, "requiredWhen", "b");
    expect(rules).toEqual({
      visibleWhen: { kind: "path", path: "a" },
      requiredWhen: "b"
    });
    expect(withRule(rules, "value", { formula: "a + 1", run: "server" })).toEqual({
      visibleWhen: { kind: "path", path: "a" },
      requiredWhen: "b",
      value: { formula: "a + 1", run: "server" }
    });
  });

  it("drops the key on no rule, and the whole object once nothing is left", () => {
    expect(withRule({ visibleWhen: { kind: "path", path: "a" } }, "visibleWhen", undefined)).toBeUndefined();
    expect(withRule(undefined, "visibleWhen", undefined)).toBeUndefined();
  });
});
