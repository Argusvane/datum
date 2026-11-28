// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { createPdfBuilderMode } from "../form-engine/builder/pdf-designer/pdf-builder-mode.js";
import type { PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { RenderableRuntime } from "../form-engine/render/core/runtime-render-bridge.js";
import type { PdfRenderProvider } from "../form-engine/render/pdf/pdf-provider.js";

/**
 * A PDF layout's sources and condition follow a component's rename inside the rename's own step
 * of the form's history: one Undo puts the id and the layout back together.
 */

const FORM: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: { content: [{ id: "phone", type: "text", configuration: { label: "Phone" } }] }
};

function setUp() {
  const form = new BuilderController({ initialRoot: structuredClone(FORM) });
  const layout: PdfTemplateLayout = {
    id: "paper",
    kind: "template",
    template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" },
    fields: [{ pdfField: "Phone", source: { kind: "path", path: "phone" } }],
    when: 'phone != ""'
  } as PdfTemplateLayout;
  const provider = { id: "fake", abiVersion: "1.0.0", inspect: async () => ({}), render: async () => ({}) } as unknown as PdfRenderProvider;
  const mode = createPdfBuilderMode({ formRoot: () => structuredClone(form.snapshot()), form: () => form, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout], defaultLayoutId: "paper" }, support: { provider } });
  // As the shell wires it: a rename on the form's change event reaches the mode.
  form.on("change", (event) => {
    if (event.renamed) {
      mode.formRenamed?.(event.renamed);
    }
  });
  const paper = (): PdfTemplateLayout => mode.pdfConfiguration.layouts![0] as PdfTemplateLayout;
  return { form, paper };
}

describe("a rename's PDF follow-up is part of the rename's step", () => {
  it("undo puts back the id, the source and the condition at once, and redo renames them all again", () => {
    const { form, paper } = setUp();
    form.renameId("phone", "tel");
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "tel" });
    expect(JSON.stringify(paper().when)).toContain("tel");
    form.undo();
    expect(form.snapshot().children?.content?.[0]?.id).toBe("phone");
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "phone" });
    expect(JSON.stringify(paper().when)).toContain("phone");
    expect(form.canUndo()).toBe(false);
    form.redo();
    expect(form.snapshot().children?.content?.[0]?.id).toBe("tel");
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "tel" });
  });
});

describe("a data key edit's PDF follow-up", () => {
  it("moves the path sources with the data, inside the edit's step", () => {
    const form = new BuilderController({
      initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "phone", type: "text", configuration: { label: "Phone" } }] } }
    });
    const layout: PdfTemplateLayout = {
      id: "paper",
      kind: "template",
      template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" },
      fields: [{ pdfField: "Phone", source: { kind: "path", path: "phone" } }],
      when: 'phone != ""'
    } as PdfTemplateLayout;
    const provider = { id: "fake", abiVersion: "1.0.0", inspect: async () => ({}), render: async () => ({}) } as unknown as PdfRenderProvider;
    const mode = createPdfBuilderMode({ formRoot: () => structuredClone(form.snapshot()), form: () => form, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout], defaultLayoutId: "paper" }, support: { provider } });
    form.on("change", (event) => {
      // As the shell does: a mode's rewrite is a part of the step, so an Undo or a Redo already carries it.
      if (event.dataMoved && !event.historyStep) {
        mode.formDataMoved(event.dataMoved);
      }
    });
    const paper = (): PdfTemplateLayout => mode.pdfConfiguration.layouts![0] as PdfTemplateLayout;
    form.setProperty("phone", "dataKey", "tel");
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "tel" });
    // The condition reads the component by its id, which did not change.
    expect(paper().when).toBe('phone != ""');
    form.undo();
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "phone" });
    expect(form.getProperty("phone", "dataKey")).toBeUndefined();
    expect(form.canUndo()).toBe(false);
  });

  it("applies the moves of one edit as one map: two keys swapped send each source to its own field's data", () => {
    const form = new BuilderController({
      initialRoot: {
        id: "root",
        type: "form",
        configuration: {},
        children: {
          content: [
            { id: "phone", type: "text", configuration: { label: "Phone" } },
            { id: "fax", type: "text", configuration: { label: "Fax" } }
          ]
        }
      }
    });
    const layout: PdfTemplateLayout = {
      id: "paper",
      kind: "template",
      template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" },
      fields: [
        { pdfField: "Phone", source: { kind: "path", path: "phone" } },
        { pdfField: "Fax", source: { kind: "path", path: "fax" } }
      ]
    } as PdfTemplateLayout;
    const provider = { id: "fake", abiVersion: "1.0.0", inspect: async () => ({}), render: async () => ({}) } as unknown as PdfRenderProvider;
    const mode = createPdfBuilderMode({ formRoot: () => structuredClone(form.snapshot()), form: () => form, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout], defaultLayoutId: "paper" }, support: { provider } });
    form.on("change", (event) => {
      // As the shell does: a mode's rewrite is a part of the step, so an Undo or a Redo already carries it.
      if (event.dataMoved && !event.historyStep) {
        mode.formDataMoved(event.dataMoved);
      }
    });
    const paper = (): PdfTemplateLayout => mode.pdfConfiguration.layouts![0] as PdfTemplateLayout;
    form.setProperties([
      { componentId: "phone", propertyPath: "dataKey", value: "fax" },
      { componentId: "fax", propertyPath: "dataKey", value: "phone" }
    ]);
    expect(paper().fields.map((field) => field.source)).toEqual([
      { kind: "path", path: "fax" },
      { kind: "path", path: "phone" }
    ]);
    form.undo();
    expect(paper().fields.map((field) => field.source)).toEqual([
      { kind: "path", path: "phone" },
      { kind: "path", path: "fax" }
    ]);
  });

  it("a Save with a new id and a new data key: the sources land on the new key once, and one Undo puts them back", () => {
    const { form, paper, mode } = setUpBoth();
    form.select("phone");
    form.setDraftId("phone", "tel");
    form.setDraftProperty("phone", "dataKey", "telephone");
    expect(form.commitDraft("phone")).toBe(true);
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "telephone" });
    form.undo();
    expect(paper().fields[0]?.source).toEqual({ kind: "path", path: "phone" });
    expect(form.snapshot().children?.content?.[0]?.id).toBe("phone");
    expect(form.canUndo()).toBe(false);
    expect(mode.pdfConfiguration.layouts).toHaveLength(1);
  });
});

/** As the shell wires both: a rename, then the moves its Save made past the id. */
function setUpBoth() {
  const form = new BuilderController({ initialRoot: structuredClone(FORM) });
  const layout: PdfTemplateLayout = {
    id: "paper",
    kind: "template",
    template: { storage: "base64", name: "paper.pdf", type: "application/pdf", size: 3, data: "AAA=" },
    fields: [{ pdfField: "Phone", source: { kind: "path", path: "phone" } }]
  } as PdfTemplateLayout;
  const provider = { id: "fake", abiVersion: "1.0.0", inspect: async () => ({}), render: async () => ({}) } as unknown as PdfRenderProvider;
  const mode = createPdfBuilderMode({ formRoot: () => structuredClone(form.snapshot()), form: () => form, runtime: () => ({}) as RenderableRuntime, pdf: { layouts: [layout], defaultLayoutId: "paper" }, support: { provider } });
  form.on("change", (event) => {
    if (event.renamed) {
      mode.formRenamed?.(event.renamed);
    }
    // As the shell does: a mode's rewrite is a part of the step, so an Undo or a Redo already carries it.
    if (event.dataMoved && !event.historyStep) {
      mode.formDataMoved(event.dataMoved);
    }
  });
  const paper = (): PdfTemplateLayout => mode.pdfConfiguration.layouts![0] as PdfTemplateLayout;
  return { form, paper, mode };
}
