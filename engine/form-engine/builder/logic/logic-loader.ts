/**
 * The Logic surface's loader: its chunk is fetched the first time the author opens
 * Logic, once per page. A failed load is tried again on the next call rather than remembered, so
 * Retry on the failure card works (the journeys designer's rule).
 */
export type LogicSurfaceModule = typeof import("./logic-surface.js");

let memo: Promise<LogicSurfaceModule> | undefined;

export function loadLogicSurface(): Promise<LogicSurfaceModule> {
  if (!memo) {
    const next = import("./logic-surface.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
