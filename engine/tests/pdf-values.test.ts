import { describe, expect, it } from "vitest";

import type { RenderComponentModel } from "../form-engine/render/core/component-model.js";
import { formatPdfPlainValue, formatPdfValue, readCollectionRows, stripAnswerBidi } from "../form-engine/render/pdf/pdf-values.js";

function model(
  type: string,
  value: unknown,
  items: Array<{ value: string; label: string; description?: string }> = []
): RenderComponentModel {
  return {
    id: "x",
    type,
    valuePath: "x",
    node: { id: "x", type, configuration: {} },
    label: "X",
    description: undefined,
    placeholder: undefined,
    tooltip: undefined,
    pattern: undefined,
    minLength: undefined,
    maxLength: undefined,
    classNames: [],
    hideLabel: false,
    value,
    visible: true,
    disabled: false,
    readOnly: true,
    errors: [],
    accessibility: { fieldId: "x", labelId: "x-label", errorId: "x-error", descriptionId: "x-description", ariaDescribedBy: undefined, invalid: false, required: false },
    optionState: { componentId: "x", status: items.length > 0 ? "ready" : "not-applicable", items },
    parentId: undefined,
    slotId: undefined,
    depth: 0,
    containerPath: [],
    layout: { kind: "stack" },
    isLayoutContainer: false,
    buttonAction: undefined,
    buttonVariant: undefined,
    buttonSize: undefined,
    buttonSignature: undefined,
    staticHtml: undefined,
    image: undefined,
    file: undefined
  } as unknown as RenderComponentModel;
}

describe("formatPdfValue", () => {
  it("prints text, numbers and nothing", () => {
    expect(formatPdfValue(model("text", "hello"))).toEqual({ text: "hello", empty: false });
    expect(formatPdfValue(model("number", 3.5))).toEqual({ text: "3.5", empty: false });
    expect(formatPdfValue(model("text", ""))).toEqual({ text: "", empty: true });
    expect(formatPdfValue(model("text", undefined))).toEqual({ text: "", empty: true });
    expect(formatPdfValue(model("text", ["a", "b"]))).toEqual({ text: "a, b", empty: false });
    expect(formatPdfValue(model("date", { y: 1 }))).toEqual({ text: '{"y":1}', empty: false });
  });

  it("prints a checkbox as yes / no in the theme's words", () => {
    expect(formatPdfValue(model("checkbox", true))).toEqual({ text: "Yes", checked: true, empty: false });
    expect(formatPdfValue(model("checkbox", undefined), { yes: "Oui", no: "Non" })).toEqual({ text: "Non", checked: false, empty: false });
  });

  it("prints a choice by its option label and lists every option with the picked ones marked", () => {
    const items = [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }];
    expect(formatPdfValue(model("select", "FR", items))).toEqual({
      text: "France",
      items: [{ value: "CA", label: "Canada", checked: false }, { value: "FR", label: "France", checked: true }],
      empty: false
    });
    expect(formatPdfValue(model("radio", "ZZ", items)).text).toBe("ZZ");
    expect(formatPdfValue(model("select", undefined, items))).toMatchObject({ text: "", empty: true });
    expect(formatPdfValue(model("checkboxes", { CA: true, FR: false }, items))).toMatchObject({ text: "Canada", empty: false });
    expect(formatPdfValue(model("multiselect", ["CA", "FR"], items)).text).toBe("Canada, France");
  });

  it("prints a file's names and sizes, never its bytes", () => {
    const attachments = [
      { storage: "base64", name: "a.pdf", type: "application/pdf", size: 2048, data: "AAAA" },
      { storage: "base64", name: "b.png", type: "image/png", size: 10, data: "BBBB" }
    ];
    const formatted = formatPdfValue(model("file", attachments));
    expect(formatted.text).toContain("a.pdf");
    expect(formatted.text).toContain("b.png");
    expect(formatted.text).not.toContain("AAAA");
    expect(formatPdfValue(model("file", undefined))).toEqual({ text: "", empty: true });
  });

  it("formats a bare value as text", () => {
    expect(formatPdfPlainValue(undefined)).toBe("");
    expect(formatPdfPlainValue([1, "x"])).toBe("1, x");
    expect(formatPdfPlainValue(true)).toBe("true");
  });
});

describe("readCollectionRows", () => {
  it("rebuilds rows from flat indexed keys, in index order, and reads a whole array too", () => {
    expect(
      readCollectionRows(
        { "items[1].sku": "B", "items[0].sku": "A", "items[0].qty": 1, "other[0].x": 9, items2: "no", "items[2].qty": 3 },
        "items"
      )
    ).toEqual([{ sku: "A", qty: 1 }, { sku: "B" }, { qty: 3 }]);
    expect(readCollectionRows({ items: [{ sku: "A" }, { sku: "B" }] }, "items")).toEqual([{ sku: "A" }, { sku: "B" }]);
    expect(readCollectionRows({ items: "x" }, "items")).toEqual([]);
    expect(readCollectionRows({ "a.b[0].c": 1 }, "a.b")).toEqual([{ c: 1 }]);
  });

  it("keeps a data grid's empty row when the rows arrive whole, and a data-scoped cell under its dotted key", () => {
    // A submission hands the rows back as a list, an unfilled row included: it prints as a blank row.
    expect(readCollectionRows({ lines: [{ sku: "A" }, {}, { sku: "C" }] }, "lines")).toEqual([{ sku: "A" }, {}, { sku: "C" }]);
    // Flat keys name a cell inside a data-scoping container by its path within the entry.
    expect(readCollectionRows({ "lines[0].address.city": "Ottawa", "lines[1].address.city": "Hull" }, "lines")).toEqual([
      { "address.city": "Ottawa" },
      { "address.city": "Hull" }
    ]);
  });
});

describe("option descriptions on paper", () => {
  it("carries an option's hint into the choice items, and only where there is one", () => {
    const items = [
      { value: "personal", label: "Personal", description: "For you or your family" },
      { value: "business", label: "Business" }
    ];
    expect(formatPdfValue(model("radio", "business", items)).items).toEqual([
      { value: "personal", label: "Personal", checked: false, description: "For you or your family" },
      { value: "business", label: "Business", checked: true }
    ]);
    // The text a value prints as is still the label alone.
    expect(formatPdfValue(model("radio", "personal", items)).text).toBe("Personal");
  });
});

// the controls that reorder are stripped from an answer, balanced isolates stay.
describe("stripAnswerBidi", () => {
  it("removes embeddings and overrides, unclosed isolates and closers that open nothing; keeps balanced isolates", () => {
    expect(stripAnswerBidi("plain")).toBe("plain");
    expect(stripAnswerBidi("\u202Eevil\u202C and \u202A\u202B\u202D")).toBe("evil and ");
    expect(stripAnswerBidi("a\u2067b")).toBe("ab");
    expect(stripAnswerBidi("a\u2069b")).toBe("ab");
    expect(stripAnswerBidi("x \u2067\u05E9\u05DC\u05D5\u05DD\u2069 y")).toBe("x \u2067\u05E9\u05DC\u05D5\u05DD\u2069 y");
    expect(stripAnswerBidi("\u2068a\u2066b\u2069")).toBe("a\u2066b\u2069");
    expect(stripAnswerBidi("\u2069\u2066a\u2069")).toBe("\u2066a\u2069");
    expect(stripAnswerBidi("\u{1F600}\u202E\u{1F600}")).toBe("\u{1F600}\u{1F600}");
  });
  it("is applied to an answer's text and says so, but not to a yes or a no", () => {
    expect(formatPdfValue(model("text", "\u202Eabc"))).toEqual({ text: "abc", empty: false, bidiStripped: true });
    expect(formatPdfValue(model("text", "abc"))).toEqual({ text: "abc", empty: false });
    expect(formatPdfPlainValue(["\u2067x", "y"])).toBe("x, y");
  });
});
