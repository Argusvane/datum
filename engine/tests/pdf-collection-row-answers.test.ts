import { describe, expect, it } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
import type { PdfGeneratedLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { DataSourceResolver } from "../form-engine/render/core/component-options.js";
import { buildPdfRenderModel } from "../form-engine/render/pdf/pdf-render-model.js";
import { formatPdfValue } from "../form-engine/render/pdf/pdf-values.js";
import { runsText, walkPdfBlocks, type PdfBlock, type PdfDocument } from "../form-engine/render/pdf/pdf-document.js";

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

function blocks(document: PdfDocument | undefined): PdfBlock[] {
  const out: PdfBlock[] = [];
  walkPdfBlocks(document?.blocks ?? [], (block) => out.push(block));
  return out;
}

function tableCells(document: PdfDocument | undefined): string[][] {
  const table = blocks(document).find((block): block is Extract<PdfBlock, { kind: "table" }> => block.kind === "table" && block.componentId === "people");
  return (table?.rows ?? []).map((row) => row.cells.map((cell) => cell.blocks.map((block) => ("runs" in block ? runsText(block.runs) : "")).join("")));
}

/** A top-level `email` beside a repeating section whose entries hold a field keyed `email` too. */
function root(peopleConfiguration: Record<string, unknown> = {}): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: { title: "Team" },
    children: {
      content: [
        { id: "email", type: "text", configuration: { label: "Your email" } },
        {
          id: "people",
          type: "panel",
          collection: { collectionPath: "people" },
          configuration: { label: "People", ...peopleConfiguration },
          children: {
            content: [
              { id: "people_name", type: "text", configuration: { label: "Name", dataKey: "name" } },
              { id: "people_email", type: "text", configuration: { label: "Email", dataKey: "email" } }
            ]
          }
        }
      ]
    }
  };
}

const answers = { email: "boss@corp.test", "people[0].name": "Ann", "people[0].email": "ann@x.test", "people[1].name": "Bob" };

describe("a collection entry with no answer at a field's key", () => {
  it("formats an explicit undefined as no answer, not the model's own value", () => {
    const model = { id: "f", type: "text", value: "elsewhere", optionState: { componentId: "f", status: "not-applicable", items: [] } } as never;
    expect(formatPdfValue(model, undefined, undefined)).toEqual({ text: "", empty: true });
    expect(formatPdfValue(model).text).toBe("elsewhere");
  });

  it("prints a blank table cell, never the top-level answer at the same bare key", async () => {
    for (const rendition of ["table", "sections"]) {
      const model = await buildPdfRenderModel(root({ pdf: { rendition } }), state(answers), resolver);
      const printed = JSON.stringify(blocks(model.document).map((block) => ("runs" in block ? runsText(block.runs) : block.kind === "labelValue" ? runsText(block.value) : "")));
      expect(printed).toContain("ann@x.test");
      expect(printed.match(/boss@corp\.test/g)?.length).toBe(1);
    }
    const model = await buildPdfRenderModel(root(), state(answers), resolver);
    expect(tableCells(model.document)).toEqual([
      ["Ann", "ann@x.test"],
      ["Bob", ""]
    ]);
  });

  it("prints a repeat's field and its {{row.key}} placeholder blank", async () => {
    const layout: PdfGeneratedLayout = {
      id: "repeat",
      kind: "generated",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            {
              id: "rep",
              type: "pdf-repeat",
              configuration: { collectionPath: "people" },
              children: {
                row: [
                  { id: "b-email", type: "pdf-field", configuration: { componentId: "people_email" } },
                  { id: "t", type: "pdf-text", configuration: { text: "{{row.name}} <{{row.email}}>" } }
                ]
              }
            }
          ]
        }
      }
    };
    const model = await buildPdfRenderModel(root(), state(answers), resolver, {}, { layout });
    const texts = blocks(model.document).filter((block) => block.kind === "paragraph").map((block) => runsText((block as Extract<PdfBlock, { kind: "paragraph" }>).runs));
    expect(texts).toEqual(["Ann <ann@x.test>", "Bob <>"]);
    const values = blocks(model.document)
      .filter((block): block is Extract<PdfBlock, { kind: "labelValue" }> => block.kind === "labelValue")
      .map((block) => runsText(block.value));
    expect(values).not.toContain("boss@corp.test");
    expect(values[0]).toBe("ann@x.test");
  });
});

describe("the fields a collection rendition lists", () => {
  function itemsRoot(rendition: string): ComponentNode {
    return {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "items",
            type: "panel",
            collection: { collectionPath: "items" },
            configuration: { label: "Items", pdf: { rendition } },
            children: {
              content: [
                { id: "sku", type: "text", configuration: { label: "SKU" } },
                { id: "secret", type: "text", configuration: { label: "Internal", hidden: true } },
                { id: "excl", type: "text", configuration: { label: "Excluded", pdf: { exclude: true } } }
              ]
            }
          }
        ]
      }
    };
  }

  const rows = { "items[0].sku": "A1", "items[0].secret": "S3CRET", "items[0].excl": "EX1" };

  it("leaves out a field the PDF excludes and one that is hidden, in the table and the sections", async () => {
    for (const rendition of ["table", "sections"]) {
      const model = await buildPdfRenderModel(itemsRoot(rendition), state(rows), resolver);
      const printed = JSON.stringify(model.document?.blocks);
      expect(printed).toContain("A1");
      expect(printed).not.toContain("S3CRET");
      expect(printed).not.toContain("Internal");
      expect(printed).not.toContain("EX1");
      expect(printed).not.toContain("Excluded");
    }
  });

  it("leaves out a field its rules hide", async () => {
    const model = await buildPdfRenderModel(itemsRoot("table"), state(rows), resolver, {
      effectiveStates: new Map([
        ["sku", { visible: false, disabled: false, readonly: false, runValidation: false, requiredApplies: false, submitValue: false, clearValue: false }]
      ])
    });
    expect(JSON.stringify(model.document?.blocks)).not.toContain("A1");
  });
});

describe("a file field drawn as an image in a repeat", () => {
  const PNG_A = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
  const PNG_B = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const file = (name: string, data: string) => ({ storage: "base64", name, type: "image/png", size: 68, data });

  it("draws each entry's own picture", async () => {
    const form: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "items",
            type: "panel",
            collection: { collectionPath: "items" },
            configuration: { label: "Items" },
            children: { content: [{ id: "photo", type: "file", configuration: { label: "Photo" } }] }
          }
        ]
      }
    };
    const layout: PdfGeneratedLayout = {
      id: "photos",
      kind: "generated",
      root: {
        id: "document",
        type: "pdf-document",
        configuration: {},
        children: {
          body: [
            {
              id: "rep",
              type: "pdf-repeat",
              configuration: { collectionPath: "items" },
              children: { row: [{ id: "b", type: "pdf-field", configuration: { componentId: "photo", rendition: "image" } }] }
            }
          ]
        }
      }
    };
    const model = await buildPdfRenderModel(form, state({ "items[0].photo": [file("a.png", PNG_A)], "items[1].photo": [file("b.png", PNG_B)] }), resolver, {}, { layout });
    const images = blocks(model.document).filter((block): block is Extract<PdfBlock, { kind: "image" }> => block.kind === "image");
    expect(images.map((image) => image.alt)).toEqual(["a.png", "b.png"]);
    const data = images.map((image) => {
      const resource = model.document!.resources.images[image.resourceId]!;
      return "data" in resource ? resource.data : undefined;
    });
    expect(data).toEqual([PNG_A, PNG_B]);
  });
});
