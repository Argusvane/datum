import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
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

function root(exclude = false): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "country", type: "radio", configuration: { label: "Country", data: { sourceId: "countries" }, ...(exclude ? { pdf: { exclude: true } } : {}) } },
        { id: "name", type: "text", configuration: { label: "Name" } }
      ]
    }
  };
}

const failing: DataSourceResolver = {
  resolveDataSource: async ({ componentId }) => {
    if (componentId === "country") {
      throw new Error("service down");
    }
    return undefined;
  }
};

describe("an option source that failed when the PDF was built", () => {
  it("says so with options.unavailable, on a generated document and a template fill", async () => {
    const generated = await buildPdfRenderModel(root(), state({ country: "CA", name: "Ada" }), failing);
    const warning = generated.warnings.find((entry) => entry.code === "options.unavailable");
    expect(warning).toMatchObject({ componentId: "country" });
    expect(warning?.message).toContain("countries");
    expect(warning?.message).toContain("service down");

    const template: PdfTemplateLayout = {
      id: "t",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" },
      fields: [{ pdfField: "Country", source: { kind: "component", componentId: "country" } }]
    };
    const filled = await buildPdfRenderModel(root(), state({ country: "CA" }), failing, {}, { layout: template });
    expect(filled.warnings.filter((entry) => entry.code === "options.unavailable").map((entry) => entry.componentId)).toEqual(["country"]);
  });

  it("says nothing for a component the PDF leaves out, or a source that answered", async () => {
    const excluded = await buildPdfRenderModel(root(true), state({ country: "CA" }), failing);
    expect(excluded.warnings.map((entry) => entry.code)).not.toContain("options.unavailable");
    const answering: DataSourceResolver = { resolveDataSource: async ({ componentId }) => (componentId === "country" ? { items: [{ value: "CA", label: "Canada" }] } : undefined) };
    const fine = await buildPdfRenderModel(root(), state({ country: "CA" }), answering);
    expect(fine.warnings.map((entry) => entry.code)).not.toContain("options.unavailable");
  });
});
