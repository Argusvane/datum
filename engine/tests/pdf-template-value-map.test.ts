/**
 * A mapping's value map: the answer is translated to the value the PDF holds (a radio
 * group's export value, a dropdown's option) before `checkedValue` compares it and before
 * `format` shapes it. Driven through the render model, the way a host reaches it.
 */
import { describe, expect, it } from "vitest";

import { readPdfValueMap, type PdfFieldMapping, type PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormState } from "../form-engine/core/state/form-state.js";
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
    locale: "en-CA"
  };
}

const form: ComponentNode = {
  id: "root",
  type: "form",
  configuration: { title: "Claim" },
  children: {
    content: [
      {
        id: "change",
        type: "radio",
        configuration: { label: "Change", options: [{ value: "improved" }, { value: "unchanged" }, { value: "worsened" }] }
      },
      { id: "working", type: "checkbox", configuration: { label: "Working" } },
      {
        id: "contact",
        type: "checkboxes",
        configuration: { label: "Contact", options: [{ value: "email" }, { value: "phone" }, { value: "mail" }] }
      },
      { id: "tags", type: "select", configuration: { label: "Tags", multiple: true, options: [{ value: "a" }, { value: "b" }] } },
      { id: "name", type: "text", configuration: { label: "Name" } }
    ]
  }
};

const resolver: DataSourceResolver = { resolveDataSource: async () => undefined };

function layoutOf(fields: PdfFieldMapping[], areas?: PdfTemplateLayout["areas"]): PdfTemplateLayout {
  return {
    id: "gov",
    kind: "template",
    template: { storage: "base64", name: "gov.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
    fields,
    ...(areas ? { areas } : {})
  };
}

async function fill(fields: PdfFieldMapping[], values: Record<string, unknown>, areas?: PdfTemplateLayout["areas"]) {
  const model = await buildPdfRenderModel(form, state(values), resolver, {}, { layout: layoutOf(fields, areas) });
  return { values: model.fill!.values, areas: model.fill!.areas, warnings: model.warnings };
}

const CHANGE = { improved: "1", unchanged: "2", worsened: "3" };

describe("a mapping's value map", () => {
  it("writes a radio component's answer as the PDF group's export value", async () => {
    const out = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: CHANGE }], { change: "worsened" });
    expect(out.values).toEqual({ Since: "3" });
    expect(out.warnings).toEqual([]);
  });

  it("passes an unmapped answer through and warns once per binding, naming the value", async () => {
    const out = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { improved: "1" } }], { change: "worsened" });
    expect(out.values).toEqual({ Since: "worsened" });
    expect(out.warnings).toEqual([expect.objectContaining({ code: "mapping.unmappedValue", componentId: "change", message: expect.stringContaining('"worsened"') })]);
    expect(out.warnings[0]!.message).toContain('Field "Since"');
  });

  it("says nothing for an empty answer, and for an answer it maps", async () => {
    const mapping: PdfFieldMapping = { pdfField: "Since", source: { kind: "component", componentId: "change" }, values: CHANGE };
    expect((await fill([mapping], {})).warnings).toEqual([]);
    expect((await fill([mapping], { change: "" })).warnings).toEqual([]);
    expect((await fill([mapping], { change: "improved" })).warnings).toEqual([]);
  });

  it("translates every element of a multi-select and a checkboxes answer, and names each unmapped one once", async () => {
    const out = await fill(
      [
        { pdfField: "Tags", source: { kind: "component", componentId: "tags" }, values: { a: "A1" } },
        { pdfField: "Contact", source: { kind: "component", componentId: "contact" }, values: { email: "E", phone: "P" } }
      ],
      { tags: ["a", "b", "b"], contact: { email: true, phone: false, mail: true } }
    );
    expect(out.values).toEqual({ Tags: ["A1", "b", "b"], Contact: ["E", "mail"] });
    expect(out.warnings.map((warning) => [warning.code, warning.message.includes('"b"'), warning.message.includes('"mail"')])).toEqual([
      ["mapping.unmappedValue", true, false],
      ["mapping.unmappedValue", false, true]
    ]);
    // "b" is named once although it is picked twice.
    expect(out.warnings[0]!.message.match(/"b"/g)).toHaveLength(1);
  });

  it("keeps a picked checkboxes key when an unpicked one is mapped onto its name, in either key order", async () => {
    const mapping: PdfFieldMapping = { pdfField: "Contact", source: { kind: "component", componentId: "contact" }, values: { email: "phone", phone: "P" } };
    // email is unpicked and maps to "phone", the name of a picked key: the picked one must stay.
    for (const answer of [{ email: false, phone: true }, { phone: true, email: false }]) {
      expect((await fill([mapping], { contact: answer })).values).toEqual({ Contact: ["P"] });
    }
    const swapped: PdfFieldMapping = { pdfField: "Contact", source: { kind: "component", componentId: "contact" }, values: { email: "phone" } };
    for (const answer of [{ email: false, phone: true }, { phone: true, email: false }]) {
      const out = await fill([swapped], { contact: answer });
      expect(out.values).toEqual({ Contact: ["phone"] });
      // The picked "phone" has no key of its own; the unpicked "email" says nothing.
      expect(out.warnings.map((warning) => warning.message.includes('"phone"') && !warning.message.includes('"email"'))).toEqual([true]);
    }
    // An inherited name is a key like any other, never read from the prototype.
    expect((await fill([mapping], { contact: { constructor: true, email: true } })).values).toEqual({ Contact: ["constructor", "phone"] });
  });

  it("turns a boolean answer into the group's value through the true and false keys", async () => {
    const mapping: PdfFieldMapping = { pdfField: "Working", source: { kind: "component", componentId: "working" }, values: { true: "1", false: "2" } };
    expect((await fill([mapping], { working: true })).values).toEqual({ Working: "1" });
    expect((await fill([mapping], { working: false })).values).toEqual({ Working: "2" });
    // An unanswered box has no answer to translate: it stays what it was, a cleared group.
    expect((await fill([mapping], {})).values).toEqual({ Working: false });
  });

  it("leaves a boolean as it is when the map names neither true nor false", async () => {
    const mapping: PdfFieldMapping = { pdfField: "Working", source: { kind: "component", componentId: "working" }, values: { yes: "1" } };
    const out = await fill([mapping], { working: true });
    expect(out.values).toEqual({ Working: true });
    expect(out.warnings).toEqual([]);
  });

  it("compares a checked value against the mapped answer", async () => {
    const out = await fill(
      [
        { pdfField: "IsImproved", source: { kind: "component", componentId: "change" }, values: CHANGE, checkedValue: "1" },
        { pdfField: "IsWorse", source: { kind: "component", componentId: "change" }, values: CHANGE, checkedValue: "3" },
        // The answer's own name no longer matches once it has been translated.
        { pdfField: "ByAnswer", source: { kind: "component", componentId: "change" }, values: CHANGE, checkedValue: "improved" },
        { pdfField: "WorkingOn", source: { kind: "component", componentId: "working" }, values: { true: "yes" }, checkedValue: "yes" },
        { pdfField: "WorkingTick", source: { kind: "component", componentId: "working" }, values: { yes: "x" }, checkedValue: "On" }
      ],
      { change: "improved", working: true }
    );
    expect(out.values).toEqual({ IsImproved: "1", IsWorse: false, ByAnswer: false, WorkingOn: "yes", WorkingTick: "On" });
  });

  it("maps a path source's value and an expression source's value, before the format", async () => {
    const out = await fill(
      [
        { pdfField: "FromPath", source: { kind: "path", path: "change" }, values: CHANGE },
        { pdfField: "FromFormula", source: { kind: "expression", expression: "if change = \"unchanged\" then \"better\" else \"other\"" }, values: { better: "B" } },
        { pdfField: "FromLiteral", source: { kind: "literal", value: true }, values: { true: "Yes" } },
        { pdfField: "FromText", source: { kind: "template", text: "{{name}}" }, values: { Ada: "ADA" } },
        { pdfField: "Formatted", source: { kind: "literal", value: true }, values: { true: "1" }, format: { kind: "number", pattern: "2" } }
      ],
      { change: "unchanged", name: "Ada" }
    );
    expect(out.values).toEqual({ FromPath: "2", FromFormula: "B", FromLiteral: "Yes", FromText: "ADA", Formatted: "1.00" });
    expect(out.warnings).toEqual([]);
  });

  it("changes nothing for a binding with no map, and for an empty or malformed one", async () => {
    const values = { change: "improved" };
    const plain = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "change" } }], values);
    expect(plain.values).toEqual({ Since: "improved" });
    for (const bad of [{}, [], "1", 7, null, { improved: 1, unchanged: null }] as unknown[]) {
      const out = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: bad as never }], values);
      expect(out.values).toEqual({ Since: "improved" });
      expect(out.warnings).toEqual([]);
    }
  });

  it("keeps the usable entries of a map that holds a bad one", async () => {
    const out = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { improved: "1", unchanged: 2, worsened: null } as never }], { change: "improved" });
    expect(out.values).toEqual({ Since: "1" });
    const rest = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { improved: "1", unchanged: 2 } as never }], { change: "unchanged" });
    expect(rest.values).toEqual({ Since: "unchanged" });
  });

  it("does not take an inherited name for a key", async () => {
    const out = await fill([{ pdfField: "Since", source: { kind: "component", componentId: "name" }, values: { Ada: "A" } }], { name: "constructor" });
    expect(out.values).toEqual({ Since: "constructor" });
    expect(out.warnings).toEqual([expect.objectContaining({ code: "mapping.unmappedValue" })]);
  });

  it("does not warn for a component the form hides", async () => {
    const hidden: ComponentNode = { ...form, children: { content: [{ id: "change", type: "radio", configuration: { label: "Change", hidden: true, options: [{ value: "improved" }] } }] } };
    const model = await buildPdfRenderModel(hidden, state({ change: "improved" }), resolver, {}, {
      layout: layoutOf([{ pdfField: "Since", source: { kind: "component", componentId: "change" }, values: { other: "1" } }])
    });
    expect(model.fill!.values).toEqual({ Since: null });
    expect(model.warnings).toEqual([]);
  });

  it("applies to an area, which shares the binding", async () => {
    const out = await fill(
      [],
      { change: "worsened" },
      [{ id: "worse", label: "Worse", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "component", componentId: "change" }, values: CHANGE, checkedValue: "3", draw: { kind: "check" } }]
    );
    expect(out.areas.map((area) => area.value)).toEqual(["3"]);
    const unmapped = await fill([], { change: "worsened" }, [{ id: "a", label: "Change", page: 1, rect: { x: 0, y: 0, width: 10, height: 10 }, source: { kind: "component", componentId: "change" }, values: { improved: "1" } }]);
    expect(unmapped.warnings).toEqual([expect.objectContaining({ code: "mapping.unmappedValue", message: expect.stringContaining('Area "Change"') })]);
  });
});

describe("readPdfValueMap", () => {
  it("keeps the string-to-string entries in order and nothing else", () => {
    expect([...readPdfValueMap({ b: "2", a: "1", c: 3, d: null })!]).toEqual([
      ["b", "2"],
      ["a", "1"]
    ]);
    expect(readPdfValueMap(undefined)).toBeUndefined();
    expect(readPdfValueMap({})).toBeUndefined();
    expect(readPdfValueMap([["a", "1"]])).toBeUndefined();
    expect(readPdfValueMap({ a: 1 })).toBeUndefined();
  });
});
