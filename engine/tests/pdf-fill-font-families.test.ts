import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import type { PdfThemeDefinition } from "../form-engine/render/pdf/pdf-theme.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { pdfFillFontNeed } from "../form-engine/render/pdf/pdf-provider.js";

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

describe("the fonts a template fill asks for", () => {
  it("names the families of the theme's typography the plan carries", async () => {
    const theme = {
      id: "corp",
      version: "1.0.0",
      target: "pdf",
      assets: { fonts: [{ family: "Lato", file: "lato.woff" }] },
      pdf: { typography: { body: { family: "Lato", size: 10 }, label: { family: "Lato", size: 9 }, heading: { family: "Lato", size: 14 } } }
    } as PdfThemeDefinition;
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] } };
    const layout: PdfTemplateLayout = {
      id: "t",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" },
      fields: [],
      areas: [{ id: "ar", page: 1, rect: { x: 10, y: 10, width: 100, height: 20 }, source: { kind: "component", componentId: "a" } }]
    };
    const model = await buildPdfRenderModel(root, state({ a: "hello" }), resolver, {}, { layout, theme });
    const need = pdfFillFontNeed(model.fill!);
    expect(need.families).toContain("Lato");
    expect(model.fontFaces.map((face) => face.family)).toContain("Lato");
  });
});
