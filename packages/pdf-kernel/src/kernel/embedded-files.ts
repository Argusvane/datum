/**
 * The embedded files a PDF carries, read back: the catalog's
 * `EmbeddedFiles` name tree, kids followed, each file's bytes decoded — to hash them, as
 * `verify` does so a host can tell what a signature sealed, or to hand them back, as
 * `inspect` does when asked so a server can read the record a PDF was rendered
 * from. One reader for both: the same names, the same digests.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRawStream, PDFStream, PDFString, decodePDFRawStream } from "@cantoo/pdf-lib";
import { bytesToBase64, type PdfEmbeddedFileInfo, type PdfWarning } from "@argusvane/datum-engine/render";

import { sha256 } from "./util/sha256.js";

export interface ReadEmbeddedFilesOptions {
  /** Hand the bytes back (base64) beside the digest. */
  data: boolean;
  /** How deep a name tree is followed before it is called hostile. */
  maxDepth?: number;
}

function textOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function nameOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : undefined;
}

export function readEmbeddedFiles(pdf: PDFDocument, warnings: PdfWarning[], options: ReadEmbeddedFilesOptions): PdfEmbeddedFileInfo[] {
  const out: PdfEmbeddedFileInfo[] = [];
  const names = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  const root = names?.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  if (!root) {
    return out;
  }
  const maxDepth = options.maxDepth ?? 16;
  const visit = (node: PDFDict, depth: number): void => {
    if (depth > maxDepth) {
      return;
    }
    const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
    if (kids) {
      for (let i = 0; i < kids.size(); i += 1) {
        const kid = kids.lookupMaybe(i, PDFDict);
        if (kid) {
          visit(kid, depth + 1);
        }
      }
    }
    const list = node.lookupMaybe(PDFName.of("Names"), PDFArray);
    if (!list) {
      return;
    }
    for (let i = 0; i + 1 < list.size(); i += 2) {
      const key = list.lookup(i);
      const spec = list.lookupMaybe(i + 1, PDFDict);
      if (!spec) {
        continue;
      }
      const name = textOf(spec, "UF") ?? textOf(spec, "F") ?? (key instanceof PDFString || key instanceof PDFHexString ? key.decodeText() : `attachment ${out.length + 1}`);
      const ef = spec.lookupMaybe(PDFName.of("EF"), PDFDict);
      const stream = ef?.lookupMaybe(PDFName.of("UF"), PDFStream) ?? ef?.lookupMaybe(PDFName.of("F"), PDFStream);
      if (!stream) {
        warnings.push({ code: "signature.attachment", message: `The embedded file "${name}" has no stream.` });
        continue;
      }
      let bytes: Uint8Array;
      try {
        bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
      } catch (error) {
        warnings.push({ code: "signature.attachment", message: `The embedded file "${name}" could not be decoded: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }
      const relationship = nameOf(spec, "AFRelationship");
      const mimeType = nameOf(stream.dict, "Subtype");
      const description = textOf(spec, "Desc");
      out.push({
        name,
        sha256: bytesToBase64(sha256(bytes)),
        size: bytes.length,
        ...(relationship !== undefined ? { relationship } : {}),
        ...(mimeType !== undefined ? { mimeType: mimeType.replace("#2F", "/") } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(options.data ? { data: bytesToBase64(bytes) } : {})
      });
    }
  };
  visit(root, 0);
  return out;
}
