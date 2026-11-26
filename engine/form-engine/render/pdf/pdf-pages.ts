/**
 * Page imagery for the designer: the pages of an existing PDF as pictures an author
 * draws areas over. The engine only names the seam — a host plugs in a rasteriser (the
 * `datum-pdf-pages.js` module built on pdf.js, or its own, say pre-rendered images from a
 * server) and the template editor shows what it gets, or blank sheets of the right size when
 * there is none. Nothing here touches a DOM at module scope.
 */

/** One open document: its page count, each page's size in points, and each page as a picture. */
export interface PdfPageSet {
  pageCount: number;
  /** `index` is 1-based, like the fields the kernel's `inspect` op lists. Points. */
  pageSize(index: number): { width: number; height: number };
  /** The page drawn `scale` times its point size (1 = 72 dpi). */
  render(index: number, options: { scale: number }): Promise<HTMLCanvasElement | ImageBitmap | Blob>;
  /** Releases the document; nothing is rendered after it. */
  close(): void;
}

export interface PdfPageRasterizer {
  open(bytes: Uint8Array): Promise<PdfPageSet>;
}
