import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";

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

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function layout(binding: Record<string, unknown>): PdfGeneratedLayout {
  return {
    id: "g",
    kind: "generated",
    root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "b", type: "pdf-field", configuration: binding }] } }
  };
}

function kinds(blocks: readonly PdfBlock[]): string[] {
  const out: string[] = [];
  walkPdfBlocks(blocks, (block) => out.push(block.kind));
  return out;
}

describe("a rendition a repeating component cannot draw", () => {
  it("is drawn as the collection's own and says rendition.unknown", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "grid",
            type: "dataGrid",
            configuration: { label: "Lines" },
            collection: { collectionPath: "grid" },
            children: { content: [{ id: "sku", type: "text", configuration: { label: "SKU" } }] }
          }
        ]
      }
    };
    const model = await buildPdfRenderModel(root, state({ "grid[0].sku": "A1" }), resolver, {}, { layout: layout({ componentId: "grid", rendition: "checklist" }) });
    expect(kinds(model.document!.blocks)).toContain("table");
    expect(model.warnings).toContainEqual(expect.objectContaining({ code: "rendition.unknown", componentId: "grid" }));
  });
});

describe("an unknown type bound with a generic rendition", () => {
  it("draws that rendition and does not call it passed over", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "x", type: "acme-widget", configuration: { label: "Widget" } }] }
    };
    const model = await buildPdfRenderModel(root, state({ x: "hello" }), resolver, {}, { layout: layout({ componentId: "x", rendition: "field" }) });
    expect(kinds(model.document!.blocks)).toContain("widget");
    const codes = model.warnings.map((warning) => warning.code);
    expect(codes).not.toContain("rendition.unknown");
    const unknown = model.warnings.find((warning) => warning.code === "component.unknown");
    expect(unknown?.message).toContain('"field"');
  });

  it("still says rendition.unknown for a rendition nothing draws", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "x", type: "acme-widget", configuration: { label: "Widget" } }] }
    };
    const model = await buildPdfRenderModel(root, state({ x: "hello" }), resolver, {}, { layout: layout({ componentId: "x", rendition: "sparkles" }) });
    expect(model.warnings.map((warning) => warning.code)).toContain("rendition.unknown");
  });
});
