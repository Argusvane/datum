/**
 * The submission signing provider over WebAuthn: the canonical
 * string the runtime hands over is hashed, the hash is the challenge, the person's passkey or
 * security key signs, and everything returned is archived on the `SignatureResult`. One
 * ceremony per submission — a passkey stands for the person, not for each declared
 * participant, so the result names the first participant (or "submitter").
 *
 * The other half, `verifyWebAuthnSubmission`, is what a server does with a delivered
 * document: recompute the scoped canonical string, hash it, and run the relying party's checks.
 *
 * `discoverable: true` signs with an empty `allowCredentials` when the page
 * knows no credential, so the browser offers any passkey the visitor has for the rpId; the
 * archived assertion names the credential chosen and its user handle, and the server looks
 * the key up by that id. WebAuthn does not say whether the visitor had no passkey or closed
 * the prompt (a privacy rule): both are `cancelled`, after which a host offers to create one.
 */
import { sha256 } from "../../core/crypto/sha256.js";
import { signatureFormatOf, signedCanonicalForSignature, type CanonicalSubmission } from "../../core/submission/canonical-submission.js";
import {
  signingStatementOf,
  type SignatureResult,
  type SignedSubmissionDocument,
  type SigningProvider,
  type SigningRequest,
  type SubmissionSigningFormat
} from "../../core/submission/signing.js";
import { COSE_ALGORITHM, type WebAuthnAssertion } from "../../core/submission/webauthn-assertion.js";
import { requestAssertion, verifyAssertion, type AssertionVerdict, type WebAuthnCredentialReference } from "./assertion.js";
import { WebAuthnError } from "./errors.js";

export const WEBAUTHN_SIGNING_PROVIDER_ID = "webauthn";

/** `webauthn-es256` / `webauthn-rs256`: what a `SignatureResult.algorithm` says for a WebAuthn signature. */
export function webAuthnAlgorithmName(algorithm: number): string {
  return algorithm === COSE_ALGORITHM.RS256 ? "webauthn-rs256" : algorithm === COSE_ALGORITHM.ES256 ? "webauthn-es256" : `webauthn-cose${algorithm}`;
}

export interface WebAuthnSigningProviderOptions {
  /** The provider id a button's `signature` option or `submit({ signWith })` names; `"webauthn"` unless told otherwise. */
  id?: string;
  rpId: string;
  /**
   * The credentials the person may sign with, read at each submission — a store's current
   * list. Required unless `discoverable`; an empty list without `discoverable` fails as
   * `no_credentials`.
   */
  credentials?: () => readonly WebAuthnCredentialReference[];
  /**
   * Sign with any discoverable passkey the visitor has for the rpId when `credentials` gives
   * none: `allowCredentials` is empty and the browser offers the choice. A listed
   * credential still narrows the prompt to the list. An assertion from a credential the list
   * does not name is archived with ES256 assumed and no public key: the verifier uses the key
   * it registered for that credential id, and that key's type says its algorithm.
   */
  discoverable?: boolean;
  userVerification?: UserVerificationRequirement;
  timeout?: number;
  /** The participant the signature is attributed to; the first declared one, else "submitter", when absent. */
  participantId?: string;
  credentialsContainer?: CredentialsContainer;
  now?: () => Date;
  /** Told what signed, so a store can record the use and the counter. */
  onSigned?: (assertion: WebAuthnAssertion, request: SigningRequest) => void;
}

export function createWebAuthnSigningProvider(options: WebAuthnSigningProviderOptions): SigningProvider {
  const now = options.now ?? (() => new Date());
  return {
    id: options.id ?? WEBAUTHN_SIGNING_PROVIDER_ID,
    async sign(request: SigningRequest): Promise<SignatureResult[]> {
      const credentials = options.credentials?.() ?? [];
      if (credentials.length === 0 && !options.discoverable) {
        throw new WebAuthnError("no_credentials", "No passkey or security key is registered to sign with.");
      }
      const challenge = sha256(new TextEncoder().encode(request.canonical));
      const assertion = await requestAssertion({
        challenge,
        rpId: options.rpId,
        allowCredentials: credentials,
        ...(options.userVerification ? { userVerification: options.userVerification } : {}),
        ...(options.timeout !== undefined ? { timeout: options.timeout } : {}),
        ...(options.credentialsContainer ? { credentials: options.credentialsContainer } : {}),
        now
      });
      options.onSigned?.(assertion, request);
      const statement = signingStatementOf(request.statement);
      return [
        {
          participantId: options.participantId ?? request.participants[0]?.id ?? "submitter",
          algorithm: webAuthnAlgorithmName(assertion.algorithm),
          signature: assertion.signature,
          signedAt: now().getTime(),
          format: request.format,
          ...(statement !== undefined ? { statement } : {}),
          webauthn: assertion
        }
      ];
    }
  };
}

export interface VerifyWebAuthnSubmissionOptions {
  /** The origins the client may have written into the assertion; the page's own for a page verifying itself. */
  expectedOrigins: readonly string[];
  rpId: string;
  /**
   * The registered public key (SPKI DER base64) for a credential id, and its COSE algorithm
   * (absent: the key's type says, RSA RS256 and EC ES256). A credential it returns nothing for
   * is not registered: its signature is invalid, whatever key the assertion carries. Left out,
   * each signature is checked with the key archived in it, which proves only that the signer
   * holds that key.
   */
  publicKeyFor?: (credentialId: string) => { publicKey: string; algorithm?: number } | undefined;
  requireUserVerification?: boolean;
  subtle?: SubtleCrypto;
}

/** One WebAuthn signature on a delivered document, verified. */
export interface WebAuthnSubmissionVerdict extends AssertionVerdict {
  participantId: string;
  credentialId: string;
  algorithm: string;
  /**
   * The key the signature was checked with: `"registered"`, what `publicKeyFor` returned, or
   * `"archived"`, the one the assertion carries (only when `publicKeyFor` is left out). Absent
   * when no key was at hand. A host that trusts only its own keys requires `"registered"`.
   */
  key?: "registered" | "archived";
  /** The format the signature was checked under: its own, else the wrapper's; absent when neither is readable (the verdict is then invalid). */
  format?: SubmissionSigningFormat;
  /** The signing statement the signature covers, when it has one. */
  statement?: string;
}

/** The reason on a signature with no key at hand: no lookup, and none archived in it. */
const NO_KEY = "no public key is known for this credential";

/** The verdict on a signature no check could run on: every check failed, no flags read. */
function unreadVerdict(reason: string): AssertionVerdict {
  return {
    valid: false,
    checks: { type: false, challenge: false, origin: false, crossOrigin: false, rpId: false, userPresent: false, userVerified: false, backupState: false, publicKey: false, signature: false },
    flags: { userPresent: false, userVerified: false, backupEligible: false, backedUp: false, attestedCredentialData: false, extensionData: false },
    signCount: 0,
    reason
  };
}

/** The reason on a signature whose format is unreadable ({@link signatureFormatOf}). */
export const UNREADABLE_FORMAT = 'the signature names no signing format this engine signs under (a known scope, canonicalization "jcs")';

/**
 * Verifies every WebAuthn signature on a delivered document — an envelope with embedded
 * `signatures`, or a wrapper document — the way a server would: the scoped canonical string is
 * recomputed from the document, hashed, and compared to the archived challenge; then origin,
 * rpId, presence, verification and the signature itself. Each signature is rebuilt under its
 * own format (its scope, in RFC 8785) and with its own statement. A signature whose format is
 * unreadable — none, another canonicalization than `"jcs"`, an unknown scope — is invalid: its
 * challenge check fails, since no text can be rebuilt to compare it with. A signature that
 * cannot be read (its client data or authenticator data), or that has no key at hand, is an
 * invalid verdict with the reason, and the others are still checked. Signatures from other
 * providers are left out of the list. Throws only when there is no WebCrypto.
 */
export async function verifyWebAuthnSubmission(
  document: CanonicalSubmission | SignedSubmissionDocument,
  options: VerifyWebAuthnSubmissionOptions
): Promise<WebAuthnSubmissionVerdict[]> {
  const signatures = "payload" in document ? document.signatures : (document.signatures ?? []);
  const verdicts: WebAuthnSubmissionVerdict[] = [];
  for (const signature of signatures) {
    if (!signature.webauthn) {
      continue;
    }
    const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
    if (!subtle) {
      throw new WebAuthnError("unsupported", "WebCrypto is not available here; give the verifier a SubtleCrypto.");
    }
    const format = signatureFormatOf(document, signature);
    const canonical = signedCanonicalForSignature(document, signature);
    const known = options.publicKeyFor?.(signature.webauthn.credentialId);
    const key = known ? "registered" : options.publicKeyFor === undefined && signature.webauthn.publicKey ? "archived" : undefined;
    let checked: AssertionVerdict;
    try {
      checked = await verifyAssertion(signature.webauthn, {
        expectedChallenge: canonical === undefined ? new Uint8Array(0) : sha256(new TextEncoder().encode(canonical)),
        expectedOrigins: options.expectedOrigins,
        rpId: options.rpId,
        // A lookup that knows no key for the credential leaves it unregistered; the archived key never stands in.
        ...(known ? { publicKey: known.publicKey } : options.publicKeyFor ? { publicKey: null } : {}),
        ...(known?.algorithm !== undefined ? { algorithm: known.algorithm } : {}),
        ...(options.requireUserVerification !== undefined ? { requireUserVerification: options.requireUserVerification } : {}),
        subtle
      });
    } catch (error) {
      if (!(error instanceof WebAuthnError) || (error.code !== "protocol" && error.code !== "no_credentials")) {
        throw error;
      }
      checked = unreadVerdict(error.code === "no_credentials" ? NO_KEY : `the signature could not be read: ${error.message}`);
    }
    const verdict: AssertionVerdict =
      canonical === undefined ? { ...checked, valid: false, checks: { ...checked.checks, challenge: false }, reason: UNREADABLE_FORMAT } : checked;
    const statement = signingStatementOf(signature.statement);
    verdicts.push({
      ...verdict,
      participantId: signature.participantId,
      credentialId: signature.webauthn.credentialId,
      algorithm: signature.algorithm,
      ...(key !== undefined ? { key } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(statement !== undefined ? { statement } : {})
    });
  }
  return verdicts;
}
