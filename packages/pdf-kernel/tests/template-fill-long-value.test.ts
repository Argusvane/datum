import { describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "@cantoo/pdf-lib";
import { bytesToBase64, buildPdfFillRequest } from "@argusvane/datum-engine/render";
import { createInProcessPdfProvider } from "../src/in-process-provider.js";
import { ENV, fonts } from "./helpers.js";

async function template(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const page = pdf.addPage([400, 400]);
  const form = pdf.getForm();
  form.createTextField("Name").addToPage(page, { x: 20, y: 340, width: 200, height: 20, font });
  const limited = form.createTextField("Lim");
  limited.setMaxLength(10);
  limited.addToPage(page, { x: 20, y: 160, width: 100, height: 20, font });
  const long = form.createTextField("Long");
  long.setMaxLength(8000);
  long.addToPage(page, { x: 20, y: 120, width: 300, height: 20, font });
  const huge = form.createTextField("Huge");
  huge.setMaxLength(50000);
  huge.addToPage(page, { x: 20, y: 80, width: 300, height: 20, font });
  const story = form.createTextField("Story");
  story.setMaxLength(8000);
  story.enableMultiline();
  story.addToPage(page, { x: 20, y: 10, width: 300, height: 60, font });
  return pdf.save({ useObjectStreams: false });
}

// A 64 KiB value must not make appearance regeneration fail for the form.
describe("filling a template field with a very long value", () => {
  it("cuts it with a field.overflow warning and still regenerates appearances", async () => {
    const bytes = await template();
    const plan = { layoutId: "t", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) }, values: { Name: "lorem ipsum dolor ".repeat(4000), Lim: "0123456789ABCDEF" }, areas: [], options: { flatten: false, readOnly: false, appearances: "regenerate" as const } };
    const provider = createInProcessPdfProvider();
    const res = await provider.fill!(buildPdfFillRequest(plan as never, bytes, await fonts(), ENV));
    expect(res.fields.map((f) => f.status)).toEqual(["filled", "filled"]);
    const codes = res.warnings.map((w) => w.code);
    expect(codes).toContain("field.overflow");
    expect(res.warnings.map((w) => w.message).join()).not.toContain("too many arguments");
    expect(res.warnings.map((w) => w.code)).not.toContain("template.appearances");
  }, 60_000);

  // The cut is the field's own /MaxLen (up to 32,000), 4096 only without one.
  it("keeps a long single-line value up to its /MaxLen, and caps a /MaxLen past 32,000", async () => {
    const bytes = await template();
    const plan = { layoutId: "t", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) }, values: { Long: "word ".repeat(1600), Huge: "x".repeat(40000) }, areas: [], options: { flatten: false, readOnly: false, appearances: "regenerate" as const } };
    const res = await createInProcessPdfProvider().fill!(buildPdfFillRequest(plan as never, bytes, await fonts(), ENV));
    expect(res.fields.map((f) => f.status)).toEqual(["filled", "filled"]);
    const overflow = res.warnings.filter((w) => w.code === "field.overflow").map((w) => w.message);
    expect(overflow.filter((m) => m.includes("characters; only"))).toHaveLength(1);
    expect(overflow.join()).toContain('"Huge" was given 40000 characters; only the first 32000 were set');
    expect(res.warnings.map((w) => w.code)).not.toContain("template.appearances");
  }, 60_000);

  it("still cuts a value at 4096 when the field declares no /MaxLen", async () => {
    const bytes = await template();
    // Appearances left to the viewer: laying out thousands of characters in a multi-line box is slow in pdf-lib.
    const plan = { layoutId: "t", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) }, values: { Name: "y".repeat(5000), Story: "z".repeat(8000) }, areas: [], options: { flatten: false, readOnly: false, appearances: "viewer" as const } };
    const res = await createInProcessPdfProvider().fill!(buildPdfFillRequest(plan as never, bytes, await fonts(), ENV));
    const said = res.warnings.map((w) => w.message).join();
    expect(said).toContain('"Name" was given 5000 characters; only the first 4096 were set');
    expect(said).not.toContain('"Story"');
  }, 60_000);

  // A long multi-line value keeps its whole /V; only the appearance is drawn from 1,000 characters.
  it("draws a multi-line appearance from at most 1,000 characters, keeps /V whole and sets NeedAppearances", async () => {
    const bytes = await template();
    const value = "lorem ipsum ".repeat(600);
    const plan = { layoutId: "t", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) }, values: { Story: value }, areas: [], options: { flatten: false, readOnly: false, appearances: "regenerate" as const } };
    const started = Date.now();
    const res = await createInProcessPdfProvider().fill!(buildPdfFillRequest(plan as never, bytes, await fonts(), ENV));
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(res.fields.map((f) => f.status)).toEqual(["filled"]);
    expect(res.warnings.map((w) => w.message).join()).toContain('Field "Story" holds 7200 characters');
    const out = await PDFDocument.load(res.bytes);
    expect(out.getForm().getTextField("Story").getText()).toBe(value);
    expect(out.getForm().acroForm.dict.get(PDFName.of("NeedAppearances"))?.toString()).toBe("true");
  }, 60_000);

  // A flattened page keeps no field, so the warning must not promise a redraw.
  it("says a flattened multi-line page draws only the first 1,000 characters", async () => {
    const bytes = await template();
    const value = "lorem ipsum ".repeat(300);
    const plan = { layoutId: "t", template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) }, values: { Story: value }, areas: [], options: { flatten: true, readOnly: false, appearances: "regenerate" as const } };
    const res = await createInProcessPdfProvider().fill!(buildPdfFillRequest(plan as never, bytes, await fonts(), ENV));
    expect(res.fields.map((f) => f.status)).toEqual(["filled"]);
    const said = res.warnings.filter((w) => w.code === "field.overflow").map((w) => w.message).join();
    expect(said).toContain('Field "Story" holds 3600 characters; the flattened page draws only the first 1000, the rest is not in the output.');
    expect(said).not.toContain("redraws");
    const out = await PDFDocument.load(res.bytes);
    expect(out.getForm().getFields().find((f) => f.getName() === "Story")).toBeUndefined();
  }, 60_000);
});
