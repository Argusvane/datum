import { PDFDocument } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { MAX_INSPECTED_FIELDS, MAX_INSPECTED_PAGES, inspectTemplate } from "../src/kernel/template.js";

// The designer's template inspection lists a bounded number of pages and fields.
describe("inspectTemplate caps", () => {
  it("lists the first fields and says so when a template holds more", async () => {
    const pdf = await PDFDocument.create();
    const page = pdf.addPage([600, 800]);
    const form = pdf.getForm();
    for (let i = 0; i < 30; i += 1) {
      form.createTextField(`f${i}`).addToPage(page, { x: 10, y: 10, width: 20, height: 10 });
    }
    const info = await inspectTemplate(await pdf.save({ updateFieldAppearances: false }), { limits: { fields: 20 } });
    expect(info.fields).toHaveLength(20);
    expect(info.warnings?.some((warning) => warning.code === "template.truncated")).toBe(true);
  }, 120_000);

  it("lists the first pages and keeps the true page count", async () => {
    const pdf = await PDFDocument.create();
    for (let i = 0; i < 25; i += 1) {
      pdf.addPage([100, 100]);
    }
    const info = await inspectTemplate(await pdf.save(), { limits: { pages: 10 } });
    expect(info.pageCount).toBe(25);
    expect(info.pages).toHaveLength(10);
    expect(info.warnings?.some((warning) => warning.code === "template.truncated")).toBe(true);
  }, 60_000);

  it("the caps are 500 pages and 5,000 fields", () => {
    expect([MAX_INSPECTED_PAGES, MAX_INSPECTED_FIELDS]).toEqual([500, 5000]);
  });

  it("a small template is untouched", async () => {
    const pdf = await PDFDocument.create();
    pdf.addPage([100, 100]);
    const info = await inspectTemplate(await pdf.save());
    expect(info.pages).toHaveLength(1);
    expect(info.warnings).toBeUndefined();
  });
});
