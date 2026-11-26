import type { JourneyRenderKit } from "./journey-render-kit.js";
import { createJourneyRenderKit } from "./journey-render-kit-factory.js";
import { EagerJourneyReviewKit } from "./journey-review-kit-eager.js";

/**
 * The full journey render kit: the page kit (`journey-render-kit-factory.ts`) over the
 * Check answers kit, so every page kind is drawn, a review page's list included. The builder, the
 * demo app and the tests take this one. `<datum-form>` does not: its journeys chunk holds the
 * kit with no Check answers code (`createJourneyRenderKit()`), and the element loads that code
 * from a chunk of its own only for a journey with a page of kind `review`. The live form draws a
 * page through `pageFeature` (lit templates).
 */
export const EagerJourneyRenderKit: JourneyRenderKit = createJourneyRenderKit(EagerJourneyReviewKit);
