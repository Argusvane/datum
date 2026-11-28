import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { runsText, walkPdfBlocks, type PdfBlock } from "../form-engine/render/pdf/pdf-document.js";
import { PDF_ANSWER_MASK } from "../form-engine/render/pdf/standard-renditions.js";
import { REVIEW_MASK } from "../form-engine/render/core/journey-review.js";

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

function printed(blocks: PdfBlock[]): string {
  const out: string[] = [];
  walkPdfBlocks(blocks, (block) => {
    if (block.kind === "labelValue") {
      out.push(runsText(block.value));
    } else if (block.kind === "paragraph" || block.kind === "heading") {
      out.push(runsText(block.runs));
    } else if (block.kind === "widget" && typeof block.field.value === "string") {
      out.push(block.field.value);
    }
  });
  return out.join("\n");
}

const form: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "T" },
  children: {
    content: [
      { id: "secret", type: "password", configuration: { label: "Password" } },
      {
        id: "logins",
        type: "dataGrid",
        configuration: { label: "Logins" },
        collection: { collectionPath: "logins" },
        children: { content: [{ id: "user", type: "text", configuration: { label: "User" } }, { id: "pin", type: "password", configuration: { label: "PIN" } }] }
      }
    ]
  }
};

describe("a password answer on paper", () => {
  it("prints as the review's mask in a field and a table row, and is not written into a widget", async () => {
    expect(PDF_ANSWER_MASK).toBe(REVIEW_MASK);
    const values = { secret: "hunter2", "logins[0].user": "ada", "logins[0].pin": "4321" };
    const model = await buildPdfRenderModel(form, state(values), resolver);
    const text = printed(model.document?.blocks ?? []);
    expect(text).not.toContain("hunter2");
    expect(text).not.toContain("4321");
    expect(text).toContain("ada");
    expect(text.split(PDF_ANSWER_MASK).length - 1).toBe(2);

    const layout = { id: "l", kind: "generated" as const, root: { id: "d", type: "pdf-document", configuration: {}, children: { body: [{ id: "f", type: "pdf-field", configuration: { componentId: "secret", rendition: "field" } }] } } };
    const fillable = await buildPdfRenderModel(form, state(values), resolver, {}, { layout });
    expect(printed(fillable.document?.blocks ?? [])).not.toContain("hunter2");
  });

  it("prints nothing in place of no answer", async () => {
    const model = await buildPdfRenderModel(form, state({}), resolver);
    expect(printed(model.document?.blocks ?? [])).not.toContain(PDF_ANSWER_MASK);
  });
});
