import { PDFDocument, StandardFonts, degrees } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import type { PdfFillArea } from "@argusvane/datum-engine/render";
import { fillTemplate, inspectTemplate } from "../src/kernel/template.js";
import { ENV, fonts } from "./helpers.js";
import { FILL_OPTIONS } from "./pdfa-fixtures.js";

/**
 * Pages shown cropped or turned: what `inspect` reports and where an area lands
 * must be the page as pdf.js shows it, the designer's viewer, not the media box unturned.
 */
async function turnedTemplate(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const form = pdf.getForm();
  const turned = pdf.addPage([612, 792]);
  turned.setRotation(degrees(90));
  form.createTextField("Turned").addToPage(turned, { x: 100, y: 500, width: 200, height: 20, font });
  const cropped = pdf.addPage([612, 792]);
  cropped.setCropBox(36, 36, 540, 720);
  form.createTextField("Cropped").addToPage(cropped, { x: 100, y: 500, width: 200, height: 20, font });
  const upside = pdf.addPage([400, 300]);
  upside.setRotation(degrees(180));
  pdf.addPage([300, 200]).setRotation(degrees(270));
  return pdf.save({ useObjectStreams: false });
}

async function pdfjsDocument(bytes: Uint8Array) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const standardFontDataUrl = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl });
  return { pdf: await task.promise, pdfjs, task };
}

/** pdf.js's rectangle, top-down on the displayed page, for a user-space `[x1 y1 x2 y2]` (through the viewport's transform). */
function shown(viewport: { transform: number[] }, rect: number[]) {
  const [a, b, c, d, e, f] = viewport.transform as [number, number, number, number, number, number];
  const point = (x: number, y: number) => [a * x + c * y + e, b * x + d * y + f] as const;
  const [x1, y1] = point(rect[0]!, rect[1]!);
  const [x2, y2] = point(rect[2]!, rect[3]!);
  return { x: Math.min(x1, x2), y: Math.min(y1, y2), width: Math.abs(x2 - x1), height: Math.abs(y2 - y1) };
}

const near = (a: number, b: number) => expect(Math.abs(a - b)).toBeLessThan(0.01);

describe("template pages as shown (cropped, turned)", () => {
  it("reports each page's size and each field's box as pdf.js shows them", async () => {
    const bytes = await turnedTemplate();
    const info = await inspectTemplate(bytes);
    const { pdf, task } = await pdfjsDocument(bytes);
    for (const entry of info.pages) {
      const viewport = (await pdf.getPage(entry.index)).getViewport({ scale: 1 });
      near(entry.width, viewport.width);
      near(entry.height, viewport.height);
    }
    for (const field of info.fields) {
      const page = await pdf.getPage(field.page!);
      const viewport = page.getViewport({ scale: 1 });
      const annotation = ((await page.getAnnotations()) as Array<{ fieldName?: string; rect: number[] }>).find((entry) => entry.fieldName === field.name)!;
      const expected = shown(viewport, annotation.rect);
      const pageInfo = info.pages[field.page! - 1]!;
      // The ABI's boxes are bottom-up: flipped by the displayed height, they are pdf.js's.
      near(field.rect!.x, expected.x);
      near(pageInfo.height - field.rect!.y - field.rect!.height, expected.y);
      near(field.rect!.width, expected.width);
      near(field.rect!.height, expected.height);
    }
    await task.destroy();
  });

  it("prints an area where it was drawn on the shown page, turned or cropped, text and fillable field alike", async () => {
    const bytes = await turnedTemplate();
    const draw: PdfFillArea["draw"] = { kind: "text", fontSize: 10, align: "start", valign: "top", padding: 2, wrap: true, bold: false };
    const areas: PdfFillArea[] = [1, 2, 3, 4].flatMap((page) => [
      { id: `text_${page}`, page, rect: { x: 30, y: 40, width: 150, height: 30 }, value: `Answer ${page}`, draw },
      { id: `field_${page}`, page, rect: { x: 30, y: 100, width: 120, height: 20 }, value: `Filled ${page}`, draw, field: { name: `Area field ${page}`, required: false, readOnly: false } }
    ]);
    const filled = await fillTemplate(bytes, {}, FILL_OPTIONS, await fonts(), ENV, areas);
    expect(filled.areas?.map((report) => report.status)).toEqual(areas.map(() => "filled"));
    const { pdf, pdfjs, task } = await pdfjsDocument(filled.bytes);
    for (const pageIndex of [1, 2, 3, 4]) {
      const page = await pdf.getPage(pageIndex);
      const viewport = page.getViewport({ scale: 1 });
      // The text: its first glyph's origin, on the shown page, inside the area's box.
      const item = (await page.getTextContent()).items.find((entry) => "str" in entry && entry.str.startsWith(`Answer ${pageIndex}`)) as { transform: number[] } | undefined;
      expect(item, `text on page ${pageIndex}`).toBeDefined();
      const matrix = pdfjs.Util.transform(viewport.transform, item!.transform);
      const [x, y] = [matrix[4]!, matrix[5]!];
      expect(x).toBeGreaterThanOrEqual(30);
      expect(x).toBeLessThanOrEqual(180);
      expect(y).toBeGreaterThanOrEqual(40);
      expect(y).toBeLessThanOrEqual(70);
      // Upright on the shown page: the glyphs run left to right, not up or down.
      expect(Math.abs(matrix[0]!)).toBeGreaterThan(0.5);
      expect(Math.abs(matrix[1]!)).toBeLessThan(0.01);
      // The fillable area's widget: its box is the area's.
      const widget = ((await page.getAnnotations()) as Array<{ fieldName?: string; rect: number[] }>).find((entry) => entry.fieldName === `Area field ${pageIndex}`)!;
      const box = shown(viewport, widget.rect);
      near(box.x, 30);
      near(box.y, 100);
      near(box.width, 120);
      near(box.height, 20);
    }
    await task.destroy();
  });
});
