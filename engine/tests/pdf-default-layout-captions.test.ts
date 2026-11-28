import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { deriveDefaultPdfLayout } from "../form-engine/render/pdf/default-layout.js";
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

function printed(blocks: readonly PdfBlock[]): string[] {
  const out: string[] = [];
  walkPdfBlocks(blocks, (block) => {
    if (block.kind === "heading" || block.kind === "paragraph") {
      out.push(runsText(block.runs));
    }
  });
  return out;
}

describe("the derived layout's headings", () => {
  it("leaves out the label of a container, fieldset or grid whose label the author hid", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "box", type: "fieldset", configuration: { label: "Hidden fieldset", hideLabel: true }, children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] } },
          {
            id: "cols",
            type: "grid",
            configuration: { label: "Hidden grid", hideLabel: true },
            children: { "col-1": [{ id: "b", type: "text", configuration: { label: "B" } }], "col-2": [{ id: "c", type: "text", configuration: { label: "C" } }] }
          },
          { id: "shown", type: "fieldset", configuration: { label: "Shown fieldset" }, children: { content: [{ id: "d", type: "text", configuration: { label: "D" } }] } }
        ]
      }
    };
    const layout = JSON.stringify(deriveDefaultPdfLayout(root));
    expect(layout).not.toContain("Hidden fieldset");
    expect(layout).not.toContain("Hidden grid");
    expect(layout).toContain("Shown fieldset");
  });

  it("captions an untitled tab by its place or its lone tab's label, never its slot id", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "tabs",
            type: "tabs",
            configuration: { tabs: [{ id: "slot-a", label: "Named" }, { id: "slot-b" }, { id: "slot-c" }] },
            children: {
              "slot-a": [{ id: "a", type: "text", configuration: { label: "A" } }],
              "slot-b": [{ id: "b", type: "text", configuration: { label: "B" } }],
              "slot-c": [{ id: "inner", type: "tab", configuration: { label: "From the tab" }, children: { content: [{ id: "c", type: "text", configuration: { label: "C" } }] } }]
            }
          }
        ]
      }
    };
    const model = await buildPdfRenderModel(root, state({ a: "1", b: "2", c: "3" }), resolver);
    const headings = printed(model.document!.blocks);
    expect(headings).toContain("Named");
    expect(headings).toContain("Tab 2");
    expect(headings).toContain("From the tab");
    expect(JSON.stringify(model.document!.blocks)).not.toContain("slot-b");
  });
});

describe("the derived layout's title", () => {
  it("prints the form's title as written, never an answer a placeholder in it names", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: { title: "Form {{secret}}" },
      children: {
        content: [
          { id: "secret", type: "text", configuration: { label: "Secret", pdf: { exclude: true } } },
          { id: "name", type: "text", configuration: { label: "Name" } }
        ]
      }
    };
    const model = await buildPdfRenderModel(root, state({ secret: "S3CRET", name: "Ada" }), resolver);
    const text = printed([...model.document!.blocks, ...(model.document!.footer ?? [])]);
    expect(text.filter((line) => line === "Form {{secret}}")).toHaveLength(2);
    expect(JSON.stringify(model.document)).not.toContain("S3CRET");
  });

  it("keeps a title with no placeholder as plain text", () => {
    const layout = deriveDefaultPdfLayout({ id: "root", type: "form", configuration: { title: "Intake" }, children: { content: [] } });
    expect(layout.root.children!.body![0]!.configuration).toEqual({ text: "Intake", variant: "h1" });
  });
});
