import { describe, expect, it } from "vitest";

import type { PdfDocument } from "@argusvane/datum-engine/render";
import { PDF_KERNEL_FALLBACKS } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { ENV, document, extractText, fonts, paragraph } from "./helpers.js";

const latin1 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("latin1");

/** A document whose body is set in a named family. */
function inFamily(family: string, overrides: Partial<PdfDocument> = {}): PdfDocument {
  const typography = { ...PDF_KERNEL_FALLBACKS.typography, body: { ...PDF_KERNEL_FALLBACKS.typography.body, family } };
  return document([paragraph("p", "Un déjà vu — Ωmega")], { typography, ...overrides });
}

describe("a family no font resource covers", () => {
  it("is drawn in the default pack's embedded face, with one warning, not in Helvetica", async () => {
    const rendered = await renderDocument(inFamily("Noto Sans"), await fonts(), ENV);
    expect(rendered.warnings).toEqual([{ code: "font.fallback_default", message: expect.stringContaining('"Noto Sans"') }]);
    const raw = latin1(rendered.bytes);
    expect(raw).not.toContain("/BaseFont /Helvetica");
    expect(raw).toContain("/BaseFont /DatumFont1");
    // The default face covers the text, so the reader gets all of it.
    expect((await extractText(rendered.bytes))[0]).toContain("Un déjà vu — Ωmega");
  });

  it("falls back to Helvetica only when the host supplied no default pack", async () => {
    const rendered = await renderDocument(inFamily("Noto Sans"), [], ENV);
    expect(rendered.warnings.map((warning) => warning.code)).toContain("font.fallback_standard14");
    expect(latin1(rendered.bytes)).toContain("/BaseFont /Helvetica");
  });

  it("is also embedded under PDF/A, where a standard font would refuse the document", async () => {
    const doc = inFamily("Noto Sans", { conformance: { pdfa: "2b" } } as Partial<PdfDocument>);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings.map((warning) => warning.code)).toContain("font.fallback_default");
    expect(latin1(rendered.bytes)).not.toContain("/BaseFont /Helvetica");
  });
});
