// Not type-checked with the package (it uses Node, vitest and the kernel's sources): run with the kernel's vitest, `npm run test:pdf`.
// The PDF half of the GCDS package, run for real in Node: the theme resolves,
// the engine's ladder picks it for the binding's suggestion, the faces convert with the kernel's own
// WOFF reader, and a form renders to a PDF under it through the in-process kernel with no font warning.
import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createFaceFontProvider, createInProcessPdfProvider, woffToSfnt } from "../../../packages/pdf-kernel/src/index.js";
import { resolvePdfTheme, selectPdfTheme } from "../../../engine/form-engine/render/pdf/pdf-theme.js";
import { renderFormPdf } from "../../../engine/form-engine/render/pdf/pdf-service.js";
import { PdfThemeRegistry, pdfThemeLookup } from "../../../engine/form-engine/render/pdf/pdf-theme-registry.js";
import { SubmissionModeRegistry } from "../../../engine/form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../../../engine/form-engine/runtime/browser/form-runtime.js";
import { ValidationPipeline } from "../../../engine/form-engine/validation/core/validation-pipeline.js";
import type { FormDefinition } from "../../../engine/form-engine/core/schema/types.js";
import { GCDS_BINDING_PDF_SUGGESTION, GCDS_PDF_FACES, gcdsPdfTheme } from "../pdf/index.js";

const FONTS = process.env.GCDS_FONTS ?? join(__dirname, "..", "node_modules", "gcds-fonts-1.1.1", "fonts");

describe("the GCDS PDF theme", () => {
 it("holds", async () => {
  const checks: Array<{ id: string; ok: boolean; message: string }> = [];
  const check = (id: string, ok: boolean, message: string): void => void checks.push({ id, ok, message });

  // PDF-01: the theme resolves; its type roles come from the tokens.
  const resolved = resolvePdfTheme(gcdsPdfTheme);
  const typography = resolved.typography;
  check("PDF-01", typography.body.family === "Noto Sans" && typography.body.size === 15 && typography.label.weight === 600, `body ${typography.body.family} ${typography.body.size}pt, label weight ${typography.label.weight}`);

  // PDF-02: the engine's ladder. Registered, the binding's suggestion is the theme; unregistered, datum-pdf and one warning.
  const registry = new PdfThemeRegistry();
  registry.register(gcdsPdfTheme);
  const lookup = pdfThemeLookup(registry);
  const found = selectPdfTheme({ binding: GCDS_BINDING_PDF_SUGGESTION, resolveTheme: lookup });
  const missing = selectPdfTheme({ binding: GCDS_BINDING_PDF_SUGGESTION, resolveTheme: () => undefined });
  const named = selectPdfTheme({ themeId: "datum-pdf", binding: GCDS_BINDING_PDF_SUGGESTION, resolveTheme: lookup });
  check("PDF-02", found.source === "binding" && found.theme?.id === "gcds" && missing.source === "default" && missing.warnings[0]?.code === "theme.notFound" && named.source === "call", `registered: ${found.source}; unregistered: ${missing.source} (${missing.warnings[0]?.code}); a named theme wins: ${named.source}`);

  // PDF-03: every face converts with the kernel's WOFF reader to an sfnt.
  const converted: string[] = [];
  for (const face of GCDS_PDF_FACES) {
    const sfnt = await woffToSfnt(new Uint8Array(await readFile(join(FONTS, face.file))));
    const tag = String.fromCharCode(...sfnt.subarray(0, 4));
    if (tag === "\u0000\u0001\u0000\u0000" || tag === "OTTO" || tag === "true") converted.push(face.file);
  }
  check("PDF-03", converted.length === GCDS_PDF_FACES.length, `${converted.length} of ${GCDS_PDF_FACES.length} faces are sfnt after the kernel's woffToSfnt`);

  // PDF-04: a form renders under the theme through the binding's suggestion, with the faces embedded.
  const definition: FormDefinition = {
    id: "gcds-pdf",
    version: "1.0.0",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: { title: "Application" },
      children: { content: [{ id: "name", type: "text", configuration: { label: "Full name", description: "As on your passport.", required: true } }, { id: "way", type: "radio", configuration: { label: "Contact", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } }] }
    }
  };
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
  runtime.setValue("name", "Ada Lovelace");
  runtime.setValue("way", "email");
  const render = async (base: string | undefined) =>
    renderFormPdf(runtime as never, { provider: createInProcessPdfProvider(), fonts: createFaceFontProvider({ baseUrl: () => base, read: async (location) => new Uint8Array(await readFile(location)) }), binding: GCDS_BINDING_PDF_SUGGESTION, themes: registry }, {});
  const ok = await render(FONTS);
  const text = Buffer.from(ok.bytes).toString("latin1");
  const warned = ok.warnings.filter((warning) => warning.code.startsWith("font."));
  check("PDF-04", text.startsWith("%PDF-") && /NotoSans/.test(text) && warned.length === 0, `${ok.pageCount} page(s), ${ok.bytes.length} bytes, Noto Sans embedded: ${/NotoSans/.test(text)}, font warnings: ${warned.map((w) => w.code).join(",") || "none"}`);

  // PDF-05: sensitivity. With no font folder the faces are reported (one warning each) and the document still renders.
  const bad = await render(undefined);
  check("PDF-05", bad.bytes.length > 1000 && bad.warnings.some((warning) => warning.code === "font.faceFailed"), `no font folder: ${bad.warnings.filter((w) => w.code.startsWith("font.")).map((w) => w.code).join(",")}`);
  for (const entry of checks) console.log(`${entry.ok ? "PASS" : "FAIL"} ${entry.id} ${entry.message}`);
  expect(checks.filter((entry) => !entry.ok).map((entry) => `${entry.id} ${entry.message}`)).toEqual([]);
 }, 120000);
});
