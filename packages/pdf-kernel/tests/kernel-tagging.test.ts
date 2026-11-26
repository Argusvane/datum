import { describe, expect, it } from "vitest";

import { inflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef } from "@cantoo/pdf-lib";
import { renderDocument } from "../src/kernel/render.js";

/** A page's content stream, inflated: pdf-lib compresses it, so raw byte searches see nothing. */
function pageContent(pdf: PDFDocument, index: number): string {
  const page = pdf.getPage(index);
  const contents = page.node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs
    .map((entry) => {
      const stream = pdf.context.lookup(entry as PDFRef) as PDFRawStream;
      const filter = stream.dict.get(PDFName.of("Filter"))?.toString();
      const bytes = filter === "/FlateDecode" ? inflateSync(Buffer.from(stream.contents)) : Buffer.from(stream.contents);
      return bytes.toString("latin1");
    })
    .join("\n");
}
import { ENV, RED_PNG_BASE64, document, extractText, fonts, paragraph, reload } from "./helpers.js";

function fixture() {
  return document(
    [
      { id: "h", kind: "heading", level: 1, runs: [{ text: "Tagged" }] },
      paragraph("p", "A paragraph of body text."),
      { id: "img", kind: "image", resourceId: "logo", alt: "Company logo", width: 30 },
      { id: "w", kind: "widget", label: "Name", field: { name: "name", kind: "text", value: "Ada" } },
      {
        id: "t",
        kind: "table",
        columns: [{}, {}],
        header: { id: "th", cells: [{ id: "h1", header: true, blocks: [paragraph("h1p", "Item")] }, { id: "h2", header: true, blocks: [paragraph("h2p", "Qty")] }] },
        rows: [{ id: "r1", cells: [{ id: "c1", blocks: [paragraph("c1p", "Apples")] }, { id: "c2", blocks: [paragraph("c2p", "3")] }] }],
        repeatHeader: true,
        borders: "all"
      },
      { id: "rule", kind: "rule" },
      { id: "g", kind: "group", role: "Sect", keepTogether: false, blocks: [paragraph("gp", "Inside a section")] }
    ],
    {
      resources: { images: { logo: { type: "image/png", data: RED_PNG_BASE64 } } },
      page: { size: "Letter", orientation: "portrait", margins: { top: 54, right: 54, bottom: 54, left: 54 }, footer: { height: 24 } },
      footer: [paragraph("ftr", "Footer furniture")]
    }
  );
}

function roleOf(dict: PDFDict): string {
  return dict.get(PDFName.of("S"))?.toString() ?? "";
}

describe("tagged PDF", () => {
  it("writes a structure tree with roles, table structure, figure alt text, widgets and artifacts", async () => {
    const rendered = await renderDocument(fixture(), await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const pdf = await reload(rendered.bytes);
    const catalog = pdf.catalog;
    const markInfo = catalog.lookup(PDFName.of("MarkInfo"), PDFDict);
    expect(markInfo.get(PDFName.of("Marked"))?.toString()).toBe("true");
    const root = catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
    expect(root.get(PDFName.of("Type"))?.toString()).toBe("/StructTreeRoot");

    const rootKids = root.lookup(PDFName.of("K"), PDFArray);
    const documentElement = pdf.context.lookup(rootKids.get(0), PDFDict);
    expect(roleOf(documentElement)).toBe("/Document");

    const children = (dict: PDFDict): PDFDict[] => {
      const kids = dict.lookup(PDFName.of("K"), PDFArray);
      const out: PDFDict[] = [];
      for (let i = 0; i < kids.size(); i += 1) {
        const entry = kids.get(i);
        const resolved = entry instanceof PDFRef ? pdf.context.lookup(entry) : entry;
        if (resolved instanceof PDFDict && resolved.get(PDFName.of("S"))) {
          out.push(resolved);
        }
      }
      return out;
    };
    const topRoles = children(documentElement).map(roleOf);
    expect(topRoles).toEqual(["/H1", "/P", "/Figure", "/Form", "/Table", "/Sect"]);

    const figure = children(documentElement)[2]!;
    expect(figure.get(PDFName.of("Alt"))?.toString()).toContain("Company logo".split("").map((c) => c.charCodeAt(0).toString(16).padStart(4, "0")).join("").toUpperCase().slice(0, 8));

    const table = children(documentElement)[4]!;
    const rows = children(table);
    expect(rows.map(roleOf)).toEqual(["/TR", "/TR"]);
    expect(children(rows[0]!).map(roleOf)).toEqual(["/TH", "/TH"]);
    expect(children(rows[1]!).map(roleOf)).toEqual(["/TD", "/TD"]);
    expect(children(children(rows[1]!)[0]!).map(roleOf)).toEqual(["/P"]);

    // The form element references its widget, and the widget points back through StructParent.
    const formElement = children(documentElement)[3]!;
    const formKids = formElement.lookup(PDFName.of("K"), PDFArray);
    const kidTypes: string[] = [];
    for (let i = 0; i < formKids.size(); i += 1) {
      kidTypes.push(formKids.lookup(i, PDFDict).get(PDFName.of("Type"))?.toString() ?? "");
    }
    // The label's text is marked content in the same element; the widget follows as an OBJR.
    expect(kidTypes).toEqual(["/MCR", "/OBJR"]);
    const widget = pdf.getForm().getTextField("name").acroField.getWidgets()[0]!;
    expect(widget.dict.get(PDFName.of("StructParent"))).toBeInstanceOf(PDFNumber);

    // Marked content: one MCID per content sequence, parent tree entries per page.
    const page = pdf.getPage(0);
    expect(page.node.get(PDFName.of("StructParents"))?.toString()).toBe("0");
    const content = pageContent(pdf, 0);
    expect(content).toMatch(/\/H1\s*<<\s*\/MCID 0\s*>>\s*BDC/);
    expect(content).toMatch(/\/P\s*<<\s*\/MCID 1\s*>>\s*BDC/);
    expect(content).toContain("/Artifact BMC");
    expect(content.split("EMC").length).toBeGreaterThan(4);
    const parentTree = root.lookup(PDFName.of("ParentTree"), PDFDict);
    const nums = parentTree.lookup(PDFName.of("Nums"), PDFArray);
    expect(nums.size()).toBeGreaterThanOrEqual(4);
    expect(root.get(PDFName.of("ParentTreeNextKey"))?.toString()).toBe("100001");

    // Text is still readable in order.
    const text = await extractText(rendered.bytes);
    expect(text[0]).toContain("Tagged");
    expect(text[0]).toContain("Footer furniture");
  });

  it("writes no structure tree when the document is untagged, keeping language and title", async () => {
    const untagged = { ...fixture(), accessibility: { tagged: false, displayDocTitle: true } };
    const rendered = await renderDocument(untagged, await fonts(), ENV);
    const pdf = await reload(rendered.bytes);
    expect(pdf.catalog.get(PDFName.of("StructTreeRoot"))).toBeUndefined();
    expect(pdf.catalog.get(PDFName.of("MarkInfo"))).toBeUndefined();
    expect(pageContent(pdf, 0)).not.toContain("BDC");
    expect(pdf.getTitle()).toBe("Fixture");
    expect(pdf.catalog.get(PDFName.of("Lang"))?.toString()).toBe("(en)");
    // The render option overrides the document's own choice.
    const forced = await renderDocument(untagged, await fonts(), ENV, { tagged: true });
    expect((await reload(forced.bytes)).catalog.get(PDFName.of("StructTreeRoot"))).toBeDefined();
  });

  it("marks the same document identically twice", async () => {
    const a = await renderDocument(fixture(), await fonts(), ENV);
    const b = await renderDocument(fixture(), await fonts(), ENV);
    expect(Buffer.compare(Buffer.from(a.bytes), Buffer.from(b.bytes))).toBe(0);
  });
});
