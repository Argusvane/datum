/**
 * A relying party's checks over a registration, apart from
 * `registration.ts` so a bundle that only verifies a delivered registration does not carry the
 * ceremony (`registerCredential`) with it. The renderer bundle keeps this half
 * eager, since `verifyRegistration` is synchronous and cannot sit behind a lazy chunk, and
 * loads the ceremony and the signing provider on first use.
 */
import { sha256 } from "../../core/crypto/sha256.js";
import { bytesToBase64Url, base64UrlToBytes, parseClientData, type WebAuthnClientData } from "../../core/submission/webauthn-assertion.js";
import { parseAuthenticatorData, type AuthenticatorFlags } from "./authenticator-data.js";
import { WebAuthnError } from "./errors.js";
import type { WebAuthnRegistrationResult } from "./registration.js";

function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? base64UrlToBytes(value) : value;
}

export interface VerifyRegistrationOptions {
  /** The challenge the server handed out: bytes, or base64url. */
  expectedChallenge: Uint8Array | string;
  /** The origins the registering page may have had. */
  expectedOrigins: readonly string[];
  rpId: string;
  requireUserVerification?: boolean;
}

export interface RegistrationVerdict {
  valid: boolean;
  checks: {
    /** `clientDataJSON.type` is `webauthn.create`. */
    type: boolean;
    challenge: boolean;
    origin: boolean;
    /** The authenticator data's rpIdHash is SHA-256 of `rpId`. */
    rpId: boolean;
    userPresent: boolean;
    /** True unless verification was required and not performed. */
    userVerified: boolean;
    /** The AT flag is set: the authenticator data carries the new credential. */
    attestedCredential: boolean;
    /** The credential id in the authenticator data is the record's `id`. */
    credentialId: boolean;
  };
  flags: AuthenticatorFlags;
  signCount: number;
  /** The first check that failed, worded. */
  reason?: string;
}

/** The credential id inside attested credential data (WebAuthn §6.5.1): after the 37-byte header, a 16-byte AAGUID, a 2-byte length, the id. */
function attestedCredentialId(authenticatorData: Uint8Array): Uint8Array | undefined {
  const start = 37 + 16;
  if (authenticatorData.length < start + 2) {
    return undefined;
  }
  const length = (authenticatorData[start]! << 8) | authenticatorData[start + 1]!;
  if (authenticatorData.length < start + 2 + length) {
    return undefined;
  }
  return authenticatorData.subarray(start + 2, start + 2 + length);
}

/**
 * A relying party's checks over a registration (WebAuthn §7.1, attestation `none`): type
 * `webauthn.create`, the challenge it handed out, an allowed origin, the rpId hash, user
 * presence (and verification when required), the AT flag, and the credential id in the
 * authenticator data equal to the record's id. Never throws for a failed check — the verdict
 * says which one; throws a `protocol` {@link WebAuthnError} only when the result cannot be
 * read (no authenticator data, bad base64url or JSON). The public key is the record's
 * (`getPublicKey()`), which nothing signs under `none` attestation: these checks bind the
 * registration to the server's challenge and to this relying party, not to a make of
 * authenticator.
 */
export function verifyRegistration(
  result: Pick<WebAuthnRegistrationResult, "id" | "response">,
  options: VerifyRegistrationOptions
): RegistrationVerdict {
  let clientData: WebAuthnClientData;
  let authenticatorData: Uint8Array;
  let expectedChallenge: string;
  try {
    clientData = parseClientData(result.response.clientDataJSON);
    authenticatorData = base64UrlToBytes(result.response.authenticatorData);
    expectedChallenge = bytesToBase64Url(bytesOf(options.expectedChallenge));
  } catch (error) {
    throw new WebAuthnError("protocol", "The registration could not be read.", error);
  }
  if (authenticatorData.length === 0) {
    throw new WebAuthnError("protocol", "The registration carries no authenticator data (the browser has no getAuthenticatorData).");
  }
  let parsed: ReturnType<typeof parseAuthenticatorData>;
  try {
    parsed = parseAuthenticatorData(authenticatorData);
  } catch (error) {
    throw new WebAuthnError("protocol", "The registration's authenticator data could not be read.", error);
  }
  const rpIdHash = sha256(new TextEncoder().encode(options.rpId));
  const credentialId = parsed.flags.attestedCredentialData ? attestedCredentialId(authenticatorData) : undefined;
  const checks: RegistrationVerdict["checks"] = {
    type: clientData.type === "webauthn.create",
    challenge: clientData.challenge === expectedChallenge,
    origin: options.expectedOrigins.includes(clientData.origin),
    rpId: parsed.rpIdHash.every((byte, index) => byte === rpIdHash[index]),
    userPresent: parsed.flags.userPresent,
    userVerified: options.requireUserVerification ? parsed.flags.userVerified : true,
    attestedCredential: parsed.flags.attestedCredentialData,
    credentialId: credentialId !== undefined && bytesToBase64Url(credentialId) === result.id
  };
  const failed = (Object.keys(checks) as Array<keyof RegistrationVerdict["checks"]>).find((key) => !checks[key]);
  return {
    valid: failed === undefined,
    checks,
    flags: parsed.flags,
    signCount: parsed.signCount,
    ...(failed ? { reason: REGISTRATION_REASONS[failed] } : {})
  };
}

const REGISTRATION_REASONS: Record<keyof RegistrationVerdict["checks"], string> = {
  type: "the client data is not a webauthn.create registration",
  challenge: "the challenge is not the one handed out",
  origin: "the origin is not one the verifier accepts",
  rpId: "the relying party id hash does not match",
  userPresent: "the authenticator reports no user presence",
  userVerified: "user verification was required and not performed",
  attestedCredential: "the authenticator data carries no attested credential (AT flag unset)",
  credentialId: "the credential id in the authenticator data is not the credential's id"
};
