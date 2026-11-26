/**
 * The `signature` block of a PDF layout read tolerantly, for the PDF render model (`pdf-render-model.ts`).
 *
 * Its own module, apart from `pdf-layout.ts`: the renderer's shells import that module for the
 * table slot ids, so under the Vite 8 (Rolldown) build it rides in the bundle's core chunk, and
 * this reader is the PDF service's alone (check-bundles guard 08 holds it out of the entry and
 * its core chunk).
 */
import { PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES, isRect, signatureCertifyOf, signatureCommitmentOf, signatureSubFilterOf } from "./pdf-layout-read.js";
import type { PdfSignatureAppearanceConfiguration, PdfSignatureConfiguration } from "./pdf-layout-read.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The `signature` block read tolerantly, like `resolvePdfConformance` in pdf-layout.ts: keys that are
 * not what they should be fall away; `undefined` for anything but an object.
 */
export function resolvePdfSignatureConfiguration(value: unknown): PdfSignatureConfiguration | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const out: PdfSignatureConfiguration = {};
  const subFilter = signatureSubFilterOf(value.subFilter);
  if (subFilter) {
    out.subFilter = subFilter;
  }
  const certify = signatureCertifyOf(value.certify);
  if (certify !== undefined) {
    out.certify = certify;
  }
  for (const key of ["field", "name", "location", "contactInfo"] as const) {
    const text = value[key];
    if (typeof text === "string" && text.trim() !== "") {
      out[key] = text;
    }
  }
  if (typeof value.reason === "string") {
    out.reason = value.reason;
  }
  const commitment = signatureCommitmentOf(value.commitment);
  if (commitment) {
    out.commitment = commitment;
  }
  if (value.appearance === false) {
    out.appearance = false;
  } else if (isRecord(value.appearance)) {
    const appearance = value.appearance;
    const resolved: PdfSignatureAppearanceConfiguration = {};
    if (typeof appearance.page === "number" && Number.isInteger(appearance.page) && appearance.page >= 1) {
      resolved.page = appearance.page;
    }
    if (isRect(appearance.rect)) {
      resolved.rect = appearance.rect;
    }
    if (Array.isArray(appearance.lines) && appearance.lines.every((line) => typeof line === "string")) {
      resolved.lines = appearance.lines as string[];
    }
    if (typeof appearance.fontId === "string") {
      resolved.fontId = appearance.fontId;
    }
    if (typeof appearance.fontSize === "number" && appearance.fontSize > 0) {
      resolved.fontSize = appearance.fontSize;
    }
    out.appearance = resolved;
  }
  if (typeof value.timestamp === "boolean") {
    out.timestamp = value.timestamp;
  }
  if (typeof value.required === "boolean") {
    out.required = value.required;
  }
  if (typeof value.placeholderBytes === "number" && Number.isInteger(value.placeholderBytes) && value.placeholderBytes > 0 && value.placeholderBytes <= PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES) {
    out.placeholderBytes = value.placeholderBytes;
  }
  return out;
}
