/**
 * A PDF is drawn from answers a draft or a host can write, and from a template a definition
 * carries: a value that is not a scalar (an object whose toString is not a function, a list of
 * them) or a literal of that shape must print empty or as its JSON, never throw out of the fill.
 */
import { describe, expect, it } from "vitest";

import type { PdfFieldMapping, PdfTemplateLayout } from "../form-engine/core/schema/pdf-layout.js";
import type { RenderComponentModel } from "../form-engine/render/core/component-model.js";
import { formatPdfValue } from "../form-engine/render/pdf/pdf-values.js";
import { resolveFieldMappings } from "../form-engine/render/pdf/pdf-template.js";

const hostile = (): unknown => JSON.parse('{"toString":"x"}');
const items = [{ value: "a", label: "A" }];

function model(type: string, value: unknown, options: Array<{ value: string; label: string }> = []): RenderComponentModel {
  return {
    id: "x",
    type,
    valuePath: "x",
    node: { id: "x", type, configuration: {} },
    label: "X",
    value,
    visible: true,
    errors: [],
    optionState: { componentId: "x", status: options.length > 0 ? "ready" : "not-applicable", items: options },
    classNames: []
  } as unknown as RenderComponentModel;
}

describe("formatPdfValue with answers that are not scalars", () => {
  it.each([
    ["a text field", "text", []],
    ["a number field", "number", []],
    ["a select", "select", items],
    ["a radio group", "radio", items],
    ["a checkboxes group", "checkboxes", items]
  ] as const)("%s draws %s answers without throwing", (_name, type, options) => {
    for (const value of [hostile(), [hostile()], { a: hostile() }]) {
      expect(() => formatPdfValue(model(type, value, [...options]))).not.toThrow();
      expect(typeof formatPdfValue(model(type, value, [...options])).text).toBe("string");
    }
  });

  it("a localized answer whose locale entry is not text falls back to its default", () => {
    const stored = { default: "d", locales: { en: JSON.parse('{"toString":1}'), fr: 5 } };
    for (const locale of ["en", "fr"]) {
      const formatted = formatPdfValue(model("text", stored), undefined, stored, locale);
      expect(formatted.text).toBe("d");
      expect(formatted.empty).toBe(false);
    }
  });

  it("a localized answer still reads its own language", () => {
    const stored = { default: "d", locales: { fr: "bonjour" } };
    expect(formatPdfValue(model("text", stored), undefined, stored, "fr").text).toBe("bonjour");
  });
});

describe("a template mapping with a value that is not a scalar", () => {
  const layout = (source: unknown): PdfTemplateLayout => ({
    id: "tpl",
    kind: "template",
    template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: 4, data: "JVBERg==" },
    fields: [{ pdfField: "F", source } as PdfFieldMapping]
  });
  const context = (value: unknown, options: Array<{ value: string; label: string }> = []) => ({
    modelsById: new Map([["x", model(options.length > 0 ? "select" : "text", value, options)]]),
    values: { x: value },
    locale: "en",
    texts: { yes: "Yes", no: "No" }
  });

  it("a component source holding such an answer fills without throwing", () => {
    for (const value of [hostile(), [hostile()]]) {
      expect(() => resolveFieldMappings(layout({ kind: "component", componentId: "x" }), context(value))).not.toThrow();
      expect(() => resolveFieldMappings(layout({ kind: "component", componentId: "x" }), context(value, items))).not.toThrow();
      expect(() => resolveFieldMappings(layout({ kind: "path", path: "x" }), context(value))).not.toThrow();
    }
  });

  it("a literal source that is an object prints empty, not an exception", () => {
    expect(() => resolveFieldMappings(layout({ kind: "literal", value: hostile() }), context(""))).not.toThrow();
    expect(resolveFieldMappings(layout({ kind: "literal", value: hostile() }), context("")).values.F).toBe("");
  });

  it("an ordinary literal keeps its text, a boolean stays a boolean and null stays null", () => {
    expect(resolveFieldMappings(layout({ kind: "literal", value: "hi" }), context("")).values.F).toBe("hi");
    expect(resolveFieldMappings(layout({ kind: "literal", value: 3 }), context("")).values.F).toBe("3");
    expect(resolveFieldMappings(layout({ kind: "literal", value: true }), context("")).values.F).toBe(true);
    expect(resolveFieldMappings(layout({ kind: "literal", value: null }), context("")).values.F).toBeNull();
  });
});
