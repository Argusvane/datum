/**
 * The Values section of a template widget: where a PDF radio group, dropdown or list
 * is filled from a form component with answers of its own, one row per answer says what is
 * written to the PDF for it. Driven through the controller and its inspector model, as the panel
 * reads them; the panel's own events are covered in the packages/datum suite.
 */
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createPdfTemplateDesigner, staleValueMapEntries } from "../form-engine/builder/pdf-designer/pdf-template-designer.js";
import { buildInspectorModel, valueMapWith, valueMapWithout, type InspectorField } from "../form-engine/builder/property-editor/inspector-model.js";
import type { PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [
      { id: "change", type: "radio", configuration: { label: "Change", options: [{ value: "improved", label: "Improved" }, { value: "unchanged", label: "Unchanged" }, { value: "worsened", label: "Worsened" }] } },
      { id: "working", type: "checkbox", configuration: { label: "Working" } },
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "province", type: "select", configuration: { label: "Province", data: { sourceId: "provinces" }, options: [{ value: "ON" }] } },
      { id: "yesno", type: "radio", configuration: { label: "Fit", options: [{ value: "1" }, { value: "2" }] } }
    ]
  }
};

const INSPECTION: PdfTemplateInfo = {
  pageCount: 1,
  pages: [{ index: 1, width: 612, height: 792 }],
  fields: [
    { name: "Since", kind: "radio", page: 1, rect: { x: 10, y: 600, width: 12, height: 12 }, options: ["1", "2", "3"], readOnly: false, required: false },
    { name: "Fit", kind: "radio", page: 1, rect: { x: 10, y: 560, width: 12, height: 12 }, options: ["1", "2"], readOnly: false, required: false },
    { name: "Prov", kind: "dropdown", page: 1, rect: { x: 10, y: 520, width: 80, height: 14 }, options: ["On", "Qc"], readOnly: false, required: false },
    { name: "Agree", kind: "checkbox", page: 1, rect: { x: 10, y: 480, width: 12, height: 12 }, exportValues: ["Yes"], readOnly: false, required: false },
    { name: "Full Name", kind: "text", page: 1, rect: { x: 10, y: 440, width: 200, height: 14 }, readOnly: false, required: false }
  ],
  hasXfa: false,
  encrypted: false
};

const TEMPLATE = { storage: "url", name: "paper.pdf", type: "application/pdf", size: 3072, ref: "/templates/paper.pdf" };

function open(fields: PdfTemplateLayout["fields"] = []) {
  const designer = createPdfTemplateDesigner({
    layout: { id: "paper", kind: "template", template: TEMPLATE, fields },
    inspection: INSPECTION,
    formRoot: FORM
  });
  const controller = new BuilderController();
  // As the PDF mode wires them (pdf-builder-mode.ts).
  controller.setOptions({ ...designer.builderOptions, notes: designer.notesFor, problems: designer.problemsFor });
  const current = () => designer.layoutFrom(controller.snapshot());
  const valuesField = (pdfField: string): InspectorField | undefined =>
    controller.inspectorModel(designer.widgetIdFor(pdfField)!)!.sections.flatMap((section) => section.fields).find((field) => field.propertyPath === "values");
  const sectionIds = (pdfField: string): string[] => controller.inspectorModel(designer.widgetIdFor(pdfField)!)!.sections.map((section) => section.id);
  const noteMessages = (pdfField: string): string[] =>
    designer.notesFor(controller.snapshot().children!.widgets!.find((node) => node.id === designer.widgetIdFor(pdfField))!, controller.snapshot(), designer.widgetIdFor(pdfField)!)
      .filter((note) => note.target === "values")
      .map((note) => note.message);
  return { designer, controller, current, valuesField, sectionIds, noteMessages };
}

const since = (extra: Partial<PdfTemplateLayout["fields"][number]> = {}): PdfTemplateLayout["fields"][number] => ({
  pdfField: "Since",
  source: { kind: "component", componentId: "change" },
  ...extra
});

describe("the Values section of a template widget", () => {
  it("is drawn after Mapping for a radio group filled from a component with options, one row per option", () => {
    const { valuesField, sectionIds } = open([since()]);
    const field = valuesField("Since")!;
    expect(sectionIds("Since")).toEqual(["mapping", "values"]);
    expect(field.control).toBe("value-map");
    expect(field.valueMap!.rows).toEqual([
      { value: "improved", label: "Improved", target: "" },
      { value: "unchanged", label: "Unchanged", target: "" },
      { value: "worsened", label: "Worsened", target: "" }
    ]);
    expect(field.valueMap!.targets).toEqual([
      { value: "1", label: "1" },
      { value: "2", label: "2" },
      { value: "3", label: "3" }
    ]);
    expect(field.valueMap).toMatchObject({ sameLabel: "Same value", byOrderLabel: "Match by order", byOrder: { improved: "1", unchanged: "2", worsened: "3" } });
  });

  it("offers a Yes and a No row, keyed true and false, for a checkbox component feeding a radio group", () => {
    const { valuesField } = open([{ pdfField: "Fit", source: { kind: "component", componentId: "working" } }]);
    expect(valuesField("Fit")!.valueMap!.rows).toEqual([
      { value: "true", label: "Yes", target: "" },
      { value: "false", label: "No", target: "" }
    ]);
    expect(valuesField("Fit")!.valueMap!.byOrder).toEqual({ true: "1", false: "2" });
  });

  it("is drawn for a dropdown too, and pairs only as many rows as the field has options", () => {
    const { valuesField } = open([{ pdfField: "Prov", source: { kind: "component", componentId: "change" } }]);
    expect(valuesField("Prov")!.valueMap!.targets.map((target) => target.value)).toEqual(["On", "Qc"]);
    expect(valuesField("Prov")!.valueMap!.byOrder).toEqual({ improved: "On", unchanged: "Qc" });
  });

  it("is not drawn for a field without options, a source that is not a component, or a component with no answers to list", () => {
    const text = open([{ pdfField: "Full Name", source: { kind: "component", componentId: "name" } }]);
    expect(text.valuesField("Full Name")).toBeUndefined();
    expect(text.sectionIds("Full Name")).toEqual(["mapping"]);

    const checkbox = open([{ pdfField: "Agree", source: { kind: "component", componentId: "working" } }]);
    expect(checkbox.valuesField("Agree")).toBeUndefined();

    const typed = open([{ pdfField: "Since", source: { kind: "path", path: "change" } }]);
    expect(typed.valuesField("Since")).toBeUndefined();
    expect(typed.sectionIds("Since")).toEqual(["mapping"]);

    const unmapped = open();
    expect(unmapped.valuesField("Since")).toBeUndefined();

    // A text box has no options of its own; one named by a data source has none to list at design time.
    expect(open([{ pdfField: "Since", source: { kind: "component", componentId: "name" } }]).valuesField("Since")).toBeUndefined();
    expect(open([{ pdfField: "Since", source: { kind: "component", componentId: "province" } }]).valuesField("Since")).toBeUndefined();
    // A component the form lacks.
    expect(open([{ pdfField: "Since", source: { kind: "component", componentId: "ghost" } }]).valuesField("Since")).toBeUndefined();
  });

  it("appears and goes as the source is chosen", () => {
    const { controller, valuesField, sectionIds } = open();
    const id = "widget_since";
    expect(valuesField("Since")).toBeUndefined();
    controller.setProperty(id, "source", { kind: "component", componentId: "change" });
    expect(valuesField("Since")).toBeDefined();
    controller.setProperty(id, "source.componentId", "name");
    expect(valuesField("Since")).toBeUndefined();
    controller.setProperty(id, "source.componentId", "change");
    controller.setProperty(id, "source.kind", "literal");
    expect(sectionIds("Since")).toEqual(["mapping"]);
    // The inspector repaints when the component changes: the field names it as what it depends on.
    controller.setProperty(id, "source", { kind: "component", componentId: "change" });
    expect(controller.inspectorModel(id)!.shapeDependsOn).toContain("source.componentId");
    controller.setProperty(id, "source.kind", "");
    expect(controller.inspectorModel(id)!.shapeDependsOn).toContain("source.componentId");
  });

  it("writes the map through the edit path: a row set, another, one back to Same value, all back; empty leaves no values key", () => {
    const { controller, current, valuesField } = open([since()]);
    const id = "widget_since";
    const edit = (key: string, target: string) => controller.setProperty(id, "values", valueMapWith(controller.getProperty(id, "values"), key, target));

    edit("improved", "1");
    expect(current().fields[0]).toEqual(since({ values: { improved: "1" } }));
    edit("worsened", "3");
    expect(current().fields[0]!.values).toEqual({ improved: "1", worsened: "3" });
    expect(valuesField("Since")!.valueMap!.rows.map((row) => row.target)).toEqual(["1", "", "3"]);

    edit("improved", "");
    expect(current().fields[0]!.values).toEqual({ worsened: "3" });
    edit("worsened", "");
    expect(current().fields[0]).toEqual(since());
    expect(current().fields[0]).not.toHaveProperty("values");
  });

  it("is one undo step per change, and Match by order is one step however many rows it fills", () => {
    const { controller, current, valuesField } = open([since()]);
    const id = "widget_since";
    controller.setProperty(id, "values", valueMapWith(undefined, "improved", "2"));
    expect(current().fields[0]!.values).toEqual({ improved: "2" });

    // The button writes the map the field offers, replacing what was there.
    controller.setProperty(id, "values", valuesField("Since")!.valueMap!.byOrder);
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
    controller.undo();
    expect(current().fields[0]!.values).toEqual({ improved: "2" });
    controller.undo();
    expect(current().fields[0]).toEqual(since());
    controller.redo();
    controller.redo();
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
  });

  it("lands a drafted map on Save as one step, and a Cancel leaves the layout alone", () => {
    const { controller, current } = open([since()]);
    const id = "widget_since";
    controller.select(id);
    controller.setDraftProperty(id, "values", { improved: "1" });
    controller.setDraftProperty(id, "values", { improved: "1", unchanged: "2" });
    expect(current().fields[0]).toEqual(since());
    expect(controller.commitDraft(id)).toBe(true);
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2" });
    controller.undo();
    expect(current().fields[0]).toEqual(since());
  });

  it("keeps a stored map across the tree while the section is drawn, and drops it once the section cannot show it", () => {
    const stored = { improved: "1", unchanged: "2", worsened: "3" };
    const { current, valuesField, controller } = open([since({ values: stored, checkedValue: "1" })]);
    expect(current().fields[0]).toEqual(since({ values: stored, checkedValue: "1" }));
    expect(valuesField("Since")!.valueMap!.rows.map((row) => row.target)).toEqual(["1", "2", "3"]);
    // Switched to a literal and saved: the layout carries no map the author cannot see.
    controller.setProperty("widget_since", "source", { kind: "literal", value: "x" });
    expect(valuesField("Since")).toBeUndefined();
    expect(current().fields[0]).toEqual(since({ source: { kind: "literal", value: "x" }, checkedValue: "1" }));
    // Every other kind of source drops it too; back on the component it is there again.
    for (const source of [{ kind: "path", path: "change" }, { kind: "expression", expression: "change" }, { kind: "template", text: "{{change}}" }] as const) {
      controller.setProperty("widget_since", "source", source);
      expect(current().fields[0]).not.toHaveProperty("values");
    }
    controller.setProperty("widget_since", "source", { kind: "component", componentId: "change" });
    expect(current().fields[0]!.values).toEqual(stored);
  });

  it("drops a stored map for a PDF field that is not a radio group, dropdown or list", () => {
    const text = open([{ pdfField: "Full Name", source: { kind: "component", componentId: "name" }, values: { a: "b" } }]);
    expect(text.current().fields[0]).toEqual({ pdfField: "Full Name", source: { kind: "component", componentId: "name" } });
    // A component whose options a data source supplies has no rows to draw, but its hand-written map is kept.
    const province = open([{ pdfField: "Prov", source: { kind: "component", componentId: "province" }, values: { ON: "On" } }]);
    expect(province.current().fields[0]!.values).toEqual({ ON: "On" });
  });

  it("drops an entry that is not text from a hand-written map, and the map when none is left", () => {
    const { current } = open([since({ values: { improved: "1", unchanged: 2 } as never })]);
    expect(current().fields[0]!.values).toEqual({ improved: "1" });
    const none = open([since({ values: { improved: 1 } as never })]);
    expect(none.current().fields[0]).toEqual(since());
  });

  it("says, under the section, which answers match no option and have no value; nothing when all do", () => {
    const { controller, noteMessages } = open([since()]);
    const id = "widget_since";
    expect(noteMessages("Since")).toEqual([expect.stringMatching(/"Improved", "Unchanged",? and "Worsened"/)]);
    controller.setProperty(id, "values", { improved: "1" });
    expect(noteMessages("Since")).toEqual([expect.stringMatching(/"Unchanged" and "Worsened"/)]);
    controller.setProperty(id, "values", { improved: "1", unchanged: "2", worsened: "3" });
    expect(noteMessages("Since")).toEqual([]);
    // An answer that is itself one of the PDF's options needs no entry.
    expect(open([{ pdfField: "Fit", source: { kind: "component", componentId: "yesno" } }]).noteMessages("Fit")).toEqual([]);
    // Nothing to say for a field the section is not drawn for.
    expect(open([{ pdfField: "Full Name", source: { kind: "component", componentId: "name" } }]).noteMessages("Full Name")).toEqual([]);
  });

  it("states the notice from the draft, as the map is edited, before Save", () => {
    const { controller, designer } = open([since()]);
    const id = "widget_since";
    controller.select(id);
    const messages = () => controller.notesOf(id).filter((note) => note.target === "values").map((note) => note.message);
    expect(messages()).toHaveLength(1);
    controller.setDraftProperty(id, "values", { improved: "1", unchanged: "2", worsened: "3" });
    expect(messages()).toEqual([]);
    controller.setDraftProperty(id, "values", { improved: "1" });
    expect(messages()).toHaveLength(1);
    expect(designer.layoutFrom(controller.snapshot()).fields[0]).toEqual(since());
  });

  it("is carried to an area by the layout, with no section of its own", () => {
    const designer = createPdfTemplateDesigner({
      layout: {
        id: "paper",
        kind: "template",
        template: TEMPLATE,
        fields: [],
        areas: [{ id: "area_1", page: 1, rect: { x: 1, y: 2, width: 30, height: 12 }, source: { kind: "component", componentId: "change" }, values: { improved: "1" }, checkedValue: "1" }]
      },
      inspection: INSPECTION,
      formRoot: FORM
    });
    expect(designer.layoutFrom(designer.builderOptions.initialRoot!).areas![0]).toMatchObject({ values: { improved: "1" }, checkedValue: "1" });
    const controller = new BuilderController();
    controller.setOptions(designer.builderOptions);
    expect(controller.inspectorModel("area_1")!.sections.flatMap((section) => section.fields).some((field) => field.control === "value-map")).toBe(false);
  });
});

describe("valueMapWith", () => {
  it("sets, replaces and removes one entry, keeping the others, and gives nothing for an empty map", () => {
    expect(valueMapWith(undefined, "a", "1")).toEqual({ a: "1" });
    expect(valueMapWith({ a: "1" }, "b", "2")).toEqual({ a: "1", b: "2" });
    expect(valueMapWith({ a: "1", b: "2" }, "a", "9")).toEqual({ a: "9", b: "2" });
    expect(valueMapWith({ a: "1", b: "2" }, "a", "")).toEqual({ b: "2" });
    expect(valueMapWith({ a: "1" }, "a", "")).toBeUndefined();
    expect(valueMapWith({ a: 1, b: null }, "c", "")).toBeUndefined();
    expect(valueMapWith([["a", "1"]], "b", "2")).toEqual({ b: "2" });
  });
});

describe("a section that hides itself when empty", () => {
  const field = (id: string) => ({ id, type: "text" as const, propertyPath: id, label: id, visibleWhen: { propertyPath: "kind", equals: "never" } });
  const node: ComponentNode = { id: "n", type: "demo", configuration: { kind: "other" } };
  const model = (hideWhenEmpty: boolean | undefined) =>
    buildInspectorModel(node, [], {
      mode: "replace",
      fields: [field("a")],
      sections: [{ id: "only", title: "Only", fieldIds: ["a"], ...(hideWhenEmpty !== undefined ? { hideWhenEmpty } : {}) }]
    });

  it("keeps the heading of an empty section by default, and drops it only for one that opted in", () => {
    expect(model(undefined).sections.map((section) => section.id)).toEqual(["only"]);
    expect(model(false).sections.map((section) => section.id)).toEqual(["only"]);
    expect(model(true).sections).toEqual([]);
  });
});

describe("staleValueMapEntries", () => {
  const rows = [{ value: "improved" }, { value: "unchanged" }];
  const map = (entries: Record<string, string>) => new Map(Object.entries(entries));

  it("names a key the source component no longer offers, in the map's order", () => {
    expect(staleValueMapEntries(map({ improved: "1", gone: "2", other: "3", unchanged: "2" }), rows, undefined)).toEqual({ keys: ["gone", "other"], targets: [], remove: ["gone", "other"] });
    expect(staleValueMapEntries(map({ improved: "1", unchanged: "2" }), rows, undefined)).toEqual({ keys: [], targets: [], remove: [] });
  });

  it("knows a checkbox's answers are true and false", () => {
    const yesNo = [{ value: "true" }, { value: "false" }];
    expect(staleValueMapEntries(map({ true: "1", false: "2" }), yesNo, ["1", "2"])).toEqual({ keys: [], targets: [], remove: [] });
    expect(staleValueMapEntries(map({ true: "1", maybe: "2" }), yesNo, undefined).keys).toEqual(["maybe"]);
  });

  it("never calls a key stale when the answers are not known at design time (a data source, free text)", () => {
    expect(staleValueMapEntries(map({ ON: "On", anything: "x" }), undefined, ["On"])).toEqual({ keys: [], targets: ["x"], remove: ["anything"] });
    expect(staleValueMapEntries(map({ ON: "On" }), undefined, undefined)).toEqual({ keys: [], targets: [], remove: [] });
    // Known and empty is not unknown: every entry is left over.
    expect(staleValueMapEntries(map({ a: "1" }), [], undefined).keys).toEqual(["a"]);
  });

  it("names a target the PDF field does not list, each once, and none while the PDF is not inspected", () => {
    expect(staleValueMapEntries(map({ improved: "1", unchanged: "9", other: "9" }), undefined, ["1", "2", "3"])).toEqual({ keys: [], targets: ["9"], remove: ["unchanged", "other"] });
    expect(staleValueMapEntries(map({ improved: "9" }), rows, undefined)).toEqual({ keys: [], targets: [], remove: [] });
  });

  it("reports a key and a target apart, and removes an entry once whichever way it is stale", () => {
    expect(staleValueMapEntries(map({ gone: "9", improved: "9", unchanged: "2" }), rows, ["1", "2"])).toEqual({ keys: ["gone"], targets: ["9"], remove: ["gone", "improved"] });
    expect(staleValueMapEntries(undefined, rows, ["1"])).toEqual({ keys: [], targets: [], remove: [] });
  });
});

describe("valueMapWithout", () => {
  it("drops the named entries, keeps the rest in order, and gives nothing for an empty map", () => {
    expect(valueMapWithout({ a: "1", b: "2", c: "3" }, ["b"])).toEqual({ a: "1", c: "3" });
    expect(valueMapWithout({ a: "1", b: 2 }, ["a"])).toBeUndefined();
    expect(valueMapWithout(undefined, ["a"])).toBeUndefined();
  });
});

describe("stale entries in a widget's Values section", () => {
  const stale = (extra: Record<string, string> = {}) => since({ values: { improved: "1", unchanged: "2", worsened: "3", ...extra } });
  const removeStale = (controller: BuilderController, valuesField: () => InspectorField | undefined, id: string) =>
    controller.setProperty(id, "values", valueMapWithout(controller.getProperty(id, "values"), valuesField()!.valueMap!.stale));

  it("says nothing about a map that matches the form and the PDF", () => {
    const { noteMessages, valuesField, designer, controller } = open([stale()]);
    expect(noteMessages("Since")).toEqual([]);
    expect(valuesField("Since")!.valueMap!.stale).toEqual([]);
    expect(designer.staleValueMapsOf(controller.snapshot())).toEqual([]);
    expect(designer.staleSummary(controller.snapshot())).toBeUndefined();
  });

  it("names the entries for options the form no longer has, and the targets the PDF does not list", () => {
    const { noteMessages, valuesField } = open([stale({ other: "1", renamed: "7" })]);
    expect(noteMessages("Since")).toEqual([
      'Entries for options this form no longer has: "other" and "renamed". They translate nothing now.',
      '"7" is not an export value of this PDF field, so the entry fills nothing.'
    ]);
    expect(valuesField("Since")!.valueMap!.stale).toEqual(["other", "renamed"]);
    // The rows are the form's answers, not the stale keys: those are in the note.
    expect(valuesField("Since")!.valueMap!.rows.map((row) => row.value)).toEqual(["improved", "unchanged", "worsened"]);
    // More than one stale target is said in the plural.
    expect(open([stale({ a: "7", b: "8" })]).noteMessages("Since").pop()).toBe('"7" and "8" are not export values of this PDF field, so their entries fill nothing.');
  });

  it("adds the stale notes to the not-matched notice, which stays", () => {
    const { noteMessages } = open([since({ values: { improved: "1", gone: "2" } })]);
    expect(noteMessages("Since")).toEqual([expect.stringMatching(/^Not matched to an option of this PDF field: "Unchanged" and "Worsened"/), expect.stringMatching(/"gone"/)]);
  });

  it("calls nothing stale for a component whose options come from a data source: its answers are unknown here", () => {
    const { noteMessages, valuesField, designer, controller } = open([{ pdfField: "Prov", source: { kind: "component", componentId: "province" }, values: { ON: "On", QC: "Zz" } }]);
    // No rows to draw: the section is not drawn (the map is hand-written JSON), so no note and no count.
    expect(valuesField("Prov")).toBeUndefined();
    expect(noteMessages("Prov")).toEqual([]);
    expect(designer.staleValueMapsOf(controller.snapshot())).toEqual([]);
  });

  it("is drawn with the leftover entries when every option was removed from the form", () => {
    const emptied: ComponentNode = { ...FORM, children: { content: [{ id: "change", type: "radio", configuration: { label: "Change", options: [] } }] } };
    const designer = createPdfTemplateDesigner({ layout: { id: "paper", kind: "template", template: TEMPLATE, fields: [since({ values: { improved: "1" } })] }, inspection: INSPECTION, formRoot: emptied });
    const controller = new BuilderController();
    controller.setOptions({ ...designer.builderOptions, notes: designer.notesFor, problems: designer.problemsFor });
    const field = controller.inspectorModel("widget_since")!.sections.flatMap((section) => section.fields).find((entry) => entry.control === "value-map");
    expect(field!.valueMap!.rows).toEqual([]);
    expect(field!.valueMap!.stale).toEqual(["improved"]);
  });

  it("removes exactly the stale entries as one undo step, and the map itself when none is left", () => {
    const { controller, current, valuesField } = open([stale({ other: "1", renamed: "7" })]);
    const id = "widget_since";
    removeStale(controller, () => valuesField("Since"), id);
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
    expect(valuesField("Since")!.valueMap!.stale).toEqual([]);
    controller.undo();
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3", other: "1", renamed: "7" });
    controller.redo();
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });

    // A map of nothing but stale entries leaves no values key.
    const only = open([since({ values: { gone: "1", also: "9" } })]);
    removeStale(only.controller, () => only.valuesField("Since"), id);
    expect(only.current().fields[0]).toEqual(since());
    expect(only.current().fields[0]).not.toHaveProperty("values");
  });

  it("removes through a draft too, landing on Save as one step", () => {
    const { controller, current, valuesField } = open([stale({ other: "1" })]);
    const id = "widget_since";
    controller.select(id);
    controller.setDraftProperty(id, "values", valueMapWithout(controller.draftProperty(id, "values"), valuesField("Since")!.valueMap!.stale));
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3", other: "1" });
    expect(controller.commitDraft(id)).toBe(true);
    expect(current().fields[0]!.values).toEqual({ improved: "1", unchanged: "2", worsened: "3" });
    controller.undo();
    expect(current().fields[0]!.values).toHaveProperty("other");
  });

  it("counts the layout's widgets with stale entries, naming them, and follows the draft", () => {
    const { designer, controller } = open([
      stale({ other: "1" }),
      { pdfField: "Fit", source: { kind: "component", componentId: "yesno" }, values: { "1": "1", "3": "2" } },
      { pdfField: "Prov", source: { kind: "component", componentId: "change" }, values: { improved: "On" } }
    ]);
    expect(designer.staleValueMapsOf(controller.snapshot())).toEqual([
      { widgetId: "widget_since", pdfField: "Since", keys: ["other"], targets: [], remove: ["other"] },
      { widgetId: "widget_fit", pdfField: "Fit", keys: ["3"], targets: [], remove: ["3"] }
    ]);
    expect(designer.staleSummary(controller.snapshot())).toBe('2 fields have value-map entries that no longer match: "Since" and "Fit".');
    controller.setProperty("widget_fit", "values", { "1": "1" });
    expect(designer.staleSummary(controller.snapshot())).toBe('1 field has value-map entries that no longer match: "Since".');
    // An unsaved draft shows on the preview the page viewer reads.
    controller.select("widget_since");
    controller.setDraftProperty("widget_since", "values", { improved: "1" });
    expect(designer.staleSummary(controller.previewSnapshot())).toBeUndefined();
    expect(designer.staleSummary(controller.snapshot())).toBe('1 field has value-map entries that no longer match: "Since".');
  });

  it("sees a template swapped for a PDF with other export values: the new inspection drives target staleness, none without one", () => {
    const layout: PdfTemplateLayout = { id: "paper", kind: "template", template: TEMPLATE, fields: [stale()] };
    const swapped: PdfTemplateInfo = { ...INSPECTION, fields: INSPECTION.fields.map((field) => (field.name === "Since" ? { ...field, options: ["A", "B", "C"] } : field)) };
    const summary = (inspection: PdfTemplateInfo | undefined) => {
      const designer = createPdfTemplateDesigner({ layout, inspection, formRoot: FORM });
      return designer.staleSummary(designer.builderOptions.initialRoot!);
    };
    expect(summary(INSPECTION)).toBeUndefined();
    expect(summary(swapped)).toBe('1 field has value-map entries that no longer match: "Since".');
    // No inspection yet (no executor): the mappings ride along and no target is called stale.
    expect(summary(undefined)).toBeUndefined();
    const designer = createPdfTemplateDesigner({ layout, inspection: swapped, formRoot: FORM });
    const controller = new BuilderController();
    controller.setOptions({ ...designer.builderOptions, notes: designer.notesFor });
    const notes = controller.notesOf("widget_since").filter((note) => note.target === "values").map((note) => note.message);
    expect(notes).toEqual([expect.stringMatching(/"1", "2", and "3" are not export values/)]);
  });
});
