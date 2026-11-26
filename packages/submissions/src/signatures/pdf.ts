import { verifyWithWebCrypto, type PdfAttachmentReport, type PdfSignatureReport, type PdfWarning } from "@argusvane/datum-engine";
import { parseCertificate } from "@argusvane/datum-pdf-kernel";

import { base64ToHex } from "../digest.js";
import { SUBMISSION_ATTACHMENT_NAME, base64ToBytes } from "../pdf/submission-attachment.js";
import type { SignatureStatus, SignatureStatusSummary } from "../types.js";
import { summarize } from "./envelope.js";

/**
 * Whether the signatures on a PDF hold, attribute by attribute: what the kernel's
 * `verify` read — the byte range, the digest, the certificate binding, the certification, the
 * timestamp, the commitment — plus the one check the kernel leaves to the host, the signature
 * value under the signer's public key, and what a verifier decides for itself: whether the
 * signing certificate was valid when it signed, and whether it is trusted here. Nothing is
 * folded into one boolean; `unverifiable` is kept apart from `invalid`.
 */
export interface PdfVerifierDeps {
  verify: (bytes: Uint8Array) => Promise<{ signatures: PdfSignatureReport[]; attachments: PdfAttachmentReport[]; warnings: PdfWarning[] }>;
  /** Certificates this verifier trusts outright, DER base64: the server's own first. */
  trusted?: readonly string[];
  /** The server's own certificate, DER base64, when the verifier is the server. */
  own?: string;
  subtle?: SubtleCrypto;
  /** For "valid at signing": the signing time, else now. */
  clock?: () => Date;
  /** The digest of the record the PDF is expected to carry, hex; sets `matchesRecordDigest` on `submission.json`. */
  expectedDigest?: string;
}

export type PdfTrust = "this-server" | "trusted" | "self-signed" | "unknown";

export interface PdfSignatureVerdict {
  field: string;
  /** PAdES (`ETSI.CAdES.detached`) or PKCS#7 (`adbe.pkcs7.detached`), worded. */
  profile: string;
  subFilter: string;
  status: Exclude<SignatureStatus, "none">;
  reason?: string;
  checks: {
    coversDocument: boolean;
    digestMatches: boolean;
    certificateMatches: boolean;
    /** The signature value under the signer's public key — WebCrypto's verdict, or undefined when it could not be run. */
    signatureValid: boolean | undefined;
    /** The signing time inside the certificate's validity. */
    validAtSigning: boolean | undefined;
    /** The timestamp token covers this signature value, when there is one. */
    timestampCoversSignature: boolean | undefined;
  };
  signer:
    | {
        subject: string;
        issuer: string;
        serialNumber: string;
        notBefore: string;
        notAfter: string;
        selfSigned: boolean;
        certificate: string;
      }
    | null;
  trust: PdfTrust;
  chainLength: number;
  signatureAlgorithm: string;
  signingTime: string | null;
  signingTimeAttribute?: string;
  certification: PdfSignatureReport["certification"];
  timestamp?: PdfSignatureReport["timestamp"];
  commitment?: PdfSignatureReport["commitment"];
  reasonText?: string;
  location?: string;
  name?: string;
  contactInfo?: string;
}

export interface PdfAttachmentVerdict extends PdfAttachmentReport {
  /** The digest in hex, as a record keeps one. */
  sha256Hex: string;
  /** For `submission.json`, when a record digest was expected: whether they agree. */
  matchesRecordDigest?: boolean;
}

export interface PdfSignatureReportSet {
  signatures: PdfSignatureVerdict[];
  attachments: PdfAttachmentVerdict[];
  warnings: PdfWarning[];
  summary: SignatureStatusSummary;
}

const ALGORITHM_WORDS: Record<string, string> = {
  "1.2.840.113549.1.1.11": "sha256WithRSAEncryption",
  "1.2.840.113549.1.1.1": "rsaEncryption",
  "1.2.840.10045.4.3.2": "ecdsa-with-SHA256",
  "1.2.840.10045.4.3.3": "ecdsa-with-SHA384"
};

export function algorithmWord(oid: string): string {
  return ALGORITHM_WORDS[oid] ?? oid;
}

function profileOf(subFilter: string): string {
  return subFilter === "ETSI.CAdES.detached" ? "PAdES (CAdES detached)" : subFilter === "adbe.pkcs7.detached" ? "PKCS#7 detached (Adobe)" : subFilter;
}

function trustOf(report: PdfSignatureReport, deps: PdfVerifierDeps): { trust: PdfTrust; selfSigned: boolean } {
  const leaf = report.signer?.certificate;
  let selfSigned = false;
  if (leaf) {
    try {
      selfSigned = parseCertificate(base64ToBytes(leaf)).selfSigned;
    } catch {
      selfSigned = report.signer?.issuer === report.signer?.subject;
    }
  }
  if (!leaf) {
    return { trust: "unknown", selfSigned };
  }
  if (deps.own !== undefined && leaf === deps.own) {
    return { trust: "this-server", selfSigned };
  }
  if (deps.trusted?.includes(leaf) || report.certificates.some((certificate) => deps.trusted?.includes(certificate))) {
    return { trust: "trusted", selfSigned };
  }
  return { trust: selfSigned ? "self-signed" : "unknown", selfSigned };
}

function within(instant: string | null | undefined, notBefore: string, notAfter: string): boolean | undefined {
  if (!instant) {
    return undefined;
  }
  const at = Date.parse(instant);
  if (Number.isNaN(at)) {
    return undefined;
  }
  return at >= Date.parse(notBefore) && at <= Date.parse(notAfter);
}

export async function inspectPdfSignatures(bytes: Uint8Array, deps: PdfVerifierDeps): Promise<PdfSignatureReportSet> {
  const report = await deps.verify(bytes);
  const signatures: PdfSignatureVerdict[] = [];
  for (const signature of report.signatures) {
    let signatureValid: boolean | undefined;
    try {
      signatureValid = await verifyWithWebCrypto(signature, deps.subtle);
    } catch {
      signatureValid = undefined;
    }
    const { trust, selfSigned } = trustOf(signature, deps);
    const signingInstant = signature.timestamp?.time ?? signature.signingTimeAttribute ?? signature.signingTime ?? (deps.clock ?? (() => new Date()))().toISOString();
    const validAtSigning = signature.signer ? within(signingInstant, signature.signer.notBefore, signature.signer.notAfter) : undefined;
    const checks = {
      coversDocument: signature.coversDocument,
      digestMatches: signature.digestMatches,
      certificateMatches: signature.certificateMatches,
      signatureValid,
      validAtSigning,
      timestampCoversSignature: signature.timestamp ? signature.timestamp.coversSignature : undefined
    };
    let status: PdfSignatureVerdict["status"] = "valid";
    let reason: string | undefined;
    if (!checks.digestMatches) {
      status = "invalid";
      reason = "the document's bytes are not what was signed";
    } else if (!checks.coversDocument) {
      status = "invalid";
      reason = "bytes were added after this signature";
    } else if (!checks.certificateMatches) {
      status = "invalid";
      reason = "the signing-certificate attribute names another certificate";
    } else if (checks.signatureValid === false) {
      status = "invalid";
      reason = "the signature value does not verify under the signer's key";
    } else if (checks.timestampCoversSignature === false) {
      status = "invalid";
      reason = "the timestamp token does not cover this signature";
    } else if (checks.validAtSigning === false) {
      status = "invalid";
      reason = "the certificate was not valid at the time of signing";
    } else if (checks.signatureValid === undefined) {
      status = "unverifiable";
      reason = "the signature value could not be checked here (no WebCrypto, or an algorithm it lacks)";
    } else if (!signature.signer) {
      status = "unverifiable";
      reason = "the signature carries no certificate";
    } else if (trust === "unknown" || trust === "self-signed") {
      status = "unverifiable";
      reason = trust === "self-signed" ? "every check holds, but the certificate is self-signed by a party not trusted here" : "every check holds, but the certificate's issuer is not trusted here";
    }
    signatures.push({
      field: signature.field,
      profile: profileOf(signature.subFilter),
      subFilter: signature.subFilter,
      status,
      ...(reason ? { reason } : {}),
      checks,
      signer: signature.signer ? { ...signature.signer, selfSigned } : null,
      trust,
      chainLength: signature.certificates.length,
      signatureAlgorithm: algorithmWord(signature.signatureAlgorithm),
      signingTime: signature.signingTime,
      ...(signature.signingTimeAttribute ? { signingTimeAttribute: signature.signingTimeAttribute } : {}),
      certification: signature.certification,
      ...(signature.timestamp ? { timestamp: signature.timestamp } : {}),
      ...(signature.commitment ? { commitment: signature.commitment } : {}),
      ...(signature.reason ? { reasonText: signature.reason } : {}),
      ...(signature.location ? { location: signature.location } : {}),
      ...(signature.name ? { name: signature.name } : {}),
      ...(signature.contactInfo ? { contactInfo: signature.contactInfo } : {})
    });
  }
  const attachments = report.attachments.map((attachment): PdfAttachmentVerdict => {
    const sha256Hex = base64ToHex(attachment.sha256);
    return {
      ...attachment,
      sha256Hex,
      ...(attachment.name === SUBMISSION_ATTACHMENT_NAME && deps.expectedDigest !== undefined
        ? { matchesRecordDigest: sha256Hex === deps.expectedDigest }
        : {})
    };
  });
  return { signatures, attachments, warnings: report.warnings, summary: summarize(signatures.map((entry) => entry.status)) };
}
