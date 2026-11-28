import { describe, expect, it } from "vitest";

import { htmlToPdfBlocks } from "../form-engine/render/pdf/standard-renditions.js";
import { runsText, type PdfBlock, type PdfListBlock } from "../form-engine/render/pdf/pdf-document.js";
import type { PdfRenditionContext } from "../form-engine/render/pdf/pdf-renditions.js";

function blocks(html: string): PdfBlock[] {
  let counter = 0;
  const context = { model: { id: "c" }, nextId: (suffix?: string) => `${suffix ?? "b"}-${(counter += 1)}` } as unknown as PdfRenditionContext;
  return htmlToPdfBlocks(html, context);
}

function texts(list: PdfListBlock): unknown[] {
  return list.items.map((item) => [runsText(item.runs), ...(item.blocks ?? []).map((nested) => texts(nested))]);
}

describe("static HTML on paper: character references", () => {
  it("decodes a reference past U+10FFFF, to a surrogate or to NUL as the replacement character, keeping the block", () => {
    const out = blocks("<p>a&#x110000;b&#xD800;c&#0;d&#99999999999;e&#65;</p>");
    expect(out).toHaveLength(1);
    expect(runsText((out[0] as Extract<PdfBlock, { kind: "paragraph" }>).runs)).toBe("a�b�c�d�eA");
  });
});

describe("static HTML on paper: nested lists", () => {
  it("keeps text after a nested list in the item that holds it", () => {
    const out = blocks("<ul><li>one<ul><li>inner</li></ul>tail</li><li>two</li></ul>");
    expect(out).toHaveLength(1);
    const list = out[0] as PdfListBlock;
    expect(list.items).toHaveLength(2);
    expect(texts(list)).toEqual([["one\ntail", [["inner"]]], ["two"]]);
  });

  it("still joins an item's text to an item that opened with the nested list", () => {
    const list = blocks("<ul><li><ul><li>inner</li></ul>after</li><li>two</li></ul>")[0] as PdfListBlock;
    expect(texts(list)).toEqual([["after", [["inner"]]], ["two"]]);
  });
});

describe("static HTML on paper: an item left open", () => {
  it("keeps the text of a last item the list closes without its </li>", () => {
    expect(texts(blocks("<ul><li>a<li>b</ul>")[0] as PdfListBlock)).toEqual([["a"], ["b"]]);
    expect(texts(blocks("<ul><li>one<ul><li>inner</ul></li></ul>")[0] as PdfListBlock)).toEqual([["one", [["inner"]]]]);
  });
});
