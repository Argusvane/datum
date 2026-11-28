import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { runsText, walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";

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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
const file = { storage: "base64", name: "passport.png", type: "image/png", size: 68, data: PNG };

const root: ComponentNode = {
  id: "root",
  type: "form",
  configuration: {},
  children: {
    content: [
      {
        id: "applicant",
        type: "container",
        configuration: { dataKey: "applicant" },
        children: {
          content: [
            { id: "applicant_doc", type: "file", configuration: { label: "Doc", dataKey: "doc" } },
            { id: "applicant_kind", type: "radio", configuration: { label: "Kind", dataKey: "kind", options: [{ value: "p", label: "Passport" }] } }
          ]
        }
      },
      {
        id: "items",
        type: "panel",
        collection: { collectionPath: "items" },
        configuration: { label: "Items" },
        children: {
          content: [
            { id: "pick", type: "select", configuration: { label: "Pick", options: [{ value: "a", label: "Apple" }] } },
            { id: "att", type: "file", configuration: { label: "Att" } },
            { id: "note", type: "textarea", configuration: { label: "Note" } }
          ]
        }
      }
    ]
  }
};

const long = "x".repeat(500);
const values = { "applicant.doc": file, "applicant.kind": "p", "items[0].pick": "a", "items[0].att": [file], "items[0].note": long };

function texts(blocks: readonly PdfBlock[]): string[] {
  const out: string[] = [];
  walkPdfBlocks(blocks, (block) => {
    if (block.kind === "paragraph") {
      out.push(runsText(block.runs));
    }
  });
  return out;
}

describe("a placeholder that names a value path", () => {
  it("formats a keyed or an indexed entry path as its component's answer and cuts it to answerChars", async () => {
    const layout: PdfGeneratedLayout = {
      id: "g",
      kind: "generated",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: { limits: { answerChars: 50 } },
        children: {
          body: [
            { id: "t1", type: "pdf-text", configuration: { text: "doc={{applicant.doc}} kind={{applicant.kind}}" } },
            { id: "t2", type: "pdf-text", configuration: { text: "pick={{items[0].pick}} att={{items[0].att}}" } },
            { id: "t3", type: "pdf-text", configuration: { text: "{{items[0].note}}" } }
          ]
        }
      }
    };
    const model = await buildPdfRenderModel(root, state(values), resolver, {}, { layout });
    const [first, second, third] = texts(model.document!.blocks);
    expect(first).toBe("doc=passport.png (68 B) kind=Passport");
    expect(second).toBe("pick=Apple att=passport.png (68 B)");
    expect(third).toBe(`${"x".repeat(50)} […]`);
    expect(model.warnings).toContainEqual(expect.objectContaining({ code: "render.truncated", componentId: "note" }));
    expect(JSON.stringify(model.document!.blocks)).not.toContain(PNG);
  });

  it("writes a template's path and text sources from the component the path names", async () => {
    const layout: PdfTemplateLayout = {
      id: "t",
      kind: "template",
      template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 5, data: "JVBERi0=" },
      fields: [
        { pdfField: "Text", source: { kind: "template", text: "{{applicant.doc}} | {{applicant.kind}} | {{items[0].pick}}" } },
        { pdfField: "Doc", source: { kind: "path", path: "applicant.doc" } },
        { pdfField: "Att", source: { kind: "path", path: "items[0].att" } }
      ]
    };
    const model = await buildPdfRenderModel(root, state(values), resolver, {}, { layout });
    expect(model.fill!.values).toEqual({
      Text: "passport.png (68 B) | Passport | Apple",
      Doc: "passport.png (68 B)",
      Att: "passport.png (68 B)"
    });
  });
});
