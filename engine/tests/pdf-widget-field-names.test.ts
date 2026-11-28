import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
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
  children: {
    content: [
      { id: "name", type: "text", configuration: { label: "Name" } },
      { id: "email", type: "text", configuration: { label: "Email" } },
      { id: "signed", type: "signature", configuration: { label: "Sign here" } }
    ]
  }
};

function layout(body: ComponentNode[], settings: Partial<PdfGeneratedLayout> = {}): PdfGeneratedLayout {
  return { id: "g", kind: "generated", ...settings, root: { id: "document", type: "pdf-document", configuration: {}, children: { body } } };
}

describe("the layout's signature field", () => {
  it("is found when a signature component's field rendition makes it", async () => {
    const model = await buildPdfRenderModel(
      root,
      state({}),
      resolver,
      {},
      { layout: layout([{ id: "b", type: "pdf-field", configuration: { componentId: "signed", rendition: "field" } }], { signature: { field: "signed" } }) }
    );
    expect(model.warnings.map((warning) => warning.code)).not.toContain("signature.fieldMissing");
  });

  it("is still missing when nothing makes it", async () => {
    const model = await buildPdfRenderModel(root, state({}), resolver, {}, { layout: layout([{ id: "b", type: "pdf-field", configuration: { componentId: "name" } }], { signature: { field: "signed" } }) });
    expect(model.warnings.map((warning) => warning.code)).toContain("signature.fieldMissing");
  });
});

describe("two owners of one AcroForm field name", () => {
  it("warns when a signature block takes a field rendition's name, and when two components share one", async () => {
    const model = await buildPdfRenderModel(
      root,
      state({ name: "Ada", email: "ada@x.test" }),
      resolver,
      {},
      {
        layout: layout([
          { id: "b-name", type: "pdf-field", configuration: { componentId: "name", rendition: "field" } },
          { id: "sig", type: "pdf-signature", configuration: { fieldName: "name" } },
          { id: "b-email", type: "pdf-field", configuration: { componentId: "email", rendition: "field", widgetName: "name" } }
        ])
      }
    );
    const duplicates = model.warnings.filter((warning) => warning.code === "layout.duplicateWidgetName");
    expect(duplicates).toHaveLength(2);
    expect(duplicates[0]!.message).toContain('"name"');
    expect(duplicates[1]!.componentId).toBe("email");
  });

  it("says nothing for one component bound twice as a field", async () => {
    const model = await buildPdfRenderModel(
      root,
      state({ name: "Ada" }),
      resolver,
      {},
      {
        layout: layout([
          { id: "b1", type: "pdf-field", configuration: { componentId: "name", rendition: "field" } },
          { id: "b2", type: "pdf-field", configuration: { componentId: "name", rendition: "field" } }
        ])
      }
    );
    expect(model.warnings.map((warning) => warning.code)).not.toContain("layout.duplicateWidgetName");
  });
});
