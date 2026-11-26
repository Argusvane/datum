/**
 * A lazy chunk that could not be fetched: a host may deploy a bundle without a
 * feature's files, or have them blocked, or lose the network for a moment. The loaders
 * (`webauthn-loader.ts`, `server-validator-loader.ts`) reject with this instead of the
 * browser's bare "Failed to fetch dynamically imported module", naming what was being loaded
 * and keeping the browser's error as `cause`. `<datum-form>` recognises it where a call
 * crosses its boundary (a signature, a journey check) and reports it as `datum-error`, so a
 * page hears of a missing file with no listener on the loader itself. Loading is tried again
 * on the next use: a failed load is never remembered.
 */
export class ChunkLoadError extends Error {
  public readonly cause: unknown;

  constructor(what: string, cause: unknown) {
    super(`${what} could not be loaded: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "ChunkLoadError";
    this.cause = cause;
  }
}

/**
 * A browser keeps a failed `import()` of a URL in the page's module map for the page's life, so
 * asking for the same URL again fetches nothing. For the modules a host names by URL (the PDF and
 * sandbox modules, which no bundler rewrote) the loaders ask for `<url>?retry=<n>` after n failed
 * loads, a URL the module map has never seen.
 */
const failedImports = new Map<string, number>();

/** The URL to import now: the URL itself the first time, with `?retry=n` after n failures. */
export function importUrl(url: string): string {
  const failures = failedImports.get(url) ?? 0;
  return failures > 0 ? `${url}${url.includes("?") ? "&" : "?"}retry=${failures}` : url;
}

/** Records that importing `url` failed, so the next {@link importUrl} differs. */
export function noteImportFailure(url: string): void {
  failedImports.set(url, (failedImports.get(url) ?? 0) + 1);
}
