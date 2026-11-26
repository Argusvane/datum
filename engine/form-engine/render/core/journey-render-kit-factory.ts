import type { JourneyRenderKit } from "./journey-render-kit.js";
import type { JourneyReviewKit } from "./journey-review-kit.js";
import { buildJourneyMeta, journeyPageComponentIds, journeyPageComponents, journeyPageErrors, journeyPageTexts } from "./journey-render.js";
import { createJourneyPageFeature } from "../live/journey-page.js";

/** The real kit's id, with or without a Check answers kit: the bundle guard's marker. */
const EAGER_KIT_ID = "datum-journey-render-kit-eager";

/** One kit per Check answers kit, so a page's forms share it (the renderer compares kits by identity). */
const withReview = new WeakMap<JourneyReviewKit, JourneyRenderKit>();

/** The kit with no Check answers kit: what the journeys chunk hands a journey that has no such page. */
const PLAIN_KIT: JourneyRenderKit = Object.freeze({
  id: EAGER_KIT_ID,
  pageComponentIds: journeyPageComponentIds,
  pageErrors: journeyPageErrors,
  buildMeta: buildJourneyMeta,
  pageComponents: journeyPageComponents,
  pageTexts: journeyPageTexts,
  // Called with no argument (`kit.pageFeature?.()`): a page module with no Check answers kit.
  pageFeature: createJourneyPageFeature
});

/**
 * The real journey render kit, over the Check answers kit `review` when there is one:
 * the only module, besides the barrels that re-export them, that value-imports `journey-render.ts`
 * and the live renderer's page module (`render/live/journey-page.ts`). It names no Check answers
 * code itself, so the journeys chunk that calls it with no `review` carries none; `<datum-form>`
 * loads that code from a chunk of its own for a journey with a page of kind `review` and builds
 * the kit again over it. Without `review` a Check answers page draws its heading, its own content
 * and its actions, with no list, and its errors stay where a questions page's would be.
 * `EagerJourneyRenderKit` (`journey-render-kit-eager.ts`) is the kit over the real one.
 */
export function createJourneyRenderKit(review?: JourneyReviewKit): JourneyRenderKit {
  if (review === undefined) {
    return PLAIN_KIT;
  }
  let kit = withReview.get(review);
  if (kit === undefined) {
    kit = Object.freeze({
      id: EAGER_KIT_ID,
      pageComponentIds: (root, members, view) => journeyPageComponentIds(root, members, view, review.componentIds),
      pageErrors: journeyPageErrors,
      buildMeta: buildJourneyMeta,
      pageComponents: journeyPageComponents,
      pageTexts: journeyPageTexts,
      pageFeature: () => createJourneyPageFeature(review)
    } satisfies JourneyRenderKit);
    withReview.set(review, kit);
  }
  return kit;
}
