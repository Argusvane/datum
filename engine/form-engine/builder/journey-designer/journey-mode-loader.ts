/**
 * The Journeys mode's chunk, loaded on demand: `<datum-form-builder>` asks for it only
 * when its Journeys side is on (`journeys` is not `"off"`) and the Journeys workspace is not
 * hidden, so a builder without journeys never fetches the mode, its catalog or its stylesheet.
 * Until it is registered the definition's `journey` block passes through untouched. One load per
 * page, shared by every builder on it; a failed load is tried again next time rather than
 * remembered (`loadJourneyDesigner`'s rule). Once in, `loadedJourneyBuilderMode` hands the module
 * back synchronously, so a second builder on the page registers its Journeys side as it connects.
 *
 * The mode's id lives here, not in the mode's module, so the shell can name the mode (the PDF
 * side goes ahead of it on the bar) without carrying the mode.
 */

/** The Journeys mode's id: its tab, its workspace's designer, its documents. */
export const JOURNEY_BUILDER_MODE = "journeys";

/** The Journeys mode's module, as `loadJourneyBuilderMode` resolves it. */
export type JourneyBuilderModeModule = typeof import("./journey-builder-mode.js");

let modeLoad: Promise<JourneyBuilderModeModule> | undefined;
let modeLoaded: JourneyBuilderModeModule | undefined;

export function loadJourneyBuilderMode(): Promise<JourneyBuilderModeModule> {
  if (modeLoaded) {
    return Promise.resolve(modeLoaded);
  }
  if (!modeLoad) {
    const load = import("./journey-builder-mode.js");
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

/** The Journeys mode's module when an earlier `loadJourneyBuilderMode` has brought it in; `undefined` before. */
export function loadedJourneyBuilderMode(): JourneyBuilderModeModule | undefined {
  return modeLoaded;
}
