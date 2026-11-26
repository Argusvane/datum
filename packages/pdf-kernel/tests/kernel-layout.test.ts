import { describe, expect, it } from "vitest";

import { resolvePdfPageSetup } from "@argusvane/datum-engine/core";
import type { PdfAnchoredBox, PdfBlock } from "@argusvane/datum-engine/render";
import { layoutOnly, renderDocument } from "../src/kernel/render.js";
import { ENV, document, extractText, fonts, paragraph } from "./helpers.js";

const LONG = "The quick brown fox jumps over the lazy dog. ".repeat(12);

function paragraphs(count: number, prefix = "p"): PdfBlock[] {
  return Array.from({ length: count }, (_, index) => paragraph(`${prefix}${index + 1}`, `${index + 1}. ${LONG}`));
}

describe("pagination", () => {
  it("flows paragraphs across pages and reports which blocks landed where", async () => {
    const doc = document(paragraphs(30));
    const laid = await layoutOnly(doc, await fonts());
    expect(laid.pages.length).toBeGreaterThan(2);
    const all = laid.pages.flatMap((page) => page.blockIds);
    expect(new Set(all).size).toBe(30);
    expect(laid.pages[0]!.blockIds[0]).toBe("p1");
    expect(laid.pages[laid.pages.length - 1]!.blockIds).toContain("p30");
    expect(laid.pages.every((page) => page.width === 612 && page.height === 792)).toBe(true);
  });

  it("breaks the page on demand and lets the pages that follow change size", async () => {
    const landscape = resolvePdfPageSetup({ size: "A4", orientation: "landscape" });
    const doc = document([paragraph("a", "first"), { id: "brk", kind: "pageBreak", page: landscape }, paragraph("b", "second")]);
    const laid = await layoutOnly(doc, await fonts());
    expect(laid.pages.map((page) => [page.width, page.height, page.blockIds])).toEqual([
      [612, 792, ["a"]],
      [841.89, 595.28, ["b"]]
    ]);
  });

  it("keeps a group together by moving it to the next page when it fits there", async () => {
    const filler = paragraphs(20, "f");
    const group: PdfBlock = { id: "g", kind: "group", keepTogether: true, blocks: paragraphs(4, "g") };
    const doc = document([...filler, group]);
    const laid = await layoutOnly(doc, await fonts());
    const groupPages = laid.pages.filter((page) => page.blockIds.some((id) => id.startsWith("g")));
    expect(groupPages).toHaveLength(1);
    expect(groupPages[0]!.blockIds.filter((id) => id.startsWith("g"))).toEqual(["g1", "g2", "g3", "g4"]);
  });

  it("repeats a table's header on every page it continues onto", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      id: `r${index}`,
      cells: [
        { id: `r${index}a`, blocks: [paragraph(`r${index}a-p`, `Row ${index + 1}`)] },
        { id: `r${index}b`, blocks: [paragraph(`r${index}b-p`, `Value ${index + 1}`)] }
      ]
    }));
    const doc = document([
      {
        id: "t",
        kind: "table",
        columns: [{ width: { fraction: 0.3 } }, {}],
        header: { id: "th", cells: [{ id: "h1", header: true, blocks: [paragraph("h1p", "Item")] }, { id: "h2", header: true, blocks: [paragraph("h2p", "Detail")] }] },
        rows,
        repeatHeader: true,
        borders: "all"
      }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.pages.length).toBeGreaterThan(1);
    const text = await extractText(rendered.bytes);
    for (const page of text) {
      expect(page).toContain("Item");
      expect(page).toContain("Detail");
    }
    expect(text[0]).toContain("Row 1");
    expect(text[text.length - 1]).toContain("Row 60");
    expect(rendered.warnings).toEqual([]);
  });

  it("draws the running header and footer on every page with the page numbers", async () => {
    const doc = document(paragraphs(30), {
      page: resolvePdfPageSetup({ header: { height: 24 }, footer: { height: 24 } }),
      header: [paragraph("hdr", "Intake — confidential")],
      footer: [{ id: "ftr", kind: "paragraph", runs: [{ text: "Page " }, { text: "#", token: "pageNumber" }, { text: " of " }, { text: "#", token: "pageCount" }], style: { align: "center" } }]
    });
    const rendered = await renderDocument(doc, await fonts(), ENV);
    const text = await extractText(rendered.bytes);
    expect(text.length).toBeGreaterThan(2);
    text.forEach((page, index) => {
      expect(page).toContain("Intake — confidential");
      expect(page).toContain(`Page ${index + 1} of ${text.length}`);
    });
  });

  it("pins an anchored box to the first, last or every page and warns when it overflows", async () => {
    const box = (id: string, text: string): PdfBlock & { kind: "box" } => ({ id, kind: "box", blocks: [paragraph(`${id}-p`, text)], border: { width: 1, color: "#000000" } });
    const doc = document(paragraphs(30), {
      anchored: [
        { id: "a1", anchor: { page: "first", x: 400, y: 20, width: 150, height: 30 }, box: box("b1", "FIRST ONLY") },
        { id: "a2", anchor: { page: "last", x: 400, y: 20, width: 150, height: 30 }, box: box("b2", "LAST ONLY") },
        { id: "a3", anchor: { page: "every", x: 40, y: 750, width: 200, height: 30 }, box: box("b3", "EVERY PAGE") },
        { id: "a4", anchor: { page: 2, x: 40, y: 700, width: 60, height: 8 }, box: box("b4", "A box far too tall for eight points of height") }
      ]
    });
    const rendered = await renderDocument(doc, await fonts(), ENV);
    const text = await extractText(rendered.bytes);
    expect(text[0]).toContain("FIRST ONLY");
    expect(text[0]).not.toContain("LAST ONLY");
    expect(text[text.length - 1]).toContain("LAST ONLY");
    expect(text.every((page) => page.includes("EVERY PAGE"))).toBe(true);
    expect(text[1]).toContain("A box far too tall");
    expect(rendered.warnings).toEqual([expect.objectContaining({ code: "anchored.overflow" })]);
  });

  it("measures a band and an anchored box by their content, not the spacing that trails it", async () => {
    // The kernel's body line is 13.5pt (10pt at 1.35); the spacing a paragraph trails — 4pt, or
    // whatever its style says — is empty. A band or a box of fixed height holds the line, not that.
    const trailing = (id: string, text: string): PdfBlock => ({ ...paragraph(id, text), style: { spacingAfter: 40 } });
    const stamp = (height: number): PdfAnchoredBox => ({
      id: "a1",
      anchor: { page: "first", x: 400, y: 20, width: 150, height },
      box: { id: "b1", kind: "box", blocks: [trailing("b1-p", "STAMP")], padding: 6, border: { width: 1, color: "#000000" } }
    });
    const running = (band: number, box: number) =>
      document(paragraphs(3), {
        page: resolvePdfPageSetup({ header: { height: band }, footer: { height: band } }),
        header: [trailing("hdr", "Running title")],
        footer: [trailing("ftr", "Running foot")],
        anchored: [stamp(box)]
      });
    // 13.5pt of text in a 14pt band; 13.5pt + twice the 6pt padding in a 26pt box.
    expect((await renderDocument(running(14, 26), await fonts(), ENV)).warnings).toEqual([]);
    const codes = (await renderDocument(running(10, 20), await fonts(), ENV)).warnings.map((warning) => warning.code).sort();
    expect(codes).toEqual(["anchored.overflow", "footer.overflow", "header.overflow"]);
  });

  it("lays out label/value arrangements, check marks and rules", async () => {
    const doc = document([
      { id: "s", kind: "labelValue", label: "Stacked", value: [{ text: "one" }], arrangement: "stacked" },
      { id: "i", kind: "labelValue", label: "Inline", value: [{ text: "two" }], arrangement: "inline" },
      { id: "r", kind: "labelValue", label: "Ruled", value: [{ text: "three" }], arrangement: "ruled", lines: 3 },
      { id: "c", kind: "checkmark", label: "Agreed", checked: true },
      { id: "cl", kind: "checklist", label: "Contact", items: [{ label: "Email", checked: true }, { label: "Phone", checked: false }] },
      { id: "rule", kind: "rule", thickness: 2 },
      { id: "sp", kind: "spacer", height: 30 },
      { id: "bx", kind: "box", blocks: [paragraph("bxp", "boxed")], fill: "#eeeeee", border: { width: 1, color: "#333333" } }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const text = await extractText(rendered.bytes);
    for (const expected of ["Stacked", "one", "Inline", "two", "Ruled", "three", "Agreed", "Contact", "Email", "Phone", "boxed"]) {
      expect(text[0]).toContain(expected);
    }
    // Nested blocks report too (the paragraph inside the box), so a designer can find any block's page.
    expect(rendered.pages[0]!.blockIds).toEqual(["s", "i", "r", "c", "cl", "rule", "bx", "bxp"]);
  });

  it("lets a widget take less than the column, never more", async () => {
    const doc = document([
      { id: "full", kind: "widget", label: "Full width", field: { name: "full", kind: "signature" } },
      { id: "narrow", kind: "widget", label: "Narrow", field: { name: "narrow", kind: "signature" }, width: 180, height: 48 },
      { id: "wide", kind: "widget", label: "Too wide", field: { name: "wide", kind: "text", value: "x" }, width: 5000 }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const { reload } = await import("./helpers.js");
    const pdf = await reload(rendered.bytes);
    const form = pdf.getForm();
    const rect = (name: string) => form.getField(name).acroField.getWidgets()[0]!.getRectangle();
    const column = pdf.getPage(0).getWidth() - 2 * 54;
    expect(rect("full").width).toBeGreaterThanOrEqual(column);
    expect(rect("full").height).toBe(40);
    expect(rect("narrow").width).toBe(180);
    expect(rect("narrow").height).toBe(48);
    expect(Math.abs(rect("wide").width - column)).toBeLessThanOrEqual(1);
  });

  it("aligns right-to-left documents from the right edge", async () => {
    const doc = document([paragraph("p", "שלום עולם")], { metadata: { title: "T", lang: "he", textDirection: "rtl" } });
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const text = await extractText(rendered.bytes);
    expect(text[0]!.replace(/\s/g, "")).toContain("שלום");
  });
});

describe("checklist descriptions", () => {
  it("prints an option's hint under its label and leaves the others single-line", async () => {
    const doc = document([
      {
        id: "cl",
        kind: "checklist",
        label: "Account type",
        items: [
          { label: "Personal", checked: true, description: "For you or your family" },
          { label: "Business", checked: false }
        ]
      }
    ]);
    const rendered = await renderDocument(doc, await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const text = await extractText(rendered.bytes);
    for (const expected of ["Account type", "Personal", "For you or your family", "Business"]) {
      expect(text[0]).toContain(expected);
    }
    // The hint takes a line of its own: the same list, described, needs more pages.
    const items = (described: boolean) =>
      Array.from({ length: 60 }, (_, index) => ({
        label: `Option ${index + 1}`,
        checked: false,
        ...(described ? { description: "A line of help under the option" } : {})
      }));
    const plain = await layoutOnly(document([{ id: "cl", kind: "checklist", items: items(false) }]), await fonts());
    const long = await layoutOnly(document([{ id: "cl", kind: "checklist", items: items(true) }]), await fonts());
    expect(long.pages.length).toBeGreaterThan(plain.pages.length);
  });
});
