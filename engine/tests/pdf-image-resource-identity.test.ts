import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import type { PdfBlock } from "../form-engine/render/pdf/pdf-document.js";

function state(): FormState {
  return {
    values: {},
    touched: new Set(),
    dirty: new Set(),
    validation: { valid: true },
    submission: { status: "idle", attempts: 0 },
    navigation: { mode: "normal", visitedSteps: new Set(), completedSteps: new Set() },
    locale: "en"
  };
}

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };
const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [] } };

// The same header and the same length; the bytes differ after the first 64 characters.
const header = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8Dw";
const first = `${header}${"A".repeat(40)}`;
const second = `${header}${"B".repeat(40)}`;

function image(id: string, data: string): ComponentNode {
  return { id, type: "pdf-image", configuration: { src: `data:image/png;base64,${data}`, alt: id } };
}

describe("images drawn from bytes", () => {
  it("are one resource per distinct picture, never two pictures with one header and size as one", async () => {
    const layout: PdfGeneratedLayout = {
      id: "g",
      kind: "generated",
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [image("one", first), image("two", second), image("again", first)] } }
    };
    const model = await buildPdfRenderModel(root, state(), resolver, {}, { layout });
    const images = model.document!.blocks.filter((block): block is Extract<PdfBlock, { kind: "image" }> => block.kind === "image");
    const ids = images.map((block) => block.resourceId);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[2]).toBe(ids[0]);
    const data = ids.map((id) => {
      const resource = model.document!.resources.images[id]!;
      return "data" in resource ? resource.data : undefined;
    });
    expect(data).toEqual([first, second, first]);
  });
});
