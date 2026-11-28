/**
 * An earlier revision of a PDF. An incremental update only appends, so
 * the bytes up to the end of a signature's `/ByteRange` are the revision that signature
 * signed, ending at its own `%%EOF`. Loaded on its own, it shows the file as the signer saw it:
 * the signature dictionary, the fields and the pages before any later update defined them again.
 */
import type { PDFDocument } from "@cantoo/pdf-lib";
import { loadPdfDocument } from "../util/parse-depth.js";

/**
 * The file's first `end` bytes as a document of their own, or `undefined` when they do not
 * load (a cut that is not the end of a revision, a broken cross-reference). Never throws.
 */
export async function loadRevision(bytes: Uint8Array, end: number): Promise<PDFDocument | undefined> {
  if (!Number.isInteger(end) || end <= 0 || end > bytes.length) {
    return undefined;
  }
  try {
    return await loadPdfDocument(bytes.subarray(0, end), { updateMetadata: false, ignoreEncryption: true });
  } catch {
    return undefined;
  }
}
