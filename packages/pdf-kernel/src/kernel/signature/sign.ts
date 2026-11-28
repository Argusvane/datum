/**
 * Signing a PDF in two halves, the kernel doing everything but the one operation
 * that needs a private key:
 *
 * - `prepareSignature` takes any PDF, adds a signature field (or takes an unsigned one),
 *   writes the signature dictionary with its placeholders as an incremental update — the
 *   original bytes are untouched, so earlier signatures stay valid — then patches the
 *   `/ByteRange`, hashes the file and returns the DER signed attributes the host must sign.
 * - `completeSignature` takes the prepared file and the host's signature value, rebuilds the
 *   same attributes from the bytes (so a changed input is caught), assembles the CMS and
 *   writes it into the placeholder.
 *
 * A PDF/A file stays PDF/A: the widget gets an appearance with an embedded font, the new
 * font descriptor is completed, nothing else is touched.
 */
import { PDFDocument, PDFHexString, PDFName, PDFString } from "@cantoo/pdf-lib";
import {
  PdfKernelError,
  base64ToBytes,
  bytesToBase64,
  type PdfFontResource,
  type PdfKernelEnv,
  type PdfSignatureCertify,
  type PdfSignatureCompletion,
  type PdfSignatureSpec,
  type PdfSignatureSubFilter,
  type PdfSigningHandoff,
  type PdfWarning
} from "@argusvane/datum-engine/render";
import { completeFontDescriptors, declaredPdfA, existingIntent, pdfDateToXmp } from "../pdfa.js";
import { sha256 } from "../util/sha256.js";
import { pdfRect } from "../writer.js";
import { drawAppearance, emptyAppearance } from "./appearance.js";
import { COMMITMENT_TYPE_OIDS, buildSignedData, normalizeSignatureValue, parseTimestampToken, signedAttributes, timestampCovers, timestampRequest, type SignedAttributesInput } from "./cms.js";
import {
  attachSignatureValue,
  certificationPermissions,
  createField,
  declareEsicExtension,
  existingField,
  findSignatureFields,
  uniqueFieldName,
  type AcquiredField
} from "./field.js";
import { digestOverRanges, locatePlaceholder, locateUnfilled, patchByteRange, placeholderBytes, writeContents, type ByteRange } from "./placeholder.js";
import { chainNamesIssuer, parseCertificate, signatureAlgorithmFor, type ParsedCertificate } from "./x509.js";
import { loadPdfDocument } from "../util/parse-depth.js";

export interface PreparedSignature {
  bytes: Uint8Array;
  signing: PdfSigningHandoff;
  warnings: PdfWarning[];
}

export interface CompletedSignature {
  bytes: Uint8Array;
  field: string;
  cms: Uint8Array;
  timestamped: boolean;
}

/** Where a new signature goes when nothing says: the bottom-left of the page, half an inch in, 180 × 48 pt (PDF space). */
export const DEFAULT_APPEARANCE_RECT = { x: 36, y: 36, width: 180, height: 48 } as const;

function parseCertificates(certificates: readonly string[]): ParsedCertificate[] {
  if (!Array.isArray(certificates) || certificates.length === 0) {
    throw new PdfKernelError("signature", "A signature needs at least the signer's certificate");
  }
  return certificates.map((certificate, index) => {
    if (typeof certificate !== "string" || certificate === "") {
      throw new PdfKernelError("signature", `certificates[${index}] is not base64`);
    }
    return parseCertificate(base64ToBytes(certificate));
  });
}

/** `YYYY-MM-DD HH:MM UTC` from an ISO instant, for the appearance. */
function displayDate(iso: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(iso);
  return match ? `${match[1]} ${match[2]} UTC` : iso;
}

/** Days since 1970-01-01 for a civil date (Hinnant's days_from_civil) — no `Date`, which the sandbox forbids. */
function dayNumber(iso: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!match) {
    return undefined;
  }
  let year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  year -= month <= 2 ? 1 : 0;
  const era = Math.floor(year / 400);
  const yearOfEra = year - era * 400;
  const dayOfYear = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const dayOfEra = yearOfEra * 365 + Math.floor(yearOfEra / 4) - Math.floor(yearOfEra / 100) + dayOfYear;
  return era * 146097 + dayOfEra - 719468;
}

/** Days between two ISO instants, dates only. */
function daysBetween(from: string, to: string): number | undefined {
  const a = dayNumber(from);
  const b = dayNumber(to);
  return a === undefined || b === undefined ? undefined : b - a;
}

/** Certificate hygiene: warnings, never errors — the host chose the certificate. */
function certificateWarnings(leaf: ParsedCertificate, chain: readonly ParsedCertificate[], env: PdfKernelEnv, warnings: PdfWarning[]): void {
  const now = env.createdAt;
  if (leaf.notAfter < now) {
    warnings.push({ code: "signature.certificateExpired", message: `The signing certificate expired on ${leaf.notAfter}.` });
  } else {
    const left = daysBetween(now, leaf.notAfter);
    if (left !== undefined && left <= 30) {
      warnings.push({ code: "signature.certificateExpiring", message: `The signing certificate expires on ${leaf.notAfter}, in ${left} day${left === 1 ? "" : "s"}.` });
    }
  }
  if (leaf.notBefore > now) {
    warnings.push({ code: "signature.certificateNotYetValid", message: `The signing certificate is not valid before ${leaf.notBefore}.` });
  }
  if (!chainNamesIssuer(leaf, chain)) {
    warnings.push({ code: "signature.chainIncomplete", message: `No certificate in the request names the signer's issuer (${leaf.issuer}); a verifier may not be able to build the chain.` });
  }
}

function certifyOf(value: unknown): PdfSignatureCertify {
  return value === "noChanges" || value === "formFilling" || value === "annotations" ? value : false;
}

/** The commitment-type attribute a spec asks for: a named ETSI type, with the statement; nothing when absent. */
function commitmentOf(value: PdfSignatureSpec["commitment"]): Pick<SignedAttributesInput, "commitment"> {
  if (value === undefined || value === null) {
    return {};
  }
  const typeOid = (COMMITMENT_TYPE_OIDS as Record<string, string>)[String((value as { type?: unknown }).type)];
  if (!typeOid) {
    throw new PdfKernelError("signature", `Unknown commitment type "${String((value as { type?: unknown }).type)}"; use ${Object.keys(COMMITMENT_TYPE_OIDS).join(", ")}`);
  }
  const statement = (value as { statement?: unknown }).statement;
  if (statement !== undefined && typeof statement !== "string") {
    throw new PdfKernelError("signature", "commitment.statement must be a string");
  }
  return { commitment: { typeOid, ...(statement !== undefined && statement !== "" ? { statement } : {}) } };
}

function subFilterOf(value: unknown): PdfSignatureSubFilter {
  if (value === undefined || value === "ETSI.CAdES.detached") {
    return "ETSI.CAdES.detached";
  }
  if (value === "adbe.pkcs7.detached") {
    return "adbe.pkcs7.detached";
  }
  throw new PdfKernelError("signature", `Unknown subFilter "${String(value)}"; use ETSI.CAdES.detached or adbe.pkcs7.detached`);
}

/** The lines the generic appearance shows. */
function defaultLines(spec: PdfSignatureSpec, leaf: ParsedCertificate, env: PdfKernelEnv, certify: PdfSignatureCertify): string[] {
  const lines = [`Digitally signed by ${spec.name ?? leaf.commonName ?? leaf.subject}`, `Date: ${displayDate(env.createdAt)}`];
  if (spec.reason) {
    lines.push(`Reason: ${spec.reason}`);
  }
  if (spec.location) {
    lines.push(`Location: ${spec.location}`);
  }
  if (certify === "noChanges") {
    lines.push("Certified — no changes allowed");
  } else if (certify) {
    lines.push("Certified");
  }
  return lines;
}

async function acquire(pdf: PDFDocument, spec: PdfSignatureSpec, tooltip: string | undefined): Promise<AcquiredField> {
  const entries = findSignatureFields(pdf);
  if (spec.field !== undefined && spec.field !== "") {
    return existingField(pdf, entries, spec.field);
  }
  const pages = pdf.getPages();
  if (pages.length === 0) {
    throw new PdfKernelError("signature", "The document has no page to sign on");
  }
  const appearance = spec.appearance;
  const pageIndex = appearance && appearance.page !== undefined ? appearance.page - 1 : pages.length - 1;
  const page = pages[pageIndex];
  if (!page) {
    throw new PdfKernelError("signature", `The document has no page ${pageIndex + 1} for the signature`);
  }
  const box = appearance === false ? undefined : appearance?.rect;
  const rect =
    appearance === false
      ? { x: 0, y: 0, width: 0, height: 0 }
      : box
        ? pdfRect(page, { x: box[0], y: box[1], width: box[2], height: box[3] })
        : { ...DEFAULT_APPEARANCE_RECT };
  return createField(pdf, uniqueFieldName(entries.map((entry) => entry.name)), page, rect, tooltip);
}

/**
 * Adds the signature field and dictionary as an incremental update and returns the file with
 * its `/ByteRange` patched, plus what the host must sign.
 */
export async function prepareSignature(input: Uint8Array, spec: PdfSignatureSpec, fonts: readonly PdfFontResource[], env: PdfKernelEnv): Promise<PreparedSignature> {
  const warnings: PdfWarning[] = [];
  const chain = parseCertificates(spec.certificates);
  const leaf = chain[0]!;
  const algorithm = signatureAlgorithmFor(leaf);
  const subFilter = subFilterOf(spec.subFilter);
  const certify = certifyOf(spec.certify);
  if (spec.digestAlgorithm !== undefined && spec.digestAlgorithm !== "sha256") {
    throw new PdfKernelError("signature", `Unsupported digest algorithm "${String(spec.digestAlgorithm)}"; only sha256 is offered`);
  }
  certificateWarnings(leaf, chain, env, warnings);
  if (locateUnfilled(input)) {
    throw new PdfKernelError("signature", "The document carries a prepared signature no one completed; complete it before signing again");
  }
  const pdf = await loadPdfDocument(input, { forIncrementalUpdate: true, updateMetadata: false, ignoreEncryption: true });
  if (pdf.isEncrypted) {
    throw new PdfKernelError("signature", "An encrypted document cannot be signed");
  }
  const permissions = certificationPermissions(pdf);
  if (permissions === 1) {
    throw new PdfKernelError("signature", "The document is certified with no changes allowed; a further signature would break the certification");
  }
  const signed = findSignatureFields(pdf).some((entry) => entry.state === "signed");
  if (certify && (signed || permissions !== undefined)) {
    throw new PdfKernelError("signature", "A certification must be the document's first signature");
  }
  const capacity = placeholderBytes(
    chain.map((certificate) => certificate.der),
    spec.placeholderBytes,
    spec.timestamp === true
  );
  const lines = spec.appearance && spec.appearance.lines && spec.appearance.lines.length > 0 ? spec.appearance.lines : defaultLines(spec, leaf, env, certify);
  const field = await acquire(pdf, spec, lines[0]);
  const claim = declaredPdfA(pdf);
  if (spec.appearance === false || field.rect.width <= 0 || field.rect.height <= 0) {
    emptyAppearance(pdf, field);
  } else {
    const intent = existingIntent(pdf);
    await drawAppearance(pdf, field, {
      lines,
      fonts,
      ...(spec.appearance && spec.appearance.fontId !== undefined ? { fontId: spec.appearance.fontId } : {}),
      ...(spec.appearance && spec.appearance.fontSize !== undefined ? { fontSize: spec.appearance.fontSize } : {}),
      strict: claim !== undefined,
      declareRgb: intent !== undefined && intent.components !== 3,
      warnings
    });
  }
  attachSignatureValue(pdf, field, {
    subFilter,
    capacity,
    createdAt: env.createdAt,
    ...(spec.name !== undefined ? { name: spec.name } : leaf.commonName !== undefined ? { name: leaf.commonName } : {}),
    ...(spec.reason !== undefined ? { reason: spec.reason } : {}),
    ...(spec.location !== undefined ? { location: spec.location } : {}),
    ...(spec.contactInfo !== undefined ? { contactInfo: spec.contactInfo } : {}),
    certify
  });
  if (subFilter === "ETSI.CAdES.detached") {
    declareEsicExtension(pdf);
  }
  // Fonts are embedded here; under PDF/A the new descriptor then needs CIDSet and Length1.
  await pdf.flush();
  if (claim) {
    completeFontDescriptors(pdf, warnings);
  }
  const bytes = await pdf.save({
    // The update's cross-reference is the file's kind: a table cannot follow an xref stream.
    useObjectStreams: pdf.context.pdfFileDetails.useObjectStreams === true,
    objectsPerTick: Infinity,
    updateFieldAppearances: false,
    addDefaultPage: false
  });
  const located = locatePlaceholder(bytes, input.length);
  const byteRange: ByteRange = [0, located.contentsStart, located.contentsEnd, bytes.length - located.contentsEnd];
  patchByteRange(bytes, located.byteRangeAt, byteRange);
  const digest = digestOverRanges(bytes, byteRange);
  const attributes = signedAttributes({ digest, leaf, subFilter, signingTime: env.createdAt, ...commitmentOf(spec.commitment) });
  return {
    bytes,
    signing: {
      field: field.name,
      byteRange,
      digest: bytesToBase64(digest),
      toBeSigned: bytesToBase64(attributes.toBeSigned),
      toBeSignedDigest: bytesToBase64(sha256(attributes.toBeSigned)),
      signatureAlgorithm: algorithm,
      subFilter
    },
    warnings
  };
}

/** `/M` of the prepared signature dictionary, as an ISO instant. */
function signingTimeOf(value: string | undefined): string {
  const iso = value !== undefined ? pdfDateToXmp(value) : undefined;
  if (!iso) {
    throw new PdfKernelError("signature", "The prepared signature carries no signing time (/M)");
  }
  return iso;
}

/** Embeds the host's signature value — and a timestamp token, when given — into the prepared file. */
export async function completeSignature(prepared: Uint8Array, completion: PdfSignatureCompletion): Promise<CompletedSignature> {
  const located = locateUnfilled(prepared);
  if (!located) {
    throw new PdfKernelError("signature", "The document carries no prepared signature to complete");
  }
  const [, , end, tail] = located.byteRange;
  if (end + tail !== prepared.length) {
    throw new PdfKernelError("signature", "The prepared signature's byte range does not reach the end of the file; the bytes changed since sign");
  }
  const pdf = await loadPdfDocument(prepared, { updateMetadata: false, ignoreEncryption: true });
  const entry = findSignatureFields(pdf).find((candidate) => candidate.state === "prepared");
  if (!entry || !entry.value) {
    throw new PdfKernelError("signature", "The document carries no prepared signature field");
  }
  if (completion.field !== undefined && completion.field !== "" && completion.field !== entry.name) {
    throw new PdfKernelError("signature", `The prepared signature is in field "${entry.name}", not "${completion.field}"`);
  }
  const subFilterName = entry.value.lookup(PDFName.of("SubFilter"));
  const subFilter = subFilterOf(subFilterName instanceof PDFName ? subFilterName.decodeText() : undefined);
  const m = entry.value.lookup(PDFName.of("M"));
  const signingTime = signingTimeOf(m instanceof PDFString || m instanceof PDFHexString ? m.decodeText() : undefined);
  const chain = parseCertificates(completion.certificates);
  const leaf = chain[0]!;
  const algorithm = signatureAlgorithmFor(leaf);
  const digest = digestOverRanges(prepared, located.byteRange);
  const attributes = signedAttributes({ digest, leaf, subFilter, signingTime, ...commitmentOf(completion.commitment) });
  if (completion.toBeSignedDigest !== undefined && completion.toBeSignedDigest !== bytesToBase64(sha256(attributes.toBeSigned))) {
    throw new PdfKernelError("signature", "The signed attributes differ from what sign handed out: the bytes, the certificates or the commitment changed in between");
  }
  if (typeof completion.value !== "string" || completion.value === "") {
    throw new PdfKernelError("signature", "complete needs the signature value (base64)");
  }
  const signature = normalizeSignatureValue(base64ToBytes(completion.value), algorithm);
  let timestampToken: Uint8Array | undefined;
  if (completion.timestamp && typeof completion.timestamp.token === "string" && completion.timestamp.token !== "") {
    const timestamp = parseTimestampToken(base64ToBytes(completion.timestamp.token));
    if (!timestampCovers(timestamp, signature)) {
      throw new PdfKernelError("signature", "The timestamp token vouches for a different signature value");
    }
    timestampToken = timestamp.token;
  }
  const cms = buildSignedData({
    certificates: chain.map((certificate) => certificate.der),
    leaf,
    signedAttrsImplicit: attributes.implicitSet,
    algorithm,
    signature,
    ...(timestampToken ? { timestampToken } : {})
  });
  const bytes = new Uint8Array(prepared);
  writeContents(bytes, located, cms);
  return { bytes, field: entry.name, cms, timestamped: timestampToken !== undefined };
}

/** The RFC 3161 request a host posts to its timestamp authority, over a signature value. */
export function timestampRequestFor(signatureValue: Uint8Array): Uint8Array {
  return timestampRequest(signatureValue);
}
