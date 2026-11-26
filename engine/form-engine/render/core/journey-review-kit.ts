import type { JourneyView } from "../../core/journey/journey-types.js";
import type { View } from "../live/contract.js";
import type { DrawContext, LiveContext } from "../live/mount.js";
import type { ErrorSummaryEntry } from "./error-summary.js";
import type { PresentationPage } from "./presentation-tree.js";

/**
 * A journey's Check answers page (`kind: "review"`) behind one interface, so its code (the list's
 * model `journey-review.ts`, the live drawing `render/live/journey-review.ts`, Datum's sheet for it)
 * can sit in a chunk of its own that only a journey with such a page fetches. The journey render
 * kit takes one (`createJourneyRenderKit(review)`); a kit without one draws a review page as its
 * heading, its own content and its actions, with no list. The real one is
 * `journey-review-kit-eager.ts`; this module is types alone, so the entry and the journeys chunk can
 * hold it.
 */
export interface JourneyReviewKit {
  /** Names the kit in diagnostics and guards. */
  readonly id: string;
  /** The ids of the answers a Check answers page lists (`journeyReviewComponentIds`), drawn, with their errors, in its rows. */
  componentIds(view: Pick<JourneyView, "path" | "journey" | "pageOf">): readonly string[];
  /** The list under the page's heading (`reviewView`); `undefined` on every other page. */
  view(draw: DrawContext, page: PresentationPage, headingLevel: number, ownMove: () => void): View | undefined;
  /** Takes Datum's rules for the list away on unmount (`stopReview`). */
  stop(live: LiveContext): void;
  /** Where a summary entry on the page goes: the answer's row (`reviewSummaryTarget`). */
  summaryTarget(entry: ErrorSummaryEntry, draw: DrawContext): { href: string; focus(): void } | undefined;
  /** The first error's place when no summary takes focus (`focusReviewOwner`). */
  focusOwner(componentId: string, live: LiveContext): boolean;
  /** Back on the page after a Change: focus on the row changed (`focusReviewReturn`); `false` for the heading. */
  focusReturn(live: LiveContext, page: PresentationPage): boolean;
}
