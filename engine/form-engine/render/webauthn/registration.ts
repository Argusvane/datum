/**
 * Registering a passkey or security key: `navigator.credentials.create()` with
 * `none` attestation, and the record a relying party keeps — the public key as SPKI from
 * `getPublicKey()`, so no CBOR is needed, its COSE algorithm, the transports, and what the
 * authenticator said about itself.
 *
 * A server can check a registration. It hands out the challenge
 * (`RegisterCredentialOptions.challenge`) and the user handle, gets the ceremony's raw outputs
 * back on {@link WebAuthnRegistrationResult.response}, and runs the checks of
 * {@link verifyRegistration} (WebAuthn §7.1, without an attestation judgement: attestation
 * stays `none`).
 */
import { bytesToBase64 } from "../../core/schema/file-upload.js";
import { bytesToBase64Url, base64UrlToBytes, COSE_ALGORITHM } from "../../core/submission/webauthn-assertion.js";
import { credentialsContainerFrom } from "./assertion.js";
import { parseAuthenticatorData, type AuthenticatorFlags } from "./authenticator-data.js";
import { WebAuthnError, toWebAuthnError } from "./errors.js";
import { coseAlgorithmOfSpki } from "./spki.js";

/** What a relying party keeps about a registered credential. */
export interface WebAuthnCredentialRecord {
  /** The credential id, base64url. */
  id: string;
  /** What the person calls the token. */
  name: string;
  /** SPKI DER base64. */
  publicKey: string;
  /** COSE algorithm: -7 ES256, -257 RS256. */
  algorithm: number;
  transports: string[];
  /** The authenticator's attachment as the platform reported it, when it did. */
  attachment?: string;
  /** The last signature counter seen; 0 for authenticators that keep none. */
  signCount: number;
  /** The flags at registration: whether the token verified the user, and its backup state. */
  flags: Pick<AuthenticatorFlags, "userVerified" | "backupEligible" | "backedUp">;
  /** ISO timestamps. */
  createdAt: string;
  lastUsedAt?: string;
}

export interface RegisterCredentialOptions {
  rpId: string;
  rpName: string;
  /**
   * The WebAuthn user: `id` is the user handle — bytes, or their base64url (what a server
   * hands out, and what an assertion's `userHandle` reads back) — at most 64 bytes, never a
   * name or an email; `name` / `displayName` are what the passkey manager shows.
   */
  user: { id: Uint8Array | string; name: string; displayName: string };
  /** What the person calls the token; stored on the record. */
  name: string;
  /**
   * The challenge, as bytes or base64url — a server's, so it can check the registration
   * ({@link verifyRegistration}). Absent: 32 random bytes, for a page that is its own relying party.
   */
  challenge?: Uint8Array | string;
  userVerification?: UserVerificationRequirement;
  authenticatorAttachment?: AuthenticatorAttachment;
  /** Whether the passkey is discoverable (`"required"` for signing without a credential list); `"preferred"` by default. */
  residentKey?: ResidentKeyRequirement;
  /** Credentials already registered, so the same authenticator is not registered twice. */
  excludeCredentials?: readonly { id: string; transports?: string[] }[];
  timeout?: number;
  credentials?: CredentialsContainer;
  signal?: AbortSignal;
  now?: () => Date;
}

/**
 * What `registerCredential` returns: the record a relying party keeps, and the ceremony's raw
 * outputs a server checks before it keeps it, all base64url. Store the record
 * without `response` and `userHandle` when the page is its own relying party.
 */
export interface WebAuthnRegistrationResult extends WebAuthnCredentialRecord {
  /** The user handle the credential was created for, base64url — what an assertion's `userHandle` will say. */
  userHandle: string;
  response: {
    /** `AuthenticatorAttestationResponse.clientDataJSON`: type `webauthn.create`, the challenge, the origin. */
    clientDataJSON: string;
    /** `getAuthenticatorData()`: the rpId hash, the flags, the counter and the attested credential data. Empty when the browser has no `getAuthenticatorData`. */
    authenticatorData: string;
    /** The CBOR attestation object (`fmt: "none"`), kept for a host that archives it. */
    attestationObject: string;
    transports: string[];
  };
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bytesOf(value: Uint8Array | string): Uint8Array {
  return typeof value === "string" ? base64UrlToBytes(value) : value;
}

interface AttestationExtras {
  getPublicKey?: () => ArrayBuffer | null;
  getPublicKeyAlgorithm?: () => number;
  getTransports?: () => string[];
  getAuthenticatorData?: () => ArrayBuffer;
}

/** Runs `navigator.credentials.create()` and returns the record a relying party keeps, with the ceremony's raw outputs. */
export async function registerCredential(options: RegisterCredentialOptions): Promise<WebAuthnRegistrationResult> {
  const container = credentialsContainerFrom(options);
  let challenge: Uint8Array;
  let userId: Uint8Array;
  try {
    userId = bytesOf(options.user.id);
    if (options.challenge !== undefined) {
      challenge = bytesOf(options.challenge);
    } else {
      challenge = new Uint8Array(32);
      (globalThis as { crypto?: { getRandomValues?: (array: Uint8Array) => Uint8Array } }).crypto?.getRandomValues?.(challenge);
    }
  } catch (error) {
    throw new WebAuthnError("protocol", "The challenge or the user handle is not base64url.", error);
  }
  if (userId.length < 1 || userId.length > 64) {
    throw new WebAuthnError("protocol", `The user handle is ${userId.length} bytes; WebAuthn takes 1 to 64.`);
  }
  if (challenge.length < 16) {
    throw new WebAuthnError("protocol", `The challenge is ${challenge.length} bytes; at least 16 are needed.`);
  }
  const request: PublicKeyCredentialCreationOptions = {
    challenge: bufferOf(challenge),
    rp: { id: options.rpId, name: options.rpName },
    user: { id: bufferOf(userId), name: options.user.name, displayName: options.user.displayName },
    pubKeyCredParams: [
      { type: "public-key", alg: COSE_ALGORITHM.ES256 },
      { type: "public-key", alg: COSE_ALGORITHM.RS256 }
    ],
    excludeCredentials: (options.excludeCredentials ?? []).map((entry) => ({
      type: "public-key" as const,
      id: bufferOf(base64UrlToBytes(entry.id)),
      ...(entry.transports ? { transports: entry.transports as AuthenticatorTransport[] } : {})
    })),
    authenticatorSelection: {
      userVerification: options.userVerification ?? "preferred",
      residentKey: options.residentKey ?? "preferred",
      ...(options.authenticatorAttachment ? { authenticatorAttachment: options.authenticatorAttachment } : {})
    },
    attestation: "none",
    timeout: options.timeout ?? 120000
  };
  let credential: Credential | null;
  try {
    credential = await container.create({ publicKey: request, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw toWebAuthnError(error, "registration");
  }
  if (!credential || !("response" in credential)) {
    throw new WebAuthnError("cancelled", "No credential was created.");
  }
  const created = credential as PublicKeyCredential;
  const response = created.response as AuthenticatorAttestationResponse & AttestationExtras;
  const spki = response.getPublicKey?.();
  if (!spki) {
    throw new WebAuthnError("unsupported", "This browser did not expose the credential's public key (getPublicKey); the attestation would need CBOR parsing.");
  }
  const authenticatorData = response.getAuthenticatorData?.();
  const parsed = authenticatorData ? parseAuthenticatorData(new Uint8Array(authenticatorData)) : undefined;
  const flags = parsed?.flags ?? { userVerified: false, backupEligible: false, backedUp: false };
  const attachment = (created as PublicKeyCredential & { authenticatorAttachment?: string | null }).authenticatorAttachment;
  const transports = response.getTransports?.() ?? [];
  return {
    id: bytesToBase64Url(new Uint8Array(created.rawId)),
    name: options.name,
    publicKey: bytesToBase64(new Uint8Array(spki)),
    algorithm: response.getPublicKeyAlgorithm?.() ?? coseAlgorithmOfSpki(new Uint8Array(spki)) ?? COSE_ALGORITHM.ES256,
    transports,
    ...(attachment ? { attachment } : {}),
    signCount: parsed?.signCount ?? 0,
    flags: { userVerified: flags.userVerified, backupEligible: flags.backupEligible, backedUp: flags.backedUp },
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    userHandle: bytesToBase64Url(userId),
    response: {
      clientDataJSON: bytesToBase64Url(new Uint8Array(response.clientDataJSON)),
      authenticatorData: authenticatorData ? bytesToBase64Url(new Uint8Array(authenticatorData)) : "",
      attestationObject: response.attestationObject ? bytesToBase64Url(new Uint8Array(response.attestationObject)) : "",
      transports: [...transports]
    }
  };
}

// The relying party's half lives in registration-verify.ts; re-exported so the names stay here.
export { verifyRegistration, type RegistrationVerdict, type VerifyRegistrationOptions } from "./registration-verify.js";
