import { describe, expect, it } from "vitest";

import { PDF_DOCUMENT_COMPONENT_TYPE, type PdfConfiguration, type PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import { duplicatePdfLayout, movePdfLayout, removePdfLayout, setDefaultPdfLayout } from "../form-engine/builder/pdf-designer/layout-catalog.js";
import { PdfModeModel } from "../form-engine/builder/pdf-designer/pdf-mode-model.js";

/** The catalog edits values, not the block's shape; the mode model tells which declared layouts it left out, and opens a layout without writing it. */

function layout(id: string, name: string, rootConfiguration: Record<string, unknown> = {}): PdfGeneratedLayout {
  return {
    id,
    kind: "generated",
    name,
    root: { id: "document", type: PDF_DOCUMENT_COMPONENT_TYPE, configuration: rootConfiguration, children: { body: [], header: [], footer: [] } }
  };
}

const form = { id: "root", type: "form", configuration: {}, children: { content: [] } };

describe("the layout catalog's shape", () => {
  it("keeps the block's keys where they were", () => {
    const configuration: PdfConfiguration = { defaultLayoutId: "b", layouts: [layout("a", "A"), layout("b", "B")] };
    expect(Object.keys(setDefaultPdfLayout(configuration, "a"))).toEqual(["defaultLayoutId", "layouts"]);
    expect(Object.keys(movePdfLayout(configuration, "b", 0))).toEqual(["defaultLayoutId", "layouts"]);
    expect(Object.keys(removePdfLayout(configuration, "a"))).toEqual(["defaultLayoutId", "layouts"]);
    // No default before, none after a change that names none.
    expect(removePdfLayout({ layouts: [layout("a", "A"), layout("b", "B")] }, "a")).not.toHaveProperty("defaultLayoutId");
  });

  it("names the copy at its top level and copies the original's root as it is", () => {
    const configuration: PdfConfiguration = { layouts: [layout("a", "Letter", { page: { size: "A4" } }), layout("b", "Plain")] };
    const copied = duplicatePdfLayout(configuration, "a");
    expect(copied.layout.name).toBe("Letter (copy)");
    expect((copied.layout as PdfGeneratedLayout).root.configuration).toEqual({ page: { size: "A4" } });
    expect((duplicatePdfLayout(configuration, "b").layout as PdfGeneratedLayout).root.configuration).toEqual({});
  });
});

describe("PdfModeModel", () => {
  it("says which declared layouts the first seed and a reseed left out, and why", () => {
    const broken = { id: "paper", kind: "template", template: { storage: "base64" }, fields: [] };
    const model = new PdfModeModel({ root: form, pdf: { layouts: [layout("a", "A"), broken as never, { kind: "generated" } as never] } });
    expect(model.layouts.map((entry) => entry.id)).toEqual(["a"]);
    expect(model.unusable).toHaveLength(2);
    expect(model.unusable[0]).toMatch(/^paper: /);
    expect(model.unusable[1]).toMatch(/^#3: layout\.id is required/);
    expect(model.reseed({ root: form, pdf: { layouts: [layout("a", "A")] } })).toBe(0);
    expect(model.unusable).toEqual([]);
  });

  it("opens a layout without writing it: the configuration stays the object it was, and the page stays on it", () => {
    const configuration: PdfConfiguration = { layouts: [layout("a", "A"), layout("b", "B")] };
    const model = new PdfModeModel({ root: form, pdf: configuration });
    const seeded = model.configuration;
    model.keepShown("a");
    model.replaceQuietly("a", JSON.parse(JSON.stringify(seeded.layouts![0])), { declareDefault: false });
    expect(model.configuration).toBe(seeded);
    // Pinned: a new default does not move the page from under the open designer.
    model.apply(setDefaultPdfLayout(model.configuration, "b"));
    expect(model.selected()?.id).toBe("a");
  });
});
