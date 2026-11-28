/**
 * How the elements find the PDF module (`pdf.ts`, built as `dist/datum-pdf.js`) from the `pdf`
 * attribute: `"auto"` loads it from beside the running bundle, anything else is a URL
 * resolved against the page (the elements take the attribute only on the page's origin or one
 * `allow-origins` lists; the property may name any). One load per URL, shared by every element on the page. The page
 * imagery module (`pdf-pages.ts`, `dist/datum-pdf-pages.js`) is found the same way,
 * by the builder alone.
 *
 * Either module may be held to a hash (`pdf-integrity`, `pdf-pages-integrity`): it is then fetched,
 * checked and imported from a `blob:` URL of the bytes checked, which works because each is built as
 * one file. The files a module fetches beside itself (the PDF fonts, the pdf.js worker and its data)
 * are held to the package's integrity manifest when the page pins that (`pdf-manifest-integrity`).
 * The checks are integrity.ts, a lazy chunk only a page that sets one of these loads.
 */
import type { PdfPageRasterizer, RenderableRuntime, RenderFormPdfResult } from "@argusvane/datum-engine";
import { ChunkLoadError, importUrl, noteImportFailure } from "./chunk-load-error.js";
import type { IntegrityManifest, PdfModuleIntegrity } from "./integrity.js";
import type { DatumPdfSupport, RenderPdfOptions } from "./pdf.js";

export type { PdfModuleIntegrity } from "./integrity.js";

type ModuleOptions = { baseUrl?: string; manifest?: IntegrityManifest } | undefined;

interface PdfModule {
  createPdfSupport?: (options?: ModuleOptions) => Promise<DatumPdfSupport>;
  renderPdf?: (runtime: RenderableRuntime, options: RenderPdfOptions) => Promise<RenderFormPdfResult>;
}

const modules = new Map<string, Promise<PdfModule>>();
const loads = new Map<string, Promise<DatumPdfSupport>>();
const pageLoads = new Map<string, Promise<PdfPageRasterizer>>();

/** A load once per key, forgotten once it fails so the next use asks again. */
function remembered<T>(cache: Map<string, Promise<T>>, key: string, make: () => Promise<T>): Promise<T> {
  let load = cache.get(key);
  if (!load) {
    load = make();
    load.catch(() => cache.delete(key));
    cache.set(key, load);
  }
  return load;
}

const pinKey = (url: string, pin: PdfModuleIntegrity): string => [url, pin.integrity?.trim(), pin.manifestIntegrity?.trim() && pin.manifest?.trim(), pin.manifestIntegrity?.trim()].join("\n");

/** What a module at `url` is built with under `pin` (see integrity.ts, pinnedModuleOptions); nothing when nothing is pinned. */
function moduleOptions(url: string, pin: PdfModuleIntegrity): Promise<ModuleOptions> | undefined {
  return pin.integrity?.trim() || pin.manifestIntegrity?.trim() ? import("./integrity.js").then(({ pinnedModuleOptions }) => pinnedModuleOptions(url, pin)) : undefined;
}

/**
 * The module at `url`: imported by its URL, or with `integrity` fetched and checked first. A module
 * that cannot be had (deleted from the server, blocked, a 404) rejects as a `ChunkLoadError` naming
 * the URL, and one whose bytes do not match as the `IntegrityError` that says so; either way the
 * next load asks for `<url>?retry=<n>`, and a checked load checks the retry too.
 */
function importModule<T>(url: string, integrity: string | undefined, what: string): Promise<T> {
  const imported: Promise<T> = integrity
    ? import("./integrity.js").then(({ importWithIntegrity }) => importWithIntegrity<T>(importUrl(url), integrity, `${what} at ${url}`))
    : import(/* @vite-ignore */ importUrl(url));
  return imported.catch((error: unknown): never => {
    noteImportFailure(url);
    throw error instanceof Error && error.name === "IntegrityError" ? error : new ChunkLoadError(`${what} (${url})`, error);
  });
}

/** Where `"auto"` points: the PDF module beside this bundle (`import.meta.url` is the bundle's own URL). */
export function defaultPdfModuleUrl(): string {
  return new URL(/* @vite-ignore */ "./datum-pdf.js", import.meta.url).href;
}

/** Resolves the `pdf` attribute's value to the module URL. */
export function resolvePdfModuleUrl(spec: string): string {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "auto") {
    return defaultPdfModuleUrl();
  }
  return new URL(trimmed, document.baseURI).href;
}

function loadPdfModule(url: string, pin: PdfModuleIntegrity): Promise<PdfModule> {
  return remembered(modules, pinKey(url, pin), () => importModule<PdfModule>(url, pin.integrity?.trim(), "The PDF module"));
}

/**
 * Loads the PDF module at `spec` (see {@link resolvePdfModuleUrl}) and builds its support once,
 * held to `pin` (see {@link PdfModuleIntegrity}). A module that is not there (deleted from the
 * server, blocked, a 404) rejects as a `ChunkLoadError` naming the URL (absent-code resilience), and
 * the failure is forgotten so the next PDF asks again.
 */
export function loadPdfSupport(spec: string, pin: PdfModuleIntegrity = {}): Promise<DatumPdfSupport> {
  const url = resolvePdfModuleUrl(spec);
  return remembered(loads, pinKey(url, pin), () =>
    loadPdfModule(url, pin).then(async (module) => {
      if (typeof module.createPdfSupport !== "function") {
        throw new Error(`The PDF module at ${url} does not export createPdfSupport()`);
      }
      return module.createPdfSupport(await moduleOptions(url, pin));
    })
  );
}

/**
 * A runtime's form as a PDF, with no element: the PDF module's own `renderPdf` (`datum-pdf.js`),
 * from `pdf` (default `"auto"`, beside this bundle; a URL as the `pdf` attribute takes one), held to
 * `pdfIntegrity`, `pdfManifest` and `pdfManifestIntegrity` as the attributes of those names hold it.
 * The module is loaded as {@link loadPdfSupport} loads it, once per page and shared with
 * `<datum-form pdf>`, and draws with that support unless the call hands one of its own. None of
 * the PDF pipeline is in this bundle: it arrives with the module.
 */
export async function renderPdf(
  runtime: RenderableRuntime,
  options: RenderPdfOptions & { pdf?: string | undefined; pdfIntegrity?: string | undefined; pdfManifest?: string | undefined; pdfManifestIntegrity?: string | undefined } = {}
): Promise<RenderFormPdfResult> {
  const { pdf = "auto", pdfIntegrity: integrity, pdfManifest: manifest, pdfManifestIntegrity: manifestIntegrity, ...rest } = options;
  const pin = { integrity, manifest, manifestIntegrity };
  const support = rest.support ?? (await loadPdfSupport(pdf, pin));
  // The very module loadPdfSupport built the support from: a checked one runs from a blob: URL.
  const module = await loadPdfModule(resolvePdfModuleUrl(pdf), pin);
  return module.renderPdf!(runtime, { ...rest, support });
}

/** Where the page imagery module lives beside a PDF module at `pdfModuleUrl`. */
export function pdfPagesModuleUrlBeside(pdfModuleUrl: string): string {
  return new URL(/* @vite-ignore */ "./datum-pdf-pages.js", pdfModuleUrl).href;
}

/** Resolves the `pdf-pages` attribute's value to the module URL: a URL against the page, else beside the PDF module. */
export function resolvePdfPagesModuleUrl(spec: string | undefined, pdfModuleUrl: string): string {
  const trimmed = spec?.trim() ?? "";
  if (trimmed === "" || trimmed === "auto") {
    return pdfPagesModuleUrlBeside(pdfModuleUrl);
  }
  return new URL(trimmed, document.baseURI).href;
}

/** Loads the page imagery module at `url` and builds its rasteriser once, held to `pin` (see {@link PdfModuleIntegrity}). */
export function loadPdfPageRasterizer(url: string, pin: PdfModuleIntegrity = {}): Promise<PdfPageRasterizer> {
  return remembered(pageLoads, pinKey(url, pin), () =>
    importModule<{ createPdfPageRasterizer?: (options?: ModuleOptions) => PdfPageRasterizer }>(url, pin.integrity?.trim(), "The PDF pages module").then(async (module) => {
      if (typeof module.createPdfPageRasterizer !== "function") {
        throw new Error(`The PDF pages module at ${url} does not export createPdfPageRasterizer()`);
      }
      return module.createPdfPageRasterizer(await moduleOptions(url, pin));
    })
  );
}
