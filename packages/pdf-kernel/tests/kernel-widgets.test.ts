import { describe, expect, it } from "vitest";

import { PDFCheckBox, PDFDropdown, PDFHexString, PDFName, PDFOptionList, PDFRadioGroup, PDFTextField } from "@cantoo/pdf-lib";
import { renderDocument } from "../src/kernel/render.js";
import { ENV, document, fonts, reload } from "./helpers.js";

describe("AcroForm widgets", () => {
  it("creates every field kind with its value, and two widgets for one name", async () => {
    const doc = document([
      { id: "w1", kind: "widget", label: "First name", field: { name: "applicant.first", kind: "text", value: "Ada", required: true, maxLength: 40, tooltip: "Given name" } },
      { id: "w2", kind: "widget", label: "Notes", field: { name: "notes", kind: "multiline", value: "Line one\nLine two" } },
      { id: "w3", kind: "widget", label: "I agree", labelPosition: "after", field: { name: "agree", kind: "checkbox", value: true } },
      { id: "w4", kind: "widget", label: "Colour", field: { name: "colour", kind: "radio", value: "g", options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }] } },
      { id: "w5", kind: "widget", label: "Country", field: { name: "country", kind: "dropdown", value: "CA", options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] } },
      { id: "w6", kind: "widget", label: "Toppings", field: { name: "toppings", kind: "listbox", value: ["a", "c"], options: [{ value: "a", label: "Olives" }, { value: "b", label: "Onions" }, { value: "c", label: "Peppers" }] } },
      { id: "w7", kind: "widget", label: "Signature", field: { name: "sig", kind: "signature" } },
      { id: "w8", kind: "widget", label: "First name again", field: { name: "applicant.first", kind: "text", value: "Ada" } },
      { id: "w9", kind: "widget", label: "Read only", field: { name: "ro", kind: "text", value: "fixed", readOnly: true } }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const pdf = await reload(rendered.bytes);
    const form = pdf.getForm();

    const first = form.getTextField("applicant.first");
    expect(first.getText()).toBe("Ada");
    expect(first.isRequired()).toBe(true);
    expect(first.getMaxLength()).toBe(40);
    expect(first.acroField.getWidgets()).toHaveLength(2);
    expect((first.acroField.dict.get(PDFName.of("TU")) as PDFHexString).decodeText()).toBe("Given name");

    expect(form.getTextField("notes").isMultiline()).toBe(true);
    expect(form.getTextField("notes").getText()).toBe("Line one\nLine two");
    expect(form.getCheckBox("agree").isChecked()).toBe(true);
    expect(form.getRadioGroup("colour").getSelected()).toBe("g");
    expect(form.getRadioGroup("colour").getOptions()).toEqual(["r", "g"]);
    expect(form.getDropdown("country").getSelected()).toEqual(["Canada"]);
    expect(form.getOptionList("toppings").getSelected()).toEqual(["Olives", "Peppers"]);
    expect(form.getTextField("ro").isReadOnly()).toBe(true);

    const kinds = form.getFields().map((field) => [field.getName(), field.constructor.name]);
    expect(kinds).toContainEqual(["applicant.first", PDFTextField.name]);
    expect(kinds).toContainEqual(["agree", PDFCheckBox.name]);
    expect(kinds).toContainEqual(["colour", PDFRadioGroup.name]);
    expect(kinds).toContainEqual(["country", PDFDropdown.name]);
    expect(kinds).toContainEqual(["toppings", PDFOptionList.name]);
    const signature = form.getField("sig");
    expect(signature.acroField.dict.get(PDFName.of("FT"))?.toString()).toBe("/Sig");
    // Widgets have appearances, so every viewer shows the same thing.
    expect(first.acroField.getWidgets()[0]!.getAppearances()).toBeDefined();
  });

  it("reports a field it could not create instead of failing the document", async () => {
    const doc = document([
      { id: "w1", kind: "widget", field: { name: "dup", kind: "text", value: "a" } },
      { id: "w2", kind: "widget", field: { name: "dup", kind: "checkbox", value: true } }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([expect.objectContaining({ code: "widget.failed" })]);
    const pdf = await reload(rendered.bytes);
    expect(pdf.getForm().getTextField("dup").getText()).toBe("a");
  });
});
