import { describe, expect, it } from "vitest";

import {
  applyBlockers,
  buildInspectorModel,
  inspectorHints,
  inspectorWarnings
} from "../form-engine/builder/property-editor/inspector-model.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

function node(type: string, configuration: Record<string, unknown>, rules?: ComponentNode["rules"]): ComponentNode {
  return { id: "field", type, configuration, ...(rules ? { rules } : {}) };
}

const fr = { fr: { "inspector.block.pattern": "Expression régulière invalide." } };

describe("applyBlockers", () => {
  it("blocks a pattern that is not a regular expression, under the Pattern box", () => {
    const blockers = applyBlockers(node("text", { label: "Code", pattern: "(" }));
    expect(blockers).toHaveLength(1);
    expect(blockers[0]?.fieldId).toBe("pattern");
    expect(blockers[0]?.message).toMatch(/regular expression/);
  });

  it("lets a valid pattern, an empty one and none through", () => {
    expect(applyBlockers(node("text", { label: "Code", pattern: "[A-Z]{2}[0-9]{4}" }))).toEqual([]);
    expect(applyBlockers(node("text", { label: "Code", pattern: "" }))).toEqual([]);
    expect(applyBlockers(node("text", { label: "Code" }))).toEqual([]);
  });

  it("words the message from the builder's catalog (French)", () => {
    const [blocker] = applyBlockers(node("text", { pattern: "(" }), { locale: "fr", catalog: fr });
    expect(blocker?.message).toBe("Expression régulière invalide.");
  });

  it("blocks a minimum length above the maximum length, under the maximum", () => {
    const blockers = applyBlockers(node("text", { label: "Code", minLength: 10, maxLength: 5 }));
    expect(blockers.map((entry) => entry.fieldId)).toEqual(["maxLength"]);
  });

  it("blocks a Number's minimum above its maximum, under the maximum", () => {
    const blockers = applyBlockers(node("number", { label: "Age", min: 10, max: 5 }));
    expect(blockers.map((entry) => entry.fieldId)).toEqual(["max"]);
    expect(blockers[0]?.message).not.toBe("");
  });

  it("allows equal bounds on both pairs, and a single bound", () => {
    expect(applyBlockers(node("text", { minLength: 5, maxLength: 5 }))).toEqual([]);
    expect(applyBlockers(node("number", { min: 5, max: 5 }))).toEqual([]);
    expect(applyBlockers(node("number", { min: 5 }))).toEqual([]);
    expect(applyBlockers(node("number", { max: 5 }))).toEqual([]);
    expect(applyBlockers(node("text", { minLength: 5 }))).toEqual([]);
  });

  it("reads min and max as numbers only for a Number (a rating's max is its own)", () => {
    expect(applyBlockers(node("rating", { min: 10, max: 5 }))).toEqual([]);
  });

  it("reports every blocker at once", () => {
    const blockers = applyBlockers(node("text", { pattern: "(", minLength: 9, maxLength: 2 }));
    expect(blockers.map((entry) => entry.fieldId)).toEqual(["pattern", "maxLength"]);
  });
});

describe("inspectorWarnings", () => {
  it("warns of an empty label on the input types, under Label", () => {
    for (const type of ["text", "textarea", "number", "email", "select", "radio", "checkbox", "checkboxes", "date", "file"]) {
      const warnings = inspectorWarnings(node(type, { label: "" }));
      expect(warnings.map((entry) => entry.fieldId), type).toEqual(["label"]);
    }
    expect(inspectorWarnings(node("text", {}))).toHaveLength(1);
    expect(inspectorWarnings(node("text", { label: "   " }))).toHaveLength(1);
    // A label is a string in the default language: anything else says nothing.
    expect(inspectorWarnings(node("text", { label: { default: "Name", locales: { fr: "Nom" } } }))).toHaveLength(1);
  });

  it("does not warn where the component carries its own words, or the label is there", () => {
    for (const type of ["html", "button", "button-group", "container", "fieldset", "panel", "tabs", "steps", "step", "grid", "image", "form"]) {
      expect(inspectorWarnings(node(type, { label: "" })), type).toEqual([]);
    }
    expect(inspectorWarnings(node("text", { label: "Name" }))).toEqual([]);
  });

  it("asks for a label while the default Untitled field remains, and stops once renamed", () => {
    const untitled = inspectorWarnings(node("text", { label: "Untitled field" }));
    expect(untitled).toEqual([{ fieldId: "label", message: "Give this field a label" }]);
    expect(inspectorWarnings(node("text", { label: "Full name" }))).toEqual([]);
    // Any type that still carries the placeholder, not only the inputs.
    expect(inspectorWarnings(node("fieldset", { label: "Untitled field" }))).toHaveLength(1);
  });

  it("travels on the model, and is omitted when there is nothing to say", () => {
    expect(buildInspectorModel(node("text", { label: "" })).warnings).toHaveLength(1);
    expect(buildInspectorModel(node("text", { label: "Name" })).warnings).toBeUndefined();
    const french = buildInspectorModel(node("text", { label: "Untitled field" }), [], undefined, "en", {
      words: { locale: "fr", catalog: { fr: { "inspector.warn.untitled": "Donnez un libellé à ce champ" } } }
    });
    expect(french.warnings?.[0]?.message).toBe("Donnez un libellé à ce champ");
  });
});

describe("inspectorHints", () => {
  it("says a calculated field is read-only to the filler", () => {
    const calculated = node("number", { label: "Total" }, { value: "a + b" });
    expect(inspectorHints(calculated).map((entry) => entry.message)).toEqual(["Calculated by a rule - read-only to the filler"]);
    expect(buildInspectorModel(calculated).hints).toHaveLength(1);
  });

  it("is silent for a field with no calculation, other rules, or an empty formula", () => {
    expect(inspectorHints(node("number", { label: "Total" }))).toEqual([]);
    expect(inspectorHints(node("number", { label: "Total" }, { visibleWhen: "a > 1" }))).toEqual([]);
    expect(inspectorHints(node("number", { label: "Total" }, { value: "  " }))).toEqual([]);
    // A default is only a starting value: the filler may type over it.
    expect(inspectorHints(node("number", { label: "Total" }, { defaultValue: "1" }))).toEqual([]);
    expect(buildInspectorModel(node("number", { label: "Total" })).hints).toBeUndefined();
  });
});

describe("Number bounds fields", () => {
  const fieldsOf = (model: ReturnType<typeof buildInspectorModel>) => model.sections.flatMap((section) => section.fields);

  it("offers Minimum and Maximum under Validation for a Number, with the stored values", () => {
    const model = buildInspectorModel(node("number", { label: "Age", min: 18, max: 99 }));
    const validation = model.sections.find((section) => section.id === "validation");
    expect(validation?.fields.map((field) => field.propertyPath)).toEqual(["required", "min", "max"]);
    expect(validation?.fields.find((field) => field.propertyPath === "min")).toMatchObject({ control: "number", label: "Minimum", value: 18 });
    expect(validation?.fields.find((field) => field.propertyPath === "max")).toMatchObject({ control: "number", label: "Maximum", value: 99 });
  });

  it("leaves a box empty when the key is absent", () => {
    const fields = fieldsOf(buildInspectorModel(node("number", { label: "Age" })));
    expect(fields.find((field) => field.propertyPath === "min")?.value).toBeUndefined();
    expect(fields.find((field) => field.propertyPath === "max")?.value).toBeUndefined();
  });

  it("offers them for no other type", () => {
    for (const type of ["text", "textarea", "date", "select", "rating", "button"]) {
      const paths = fieldsOf(buildInspectorModel(node(type, { label: "x" }))).map((field) => field.propertyPath);
      expect(paths, type).not.toContain("min");
      expect(paths, type).not.toContain("max");
    }
  });
});
