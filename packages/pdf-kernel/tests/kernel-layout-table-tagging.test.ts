import { describe, expect, it } from "vitest";

import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef } from "@cantoo/pdf-lib";
import type { PdfBlock } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { structureOf } from "../src/kernel/tagging.js";
import { ENV, document, fonts, reload } from "./helpers.js";

/** The structure tree as indented lines: each element's role, then its MCIDs and object references. */
function tree(pdf: PDFDocument): string[] {
  const root = pdf.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const lines: string[] = [];
  const visit = (element: PDFDict, depth: number): void => {
    const kids = element.get(PDFName.of("K"));
    const items = kids instanceof PDFArray ? kids.asArray() : kids ? [kids] : [];
    const parts: string[] = [];
    const children: PDFDict[] = [];
    for (const item of items) {
      const resolved = item instanceof PDFRef ? pdf.context.lookup(item) : item;
      if (resolved instanceof PDFDict && resolved.get(PDFName.of("S"))) {
        children.push(resolved);
      } else if (resolved instanceof PDFDict) {
        parts.push(resolved.get(PDFName.of("Type"))?.toString() ?? "");
      }
    }
    lines.push(`${"  ".repeat(depth)}${element.get(PDFName.of("S"))?.toString()}${parts.length > 0 ? " " + parts.join(" ") : ""}`);
    children.forEach((child) => visit(child, depth + 1));
  };
  for (const entry of root.lookup(PDFName.of("K"), PDFArray).asArray()) {
    visit(pdf.context.lookup(entry) as PDFDict, 0);
  }
  return lines;
}

/** The grid rendition's shape: a borderless, header-less table marked an artifact, a field per cell. */
function gridDocument() {
  const blocks: PdfBlock[] = [
    { id: "heading", kind: "heading", level: 2, runs: [{ text: "Name" }] },
    {
      id: "grid",
      kind: "table",
      role: "Div",
      columns: [{ width: { fraction: 0.5 } }, { width: { fraction: 0.5 } }],
      rows: [
        {
          id: "row",
          keepTogether: false,
          cells: [
            { id: "c1", blocks: [{ id: "first", kind: "labelValue", label: "First name", value: [{ text: "Ada" }], arrangement: "stacked" }] },
            { id: "c2", blocks: [{ id: "last", kind: "widget", label: "Last name", field: { name: "lastName", kind: "text", value: "Lovelace" } }] }
          ]
        }
      ],
      repeatHeader: false,
      borders: "none",
      artifact: true
    }
  ];
  return document(blocks);
}

describe("a table marked an artifact in content (the grid rendition)", () => {
  it("tags no structure of its own while the fields in its cells are content under its parent", async () => {
    const info = structureOf(gridDocument());
    expect(info.get("grid")?.artifact).toBe(true);
    expect(info.get("first")).toMatchObject({ role: "P", artifact: false });
    expect(info.get("last")).toMatchObject({ role: "Form", artifact: false });
    expect(info.get("first")?.parent).toBe(info.get("grid")?.parent);

    const rendered = await renderDocument(gridDocument(), await fonts(), ENV);
    expect(rendered.warnings).toEqual([]);
    const pdf = await reload(rendered.bytes);
    expect(tree(pdf)).toEqual(["/Document", "  /H2 /MCR", "  /P /MCR", "  /Form /MCR /OBJR"]);
  });

  it("is still an artifact whole inside an artifact region", () => {
    const grid = gridDocument().blocks[1]!;
    const info = structureOf(document([], { footer: [grid], page: { ...document([]).page, footer: { height: 80 } } }));
    expect(info.get("first")?.artifact).toBe(true);
    expect(info.get("last")?.artifact).toBe(true);
  });
});
