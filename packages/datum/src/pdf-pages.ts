/**
 * Page imagery for the PDF designer: pdf.js drawing a template's pages so an
 * author can draw areas over them. Built as `dist/datum-pdf-pages.js`, a module only, loaded
 * on demand by `<datum-form-builder pdf>` beside their own bundle
 * — the renderer never needs it, and the classic scripts never carry it, the line the PDF
 * module and the sandbox already draw.
 *
 * pdf.js reads its worker, standard fonts, CMaps and wasm decoders from `pdfjs/` beside this
 * file (the build copies them there); every path can be overridden, or turned off, so an
 * air-gapped deployment serves them from wherever it likes and nothing is fetched from a CDN.
 */
import type { PdfPageRasterizer, PdfPageSet } from "@argusvane/datum-engine";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

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
}

function beside(path: string): string {
  return new URL(/* @vite-ignore */ path, import.meta.url).href;
}

function assetUrl(value: string | null | undefined, fallback: string): string | undefined {
  if (value === null) {
    return undefined;
  }
  return value ?? beside(fallback);
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
  const workerUrl = options.workerUrl ?? beside("./pdfjs/pdf.worker.min.mjs");
  const standardFontDataUrl = assetUrl(options.standardFontsUrl, "./pdfjs/standard_fonts/");
  const cMapUrl = assetUrl(options.cmapsUrl, "./pdfjs/cmaps/");
  const wasmUrl = assetUrl(options.wasmUrl, "./pdfjs/wasm/");
  const iccUrl = assetUrl(options.iccUrl, "./pdfjs/iccs/");
  return {
    async open(bytes: Uint8Array): Promise<PdfPageSet> {
      if (!pdfjs.GlobalWorkerOptions.workerSrc) {
        pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
      }
      // pdf.js takes the buffer over; a copy keeps the caller's bytes theirs.
      const task = pdfjs.getDocument({
        data: bytes.slice(),
        ...(standardFontDataUrl ? { standardFontDataUrl } : {}),
        ...(cMapUrl ? { cMapUrl, cMapPacked: true } : {}),
        ...(wasmUrl ? { wasmUrl } : {}),
        ...(iccUrl ? { iccUrl } : {}),
        useSystemFonts: standardFontDataUrl === undefined
      });
      const document = await task.promise;
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
        close: () => {
          void task.destroy();
        }
      };
    }
  };
}
