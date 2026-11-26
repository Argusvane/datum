import type { Journey } from "../schema/journey.js";
import { exploreJourneyWalks, journeyWalkGraph } from "./journey-diagnostics.js";

/**
 * A journey's graph facts for the flow map: which pages exist, how the walk can
 * arrive at each or leave it, and which of those ways are live — some path takes them — or
 * dead. Conditions aside, as `diagnoseJourney` reads a journey: every page the walk
 * arrives at is on the path, shown even when nothing on it shows (a page has no condition of its
 * own, and is never passed over); its routes are tried in order and the first that matches
 * wins, else the walk falls through to the next page; an exit page stops the walk.
 *
 * It is built on `diagnoseJourney`'s own walk graph (`journeyWalkGraph`) and search
 * (`exploreJourneyWalks`), so a page the map draws as unreachable is one the diagnostics call
 * `page.unreachable`, and a journey it draws as never ending is `journey.no-end`. The ways out
 * are each page's own, by position, as the path engine takes them (`journeyPath`), two pages
 * that share an id (itself an error, `page.duplicate-id`) included.
 *
 * Conditions are read as independent, so a way is live when some combination of outcomes takes
 * it, though two routes reading the same answer may in fact exclude each other.
 *
 * Pure, and free of work at import.
 */

/** Why a written route is not drawn, the errors first: the first reason is the one said. */
export type JourneyFlowIgnoreReason = "unknown-target" | "self" | "backward" | "exit" | "review" | "shadowed";

export interface JourneyFlowPage {
  pageId: string;
  exit: boolean;
  /** Present on a review page (`kind: "review"`) alone: the walk ends at it. */
  review?: true;
  /** Some walk arrives at the page, and so shows it. `!onPath` is exactly `page.unreachable`. */
  onPath: boolean;
}

export interface JourneyFlowEdge {
  /** Page indexes; `pages.length` is the journey's end. */
  from: number;
  to: number;
  /**
   * `"route"`: one of the page's routes. `"next"`: the fall-through to the next page, when no
   * route always matches (from a review page, always to the end).
   */
  kind: "route" | "next";
  /** A route's position in the page's written `routes`, 0-based. */
  routeIndex?: number;
  /** A route with a `when`. */
  conditional: boolean;
  /**
   * Taken only when what comes before it does not: a fall-through or an unconditional route
   * after at least one drawn conditional route of the page.
   */
  otherwise: boolean;
  /** Some walk takes it: a route or fall-through from a page on the path. */
  live: boolean;
}

/** A written route the walk never takes, and why. */
export interface JourneyFlowIgnoredRoute {
  from: number;
  routeIndex: number;
  /** The first of {@link reasons}. */
  reason: JourneyFlowIgnoreReason;
  /**
   * Every reason that applies, ranked unknown-target, self, backward, exit, review, shadowed.
   * `"review"`: the route is on a review page, where the walk ends whatever the routes say.
   */
  reasons: JourneyFlowIgnoreReason[];
  /** The page index it names (`pages.length`: the end); absent for an unknown target. */
  to?: number;
  /** For a shadowed route: the written index of the route before it that always matches. */
  shadowedBy?: number;
}

export interface JourneyFlow {
  pages: JourneyFlowPage[];
  /** In page order; for each page its drawn routes in written order, then its fall-through. */
  edges: JourneyFlowEdge[];
  ignored: JourneyFlowIgnoredRoute[];
  /** Some path can run off the end and submit; false for a journey with no pages (`journey.no-end` either way). */
  ends: boolean;
}

/** The graph facts of `journey`. See the module comment. */
export function journeyFlow(journey: Journey): JourneyFlow {
  const pages = journey.pages;
  const count = pages.length;
  // A route goes to the first page with its target id, as the path engine's does.
  const indexOf = new Map<string, number>();
  pages.forEach((page, at) => {
    if (!indexOf.has(page.id)) {
      indexOf.set(page.id, at);
    }
  });

  const graph = journeyWalkGraph(journey);
  const edges: JourneyFlowEdge[] = [];
  const ignored: JourneyFlowIgnoredRoute[] = [];
  const pageEdges: JourneyFlowEdge[][] = [];

  pages.forEach((page, at) => {
    const isExit = page.kind === "exit";
    // A review page ends the walk: its routes are never tried and its one way out is the end.
    const isReview = page.kind === "review";
    const own: JourneyFlowEdge[] = [];
    // As diagnoseJourney counts them: a forward route to a known page with no `when` shadows
    // every route after it, on an exit page too.
    let shadowedBy: number | undefined;
    let conditionalDrawn = false;
    (page.routes ?? []).forEach((route, routeIndex) => {
      const target = route.to === "$end" ? count : indexOf.get(route.to);
      const reasons: JourneyFlowIgnoreReason[] = [];
      if (target === undefined) {
        reasons.push("unknown-target");
      } else if (target === at) {
        reasons.push("self");
      } else if (target < at) {
        reasons.push("backward");
      }
      if (isExit) {
        reasons.push("exit");
      }
      if (isReview) {
        reasons.push("review");
      }
      if (shadowedBy !== undefined) {
        reasons.push("shadowed");
      }
      const forward = target !== undefined && target > at;
      if (forward && route.when === undefined && shadowedBy === undefined) {
        shadowedBy = routeIndex;
      }
      if (reasons.length > 0) {
        const entry: JourneyFlowIgnoredRoute = { from: at, routeIndex, reason: reasons[0] as JourneyFlowIgnoreReason, reasons };
        if (target !== undefined) {
          entry.to = target;
        }
        if (reasons.includes("shadowed") && shadowedBy !== undefined && shadowedBy !== routeIndex) {
          entry.shadowedBy = shadowedBy;
        }
        ignored.push(entry);
        return;
      }
      const conditional = route.when !== undefined;
      own.push({ from: at, to: target as number, kind: "route", routeIndex, conditional, otherwise: !conditional && conditionalDrawn, live: false });
      if (conditional) {
        conditionalDrawn = true;
      }
    });
    if (isReview) {
      own.push({ from: at, to: count, kind: "next", conditional: false, otherwise: false, live: false });
    } else if (!isExit && shadowedBy === undefined) {
      own.push({ from: at, to: at + 1, kind: "next", conditional: false, otherwise: conditionalDrawn, live: false });
    }
    pageEdges.push(own);
  });

  const walk = exploreJourneyWalks(graph);

  const flowPages: JourneyFlowPage[] = pages.map((page, at) => {
    const entry: JourneyFlowPage = {
      pageId: page.id,
      exit: graph.exit[at] === true,
      onPath: walk.onPath[at] === true
    };
    if (page.kind === "review") {
      entry.review = true;
    }
    return entry;
  });

  flowPages.forEach((page, at) => {
    for (const edge of pageEdges[at] ?? []) {
      edge.live = page.onPath;
      edges.push(edge);
    }
  });

  return { pages: flowPages, edges, ignored, ends: count > 0 && walk.ends };
}
