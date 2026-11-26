import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { bindableComponents } from "../form-engine/builder/pdf-designer/pdf-designer.js";
import { createPdfTemplateDesigner } from "../form-engine/builder/pdf-designer/pdf-template-designer.js";
import { normalizeFieldName, pdfFieldOwnName, planTemplateFormFields } from "../form-engine/builder/pdf-designer/template-mode.js";
import { pdfFieldNameFromLabel, pdfFieldNameProblem, resolvePdfAreaFields, type PdfTemplateArea, type PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfTemplateFieldInfo, PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Sample" },
  children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }, { id: "submit", type: "button", configuration: { label: "Send" } }] }
};
const TEMPLATE = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" } as const;
const INSPECTION: PdfTemplateInfo = {
  pageCount: 2,
  pages: [
    { index: 1, width: 612, height: 792 },
    { index: 2, width: 420, height: 298 }
  ],
  fields: [
    { name: "Full Name", kind: "text", page: 1, rect: { x: 250, y: 660, width: 300, height: 22 }, readOnly: false, required: false },
    { name: "Agree", kind: "checkbox", page: 1, rect: { x: 250, y: 500, width: 14, height: 14 }, exportValues: ["Yes"], readOnly: false, required: false }
  ],
  hasXfa: false,
  encrypted: false
};

function layout(overrides: Partial<PdfTemplateLayout> = {}): PdfTemplateLayout {
  return { id: "paper", kind: "template", name: "Paper", template: TEMPLATE as never, fields: [], ...overrides };
}

function open(overrides: Partial<PdfTemplateLayout> = {}, formRoot: ComponentNode = FORM) {
  const designer = createPdfTemplateDesigner({ layout: layout(overrides), inspection: INSPECTION, formRoot });
  const controller = new BuilderController({
    ...designer.builderOptions,
    notes: (edited, tree, id) => designer.notesFor(edited, tree, id),
    problems: (edited, tree, id) => designer.problemsFor(edited, tree, id)
  });
  return { designer, controller };
}

function field(name: string, kind: PdfTemplateFieldInfo["kind"], at?: { page: number; x: number; y: number }, extra: Partial<PdfTemplateFieldInfo> = {}): PdfTemplateFieldInfo {
  return { name, kind, readOnly: false, required: false, ...(at ? { page: at.page, rect: { x: at.x, y: at.y, width: 120, height: 20 } } : {}), ...extra };
}

function plan(fields: PdfTemplateFieldInfo[], root: ComponentNode = FORM) {
  const controller = new BuilderController({ initialRoot: root });
  return planTemplateFormFields(fields, root, bindableComponents(root, "en"), { hasType: (type) => controller.hasComponentType(type), template: (type) => controller.componentTemplate(type) });
}

const AREA = { id: "area_1", page: 1, rect: { x: 400, y: 600, width: 150, height: 20 }, source: { kind: "component", componentId: "fullName" } } as const;

describe("template layouts: field types, areas and form fields", () => {
  it("keeps a literal source's type through the designer (a true prints Yes, not the word)", () => {
    const fields = [
      { pdfField: "Full Name", source: { kind: "literal", value: true } },
      { pdfField: "Agree", source: { kind: "literal", value: 3 } }
    ] as PdfTemplateLayout["fields"];
    const { designer, controller } = open({ fields });
    expect(designer.layoutFrom(controller.snapshot()).fields).toEqual(fields);
  });

  it("keeps an area typed off its page on the page at Save, in one undo step, and says so for a page the PDF lacks", () => {
    const { designer, controller } = open({ areas: [{ ...AREA }] as PdfTemplateArea[] });
    controller.select("area_1");
    controller.setDraftProperty("area_1", "page", 2);
    expect(controller.commitDraft("area_1")).toBe(true);
    // Page 2 is 420 × 298: the box moved inside it rather than hanging off it.
    expect(controller.getProperty("area_1", "rect")).toEqual({ x: 270, y: 278, width: 150, height: 20 });
    expect(designer.layoutFrom(controller.snapshot()).areas![0]!.rect).toEqual({ x: 270, y: 278, width: 150, height: 20 });
    controller.undo();
    expect(controller.getProperty("area_1", "page")).toBe(1);
    expect(controller.getProperty("area_1", "rect")).toEqual(AREA.rect);

    controller.select("area_1");
    controller.setDraftProperty("area_1", "page", 7);
    expect(controller.problemsOf("area_1")).toEqual([{ target: "page", message: "The PDF has 2 pages: an area on page 7 is not printed." }]);
    expect(controller.commitDraft("area_1")).toBe(false);
  });

  it("puts an area another PDF's page would not hold back on its page, and notes one on a page it lacks", () => {
    const { designer, controller } = open({
      areas: [
        { ...AREA, page: 2 },
        { ...AREA, id: "area_2", page: 5 }
      ] as PdfTemplateArea[]
    });
    expect(designer.layoutFrom(controller.snapshot()).areas!.map((area) => area.rect)).toEqual([{ x: 270, y: 278, width: 150, height: 20 }, AREA.rect]);
    expect(controller.notesOf("area_2")).toEqual([{ target: "page", message: "The PDF has 2 pages: an area on page 5 is not printed." }]);
  });

  it("notes a widget or an area filled from a component the form no longer has, and lists those fields", () => {
    const { designer, controller } = open({ fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "gone" } }] });
    const widget = designer.widgetIdFor("Full Name")!;
    expect(controller.notesOf(widget)).toEqual([
      { target: "source.componentId", message: 'Filled from "gone", which the form no longer has: nothing is printed here. Choose another component, or Create form fields builds one.' }
    ]);
    expect([...designer.unresolvedFieldsOf(controller.snapshot())]).toEqual(["Full Name"]);
    expect([...designer.unresolvedFieldsOf(controller.snapshot(), new Set(["gone"]))]).toEqual([]);
  });

  it("names a fillable area's field from its label without periods, unique among the areas; a typed name stays and is checked", () => {
    expect(pdfFieldNameFromLabel("Policy No.")).toBe("Policy No");
    expect(pdfFieldNameFromLabel("Sig. date")).toBe("Sig date");
    expect(pdfFieldNameProblem("Policy No.")).toContain("cannot name a PDF field");
    expect(pdfFieldNameProblem("applicant.name")).toBeUndefined();
    expect(pdfFieldNameProblem("Policy No.", (key, params) => `${key} says "${params.name}"`)).toBe('pdf.fieldName.period says "Policy No."');
    const names = resolvePdfAreaFields([
      { id: "a1", label: "Date", field: {} },
      { id: "a2", label: "Date", field: {} },
      { id: "a3", label: "Policy No.", field: {} },
      { id: "a4", field: { name: "shared" } },
      { id: "a5", field: { name: "shared" } },
      { id: "a6", label: "shared", field: {} },
      { id: "a7", label: "Note" }
    ]).map((resolved) => resolved?.name);
    expect(names).toEqual(["Date", "Date_2", "Policy No", "shared", "shared", "shared_2", undefined]);

    const { controller } = open({ areas: [{ ...AREA, rect: { x: 10, y: 10, width: 100, height: 20 }, label: "Full Name", field: {} }] as PdfTemplateArea[] });
    // Its name comes from its label, which the PDF's own field already has.
    expect(controller.notesOf("area_1")).toEqual([
      { target: "label", message: 'The PDF already has a field named "Full Name", so the area\'s field "Full Name" would not be made: rename the area, or type a field name.' }
    ]);
    controller.select("area_1");
    controller.setDraftProperty("area_1", "field.name", "Policy No.");
    expect(controller.problemsOf("area_1")).toEqual([{ target: "field.name", message: expect.stringContaining("cannot name a PDF field") }]);
    expect(controller.commitDraft("area_1")).toBe(false);
  });

  it("swaps the definitions under a tree without losing its history, drafts or selection", () => {
    const { designer, controller } = open();
    const widget = designer.widgetIdFor("Full Name")!;
    controller.setProperty(widget, "source", { kind: "literal", value: "HAND" });
    controller.select(designer.widgetIdFor("Agree")!);
    controller.setDraftProperty(designer.widgetIdFor("Agree")!, "checkedValue", "Yes");
    const fresh = createPdfTemplateDesigner({ layout: designer.layoutFrom(controller.snapshot()), inspection: INSPECTION, formRoot: FORM, tree: controller.snapshot() });
    controller.setComponentDefinitions(fresh.builderOptions.componentDefinitions!, fresh.builderOptions.componentTypes);
    expect(controller.canUndo()).toBe(true);
    expect(controller.selectedComponentId()).toBe(designer.widgetIdFor("Agree"));
    expect(controller.hasPendingChanges(designer.widgetIdFor("Agree"))).toBe(true);
    expect(fresh.widgetIdFor("Full Name")).toBe(widget);
  });
});

describe("Create form fields: a question repeated across pages, copies' index names", () => {
  it("asks once for a field repeated in the same box on every page, but twice for different boxes or a default name", () => {
    const result = plan([
      field("form1[0].Page1[0].ApplicantName[0]", "text", { page: 1, x: 10, y: 700 }),
      field("form1[0].Page2[0].ApplicantName[0]", "text", { page: 2, x: 10, y: 700 }),
      field("form1[0].Page1[0].TextField1[0]", "text", { page: 1, x: 10, y: 600 }),
      field("form1[0].Page2[0].TextField1[0]", "text", { page: 2, x: 10, y: 600 }),
      field("form1[0].Page1[0].Row1[0].Item[0]", "text", { page: 1, x: 10, y: 500 }),
      field("form1[0].Page1[0].Row2[0].Item[0]", "text", { page: 1, x: 10, y: 480 })
    ]);
    expect(result.entries.map((entry) => entry.node.id)).toEqual(["ApplicantName", "TextField1", "Item", "Item_2", "TextField1_2"]);
    expect(result.mappings.filter((mapping) => mapping.source.kind === "component" && mapping.source.componentId === "ApplicantName").map((mapping) => mapping.pdfField)).toEqual([
      "form1[0].Page1[0].ApplicantName[0]",
      "form1[0].Page2[0].ApplicantName[0]"
    ]);
  });

  it("names a copy by its field and index (Text1.0 → Text1_0, labelled Text 1 0), and matches it again by that name", () => {
    expect(pdfFieldOwnName("Text1.0")).toBe("Text1.0");
    expect(pdfFieldOwnName("form.Page1.Phone.1.2")).toBe("Phone.1.2");
    expect(pdfFieldOwnName("topmostSubform[0].Page1[0].Name[0]")).toBe("Name");
    expect(normalizeFieldName("Text1.0")).toBe("text10");
    const result = plan([field("Text1.0", "text"), field("Text1.1", "text"), field("Text2.0", "text")]);
    expect(result.entries.map((entry) => ({ id: entry.node.id, label: (entry.node.configuration as Record<string, unknown>).label }))).toEqual([
      { id: "Text1_0", label: "Text 1 0" },
      { id: "Text1_1", label: "Text 1 1" },
      { id: "Text2_0", label: "Text 2 0" }
    ]);
    const again = plan([field("Text1.0", "text")], {
      ...FORM,
      children: { content: [result.entries[0]!.node, ...FORM.children!.content!] }
    });
    expect(again.entries).toEqual([]);
    expect(again.mappings).toEqual([{ pdfField: "Text1.0", source: { kind: "component", componentId: "Text1_0" } }]);
  });
});
