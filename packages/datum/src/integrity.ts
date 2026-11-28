/**
 * Subresource Integrity for a module the element imports itself: the `wasm-integrity` attribute
 * (`wasmIntegrity`) holds the sandbox module to a hash. The text is the one `<script integrity>`
 * takes: whitespace-separated `sha256-`, `sha384-` or `sha512-` digests in base64. As the browser
 * does, the strongest algorithm the text names is the one compared, and any digest of it may match.
 * Unlike the browser, a text that names no digest this check can compare is refused rather than
 * ignored: the page asked for a check, so none is a failure.
 */

const ALGORITHMS = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" } as const;
type Algorithm = keyof typeof ALGORITHMS;
const STRENGTH: readonly Algorithm[] = ["sha256", "sha384", "sha512"];

/** The digests an integrity text names for its strongest algorithm; `undefined` when it names none. */
export function parseIntegrity(integrity: string): { algorithm: Algorithm; digests: string[] } | undefined {
  const named = new Map<Algorithm, string[]>();
  for (const token of integrity.trim().split(/\s+/)) {
    // An option after `?` is reserved by the standard and ignored.
    const match = /^(sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})(?:\?.*)?$/.exec(token);
    if (match) {
      const algorithm = match[1] as Algorithm;
      named.set(algorithm, [...(named.get(algorithm) ?? []), match[2]!]);
    }
  }
  for (let index = STRENGTH.length - 1; index >= 0; index -= 1) {
    const algorithm = STRENGTH[index]!;
    const digests = named.get(algorithm);
    if (digests) {
      return { algorithm, digests };
    }
  }
  return undefined;
}

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

/** Why `bytes` fail `integrity` (`what` names them in the message); `undefined` when they match. */
export async function integrityProblem(bytes: Uint8Array, integrity: string, what: string): Promise<string | undefined> {
  const wanted = parseIntegrity(integrity);
  if (wanted === undefined) {
    return `${what} was not loaded: its integrity "${integrity}" names no sha256, sha384 or sha512 digest`;
  }
  const subtle = globalThis.crypto?.subtle;
  if (subtle === undefined) {
    return `${what} was not loaded: this page cannot compute a digest (Web Crypto needs a secure context, https or localhost)`;
  }
  const digest = toBase64(new Uint8Array(await subtle.digest(ALGORITHMS[wanted.algorithm], bytes as Uint8Array<ArrayBuffer>)));
  return wanted.digests.includes(digest) ? undefined : `${what} was not loaded: its ${wanted.algorithm} digest is ${wanted.algorithm}-${digest}, which the integrity it was given does not list`;
}

/**
 * The module at `url`, fetched, held to `integrity`, then imported from a `blob:` URL of exactly the
 * bytes that were checked, so what runs is what was hashed. A page whose Content Security Policy
 * limits scripts lists `blob:` in `script-src` for this. The module must be self-contained (the
 * sandbox module is one file with its engine embedded): a `blob:` URL has no folder for a relative
 * import to resolve against.
 */
export async function importWithIntegrity<T>(url: string, integrity: string, what: string): Promise<T> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`${what} could not be fetched: ${response.status} ${response.statusText}`.trim());
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const problem = await integrityProblem(bytes, integrity, what);
  if (problem !== undefined) {
    throw new IntegrityError(problem);
  }
  const blobUrl = URL.createObjectURL(new Blob([bytes], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as T;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/** A module whose bytes did not match the integrity it was given. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
