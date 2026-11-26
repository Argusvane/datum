import { PDFArray, PDFRawStream, decodePDFRawStream, type PDFDocument, type PDFRef } from "@cantoo/pdf-lib";
import { describe, expect, it } from "vitest";

import { PDF_KERNEL_FALLBACKS, type PdfFillArea } from "@argusvane/datum-engine/render";
import { fillTemplate } from "../src/kernel/template.js";
import { ENV, fonts, reload } from "./helpers.js";
import { FILL_OPTIONS, plainTemplate } from "./pdfa-fixtures.js";

/** A page's content streams, inflated and joined. */
function pageContent(pdf: PDFDocument, index: number): string {
  const contents = pdf.getPage(index).node.Contents();
  const refs = contents instanceof PDFArray ? contents.asArray() : contents ? [contents] : [];
  return refs
    .map((entry) => Buffer.from(decodePDFRawStream(pdf.context.lookup(entry as PDFRef) as PDFRawStream).decode()).toString("latin1"))
    .join("\n");
}

const AREA: PdfFillArea = {
  id: "note",
  page: 1,
  rect: { x: 20, y: 20, width: 260, height: 40 },
  value: "Drawn over the page",
  draw: { kind: "text", fontSize: 10, align: "start", valign: "top", padding: 2, wrap: true, bold: false }
};

describe("template areas under a theme", () => {
  it("draws an area in the plan's colours when it carries a theme, and in the kernel's fallbacks when it does not", async () => {
    const plain = await fillTemplate(await plainTemplate(), {}, FILL_OPTIONS, await fonts(), ENV, [AREA]);
    const themed = await fillTemplate(await plainTemplate(), {}, FILL_OPTIONS, await fonts(), ENV, [AREA], undefined, undefined, {
      typography: PDF_KERNEL_FALLBACKS.typography,
      colors: { ...PDF_KERNEL_FALLBACKS.colors, text: "#ff0000" }
    });
    const plainContent = pageContent(await reload(plain.bytes), 0);
    const themedContent = pageContent(await reload(themed.bytes), 0);
    expect(themedContent).toContain("1 0 0 rg");
    expect(plainContent).not.toContain("1 0 0 rg");
    expect(plain.areas?.[0]?.status).toBe("filled");
    expect(themed.areas?.[0]?.status).toBe("filled");
  });
});
