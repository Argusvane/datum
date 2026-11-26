import { DEFAULT_PDF_PAGE_SETUP } from "@argusvane/datum-engine/core";
import { PDF_KERNEL_FALLBACKS, type PdfBlock, type PdfDocument } from "@argusvane/datum-engine/render";

/** A model-level document (blocks the kernel draws as given), for checks that bypass the form builder. */
export function document(blocks: PdfBlock[]): PdfDocument {
  return {
    version: "1",
    page: DEFAULT_PDF_PAGE_SETUP,
    metadata: { title: "Fixture", lang: "en", textDirection: "ltr" },
    accessibility: { tagged: true, displayDocTitle: true },
    typography: PDF_KERNEL_FALLBACKS.typography,
    colors: PDF_KERNEL_FALLBACKS.colors,
    blocks,
    anchored: [],
    resources: { images: {} }
  } as PdfDocument;
}
