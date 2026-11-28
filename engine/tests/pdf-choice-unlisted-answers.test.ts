import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, type PdfBlock, type PdfDocument } from "../form-engine/render/pdf/pdf-document.js";

function state(values: Record<string, unknown>): FormState {
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

function form(content: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: { title: "T" }, children: { content } };
}

function layout(body: ComponentNode[]) {
  return { id: "l", kind: "generated" as const, root: { id: "d", type: "pdf-document", configuration: {}, children: { body } } };
}

function blocksOf(document: PdfDocument | undefined): PdfBlock[] {
  const out: PdfBlock[] = [];
  walkPdfBlocks(document?.blocks ?? [], (block) => out.push(block));
  return out;
}

const none: DataSourceResolver = { resolveDataSource: async () => undefined };
const failing: DataSourceResolver = {
  resolveDataSource: async () => {
    throw new Error("upstream 503");
  }
};

const choices: ComponentNode[] = [
  { id: "pets", type: "checkboxes", configuration: { label: "Pets", options: [{ value: "cat", label: "Cat" }, { value: "dog", label: "Dog" }] } },
  { id: "colour", type: "radio", configuration: { label: "Colour", options: [{ value: "red", label: "Red" }] } },
  { id: "size", type: "select", configuration: { label: "Size", options: [{ value: "s", label: "Small" }] } }
];

describe("a stored choice answer no option lists", () => {
  it("prints in the checklist as a chosen item labelled by its value", async () => {
    const model = await buildPdfRenderModel(form(choices), state({ pets: ["fish", "cat"], colour: "blue" }), none);
    const checklists = blocksOf(model.document).filter((block): block is Extract<PdfBlock, { kind: "checklist" }> => block.kind === "checklist");
    expect(checklists.find((block) => block.componentId === "pets")?.items).toEqual([
      { label: "Cat", checked: true },
      { label: "Dog", checked: false },
      { label: "fish", checked: true }
    ]);
    expect(checklists.find((block) => block.componentId === "colour")?.items).toEqual([
      { label: "Red", checked: false },
      { label: "blue", checked: true }
    ]);
  });

  it("prints every answer when the data source fails and lists no options", async () => {
    const remote: ComponentNode[] = [
      { id: "pets", type: "checkboxes", configuration: { label: "Pets", data: { sourceId: "pets" } } },
      { id: "size", type: "radio", configuration: { label: "Size", data: { sourceId: "sizes" } } }
    ];
    const model = await buildPdfRenderModel(form(remote), state({ pets: ["cat", "dog"], size: "xl" }), failing);
    const checklists = blocksOf(model.document).filter((block): block is Extract<PdfBlock, { kind: "checklist" }> => block.kind === "checklist");
    expect(checklists.map((block) => [block.componentId, block.items])).toEqual([
      ["pets", [{ label: "cat", checked: true }, { label: "dog", checked: true }]],
      ["size", [{ label: "xl", checked: true }]]
    ]);
  });

  it("is kept by the field rendition as an option of its own, picked", async () => {
    const fields = ["pets", "colour", "size"].map((componentId) => ({ id: `f-${componentId}`, type: "pdf-field", configuration: { componentId, rendition: "field" } }));
    const model = await buildPdfRenderModel(form(choices), state({ pets: ["fish"], colour: "blue", size: "xl" }), none, {}, { layout: layout(fields) });
    const widgets = blocksOf(model.document).filter((block): block is Extract<PdfBlock, { kind: "widget" }> => block.kind === "widget");
    const size = widgets.find((block) => block.componentId === "size")!.field;
    expect(size.options).toEqual([{ value: "s", label: "Small" }, { value: "xl", label: "xl" }]);
    expect(size.value).toBe("xl");
    const colour = widgets.find((block) => block.componentId === "colour")!.field;
    expect(colour.options?.map((option) => option.value)).toEqual(["red", "blue"]);
    expect(colour.value).toBe("blue");
    const fish = widgets.find((block) => block.field.name === "pets.fish")!.field;
    expect(fish).toMatchObject({ kind: "checkbox", value: true, exportValue: "fish" });
  });
});
