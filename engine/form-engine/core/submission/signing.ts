/**
 * Signature participation contract. The engine canonicalizes and serializes the
 * submission, then delegates signing to an injected {@link SigningProvider}. The concrete
 * algorithm, key management, and trust chain are entirely the provider's concern.
 *
 * The contract also carries the shape a WebAuthn signature needs ({@link SignatureResult.webauthn}), the
 * choice of provider per submission (`signWith`), and the *format* — what is hashed and where
 * the signatures land ({@link SubmissionSigningFormat}).
 */
import type { CanonicalSubmission } from "./canonical-submission.js";
import type { WebAuthnAssertion } from "./webauthn-assertion.js";

export interface SignatureParticipant {
  id: string;
  role: string;
}

/** What the signed bytes cover. */
export type SubmissionSigningScope = "envelope" | "submission" | "values";

/** Where the signatures live in the delivered document. */
export type SubmissionSigningPlacement = "embedded" | "wrapper";

/**
 * How the signed part is written as text: `"jcs"`, RFC 8785 (see
 * `canonicalizeJcs`), so any server can rebuild the exact text from the parsed document.
 */
export type SubmissionCanonicalization = "jcs";

/**
 * How a submission is signed: `scope` is what the canonical string — and so the
 * hash a signer sees — covers: the whole canonical envelope without `signatures` (the
 * default), only its `submission` block (`{ locale, values }`), or the `values` object alone.
 * `placement` is where the signatures land: `"embedded"` inside the canonical envelope as
 * `signatures[]` (the wrapper is inside the submission), or `"wrapper"` — the envelope kept
 * untouched as the `payload` of a {@link SignedSubmissionDocument} (the submission is inside
 * the wrapper). `digest` names the hash over the scoped canonical JSON; `canonicalization`
 * how that JSON is written.
 */
export interface SubmissionSigningFormat {
  scope: SubmissionSigningScope;
  placement: SubmissionSigningPlacement;
  digest: "sha-256";
  canonicalization: SubmissionCanonicalization;
}

/**
 * What a host configures (`FormRuntimeDependencies.signing`, `SubmitOptions.signing`,
 * `<datum-form>`'s `signing`): the format's parts, and the signing statement — the words the
 * signer agrees to, signed with the document and recorded on each signature. An empty
 * statement is no statement.
 */
export type SubmissionSigningOptions = Partial<SubmissionSigningFormat> & { statement?: string };

export const SUBMISSION_SIGNING_SCOPES: readonly SubmissionSigningScope[] = ["envelope", "submission", "values"];
export const SUBMISSION_SIGNING_PLACEMENTS: readonly SubmissionSigningPlacement[] = ["embedded", "wrapper"];

export const DEFAULT_SUBMISSION_SIGNING_FORMAT: SubmissionSigningFormat = { scope: "envelope", placement: "embedded", digest: "sha-256", canonicalization: "jcs" };

/**
 * A format to sign under, from partial or untrusted input: an unknown or missing scope or
 * placement falls back to the default; the digest is SHA-256 and the canonicalization `"jcs"`
 * whatever the input says. Not for reading a delivered signature's format: that is
 * {@link readSigningFormat}, which refuses what it cannot read.
 */
export function normalizeSigningFormat(value: unknown): SubmissionSigningFormat {
  const input = (value && typeof value === "object" ? value : {}) as Partial<Record<keyof SubmissionSigningFormat, unknown>>;
  const scope = SUBMISSION_SIGNING_SCOPES.find((entry) => entry === input.scope) ?? DEFAULT_SUBMISSION_SIGNING_FORMAT.scope;
  const placement = SUBMISSION_SIGNING_PLACEMENTS.find((entry) => entry === input.placement) ?? DEFAULT_SUBMISSION_SIGNING_FORMAT.placement;
  return { scope, placement, digest: "sha-256", canonicalization: "jcs" };
}

/**
 * A delivered signature's format, read strictly: a known scope and placement, `digest:
 * "sha-256"` and `canonicalization: "jcs"`, or nothing. A signature whose format this reads as
 * nothing (none at all, another key order, an unknown scope) has no text a verifier can
 * rebuild, so it is invalid.
 */
export function readSigningFormat(value: unknown): SubmissionSigningFormat | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const input = value as Partial<Record<keyof SubmissionSigningFormat, unknown>>;
  const scope = SUBMISSION_SIGNING_SCOPES.find((entry) => entry === input.scope);
  const placement = SUBMISSION_SIGNING_PLACEMENTS.find((entry) => entry === input.placement);
  if (scope === undefined || placement === undefined || input.digest !== "sha-256" || input.canonicalization !== "jcs") {
    return undefined;
  }
  return { scope, placement, digest: "sha-256", canonicalization: "jcs" };
}

/** The statement a host configured, when it is one: a non-empty string. */
export function signingStatementOf(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export interface SigningRequest {
  /**
   * The exact text being signed: the `format.scope` part of the envelope in the format's
   * canonicalization — or, with a `statement`, the canonical `{ "document": <that part>,
   * "statement": <the statement> }` (see `signedCanonicalOf`).
   */
  canonical: string;
  participants: SignatureParticipant[];
  modeId: string;
  /** What `canonical` covers and where the result will land. */
  format: SubmissionSigningFormat;
  /** The provider id the submission asked for, when a button or a call named one. */
  signWith?: string;
  /** What triggered the submission, for a provider that words a prompt. */
  trigger?: { componentId?: string };
  /** The signing statement folded into `canonical`, for the provider to show and record. */
  statement?: string;
}

export interface SignatureResult {
  signature: string;
  algorithm: string;
  signedAt: number;
  participantId: string;
  /** The format this signature was made under, so a verifier never guesses. */
  format?: SubmissionSigningFormat;
  /** Everything a WebAuthn ceremony returned, when the provider was one. */
  webauthn?: WebAuthnAssertion;
  /** The signing statement this signature covers with the document, when there was one. */
  statement?: string;
}

/** The delivered document under the `"wrapper"` placement: the envelope untouched, the signatures beside it. */
export interface SignedSubmissionDocument {
  format: SubmissionSigningFormat;
  payload: CanonicalSubmission;
  signatures: SignatureResult[];
}

export interface SigningProvider {
  id: string;
  sign(request: SigningRequest): Promise<SignatureResult[]>;
}
