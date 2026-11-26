import { describe, expect, it } from "vitest";

import { movePdfLayout } from "../form-engine/builder/pdf-designer/layout-catalog.js";
import { PdfModeModel, seededPdfConfiguration } from "../form-engine/builder/pdf-designer/pdf-mode-model.js";
import { PDF_DOCUMENT_COMPONENT_TYPE, type PdfGeneratedLayout, type PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Customer Intake" },
  children: { content: [{ id: "fullName", type: "text", configuration: { label: "Full name" } }] }
};

function generated(id: string, name?: string, body: ComponentNode[] = []): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    ...(name !== undefined ? { name } : {}),
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body, header: [], footer: [] } }
  };
}

const PAPER: PdfTemplateLayout = {
  id: "paper",
  kind: "template",
  name: "Paper form",
  template: { storage: "url", name: "paper.pdf", type: "application/pdf", size: 10, ref: "/paper.pdf" },
  fields: []
};

describe("seededPdfConfiguration", () => {
  it("keeps the declared layouts, drops unusable ones, and derives none for a form that declares none", () => {
    const declared = seededPdfConfiguration({ pdf: { layouts: [generated("client"), PAPER], defaultLayoutId: "paper" }, root: FORM });
    expect(declared.configuration.layouts?.map((layout) => layout.id)).toEqual(["client", "paper"]);
    expect(declared.configuration.defaultLayoutId).toBe("paper");
    expect(declared.dropped).toBe(0);

    const broken = seededPdfConfiguration({ pdf: { layouts: [generated("client"), { id: "bad", kind: "template" } as unknown as PdfTemplateLayout] }, root: FORM });
    expect(broken.configuration.layouts?.map((layout) => layout.id)).toEqual(["client"]);
    expect(broken.dropped).toBe(1);

    // A `when` the evaluator cannot run makes no layout unusable: it is
    // kept, so the next catalog change does not write the pdf block back without it.
    const odd = { ...generated("odd"), when: "x" } as unknown as PdfGeneratedLayout;
    const kept = seededPdfConfiguration({ pdf: { layouts: [generated("client"), odd] }, root: FORM });
    expect(kept.dropped).toBe(0);
    expect(kept.configuration.layouts?.[1]).toEqual(odd);

    // Nothing is written into the definition for the author: a host prints such a form from the form.
    const none = seededPdfConfiguration({ root: FORM });
    expect(none.configuration).toEqual({ layouts: [] });
    expect(none.dropped).toBe(0);
    const empty = new PdfModeModel({ root: FORM });
    expect(empty.selected()).toBeUndefined();
    expect(empty.defaultId).toBeUndefined();
  });
});

describe("PdfModeModel", () => {
  it("puts the chosen layout on the page, else the default, else the first", () => {
    const model = new PdfModeModel({ pdf: { layouts: [generated("client"), PAPER], defaultLayoutId: "paper" }, root: FORM });
    expect(model.selected()?.id).toBe("paper");
    model.layoutId = "client";
    expect(model.selected()?.id).toBe("client");
    model.layoutId = "gone";
    expect(model.selected()?.id).toBe("paper");
    expect(() => model.require("gone")).toThrow(/No PDF layout/);
    expect(model.defaultId).toBe("paper");
  });

  it("says what a change means for the designer: a move or a changed tree rebuilds, a rename does not", () => {
    const model = new PdfModeModel({ pdf: { layouts: [generated("client", "Client"), PAPER] }, root: FORM }, "client");

    // The page moves: rebuild.
    const moved = model.apply(model.configuration, "paper");
    expect(moved).toMatchObject({ before: { id: "client" }, after: { id: "paper" }, rebuild: true, renamed: false });

    // Back on the custom layout, its name changes under the same id: the open tree takes it, no rebuild.
    model.apply(model.configuration, "client");
    const renamed = model.apply({ ...model.configuration, layouts: [generated("client", "Client copy"), PAPER] });
    expect(renamed).toMatchObject({ rebuild: false, renamed: true });

    // Its tree changes underneath the designer: rebuild.
    const changed = model.apply({
      ...model.configuration,
      layouts: [generated("client", "Client copy", [{ id: "t", type: "pdf-text", configuration: { text: "Hello" } }]), PAPER]
    });
    expect(changed).toMatchObject({ rebuild: true, renamed: false });

    // The same template layout given a new mapping: its tree is edited on the page,
    // so a mapping changed underneath it rebuilds; a rename alone does not, as for a custom layout.
    model.apply(model.configuration, "paper");
    const remapped = model.apply({ ...model.configuration, layouts: [model.layouts[0]!, { ...PAPER, fields: [{ pdfField: "Name", source: { kind: "component", componentId: "fullName" } }] }] });
    expect(remapped).toMatchObject({ rebuild: true, renamed: false });
    expect(remapped.after).not.toBe(remapped.before);
    const paperRenamed = model.apply({ ...model.configuration, layouts: [model.layouts[0]!, { ...model.layouts[1]!, name: "Paper, renamed" }] });
    expect(paperRenamed).toMatchObject({ rebuild: false, renamed: true });
  });

  it("keeps the page on the layout it shows once a designer holds it", () => {
    const quebec = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } } as const;
    // Opened with nothing chosen: the page is the first layout, the default for want of one.
    const model = new PdfModeModel({ pdf: { layouts: [generated("client"), PAPER] }, root: FORM });
    expect(model.layoutId).toBeUndefined();
    expect(model.selected()?.id).toBe("client");

    // The designer's edit gives it a condition: the catalog now declares its default, and
    // the page — and so the controller, panels and `ready` — stays on the layout it showed.
    model.replaceQuietly("client", { ...generated("client"), when: quebec });
    expect(model.configuration.defaultLayoutId).toBe("client");
    expect(model.layoutId).toBe("client");
    // Another layout made the default no longer moves the page from under the open designer.
    const result = model.apply({ ...model.configuration, defaultLayoutId: "paper" });
    expect(result).toMatchObject({ before: { id: "client" }, after: { id: "client" }, rebuild: false });

    // Pinned only, not chosen: another definition starts over at its default.
    model.reseed({ pdf: { layouts: [generated("client"), PAPER], defaultLayoutId: "paper" }, root: FORM });
    expect(model.selected()?.id).toBe("paper");
    // A layout the person chose survives another definition that still has it.
    model.layoutId = "client";
    model.reseed({ pdf: { layouts: [generated("client"), PAPER], defaultLayoutId: "paper" }, root: FORM });
    expect(model.selected()?.id).toBe("client");
  });

  it("takes a built designer's layout back without declaring a default the definition lacks", () => {
    const quebec = { kind: "binary", operator: "eq", left: { kind: "path", path: "province" }, right: { kind: "literal", value: "QC" } } as const;
    const model = new PdfModeModel({ pdf: { layouts: [{ ...generated("client"), when: quebec }, PAPER] }, root: FORM });
    // Opening the layout: the designer's seeding comes back, and the definition keeps its shape.
    model.replaceQuietly("client", { ...generated("client", "Client"), when: quebec }, { declareDefault: false });
    expect(model.configuration).not.toHaveProperty("defaultLayoutId");
    expect(model.layouts[0]?.name).toBe("Client");
    // The author's edit through the same door writes it down.
    model.replaceQuietly("client", { ...generated("client", "Client copy"), when: quebec });
    expect(model.configuration.defaultLayoutId).toBe("client");
  });

  it("pins the shown layout on request, and leaves a chosen one as it is", () => {
    const model = new PdfModeModel({ pdf: { layouts: [generated("client"), PAPER], defaultLayoutId: "paper" }, root: FORM });
    expect(model.pinShown()).toBe("paper");
    model.apply({ ...model.configuration, defaultLayoutId: "client" });
    expect(model.selected()?.id).toBe("paper");
    model.layoutId = "client";
    expect(model.pinShown()).toBe("client");
    // A chosen id the catalog lost is replaced by what the page shows.
    model.layoutId = "gone";
    expect(model.pinShown()).toBe("client");
  });

  it("moves a layout without moving the page or rebuilding its designer", () => {
    const model = new PdfModeModel({ pdf: { layouts: [generated("client"), generated("office"), PAPER] }, root: FORM });
    // Nothing chosen: the page is the first layout, for want of a declared default.
    expect(model.selected()?.id).toBe("client");
    const result = model.apply(movePdfLayout(model.configuration, "client", 2));
    expect(model.layouts.map((layout) => layout.id)).toEqual(["office", "paper", "client"]);
    // The move wrote the default down, so the page did not follow the new first layout.
    expect(model.configuration.defaultLayoutId).toBe("client");
    expect(result).toMatchObject({ before: { id: "client" }, after: { id: "client" }, rebuild: false, renamed: false });
    // The layout on the page moved elsewhere in the list: still no rebuild.
    model.layoutId = "paper";
    expect(model.apply(movePdfLayout(model.configuration, "paper", 0))).toMatchObject({ after: { id: "paper" }, rebuild: false });
  });

  it("takes the designer's own edit quietly and reseeds on another definition", () => {
    const model = new PdfModeModel({ pdf: { layouts: [generated("client")] }, root: FORM }, "client");
    model.replaceQuietly("client", generated("client", "Named"));
    expect(model.layouts[0]?.name).toBe("Named");
    expect(() => model.replaceQuietly("missing", generated("x"))).toThrow(/No PDF layout/);
    expect(model.reseed({ root: FORM })).toBe(0);
    expect(model.layouts).toEqual([]);
    expect(model.selected()).toBeUndefined();
  });
});

describe("PdfModeModel after structural edits", () => {
  const gen = (id: string): PdfGeneratedLayout => ({
    id,
    kind: "generated",
    name: id,
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: {}, children: { body: [], header: [], footer: [] } }
  });

  it("removing the page's layout moves the page to a layout that exists", () => {
    const m = new PdfModeModel({ pdf: { layouts: [gen("a"), gen("b")] }, root: FORM }, "a");
    m.apply({ layouts: [gen("b")] });
    expect(m.selected()?.id).toBe("b");
  });

  it("removing the declared default falls back to the first", () => {
    const m = new PdfModeModel({ pdf: { layouts: [gen("a"), gen("b")], defaultLayoutId: "b" }, root: FORM });
    m.apply({ layouts: [gen("a")], defaultLayoutId: "b" });
    expect(m.defaultId).toBe("a");
  });
});
