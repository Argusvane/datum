import { describe, expect, it } from "vitest";
import type { ComponentNode } from "@argusvane/datum-engine/core";
import { PDF_ABI_VERSION, deriveDefaultPdfLayout, type PdfDocumentRequest } from "@argusvane/datum-engine/render";
import { createInProcessPdfProvider } from "../src/in-process-provider.js";
import { ENV, fonts } from "./helpers.js";

const provider = createInProcessPdfProvider();
const form: ComponentNode = { id: "f", type: "form", configuration: { title: "Caps" }, children: { content: [{ id: "ta", type: "textarea", configuration: { label: "Story" } }] } } as never;
async function request(value: string, extra: Partial<PdfDocumentRequest> = {}): Promise<PdfDocumentRequest> {
  return { abi: PDF_ABI_VERSION, op: "document", form, values: { ta: value }, locale: "en", fonts: await fonts(), env: ENV, ...extra };
}

// A huge answer cannot pin a render slot; both caps are overridable per layout.
describe("render caps", () => {
  it("cuts an answer past 20,000 characters with a marker and a render.truncated warning", async () => {
    const started = Date.now();
    const r = await provider.document!(await request("lorem ipsum ".repeat(5400)));
    expect(r.warnings.map((w) => w.code)).toContain("render.truncated");
    expect(r.pageCount).toBeLessThan(60);
    expect(Date.now() - started).toBeLessThan(20_000);
  }, 60_000);

  it("takes the layout's limits.answerChars", async () => {
    const layout = { ...deriveDefaultPdfLayout(form), limits: { answerChars: 100 } };
    const r = await provider.document!(await request("x ".repeat(300), { layout } as never));
    expect(r.warnings.map((w) => w.message).join()).toContain("runs past 100 characters");
  });

  it("refuses a document past the page cap with render_limit (render.pageCap)", async () => {
    const layout = { ...deriveDefaultPdfLayout(form), limits: { pages: 1, answerChars: 20000 } };
    await expect(provider.document!(await request("word ".repeat(3000), { layout } as never))).rejects.toMatchObject({ code: "render_limit", message: expect.stringContaining("render.pageCap") });
  }, 60_000);

  it("keeps a document inside the default 200 pages", async () => {
    const r = await provider.document!(await request("word ".repeat(3000)));
    expect(r.pageCount).toBeLessThan(200);
  }, 60_000);

  it("re-balances isolates after the cut: an answer whose closer is past the cut keeps no open isolate", async () => {
    const layout = { ...deriveDefaultPdfLayout(form), limits: { answerChars: 100 } };
    const value = "\u2067" + "x ".repeat(300) + "\u2069";
    const r = await provider.document!(await request(value, { layout } as never));
    expect(r.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["render.truncated", "text.bidiStripped"]));
    const { buildFromInputs } = await import("../src/model/build-document.js");
    const model = await buildFromInputs((await request(value, { layout } as never)) as never);
    const text = JSON.stringify((model as { document: { blocks: unknown } }).document.blocks);
    expect(text).not.toContain("\u2067");
    expect(text).toContain("[\u2026]");
  });

  it("holds a layout's limits to the ceiling (1,000 pages, 200,000 characters) with a render.limitsCapped warning", async () => {
    const { resolvePdfRenderLimits, pdfRenderLimitsOverCeiling } = await import("@argusvane/datum-engine/render");
    expect(resolvePdfRenderLimits({ pages: 1e9, answerChars: 1e9 })).toEqual({ pages: 1000, answerChars: 200000 });
    expect(resolvePdfRenderLimits({ pages: 1000, answerChars: 200000 })).toEqual({ pages: 1000, answerChars: 200000 });
    expect(pdfRenderLimitsOverCeiling({ pages: 1001, answerChars: 5 })).toEqual(["pages"]);
    expect(pdfRenderLimitsOverCeiling({ pages: 0.5, answerChars: "x" })).toEqual([]);
    const layout = { ...deriveDefaultPdfLayout(form), limits: { pages: 1e9, answerChars: 1e9 } };
    const r = await provider.document!(await request("short", { layout } as never));
    const capped = r.warnings.filter((w) => w.code === "render.limitsCapped").map((w) => w.message);
    expect(capped).toHaveLength(2);
    expect(capped.join()).toContain("limits.pages of 1000000000");
    expect(capped.join()).toContain("limits.answerChars");
  });
});
