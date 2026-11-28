import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";

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
  configuration: { title: "T" },
  children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] }
};

describe("a page break with a page setup of its own", () => {
  it("keeps the document's margins and bands for what it leaves unsaid", async () => {
    const layout: PdfGeneratedLayout = {
      id: "g",
      kind: "generated",
      page: { size: "A4", margins: { top: 36, right: 36, bottom: 36, left: 36 }, header: { height: 30 }, footer: { height: 24 } },
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            { id: "f", type: "pdf-field", configuration: { componentId: "a" } },
            { id: "brk", type: "pdf-page-break", configuration: { changePage: true, page: { orientation: "landscape", margins: { left: 72 } } } },
            { id: "f2", type: "pdf-field", configuration: { componentId: "a" } }
          ],
          footer: [{ id: "pg", type: "pdf-text", configuration: { text: "Page {{page}} of {{pages}}" } }]
        }
      }
    };
    const model = await buildPdfRenderModel(root, state({ a: "x" }), resolver, {}, { layout });
    const pageBreak = model.document!.blocks.find((block) => block.kind === "pageBreak");
    expect(pageBreak && pageBreak.kind === "pageBreak" ? pageBreak.page : undefined).toEqual({
      size: "A4",
      orientation: "landscape",
      margins: { top: 36, right: 36, bottom: 36, left: 72 },
      header: { height: 30 },
      footer: { height: 24 }
    });
  });
});

describe("a PDF theme's page defaults", () => {
  const theme = {
    id: "corp",
    version: "1.0.0",
    target: "pdf",
    pdf: { page: { size: "Letter", orientation: "landscape", margins: { top: 20, right: 20, bottom: 20, left: 20 } } }
  } as PdfThemeDefinition;

  it("reach the derived layout, under the footer band it sets", async () => {
    const model = await buildPdfRenderModel(root, state({ a: "x" }), resolver, {}, { theme });
    expect(model.layoutKind).toBe("derived");
    expect(model.document!.page).toMatchObject({ size: "Letter", orientation: "landscape", margins: { top: 20, right: 20, bottom: 20, left: 20 } });
    expect(model.document!.page.footer?.height).toBeGreaterThan(0);
  });

  it("reach an authored layout field by field, under what the layout sets", async () => {
    const layout: PdfGeneratedLayout = {
      id: "g",
      kind: "generated",
      // The root's settings, as the builder writes them: one margin set, the rest the theme's.
      root: {
        id: "document",
        type: "pdf-document",
        configuration: { page: { margins: { top: 50 }, footer: { height: 30 } } },
        children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "a" } }] }
      }
    };
    const model = await buildPdfRenderModel(root, state({ a: "x" }), resolver, {}, { theme, layout });
    expect(model.document!.page).toEqual({
      size: "Letter",
      orientation: "landscape",
      margins: { top: 50, right: 20, bottom: 20, left: 20 },
      footer: { height: 30 }
    });
  });
});
