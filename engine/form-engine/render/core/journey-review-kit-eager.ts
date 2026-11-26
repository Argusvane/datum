import type { JourneyReviewKit } from "./journey-review-kit.js";
import { journeyReviewComponentIds } from "./journey-review.js";
import { focusReviewOwner, focusReviewReturn, reviewSummaryTarget, reviewView, stopReview } from "../live/journey-review.js";

/**
 * The real Check answers kit: the only module that value-imports the list's model
 * (`journey-review.ts`) and its live drawing (`render/live/journey-review.ts`). `<datum-form>` loads
 * it from a chunk of its own (`datum-form-journey-review-chunk-*.js`) for a journey with a page of
 * kind `review`, and hands it to the journey render kit; the builder and the tests take the full
 * kit, `EagerJourneyRenderKit`, which holds it. The id is the bundle guard's marker.
 */
export const EagerJourneyReviewKit: JourneyReviewKit = Object.freeze({
  id: "datum-journey-review-kit-eager",
  componentIds: journeyReviewComponentIds,
  view: reviewView,
  stop: stopReview,
  summaryTarget: reviewSummaryTarget,
  focusOwner: focusReviewOwner,
  focusReturn: focusReviewReturn
});
