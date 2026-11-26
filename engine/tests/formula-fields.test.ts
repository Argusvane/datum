import { describe, expect, it } from "vitest";

import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { formulaFieldKind, formulaFieldsOf, isKnownFormulaPath, suggestFormulaField, type FormulaField } from "../form-engine/builder/formula/formula-fields.js";

const node = (id: string, type: string, configuration: Record<string, unknown> = {}, children?: ComponentNode[]): ComponentNode => ({
  id,
  type,
  configuration,
  ...(children ? { children: { default: children } } : {})
});

const root: ComponentNode = node("form", "form", { label: "Registration" }, [
  node("fullName", "text", { label: "Full name" }),
  node("age", "number", { label: "Age" }),
  node("fee", "currency", { title: "Fee" }),
  node("stars", "rating"),
  node("agree", "checkbox", { label: "I agree" }),
  node("remote", "toggle"),
  node("flag", "boolean"),
  node("province", "select", {
    label: "Province",
    options: [
      { value: "QC", label: "Quebec" },
      { value: "ON", label: "Ontario" }
    ]
  }),
  node("kind", "radio", { options: [{ value: "a", label: "A" }] }),
  node("interests", "checkboxes", { label: "Interests", options: [{ value: "x", label: "X" }] }),
  node("languages", "multiselect", { options: [{ value: "en", label: "English" }] }),
  node("start", "date", { label: "Start" }),
  node("photo", "file"),
  node("group", "fieldset", { label: "Address" }, [node("city", "text", { label: "City" }), node("submit", "button", { label: "Send" })]),
  { id: "items", type: "repeatingSection", configuration: { label: "Items" }, collection: { collectionPath: "items" }, children: { default: [node("sku", "text", { label: "SKU" })] } },
  node("note", "html", { html: "<p>Hi</p>" })
]);

/** The form's French: a label by the component's id, an option by its value. */
const FRENCH: FormTranslations = {
  fr: {
    components: {
      age: { label: { text: "Âge", source: sourceHash("Age") } },
      province: { options: { QC: { label: { text: "Québec", source: sourceHash("Quebec") } } } }
    }
  }
};

describe("formulaFieldsOf", () => {
  it("lists every data-holding component in document order with its kind", () => {
    const fields = formulaFieldsOf(root);
    expect(fields.map((field) => `${field.path}:${field.kind}`)).toEqual([
      "fullName:text",
      "age:number",
      "fee:number",
      "stars:number",
      "agree:boolean",
      "remote:boolean",
      "flag:boolean",
      "province:choice",
      "kind:choice",
      "interests:flags",
      "languages:list",
      "start:date",
      "photo:other",
      "city:text",
      "items:list",
      "sku:text"
    ]);
    expect(fields.every((field) => field.componentId === field.path)).toBe(true);
  });

  it("names a field by its label, title or id, resolved for the locale", () => {
    const labels = Object.fromEntries(formulaFieldsOf(root).map((field) => [field.path, field.label]));
    expect(labels.fullName).toBe("Full name");
    expect(labels.age).toBe("Age");
    expect(labels.fee).toBe("Fee");
    expect(labels.stars).toBe("stars");
    expect(formulaFieldsOf(root, { locale: "fr", translations: FRENCH }).find((field) => field.path === "age")?.label).toBe("Âge");
    // Without the form's translations the label is the string in the default language.
    expect(formulaFieldsOf(root, { locale: "fr" }).find((field) => field.path === "age")?.label).toBe("Age");
    expect(formulaFieldsOf(root, { labelOf: (id) => (id === "age" ? "Years" : undefined) }).find((field) => field.path === "age")?.label).toBe("Years");
  });

  it("carries a choice field's options with labels for the locale", () => {
    const province = formulaFieldsOf(root, { locale: "fr", translations: FRENCH }).find((field) => field.path === "province") as FormulaField;
    expect(province.options).toEqual([
      { value: "QC", label: "Québec" },
      { value: "ON", label: "Ontario" }
    ]);
    const fields = formulaFieldsOf(root);
    expect(fields.find((field) => field.path === "interests")?.options).toEqual([{ value: "x", label: "X" }]);
    expect(fields.find((field) => field.path === "languages")?.options).toEqual([{ value: "en", label: "English" }]);
    expect(fields.find((field) => field.path === "fullName")?.options).toEqual([]);
  });

  it("leaves out excluded ids and takes the host's data path", () => {
    const fields = formulaFieldsOf(root, { exclude: ["age"], dataPathOf: (id) => (id === "sku" ? "items[].sku" : undefined) });
    expect(fields.some((field) => field.path === "age")).toBe(false);
    const sku = fields.find((field) => field.componentId === "sku") as FormulaField;
    expect(sku.path).toBe("items[].sku");
  });

  it("maps types to kinds, other for the rest", () => {
    expect(formulaFieldKind("checkboxes")).toBe("flags");
    expect(formulaFieldKind("multiselect")).toBe("list");
    expect(formulaFieldKind("textarea")).toBe("text");
    expect(formulaFieldKind("email")).toBe("text");
    expect(formulaFieldKind("signature")).toBe("other");
  });
});

describe("isKnownFormulaPath", () => {
  const fields = formulaFieldsOf(root);
  it("knows a field by id and a value under it", () => {
    expect(isKnownFormulaPath("fullName", fields)).toBe(true);
    expect(isKnownFormulaPath("province.label", fields)).toBe(true);
    expect(isKnownFormulaPath("provnce", fields)).toBe(false);
    expect(isKnownFormulaPath("fullNam", fields)).toBe(false);
  });
});

describe("suggestFormulaField", () => {
  const fields = formulaFieldsOf(root);
  it("finds the nearest id or label", () => {
    expect(suggestFormulaField("provnce", fields)?.path).toBe("province");
    expect(suggestFormulaField("Full nme", fields)?.path).toBe("fullName");
    expect(suggestFormulaField("FULLNAME", fields)?.path).toBe("fullName");
  });

  it("suggests nothing for a name far from every field", () => {
    expect(suggestFormulaField("zebra", fields)).toBeUndefined();
    expect(suggestFormulaField("", fields)).toBeUndefined();
  });
});

describe("the field lookups at scale", () => {
  const many: FormulaField[] = Array.from({ length: 300 }, (_, index) => ({
    path: `field_number_${String(index)}`,
    label: `Field number ${String(index)}`,
    componentId: `field_number_${String(index)}`,
    kind: "text",
    options: []
  }));

  it("finds a path by exact id, by a dotted prefix and by component id", () => {
    expect(isKnownFormulaPath("field_number_299", many)).toBe(true);
    expect(isKnownFormulaPath("field_number_299.label", many)).toBe(true);
    expect(isKnownFormulaPath("field_number_300", many)).toBe(false);
    expect(isKnownFormulaPath("field_number_", many)).toBe(false);
    const aliased: FormulaField[] = [{ path: "data.key", label: "K", componentId: "keyed", kind: "text", options: [] }];
    expect(isKnownFormulaPath("keyed", aliased)).toBe(true);
    expect(isKnownFormulaPath("keyed.x", aliased)).toBe(true);
    expect(isKnownFormulaPath("data.key.x", aliased)).toBe(true);
    expect(isKnownFormulaPath("data", aliased)).toBe(false);
  });

  it("remembers a suggestion per name, and an absent one too", () => {
    expect(suggestFormulaField("field_numbr_7", many)?.path).toBe("field_number_7");
    expect(suggestFormulaField("field_numbr_7", many)?.path).toBe("field_number_7");
    expect(suggestFormulaField("zzzzzzzzzzzz", many)).toBeUndefined();
    expect(suggestFormulaField("zzzzzzzzzzzz", many)).toBeUndefined();
  });

  it("sees a replaced field list, not the old one", () => {
    const first: FormulaField[] = [{ path: "alpha", label: "Alpha", componentId: "alpha", kind: "text", options: [] }];
    expect(isKnownFormulaPath("beta", first)).toBe(false);
    const second: FormulaField[] = [...first, { path: "beta", label: "Beta", componentId: "beta", kind: "text", options: [] }];
    expect(isKnownFormulaPath("beta", second)).toBe(true);
  });
});
