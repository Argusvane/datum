/**
 * The PDF designer's chunk, loaded on demand (the Journeys designer's rule, `loadJourneyDesigner`):
 * the first layout to open, a Preview PDF or an Add asks for it, and the mode answers once it is in.
 * One load per page, shared by every PDF mode on it. A failed load (the chunk missing from the
 * page's copy of the bundle, a network hiccup) is tried again next time rather than remembered, so
 * the PDF side is not broken for the rest of the page's life.
 */

/** The designer's chunk, as `loadPdfDesigner` resolves it. */
export type PdfDesignerModule = typeof import("./pdf-designer-chunk.js");

let designerLoad: Promise<PdfDesignerModule> | undefined;

export function loadPdfDesigner(): Promise<PdfDesignerModule> {
  if (!designerLoad) {
    const load = import("./pdf-designer-chunk.js");
    load.catch(() => {
      if (designerLoad === load) {
        designerLoad = undefined;
      }
    });
    designerLoad = load;
  }
  return designerLoad;
}
