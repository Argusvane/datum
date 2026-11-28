import { describe, expect, it } from "vitest";

import { PDFArray, PDFInvalidObject, PDFRef } from "@cantoo/pdf-lib";
import { PDF_ABI_VERSION, buildPdfVerifyRequest } from "@argusvane/datum-engine/render";
import { MAX_PDF_OBJECT_NESTING, loadPdfDocument } from "../src/kernel/util/parse-depth.js";
import { createQuickJsPdfProvider } from "../src/quickjs-provider.js";
import { SLOW_FACTOR } from "./slow-machine.js";

/**
 * The QuickJS PDF provider gives every call a sandbox of its own, so nothing one request leaves in
 * a runtime reaches the next; and the kernel bounds how deep a PDF's arrays and dictionaries nest
 * before pdf-lib's recursive parser reads them.
 */

/** A PDF with an empty page tree and a third object of `depth` nested arrays. */
function nestedPdf(depth: number): Uint8Array {
  const text = [
    "%PDF-1.7",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [] /Count 0 >> endobj",
    `3 0 obj ${"[".repeat(depth)}${"]".repeat(depth)} endobj`,
    "trailer << /Root 1 0 R /Size 4 >>",
    "%%EOF",
    ""
  ].join("\n");
  return new TextEncoder().encode(text);
}

// A stand-in program that counts the calls made in its runtime and, asked for `deep`, recurses
// until the stack gives out.
const COUNTING_PROGRAM = `
  (function () {
    var calls = 0;
    function down(n) { return down(n + 1) + 1; }
    globalThis.__datum_pdf = function (request) {
      calls += 1;
      if (JSON.parse(request).op === "deep") { down(0); }
      return JSON.stringify({ abi: ${JSON.stringify(PDF_ABI_VERSION)}, op: "capabilities", features: [], kernelVersion: String(calls) });
    };
  })();`;

describe("the PDF kernel's nesting bound", () => {
  it("reads nesting up to the bound and refuses the object past it, which pdf-lib keeps as an invalid object", async () => {
    const within = await loadPdfDocument(nestedPdf(MAX_PDF_OBJECT_NESTING), { updateMetadata: false });
    expect(within.context.lookup(PDFRef.of(3))).toBeInstanceOf(PDFArray);
    const past = await loadPdfDocument(nestedPdf(MAX_PDF_OBJECT_NESTING + 1), { updateMetadata: false });
    expect(past.context.lookup(PDFRef.of(3))).toBeInstanceOf(PDFInvalidObject);
    const deep = await loadPdfDocument(nestedPdf(100_000), { updateMetadata: false });
    expect(deep.context.lookup(PDFRef.of(3))).toBeInstanceOf(PDFInvalidObject);
  });
});

describe("the QuickJS PDF provider", () => {
  it("verifies a PDF nested twenty thousand levels deep without exhausting the sandbox, and answers the next call", async () => {
    const provider = await createQuickJsPdfProvider();
    try {
      const verified = await provider.verify(buildPdfVerifyRequest(nestedPdf(20_000)));
      expect(verified.signatures).toEqual([]);
      expect((await provider.verify(buildPdfVerifyRequest(nestedPdf(4)))).signatures).toEqual([]);
    } finally {
      provider.dispose();
    }
  }, 120_000);

  it("runs every call in a sandbox no other call ran in, a call that exhausted its stack included", async () => {
    const provider = await createQuickJsPdfProvider({ program: COUNTING_PROGRAM });
    try {
      for (let index = 0; index < 3; index += 1) {
        expect((await provider.capabilities()).kernelVersion).toBe("1");
      }
      await expect(provider.verify({ abi: PDF_ABI_VERSION, op: "deep" } as unknown as Parameters<typeof provider.verify>[0])).rejects.toThrow();
      expect((await provider.capabilities()).kernelVersion).toBe("1");
    } finally {
      provider.dispose();
    }
    await expect(provider.capabilities()).rejects.toThrow(/disposed/);
  }, 60_000);

  it("builds a sandbox for a call in a bounded time", async () => {
    const provider = await createQuickJsPdfProvider();
    try {
      await provider.capabilities();
      const started = performance.now();
      const calls = 3;
      for (let index = 0; index < calls; index += 1) {
        await provider.capabilities();
      }
      const perCall = (performance.now() - started) / calls;
      console.log(`QuickJS PDF provider: ${perCall.toFixed(1)} ms per call, a sandbox built for each (slow factor ${SLOW_FACTOR.toFixed(1)})`);
      // Most of it is evaluating the program; an order of magnitude more than that fails.
      expect(perCall).toBeLessThan(1_500 * SLOW_FACTOR);
    } finally {
      provider.dispose();
    }
  }, 120_000);
});
