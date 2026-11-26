/**
 * Direction controls typed into an answer never reach a template's widget value, whatever the
 * shape of the answer: a list, a picked key, a choice and a path
 * source are cleaned like a scalar. Text the author wrote keeps its isolates.
 */
import { describe, expect, it } from "vitest";

import type { PdfFieldMapping, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { renderTemplateText } from "../form-engine/render/pdf/template-text.js";

const OVERRIDE = "‮";
const form: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      { id: "tags", type: "select", configuration: { label: "Tags", multiple: true, options: [{ value: "a" }, { value: "b" }] } },
      { id: "contact", type: "checkboxes", configuration: { label: "Contact", options: [{ value: "email" }] } },
      { id: "kind", type: "radio", configuration: { label: "Kind", options: [{ value: "x" }, { value: "y" }] } },
      { id: "name", type: "text", configuration: { label: "Name" } }
    ]
  }
};
const state = (values: Record<string, unknown>): FormState => ({
  values,
  touched: new Set(),
  dirty: new Set(),
  validation: { valid: true },
  submission: { status: "idle", attempts: 0 },
  navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
  locale: "en-CA"
});
const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

describe("a template widget value", () => {
  it("is free of direction controls for a list, a picked key, a choice and a path source", async () => {
    const layout: PdfTemplateLayout = {
      id: "t",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
      fields: [
        { pdfField: "Tags", source: { kind: "component", componentId: "tags" } },
        { pdfField: "Contact", source: { kind: "component", componentId: "contact" } },
        { pdfField: "Kind", source: { kind: "component", componentId: "kind" } },
        { pdfField: "Path", source: { kind: "path", path: "tags" } }
      ] as PdfFieldMapping[]
    };
    const model = await buildPdfRenderModel(
      form,
      state({ tags: ["a" + OVERRIDE, "⁦b"], contact: { ["email" + OVERRIDE]: true }, kind: "x" + OVERRIDE }),
      resolver,
      {},
      { layout }
    );
    expect(model.fill?.values).toEqual({ Tags: ["a", "b"], Contact: ["email"], Kind: "x", Path: ["a", "b"] });
  });
});

describe("author text keeps its isolates", () => {
  it("strips the answer in a placeholder and leaves the isolates around it", () => {
    const rendered = renderTemplateText("⁧label⁩ {{name}} ⁦end⁩", { values: { name: OVERRIDE + "evil" } });
    expect(rendered.text).toBe("⁧label⁩ evil ⁦end⁩");
  });
});
