import { EagerJourneyReviewKit, type JourneyReviewKit } from "@argusvane/datum-engine";

/**
 * A journey's Check answers page as a lazy chunk of its own: the entry module of
 * `datum-form-journey-review-chunk-*.js`, reached by dynamic import from `journey-review-loader.ts`
 * alone. It names the Check answers kit (the list's model, its live drawing and Datum's sheet for
 * it), which the journeys chunk does not carry: the journeys chunk loads this file
 * (`journeysBundle` in form-element.ts, beside the journeys chunk) only for a journey with a page of kind `review`, and the render kit is built
 * over it before the form is first drawn. A form whose journeys have no such page never loads it.
 */
export const JOURNEY_REVIEW_SENTINEL = "datum-journey-review-chunk";

export interface JourneyReviewBundle {
  /** The Check answers kit the journey render kit is built over. */
  review: JourneyReviewKit;
  /** Names the chunk: `scripts/guards/12-journeys-lazy.mjs` finds the chunk by this string. */
  sentinel: typeof JOURNEY_REVIEW_SENTINEL;
}

/** The chunk's one export a caller reads, with the sentinel kept live. */
export const journeyReviewBundle: JourneyReviewBundle = {
  review: EagerJourneyReviewKit,
  // Read back through the object so a minifier cannot drop the string: it is the guard's marker.
  sentinel: JOURNEY_REVIEW_SENTINEL
};
