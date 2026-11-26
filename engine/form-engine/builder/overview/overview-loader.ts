/**
 * The Journeys and PDF overviews' loader: its chunk
 * is fetched the first time the author opens either overview, once per page; a failed load is
 * tried again on the next call (Retry on the failure card).
 */
export type OverviewSurfaceModule = typeof import("./overview-surface.js");

let memo: Promise<OverviewSurfaceModule> | undefined;

export function loadOverviewSurface(): Promise<OverviewSurfaceModule> {
  if (!memo) {
    const next = import("./overview-surface.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
