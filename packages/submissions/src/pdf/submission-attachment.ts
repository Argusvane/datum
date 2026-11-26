import type { PdfAttachment } from "@argusvane/datum-engine";

import { serializeDeliveredDocument, submissionDigest } from "../digest.js";
import { parseSubmissionDocument } from "../signatures/document.js";
import type { DeliveredDocument } from "../types.js";

/**
 * The record inside its PDF: the delivered document as `record.json`,
 * an associated file with the `Data` relationship — the PDF says "this is what I was rendered
 * from". The bytes are the document's canonical serialization, the very bytes the record's
 * digest is over, so the SHA-256 a `verify` report gives for this file *is* the record's
 * digest, and a PDF handed back later gives up the exact document, not a reading of its pages.
 * Not `submission.json`: that name is the layout's own PDF/A-3 data export (`conformance.attachData`), the answers alone, which a layout may embed beside this file.
 */
export const SUBMISSION_ATTACHMENT_NAME = "record.json";
export const SUBMISSION_ATTACHMENT_MIME = "application/json";

export function buildSubmissionAttachment(document: DeliveredDocument, recordId: string): PdfAttachment {
  const text = serializeDeliveredDocument(document);
  return {
    name: SUBMISSION_ATTACHMENT_NAME,
    mimeType: SUBMISSION_ATTACHMENT_MIME,
    description: `Datum submission ${recordId} — the envelope this document was rendered from`,
    relationship: "Data",
    data: bytesToBase64(new TextEncoder().encode(text))
  };
}

/** The bytes `submission.json` carries, read back into the document and the digest of its envelope. */
export function parseSubmissionAttachment(bytes: Uint8Array): { document: DeliveredDocument; digest: string } {
  const parsed = parseSubmissionDocument(new TextDecoder().decode(bytes));
  if (parsed.kind === "bare") {
    throw new Error("submission.json holds bare values, not an envelope");
  }
  return { document: parsed.document, digest: submissionDigest(parsed.document) };
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
