import { describe, expect, it } from "vitest";
import type { FormDefinition, PdfFieldMapping, PdfTemplateFieldInfo, PdfTemplateInfo, PdfTemplateLayout } from "@argusvane/datum-engine";

import { extractFromTemplateFields } from "../src/index.js";

/**
 * Reading a filled PDF back through a mapping that carries a value map: the PDF holds
 * its own words (`1`, `2`, `3`), the form's answers are the map's keys.
 */
const definition = (fields: PdfFieldMapping[]): FormDefinition => ({
  id: "claim",
  version: "1.0.0",
  schemaVersion: "1.0.0",
  root: {
    id: "form",
    type: "form",
    configuration: {},
    children: {
      content: [
        { id: "change", type: "radio", configuration: { options: [{ value: "improved" }, { value: "unchanged" }, { value: "worsened" }] } },
        { id: "timeLost", type: "checkbox", configuration: {} },
        { id: "tags", type: "multiselect", configuration: { options: [{ value: "a" }, { value: "b" }] } }
      ]
    }
  },
  pdf: { layouts: [{ id: "paper", kind: "template", template: { storage: "base64", name: "p.pdf", type: "application/pdf", size: 1, data: "AA==" }, fields }] }
});

const field = (name: string, kind: PdfTemplateFieldInfo["kind"], value?: PdfTemplateFieldInfo["value"]): PdfTemplateFieldInfo => ({
  name,
  kind,
  readOnly: false,
  required: false,
  ...(value !== undefined ? { value } : {})
});

function read(fields: PdfFieldMapping[], pdf: PdfTemplateFieldInfo[]) {
  const def = definition(fields);
  const info = { pageCount: 1, pages: [{ index: 1, width: 612, height: 792 }], fields: pdf, hasXfa: false, encrypted: false } as PdfTemplateInfo;
  return extractFromTemplateFields(info, { definition: def, formId: "claim", formVersion: "1.0.0" } as never, def.pdf!.layouts![0] as PdfTemplateLayout);
}

const CHANGE = { improved: "1", unchanged: "2", worsened: "3" };

describe("a value map read back from a PDF", () => {
  it("reads a radio group's export value as the answer it stands for", () => {
    const out = read([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: CHANGE }], [field("Since", "radio", "3")]);
    expect(out.values).toEqual({ change: "worsened" });
    expect(out.notes).toEqual([]);
  });

  it("reads a Yes/No group back as a boolean for a checkbox component", () => {
    const mapping: PdfFieldMapping = { pdfField: "Lost", source: { kind: "component", componentId: "timeLost" }, values: { true: "1", false: "2" } };
    expect(read([mapping], [field("Lost", "radio", "1")]).values).toEqual({ timeLost: true });
    expect(read([mapping], [field("Lost", "radio", "2")]).values).toEqual({ timeLost: false });
  });

  it("reads each element of a list box back, and keeps a word the map does not hold", () => {
    const mapping: PdfFieldMapping = { pdfField: "Tags", source: { kind: "component", componentId: "tags" }, values: { a: "A1" } };
    expect(read([mapping], [field("Tags", "listbox", ["A1", "b"])]).values).toEqual({ tags: ["a", "b"] });
  });

  it("keeps the value as read and says why when two answers share a PDF value", () => {
    const out = read([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { improved: "1", unchanged: "1", worsened: "3" } }], [field("Since", "radio", "1")]);
    expect(out.values).toEqual({ change: "1" });
    expect(out.notes).toEqual([expect.stringMatching(/"Since".*ambiguous/)]);
  });

  it("reads a mapping with no map, or an unusable one, as it always did", () => {
    const plain = read([{ pdfField: "Since", source: { kind: "component", componentId: "change" } }], [field("Since", "radio", "3")]);
    expect(plain.values).toEqual({ change: "3" });
    expect(plain.notes).toEqual([]);
    expect(read([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: {} }], [field("Since", "radio", "3")]).values).toEqual({ change: "3" });
  });
});
