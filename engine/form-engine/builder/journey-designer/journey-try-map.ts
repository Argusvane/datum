/**
 * What Try it tells the journey map: the step the person is on and
 * the ways taken to it, from the runtime's view of the journey and the decisions its path was
 * worked out by. Pure: no DOM, no map, nothing imported but a type, so the try session's chunk
 * carries it without the map's.
 *
 * The map names a way as `start`, `route:<step>:<route index>` or `next:<step>`
 * (`journeyMapEdgeId`, in the map's model; a test holds the two spellings together), a step by
 * the designer's node id. The runtime's decisions name a step by the page id it runs under and a
 * route by its written position, so a decision is one edge id once its step has a node.
 *
 * Steps are found by position, not by id: two steps of a journey may share a page id, and the
 * walk is forward, so each decision (and each page on the path) is the first page of that id
 * after the one before it. The preview runs each page under its node id (`previewJourney`), so
 * for the builder's own journeys position and id agree; a runtime that does not rename still
 * keeps two steps apart.
 *
 * Only what is behind the person is "taken": the path is worked out for the whole journey with
 * the answers so far, so the steps and ways after the current step are the path's forecast and
 * stay unmarked, and Back unmarks what it leaves.
 */
import type { JourneyDecision } from "../../core/journey/journey-types.js";

/** What of the runtime's journey the state is read from: its pages in written order. */
export interface TryMapPage {
  id: string;
}

export interface TryMapInput {
  /** The running journey's pages, in written order (`JourneyView.journey.pages`). */
  pages: readonly TryMapPage[];
  /** The map's node id of each page, by the same position; a page with none is never marked. */
  nodes: readonly (string | undefined)[];
  /** The page ids on the current path (`JourneyView.path`). */
  path: readonly string[];
  /** The current page's position on the path (`JourneyView.index`). */
  index: number;
  /** Why the path looks as it does (`JourneyTrace.decisions`); absent, no way is marked, only the step. */
  decisions?: readonly JourneyDecision[] | undefined;
}

/** What the map's `setState` takes. */
export interface TryMapState {
  currentNodeId?: string | undefined;
  takenEdges: string[];
}

/** The position of the first page with `id` after `after`, else -1. */
function positionAfter(pages: readonly TryMapPage[], id: string, after: number): number {
  for (let at = after + 1; at < pages.length; at += 1) {
    if ((pages[at] as TryMapPage).id === id) {
      return at;
    }
  }
  return -1;
}

/**
 * The current step and the ways taken to it. Nothing on the path (no page applies) marks nothing.
 * The Start line is taken as soon as a step is shown; a route and a fall-through are taken once
 * their step is behind the current one.
 */
export function tryMapState(input: TryMapInput): TryMapState {
  const { pages, nodes, path } = input;
  // Each page of the path by position, the walk being forward.
  const positions: number[] = [];
  let after = -1;
  for (const id of path) {
    const at = positionAfter(pages, id, after);
    if (at < 0) {
      break;
    }
    positions.push(at);
    after = at;
  }
  const current = positions[input.index];
  if (current === undefined) {
    return { takenEdges: [] };
  }
  const currentNodeId = nodes[current];
  const taken: string[] = ["start"];
  after = -1;
  for (const decision of input.decisions ?? []) {
    const at = positionAfter(pages, decision.pageId, after);
    if (at < 0) {
      continue;
    }
    after = at;
    if (at >= current) {
      break;
    }
    const node = nodes[at];
    if (node === undefined) {
      continue;
    }
    taken.push(decision.kind === "route" ? `route:${node}:${decision.routeIndex}` : `next:${node}`);
  }
  return { ...(currentNodeId !== undefined ? { currentNodeId } : {}), takenEdges: taken };
}
