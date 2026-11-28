import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { walkPdfBlocks, type PdfBlock, type PdfFormFieldSpec } from "../form-engine/render/pdf/pdf-document.js";
import { pdfFieldNamePart } from "../form-engine/render/pdf/standard-renditions.js";

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

async function fieldSpecs(content: ComponentNode[], values: Record<string, unknown>): Promise<PdfFormFieldSpec[]> {
  const body = content.map((node) => ({ id: `f-${node.id}`, type: "pdf-field", configuration: { componentId: node.id, rendition: "field" } }));
  const model = await buildPdfRenderModel(
    { id: "root", type: "form", configuration: { title: "T" }, children: { content } },
    state(values),
    resolver,
    {},
    { layout: { id: "l", kind: "generated", root: { id: "d", type: "pdf-document", configuration: {}, children: { body } } } }
  );
  const out: PdfFormFieldSpec[] = [];
  walkPdfBlocks(model.document?.blocks ?? [], (block: PdfBlock) => {
    if (block.kind === "widget") {
      out.push(block.field);
    }
  });
  return out;
}

describe("a checkboxes component's per-option widgets", () => {
  it("name each option in one part of the field name, with no dot and no two alike", async () => {
    const specs = await fieldSpecs(
      [{ id: "pets", type: "checkboxes", configuration: { label: "Pets", options: [{ value: "U.S.", label: "US" }, { value: "a", label: "A" }, { value: "a.b", label: "AB" }, { value: "a%2Eb", label: "Literal" }] } }],
      { pets: ["U.S.", "a.b"] }
    );
    const names = specs.map((spec) => spec.name);
    expect(names).toEqual(["pets.U%2ES%2E", "pets.a", "pets.a%2Eb", "pets.a%252Eb"]);
    expect(new Set(names).size).toBe(names.length);
    for (const name of names) {
      expect(name.split(".")).toHaveLength(2);
    }
    expect(specs.map((spec) => [spec.exportValue, spec.value])).toEqual([
      ["U.S.", true],
      ["a", false],
      ["a.b", true],
      ["a%2Eb", false]
    ]);
    expect(pdfFieldNamePart("plain")).toBe("plain");
  });

  it("mark no single option required when the field is: one ticked is enough", async () => {
    const specs = await fieldSpecs(
      [{ id: "pets", type: "checkboxes", configuration: { label: "Pets", required: true, options: [{ value: "cat", label: "Cat" }, { value: "dog", label: "Dog" }] } }],
      {}
    );
    expect(specs).toHaveLength(2);
    expect(specs.every((spec) => spec.required !== true)).toBe(true);
  });
});

describe("a text widget's length limit", () => {
  it("is widened to the answer's UTF-16 length, so an answer of astral characters within the limit is written whole", async () => {
    const specs = await fieldSpecs(
      [
        { id: "emoji", type: "text", configuration: { label: "Emoji", maxLength: 3 } },
        { id: "plain", type: "text", configuration: { label: "Plain", maxLength: 5 } },
        { id: "empty", type: "text", configuration: { label: "Empty", maxLength: 4 } }
      ],
      { emoji: "\u{1F600}\u{1F600}\u{1F600}", plain: "abc" }
    );
    expect(specs.map((spec) => [spec.name, spec.value, spec.maxLength])).toEqual([
      ["emoji", "\u{1F600}\u{1F600}\u{1F600}", 6],
      ["plain", "abc", 5],
      ["empty", undefined, 4]
    ]);
  });
});
