import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { runsText, walkPdfBlocks } from "../form-engine/render/pdf/pdf-document.js";
import { PDF_ANSWER_MASK } from "../form-engine/render/pdf/standard-renditions.js";

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

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "secret", type: "password", configuration: { label: "Password" } },
      { id: "empty", type: "password", configuration: { label: "Unused" } },
      { id: "name", type: "text", configuration: { label: "Name" } }
    ]
  }
};

const values = { secret: "hunter2", name: "Ada" };

describe("a placeholder naming a password", () => {
  it("prints the mask in a layout text block, and nothing for no answer", async () => {
    const layout: PdfGeneratedLayout = {
      id: "g",
      kind: "generated",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: { body: [{ id: "t", type: "pdf-text", configuration: { text: "{{name}}: {{secret}} / [{{empty}}]" } }] }
      }
    };
    const model = await buildPdfRenderModel(root, state(values), resolver, {}, { layout });
    const texts: string[] = [];
    walkPdfBlocks(model.document!.blocks, (block) => {
      if (block.kind === "paragraph") {
        texts.push(runsText(block.runs));
      }
    });
    expect(texts).toEqual([`Ada: ${PDF_ANSWER_MASK} / []`]);
    expect(JSON.stringify(model.document)).not.toContain("hunter2");
  });

  it("prints the mask in a template's text source", async () => {
    const layout: PdfTemplateLayout = {
      id: "t",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" },
      fields: [{ pdfField: "Summary", source: { kind: "template", text: "{{name}} {{secret}}" } }]
    };
    const model = await buildPdfRenderModel(root, state(values), resolver, {}, { layout });
    expect(model.fill!.values.Summary).toBe(`Ada ${PDF_ANSWER_MASK}`);
  });
});
