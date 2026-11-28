// Writes packages/pdf-kernel/tests/fixtures/documents/: the canonical fixture form (FIXTURE_FORM) with a full set of
// answers, built by the PDF program's own `build` op under each case's theme and locale (`<case>.json`, the document
// model a host sends to `render`), and hashes.json, the sha256 of each document rendered by the kernel with the whole
// DejaVu pack and the fixed env below. The kernel's parity test (kernel-parity-documents.test.ts) and every host's PDF
// render contract hold their output to these hashes. Rerun it when the document model or the kernel's drawing changes
// on purpose, and commit what it writes.
//   packages/datum/node_modules/.bin/vite-node --root packages/datum packages/datum/scripts/pdf-parity-documents.ts
import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { DEFAULT_PDF_THEME, PDF_ABI_VERSION, PLAIN_PDF_THEME, type PdfDocument, type PdfKernelEnv, type PdfThemeDefinition } from "../../../engine/form-engine/render/index.ts";
import { FIXTURE_FORM } from "../../../engine/form-engine/testing/fixture-form.ts";
import { loadFontPack } from "../../pdf-kernel/src/fonts.ts";
import { renderDocument } from "../../pdf-kernel/src/kernel/render.ts";
import { handlePdfRequest } from "../../pdf-kernel/src/program/entry.ts";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "..", "..", "pdf-kernel", "tests", "fixtures", "documents");

/** The env every host renders the documents with; the hashes hold for it alone. */
const ENV: PdfKernelEnv = { createdAt: "2026-09-05T10:11:12.000Z", documentId: "pdf-theme-sheet", producer: "Datum pdf-theme-sheet" };

/** An answer for every field the fixture form prints (the file field left empty, so it prints the empty dash). */
const VALUES: Record<string, unknown> = {
  fullName: "Ada Lovelace",
  amount: 1250,
  bio: "Mathematician and writer.\nKnown for her work on the Analytical Engine.",
  province: "BC",
  birthDate: "1984-03-09",
  contactMethod: "email",
  interests: ["news"],
  agree: true,
  hiddenLabel: "analytical engine",
  disabledField: "REF-2026-0091",
  readOnlyField: "ACC-1815",
  street: "1 Main Street",
  city: "Ottawa",
  email: "ada@example.ca",
  phone: "613 555 0100",
  employer: "Analytical Engines Ltd.",
  nickname: "Ada",
  jobTitle: "Engineer",
  resident: true,
  notes: "Reviewed on paper.",
  consent: false
};

const CASES: Array<{ name: string; theme: PdfThemeDefinition; locale: string }> = [
  { name: "datum-pdf", theme: DEFAULT_PDF_THEME, locale: "en" },
  { name: "datum-plain", theme: PLAIN_PDF_THEME, locale: "en" },
  { name: "datum-pdf-fr-CA", theme: DEFAULT_PDF_THEME, locale: "fr-CA" }
];

const fonts = await loadFontPack();
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const hashes: Record<string, string> = {};
for (const { name, theme, locale } of CASES) {
  const built = await handlePdfRequest({
    abi: PDF_ABI_VERSION,
    op: "build",
    form: FIXTURE_FORM.root,
    formTranslations: FIXTURE_FORM.translations,
    values: VALUES,
    locale,
    theme
  });
  if (!built.ok || built.op !== "build" || !built.document) {
    throw new Error(`${name}: the build op made no document: ${JSON.stringify(built)}`);
  }
  const document: PdfDocument = built.document;
  const rendered = await renderDocument(document, fonts, ENV);
  writeFileSync(join(out, `${name}.json`), `${JSON.stringify(document, null, 2)}\n`);
  hashes[name] = createHash("sha256").update(rendered.bytes).digest("hex");
  console.log(`${name}: ${hashes[name]}${built.warnings.length > 0 ? ` (warnings: ${built.warnings.map((warning) => warning.code).join(", ")})` : ""}`);
}
writeFileSync(join(out, "hashes.json"), `${JSON.stringify(hashes, null, 2)}\n`);
