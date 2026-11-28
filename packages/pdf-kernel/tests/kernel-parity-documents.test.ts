import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { PdfDocument, PdfKernelEnv } from "@argusvane/datum-engine/render";
import { renderDocument } from "../src/kernel/render.js";
import { fonts } from "./helpers.js";

/**
 * The parity documents: the fixture form's answers as the PDF program's `build` op makes them
 * under the default theme, the plain theme and the default theme in French, rendered with the
 * fixed env and the whole DejaVu pack. Their sha256 is the contract every host's PDF render is
 * held to (the JVM's `PdfRenderContract`, the Python `pdf_contract`): the same document, the same
 * bytes, on every engine. `packages/datum/scripts/pdf-parity-documents.ts` writes the documents
 * and the hashes; rerun it when the document model or the kernel's drawing changes on purpose.
 */
const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "documents");

const ENV: PdfKernelEnv = { createdAt: "2026-09-05T10:11:12.000Z", documentId: "pdf-theme-sheet", producer: "Datum pdf-theme-sheet" };

const HASHES = JSON.parse(readFileSync(join(FIXTURES, "hashes.json"), "utf8")) as Record<string, string>;

describe("kernel output for the parity documents", () => {
  for (const [name, hash] of Object.entries(HASHES)) {
    it(`renders the ${name} document to its pinned bytes`, async () => {
      const document = JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8")) as PdfDocument;
      const rendered = await renderDocument(document, await fonts(), ENV);
      expect(createHash("sha256").update(rendered.bytes).digest("hex")).toBe(hash);
    });
  }
});
