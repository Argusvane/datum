import { ChunkLoadError } from "./chunk-load-error.js";
import type { JourneyEngineBundle } from "./journey-engine-chunk.js";

export type { JourneyEngineBundle } from "./journey-engine-chunk.js";

/**
 * The journeys runtime as a lazy chunk: `journey-engine-chunk.ts` carries
 * the eager journey engine and render kit with every module only they use, and is reached by
 * dynamic import alone, so a form with no journeys (or a host whose `features` leaves
 * `journeys` out) never downloads it. This module is what the renderer bundle carries instead,
 * in the shape of `webauthn-loader.ts` and `server-validator-loader.ts`.
 */
type JourneyEngineModule = typeof import("./journey-engine-chunk.js");

/** One load of the chunk per page, shared by every element. */
let engineLoad: Promise<JourneyEngineBundle> | undefined;

/** What the chunk answered, once it has: the page's journey forms after the first build at once. */
let engineLoaded: JourneyEngineBundle | undefined;

/**
 * Loads the chunk, once, and answers the engine and the render kit it holds. A failed load is
 * forgotten so the next call asks again (a chunk that 404ed for a moment); in the module build
 * the import goes through the retrying loader (vite.config.ts), which asks the module map for a
 * URL it has not failed on. A missing or blocked chunk rejects as a ChunkLoadError naming the
 * journeys runtime, with the browser's error as `cause` (absent-code resilience).
 */
export function loadJourneyEngine(): Promise<JourneyEngineBundle> {
  if (!engineLoad) {
    const load = import("./journey-engine-chunk.js").then(
      ({ journeyEngineBundle }: JourneyEngineModule): JourneyEngineBundle => {
        engineLoaded = journeyEngineBundle;
        return journeyEngineBundle;
      },
      (error: unknown): never => {
        throw new ChunkLoadError("The journeys runtime (datum-form-journey-engine-chunk-*.js)", error);
      }
    );
    load.catch(() => {
      if (engineLoad === load) {
        engineLoad = undefined;
      }
    });
    engineLoad = load;
  }
  return engineLoad;
}

/**
 * The engine and the kit when the chunk has already arrived on this page, else `undefined`
 * (never loading, never failing). `<datum-form>` takes the already-loaded bundle without waiting
 * for the chunk, so only the page's first journey form waits for it (the build itself still lands
 * in a microtask, as every build does).
 */
export function loadedJourneyEngine(): JourneyEngineBundle | undefined {
  return engineLoaded;
}
