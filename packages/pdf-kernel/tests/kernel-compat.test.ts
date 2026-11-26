import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { PdfDocument, PdfKernelEnv } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { fonts } from "./helpers.js";

/**
 * The kernel's promise to older documents: a document built before the theme
 * geometry existed carries none of it, and the kernel draws it from its own fallbacks — the
 * constants it always had — byte for byte as it did. The documents were captured from the
 * engine by `packages/datum/scripts/pdf-theme-sheet.ts` (the fixture form
 * under three themes) and rendered with the same fixed env and the whole DejaVu pack; their
 * sha256 is what the capture printed.
 *
 * The hashes were re-pinned when pdf-lib moved from 2.9.1 to 2.11.1, which deflates with fflate
 * where 2.9.1 used pako: the compressed bytes differ, nothing else. Checked at the time by
 * rendering the three documents under both versions and comparing them with every Flate stream
 * inflated: the object skeletons and the inflated streams were identical.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "documents-3.8");

const ENV: PdfKernelEnv = { createdAt: "2026-09-05T10:11:12.000Z", documentId: "pdf-theme-sheet", producer: "Datum pdf-theme-sheet" };

const HASHES = JSON.parse(readFileSync(join(FIXTURES, "hashes.json"), "utf8")) as Record<string, string>;

describe("kernel output for the pinned documents", () => {
  for (const [theme, hash] of Object.entries(HASHES)) {
    it(`renders the ${theme} document exactly as it did`, async () => {
      const document = JSON.parse(readFileSync(join(FIXTURES, `${theme}.json`), "utf8")) as PdfDocument;
      // What the promise rests on: nothing of the new geometry travels with an older document.
      for (const key of ["controls", "choice", "fields", "headings", "table", "box", "panel", "list", "spacing"] as const) {
        expect(document[key]).toBeUndefined();
      }
      const rendered = await renderDocument(document, await fonts(), ENV);
      expect(createHash("sha256").update(rendered.bytes).digest("hex")).toBe(hash);
    });
  }
});
