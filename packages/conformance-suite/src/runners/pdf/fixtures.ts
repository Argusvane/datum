import { PDF_ABI_VERSION, bytesToBase64, deriveDefaultPdfLayout, type PdfDocumentRequest, type PdfFontResource, type PdfKernelEnv } from "@argusvane/datum-engine/render";
import type { ComponentNode } from "@argusvane/datum-engine/core";

import { loadPdfLib } from "./libs.js";

/** A fixed environment, so two runs of one request are comparable byte for byte. */
export const ENV: PdfKernelEnv = { createdAt: "2026-09-05T10:11:12.000Z", documentId: "security-suite-pdf", producer: "datum-security-check" };

/**
 * Hostile answers: each one tries to end a PDF string, close a
 * dictionary, open an action, smuggle a second object, or confuse the text layer. They are
 * ordinary text answers; the document must draw them as text and nothing else.
 */
export const HOSTILE: Readonly<Record<string, string>> = {
  paren: "a) Tj ET /Evil gs (b",
  backslash: "x\\) \\( \\n \\000 \\\\",
  dict: ">> /S /JavaScript /JS (app.alert(1)) >> <<",
  stream: "endstream\nendobj\n99 0 obj\n<< /Type /Catalog /OpenAction << /S /JavaScript /JS (x) >> >>\nendobj",
  nul: "a\u0000b",
  surrogate: "lone\uD800hi\uDC00lo",
  bidi: "‮evil‬ and ⁧x",
  zerowidth: "a​b‍c﻿d⁠e",
  tokens: "{{page}} of {{pages}} {{host.x}} {{f}}",
  eof: "%PDF-1.7 %%EOF startxref 0"
};

/** Answers whose text must come back from the text layer as typed (no characters a font may lack). */
export const TEXT_KEYS = ["paren", "backslash", "dict", "tokens", "eof"] as const;

export function formWith(children: unknown[], configuration: Record<string, unknown> = { title: "Security suite" }): ComponentNode {
  return { id: "f", type: "form", configuration, children: { content: children } } as never;
}

export function textForm(ids: readonly string[]): ComponentNode {
  return formWith(ids.map((id) => ({ id, type: "text", configuration: { label: id } })));
}

export function documentRequest(form: ComponentNode, values: Record<string, unknown>, fonts: PdfFontResource[], extra: Partial<PdfDocumentRequest> = {}): PdfDocumentRequest {
  return { abi: PDF_ABI_VERSION, op: "document", form, values, locale: "en", fonts, env: ENV, ...extra };
}

export function upload(name: string, type = "text/plain", body = "hello"): Record<string, unknown> {
  return { storage: "base64", name, type, size: body.length, data: Buffer.from(body).toString("base64") };
}

/** An envelope that lies about its size: declared 0, carrying `bytes` decoded bytes. */
export function liar(name: string, bytes: number): Record<string, unknown> {
  return { storage: "base64", name, type: "application/octet-stream", size: 0, data: Buffer.alloc(bytes, 7).toString("base64") };
}

export const fileForm = formWith([{ id: "doc", type: "file", configuration: { label: "Doc", storage: "base64", pdf: { attach: true } } }]);

export { deriveDefaultPdfLayout };

/** A template with a pre-filled field ("Pre"), a capped field ("Short", /MaxLen 8) and an empty one ("Other"). */
export async function templateBytes(): Promise<Uint8Array> {
  const lib = await loadPdfLib();
  const pdf = await lib.PDFDocument.create({ updateMetadata: false });
  const font = await pdf.embedFont(lib.StandardFonts.Helvetica);
  const page = pdf.addPage([400, 240]);
  const form = pdf.getForm();
  const pre = form.createTextField("Pre");
  pre.setText("OLDVALUE-FROM-TEMPLATE");
  pre.addToPage(page, { x: 20, y: 190, width: 300, height: 20, font });
  const short = form.createTextField("Short");
  short.setMaxLength(8);
  short.addToPage(page, { x: 20, y: 150, width: 300, height: 20, font });
  form.createTextField("Other").addToPage(page, { x: 20, y: 110, width: 300, height: 20, font });
  return new Uint8Array(await pdf.save({ useObjectStreams: false, objectsPerTick: Infinity }));
}

export function fillPlan(bytes: Uint8Array, values: Record<string, unknown>, appearances: "viewer" | "regenerate") {
  return {
    layoutId: "t",
    template: { storage: "base64", name: "t.pdf", type: "application/pdf", size: bytes.length, data: bytesToBase64(bytes) },
    values,
    areas: [],
    options: { flatten: false, readOnly: false, appearances }
  };
}
