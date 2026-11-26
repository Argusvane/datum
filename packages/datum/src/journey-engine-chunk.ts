import { EagerJourneyEngine, createJourneyRenderKit, readJourneys, type FormDefinition, type JourneyEngine, type JourneyRenderKit } from "@argusvane/datum-engine";
import { loadJourneyReview, type JourneyReviewBundle } from "./journey-review-loader.js";

/**
 * The journeys runtime as a lazy chunk: the entry module of
 * `datum-form-journey-engine-chunk-*.js`, reached by dynamic import from `journey-engine-loader.ts`
 * alone. It names the two things only a journey form needs and nothing else does: the eager
 * engine (path, navigation, the server checks, the presentation overlay) and the eager render
 * kit (the page's components, errors, meta and markup). Everything they pull in that only they
 * use (journey-path's engine, journey-render, journey-markup, presentation, journey-server-check)
 * therefore lands in this chunk, not in `datum-form.js`.
 *
 * Nothing registers on import: `<datum-form>` takes `{ engine, renderKit }` from the loader and
 * hands each to the runtime and the renderer it builds. A plain form never loads this file.
 *
 * A Check answers page's list is not in here (`journey-review-chunk.ts`, a chunk of its own):
 * `renderKit` draws such a page with no list. `forDefinition` answers the kit a definition's journeys
 * are drawn with: over the Check answers chunk's kit for a journey with a page of kind `review`,
 * plain for one without, which never fetches that chunk. `<datum-form>` starts both fetches at once
 * and hands the arrived Check answers bundle in as `review`;
 * a host that calls `forDefinition(definition)` alone has the chunk loaded from here.
 */
export const JOURNEY_ENGINE_SENTINEL = "datum-journey-engine-chunk";

export interface JourneyEngineBundle {
  /** The engine a runtime with journeys is built with. */
  engine: JourneyEngine;
  /** The kit the renderer draws a journey's pages with, with no Check answers list. */
  renderKit: JourneyRenderKit;
  /**
   * The engine and the kit `definition`'s journeys are drawn with: `renderKit`, or, when a journey
   * has a page of kind `review`, the kit over the Check answers chunk's kit: `review` when the
   * caller has loaded it already, else loaded here. Rejects as a ChunkLoadError naming the Check
   * answers page when that chunk does not arrive.
   */
  forDefinition(definition: FormDefinition, review?: JourneyReviewBundle): Promise<{ engine: JourneyEngine; renderKit: JourneyRenderKit }>;
  /** Names the chunk: `scripts/guards/12-journeys-lazy.mjs` finds the chunk by this string. */
  sentinel: typeof JOURNEY_ENGINE_SENTINEL;
}

/** The chunk's one export a caller reads: the engine and the kit, with the sentinel kept live. */
export const journeyEngineBundle: JourneyEngineBundle = {
  engine: EagerJourneyEngine,
  renderKit: createJourneyRenderKit(),
  forDefinition: (definition, review) =>
    readJourneys(definition).some((journey) => journey.pages.some((page) => page.kind === "review"))
      ? Promise.resolve(review ?? loadJourneyReview()).then((check) => ({ engine: EagerJourneyEngine, renderKit: createJourneyRenderKit(check.review) }))
      : Promise.resolve({ engine: EagerJourneyEngine, renderKit: createJourneyRenderKit() }),
  // Read back through the object so a minifier cannot drop the string: it is the guard's marker.
  sentinel: JOURNEY_ENGINE_SENTINEL
};
