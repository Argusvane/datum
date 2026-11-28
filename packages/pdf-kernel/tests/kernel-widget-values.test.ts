import { describe, expect, it } from "vitest";

import { PDFDict, PDFName } from "@cantoo/pdf-lib";
import { renderDocument } from "../src/kernel/render.js";
import { ENV, document, fonts, reload } from "./helpers.js";

/** The names a checkbox widget's normal appearance offers, the off state included. */
function appearanceStates(widget: { dict: PDFDict }): string[] {
  const normal = widget.dict.lookup(PDFName.of("AP"), PDFDict).lookup(PDFName.of("N"), PDFDict);
  return normal.keys().map((key) => key.asString());
}

describe("a checkbox widget's export value", () => {
  it("names the on state, so each option exports its own value rather than /Yes", async () => {
    const doc = document([
      { id: "a", kind: "widget", label: "Cat", labelPosition: "after", field: { name: "pets.cat", kind: "checkbox", value: true, exportValue: "cat" } },
      { id: "b", kind: "widget", label: "U.S.", labelPosition: "after", field: { name: "pets.U%2ES%2E", kind: "checkbox", value: false, exportValue: "U.S. #1 é" } },
      { id: "c", kind: "widget", label: "Agree", labelPosition: "after", field: { name: "agree", kind: "checkbox", value: true } }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const form = (await reload(rendered.bytes)).getForm();

    const cat = form.getCheckBox("pets.cat");
    expect(cat.isChecked()).toBe(true);
    expect(cat.acroField.getOnValue()?.asString()).toBe("/cat");
    expect(cat.acroField.dict.get(PDFName.of("V"))?.toString()).toBe("/cat");
    expect(cat.acroField.getWidgets()[0]!.getAppearanceState()?.asString()).toBe("/cat");
    expect(appearanceStates(cat.acroField.getWidgets()[0]!).sort()).toEqual(["/Off", "/cat"]);

    const us = form.getCheckBox("pets.U%2ES%2E");
    expect(us.isChecked()).toBe(false);
    // UTF-8 bytes, `#` and the space escaped as the name syntax wants.
    expect(us.acroField.getOnValue()?.asString()).toBe("/U.S.#20#231#20#C3#A9");

    // No export value: the default on state.
    const agree = form.getCheckBox("agree");
    expect(agree.isChecked()).toBe(true);
    expect(agree.acroField.getOnValue()?.asString()).toBe("/Yes");
  });
});

describe("a text widget's length limit", () => {
  it("is widened to a value longer in UTF-16 units than the limit, so the widget and its value are kept", async () => {
    const doc = document([
      { id: "a", kind: "widget", label: "Emoji", field: { name: "emo", kind: "text", maxLength: 3, value: "\u{1F600}\u{1F600}\u{1F600}" } },
      { id: "b", kind: "widget", label: "Code", field: { name: "code", kind: "text", maxLength: 5, value: "ABC" } }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings.filter((warning) => warning.code === "widget.failed")).toEqual([]);
    const form = (await reload(rendered.bytes)).getForm();
    expect(form.getTextField("emo").getText()).toBeDefined();
    expect(form.getTextField("emo").getMaxLength()).toBeGreaterThanOrEqual(form.getTextField("emo").getText()!.length);
    expect(form.getTextField("code").getMaxLength()).toBe(5);
  });
});

describe("a choice widget's value no option lists", () => {
  it("is kept as an option of its own and picked", async () => {
    const doc = document([
      { id: "a", kind: "widget", label: "Size", field: { name: "size", kind: "dropdown", value: "xl", options: [{ value: "s", label: "Small" }] } },
      { id: "b", kind: "widget", label: "Toppings", field: { name: "toppings", kind: "listbox", value: ["a", "z"], options: [{ value: "a", label: "Olives" }] } }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const form = (await reload(rendered.bytes)).getForm();
    expect(form.getDropdown("size").getOptions()).toEqual(["Small", "xl"]);
    expect(form.getDropdown("size").getSelected()).toEqual(["xl"]);
    expect(form.getOptionList("toppings").getSelected()).toEqual(["Olives", "z"]);
  });
});
