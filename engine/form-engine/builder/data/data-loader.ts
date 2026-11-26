/**
 * The Data surface's loader: its chunk is fetched the first time the author opens
 * Data, once per page; a failed load is tried again on the next call (Retry on the failure card).
 */
export type DataSurfaceModule = typeof import("./data-surface.js");

let memo: Promise<DataSurfaceModule> | undefined;

export function loadDataSurface(): Promise<DataSurfaceModule> {
  if (!memo) {
    const next = import("./data-surface.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
