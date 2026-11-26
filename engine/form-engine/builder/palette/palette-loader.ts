/**
 * The command palette's loader: its chunk is fetched the first time the palette
 * opens, once per page; a failed load is tried again on the next open.
 */
export type PaletteModule = typeof import("./command-palette.js");

let memo: Promise<PaletteModule> | undefined;

export function loadCommandPalette(): Promise<PaletteModule> {
  if (!memo) {
    const next = import("./command-palette.js");
    next.catch(() => {
      if (memo === next) {
        memo = undefined;
      }
    });
    memo = next;
  }
  return memo;
}
