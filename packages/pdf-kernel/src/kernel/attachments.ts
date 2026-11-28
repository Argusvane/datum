/**
 * Associated files (the submission data and uploaded files): embedded
 * file streams, their file specifications, the `EmbeddedFiles` name tree and the catalog's
 * `/AF`. Written into any document — an ordinary PDF lists them in its attachment pane — and
 * gated by the PDF/A part where one is declared: parts 1 and 2 forbid arbitrary embedded
 * files, so those documents get a warning and none.
 *
 * Runs after the last drawing operation and before the PDF/A pass flushes the fonts. Nothing
 * here reads a clock: the modification date is the host's `env.createdAt`.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFRef, PDFStream, PDFString } from "@cantoo/pdf-lib";
import type { PdfAConformance, PdfAttachmentPolicy } from "@argusvane/datum-engine/core";
import type { PdfAttachment, PdfDocumentAttachment, PdfDocumentConformance, PdfKernelEnv, PdfWarning } from "@argusvane/datum-engine/render";
import { attachmentMimeType, base64ToBytes, enforceAttachmentBudget, isResolvedPdfAttachment, refusedAttachmentType, sanitizeAttachmentName } from "@argusvane/datum-engine/render";
import { pdfAPartOf } from "./pdfa.js";
import { pdfDateString } from "./writer.js";

export interface EmbedAttachmentsOptions {
  /** The PDF/A level the document declares, when it does. */
  claim: PdfAConformance | undefined;
  /** The model's conformance block: its `attachments` (the submission data) ride with the claim. */
  conformance: PdfDocumentConformance | undefined;
  /** The uploaded files, embedded whatever the claim allows. */
  attachments: readonly PdfDocumentAttachment[] | undefined;
  /**
   * The budget the uploaded files are charged against, over their decoded bytes, with the
   * declared-size check; absent, only the declared-size check applies.
   */
  attachmentPolicy?: PdfAttachmentPolicy | undefined;
  env: PdfKernelEnv;
  warnings: PdfWarning[];
}

/** Deflating costs an interpreter seconds per megabyte; a text upload past this is stored as it is. */
const FLATE_LIMIT = 1024 * 1024;

/**
 * Text-shaped content shrinks under flate, so a small text upload is deflated; an upload of
 * any other kind (a PDF, a picture, an archive — already compressed) or a large one is stored
 * as it is, which is what keeps a sandboxed render inside its clock.
 */
function compressible(mimeType: string, size: number): boolean {
  return size <= FLATE_LIMIT && (mimeType.startsWith("text/") || mimeType === "application/json" || mimeType === "application/xml" || /\+(json|xml)$/.test(mimeType));
}

const STREAM_OPEN = new Uint8Array([0x0a, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d, 0x0a]); // "\nstream\n"
const STREAM_CLOSE = new Uint8Array([0x0a, 0x65, 0x6e, 0x64, 0x73, 0x74, 0x72, 0x65, 0x61, 0x6d]); // "\nendstream"

/**
 * pdf-lib serialises a stream's bytes one at a time, which an interpreter feels on a
 * megabyte of upload. The same layout — the dictionary, `stream`, the bytes, `endstream` —
 * written with one copy; the bytes come from `getContents()`, so a flate stream still deflates.
 */
function copyInOneGo(stream: PDFStream): void {
  stream.copyBytesInto = function (this: PDFStream, buffer: Uint8Array, offset: number): number {
    this.updateDict();
    const initialOffset = offset;
    offset += this.dict.copyBytesInto(buffer, offset);
    buffer.set(STREAM_OPEN, offset);
    offset += STREAM_OPEN.length;
    const contents = this.getContents();
    buffer.set(contents, offset);
    offset += contents.length;
    buffer.set(STREAM_CLOSE, offset);
    offset += STREAM_CLOSE.length;
    return offset - initialOffset;
  };
}

/** The `EmbeddedFiles` name tree, flat, sorted by name; `undefined` when the document's is a kind this pass does not edit. */
function embeddedFilesNames(pdf: PDFDocument): PDFArray | undefined {
  const context = pdf.context;
  let names = pdf.catalog.lookupMaybe(PDFName.of("Names"), PDFDict);
  if (!names) {
    names = context.obj({});
    pdf.catalog.set(PDFName.of("Names"), names);
  }
  let embedded = names.lookupMaybe(PDFName.of("EmbeddedFiles"), PDFDict);
  if (!embedded) {
    embedded = context.obj({});
    names.set(PDFName.of("EmbeddedFiles"), embedded);
  }
  if (embedded.has(PDFName.of("Kids"))) {
    return undefined;
  }
  let list = embedded.lookupMaybe(PDFName.of("Names"), PDFArray);
  if (!list) {
    list = context.obj([]);
    embedded.set(PDFName.of("Names"), list);
  }
  return list;
}

/** Associates the files with the document: embedded file streams, file specifications, the name tree and `/AF`. Returns the names as written. */
function attachFiles(pdf: PDFDocument, attachments: readonly PdfAttachment[], env: PdfKernelEnv, warnings: PdfWarning[]): string[] {
  const context = pdf.context;
  const list = embeddedFilesNames(pdf);
  if (!list) {
    warnings.push({ code: "pdfa.attachments", message: "The document's embedded-files tree has kids, which this kernel does not edit; nothing was attached." });
    return [];
  }
  const entries: Array<[string, PDFRef]> = [];
  for (let i = 0; i + 1 < list.size(); i += 2) {
    const key = list.get(i);
    const value = list.get(i + 1);
    if ((key instanceof PDFString || key instanceof PDFHexString) && value instanceof PDFRef) {
      entries.push([key.decodeText(), value]);
    }
  }
  const taken = new Set(entries.map(([name]) => name));
  let af = pdf.catalog.lookupMaybe(PDFName.of("AF"), PDFArray);
  if (!af) {
    af = context.obj([]);
    pdf.catalog.set(PDFName.of("AF"), af);
  }
  const written: string[] = [];
  for (const attachment of attachments) {
    // The kernel cleans the name too: a host's own attachments reach it without the engine's pass.
    const base = sanitizeAttachmentName(attachment.name);
    let name = base;
    for (let n = 2; taken.has(name); n += 1) {
      name = base.replace(/(\.[^.]*)?$/, `-${n}$1`);
    }
    taken.add(name);
    const bytes = base64ToBytes(attachment.data);
    const mimeType = attachmentMimeType(attachment.mimeType);
    const dict = {
      Type: "EmbeddedFile",
      Subtype: mimeType,
      Params: { Size: bytes.length, ModDate: PDFString.of(pdfDateString(env.createdAt)) }
    };
    const embedded = compressible(mimeType, bytes.length) ? context.flateStream(bytes, dict) : context.stream(bytes, dict);
    copyInOneGo(embedded);
    const stream = context.register(embedded);
    const spec = context.register(
      context.obj({
        Type: "Filespec",
        F: PDFHexString.fromText(name),
        UF: PDFHexString.fromText(name),
        ...(attachment.description ? { Desc: PDFHexString.fromText(attachment.description) } : {}),
        AFRelationship: attachment.relationship,
        EF: { F: stream, UF: stream }
      })
    );
    entries.push([name, spec]);
    af.push(spec);
    written.push(name);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  while (list.size() > 0) {
    list.remove(list.size() - 1);
  }
  for (const [name, ref] of entries) {
    list.push(PDFHexString.fromText(name));
    list.push(ref);
  }
  return written;
}

/**
 * Embeds what the document carries: the conformance block's files when a level is declared,
 * the uploaded files always — unless the level is part 1 or 2, which forbid them. The uploaded
 * files are charged the budget again over their decoded bytes, and one whose bytes disagree with
 * the size its envelope declared is left out (`enforceAttachmentBudget`), so a host's own
 * resolution agrees with `renderFormPdf`'s. Returns the
 * names written, so the reply can say what is in the file; `undefined` when nothing was sent,
 * so a reply to a request without attachments reads as it did before.
 */
export function embedAttachments(pdf: PDFDocument, options: EmbedAttachmentsOptions): string[] | undefined {
  const { claim, conformance, env, warnings } = options;
  const submission: PdfDocumentAttachment[] = claim ? conformance?.attachments ?? [] : [];
  const uploads = options.attachments ?? [];
  if (submission.length + uploads.length === 0) {
    return undefined;
  }
  const resolved: PdfAttachment[] = [];
  const resolvedUploads: PdfDocumentAttachment[] = [];
  for (const candidate of [...submission, ...uploads]) {
    const refusedWhy = isResolvedPdfAttachment(candidate) ? refusedAttachmentType(candidate.mimeType, candidate.data, candidate.name) : undefined;
    if (refusedWhy !== undefined) {
      // The kernel backs the engine's check: a host's own attachments reach it without the collector.
      warnings.push({ code: "attachment.refusedType", message: `The file "${candidate.name}" was not attached: ${refusedWhy}.`, ...(candidate.componentId !== undefined ? { componentId: candidate.componentId } : {}) });
    } else if (isResolvedPdfAttachment(candidate)) {
      (submission.includes(candidate) ? resolved : resolvedUploads).push(candidate);
    } else {
      warnings.push({
        code: "attachment.unresolved",
        message: `The uploaded file "${candidate.name}" is in storage "${candidate.source.storage}", which the program cannot fetch; resolve it on the host. It was not attached.`,
        componentId: candidate.componentId
      });
    }
  }
  // The submission is the document's own data, not an upload: the budget is the uploads'.
  for (const upload of enforceAttachmentBudget(resolvedUploads, options.attachmentPolicy, (warning) => warnings.push(warning))) {
    resolved.push(upload as PdfAttachment);
  }
  if (resolved.length === 0) {
    return [];
  }
  if (claim && pdfAPartOf(claim) !== 3) {
    warnings.push({
      code: "pdfa.attachments",
      message: `Associated files need PDF/A-3; the document declares PDF/A-${claim}, so nothing was attached (${resolved.map((file) => file.name).join(", ")}).`
    });
    return [];
  }
  return attachFiles(pdf, resolved, env, warnings);
}
