/**
 * The Print workspace's loader: its chunk is fetched the first time the author opens Print, once
 * per page; a failed load is tried again on the next call (Retry on the failure card).
 */
export type PrintSurfaceModule = typeof import("./print-surface.js");

let memo: Promise<PrintSurfaceModule> | undefined;

export function loadPrintSurface(): Promise<PrintSurfaceModule> {
  if (!memo) {
    const next = import("./print-surface.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
