import { describe, expect, it } from "vitest";

import {
  clampAreaRect,
  createTemplateMappingEditor,
  newAreaId,
  normalizeFieldName,
  suggestFieldMappings,
  templateFieldBoxesHtml,
  templateSchematicHtml
} from "../form-engine/builder/pdf-designer/template-mode.js";
import type { PdfTemplateFieldInfo, PdfTemplateInfo } from "../form-engine/render/pdf/pdf-abi.js";
import type { PdfBindableComponent } from "../form-engine/render/pdf/pdf-components.js";
import { escapeHtml } from "../form-engine/render/core/escape-html.js";

const FIELDS: PdfTemplateFieldInfo[] = [
  { name: "topmostSubform[0].Page1[0].Full_Name[0]", kind: "text", page: 1, rect: { x: 50, y: 700, width: 200, height: 20 }, readOnly: false, required: false },
  { name: "Country", kind: "dropdown", page: 1, rect: { x: 50, y: 660, width: 120, height: 20 }, options: ["Canada", "France"], readOnly: false, required: false },
  { name: "Subscribe", kind: "checkbox", page: 1, rect: { x: 50, y: 620, width: 14, height: 14 }, exportValues: ["Yes"], readOnly: false, required: false },
  { name: "Contact Method", kind: "radio", page: 2, rect: { x: 50, y: 600, width: 14, height: 14 }, exportValues: ["email", "phone"], readOnly: false, required: false },
  { name: "Print", kind: "button", page: 1, readOnly: false, required: false },
  { name: "Office.Received", kind: "text", page: 2, rect: { x: 50, y: 40, width: 100, height: 18 }, readOnly: true, required: false }
];

const INSPECTION: PdfTemplateInfo = {
  pageCount: 2,
  pages: [
    { index: 1, width: 612, height: 792 },
    { index: 2, width: 612, height: 792 }
  ],
  fields: FIELDS,
  hasXfa: false,
  encrypted: false
};

const COMPONENTS: PdfBindableComponent[] = [
  { id: "who", label: "Who", type: "panel", container: true },
  { id: "fullName", label: "Full name", type: "text", container: false },
  { id: "country", label: "Country of residence", type: "select", container: false },
  { id: "subscribe", label: "Subscribe to the newsletter", type: "checkbox", container: false },
  { id: "contactMethod", label: "Contact method", type: "radio", container: false },
  { id: "received", label: "Received", type: "date", container: false }
];

const TEMPLATE = { storage: "base64", name: "form.pdf", type: "application/pdf", size: 3, data: "AAA=" };

describe("template mode", () => {
  it("normalises field names down to their last segment, without indices, case or punctuation", () => {
    expect(normalizeFieldName("topmostSubform[0].Page1[0].Full_Name[0]")).toBe("fullname");
    expect(normalizeFieldName("Contact Method")).toBe("contactmethod");
    expect(normalizeFieldName("Office.Received")).toBe("received");
  });

  it("suggests mappings by id, then by label, with a checkbox's export value; never for buttons or containers", () => {
    const suggested = suggestFieldMappings(FIELDS, COMPONENTS);
    expect(suggested).toEqual([
      { pdfField: "topmostSubform[0].Page1[0].Full_Name[0]", source: { kind: "component", componentId: "fullName" } },
      { pdfField: "Country", source: { kind: "component", componentId: "country" } },
      { pdfField: "Subscribe", source: { kind: "component", componentId: "subscribe" }, checkedValue: "Yes" },
      // A radio group takes the answer as its option: no checked value, which would clear it on any other answer.
      { pdfField: "Contact Method", source: { kind: "component", componentId: "contactMethod" } },
      { pdfField: "Office.Received", source: { kind: "component", componentId: "received" } }
    ]);
  });

  it("edits mappings field by field, reports the unmapped and the stale, and builds the layout in template order", () => {
    const editor = createTemplateMappingEditor({
      layoutId: "paper",
      name: "Paper form",
      template: TEMPLATE,
      inspection: INSPECTION,
      fields: [
        { pdfField: "Country", source: { kind: "literal", value: "Canada" } },
        { pdfField: "Gone", source: { kind: "path", path: "old" } }
      ],
      options: { flatten: true }
    });
    expect(editor.rows().map((row) => [row.field.name, row.mapping?.source.kind])).toEqual([
      ["topmostSubform[0].Page1[0].Full_Name[0]", undefined],
      ["Country", "literal"],
      ["Subscribe", undefined],
      ["Contact Method", undefined],
      ["Print", undefined],
      ["Office.Received", undefined]
    ]);
    expect(editor.stale().map((mapping) => mapping.pdfField)).toEqual(["Gone"]);

    expect(editor.suggest(COMPONENTS)).toBe(4);
    editor.setSource("Subscribe", { kind: "template", text: "{{subscribe}}" });
    editor.setCheckedValue("Subscribe", "On");
    editor.setFormat("Office.Received", { kind: "date", pattern: "yyyy-MM-dd" });
    editor.setSource("Office.Received", undefined);
    editor.setOptions({ flatten: false, readOnly: true, appearances: "viewer" });
    expect(editor.unmapped().map((field) => field.name)).toEqual(["Print", "Office.Received"]);

    const layout = editor.layout();
    expect(layout.kind).toBe("template");
    expect(layout.id).toBe("paper");
    expect(layout.name).toBe("Paper form");
    expect(layout.template).toBe(TEMPLATE);
    expect(layout.options).toEqual({ flatten: false, readOnly: true, appearances: "viewer" });
    expect(layout.fields).toEqual([
      { pdfField: "topmostSubform[0].Page1[0].Full_Name[0]", source: { kind: "component", componentId: "fullName" } },
      { pdfField: "Country", source: { kind: "literal", value: "Canada" } },
      { pdfField: "Subscribe", source: { kind: "template", text: "{{subscribe}}" }, checkedValue: "On" },
      { pdfField: "Contact Method", source: { kind: "component", componentId: "contactMethod" } }
    ]);
    // The layout is a copy: editing on is not editing what was handed out.
    editor.setSource("Country", undefined);
    expect(layout.fields.length).toBe(4);

    // The archival profile rides along the same way, and only when set.
    expect(layout.conformance).toBeUndefined();
    editor.setConformance({ pdfa: "3b", attachData: true, attachment: { name: "answers.json" } });
    expect(editor.conformance()).toEqual({ pdfa: "3b", attachData: true, attachment: { name: "answers.json" } });
    expect(editor.layout().conformance).toEqual({ pdfa: "3b", attachData: true, attachment: { name: "answers.json" } });
    editor.setConformance(undefined);
    expect(editor.layout().conformance).toBeUndefined();
    expect(editor.layout().fields.length).toBe(3);
  });

  it("names the template signature field the server seals, and keeps the rest of the block", () => {
    const fields: PdfTemplateFieldInfo[] = [...FIELDS, { name: "OfficerSignature", kind: "signature", page: 2, rect: { x: 50, y: 80, width: 180, height: 40 }, readOnly: false, required: false, signed: false }];
    const editor = createTemplateMappingEditor({ layoutId: "gov", template: TEMPLATE, inspection: { ...INSPECTION, fields }, signature: { certify: "noChanges" } });
    expect(editor.signature()).toEqual({ certify: "noChanges" });
    expect(editor.layout().signature).toEqual({ certify: "noChanges" });
    editor.setSignatureField("OfficerSignature");
    expect(editor.layout().signature).toEqual({ certify: "noChanges", field: "OfficerSignature" });
    editor.setSignatureField(undefined);
    expect(editor.layout().signature).toEqual({ certify: "noChanges" });
    editor.setSignature(undefined);
    editor.setSignatureField("OfficerSignature");
    expect(editor.layout().signature).toEqual({ field: "OfficerSignature" });
    editor.setSignatureField("");
    expect(editor.layout().signature).toBeUndefined();
    // A signature row is still a row, so the table lists it.
    expect(editor.rows().map((row) => row.field.name)).toContain("OfficerSignature");
  });

  it("draws one page per inspected page and one flipped box per placed field", () => {
    const html = templateSchematicHtml(INSPECTION, { escape: escapeHtml, mapped: new Set(["Country"]) });
    expect(html.match(/<svg /g)?.length).toBe(2);
    expect(html).toContain('viewBox="0 0 612 792"');
    // y from the top: 792 − 700 − 20 = 72.
    expect(html).toContain('data-field="topmostSubform[0].Page1[0].Full_Name[0]" x="50.00" y="72.00" width="200.00" height="20.00"');
    expect(html).toContain('class="datum-pdf-schematic__field datum-pdf-schematic__field--mapped" data-field="Country"');
    expect(html).not.toContain('data-field="Print"');
    expect(html).toContain("<title>Country (dropdown)</title>");
    // One page's boxes on their own, for a viewer that draws the sheet itself.
    const second = templateFieldBoxesHtml(INSPECTION, 2, { escape: escapeHtml });
    expect(second).toContain('data-field="Contact Method"');
    expect(second).toContain('data-field="Office.Received"');
    expect(second).not.toContain('data-field="Country"');
    expect(templateFieldBoxesHtml(INSPECTION, 3, { escape: escapeHtml })).toBe("");
  });

  it("adds, edits and removes areas, keeps them on the page, and puts them on the layout only when there are any", () => {
    const editor = createTemplateMappingEditor({ layoutId: "paper", template: TEMPLATE, inspection: { ...INSPECTION, fields: [] } });
    expect(editor.areas()).toEqual([]);
    expect(editor.layout()).not.toHaveProperty("areas");

    const first = editor.addArea({ page: 1, rect: { x: 60.004, y: 40, width: 200, height: 14 } });
    expect(first).toEqual({ id: "area_1", page: 1, rect: { x: 60, y: 40, width: 200, height: 14 }, source: { kind: "literal", value: null } });
    const second = editor.addArea({ page: 2, rect: { x: 600, y: 780, width: 50, height: 50 }, label: "Tick", source: { kind: "component", componentId: "subscribe" }, draw: { kind: "check" } });
    // Clamped onto the page: 612 wide, 792 tall.
    expect(second).toEqual({ id: "area_2", label: "Tick", page: 2, rect: { x: 562, y: 742, width: 50, height: 50 }, source: { kind: "component", componentId: "subscribe" }, draw: { kind: "check" } });
    expect(editor.areas().map((area) => area.id)).toEqual(["area_1", "area_2"]);

    editor.setAreaSource("area_1", { kind: "template", text: "{{fullName}}" });
    editor.setAreaCheckedValue("area_2", "Yes");
    editor.updateArea("area_1", { label: "Name", rect: { x: -5, width: 700 }, draw: { align: "end", bold: true } });
    editor.updateArea("area_1", { draw: { bold: undefined }, format: { kind: "text" } });
    expect(editor.area("area_1")).toEqual({
      id: "area_1",
      label: "Name",
      page: 1,
      rect: { x: 0, y: 40, width: 612, height: 14 },
      source: { kind: "template", text: "{{fullName}}" },
      draw: { align: "end" },
      format: { kind: "text" }
    });
    editor.updateArea("area_1", { label: "", draw: { align: undefined }, format: undefined });
    expect(editor.area("area_1")).toEqual({ id: "area_1", page: 1, rect: { x: 0, y: 40, width: 612, height: 14 }, source: { kind: "template", text: "{{fullName}}" } });
    expect(editor.area("area_2")?.checkedValue).toBe("Yes");
    editor.setAreaCheckedValue("area_2", "");
    expect(editor.area("area_2")).not.toHaveProperty("checkedValue");

    // Copies out, so an edit on what was handed back changes nothing.
    editor.area("area_2")!.rect.x = 1;
    expect(editor.area("area_2")!.rect.x).toBe(562);

    editor.updateArea("area_2", { page: 9 });
    expect(editor.unplacedAreas().map((area) => area.id)).toEqual(["area_2"]);
    expect(editor.layout().areas).toEqual(editor.areas());
    expect(editor.layout().fields).toEqual([]);

    editor.removeArea("area_1");
    expect(editor.addArea({ page: 1, rect: { x: 0, y: 0, width: 10, height: 10 } }).id).toBe("area_1");
    editor.removeArea("area_1");
    editor.removeArea("area_2");
    editor.removeArea("nothing");
    expect(editor.layout()).not.toHaveProperty("areas");

    // Seeded from a layout, the areas come back as they were.
    const seeded = createTemplateMappingEditor({ layoutId: "paper", template: TEMPLATE, inspection: INSPECTION, areas: [second] });
    expect(seeded.areas()).toEqual([second]);
    expect(newAreaId(["area_1", "area_3"])).toBe("area_2");
  });

  it("makes an area a fillable field and back, keeping only the field choices that differ from the defaults", () => {
    const editor = createTemplateMappingEditor({ layoutId: "paper", template: TEMPLATE, inspection: { ...INSPECTION, fields: [] } });
    const area = editor.addArea({ page: 1, rect: { x: 10, y: 10, width: 100, height: 14 } });
    expect(editor.area(area.id)).not.toHaveProperty("field");
    editor.updateArea(area.id, { field: {} });
    expect(editor.area(area.id)?.field).toEqual({});
    editor.updateArea(area.id, { field: { name: "applicant", required: true, tooltip: "Your name" } });
    editor.updateArea(area.id, { field: { readOnly: true } });
    expect(editor.area(area.id)?.field).toEqual({ name: "applicant", required: true, readOnly: true, tooltip: "Your name" });
    // Cleared or unticked choices leave; the field stays.
    editor.updateArea(area.id, { field: { name: "", required: false, readOnly: undefined, tooltip: "" } });
    expect(editor.area(area.id)?.field).toEqual({});
    expect(editor.layout().areas?.[0]?.field).toEqual({});
    editor.updateArea(area.id, { field: null });
    expect(editor.area(area.id)).not.toHaveProperty("field");
    // Seeded from a layout, the field block comes back as it was, as a copy.
    const seeded = createTemplateMappingEditor({ layoutId: "paper", template: TEMPLATE, inspection: INSPECTION, areas: [{ ...area, field: { name: "x" } }] });
    const copy = seeded.area(area.id)!;
    copy.field!.name = "changed";
    expect(seeded.area(area.id)?.field).toEqual({ name: "x" });
  });

  it("clamps a rectangle onto the page, no smaller than the floor, rounded to a hundredth", () => {
    const page = { width: 612, height: 792 };
    expect(clampAreaRect({ x: 10.004, y: 20.006, width: 100, height: 14 }, page)).toEqual({ x: 10, y: 20.01, width: 100, height: 14 });
    expect(clampAreaRect({ x: 600, y: 700, width: 100, height: 200 }, page)).toEqual({ x: 512, y: 592, width: 100, height: 200 });
    expect(clampAreaRect({ x: -10, y: -10, width: 1, height: 1 }, page)).toEqual({ x: 0, y: 0, width: 4, height: 4 });
    expect(clampAreaRect({ x: 0, y: 0, width: 1, height: 1 }, page, 0)).toEqual({ x: 0, y: 0, width: 1, height: 1 });
    expect(clampAreaRect({ x: 0, y: 0, width: 9999, height: 9999 }, page)).toEqual({ x: 0, y: 0, width: 612, height: 792 });
  });
});
