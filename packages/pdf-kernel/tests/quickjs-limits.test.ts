import { describe, expect, it } from "vitest";

import { DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES } from "@argusvane/datum-engine/core";
import { PdfKernelError, buildPdfRenderRequest, bytesToBase64 } from "@argusvane/datum-engine/render";
import { DOCUMENT_PROFILE, QuickJsExecutionError, VALIDATION_PROFILE } from "@argusvane/datum-quickjs-wasm-host";
import { createQuickJsPdfProvider } from "../src/quickjs-provider.js";
import { ENV, document, fonts, paragraph } from "./helpers.js";
import { SLOW_FACTOR } from "./slow-machine.js";

// The document profile's budget for a run that must finish inside it, widened only by how slow this
// machine is right now (SLOW_FACTOR is a CPU-spin sample taken once at import, 1 or more; no
// environment variable sets it). It stays under each test's own timeout, so a hang shows as the
// interrupt rather than as a timed-out test, and a render over the real budget on a machine as fast
// as the reference fails.
const TEST_TIMEOUT_MS = 120_000;
const DOCUMENT_BUDGET_MS = Math.min(DOCUMENT_PROFILE.maxEvalMs * SLOW_FACTOR, TEST_TIMEOUT_MS - 10_000);

function longDocument(rows: number) {
  const body = Array.from({ length: rows }, (_, index) => ({
    id: `r${index}`,
    cells: [
      { id: `r${index}a`, blocks: [paragraph(`r${index}a-p`, `Row ${index + 1}`)] },
      { id: `r${index}b`, blocks: [paragraph(`r${index}b-p`, "Some longer text that wraps within the cell and takes a little room. ".repeat(2))] }
    ]
  }));
  return document([
    { id: "t", kind: "table", columns: [{ width: { fraction: 0.25 } }, {}], rows: body, repeatHeader: false, borders: "horizontal" }
  ]);
}

describe("QuickJS resource profiles", () => {
  it("finishes a long document under the document profile", async () => {
    const provider = await createQuickJsPdfProvider({ limits: { maxEvalMs: DOCUMENT_BUDGET_MS } });
    try {
      const started = Date.now();
      const rendered = await provider.render(buildPdfRenderRequest(longDocument(150), await fonts(), ENV));
      console.log(`long document: ${rendered.pageCount} pages, ${rendered.bytes.length} bytes, QuickJS ${Date.now() - started} ms`);
      expect(rendered.pageCount).toBeGreaterThan(8);
    } finally {
      provider.dispose();
    }
  }, 120_000);

  it("embeds a document's worth of uploaded files — the default attachment budget — under the document profile, and disposes cleanly", async () => {
    // Seeded bytes, so the run is the same every time; incompressible, the worst case for
    // the one that deflates. Together the files fill the default budget, the most a layout
    // embeds without a host raising it.
    const provider = await createQuickJsPdfProvider({ limits: { maxEvalMs: DOCUMENT_BUDGET_MS } });
    try {
      let seed = 0x2545f491;
      const noise = (length: number): Uint8Array => {
        const out = new Uint8Array(length);
        for (let i = 0; i < length; i += 1) {
          seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
          out[i] = seed >>> 24;
        }
        return out;
      };
      const count = 4;
      const each = DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES / count;
      const files = Array.from({ length: count }, (_, index) => ({
        name: index === 0 ? "log.txt" : `scan-${index}.pdf`,
        mimeType: index === 0 ? "text/plain" : "application/pdf",
        relationship: "Supplement" as const,
        data: bytesToBase64(noise(each)),
        componentId: index === 0 ? "log" : `scan-${index}`
      }));
      const started = Date.now();
      const rendered = await provider.render(buildPdfRenderRequest({ ...document([paragraph("p", "With attachments")]), attachments: files }, await fonts(), ENV));
      const elapsed = Date.now() - started;
      console.log(`attachments: ${rendered.bytes.length} bytes, QuickJS ${elapsed} ms`);
      expect(rendered.attachments).toEqual(files.map((file) => file.name));
      expect(rendered.bytes.length).toBeGreaterThan(each * count);
      expect(elapsed).toBeLessThan(DOCUMENT_BUDGET_MS);
    } finally {
      provider.dispose();
    }
  }, 120_000);

  it("interrupts a program load that passes its time budget", async () => {
    // A budget no load can meet, so the outcome never depends on how fast the machine is. Only the
    // outcome's code reaches the assertion: a provider handed to expect() would be pretty-printed on
    // failure, and walking its QuickJS runtime and WebAssembly memory exhausts the worker's heap.
    const outcome = await createQuickJsPdfProvider({ limits: { ...VALIDATION_PROFILE, maxEvalMs: 1 } }).then(
      (provider) => {
        provider.dispose();
        return "loaded";
      },
      (error: unknown) => (error instanceof QuickJsExecutionError ? error.code : `unexpected: ${String(error)}`)
    );
    expect(outcome).toBe("interrupted");
  }, 60_000);

  it("interrupts a call past its budget as a typed failure, and the provider still disposes cleanly", async () => {
    const provider = await createQuickJsPdfProvider({ limits: { maxEvalMs: 1_500 } });
    try {
      await expect(provider.render(buildPdfRenderRequest(longDocument(300), await fonts(), ENV))).rejects.toSatisfy(
        (error: unknown) => error instanceof PdfKernelError && /interrupted/.test(error.message)
      );
    } finally {
      provider.dispose();
    }
  }, 60_000);
});
