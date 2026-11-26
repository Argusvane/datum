import type { JourneyNavigationResult } from "../../../core/journey/journey-types.js";

/**
 * The part of a journey page's meta (`RenderOutputMeta.journey`) a page action reads: which
 * page it is, whether it is the last on the path, whether it holds a submit or download
 * button of its own, and whether a server check is out.
 */
export interface JourneyActionPage {
  journeyId: string;
  pageId: string;
  kind: string;
  final: boolean;
  hasOwnSubmit: boolean;
  pending: "page" | "journey" | undefined;
}

/**
 * What a journey page's action came to, for the caller to carry out:
 *
 * - `idle`: nothing to do: an exit page has no action, and nothing is done while the server is
 *   still checking.
 * - `moved`: Continue asked the runtime for the next page; `result` says whether it went or
 *   what stopped it (a caller moves focus to the first error on a refusal).
 * - `own-submit`: the last page holds a submit or download button of its own, so the action is
 *   pressing it (its submit one when it has both): that button keeps its signing and wording.
 * - `submit`: the last page's own Submit. The caller reports the intent to submit the form
 *   (`datum-form-action`) and whoever holds the submission mode and version context calls
 *   `submit`, which sends exactly `values` (the answers as the fold judges them: journey
 *   placement and the hidden-value policy applied) after the journey's end check against the
 *   host's server. A download skips that check (`journeyEndCheck: "skip"`).
 */
export type JourneyActionOutcome =
  | { kind: "idle" }
  | { kind: "moved"; result: JourneyNavigationResult }
  | { kind: "own-submit" }
  | { kind: "submit"; journeyId: string; pageId: string; values: Record<string, unknown> };
