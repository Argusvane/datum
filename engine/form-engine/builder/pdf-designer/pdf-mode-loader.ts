/**
 * The PDF mode's chunk, loaded on demand: `<datum-form-builder>` asks for it only when
 * its PDF side is on (`pdf` is not `"off"`) and the PDF workspace is not hidden, so a builder
 * without a PDF side never fetches the mode, its catalog, its words or its stylesheet. One load
 * per page, shared by every builder on it; a failed load (the chunk missing from the page's copy
 * of the bundle, a network hiccup) is tried again next time rather than remembered, the
 * designer's rule (`pdf-designer-loader.ts`). Once in, `loadedPdfBuilderMode` hands the module
 * back synchronously, so a second builder on the page registers its PDF side as it connects.
 *
 * Engine hosts that build their own `<datum-builder>` keep `createPdfBuilderMode` from the
 * engine's exports; this loader is for a bundle that must not carry the mode up front.
 */

/** The PDF mode's module, as `loadPdfBuilderMode` resolves it. */
export type PdfBuilderModeModule = typeof import("./pdf-builder-mode.js");

let modeLoad: Promise<PdfBuilderModeModule> | undefined;
let modeLoaded: PdfBuilderModeModule | undefined;

export function loadPdfBuilderMode(): Promise<PdfBuilderModeModule> {
  if (modeLoaded) {
    return Promise.resolve(modeLoaded);
  }
  if (!modeLoad) {
    const load = import("./pdf-builder-mode.js");
    load.then(
      (module) => {
        modeLoaded = module;
      },
      () => {
        if (modeLoad === load) {
          modeLoad = undefined;
        }
      }
    );
    modeLoad = load;
  }
  return modeLoad;
}

/** The PDF mode's module when an earlier `loadPdfBuilderMode` has brought it in; `undefined` before. */
export function loadedPdfBuilderMode(): PdfBuilderModeModule | undefined {
  return modeLoaded;
}
