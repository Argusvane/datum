import { describe, expect, it } from "vitest";

import { PDFName } from "@cantoo/pdf-lib";
import { DEFAULT_PDF_TYPOGRAPHY } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { ENV, PDF_MAGIC, RED_PNG_BASE64, document, extractText, fonts, head, paragraph, reload } from "./helpers.js";

describe("renderDocument", () => {
  it("writes a PDF with the document's text, metadata and identity, the same bytes every time", async () => {
    const doc = document(
      [
        { id: "h", kind: "heading", level: 1, runs: [{ text: "Customer Intake" }] },
        { id: "lv", kind: "labelValue", label: "First name", value: [{ text: "Ada" }], arrangement: "stacked" },
        paragraph("p", "Thank you for your application — we will be in touch.")
      ],
      { metadata: { title: "Intake", lang: "en-CA", textDirection: "ltr", subject: "Forms", author: "Datum", keywords: ["a", "b"] } }
    );
    const first = await renderDocument(doc, await fonts(), ENV);
    const second = await renderDocument(doc, await fonts(), ENV);
    expect(head(first.bytes)).toBe(PDF_MAGIC);
    expect(Buffer.compare(Buffer.from(first.bytes), Buffer.from(second.bytes))).toBe(0);
    expect(first.pages).toHaveLength(1);
    expect(first.pages[0]!.blockIds).toEqual(["h", "lv", "p"]);
    expect(first.warnings).toEqual([]);

    const text = await extractText(first.bytes);
    expect(text[0]).toContain("Customer Intake");
    expect(text[0]).toContain("First name");
    expect(text[0]).toContain("Ada");
    expect(text[0]).toContain("we will be in touch");

    const pdf = await reload(first.bytes);
    expect(pdf.getTitle()).toBe("Intake");
    expect(pdf.getSubject()).toBe("Forms");
    expect(pdf.getAuthor()).toBe("Datum");
    expect(pdf.getProducer()).toBe("Datum tests");
    expect(pdf.getCreator()).toBe("Datum");
    expect(pdf.getCreationDate()?.toISOString()).toBe("2026-09-05T10:11:12.000Z");
    expect(pdf.catalog.get(PDFName.of("Lang"))?.toString()).toBe("(en-CA)");
    const id = pdf.context.trailerInfo.ID?.toString();
    expect(id).toMatch(/^\[ ?<[0-9a-f]{32}> <[0-9a-f]{32}> ?\]$/);
    expect(pdf.getPage(0).node.get(PDFName.of("Tabs"))?.toString()).toBe("/S");
  });

  it("changes the identity with the document id and the dates with the instant, nothing else", async () => {
    const doc = document([paragraph("p", "Same content")]);
    const a = await renderDocument(doc, await fonts(), ENV);
    const b = await renderDocument(doc, await fonts(), { ...ENV, documentId: "another" });
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).not.toBe(0);
    expect(a.bytes.length).toBe(b.bytes.length);
  });

  it("falls back to the standard fonts without resources and says which characters it could not draw", async () => {
    const doc = document([paragraph("p", "Plain text → with an arrow and Arabic مرحبا")]);
    const rendered = await renderDocument(doc, [], ENV);
    expect(head(rendered.bytes)).toBe(PDF_MAGIC);
    expect(rendered.warnings.map((w) => w.code)).toEqual(["font.unencodable"]);
    const text = await extractText(rendered.bytes);
    expect(text[0]).toContain("Plain text ?");
  });

  it("embeds and subsets a font with its glyphs, and draws Arabic and Hebrew through it", async () => {
    const doc = document([paragraph("p", "Hello مرحبا שלום")]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const pdf = await reload(rendered.bytes);
    const fontNames = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object.toString())
      .filter((text) => text.includes("/BaseFont"))
      .join("\n");
    expect(fontNames).toContain("DatumFont1");
    // A subset is small: nowhere near DejaVu Sans's 700 KB.
    expect(rendered.bytes.length).toBeLessThan(120_000);
    const text = await extractText(rendered.bytes);
    expect(text[0]).toContain("Hello");
    expect(text[0]).toContain("مرحبا");
  });

  it("draws a script the main font lacks with the theme's fallback family for it", async () => {
    const pack = await fonts();
    // The serif family (DejaVu Serif) has no Arabic; the sans family does. The theme names it as the Arabic fallback.
    const doc = document([paragraph("p", "Serif text with Arabic مرحبا inside")], {
      typography: { ...DEFAULT_PDF_TYPOGRAPHY, body: { family: "serif", size: 10, lineHeight: 1.35 }, fallbacks: { Arab: "sans-serif" } }
    });
    const rendered = await renderDocument(doc, pack, ENV);
    expect(rendered.warnings).toEqual([]);
    const pdf = await reload(rendered.bytes);
    const fontNames = pdf.context
      .enumerateIndirectObjects()
      .map(([, object]) => object.toString())
      .filter((text) => text.includes("/BaseFont"))
      .join("\n");
    // Two embedded fonts: the serif for the Latin, the sans for the Arabic run.
    expect(fontNames).toContain("DatumFont1");
    expect(fontNames).toContain("DatumFont2");
    const text = await extractText(rendered.bytes);
    expect(text[0]).toContain("Serif text with Arabic");
    expect(text[0]).toContain("مرحبا");
  });

  it("embeds images from bytes and skips what the host left as a URL", async () => {
    const doc = document(
      [
        { id: "img", kind: "image", resourceId: "logo", alt: "Logo", width: 50 },
        { id: "missing", kind: "image", resourceId: "remote", alt: "Remote" }
      ],
      { resources: { images: { logo: { type: "image/png", data: RED_PNG_BASE64 }, remote: { url: "https://example.test/x.png" } } } }
    );
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings.map((w) => w.code).sort()).toEqual(["image.unavailable", "image.unresolved"]);
    expect(rendered.pages[0]!.blockIds).toEqual(["img"]);
    const pdf = await reload(rendered.bytes);
    expect(pdf.getPage(0).node.Resources()?.toString()).toContain("/XObject");
  });

  it("writes object streams when asked to be compact", async () => {
    const doc = document([paragraph("p", "compact")]);
    const plain = await renderDocument(doc, await fonts(), ENV);
    const compact = await renderDocument(doc, await fonts(), ENV, { compact: true });
    expect(head(compact.bytes)).toBe(PDF_MAGIC);
    expect(compact.bytes.length).toBeLessThan(plain.bytes.length);
    expect(Buffer.from(compact.bytes).toString("latin1")).toContain("/ObjStm");
  });
});
