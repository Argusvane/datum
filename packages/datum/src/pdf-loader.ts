/**
 * How the elements find the PDF module (`pdf.ts`, built as `dist/datum-pdf.js`) from the `pdf`
 * attribute: `"auto"` loads it from beside the running bundle, anything else is a URL
 * resolved against the page (the elements take the attribute only on the page's origin or one
 * `allow-origins` lists; the property may name any). One load per URL, shared by every element on the page. The page
 * imagery module (`pdf-pages.ts`, `dist/datum-pdf-pages.js`) is found the same way,
 * by the builder alone.
 */
import type { PdfPageRasterizer, RenderableRuntime, RenderFormPdfResult } from "@argusvane/datum-engine";
import { ChunkLoadError, importUrl, noteImportFailure } from "./chunk-load-error.js";
import type { DatumPdfSupport, RenderPdfOptions } from "./pdf.js";

const loads = new Map<string, Promise<DatumPdfSupport>>();
const pageLoads = new Map<string, Promise<PdfPageRasterizer>>();

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

/**
 * Loads the PDF module at `spec` (see {@link resolvePdfModuleUrl}) and builds its support once.
 * A module that is not there (deleted from the server, blocked, a 404) rejects as a
 * `ChunkLoadError` naming the URL (absent-code resilience), and the failure is
 * forgotten so the next PDF asks again.
 */
export function loadPdfSupport(spec: string): Promise<DatumPdfSupport> {
  const url = resolvePdfModuleUrl(spec);
  let load = loads.get(url);
  if (!load) {
    load = import(/* @vite-ignore */ importUrl(url)).then((module: { createPdfSupport?: () => Promise<DatumPdfSupport> }) => {
      if (typeof module.createPdfSupport !== "function") {
        throw new Error(`The PDF module at ${url} does not export createPdfSupport()`);
      }
      return module.createPdfSupport();
    }, (error: unknown): never => {
      noteImportFailure(url);
      throw new ChunkLoadError(`The PDF module (${url})`, error);
    });
    load.catch(() => loads.delete(url));
    loads.set(url, load);
  }
  return load;
}

/**
 * A runtime's form as a PDF, with no element: the PDF module's own `renderPdf` (`datum-pdf.js`),
 * from `pdf` (default `"auto"`, beside this bundle; a URL as the `pdf` attribute takes one). The
 * module is loaded as {@link loadPdfSupport} loads it, once per page and shared with
 * `<datum-form pdf>`, and draws with that support unless the call hands one of its own. None of
 * the PDF pipeline is in this bundle: it arrives with the module.
 */
export async function renderPdf(runtime: RenderableRuntime, options: RenderPdfOptions & { pdf?: string | undefined } = {}): Promise<RenderFormPdfResult> {
  const { pdf = "auto", support = await loadPdfSupport(pdf), ...rest } = options;
  // The module map holds the module loadPdfSupport imported: this asks for the same URL again.
  const module = (await import(/* @vite-ignore */ importUrl(resolvePdfModuleUrl(pdf)))) as { renderPdf: (runtime: RenderableRuntime, options: RenderPdfOptions) => Promise<RenderFormPdfResult> };
  return module.renderPdf(runtime, { ...rest, support });
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

/** Loads the page imagery module at `url` and builds its rasteriser once. */
export function loadPdfPageRasterizer(url: string): Promise<PdfPageRasterizer> {
  let load = pageLoads.get(url);
  if (!load) {
    load = import(/* @vite-ignore */ importUrl(url)).then((module: { createPdfPageRasterizer?: () => PdfPageRasterizer }) => {
      if (typeof module.createPdfPageRasterizer !== "function") {
        throw new Error(`The PDF pages module at ${url} does not export createPdfPageRasterizer()`);
      }
      return module.createPdfPageRasterizer();
    }, (error: unknown): never => {
      noteImportFailure(url);
      throw new ChunkLoadError(`The PDF pages module (${url})`, error);
    });
    load.catch(() => pageLoads.delete(url));
    pageLoads.set(url, load);
  }
  return load;
}
