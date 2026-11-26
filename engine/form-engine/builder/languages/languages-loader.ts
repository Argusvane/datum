/**
 * The Languages surface's loader: its chunk is fetched the first time the author
 * opens Languages, once per page; a failed load is tried again on the next call (Retry on the
 * failure card).
 */
export type LanguagesSurfaceModule = typeof import("./languages-surface.js");

let memo: Promise<LanguagesSurfaceModule> | undefined;

export function loadLanguagesSurface(): Promise<LanguagesSurfaceModule> {
  if (!memo) {
    const next = import("./languages-surface.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
