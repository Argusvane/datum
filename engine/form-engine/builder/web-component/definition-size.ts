/**
 * The one sentence for a form definition refused by its size: the bar's Open says it of a chosen
 * file, and the elements of a definition past `max-definition-bytes`, so the same file is refused
 * in the same words by either route. Plain functions with nothing to load, for any bundle to take.
 */

/** A byte count as the importers say it: whole megabytes or kilobytes when it is one, else bytes. */
export function bytesInWords(bytes: number): string {
  const mib = 1024 * 1024;
  if (bytes >= mib && bytes % mib === 0) {
    return `${(bytes / mib).toLocaleString("en-US")} MB`;
  }
  if (bytes >= 1024 && bytes % 1024 === 0) {
    return `${(bytes / 1024).toLocaleString("en-US")} KB`;
  }
  return `${bytes.toLocaleString("en-US")} bytes`;
}

/**
 * Why a definition of `bytes` is not read under a cap of `limit`; `undefined` within it.
 * `atLeast` when only the bytes read so far are known (the rest is never read).
 */
export function definitionSizeProblem(bytes: number, limit: number, atLeast = false): string | undefined {
  if (bytes <= limit) {
    return undefined;
  }
  return `it is ${atLeast ? "over " : ""}${Math.max(1, Math.round(bytes / 1024)).toLocaleString("en-US")} KB; up to ${bytesInWords(limit)} is read`;
}
