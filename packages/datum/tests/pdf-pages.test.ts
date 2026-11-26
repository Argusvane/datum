import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

import { createPdfPageRasterizer } from "../src/pdf-pages.js";

const require = createRequire(import.meta.url);

/** pdf.js's own worker, from node_modules: what the build copies to dist/pdfjs/ for a page. */
const WORKER_URL = pathToFileURL(require.resolve("pdfjs-dist/legacy/build/pdf.worker.min.mjs")).href;

/** A two-page PDF written by hand: Letter, then A4. pdf.js rebuilds the xref, so no offsets are needed. */
function twoPages(): Uint8Array {
  const body = [
    "%PDF-1.4",
    "1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj",
    "2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj",
    "3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >> endobj",
    "4 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] >> endobj",
    "trailer << /Root 1 0 R >>",
    "%%EOF"
  ].join("\n");
  return new TextEncoder().encode(body);
}

describe("datum-pdf-pages", () => {
  // Drawing a page needs a real canvas, which jsdom has none of: what is checked here is the
  // document side — opening, counting and sizing pages, closing — through pdf.js's own worker
  // module run in-process. The picture itself is checked in a browser.
  it("opens a PDF and reports each page's size in points, then closes it", async () => {
    const rasterizer = createPdfPageRasterizer({ workerUrl: WORKER_URL, standardFontsUrl: null, cmapsUrl: null, wasmUrl: null, iccUrl: null });
    const bytes = twoPages();
    const before = bytes.slice();
    const set = await rasterizer.open(bytes);
    expect(set.pageCount).toBe(2);
    expect(set.pageSize(1)).toEqual({ width: 612, height: 792 });
    const second = set.pageSize(2);
    expect(Math.round(second.width)).toBe(595);
    expect(Math.round(second.height)).toBe(842);
    expect(() => set.pageSize(3)).toThrow(RangeError);
    // The caller's bytes are left alone (pdf.js takes over the buffer it is given).
    expect(Buffer.from(bytes).equals(Buffer.from(before))).toBe(true);
    set.close();
  }, 30_000);
});
