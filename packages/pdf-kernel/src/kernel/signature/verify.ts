/**
 * Reading signatures back: for every signed field, whether the `/ByteRange` is the
 * shape the standard asks (from the start, around the hex string, to the end of the file or
 * short of a later revision), whether the file still hashes to the CMS's `messageDigest`,
 * whether the signing-certificate attribute names the certificate carried, and what the
 * signature says about itself. The one thing not checked is the signature value: that is the
 * host's platform crypto, over the `toBeVerified` bytes with the `signer.publicKey` handed back.
 * The embedded files are listed with their digests, so a host can tell what the signature sealed.
 *
 * The report carries what a server host would otherwise read out of the file
 * itself: the timestamp token taken apart (its digests and certificate binding checked here,
 * its signature left to the host like the signature's own), the signature dictionary as the
 * revision it covers defines it, and the trailer `/ID`.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString } from "@cantoo/pdf-lib";
import {
  PdfKernelError,
  bytesToBase64,
  type PdfAttachmentReport,
  type PdfLaterChangeKind,
  type PdfLaterRevisionsReport,
  type PdfSignatureChanges,
  type PdfSignatureDetails,
  type PdfSignatureReport,
  type PdfTimestampReport,
  type PdfWarning
} from "@argusvane/datum-engine/render";
import { readEmbeddedFiles } from "../embedded-files.js";
import { pdfDateToXmp } from "../pdfa.js";
import { sha256 } from "../util/sha256.js";
import { commitmentTypeName, digestFor, ecdsaToP1363, parseSignedData, parseTimestampToken, timestampCovers, type ParsedTimestamp } from "./cms.js";
import { OID, bytesEqual, fromHex, toHex } from "./der.js";
import { certificationSignature, docMdpPermissionsOf, findSignatureFields } from "./field.js";
import { digestOverRanges, rangeIsWellFormed, type ByteRange } from "./placeholder.js";
import { loadRevision } from "./revision.js";
import { analyzeLaterRevisions, type LaterChangeKind, type LaterRevisionsReport, type ReliedOnSignature } from "./revisions.js";
import { findByIssuerSerial, findBySubjectKeyId, parseCertificate, type ParsedCertificate } from "./x509.js";
import { loadPdfDocument } from "../util/parse-depth.js";

export interface VerifiedSignatures {
  signatures: PdfSignatureReport[];
  attachments: PdfAttachmentReport[];
  warnings: PdfWarning[];
  /** The first element of the last trailer `/ID`, lowercase hex, or `null`: the file's current claim, not authenticated. */
  documentId: string | null;
}

/** More signatures than any form would carry; past this the file is treated as hostile. */
const MAX_SIGNATURES = 64;

const PERMISSION_NAMES = { 1: "noChanges", 2: "formFilling", 3: "annotations" } as const;

function textOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function nameOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookup(PDFName.of(key));
  return value instanceof PDFName ? value.decodeText() : undefined;
}

function byteRangeOf(value: PDFDict): ByteRange | undefined {
  const entry = value.lookup(PDFName.of("ByteRange"));
  const array = entry instanceof PDFArray ? entry : undefined;
  if (!array || array.size() !== 4) {
    return undefined;
  }
  const numbers = array.asArray().map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : NaN));
  return numbers.every((n) => Number.isInteger(n) && n >= 0) ? (numbers as ByteRange) : undefined;
}

/** The hex the file holds between the range's spans, with whitespace dropped, lower-cased. */
function hexInFile(bytes: Uint8Array, range: ByteRange): string {
  let text = "";
  for (let i = range[1] + 1; i < range[2] - 1; i += 1) {
    const code = bytes[i]!;
    if (code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09) {
      continue;
    }
    text += String.fromCharCode(code);
  }
  return text.toLowerCase();
}

function certificatesOf(ders: readonly Uint8Array[], warnings: PdfWarning[], field: string): ParsedCertificate[] {
  const out: ParsedCertificate[] = [];
  for (const der of ders) {
    try {
      out.push(parseCertificate(der));
    } catch (error) {
      warnings.push({ code: "signature.certificate", message: `A certificate in "${field}" could not be read: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return out;
}

function signerOf(certificate: ParsedCertificate): PdfSignatureReport["signer"] {
  return {
    certificate: bytesToBase64(certificate.der),
    publicKey: bytesToBase64(certificate.spki),
    subject: certificate.subject,
    issuer: certificate.issuer,
    serialNumber: certificate.serialHex,
    notBefore: certificate.notBefore,
    notAfter: certificate.notAfter
  };
}

/**
 * The classifier's kinds are the ABI's: `revisions.ts` owns the logic, `pdf-abi.ts` the shape.
 * This fails to compile when the two unions drift apart.
 */
type SameUnion<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
const KINDS_AGREE: SameUnion<LaterChangeKind, PdfLaterChangeKind> = true;
void KINDS_AGREE;

/** The classifier's report as the ABI carries it (a compile-time check that it fits); `reliedOnSignatures` is named afterwards. */
function laterRevisionsReport(report: LaterRevisionsReport): PdfLaterRevisionsReport {
  return { revisions: report.revisions, changes: report.changes.map((change) => ({ ...change })), permitted: report.permitted, reliedOnSignatures: [] };
}

/** The ECDSA field size of a certificate's curve, for the `r‖s` form; `undefined` for any other key. */
function ecdsaSizeOf(certificate: ParsedCertificate): number | undefined {
  if (certificate.keyAlgorithm !== OID.ecPublicKey) {
    return undefined;
  }
  switch (certificate.curve) {
    case OID.prime256v1:
      return 32;
    case OID.secp384r1:
      return 48;
    case OID.secp521r1:
      return 66;
    default:
      // A curve the kernel does not size (brainpool, say): no `r‖s` form rather than a wrong one.
      return undefined;
  }
}

function p1363Of(signature: Uint8Array, certificate: ParsedCertificate | undefined): string | undefined {
  const size = certificate ? ecdsaSizeOf(certificate) : undefined;
  if (size === undefined) {
    return undefined;
  }
  try {
    return bytesToBase64(ecdsaToP1363(signature, size));
  } catch {
    return undefined;
  }
}

/** A signature dictionary's own entries, as the revision it was read from defines them. */
function detailsOf(value: PDFDict): PdfSignatureDetails {
  const signingTimeRaw = textOf(value, "M");
  const permissions = docMdpPermissionsOf(value);
  const reason = textOf(value, "Reason");
  const location = textOf(value, "Location");
  const name = textOf(value, "Name");
  const contactInfo = textOf(value, "ContactInfo");
  return {
    ...(reason !== undefined ? { reason } : {}),
    ...(location !== undefined ? { location } : {}),
    ...(name !== undefined ? { name } : {}),
    ...(contactInfo !== undefined ? { contactInfo } : {}),
    signingTime: signingTimeRaw !== undefined ? (pdfDateToXmp(signingTimeRaw) ?? null) : null,
    certification: permissions !== undefined ? { permissions: PERMISSION_NAMES[permissions] } : null
  };
}

const DETAIL_KEYS = ["reason", "location", "name", "contactInfo", "signingTime", "certification"] as const;

/** The keys whose latest value differs from the signed one, with the latest value (`null` for none). */
function changesBetween(signed: PdfSignatureDetails, latest: PdfSignatureDetails): PdfSignatureChanges {
  const changes: Record<string, unknown> = {};
  for (const key of DETAIL_KEYS) {
    const before = key === "certification" ? (signed.certification?.permissions ?? null) : (signed[key] ?? null);
    const after = key === "certification" ? (latest.certification?.permissions ?? null) : (latest[key] ?? null);
    if (before !== after) {
      changes[key] = latest[key] ?? null;
    }
  }
  return changes as PdfSignatureChanges;
}

/** A dictionary that looks like a signature value: a `/ByteRange` and a hex-string `/Contents`. */
function isSignatureValue(dict: PDFDict): boolean {
  return dict.has(PDFName.of("ByteRange")) && dict.lookup(PDFName.of("Contents")) instanceof PDFHexString;
}

/** The `/Contents` hex as one key, whitespace dropped, lower-cased. */
function contentsHexOf(value: PDFDict): string | undefined {
  const contents = value.lookup(PDFName.of("Contents"));
  return contents instanceof PDFHexString ? contents.asString().replace(/\s+/g, "").toLowerCase() : undefined;
}

/**
 * What tells two signature dictionaries apart: the `/Contents` and the `/ByteRange` together. A
 * later copy with the same `/Contents` and another range is another signature (one whose
 * digest will not hold), and reporting it must not hide the one it copies.
 */
function signatureKey(hex: string, range: readonly number[] | undefined): string {
  return `${range ? range.join(",") : "?"}:${hex.replace(/\s+/g, "").toLowerCase()}`;
}

const WHITE_SPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const EOF_MARKER = [0x25, 0x25, 0x45, 0x4f, 0x46]; // "%%EOF"

/** Whether the bytes before `end`, trailing white space aside, end in `%%EOF`: the end of a revision. */
function endsRevision(bytes: Uint8Array, end: number): boolean {
  let at = end;
  while (at > 0 && WHITE_SPACE.has(bytes[at - 1]!)) {
    at -= 1;
  }
  if (at < EOF_MARKER.length) {
    return false;
  }
  return EOF_MARKER.every((code, i) => bytes[at - EOF_MARKER.length + i] === code);
}

/**
 * The earlier revisions one `verify` loads: each end parsed once, only an end that closes a
 * revision, and no more than `MAX_SIGNATURES` distinct ends. A `/ByteRange` written in a
 * comment or a string must not make the program parse the file again for every copy.
 */
interface RevisionLoader {
  load(end: number): Promise<PDFDocument | undefined>;
  /** Whether an end was refused for the limit. */
  limited(): boolean;
}

function revisionLoader(bytes: Uint8Array): RevisionLoader {
  const loaded = new Map<number, Promise<PDFDocument | undefined>>();
  let refused = false;
  return {
    load(end: number): Promise<PDFDocument | undefined> {
      const cached = loaded.get(end);
      if (cached) {
        return cached;
      }
      if (!endsRevision(bytes, end)) {
        return Promise.resolve(undefined);
      }
      if (loaded.size >= MAX_SIGNATURES) {
        refused = true;
        return Promise.resolve(undefined);
      }
      const promise = loadRevision(bytes, end);
      loaded.set(end, promise);
      return promise;
    },
    limited: () => refused
  };
}

interface SignedRevision {
  details: PdfSignatureDetails;
  /** The field's name in that revision, when its field tree names it. */
  fieldName?: string;
  /** That revision's trailer `/ID`, first element. */
  documentId: string | null;
  /** The dictionary as that revision defines it. */
  value: PDFDict;
}

/** The signature value with this range and this gap among a document's indirect dictionaries. */
function findValueByRange(pdf: PDFDocument, range: ByteRange, gap: string): PDFDict | undefined {
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && isSignatureValue(object)) {
      const own = byteRangeOf(object);
      if (own !== undefined && own.every((n, i) => n === range[i]) && contentsHexOf(object) === gap) {
        return object;
      }
    }
  }
  return undefined;
}

/**
 * The signature dictionary in the revision the range ends with: the field of the same name
 * whose `/ByteRange` is this one and whose `/Contents` is what the gap holds, else any field
 * that matches so (a later revision may have renamed the field), else any dictionary in that
 * revision that matches so. The revision's trailer is inside the signed bytes, so its `/ID`
 * is the one the signer signed.
 */
async function readSignedRevision(revisions: RevisionLoader, bytes: Uint8Array, range: ByteRange, field: string | undefined): Promise<SignedRevision | undefined> {
  const revision = await revisions.load(range[2] + range[3]);
  if (!revision || revision.isEncrypted) {
    return undefined;
  }
  try {
    const gap = hexInFile(bytes, range);
    const holds = (value: PDFDict): boolean => {
      const own = byteRangeOf(value);
      return own !== undefined && own.every((n, i) => n === range[i]) && contentsHexOf(value) === gap;
    };
    const entries = findSignatureFields(revision).filter((entry) => entry.value !== undefined);
    const found = (field !== undefined ? entries.find((entry) => entry.name === field && holds(entry.value!)) : undefined) ?? entries.find((entry) => holds(entry.value!));
    const value = found?.value ?? findValueByRange(revision, range, gap);
    if (!value) {
      return undefined;
    }
    return { details: detailsOf(value), ...(found ? { fieldName: found.name } : {}), documentId: documentIdOf(revision), value };
  } catch {
    return undefined;
  }
}

/** Where `/ByteRange [a b c d]` is written in the file, each distinct array once. */
function byteRangesWritten(bytes: Uint8Array): ByteRange[] {
  const key = [0x2f, 0x42, 0x79, 0x74, 0x65, 0x52, 0x61, 0x6e, 0x67, 0x65]; // "/ByteRange"
  const out: ByteRange[] = [];
  const distinct = new Set<string>();
  let at = bytes.indexOf(0x2f);
  while (at >= 0 && at + key.length < bytes.length) {
    let matches = true;
    for (let i = 1; i < key.length; i += 1) {
      if (bytes[at + i] !== key[i]) {
        matches = false;
        break;
      }
    }
    if (matches) {
      const range = readNumbers(bytes, at + key.length);
      if (range && !distinct.has(range.join(","))) {
        distinct.add(range.join(","));
        out.push(range);
      }
    }
    at = bytes.indexOf(0x2f, at + 1);
  }
  return out;
}

/** `[ n n n n ]` at `from`, white space allowed around the numbers. */
function readNumbers(bytes: Uint8Array, from: number): ByteRange | undefined {
  const isSpace = (code: number | undefined): boolean => code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
  let at = from;
  while (isSpace(bytes[at])) {
    at += 1;
  }
  if (bytes[at] !== 0x5b) {
    return undefined;
  }
  at += 1;
  const numbers: number[] = [];
  for (let n = 0; n < 4; n += 1) {
    while (isSpace(bytes[at])) {
      at += 1;
    }
    let value = 0;
    let digits = 0;
    while (bytes[at] !== undefined && bytes[at]! >= 0x30 && bytes[at]! <= 0x39 && digits < 16) {
      value = value * 10 + (bytes[at]! - 0x30);
      digits += 1;
      at += 1;
    }
    if (digits === 0) {
      return undefined;
    }
    numbers.push(value);
  }
  while (isSpace(bytes[at])) {
    at += 1;
  }
  return bytes[at] === 0x5d ? (numbers as ByteRange) : undefined;
}

interface Candidate {
  /** The dictionary as the latest file defines it, or as its signed revision does when the latest no longer defines it. */
  value: PDFDict;
  /** Its field's name in the latest field tree; absent when no field there holds it. */
  name?: string;
  /** Found only in the revision it signed: the latest file no longer defines this dictionary. */
  fromRevision?: SignedRevision;
  state: "prepared" | "signed";
}

/**
 * Every signature the file holds, not only those its latest field tree links: a later update
 * may unlink a certification, or define its dictionary again as something else, and it must
 * then show as changed rather than vanish. Read from the field tree, the catalog's
 * `/Perms /DocMDP`, every indirect dictionary with a `/ByteRange` and a hex `/Contents`, and
 * every `/ByteRange` array written in the bytes whose signed revision still holds the
 * dictionary. One signature is reported once, by its `/Contents` and `/ByteRange`. A range
 * written in the bytes is looked into only when it frames hex and ends a revision.
 */
async function collectSignatures(pdf: PDFDocument, bytes: Uint8Array, warnings: PdfWarning[], revisions: RevisionLoader): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const add = (value: PDFDict, name: string | undefined, fromRevision?: SignedRevision): void => {
    const hex = contentsHexOf(value);
    if (hex === undefined) {
      return;
    }
    const key = signatureKey(hex, byteRangeOf(value));
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    out.push({ value, ...(name !== undefined ? { name } : {}), ...(fromRevision ? { fromRevision } : {}), state: /^0*$/.test(hex) ? "prepared" : "signed" });
    if (out.length > MAX_SIGNATURES) {
      throw new PdfKernelError("signature", `The document carries more than ${MAX_SIGNATURES} signatures; it is not read`);
    }
  };
  const fieldProblem = (message: string): void => {
    warnings.push({ code: "signature.malformed", message });
  };
  for (const entry of findSignatureFields(pdf, fieldProblem)) {
    if (entry.value !== undefined && entry.state !== "unsigned") {
      add(entry.value, entry.name);
    }
  }
  const certification = certificationSignature(pdf);
  if (certification && isSignatureValue(certification)) {
    add(certification, undefined);
  }
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict && isSignatureValue(object)) {
      add(object, undefined);
    }
  }
  // The loader's slots go to the signatures the file defines first, in this order (field tree,
  // /Perms, other dictionaries), and only then to ranges merely written in the bytes: decoys
  // planted to use up the limit lose their own slots, never a real signature's.
  for (const candidate of out) {
    const range = byteRangeOf(candidate.value);
    if (range && rangeIsWellFormed(bytes, range) && range[2] + range[3] !== bytes.length) {
      await revisions.load(range[2] + range[3]);
    }
  }
  for (const range of byteRangesWritten(bytes)) {
    if (!rangeIsWellFormed(bytes, range) || !endsRevision(bytes, range[2] + range[3])) {
      continue;
    }
    const gap = hexInFile(bytes, range);
    if (!/^[0-9a-f]*$/.test(gap) || seen.has(signatureKey(gap, range))) {
      continue;
    }
    const signed = await readSignedRevision(revisions, bytes, range, undefined);
    if (signed) {
      add(signed.value, undefined, signed);
    }
  }
  return out;
}

/** The first element of the trailer `/ID` the loaded file ends with, lowercase hex. */
function documentIdOf(pdf: PDFDocument): string | null {
  const id = pdf.context.trailerInfo.ID;
  const array = id ? pdf.context.lookup(id) : undefined;
  const first = array instanceof PDFArray && array.size() > 0 ? array.lookup(0) : undefined;
  return first instanceof PDFHexString || first instanceof PDFString ? toHex(first.asBytes()) : null;
}

/**
 * The token taken apart for the host: what the program checks (the imprint, the messageDigest
 * over the TSTInfo, the content type, the certificate binding) and what the host checks the
 * TSA's signature with.
 */
function timestampReportOf(token: ParsedTimestamp, signatureValue: Uint8Array, warnings: PdfWarning[], field: string, known: readonly ParsedCertificate[]): PdfTimestampReport {
  const certificates = certificatesOf(token.certificates, warnings, field);
  const base: PdfTimestampReport = {
    time: token.time,
    ...(token.tsa !== undefined ? { tsa: token.tsa } : {}),
    coversSignature: timestampCovers(token, signatureValue),
    token: bytesToBase64(token.token),
    imprintAlgorithm: token.imprintAlgorithm,
    imprint: bytesToBase64(token.imprint),
    serial: token.serialHex,
    ...(token.nonceHex !== undefined ? { nonce: token.nonceHex } : {}),
    ...(token.accuracy ? { accuracy: token.accuracy } : {}),
    certificates: certificates.map((certificate) => bytesToBase64(certificate.der))
  };
  const info = token.signer;
  if (!info) {
    warnings.push({ code: "signature.timestamp", message: `The timestamp on "${field}" has a SignerInfo the kernel cannot read: ${token.signerProblem ?? "unknown"}` });
    return { ...base, digestAlgorithm: "", toBeVerified: "", signatureAlgorithm: "", signature: "", signer: null, signerSource: null, messageDigestMatches: false, contentTypeMatches: false, certificateMatches: false };
  }
  const named = (among: readonly ParsedCertificate[]): ParsedCertificate | undefined => (info.keyId ? findBySubjectKeyId(among, info.keyId) : findByIssuerSerial(among, info.issuerTlv!, info.serialTlv!));
  // The token's own certificates first; a token asked for without certReq carries none, and the host may know its TSA's.
  const carried = named(certificates);
  const knownSigner = named(known);
  if (carried && knownSigner && !bytesEqual(carried.der, knownSigner.der)) {
    warnings.push({ code: "signature.certificateMismatch", message: `The timestamp on "${field}" carries a certificate for its signer that differs from the known one with the same name; the carried one is reported.` });
  }
  const signer = carried ?? knownSigner;
  const signerSource = carried ? "token" : signer ? "known" : null;
  const expected = digestFor(info.digestAlgorithm, token.tstInfo);
  if (!expected) {
    warnings.push({ code: "signature.timestamp", message: `The timestamp on "${field}" uses digest algorithm ${info.digestAlgorithm}; its messageDigest is not checked.` });
  }
  let certificateMatches = false;
  if (!signer) {
    warnings.push({ code: "signature.timestamp", message: `The timestamp on "${field}" names a signer whose certificate neither it nor the known certificates hold.` });
  } else if (info.essCertId === undefined) {
    // RFC 3161 §2.4.2 requires the attribute on a token: without it the TSA's certificate is not bound, which counts as no match.
    warnings.push({ code: "signature.timestamp", message: `The timestamp on "${field}" carries no signing-certificate attribute, which RFC 3161 requires; its certificate is not bound to the signed attributes.` });
  } else if (info.essCertId !== null) {
    const hash = digestFor(info.essCertId.algorithm, signer.der);
    certificateMatches = hash !== undefined && bytesEqual(hash, info.essCertId.hash);
  }
  const signatureP1363 = p1363Of(info.signature, signer);
  return {
    ...base,
    digestAlgorithm: info.digestAlgorithm,
    toBeVerified: bytesToBase64(info.toBeVerified),
    signatureAlgorithm: info.signatureAlgorithm,
    signature: bytesToBase64(info.signature),
    ...(signatureP1363 !== undefined ? { signatureP1363 } : {}),
    signer: signer ? signerOf(signer) : null,
    signerSource,
    messageDigestMatches: expected !== undefined && info.messageDigest !== undefined && bytesEqual(expected, info.messageDigest),
    contentTypeMatches: info.contentType === OID.tstInfo,
    certificateMatches
  };
}

/** The embedded files under the catalog's `EmbeddedFiles` name tree, digests only: what the signature sealed. */
function attachmentsOf(pdf: PDFDocument, warnings: PdfWarning[]): PdfAttachmentReport[] {
  return readEmbeddedFiles(pdf, warnings, { data: false }).map(({ name, sha256: digest, size, relationship }) => ({ name, sha256: digest, size, ...(relationship !== undefined ? { relationship } : {}) }));
}

export interface VerifyOptions {
  /** Certificates the host already knows, DER: where a signer the file names but does not carry is looked for. */
  knownCertificates?: readonly Uint8Array[];
}

export async function verifySignatures(bytes: Uint8Array, options: VerifyOptions = {}): Promise<VerifiedSignatures> {
  const warnings: PdfWarning[] = [];
  const known = certificatesOf(options.knownCertificates ?? [], warnings, "knownCertificates");
  const pdf = await loadPdfDocument(bytes, { updateMetadata: false, ignoreEncryption: true });
  if (pdf.isEncrypted) {
    throw new PdfKernelError("signature", "An encrypted document's signatures cannot be read");
  }
  const revisions = revisionLoader(bytes);
  const signatures: PdfSignatureReport[] = [];
  // Each signature's field by its key, so the signatures a classifier relied on can be named.
  const fieldByKey = new Map<string, string>();
  const relied = new Map<PdfLaterRevisionsReport, readonly ReliedOnSignature[]>();
  for (const candidate of await collectSignatures(pdf, bytes, warnings, revisions)) {
    const value = candidate.value;
    const range = byteRangeOf(value);
    const contents = value.lookup(PDFName.of("Contents"));
    const label = candidate.name ?? "(unlinked)";
    if (!range || !(contents instanceof PDFHexString)) {
      warnings.push({ code: "signature.malformed", message: `The signature in "${label}" has no usable /ByteRange or /Contents.` });
      continue;
    }
    const wellFormed = rangeIsWellFormed(bytes, range);
    const gap = wellFormed ? hexInFile(bytes, range) : undefined;
    const hexMatches = gap !== undefined && gap === contents.asString().replace(/\s+/g, "").toLowerCase();
    if (!wellFormed || !hexMatches) {
      warnings.push({ code: "signature.byteRange", message: `The /ByteRange of "${label}" does not frame its /Contents; the signature cannot be trusted.` });
    }
    const coversDocument = wellFormed && range[2] + range[3] === bytes.length;
    // What was signed: the file itself when the range reaches its end, else the revision the range ends with.
    let signed: SignedRevision | undefined = candidate.fromRevision;
    if (!signed && !coversDocument && wellFormed) {
      signed = await readSignedRevision(revisions, bytes, range, candidate.name);
    }
    const field = candidate.name ?? signed?.fieldName ?? "";
    fieldByKey.set(signatureKey(contents.asString(), range), field);
    if (candidate.name === undefined) {
      warnings.push({
        code: "signature.unlinked",
        message: candidate.fromRevision
          ? `A signature${field ? ` in "${field}"` : ""} is no longer defined by the file's latest revision; it is read from the revision it signed.`
          : `A signature${field ? ` once in "${field}"` : ""} is in no field of the file's latest revision.`
      });
    }
    // A dictionary only its own revision still defines has no latest definition: its details are the signed ones.
    const latest = detailsOf(value);
    let revision: Pick<PdfSignatureReport, "details" | "signedRevision" | "changedAfter" | "signedDocumentId"> = { details: "current" };
    if (coversDocument) {
      revision = { details: "signed", changedAfter: {}, signedDocumentId: documentIdOf(pdf) };
    } else if (signed) {
      revision = { details: "signed", signedRevision: signed.details, changedAfter: changesBetween(signed.details, latest), signedDocumentId: signed.documentId };
    } else if (wellFormed) {
      warnings.push({ code: "signature.revision", message: `The revision the signature in "${label}" covers could not be read; its details are the file's latest and what changed after it is not judged.` });
    }
    // What the updates after it changed, judged by the permissions the signed revision gives.
    // Without the signed revision nothing is judged: the latest dictionary's permissions are not the signer's.
    let laterRevisions: PdfLaterRevisionsReport | undefined;
    if (!coversDocument && signed && gap !== undefined) {
      const permissions = signed.details.certification?.permissions;
      try {
        const report = await analyzeLaterRevisions(bytes, range[2] + range[3], {
          ...(permissions !== undefined ? { permissions } : {}),
          ...(signed.fieldName !== undefined ? { fieldName: signed.fieldName } : {}),
          signatureContentsHex: gap
        });
        laterRevisions = laterRevisionsReport(report);
        relied.set(laterRevisions, report.reliedOnSignatures);
      } catch (error) {
        warnings.push({ code: "signature.revisions", message: `The updates after the signature in "${label}" could not be read: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    const base: Omit<PdfSignatureReport, "digestMatches" | "certificateMatches" | "signer" | "certificates" | "signatureAlgorithm" | "toBeVerified" | "signature"> = {
      field,
      subFilter: nameOf(value, "SubFilter") ?? "",
      byteRange: range,
      coversDocument,
      ...latest,
      ...revision,
      ...(laterRevisions ? { laterRevisions } : {})
    };
    if (candidate.state === "prepared") {
      warnings.push({ code: "signature.unfinished", message: `The signature in "${label}" was prepared and never completed.` });
      signatures.push({ ...base, digestMatches: false, certificateMatches: false, signer: null, signerSource: null, certificates: [], signatureAlgorithm: "", toBeVerified: "", signature: "" });
      continue;
    }
    let cms;
    try {
      cms = parseSignedData(fromHex(contents.asString()));
    } catch (error) {
      warnings.push({ code: "signature.malformed", message: `The signature in "${label}" is not a CMS the kernel can read: ${error instanceof Error ? error.message : String(error)}` });
      signatures.push({ ...base, digestMatches: false, certificateMatches: false, signer: null, signerSource: null, certificates: [], signatureAlgorithm: "", toBeVerified: "", signature: "" });
      continue;
    }
    let digestMatches = false;
    if (cms.digestAlgorithm === OID.sha256) {
      digestMatches = wellFormed && hexMatches && cms.messageDigest !== undefined && bytesEqual(cms.messageDigest, digestOverRanges(bytes, range));
    } else {
      warnings.push({ code: "signature.digestAlgorithm", message: `The signature in "${label}" uses digest algorithm ${cms.digestAlgorithm}; only SHA-256 is checked.` });
    }
    const certificates = certificatesOf(cms.certificates, warnings, label);
    const carriedLeaf = findByIssuerSerial(certificates, cms.signerIssuerTlv, cms.signerSerialTlv);
    const knownLeaf = findByIssuerSerial(known, cms.signerIssuerTlv, cms.signerSerialTlv);
    if (carriedLeaf && knownLeaf && !bytesEqual(carriedLeaf.der, knownLeaf.der)) {
      warnings.push({ code: "signature.certificateMismatch", message: `The signature in "${label}" carries a certificate for its signer that differs from the known one with the same issuer and serial; the carried one is reported.` });
    }
    const leaf = carriedLeaf ?? knownLeaf;
    let certificateMatches = false;
    if (leaf) {
      if (cms.essCertHash) {
        certificateMatches = bytesEqual(cms.essCertHash, sha256(leaf.der));
      } else {
        // A carried certificate without the attribute is the signer's by the CMS's own word, as before; a known one is
        // named only by the unsigned SignerIdentifier, so without the attribute nothing binds it.
        certificateMatches = carriedLeaf !== undefined;
        warnings.push({ code: "signature.noSigningCertificate", message: `The signature in "${label}" carries no signing-certificate attribute; the certificate is not bound to the signed attributes.` });
      }
    } else {
      warnings.push({ code: "signature.signerMissing", message: `The signature in "${label}" names a signer whose certificate neither it nor the known certificates hold.` });
    }
    const signatureP1363 = p1363Of(cms.signature, leaf);
    let timestamp: PdfSignatureReport["timestamp"];
    if (cms.timestampToken) {
      try {
        timestamp = timestampReportOf(parseTimestampToken(cms.timestampToken), cms.signature, warnings, label, known);
      } catch (error) {
        warnings.push({ code: "signature.timestamp", message: `The timestamp on "${label}" could not be read: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
    signatures.push({
      ...base,
      digestMatches,
      certificateMatches,
      signer: leaf ? signerOf(leaf) : null,
      signerSource: carriedLeaf ? "signature" : leaf ? "known" : null,
      certificates: certificates.map((certificate) => bytesToBase64(certificate.der)),
      signatureAlgorithm: cms.signatureAlgorithm,
      toBeVerified: bytesToBase64(cms.toBeVerified),
      signature: bytesToBase64(cms.signature),
      ...(signatureP1363 !== undefined ? { signatureP1363 } : {}),
      ...(cms.signingTime !== undefined ? { signingTimeAttribute: cms.signingTime } : {}),
      ...(timestamp ? { timestamp } : {}),
      ...(cms.commitment ? { commitment: { type: commitmentTypeName(cms.commitment.typeOid), ...(cms.commitment.statement !== undefined ? { statement: cms.commitment.statement } : {}) } } : {})
    });
  }
  // The later signatures a classifier trusted to seal their updates, named by the reports above, for the host to check.
  for (const [report, entries] of relied) {
    report.reliedOnSignatures = entries.map((entry) => ({ field: fieldByKey.get(signatureKey(entry.contentsHex, entry.byteRange)) ?? "", byteRange: [...entry.byteRange] }));
  }
  if (revisions.limited()) {
    warnings.push({ code: "signature.revision", message: `More than ${MAX_SIGNATURES} earlier revisions would have to be read; the rest were not, and what changed after their signatures is not judged.` });
  }
  return { signatures, attachments: attachmentsOf(pdf, warnings), warnings, documentId: documentIdOf(pdf) };
}
