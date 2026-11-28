/**
 * Page imagery for the PDF designer: pdf.js drawing a template's pages so an
 * author can draw areas over them. Built as `dist/datum-pdf-pages.js`, a module only, loaded
 * on demand by `<datum-form-builder pdf>` beside their own bundle
 * — the renderer never needs it, and the classic scripts never carry it, the line the PDF
 * module and the sandbox already draw. It is one file with no chunks, so `pdf-pages-integrity`
 * can fetch it, check it and import it from a `blob:` URL.
 *
 * pdf.js reads its worker, standard fonts, CMaps and wasm decoders from `pdfjs/` beside this
 * file (the build copies them there); every path can be overridden, or turned off, so an
 * air-gapped deployment serves them from wherever it likes and nothing is fetched from a CDN.
 * Given the package's integrity manifest, this module fetches those files itself and holds each to
 * the manifest (see `manifest` below).
 */
import type { PdfPageRasterizer, PdfPageSet } from "@argusvane/datum-engine";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

import type { IntegrityManifest } from "./integrity.js";

export interface CreatePdfPageRasterizerOptions {
  /** The pdf.js worker module. Default: `pdfjs/pdf.worker.min.mjs` beside this module. */
  workerUrl?: string | undefined;
  /** Where the standard 14 fonts are served from (a URL prefix); `null` leaves them to the browser's own. */
  standardFontsUrl?: string | null | undefined;
  /** Where the CMaps for CJK text are served from; `null` for none. */
  cmapsUrl?: string | null | undefined;
  /** Where the wasm image decoders (JBIG2, JPEG 2000) are served from; `null` for none. */
  wasmUrl?: string | null | undefined;
  /** Where the ICC profiles are served from; `null` for none. */
  iccUrl?: string | null | undefined;
  /**
   * Where this module was served from, which the default paths above are found beside. Default: the
   * module's own URL. A page that imported the module from a `blob:` URL, after checking its bytes,
   * names the URL it fetched it from (the builder does, for `pdf-pages-integrity`).
   */
  baseUrl?: string | undefined;
  /**
   * The package's integrity manifest (`integrity.json`, which the page checked against a hash of its
   * own). Set, this module fetches the worker, the standard fonts, the CMaps and the wasm image
   * decoders itself and holds each to the hash the manifest lists for its path under `pdfjs/`; a
   * file the manifest does not list, or whose bytes differ, is refused. The worker runs from a
   * `blob:` URL of the bytes checked (`worker-src blob:` under a Content Security Policy), and the
   * data reach it through pdf.js's `BinaryDataFactory`. pdf.js fetches its ICC profiles, their
   * colour engine and the decoders' JavaScript fallbacks itself, with no hook to check them, so in
   * this mode none of them is loaded: colour profiles are not applied, and an image whose wasm
   * decoder cannot run (no `wasm-unsafe-eval`) is left out of the picture.
   */
  manifest?: IntegrityManifest | undefined;
}

/**
 * The files pdf.js asks the page for when the worker does not fetch them itself
 * (`useWorkerFetch: false`): its `BinaryDataFactory` kinds, each with the folder its files have in
 * `dist`, which is their path in the manifest.
 */
const PINNED_FOLDERS = { cMapUrl: "pdfjs/cmaps/", standardFontDataUrl: "pdfjs/standard_fonts/", wasmUrl: "pdfjs/wasm/" } as const;
const PINNED_WORKER = "pdfjs/pdf.worker.min.mjs";

/**
 * pdf.js's worker started from `blob`: resolved once the worker says it is ready, rejected when it
 * cannot start (a Content Security Policy whose `worker-src` does not list `blob:`).
 */
function startWorker(blob: Blob): Promise<Worker> {
  const url = URL.createObjectURL(blob);
  return new Promise<Worker>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(url, { type: "module" });
    } catch (error) {
      URL.revokeObjectURL(url);
      reject(error);
      return;
    }
    const settle = (): void => {
      worker.removeEventListener("message", ready);
      worker.removeEventListener("error", failed);
      URL.revokeObjectURL(url);
    };
    const ready = (event: MessageEvent): void => {
      if ((event.data as { action?: unknown } | null)?.action === "ready") {
        settle();
        resolve(worker);
      }
    };
    const failed = (): void => {
      settle();
      worker.terminate();
      reject(new Error("The pdf.js worker did not start from the bytes checked (a Content Security Policy must list blob: in worker-src)"));
    };
    worker.addEventListener("message", ready);
    worker.addEventListener("error", failed);
  });
}

/**
 * What a page picture may be: the designer lists the first 500 pages (the
 * kernel's inspection lists the same), and a page whose box is huge is drawn at a scale that keeps
 * its canvas within 8,192 pixels on a side, the viewer sizing it by the page's points as ever.
 */
export const MAX_RASTER_PAGES = 500;
export const MAX_RASTER_SIDE = 8192;

/** The pdf.js-backed rasteriser: one `open` per template, one canvas per page drawn. */
export function createPdfPageRasterizer(options: CreatePdfPageRasterizerOptions = {}): PdfPageRasterizer {
  const base = options.baseUrl ?? import.meta.url;
  const beside = (path: string): string => new URL(/* @vite-ignore */ path, base).href;
  const assetUrl = (value: string | null | undefined, fallback: string): string | undefined => (value === null ? undefined : (value ?? beside(fallback)));
  const workerUrl = options.workerUrl ?? beside("./pdfjs/pdf.worker.min.mjs");
  const standardFontDataUrl = assetUrl(options.standardFontsUrl, "./pdfjs/standard_fonts/");
  const cMapUrl = assetUrl(options.cmapsUrl, "./pdfjs/cmaps/");
  const wasmUrl = assetUrl(options.wasmUrl, "./pdfjs/wasm/");
  const iccUrl = assetUrl(options.iccUrl, "./pdfjs/iccs/");
  const manifest = options.manifest;
  let workerBytes: Promise<Blob> | undefined;

  /** The worker and the data factory of the manifest mode, the worker's bytes fetched and checked once. */
  async function pinnedWorker(held: IntegrityManifest): Promise<{ port: Worker; BinaryDataFactory: object }> {
    const { fetchListed } = await import("./integrity.js");
    const load = (workerBytes ??= fetchListed(held, PINNED_WORKER, workerUrl).then((bytes) => new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "text/javascript" })));
    load.catch(() => {
      if (workerBytes === load) {
        workerBytes = undefined;
      }
    });
    const port = await startWorker(await load);
    const served: Record<keyof typeof PINNED_FOLDERS, string | undefined> = { cMapUrl, standardFontDataUrl, wasmUrl };
    class PinnedBinaryDataFactory {
      fetch({ kind, filename }: { kind: string; filename: string }): Promise<Uint8Array> {
        const folder = Object.prototype.hasOwnProperty.call(PINNED_FOLDERS, kind) ? PINNED_FOLDERS[kind as keyof typeof PINNED_FOLDERS] : undefined;
        const url = folder === undefined ? undefined : served[kind as keyof typeof PINNED_FOLDERS];
        if (folder === undefined || url === undefined) {
          return Promise.reject(new Error(`pdf.js asked for ${kind} data, which this page does not serve`));
        }
        return fetchListed(held, `${folder}${filename}`, `${url}${filename}`);
      }
    }
    return { port, BinaryDataFactory: PinnedBinaryDataFactory };
  }

  return {
    async open(bytes: Uint8Array): Promise<PdfPageSet> {
      let pinned: { port: Worker; worker: pdfjs.PDFWorker; BinaryDataFactory: object } | undefined;
      if (manifest) {
        const { port, BinaryDataFactory } = await pinnedWorker(manifest);
        pinned = { port, worker: new pdfjs.PDFWorker({ port: port as never }), BinaryDataFactory };
      } else if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      // pdf.js takes the buffer over; a copy keeps the caller's bytes theirs.
      const task = pdfjs.getDocument({
        data: bytes.slice(),
        ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
        ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
        // The manifest mode names no wasm or ICC folder to the worker: it would fetch or import from them unchecked.
        ...(pinned
          ? { worker: pinned.worker, useWorkerFetch: false, BinaryDataFactory: pinned.BinaryDataFactory }
          : { ...(wasmUrl ? { wasmUrl } : {}), ...(iccUrl ? { iccUrl } : {}) }),
        useSystemFonts: standardFontDataUrl === undefined
      });
      // A worker of this module's own is not pdf.js's to end: it goes with the document.
      const end = (): void => {
        void task.destroy().finally(() => {
          pinned?.worker.destroy();
          pinned?.port.terminate();
        });
      };
      let document: pdfjs.PDFDocumentProxy;
      try {
        document = await task.promise;
      } catch (error) {
        if (pinned) {
          end();
        }
        throw error;
      }
      const pages = new Map<number, Promise<pdfjs.PDFPageProxy>>();
      const pageAt = (index: number): Promise<pdfjs.PDFPageProxy> => {
        let page = pages.get(index);
        if (!page) {
          page = document.getPage(index);
          pages.set(index, page);
        }
        return page;
      };
      const sizes = new Map<number, { width: number; height: number }>();
      // Sizes are read up front: the viewer lays the sheets out before any page is drawn.
      const pageCount = Math.min(document.numPages, MAX_RASTER_PAGES);
      for (let index = 1; index <= pageCount; index += 1) {
        const viewport = (await pageAt(index)).getViewport({ scale: 1 });
        sizes.set(index, { width: viewport.width, height: viewport.height });
      }
      return {
        pageCount,
        pageSize: (index) => {
          const size = sizes.get(index);
          if (!size) {
            throw new RangeError(`No page ${index}: the document lists ${pageCount}`);
          }
          return size;
        },
        async render(index, { scale }) {
          const page = await pageAt(index);
          let viewport = page.getViewport({ scale });
          const longest = Math.max(viewport.width, viewport.height);
          if (longest > MAX_RASTER_SIDE) {
            viewport = page.getViewport({ scale: (scale * MAX_RASTER_SIDE) / longest });
          }
          const canvas = window.document.createElement("canvas");
          canvas.width = Math.ceil(viewport.width);
          canvas.height = Math.ceil(viewport.height);
          await page.render({ canvas, viewport, annotationMode: pdfjs.AnnotationMode.ENABLE }).promise;
          return canvas;
        },
        close: end
      };
    }
  };
}
