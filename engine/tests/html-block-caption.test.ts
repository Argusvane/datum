// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { htmlToPdfBlocks } from "../form-engine/render/pdf/standard-renditions.js";
import { sanitizeStaticHtml } from "../form-engine/core/schema/static-html.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

/**
 * An html block's table keeps its <caption> on every surface that draws the block
 * (browser markup, the print document and the PDF blocks).
 */
const markup = "<table><caption>Simple Data Table</caption><thead><tr><th>Name</th></tr></thead><tbody><tr><td>Ada</td></tr></tbody></table>";

describe("html block table caption across the render paths", () => {
  it("the browser markup carries the caption inside the table", async () => {
    const drawn = (await markupOf([{ id: "t", type: "html", configuration: { content: markup } }])).html;
    expect(String(drawn)).toContain("<table><caption>Simple Data Table</caption>");
  });

  it("the PDF blocks keep the caption text as its own paragraph, before the table text", () => {
    let n = 0;
    const context = { nextId: (kind: string) => `${kind}${(n += 1)}`, model: { id: "t" } } as never;
    const blocks = htmlToPdfBlocks(sanitizeStaticHtml(markup), context) as Array<{ kind: string; runs?: Array<{ text: string }> }>;
    const texts = blocks.map((block) => (block.runs ?? []).map((run) => run.text).join(""));
    expect(texts[0]).toBe("Simple Data Table");
    expect(texts).toContain("Name");
    expect(texts).toContain("Ada");
  });
});
