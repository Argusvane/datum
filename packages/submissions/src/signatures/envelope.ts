import {
  DEFAULT_SUBMISSION_SIGNING_FORMAT,
  UNREADABLE_FORMAT,
  canonicalizeJcs,
  sha256,
  signatureFormatOf,
  signedCanonicalForSignature,
  signingStatementOf,
  verifyWebAuthnSubmission,
  type AssertionVerdict,
  type AuthenticatorFlags,
  type SignatureResult,
  type SubmissionSigningFormat,
  type WebAuthnSubmissionVerdict
} from "@argusvane/datum-engine";

import { bytesToHex } from "../digest.js";
import type { DeliveredDocument, SignatureStatus, SignatureStatusSummary } from "../types.js";

/**
 * Whether the signatures on a delivered envelope hold, attribute by attribute: a
 * WebAuthn signature is checked the way a relying party checks it — the scoped canonical
 * recomputed from the document, hashed, compared with the archived challenge, then origin,
 * relying party, presence, verification and the signature itself — and every check is
 * reported, not folded into one boolean. A signature no verifier here can check (the demo
 * stand-in, an unknown algorithm) is `unverifiable`, which is not `invalid`: nothing was found
 * wrong, nothing could be found right. Each signature is rebuilt under its own format — its
 * scope, in RFC 8785 — and its own signing statement. A signature whose format is
 * unreadable (none, another canonicalization than `"jcs"`, an unknown scope) is `invalid`,
 * whatever its provider: no verifier can rebuild what it covers.
 */
export interface EnvelopeVerifierDeps {
  /** The registered public key for a credential id — a relying party's store. Nothing means the credential is not known here. */
  credentials: (credentialId: string) => { publicKey: string; algorithm?: number; name?: string } | undefined;
  /** The origins the signing page may have had. */
  expectedOrigins: readonly string[];
  rpId: string;
  requireUserVerification: boolean;
  subtle?: SubtleCrypto;
}

export type EnvelopeSignatureProvider = "webauthn" | "demo" | "unknown";

export interface EnvelopeSignatureVerdict {
  participantId: string;
  algorithm: string;
  /** ISO 8601, from the signature's `signedAt`. */
  signedAt: string;
  provider: EnvelopeSignatureProvider;
  status: Exclude<SignatureStatus, "none">;
  /** Why the status is what it is, when not every check passed. */
  reason?: string;
  /** The format the signature was checked under; absent when it is unreadable (the status is then `invalid`). */
  format?: SubmissionSigningFormat;
  /** The signing statement the signature covers with the document, when it has one. */
  statement?: string;
  /** The WebAuthn checks, each on its own. */
  checks?: AssertionVerdict["checks"];
  flags?: AuthenticatorFlags;
  signCount?: number;
  credential?: { id: string; name?: string; registered: boolean };
}

export interface EnvelopeSignatureReport {
  placement: "embedded" | "wrapper" | "none";
  format: SubmissionSigningFormat;
  /**
   * SHA-256 hex of the bytes the (first) signature covers: its format's scope in RFC 8785, with
   * its statement; for an unsigned envelope, or a first signature whose format is unreadable,
   * the whole envelope in RFC 8785.
   */
  scopedDigest: string;
  signatures: EnvelopeSignatureVerdict[];
  summary: SignatureStatusSummary;
}

function signaturesOf(document: DeliveredDocument): SignatureResult[] {
  return "payload" in document ? document.signatures : (document.signatures ?? []);
}

function providerOf(signature: SignatureResult): EnvelopeSignatureProvider {
  if (signature.webauthn) {
    return "webauthn";
  }
  return signature.algorithm === "demo-none" ? "demo" : "unknown";
}

/** One status for a set: any `invalid` wins, else any `unverifiable`, else `valid`; no signatures is `none`. */
export function summarize(statuses: readonly SignatureStatus[]): SignatureStatusSummary {
  const count = statuses.length;
  if (count === 0) {
    return { count, status: "none" };
  }
  if (statuses.includes("invalid")) {
    return { count, status: "invalid" };
  }
  if (statuses.includes("unverifiable")) {
    return { count, status: "unverifiable" };
  }
  return { count, status: "valid" };
}

function narrowestScope(scopes: readonly SubmissionSigningFormat["scope"][]): "envelope" | "submission" | "values" {
  return scopes.includes("values") ? "values" : scopes.includes("submission") ? "submission" : "envelope";
}

export async function inspectEnvelopeSignatures(document: DeliveredDocument, deps: EnvelopeVerifierDeps): Promise<EnvelopeSignatureReport> {
  const signatures = signaturesOf(document);
  const first = signatures[0];
  const placement = "payload" in document ? "wrapper" : signatures.length > 0 ? "embedded" : "none";
  const read = "payload" in document ? signatureFormatOf(document, undefined) : first ? signatureFormatOf(document, first) : undefined;
  const format: SubmissionSigningFormat = read ?? { ...DEFAULT_SUBMISSION_SIGNING_FORMAT, ...(placement === "wrapper" ? { placement } : {}) };
  const covered = signedCanonicalForSignature(document, first ?? {});
  const { signatures: _signatures, ...unsigned } = "payload" in document ? document.payload : document;
  const scopedDigest = bytesToHex(sha256(new TextEncoder().encode(covered ?? canonicalizeJcs(unsigned))));

  let verdicts: WebAuthnSubmissionVerdict[] = [];
  let verifierError: string | undefined;
  if (signatures.some((signature) => signature.webauthn)) {
    try {
      verdicts = await verifyWebAuthnSubmission(document, {
        expectedOrigins: deps.expectedOrigins,
        rpId: deps.rpId,
        publicKeyFor: (id) => {
          const known = deps.credentials(id);
          return known ? { publicKey: known.publicKey, ...(known.algorithm !== undefined ? { algorithm: known.algorithm } : {}) } : undefined;
        },
        requireUserVerification: deps.requireUserVerification,
        ...(deps.subtle ? { subtle: deps.subtle } : {})
      });
    } catch (error) {
      verifierError = error instanceof Error ? error.message : String(error);
    }
  }

  const results = signatures.map((signature): EnvelopeSignatureVerdict => {
    const provider = providerOf(signature);
    const statement = signingStatementOf(signature.statement);
    const signed = signatureFormatOf(document, signature);
    const base = {
      participantId: signature.participantId,
      algorithm: signature.algorithm,
      signedAt: new Date(signature.signedAt).toISOString(),
      provider,
      ...(signed !== undefined ? { format: signed } : {}),
      ...(statement !== undefined ? { statement } : {})
    };
    if (signed === undefined) {
      return { ...base, status: "invalid", reason: UNREADABLE_FORMAT };
    }
    if (provider === "demo") {
      return { ...base, status: "unverifiable", reason: "demo provider, no cryptographic signature" };
    }
    if (provider === "unknown" || !signature.webauthn) {
      return { ...base, status: "unverifiable", reason: `algorithm "${signature.algorithm}" has no verifier here` };
    }
    const credentialId = signature.webauthn.credentialId;
    const known = deps.credentials(credentialId);
    const credential = { id: credentialId, ...(known?.name ? { name: known.name } : {}), registered: known !== undefined };
    if (verifierError !== undefined) {
      return { ...base, status: "unverifiable", reason: `could not verify: ${verifierError}`, credential };
    }
    const verdict = verdicts.find((entry) => entry.credentialId === credentialId && entry.participantId === signature.participantId);
    if (!verdict) {
      return { ...base, status: "unverifiable", reason: "the verifier returned no verdict for this signature", credential };
    }
    const detail = { checks: verdict.checks, flags: verdict.flags, signCount: verdict.signCount, credential };
    if (!verdict.valid) {
      return { ...base, status: "invalid", reason: verdict.reason ?? "a check failed", ...detail };
    }
    if (!known) {
      // Every check passed against the key the assertion carries — which the signer chose. A
      // relying party trusts only a key it registered, so this says "consistent", not "valid".
      return { ...base, status: "unverifiable", reason: "the credential is not registered here; the checks used the key the assertion carries", ...detail };
    }
    return { ...base, status: "valid", ...detail };
  });

  return { placement, format, scopedDigest, signatures: results, summary: { ...summarize(results.map((entry) => entry.status)), ...(results.length > 0 ? { scope: narrowestScope(results.flatMap((entry) => (entry.format ? [entry.format.scope] : []))) } : {}) } };
}
