/**
 * Subresource Integrity for the files the elements load themselves. `wasm-integrity`
 * (`wasmIntegrity`) holds the sandbox module to a hash, `pdf-integrity` and `pdf-pages-integrity`
 * the two PDF modules, and `pdf-manifest-integrity` the package's `integrity.json`, whose entries
 * then hold the files those modules fetch (the PDF fonts, the pdf.js worker and its data). The text
 * is the one `<script integrity>` takes: whitespace-separated `sha256-`, `sha384-` or `sha512-`
 * digests in base64. As the browser does, the strongest algorithm the text names is the one
 * compared, and any digest of it may match. Unlike the browser, a text that names no digest this
 * check can compare is refused rather than ignored: the page asked for a check, so none is a failure.
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

/** The bytes at `url`, held to `integrity` (`what` names them in a message); a mismatch rejects as an {@link IntegrityError}. */
export async function fetchWithIntegrity(url: string, integrity: string, what: string): Promise<Uint8Array> {
  const response = await fetch(url, { credentials: "same-origin" });
  if (!response.ok) {
    throw new Error(`${what} could not be fetched: ${response.status} ${response.statusText}`.trim());
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const problem = await integrityProblem(bytes, integrity, what);
  if (problem !== undefined) {
    throw new IntegrityError(problem);
  }
  return bytes;
}

/**
 * The module at `url`, fetched, held to `integrity`, then imported from a `blob:` URL of exactly the
 * bytes that were checked, so what runs is what was hashed. A page whose Content Security Policy
 * limits scripts lists `blob:` in `script-src` for this. The module must be self-contained (the
 * sandbox module and the two PDF modules are each one file): a `blob:` URL has no folder for a
 * relative import to resolve against. Its `import.meta.url` is the `blob:` URL too, so a module that
 * finds files beside itself is told where it was fetched from instead (the PDF modules' `baseUrl`).
 */
export async function importWithIntegrity<T>(url: string, integrity: string, what: string): Promise<T> {
  const bytes = await fetchWithIntegrity(url, integrity, what);
  const blobUrl = URL.createObjectURL(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "text/javascript" }));
  try {
    return (await import(/* @vite-ignore */ blobUrl)) as T;
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

/**
 * The package's integrity manifest (`integrity.json`, written by scripts/integrity-manifest.mjs):
 * the Subresource Integrity of every file of `dist` a page can load, by its path in `dist`
 * (`fonts/DejaVuSans.ttf`, `pdfjs/pdf.worker.min.mjs`).
 */
export interface IntegrityManifest {
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The manifest at `url`, held to `integrity` as a whole and then read. The page pins one hash, and
 * the entries are trusted because the bytes that list them were checked.
 */
export async function loadIntegrityManifest(url: string, integrity: string): Promise<IntegrityManifest> {
  const what = `The integrity manifest at ${url}`;
  const bytes = await fetchWithIntegrity(url, integrity, what);
  let files: unknown;
  try {
    files = (JSON.parse(new TextDecoder().decode(bytes)) as { files?: unknown } | null)?.files;
  } catch {
    throw new IntegrityError(`${what} is not JSON`);
  }
  if (typeof files !== "object" || files === null || Array.isArray(files) || Object.values(files).some((value) => typeof value !== "string")) {
    throw new IntegrityError(`${what} has no "files" object of integrity strings`);
  }
  return { files: files as Record<string, string> };
}

/**
 * The bytes at `url`, held to the hash `manifest` lists for `path` (the file's path in `dist`). A
 * path the manifest does not list is refused, never fetched unchecked.
 */
export function fetchListed(manifest: IntegrityManifest, path: string, url: string): Promise<Uint8Array> {
  const integrity = Object.prototype.hasOwnProperty.call(manifest.files, path) ? manifest.files[path] : undefined;
  if (integrity === undefined) {
    return Promise.reject(new IntegrityError(`${url} was not loaded: the integrity manifest lists no "${path}"`));
  }
  return fetchWithIntegrity(url, integrity, url);
}

/**
 * How a PDF module and the files beside it are held to hashes: what `pdf-integrity` (or
 * `pdf-pages-integrity`), `pdf-manifest` and `pdf-manifest-integrity` say. Nothing set, the module is
 * imported by its URL and its files are fetched as they are.
 */
export interface PdfModuleIntegrity {
  /** The module's Subresource Integrity. Set, the module is fetched, checked and imported from a `blob:` URL. */
  integrity?: string | undefined;
  /** Where the package's `integrity.json` is: absent or `"auto"`, `../integrity.json` from the module (the npm package's layout, as the CDNs serve it). */
  manifest?: string | undefined;
  /** The manifest's Subresource Integrity. Set, every file the module fetches is held to the hash the manifest lists for it. */
  manifestIntegrity?: string | undefined;
}

const manifests = new Map<string, Promise<IntegrityManifest>>();

/**
 * The package's integrity manifest for a module at `moduleUrl`, held to `pin.manifestIntegrity`, once
 * per page (a failed load is forgotten); `undefined` when the page pins none, since an unpinned
 * manifest proves nothing.
 */
export async function loadPinnedManifest(pin: PdfModuleIntegrity, moduleUrl: string): Promise<IntegrityManifest | undefined> {
  const integrity = pin.manifestIntegrity?.trim();
  if (!integrity) {
    return undefined;
  }
  const spec = pin.manifest?.trim();
  const url = !spec || spec === "auto" ? new URL("../integrity.json", moduleUrl).href : new URL(spec, document.baseURI).href;
  const key = `${url}\n${integrity}`;
  let load = manifests.get(key);
  if (!load) {
    load = loadIntegrityManifest(url, integrity);
    load.catch(() => manifests.delete(key));
    manifests.set(key, load);
  }
  return load;
}

/**
 * What a PDF module at `url` is built with under `pin`: the URL it was fetched from when it runs from
 * a `blob:` URL (its own `import.meta.url` is then the blob's), and the manifest its files are held to.
 */
export async function pinnedModuleOptions(url: string, pin: PdfModuleIntegrity): Promise<{ baseUrl?: string; manifest?: IntegrityManifest }> {
  const manifest = await loadPinnedManifest(pin, url);
  return { ...(pin.integrity?.trim() ? { baseUrl: url } : {}), ...(manifest ? { manifest } : {}) };
}

/** A file whose bytes did not match the integrity it was given, or one the manifest does not list. */
export class IntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IntegrityError";
  }
}
