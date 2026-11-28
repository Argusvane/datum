import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createPdfTemplateDesigner, followRenameInTemplateTree, widgetNodeId } from "../form-engine/builder/pdf-designer/pdf-template-designer.js";
import { pdfConditionFieldOptions, pdfLayoutConditionFindings } from "../form-engine/builder/pdf-designer/layout-conditions.js";
import { PDF_DOCUMENT_COMPONENT_TYPE, type PdfGeneratedLayout, type PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import { PDF_AREA_COMPONENT_TYPE, PDF_TEMPLATE_AREAS_SLOT, PDF_TEMPLATE_WIDGETS_SLOT, PDF_WIDGET_COMPONENT_TYPE } from "../form-engine/render/pdf/pdf-template-components.js";

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Sample" },
  children: {
    content: [
      { id: "fullName", type: "text", configuration: { label: "Full name" } },
      { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } },
      { id: "submit", type: "button", configuration: { label: "Send" } }
    ]
  }
};

const TEMPLATE = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" };

const INSPECTION: PdfTemplateInfo = {
  pageCount: 2,
  pages: [
    { index: 1, width: 612, height: 792 },
    { index: 2, width: 612, height: 792 }
  ],
  fields: [
    { name: "Full Name", kind: "text", page: 1, rect: { x: 250, y: 660, width: 300, height: 22 }, readOnly: false, required: false },
    { name: "Subscribe", kind: "checkbox", page: 1, rect: { x: 250, y: 500, width: 14, height: 14 }, exportValues: ["Yes"], readOnly: false, required: false },
    { name: "Sign here", kind: "signature", page: 2, rect: { x: 50, y: 50, width: 200, height: 40 }, readOnly: false, required: false }
  ],
  hasXfa: false,
  encrypted: false
};

function layout(overrides: Partial<PdfTemplateLayout> = {}): PdfTemplateLayout {
  return {
    id: "paper",
    kind: "template",
    name: "Paper form",
    template: TEMPLATE,
    fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }],
    ...overrides
  };
}

describe("createPdfTemplateDesigner", () => {
  it("names a widget after its field, made an id, unique among the tree's", () => {
    const taken = new Set<string>();
    expect(widgetNodeId("Full Name", taken)).toBe("widget_full_name");
    expect(widgetNodeId("topmostSubform[0].Page1[0].Name[0]", taken)).toBe("widget_topmostsubform_0_page1_0_name_0");
    taken.add("widget_full_name");
    expect(widgetNodeId("Full-Name", taken)).toBe("widget_full_name_2");
    expect(widgetNodeId("", taken)).toBe("widget_field");
  });

  it("builds one widget per template field, seeded from the layout's mappings by name, and the areas as nodes", () => {
    const designer = createPdfTemplateDesigner({
      layout: layout({
        fields: [
          { pdfField: "Full Name", source: { kind: "component", componentId: "fullName" }, format: { kind: "text" } },
          // A mapping over a field this PDF lacks: carried into no widget, and dropped from the layout.
          { pdfField: "Old Name", source: { kind: "component", componentId: "fullName" } }
        ],
        areas: [{ id: "area_1", label: "Stamp", page: 2, rect: { x: 10, y: 20, width: 100, height: 30 }, source: { kind: "literal", value: "APPROVED" }, draw: { kind: "text", bold: true }, field: { name: "stamp", required: true } }]
      }),
      inspection: INSPECTION,
      formRoot: FORM
    });
    const root = designer.builderOptions.initialRoot!;
    expect(root.type).toBe("pdf-template");
    expect(root.configuration).toMatchObject({ name: "Paper form", template: TEMPLATE });
    const widgets = root.children![PDF_TEMPLATE_WIDGETS_SLOT]!;
    expect(widgets.map((node) => node.id)).toEqual(["widget_full_name", "widget_subscribe", "widget_sign_here"]);
    expect(widgets[0]).toMatchObject({
      type: PDF_WIDGET_COMPONENT_TYPE,
      configuration: { pdfField: "Full Name", label: "Full Name", kind: "text", page: 1, source: { kind: "component", componentId: "fullName" }, format: { kind: "text" } }
    });
    expect(widgets[1]!.configuration).toMatchObject({ source: { kind: "" } });
    const areas = root.children![PDF_TEMPLATE_AREAS_SLOT]!;
    expect(areas[0]).toMatchObject({
      id: "area_1",
      type: PDF_AREA_COMPONENT_TYPE,
      configuration: { label: "Stamp", page: 2, rect: { x: 10, y: 20, width: 100, height: 30 }, source: { kind: "literal", value: "APPROVED" }, draw: { kind: "text", bold: true }, field: { enabled: true, name: "stamp", required: true } }
    });
    // The palette offers an area; the widgets are the PDF's own and never on it. Their definitions say so.
    expect(designer.builderOptions.componentTypes!.map((entry) => entry.type)).toEqual([PDF_AREA_COMPONENT_TYPE]);
    const widgetDefinition = designer.builderOptions.componentDefinitions!.find((definition) => definition.type === PDF_WIDGET_COMPONENT_TYPE);
    expect(widgetDefinition?.fixed).toBe(true);
    // The signature field is offered for the root's signature choice.
    const rootDefinition = designer.builderOptions.componentDefinitions!.find((definition) => definition.type === "pdf-template");
    const signatureField = rootDefinition?.propertyEditor?.fields?.find((field) => field.propertyPath === "signature.field");
    expect(signatureField?.choices?.map((choice) => choice.value)).toEqual(["", "Sign here"]);
    expect(designer.widgetIdFor("Subscribe")).toBe("widget_subscribe");
    expect(designer.fieldNameOf("widget_sign_here")).toBe("Sign here");
    expect(designer.fieldNameOf("area_1")).toBeUndefined();

    // Folded back: the layout as it came, the stale mapping gone, the area's defaults left out.
    const folded = designer.layoutFrom(root);
    expect(folded).toEqual(
      layout({
        fields: [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" }, format: { kind: "text" } }],
        areas: [{ id: "area_1", label: "Stamp", page: 2, rect: { x: 10, y: 20, width: 100, height: 30 }, source: { kind: "literal", value: "APPROVED" }, draw: { bold: true }, field: { name: "stamp", required: true } }]
      })
    );
    expect(designer.mappedFieldsOf(root)).toEqual(new Set(["Full Name"]));
    expect(designer.areasOf(root).map((area) => area.id)).toEqual(["area_1"]);
  });

  it("edits through a BuilderController like any tree: a mapping set, an area drawn and moved, undone; the layout follows each commit", () => {
    const designer = createPdfTemplateDesigner({ layout: layout(), inspection: INSPECTION, formRoot: FORM });
    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    const current = () => designer.layoutFrom(controller.snapshot());

    // What fills a widget is its property: the kind, then the component.
    controller.setProperty("widget_subscribe", "source", { kind: "component", componentId: "subscribe" });
    controller.setProperty("widget_subscribe", "checkedValue", "Yes");
    expect(current().fields).toEqual([
      { pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } },
      { pdfField: "Subscribe", source: { kind: "component", componentId: "subscribe" }, checkedValue: "Yes" }
    ]);
    // A kind switched back to nothing unmaps it, whatever the other keys still hold.
    controller.setProperty("widget_subscribe", "source.kind", "");
    expect(current().fields.map((mapping) => mapping.pdfField)).toEqual(["Full Name"]);
    controller.undo();
    expect(current().fields.map((mapping) => mapping.pdfField)).toEqual(["Full Name", "Subscribe"]);

    // A widget is the PDF's: it cannot be removed, and the inspector offers no Delete for it.
    expect(controller.isFixedNode("widget_full_name")).toBe(true);
    expect(() => controller.remove("widget_full_name")).toThrow(/cannot be removed/);

    // An area drawn on a page: one add, with its page and rectangle, in the areas slot.
    controller.add(PDF_AREA_COMPONENT_TYPE, "template", PDF_TEMPLATE_AREAS_SLOT, { configuration: { page: 2, rect: { x: 30, y: 40, width: 200, height: 14 } } });
    const areaId = controller.selectedComponentId()!;
    expect(areaId).toMatch(/^pdf-area_\d+$/);
    expect(current().areas).toEqual([{ id: areaId, page: 2, rect: { x: 30, y: 40, width: 200, height: 14 }, source: { kind: "literal", value: null } }]);
    // The palette's add lands in the areas slot too, though the widgets slot comes first.
    controller.add(PDF_AREA_COMPONENT_TYPE);
    expect(controller.snapshot().children![PDF_TEMPLATE_AREAS_SLOT]!.length).toBe(2);
    expect(controller.snapshot().children![PDF_TEMPLATE_WIDGETS_SLOT]!.length).toBe(3);
    controller.undo();
    // Moved, filled, made a check box: each a property, the layout trimmed of defaults.
    controller.setProperty(areaId, "rect", { x: 62, y: 40, width: 200, height: 14 });
    controller.setProperty(areaId, "source", { kind: "component", componentId: "subscribe" });
    controller.setProperty(areaId, "draw.kind", "check");
    controller.setProperty(areaId, "draw.align", "start");
    controller.setProperty(areaId, "field.enabled", true);
    controller.setProperty(areaId, "field.readOnly", false);
    expect(current().areas).toEqual([
      { id: areaId, page: 2, rect: { x: 62, y: 40, width: 200, height: 14 }, source: { kind: "component", componentId: "subscribe" }, draw: { kind: "check" }, field: {} }
    ]);
    // Drafts show on the pages before Save, and the layout waits.
    controller.select(areaId);
    controller.setDraftProperty(areaId, "rect", { x: 100, y: 40, width: 200, height: 14 });
    expect(designer.areasOf(controller.previewSnapshot())[0]?.rect.x).toBe(100);
    expect(current().areas?.[0]?.rect.x).toBe(62);
    controller.commitDraft(areaId);
    expect(current().areas?.[0]?.rect.x).toBe(100);
    controller.remove(areaId);
    expect(current().areas).toBeUndefined();
  });

  it("keeps the layout's mappings and settings when nothing has read the PDF yet, and prunes what is back at its default", () => {
    const designer = createPdfTemplateDesigner({
      layout: layout({ options: { flatten: true }, conformance: { pdfa: "2b" }, accessibility: { tagged: false } }),
      formRoot: FORM
    });
    const root = designer.builderOptions.initialRoot!;
    expect(root.children![PDF_TEMPLATE_WIDGETS_SLOT]).toEqual([]);
    expect(designer.builderOptions.componentTypes).toEqual([]);
    expect(designer.layoutFrom(root)).toEqual(layout({ options: { flatten: true }, conformance: { pdfa: "2b" }, accessibility: { tagged: false } }));

    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    controller.setProperty("template", "options.flatten", false);
    controller.setProperty("template", "conformance.pdfa", "");
    controller.setProperty("template", "conformance.attachment.name", "");
    controller.setProperty("template", "signature.required", false);
    const folded = designer.layoutFrom(controller.snapshot());
    expect(folded.options).toBeUndefined();
    expect(folded.conformance).toBeUndefined();
    expect(folded.signature).toBeUndefined();
    // Accessibility is carried as it came: a `tagged: false` is a choice, not a default.
    expect(folded.accessibility).toEqual({ tagged: false });
    expect(folded.fields).toEqual(layout().fields);
  });

  it("keeps a signature's `appearance: false` (an invisible signature) through an edit: it is a choice, not a default", () => {
    const designer = createPdfTemplateDesigner({
      layout: layout({ signature: { field: "Sign here", appearance: false } }),
      inspection: INSPECTION,
      formRoot: FORM
    });
    expect(designer.layoutFrom(designer.builderOptions.initialRoot!).signature).toEqual({ field: "Sign here", appearance: false });

    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    controller.setProperty("template", "name", "Renamed");
    controller.setProperty("template", "signature.required", false);
    expect(designer.layoutFrom(controller.snapshot()).signature).toEqual({ field: "Sign here", appearance: false });
  });

  it("round-trips the layout's when and any root key it has no box for: nothing is lost on the first edit", () => {
    const quebec = 'province = "QC"';
    // A key from a later layout version, say — the designer has no box for it, and keeps it.
    const conditional = { ...layout({ when: quebec, options: { flatten: true } }), futureKey: { keep: [1, 2] } } as PdfTemplateLayout;
    const designer = createPdfTemplateDesigner({ layout: conditional, inspection: INSPECTION, formRoot: FORM });
    const root = designer.builderOptions.initialRoot!;
    // Seeded on the root, where the Rules tab edits it; the catalog's copy is the layout as it came.
    expect(root.configuration).toMatchObject({ when: quebec, futureKey: { keep: [1, 2] } });
    expect(designer.layout).toBe(conditional);
    expect(designer.layoutFrom(root)).toEqual(conditional);

    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    controller.setProperty("widget_subscribe", "source", { kind: "component", componentId: "subscribe" });
    const edited = designer.layoutFrom(controller.snapshot());
    expect(edited.when).toEqual(quebec);
    expect((edited as unknown as Record<string, unknown>).futureKey).toEqual({ keep: [1, 2] });
    expect(edited.fields.map((mapping) => mapping.pdfField)).toEqual(["Full Name", "Subscribe"]);
    // A template layout has no root node: its one copy is the top level.
    expect(JSON.stringify(edited).match(/"when"/g)).toHaveLength(1);

    controller.setProperty("template", "when", undefined);
    expect(designer.layoutFrom(controller.snapshot())).not.toHaveProperty("when");
    // What the tree holds as its structure never comes back from the root's settings.
    controller.setProperty("template", "fields", "not the mappings");
    expect(designer.layoutFrom(controller.snapshot()).fields.map((mapping) => mapping.pdfField)).toEqual(["Full Name", "Subscribe"]);
  });

  it("follows a form rename into the open tree's field and area formulas, and lists the ones that do not parse", () => {
    const designer = createPdfTemplateDesigner({
      layout: layout({
        fields: [
          { pdfField: "Full Name", source: { kind: "expression", expression: "fullName + 1" } },
          { pdfField: "Subscribe", source: { kind: "expression", expression: "fullName = " } }
        ],
        areas: [{ id: "area_1", label: "Stamp", page: 2, rect: { x: 10, y: 20, width: 100, height: 30 }, source: { kind: "expression", expression: "fullName" }, draw: { kind: "text" } }]
      }),
      inspection: INSPECTION,
      formRoot: FORM
    });
    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    const followed = followRenameInTemplateTree(controller, "fullName", "name");
    expect(followed.changed).toBe(true);
    expect(followed.unparsed).toEqual([{ nodeId: "widget_subscribe", formula: "fullName = " }]);
    const folded = designer.layoutFrom(controller.snapshot());
    expect(folded.fields.map((mapping) => (mapping.source as { expression?: unknown }).expression)).toEqual(["name + 1", "fullName = "]);
    expect((folded.areas?.[0]?.source as { expression?: unknown }).expression).toBe("name");
    expect(followRenameInTemplateTree(controller, "fullName", "name").changed).toBe(false);
  });
});

describe("a source naming something the form no longer has", () => {
  const widgetOf = (tree: ComponentNode): ComponentNode => tree.children![PDF_TEMPLATE_WIDGETS_SLOT]!.find((n) => n.type === PDF_WIDGET_COMPONENT_TYPE)!;
  const designerFor = (source: unknown) =>
    createPdfTemplateDesigner({
      layout: layout({ fields: [{ pdfField: "Full Name", source: source as never }] }),
      inspection: INSPECTION,
      formRoot: FORM
    });
  const flagged = (source: unknown): boolean => {
    const designer = designerFor(source);
    const tree = designer.builderOptions.initialRoot!;
    const widget = widgetOf(tree);
    return designer.notesFor(widget, tree, widget.id).length > 0 && designer.unresolvedFieldsOf(tree).has("Full Name");
  };

  it("flags a path or an expression that leads with a removed component", () => {
    expect(flagged({ kind: "path", path: "gone" })).toBe(true);
    expect(flagged({ kind: "path", path: "gone.first" })).toBe(true);
    expect(flagged({ kind: "expression", expression: "gone + 1" })).toBe(true);
  });

  it("does not flag a path or expression the form holds, a scoped path, or a formula that does not parse", () => {
    expect(flagged({ kind: "path", path: "fullName" })).toBe(false);
    expect(flagged({ kind: "path", path: "fullName.first" })).toBe(false);
    expect(flagged({ kind: "expression", expression: "fullName" })).toBe(false);
    expect(flagged({ kind: "path", path: "row.gone" })).toBe(false);
    expect(flagged({ kind: "expression", expression: "gone +" })).toBe(false);
  });

  it("knows a data key as a name the form holds", () => {
    const form: ComponentNode = { ...FORM, children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name", dataKey: "applicant" } }] } };
    const designer = createPdfTemplateDesigner({
      layout: layout({ fields: [{ pdfField: "Full Name", source: { kind: "path", path: "applicant" } }] }),
      inspection: INSPECTION,
      formRoot: form
    });
    expect(designer.unresolvedFieldsOf(designer.builderOptions.initialRoot!).size).toBe(0);
  });

  it("a form rename follows into component and path sources of the open tree, and undo restores them", () => {
    const designer = createPdfTemplateDesigner({
      layout: layout({
        fields: [
          { pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } },
          { pdfField: "Subscribe", source: { kind: "path", path: "fullName.first" } }
        ]
      }),
      inspection: INSPECTION,
      formRoot: FORM
    });
    const c = new BuilderController();
    c.setOptions(designer.builderOptions);
    const before = JSON.stringify(c.snapshot());
    const out = followRenameInTemplateTree(c, "fullName", "legalName");
    expect(out.changed).toBe(true);
    const after = JSON.stringify(c.snapshot());
    expect(after).toContain('"componentId":"legalName"');
    expect(after).toContain('"path":"legalName.first"');
    expect(after).not.toContain("fullName");
    c.undo();
    c.undo();
    expect(JSON.stringify(c.snapshot())).toBe(before);
  });
});

describe("a widget or an area filled from a saved path or a formula", () => {
  const setup = (fields: PdfTemplateLayout["fields"] = [{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" } }]) => {
    const designer = createPdfTemplateDesigner({ layout: layout({ fields }), inspection: INSPECTION, formRoot: FORM });
    const controller = new BuilderController();
    // As the PDF mode wires them (pdf-builder-mode.ts).
    controller.setOptions({ ...designer.builderOptions, notes: designer.notesFor, problems: designer.problemsFor });
    return { designer, controller, current: () => designer.layoutFrom(controller.snapshot()) };
  };
  const fieldIds = (controller: BuilderController, id: string): string[] =>
    controller.inspectorModel(id)!.sections.flatMap((section) => section.fields.map((field) => field.propertyPath));

  it("offers Value path and Formula beside the existing kinds", () => {
    const { controller } = setup();
    const kind = controller.inspectorModel("widget_full_name")!.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "source.kind")!;
    expect(kind.choices.map((choice) => choice.value)).toEqual(["", "component", "template", "literal", "path", "expression"]);
  });

  it("draws the path box only for a path source, with the saved paths as suggestions, and stores the path", () => {
    const { controller, current } = setup();
    expect(fieldIds(controller, "widget_subscribe")).not.toContain("source.path");
    controller.setProperty("widget_subscribe", "source.kind", "path");
    expect(fieldIds(controller, "widget_subscribe")).toContain("source.path");
    expect(fieldIds(controller, "widget_subscribe")).not.toContain("source.expression");
    const box = controller.inspectorModel("widget_subscribe")!.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "source.path")!;
    expect(box.control).toBe("text");
    expect(box.suggestions?.map((choice) => choice.value)).toEqual(["fullName", "subscribe"]);
    controller.setProperty("widget_subscribe", "source.path", "fullName.first");
    expect(current().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "path", path: "fullName.first" });
  });

  it("lints a typed path the form does not save, as it is typed, and not one it does", () => {
    const { designer, controller } = setup();
    controller.select("widget_subscribe");
    controller.setProperty("widget_subscribe", "source.kind", "path");
    controller.setDraftProperty("widget_subscribe", "source.path", "nope.here");
    const noteFor = (id: string) => controller.notesOf(id).filter((note) => note.target === "source.path");
    expect(noteFor("widget_subscribe").map((note) => note.message)).toEqual([expect.stringContaining('saves nothing at "nope"')]);
    controller.setDraftProperty("widget_subscribe", "source.path", "fullName");
    expect(noteFor("widget_subscribe")).toEqual([]);
    // Free typing is allowed: the lint never holds a draft back.
    controller.setDraftProperty("widget_subscribe", "source.path", "nope.here");
    expect(controller.problemsOf("widget_subscribe")).toEqual([]);
    expect(designer.layoutFrom(controller.previewSnapshot()).fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "path", path: "nope.here" });
  });

  it("draws the formula box only for a formula source and stores the formula string, the shapes the fill accepts", () => {
    const { controller, current } = setup();
    controller.setProperty("widget_subscribe", "source.kind", "expression");
    expect(fieldIds(controller, "widget_subscribe")).toContain("source.expression");
    expect(fieldIds(controller, "widget_subscribe")).not.toContain("source.path");
    const box = controller.inspectorModel("widget_subscribe")!.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "source.expression")!;
    expect(box.control).toBe("formula");
    controller.setProperty("widget_subscribe", "source.expression", "upper(fullName)");
    expect(current().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "expression", expression: "upper(fullName)" });
    controller.setProperty("widget_subscribe", "source.expression", { formula: "fullName", run: "server" });
    expect(current().fields.find((mapping) => mapping.pdfField === "Subscribe")?.source).toEqual({ kind: "expression", expression: { formula: "fullName", run: "server" } });
    // Cleared, nothing fills it.
    controller.setProperty("widget_subscribe", "source.expression", undefined);
    expect(current().fields.map((mapping) => mapping.pdfField)).toEqual(["Full Name"]);
  });

  it("holds a formula that does not read as a problem under its box, and not one that does", () => {
    const { controller } = setup();
    controller.select("widget_subscribe");
    controller.setProperty("widget_subscribe", "source.kind", "expression");
    controller.setDraftProperty("widget_subscribe", "source.expression", "fullName +");
    expect(controller.problemsOf("widget_subscribe").map((problem) => problem.target)).toEqual(["source.expression"]);
    controller.setDraftProperty("widget_subscribe", "source.expression", "fullName");
    expect(controller.problemsOf("widget_subscribe")).toEqual([]);
  });

  it("keeps the other binding fields when the kind changes, and writes only the chosen kind's", () => {
    const { controller, current } = setup([{ pdfField: "Full Name", source: { kind: "component", componentId: "fullName" }, checkedValue: "Yes", format: { kind: "text" } }]);
    controller.setProperty("widget_full_name", "source.kind", "path");
    controller.setProperty("widget_full_name", "source.path", "fullName");
    controller.setProperty("widget_full_name", "source.kind", "expression");
    controller.setProperty("widget_full_name", "source.expression", "fullName");
    expect(controller.getProperty("widget_full_name", "source.componentId")).toBe("fullName");
    expect(controller.getProperty("widget_full_name", "source.path")).toBe("fullName");
    expect(current().fields[0]).toEqual({ pdfField: "Full Name", source: { kind: "expression", expression: "fullName" }, checkedValue: "Yes", format: { kind: "text" } });
    controller.setProperty("widget_full_name", "source.kind", "path");
    expect(current().fields[0]?.source).toEqual({ kind: "path", path: "fullName" });
    controller.setProperty("widget_full_name", "source.kind", "component");
    expect(current().fields[0]?.source).toEqual({ kind: "component", componentId: "fullName" });
  });

  it("offers the same two kinds on an area", () => {
    const { controller, current } = setup();
    controller.add(PDF_AREA_COMPONENT_TYPE, "template", PDF_TEMPLATE_AREAS_SLOT, { configuration: { page: 1, rect: { x: 10, y: 10, width: 100, height: 14 } } });
    const areaId = controller.selectedComponentId()!;
    controller.setProperty(areaId, "source.kind", "expression");
    expect(fieldIds(controller, areaId)).toContain("source.expression");
    controller.setProperty(areaId, "source.expression", "fullName");
    expect(current().areas?.[0]?.source).toEqual({ kind: "expression", expression: "fullName" });
    controller.setProperty(areaId, "source.kind", "path");
    controller.setProperty(areaId, "source.path", "subscribe");
    expect(current().areas?.[0]?.source).toEqual({ kind: "path", path: "subscribe" });
  });
});

describe("a data grid in the form the template maps from", () => {
  const GRID_FORM: ComponentNode = {
    id: "root",
    type: "form",
    configuration: { title: "Order" },
    children: {
      content: [
        { id: "fullName", type: "text", configuration: { label: "Full name" } },
        {
          id: "lines",
          type: "dataGrid",
          configuration: { label: "Lines" },
          collection: { collectionPath: "ledger" },
          children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
        }
      ]
    }
  };
  const SECTION_FORM: ComponentNode = {
    ...GRID_FORM,
    children: { content: [GRID_FORM.children!.content![0]!, { ...GRID_FORM.children!.content![1]!, type: "panel" }] }
  };
  const designerFor = (formRoot: ComponentNode, source: unknown) =>
    createPdfTemplateDesigner({ layout: layout({ fields: [{ pdfField: "Full Name", source: source as never }] }), inspection: INSPECTION, formRoot });

  it("knows the grid's collection path as a name the form saves, as it knows a repeating section's", () => {
    for (const formRoot of [GRID_FORM, SECTION_FORM]) {
      for (const path of ["ledger", "ledger[0].sku", "lines", "sku"]) {
        const designer = designerFor(formRoot, { kind: "path", path });
        expect(designer.unresolvedFieldsOf(designer.builderOptions.initialRoot!).size, `${formRoot.children!.content![1]!.type} ${path}`).toBe(0);
      }
      const gone = designerFor(formRoot, { kind: "path", path: "nothing[0].sku" });
      expect(gone.unresolvedFieldsOf(gone.builderOptions.initialRoot!).has("Full Name")).toBe(true);
    }
  });

  it("offers the grid and its row template's fields among the saved paths exactly as a section's", () => {
    const choices = (formRoot: ComponentNode) => {
      const designer = designerFor(formRoot, { kind: "path", path: "ledger" });
      const controller = new BuilderController();
      controller.setOptions(designer.builderOptions);
      controller.setProperty("widget_subscribe", "source.kind", "path");
      const box = controller.inspectorModel("widget_subscribe")!.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "source.path")!;
      return box.suggestions?.map((choice) => choice.value);
    };
    const grid = choices(GRID_FORM);
    expect(grid).toEqual(choices(SECTION_FORM));
    // The grid's path, then its row template's field as the Data workspace lists it (a row's key within an entry).
    expect(grid).toEqual(["fullName", "ledger", "ledger[].sku"]);
  });
});

describe("a layout's condition over a form with a data grid", () => {
  const form = (type: string): ComponentNode => ({
    id: "root",
    type: "form",
    configuration: { title: "Order" },
    children: {
      content: [
        { id: "express", type: "checkbox", configuration: { label: "Express" } },
        { id: "lines", type: "dataGrid", configuration: { label: "Lines" }, collection: { collectionPath: "ledger" }, children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] } }
      ].map((node) => (node.id === "lines" ? { ...node, type } : node))
    }
  });
  const generated = (id: string, when?: string): PdfGeneratedLayout => ({
    id,
    kind: "generated",
    name: id === "std" ? "Standard" : "Grid copy",
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } },
    ...(when !== undefined ? { when } : {})
  });

  it("suggests the answers outside the grid, not the grid or its row template, as it does for a section", () => {
    for (const type of ["dataGrid", "panel"]) {
      expect(pdfConditionFieldOptions({ formRoot: form(type), locale: "en" }), type).toEqual([{ value: "express", label: "Express (express)" }]);
    }
  });

  it("says a condition cannot count the grid's rows or read a cell, with the same findings as a section", () => {
    const count = "len(lines)";
    const cell = "sku";
    for (const type of ["dataGrid", "panel"]) {
      const context = { formRoot: form(type), locale: "en" };
      const counted = pdfLayoutConditionFindings(context, { layouts: [generated("g", count), generated("std")], defaultLayoutId: "std" });
      expect(counted.map((finding) => finding.code), type).toEqual(["pdf-layout.condition.entry-field"]);
      const read = pdfLayoutConditionFindings(context, { layouts: [generated("g", cell), generated("std")], defaultLayoutId: "std" });
      expect(read.map((finding) => finding.code), type).toEqual(["pdf-layout.condition.entry-field"]);
    }
  });
});
