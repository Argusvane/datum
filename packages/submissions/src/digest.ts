import { canonicalizeSubmission, sha256, type CanonicalSubmission } from "@argusvane/datum-engine";

import type { DeliveredDocument } from "./types.js";

/**
 * A record's identity across copies: SHA-256, hex, over the delivered
 * document's canonical serialization — every key sorted, no whitespace, exactly the bytes
 * `submission.json` carries inside the server's PDF. For an envelope (signatures embedded or
 * none) that is `serializeCanonicalSubmission(envelope)`, the digest the package's
 * signing step names; for a wrapper document it covers the wrapper, so the signatures around the envelope
 * are part of what the PDF's attachment report names.
 */
export function serializeDeliveredDocument(document: DeliveredDocument): string {
  return JSON.stringify(canonicalizeSubmission(document as CanonicalSubmission));
}

export function submissionDigest(document: DeliveredDocument): string {
  return bytesDigest(new TextEncoder().encode(serializeDeliveredDocument(document)));
}

/** SHA-256 hex of any bytes — a stored PDF's. */
export function bytesDigest(bytes: Uint8Array): string {
  return bytesToHex(sha256(bytes));
}

export function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** Base64 (as the PDF kernel reports a digest) to hex (as a record keeps one). */
export function base64ToHex(base64: string): string {
  const binary = atob(base64);
  let out = "";
  for (let index = 0; index < binary.length; index += 1) {
    out += binary.charCodeAt(index).toString(16).padStart(2, "0");
  }
  return out;
}
