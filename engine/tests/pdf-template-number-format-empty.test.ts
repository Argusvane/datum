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

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: { content: [{ id: "amount", type: "number", configuration: { label: "Amount" } }] }
};

const layout: PdfTemplateLayout = {
  id: "t",
  kind: "template",
  template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" },
  fields: [
    { pdfField: "Amount", source: { kind: "component", componentId: "amount" }, format: { kind: "number", pattern: "2" } },
    { pdfField: "Typed", source: { kind: "literal", value: "" }, format: { kind: "number", pattern: "2" } },
    { pdfField: "Path", source: { kind: "path", path: "amount" }, format: { kind: "number", pattern: "2" } }
  ]
};

describe("a number format over an empty answer", () => {
  it("leaves the field empty rather than writing 0.00", async () => {
    const empty = await buildPdfRenderModel(root, state({ amount: "" }), resolver, {}, { layout });
    expect(empty.fill!.values.Amount).toBeNull();
    expect(empty.fill!.values.Typed).toBe("");
    expect(empty.fill!.values.Path).toBe("");
  });

  it("still formats an answer, zero included", async () => {
    const zero = await buildPdfRenderModel(root, state({ amount: 0 }), resolver, {}, { layout });
    expect(zero.fill!.values.Amount).toBe("0.00");
    const some = await buildPdfRenderModel(root, state({ amount: 12.5 }), resolver, {}, { layout });
    expect(some.fill!.values.Amount).toBe("12.50");
  });
});
