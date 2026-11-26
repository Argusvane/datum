import { ChunkLoadError } from "./chunk-load-error.js";
import type { JourneyReviewBundle } from "./journey-review-chunk.js";

export type { JourneyReviewBundle } from "./journey-review-chunk.js";

/** One load of the chunk per page, shared by every element; forgotten when it fails. */
let reviewLoad: Promise<JourneyReviewBundle> | undefined;

/**
 * A journey's Check answers page as a lazy chunk (`journey-review-chunk.ts`), in the shape of
 * `journey-engine-loader.ts`: `<datum-form>` asks for it beside the journeys chunk, for a journey with
 * a page of kind `review` alone (a host's `forDefinition` call asks for it from the journeys
 * chunk), and the build waits for both. Loaded once; a failed load is
 * forgotten, so the next call asks again (in the module build through the retrying loader,
 * vite.config.ts), and rejects as a ChunkLoadError naming the Check answers page with the
 * browser's error as `cause`, which `<datum-form>` reports as it reports the journeys runtime's.
 */
export function loadJourneyReview(): Promise<JourneyReviewBundle> {
  return (reviewLoad ??= import("./journey-review-chunk.js").then(
    (chunk) => chunk.journeyReviewBundle,
    (error: unknown): never => {
      reviewLoad = undefined;
      throw new ChunkLoadError("The Check answers page", error);
    }
  ));
}
