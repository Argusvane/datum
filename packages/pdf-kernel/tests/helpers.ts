import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFString, StandardFonts } from "@cantoo/pdf-lib";
import { DEFAULT_PDF_PAGE_SETUP } from "@argusvane/datum-engine/core";
import type { PdfBlock, PdfDocument, PdfFontResource, PdfKernelEnv } from "@argusvane/datum-engine/render";
import { PDF_KERNEL_FALLBACKS } from "@argusvane/datum-engine/render";
import { loadFontPack } from "../src/fonts.js";

export const ENV: PdfKernelEnv = { createdAt: "2026-09-05T10:11:12.000Z", documentId: "fixture-doc", producer: "Datum tests" };

export const PDF_MAGIC = "%PDF-";

let fontsPromise: Promise<PdfFontResource[]> | undefined;

/** The default pack (DejaVu Sans), loaded once per test run. */
export function fonts(): Promise<PdfFontResource[]> {
  fontsPromise ??= loadFontPack();
  return fontsPromise;
}

export function document(blocks: PdfBlock[], overrides: Partial<PdfDocument> = {}): PdfDocument {
  return {
    version: "1",
    page: DEFAULT_PDF_PAGE_SETUP,
    metadata: { title: "Fixture", lang: "en", textDirection: "ltr" },
    accessibility: { tagged: true, displayDocTitle: true },
    // The kernel's own fallbacks: a document that says nothing about its geometry, as an older engine sends one.
    typography: PDF_KERNEL_FALLBACKS.typography,
    colors: PDF_KERNEL_FALLBACKS.colors,
    blocks,
    anchored: [],
    resources: { images: {} },
    ...overrides
  };
}

export function paragraph(id: string, text: string): PdfBlock {
  return { id, kind: "paragraph", runs: [{ text }], role: "P" };
}

export function head(bytes: Uint8Array, length = 5): string {
  return String.fromCharCode(...bytes.subarray(0, length));
}

/** Text per page, through pdf.js — the reader's view, ToUnicode maps applied. */
export async function extractText(bytes: Uint8Array): Promise<string[]> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const standardFontDataUrl = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl });
  const pdf = await task.promise;
  const pages: string[] = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    const content = await page.getTextContent();
    pages.push(
      content.items
        .map((item) => ("str" in item ? item.str : ""))
        .join(" ")
        .replace(/\s+/g, " ")
        .trim()
    );
  }
  await task.destroy();
  return pages;
}

/**
 * A template the way macOS re-saves one: every widget copied, the page listing the copies and
 * the field keeping the originals, `/P` on neither. The copies name their field the ways seen
 * in the wild — a text field's copy merged with the field (`/T`, no `/Parent`), a radio kid's
 * copy pointing `/Parent` at the field, a check box's copy saying nothing but its rectangle.
 * Two pages, the second with a widget at the first page's Name rectangle under another name,
 * so a rectangle alone cannot place a field; and one widget on no page at all, copy or not.
 */
export async function detachedTemplateBytes(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page1 = pdf.addPage([400, 400]);
  const page2 = pdf.addPage([400, 400]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const formApi = pdf.getForm();
  formApi.createTextField("Name").addToPage(page1, { x: 20, y: 340, width: 200, height: 20, font });
  const colour = formApi.createRadioGroup("Colour");
  colour.addOptionToPage("Red", page1, { x: 20, y: 260, width: 14, height: 14 });
  colour.addOptionToPage("Green", page1, { x: 60, y: 260, width: 14, height: 14 });
  formApi.createTextField("Other").addToPage(page2, { x: 20, y: 340, width: 200, height: 20, font });
  formApi.createCheckBox("Agree").addToPage(page2, { x: 20, y: 300, width: 14, height: 14 });
  formApi.createTextField("Lost").addToPage(page2, { x: 20, y: 200, width: 100, height: 20, font });
  for (const page of [page1, page2]) {
    const annots = page.node.Annots()!;
    for (let index = annots.size() - 1; index >= 0; index -= 1) {
      const original = annots.lookup(index, PDFDict);
      original.delete(PDFName.of("P"));
      const parent = original.lookup(PDFName.of("Parent"), PDFDict);
      const name = parent.lookup(PDFName.of("T"), PDFString, PDFHexString).decodeText();
      if (name === "Lost") {
        annots.remove(index);
        continue;
      }
      const copy = original.clone(pdf.context);
      if (name === "Name" || name === "Other") {
        copy.delete(PDFName.of("Parent"));
        copy.set(PDFName.of("T"), PDFString.of(name));
        copy.set(PDFName.of("FT"), PDFName.of("Tx"));
      } else if (name === "Agree") {
        copy.delete(PDFName.of("Parent"));
      }
      annots.set(index, pdf.context.register(copy));
    }
  }
  return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity, updateFieldAppearances: false });
}

/**
 * The widgets a viewer draws, page by page, through pdf.js: each page's `/Annots` with the
 * field name and value pdf.js reads for it — what a reader sees, as opposed to what the
 * AcroForm's field tree holds.
 */
export async function widgetsShown(bytes: Uint8Array): Promise<Array<{ page: number; name: string; value: unknown }>> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const { createRequire } = await import("node:module");
  const { dirname, join } = await import("node:path");
  const standardFontDataUrl = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "standard_fonts") + "/";
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: false, disableFontFace: true, standardFontDataUrl });
  const pdf = await task.promise;
  const shown: Array<{ page: number; name: string; value: unknown }> = [];
  for (let index = 1; index <= pdf.numPages; index += 1) {
    const page = await pdf.getPage(index);
    for (const annotation of (await page.getAnnotations()) as Array<{ subtype: string; fieldName?: string; fieldValue?: unknown }>) {
      if (annotation.subtype === "Widget") {
        shown.push({ page: index, name: annotation.fieldName ?? "", value: annotation.fieldValue });
      }
    }
  }
  await task.destroy();
  return shown;
}

/** The document reloaded with pdf-lib, for structural assertions. */
export async function reload(bytes: Uint8Array): Promise<PDFDocument> {
  return PDFDocument.load(bytes, { updateMetadata: false });
}

/** A 1×1 red PNG. */
export const RED_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";
