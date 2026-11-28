import { DEFAULT_PDF_PAGE_SETUP } from "@argusvane/datum-engine/core";
import { PDF_KERNEL_FALLBACKS, PLAIN_PDF_THEME, resolvePdfTheme, type PdfBlock, type PdfDocument } from "@argusvane/datum-engine/render";

/** A model-level document (blocks the kernel draws as given, under the plain theme's geometry), for checks that bypass the form builder. */
export function document(blocks: PdfBlock[]): PdfDocument {
  const { controls, choice, fields, headings, table, box, panel, list, spacing } = resolvePdfTheme(PLAIN_PDF_THEME);
  return {
    version: "1",
    page: DEFAULT_PDF_PAGE_SETUP,
    metadata: { title: "Fixture", lang: "en", textDirection: "ltr" },
    accessibility: { tagged: true, displayDocTitle: true },
    typography: PDF_KERNEL_FALLBACKS.typography,
    colors: PDF_KERNEL_FALLBACKS.colors,
    controls,
    choice,
    fields,
    headings,
    table,
    box,
    panel,
    list,
    spacing,
    blocks,
    anchored: [],
    resources: { images: {} }
  } as PdfDocument;
}
