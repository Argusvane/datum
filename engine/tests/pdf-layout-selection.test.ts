import { describe, expect, expectTypeOf, it, vi } from "vitest";

import type { Expression } from "../form-engine/core/expressions/expression.js";
import {
  PDF_DOCUMENT_COMPONENT_TYPE,
  findPdfLayout,
  pdfLayoutCandidates,
  readPdfConfiguration,
  readPdfLayoutCondition,
  selectPdfLayout,
  validatePdfLayout,
  type PdfConditionEvaluate,
  type PdfGeneratedLayout,
  type PdfTemplateLayout
} from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { evaluatePdfLayoutCondition, pdfLayoutConditionEvaluator, selectPdfLayoutForValues } from "../form-engine/render/pdf/pdf-layout-selection.js";
import { PDF_ABI_VERSION, PdfKernelError, type PdfKernelResponse } from "../form-engine/render/pdf/pdf-abi.js";
import { buildPdfRenderModel, compilePdfDefinition } from "../form-engine/render/pdf/pdf-render-model.js";

// A download that names no layout prints the first layout, in list order, whose
// `when` holds on the submittable answers by component id; else the declared default; else
// the first; else one derived from the form. An explicit id or layout wins over conditions.

const QUEBEC: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } };
const LARGE: Expression = { kind: "path", path: "largePrint" };
const ALWAYS: Expression = { kind: "literal", value: true };

function generated(id: string, when?: unknown): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    ...(when !== undefined ? { when: when as Expression } : {}),
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } }
  };
}

function template(id: string, when?: Expression): PdfTemplateLayout {
  return {
    id,
    kind: "template",
    ...(when !== undefined ? { when } : {}),
    template: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 10, ref: "/paper.pdf" },
    fields: []
  };
}

/** The injected evaluator the render layer passes: form scope, no host context. */
const evaluate: PdfConditionEvaluate = evaluatePdfLayoutCondition;

function answers(values: Record<string, unknown>): { values: () => Record<string, unknown>; evaluate: PdfConditionEvaluate } {
  return { values: () => values, evaluate };
}

describe("selectPdfLayout", () => {
  const definition = {
    pdf: { layouts: [generated("standard"), generated("quebec", QUEBEC), template("large", LARGE)], defaultLayoutId: "standard" }
  };

  it("chooses in one order: asked, condition, default, fallback, derived", () => {
    // An explicit id wins over a condition that holds.
    expect(selectPdfLayout(definition, { layoutId: "large", ...answers({ province: "QC" }) })).toMatchObject({ layout: { id: "large" }, choice: "asked", failed: [] });
    // Named by none, the first whose condition holds.
    expect(selectPdfLayout(definition, answers({ province: "QC" }))).toMatchObject({ layout: { id: "quebec" }, choice: "condition" });
    // None holds: the declared default.
    expect(selectPdfLayout(definition, answers({ province: "ON" }))).toMatchObject({ layout: { id: "standard" }, choice: "default" });
    // No default declared: the first layout.
    const undeclared = { pdf: { layouts: definition.pdf.layouts } };
    expect(selectPdfLayout(undeclared, answers({ province: "ON" }))).toMatchObject({ layout: { id: "standard" }, choice: "fallback" });
    // No usable layout: derive one.
    expect(selectPdfLayout({ pdf: { layouts: [] } }, answers({}))).toEqual({ layout: undefined, choice: "derived", failed: [] });
    expect(selectPdfLayout(undefined)).toEqual({ layout: undefined, choice: "derived", failed: [] });
  });

  it("tries the layouts in list order: the first whose condition holds wins", () => {
    const both = { pdf: { layouts: [generated("standard"), template("large", LARGE), generated("quebec", QUEBEC)], defaultLayoutId: "standard" } };
    expect(selectPdfLayout(both, answers({ province: "QC", largePrint: true })).layout?.id).toBe("large");
    const reordered = { pdf: { ...both.pdf, layouts: [generated("standard"), generated("quebec", QUEBEC), template("large", LARGE)] } };
    expect(selectPdfLayout(reordered, answers({ province: "QC", largePrint: true })).layout?.id).toBe("quebec");
  });

  it("tries the default's own condition in its place, and keeps it the default all the same", () => {
    const conditionalDefault = { pdf: { layouts: [generated("quebec", QUEBEC), generated("standard", ALWAYS), generated("other")], defaultLayoutId: "other" } };
    expect(selectPdfLayout({ pdf: { ...conditionalDefault.pdf, defaultLayoutId: "quebec" } }, answers({ province: "QC" }))).toMatchObject({ layout: { id: "quebec" }, choice: "condition" });
    // The default's condition does not hold: it still prints, as the default, when nothing else does.
    const lone = { pdf: { layouts: [generated("quebec", QUEBEC), generated("large", LARGE)], defaultLayoutId: "quebec" } };
    expect(selectPdfLayout(lone, answers({ province: "ON" }))).toMatchObject({ layout: { id: "quebec" }, choice: "default" });
  });

  it("falls back to the first layout when none is declared, even a conditional one", () => {
    const allConditional = { pdf: { layouts: [generated("quebec", QUEBEC), generated("standard")] } };
    expect(selectPdfLayout(allConditional, answers({ province: "ON" }))).toMatchObject({ layout: { id: "quebec" }, choice: "fallback" });
    // A default that names no layout the form has is no default.
    expect(selectPdfLayout({ pdf: { ...allConditional.pdf, defaultLayoutId: "gone" } }, answers({ province: "ON" }))).toMatchObject({ layout: { id: "quebec" }, choice: "fallback" });
  });

  it("derives a layout for an id the form lacks, or has but cannot render, without guessing", () => {
    expect(selectPdfLayout(definition, { layoutId: "missing", ...answers({ province: "QC" }) })).toEqual({ layout: undefined, choice: "derived", failed: [] });
    const unusable = { pdf: { layouts: [generated("standard"), { id: "broken", kind: "generated" }] } };
    expect(selectPdfLayout(unusable, { layoutId: "broken" })).toEqual({ layout: undefined, choice: "derived", failed: [] });
  });

  it("tries no condition without an evaluator or the answers: by id, else the default, else the first", () => {
    expect(selectPdfLayout(definition, { values: () => ({ province: "QC" }) }).layout?.id).toBe("standard");
    expect(selectPdfLayout(definition, { evaluate }).layout?.id).toBe("standard");
    expect(selectPdfLayout(definition).choice).toBe("default");
  });

  it("builds the answers only when a layout has a condition to try, and once", () => {
    const values = vi.fn(() => ({ province: "ON", largePrint: false }));
    selectPdfLayout({ pdf: { layouts: [generated("a"), generated("b")] } }, { values, evaluate });
    expect(values).not.toHaveBeenCalled();
    selectPdfLayout(definition, { values, evaluate });
    expect(values).toHaveBeenCalledTimes(1);
    selectPdfLayout(definition, { layoutId: "standard", values, evaluate });
    expect(values).toHaveBeenCalledTimes(1);
  });

  it("counts a condition that throws as not holding, and lists it", () => {
    const throwing: PdfConditionEvaluate = (expression, values) => {
      if (expression === QUEBEC) {
        throw new Error("boom");
      }
      return evaluate(expression, values);
    };
    const selection = selectPdfLayout(definition, { values: () => ({ province: "QC", largePrint: true }), evaluate: throwing });
    expect(selection).toMatchObject({ layout: { id: "large" }, choice: "condition" });
    expect(selection.failed).toEqual([{ layoutId: "quebec", reason: "threw", message: "boom" }]);
  });

  it("keeps a layout with a malformed when usable — by id, as the default, as the fallback — and its condition never holds", () => {
    // A string is a formula: "x" alone is a path, so the malformed one is unparseable.
    const malformed = generated("odd", "x +");
    const misspelt = generated("typo", { kind: "binary", operator: "equals", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } });
    expect(validatePdfLayout(malformed)).toEqual([]);
    expect(validatePdfLayout(misspelt)).toEqual([]);
    const pdf = { layouts: [malformed, misspelt, generated("standard")] };
    expect(readPdfConfiguration({ pdf }).map((layout) => layout.id)).toEqual(["odd", "typo", "standard"]);

    const chosen = selectPdfLayout({ pdf: { ...pdf, defaultLayoutId: "standard" } }, answers({ province: "QC" }));
    expect(chosen).toMatchObject({ layout: { id: "standard" }, choice: "default" });
    expect(chosen.failed).toEqual([
      { layoutId: "odd", reason: "invalid" },
      { layoutId: "typo", reason: "invalid" }
    ]);
    expect(selectPdfLayout({ pdf }, { layoutId: "odd", ...answers({}) })).toMatchObject({ layout: { id: "odd" }, choice: "asked" });
    expect(selectPdfLayout({ pdf: { ...pdf, defaultLayoutId: "typo" } }, answers({}))).toMatchObject({ layout: { id: "typo" }, choice: "default" });
    expect(selectPdfLayout({ pdf }, answers({}))).toMatchObject({ layout: { id: "odd" }, choice: "fallback" });
  });

  it("reads a layout's condition at its top level only", () => {
    expect(readPdfLayoutCondition(generated("a"))).toBeUndefined();
    expect(readPdfLayoutCondition(generated("a", null))).toBeUndefined();
    expect(readPdfLayoutCondition(generated("a", QUEBEC))).toEqual({ evaluable: true, expression: QUEBEC });
    expect(readPdfLayoutCondition(generated("a", "x +"))).toEqual({ evaluable: false, written: "x +" });
    // A string that parses is a condition: a formula over the answers.
    expect(readPdfLayoutCondition(generated("a", "x"))).toEqual({ evaluable: true, expression: { kind: "path", path: "x" } });
    expect(readPdfLayoutCondition(template("t", LARGE))).toEqual({ evaluable: true, expression: LARGE });
    // A `when` on the document root is not the layout's: the designer lifts one back to the top.
    const onRoot = { ...generated("a"), root: { ...generated("a").root, configuration: { when: ALWAYS } } };
    expect(readPdfLayoutCondition(onRoot)).toBeUndefined();
    expect(selectPdfLayout({ pdf: { layouts: [generated("first"), onRoot] } }, answers({})).layout?.id).toBe("first");
  });
});

describe("findPdfLayout stays condition-blind", () => {
  it("returns the named layout, else the default, else the first, whatever the conditions", () => {
    const listed = { pdf: { layouts: [generated("a"), generated("b"), template("t")], defaultLayoutId: "b" } };
    expect(findPdfLayout(listed, "t")?.id).toBe("t");
    expect(findPdfLayout(listed, "a")?.id).toBe("a");
    expect(findPdfLayout(listed, "missing")).toBeUndefined();
    expect(findPdfLayout(listed)?.id).toBe("b");
    expect(findPdfLayout({ pdf: { layouts: [generated("a")], defaultLayoutId: "zzz" } })?.id).toBe("a");
    expect(findPdfLayout({ pdf: { layouts: [generated("a")], defaultLayoutId: "" } })?.id).toBe("a");
    // Conditions are not its business: the first layout leads though its condition is false for any answers.
    const conditioned = { pdf: { layouts: [generated("quebec", QUEBEC), generated("standard")] } };
    expect(findPdfLayout(conditioned)?.id).toBe("quebec");
    expect(findPdfLayout(conditioned, "standard")?.id).toBe("standard");
    expect(findPdfLayout({ pdf: { ...conditioned.pdf, defaultLayoutId: "standard" } })?.id).toBe("standard");
    expect(findPdfLayout({ pdf: { layouts: [generated("odd", "x"), generated("standard")] } })?.id).toBe("odd");
    for (const pdf of [undefined, {}, { layouts: "nope" }, { layouts: [] }]) {
      expect(findPdfLayout(pdf === undefined ? undefined : { pdf }), JSON.stringify(pdf)).toBeUndefined();
    }
    expect(findPdfLayout(undefined, "a")).toBeUndefined();
  });
});

describe("pdfLayoutCandidates", () => {
  it("lists what a download naming no layout can print: the conditional layouts in order, then the fallback, each once", () => {
    const pdf = { layouts: [generated("standard"), generated("quebec", QUEBEC), template("large", LARGE), generated("odd", "x +"), generated("spare")], defaultLayoutId: "standard" };
    expect(pdfLayoutCandidates({ pdf }).map((layout) => layout.id)).toEqual(["quebec", "large", "standard"]);
    // The fallback that is conditional itself is listed once, in its place.
    expect(pdfLayoutCandidates({ pdf: { layouts: pdf.layouts } }).map((layout) => layout.id)).toEqual(["quebec", "large", "standard"]);
    expect(pdfLayoutCandidates({ pdf: { layouts: [generated("quebec", QUEBEC), generated("standard")] } }).map((layout) => layout.id)).toEqual(["quebec"]);
    expect(pdfLayoutCandidates({ pdf: { layouts: [generated("a"), generated("b")], defaultLayoutId: "b" } }).map((layout) => layout.id)).toEqual(["b"]);
    expect(pdfLayoutCandidates(undefined)).toEqual([]);
  });
});

describe("selectPdfLayoutForValues", () => {
  // A field inside a data-scoping container: its answer is stored at `address.province`, and
  // a condition names it by id, as a journey's does.
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        {
          id: "address",
          type: "container",
          configuration: {},
          children: { content: [{ id: "province", type: "text", configuration: { label: "Province" } }] }
        },
        { id: "largePrint", type: "checkbox", configuration: { label: "Large print" } }
      ]
    }
  };
  const pdf = { layouts: [generated("standard"), generated("quebec", QUEBEC), template("large", LARGE)], defaultLayoutId: "standard" };

  it("re-keys the path-keyed submittable answers by component id, as the render model does", () => {
    expect(selectPdfLayoutForValues({ root, pdf }, { "address.province": "QC" })).toMatchObject({ layout: { id: "quebec" }, choice: "condition" });
    expect(selectPdfLayoutForValues({ root, pdf }, { "address.province": "ON", largePrint: true })).toMatchObject({ layout: { id: "large" }, choice: "condition" });
    expect(selectPdfLayoutForValues({ root, pdf }, {})).toMatchObject({ layout: { id: "standard" }, choice: "default" });
    expect(selectPdfLayoutForValues({ root, pdf }, { "address.province": "QC" }, { layoutId: "large" })).toMatchObject({ layout: { id: "large" }, choice: "asked" });
  });

  it("reads host., row. and ancestor. paths as unanswered: no host context reaches a condition", () => {
    const hostly: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "host.region" }, right: { kind: "literal", value: "QC" } };
    const unanswered: Expression = { kind: "unary", operator: "not", operand: { kind: "path", path: "row.province" } };
    const scoped = { layouts: [generated("host", hostly), generated("row", unanswered), generated("standard")], defaultLayoutId: "standard" };
    expect(selectPdfLayoutForValues({ root, pdf: scoped }, { "address.province": "QC", "host.region": "QC" })).toMatchObject({ layout: { id: "row" }, choice: "condition" });
    expect(evaluate(hostly, { host: { region: "QC" } })).toBe(false);
  });

  it("reads each answer as the envelope's JSON carries it, and only the keys the schema defines", () => {
    const answered: Expression = { kind: "binary", operator: "neq", left: { kind: "path", path: "largePrint" }, right: { kind: "literal", value: null } };
    const spring: Expression = { kind: "binary", operator: "eq", left: { kind: "path", path: "campaign" }, right: { kind: "literal", value: "spring" } };
    const reading = { layouts: [generated("standard"), generated("campaign", spring), generated("answered", answered)], defaultLayoutId: "standard" };
    // A calculation's NaN (or Infinity) is null on the wire, so it holds nowhere; an undefined entry is absent.
    for (const odd of [Number.NaN, Number.POSITIVE_INFINITY, null]) {
      expect(selectPdfLayoutForValues({ root, pdf: reading }, { largePrint: odd }).layout?.id, String(odd)).toBe("standard");
    }
    // An undefined entry reads as absent — which "does not equal null" counts as holding, here and on a server alike.
    expect(selectPdfLayoutForValues({ root, pdf: reading }, { largePrint: undefined }).layout?.id).toBe(selectPdfLayoutForValues({ root, pdf: reading }, {}).layout?.id);
    expect(selectPdfLayoutForValues({ root, pdf: reading }, { largePrint: 0 }).layout?.id).toBe("answered");
    // A key no component owns: a server's default `unknownFields` strips it, so it chooses nothing here either.
    expect(selectPdfLayoutForValues({ root, pdf: reading }, { campaign: "spring", largePrint: null }).layout?.id).toBe("standard");
    expect(selectPdfLayoutForValues({ root, pdf: reading }, { campaign: "spring", largePrint: true }).layout?.id).toBe("answered");
  });

  it("reads an unbound data grid's rows at its id, as the kernel and the browser do, so a condition on a row holds", () => {
    const bigOrder: Expression = { kind: "binary", operator: "gt", left: { kind: "path", path: "orders[0].qty" }, right: { kind: "literal", value: 5 } };
    const columns: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [{ id: "orders", type: "dataGrid", configuration: {}, children: { content: [{ id: "qty", type: "number", configuration: {} }] } }]
      }
    };
    const layouts = { layouts: [generated("standard"), generated("bulk", bigOrder)], defaultLayoutId: "standard" };
    // The kernel and the browser read `orders[0].qty` as the grid's row; so does the selection, flat or posted whole.
    expect(selectPdfLayoutForValues({ root: columns, pdf: layouts }, { "orders[0].qty": 10 }).layout?.id).toBe("bulk");
    expect(selectPdfLayoutForValues({ root: columns, pdf: layouts }, { orders: [{ qty: 10 }] }).layout?.id).toBe("bulk");
    expect(selectPdfLayoutForValues({ root: columns, pdf: layouts }, { "orders[0].qty": 2 }).layout?.id).toBe("standard");
  });
});

describe("formulas in a layout's when", () => {
  const root: ComponentNode = {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "province", type: "text", configuration: { label: "Province" } },
        { id: "signedOn", type: "date", configuration: { label: "Signed on" } }
      ]
    }
  };
  const TODAY_2026: Expression = {
    kind: "if",
    cases: [{ when: { kind: "binary", operator: "gte", left: { kind: "call", name: "today", args: [] }, right: { kind: "literal", value: "2026-01-01" } }, then: { kind: "literal", value: true } }]
  };

  it("reads a string when as a formula, and the object form too", () => {
    const pdf = { layouts: [generated("standard"), generated("quebec", 'province = "QC"'), generated("object", { formula: 'province = "ON"' })], defaultLayoutId: "standard" };
    expect(selectPdfLayoutForValues({ root, pdf }, { province: "QC" })).toMatchObject({ layout: { id: "quebec" }, choice: "condition", failed: [] });
    expect(selectPdfLayoutForValues({ root, pdf }, { province: "ON" })).toMatchObject({ layout: { id: "object" }, choice: "condition" });
    expect(selectPdfLayoutForValues({ root, pdf }, { province: "BC" })).toMatchObject({ layout: { id: "standard" }, choice: "default" });
    expect(readPdfLayoutCondition(generated("a", { expression: QUEBEC, run: "both" }))).toEqual({ evaluable: true, expression: QUEBEC });
  });

  it("chooses by an if over today() with the day given, and falls to the default without one", () => {
    const pdf = { layouts: [generated("standard"), generated("current", TODAY_2026)], defaultLayoutId: "standard" };
    expect(selectPdfLayoutForValues({ root, pdf }, {}, { today: "2026-06-01" })).toMatchObject({ layout: { id: "current" }, choice: "condition" });
    expect(selectPdfLayoutForValues({ root, pdf }, {}, { today: "2025-12-31" })).toMatchObject({ layout: { id: "standard" }, choice: "default" });
    // No day: the clock reads as no answer, no case matches, the if yields nothing, and the condition never holds.
    expect(selectPdfLayoutForValues({ root, pdf }, {})).toMatchObject({ layout: { id: "standard" }, choice: "default", failed: [] });
    // The same as a formula, and two valid days order by code unit.
    const written = { layouts: [generated("standard"), generated("recent", 'if signedOn >= "2026-01-01" and today() >= signedOn then true else false')], defaultLayoutId: "standard" };
    expect(selectPdfLayoutForValues({ root, pdf: written }, { signedOn: "2026-03-01" }, { today: "2026-06-01" }).layout?.id).toBe("recent");
    expect(selectPdfLayoutForValues({ root, pdf: written }, { signedOn: "2026-09-01" }, { today: "2026-06-01" }).layout?.id).toBe("standard");
    expect(pdfLayoutConditionEvaluator("2026-06-01")(TODAY_2026, {})).toBe(true);
    expect(pdfLayoutConditionEvaluator()(TODAY_2026, {})).toBeUndefined();
  });

  it("lets a condition call a function the program registered, and counts it invalid where none is", () => {
    const functions = { isQuebec: (args: unknown[]) => args[0] === "QC" };
    const pdf = { layouts: [generated("standard"), generated("quebec", "isQuebec(province)")], defaultLayoutId: "standard" };
    expect(selectPdfLayoutForValues({ root, pdf }, { province: "QC" }, { functions })).toMatchObject({ layout: { id: "quebec" }, choice: "condition", failed: [] });
    expect(selectPdfLayoutForValues({ root, pdf }, { province: "ON" }, { functions })).toMatchObject({ layout: { id: "standard" }, choice: "default" });
    // Without the registry the name is unknown to the parser: the condition is invalid and never holds.
    expect(selectPdfLayoutForValues({ root, pdf }, { province: "QC" })).toMatchObject({ layout: { id: "standard" }, choice: "default", failed: [{ layoutId: "quebec", reason: "invalid" }] });
    // A tree calling it is evaluable only with the registry's names.
    const call: Expression = { kind: "call", name: "isQuebec" as never, args: [{ kind: "path", path: "province" }] };
    expect(readPdfLayoutCondition(generated("a", call))).toEqual({ evaluable: false, written: call });
    expect(readPdfLayoutCondition(generated("a", call), ["isQuebec"])).toEqual({ evaluable: true, expression: call });
  });
});

describe("the formulaErrors policy in the render model", () => {
  const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };
  function held(values: Record<string, unknown>): FormState {
    return {
      values,
      touched: new Set(),
      dirty: new Set(),
      validation: { valid: true },
      submission: { status: "idle", attempts: 0 },
      navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
      locale: "en"
    };
  }
  function form(configuration: Record<string, unknown> = {}): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration,
      children: {
        content: [
          { id: "province", type: "text", configuration: { label: "Province" } },
          { id: "note", type: "text", configuration: { label: "Note" }, rules: { visibleWhen: "province = " } }
        ]
      }
    };
  }
  const pdf = { layouts: [generated("standard"), generated("odd", "x +"), generated("quebec", 'province = "QC"')], defaultLayoutId: "standard" };

  it("fails by default, and under the warn opt-in warns formula.invalid per problem, naming the component, and drops the rule", async () => {
    const root = form();
    const before = JSON.stringify({ root, pdf });
    await expect(buildPdfRenderModel(root, held({ province: "QC" }), resolver, {}, { pdf })).rejects.toMatchObject({ name: "PdfKernelError", code: "formula_invalid" });
    const model = await buildPdfRenderModel(root, held({ province: "QC" }), resolver, {}, { pdf, formulaErrors: "warn" });
    const invalid = model.warnings.filter((warning) => warning.code === "formula.invalid");
    expect(invalid).toHaveLength(2);
    expect(invalid[0]).toMatchObject({ componentId: "note" });
    expect(invalid[0]!.message).toContain("rules:note:visibleWhen");
    expect(invalid[1]!.message).toContain("pdf:odd");
    expect(invalid[1]!.componentId).toBeUndefined();
    // The good formula still chose; the author's objects are as they were.
    expect(model).toMatchObject({ layoutId: "quebec", layoutChoice: "condition" });
    expect(JSON.stringify({ root, pdf })).toBe(before);
  });

  it("fails with formula_invalid under fail, from the call or the form's own configuration, and the call's warn reports instead", async () => {
    await expect(buildPdfRenderModel(form(), held({}), resolver, {}, { pdf, formulaErrors: "fail" })).rejects.toMatchObject({ name: "PdfKernelError", code: "formula_invalid" });
    await expect(buildPdfRenderModel(form({ formulaErrors: "fail" }), held({}), resolver, {}, { pdf })).rejects.toBeInstanceOf(PdfKernelError);
    // The call's word wins over the form's.
    const warned = await buildPdfRenderModel(form({ formulaErrors: "fail" }), held({}), resolver, {}, { pdf, formulaErrors: "warn" });
    expect(warned.warnings.filter((warning) => warning.code === "formula.invalid")).toHaveLength(2);
    expect(warned.layoutId).toBe("standard");
    // A word that is neither is no word: the form's own fail refuses.
    await expect(buildPdfRenderModel(form({ formulaErrors: "fail" }), held({}), resolver, {}, { pdf, formulaErrors: "ignore" as never })).rejects.toBeInstanceOf(PdfKernelError);
    // The layout handed over compiles too, and only its own problems are reported.
    const clean: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [] } };
    expect(() => compilePdfDefinition(clean, undefined, generated("given", "x +"), { formulaErrors: "fail" })).toThrow(/A formula could not be read: pdf:given/);
    const compiled = compilePdfDefinition(form(), undefined, generated("given", 'province = "QC"'), { formulaErrors: "warn" });
    expect(compiled.layout).toMatchObject({ id: "given", when: QUEBEC });
    expect(compiled.warnings.map((warning) => warning.componentId)).toEqual(["note"]);
  });
});

describe("layouts chosen by the answers", () => {
  it("names the layout on the document reply and the build reply, never on render's", () => {
    expect(PDF_ABI_VERSION).toBe("4.1.0");
    type DocumentReply = Extract<PdfKernelResponse, { op: "document" }>;
    type RenderReply = Extract<PdfKernelResponse, { op: "render" }>;
    type BuildReply = Extract<PdfKernelResponse, { op: "build" }>;
    expectTypeOf<DocumentReply["layoutId"]>().toEqualTypeOf<string | undefined>();
    expectTypeOf<DocumentReply["layoutChoice"]>().toEqualTypeOf<"given" | "asked" | "condition" | "default" | "fallback" | "derived" | undefined>();
    expectTypeOf<BuildReply["layoutChoice"]>().toEqualTypeOf<"given" | "asked" | "condition" | "default" | "fallback" | "derived" | undefined>();
    expectTypeOf<RenderReply>().not.toHaveProperty("layoutId");
    expectTypeOf<RenderReply>().not.toHaveProperty("layoutChoice");
    // What both produce is shared: the bytes and the reports.
    expectTypeOf<RenderReply["bytes"]>().toEqualTypeOf<DocumentReply["bytes"]>();
  });
});

// A layout's `when` holds only for the boolean true.
describe("selectPdfLayout: strict truthiness of a layout's when", () => {
  const FIRST = generated("first", LARGE);
  const SECOND = generated("second");
  const definition = (): { root: ComponentNode; pdf: unknown } => ({
    root: { id: "root", type: "form", configuration: {}, children: { content: [] } },
    pdf: { layouts: [FIRST, SECOND], defaultLayoutId: "second" }
  });
  const chosen = (largePrint: unknown): string | undefined => selectPdfLayout(definition(), answers({ largePrint })).layout?.id;

  it("prints the conditional layout for true only", () => {
    expect(chosen(true)).toBe("first");
  });

  it.each([["the text yes", "yes"], ["the text false", "false"], ["the number 1", 1], ["a list", ["x"]], ["an empty list", []], ["an object", { a: true }], ["false", false], ["null", null]])(
    "does not hold for %s: the default prints",
    (_label, value) => {
      expect(chosen(value)).toBe("second");
    }
  );
});
