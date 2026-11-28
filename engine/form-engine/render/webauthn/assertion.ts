/**
 * The WebAuthn assertion ceremony and its verification. `requestAssertion` binds a
 * document to a passkey or security key by putting the document's hash in the challenge and
 * archiving everything the authenticator returns; `verifyAssertion` is the other half — the
 * checks a relying party makes (WebAuthn §7.2), with the signature verified through WebCrypto.
 * The engine takes no crypto dependency; the browser globals are reached only inside these
 * functions, so the render barrel still imports under Node.
 */
import { sha256 } from "../../core/crypto/sha256.js";
import { base64ToBytes } from "../../core/schema/file-upload.js";
import {
  COSE_ALGORITHM,
  base64UrlToBytes,
  bytesToBase64Url,
  parseClientData,
  type WebAuthnAssertion,
  type WebAuthnClientData
} from "../../core/submission/webauthn-assertion.js";
import { parseAuthenticatorData, type AuthenticatorFlags } from "./authenticator-data.js";
import { WebAuthnError, toWebAuthnError } from "./errors.js";
import { MIN_RSA_MODULUS_BITS, coseAlgorithmOfSpki, coseAlgorithmOfSpkiBase64, meetsKeyPolicy, readSpki } from "./spki.js";

/** A credential a ceremony may use, as the page stores it: id (base64url) and the transports it was registered over. */
export interface WebAuthnCredentialReference {
  id: string;
  transports?: string[];
  /** COSE algorithm, when known; lets the archived assertion say what signed it. Absent: the `publicKey`'s key type says (RSA RS256, EC ES256). */
  algorithm?: number;
  /** SPKI DER base64, when known; archived with the assertion so it verifies on its own. */
  publicKey?: string;
}

export interface RequestAssertionOptions {
  /** What the assertion signs over — the hash of the document is the usual challenge. */
  challenge: Uint8Array;
  rpId: string;
  /** The credentials allowed to sign; empty lets the platform offer any discoverable passkey for this rpId. */
  allowCredentials?: readonly WebAuthnCredentialReference[];
  userVerification?: UserVerificationRequirement;
  timeout?: number;
  /** `navigator.credentials` unless a test gives another container. */
  credentials?: CredentialsContainer;
  signal?: AbortSignal;
  /** The clock the `signedAt` stamp reads. */
  now?: () => Date;
}

/** The container a ceremony runs in: the one given, else the page's — which needs `PublicKeyCredential` to mean WebAuthn. */
export function credentialsContainerFrom(options: { credentials?: CredentialsContainer }): CredentialsContainer {
  if (options.credentials) {
    return options.credentials;
  }
  const container = (globalThis as { navigator?: { credentials?: CredentialsContainer } }).navigator?.credentials;
  if (!container || typeof (globalThis as { PublicKeyCredential?: unknown }).PublicKeyCredential === "undefined") {
    throw new WebAuthnError("unsupported", "This browser has no WebAuthn (navigator.credentials / PublicKeyCredential).");
  }
  return container;
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** Runs `navigator.credentials.get()` and archives the whole answer as a {@link WebAuthnAssertion}. */
export async function requestAssertion(options: RequestAssertionOptions): Promise<WebAuthnAssertion> {
  const container = credentialsContainerFrom(options);
  const allow = options.allowCredentials ?? [];
  const request: PublicKeyCredentialRequestOptions = {
    challenge: bufferOf(options.challenge),
    rpId: options.rpId,
    allowCredentials: allow.map((entry) => ({
      type: "public-key" as const,
      id: bufferOf(base64UrlToBytes(entry.id)),
      ...(entry.transports ? { transports: entry.transports as AuthenticatorTransport[] } : {})
    })),
    userVerification: options.userVerification ?? "preferred",
    timeout: options.timeout ?? 120000
  };
  let credential: Credential | null;
  try {
    credential = await container.get({ publicKey: request, ...(options.signal ? { signal: options.signal } : {}) });
  } catch (error) {
    throw toWebAuthnError(error, "assertion");
  }
  if (!credential || !("response" in credential)) {
    throw new WebAuthnError("cancelled", "No credential was returned.");
  }
  const response = (credential as PublicKeyCredential).response as AuthenticatorAssertionResponse;
  const credentialId = bytesToBase64Url(new Uint8Array((credential as PublicKeyCredential).rawId));
  const known = allow.find((entry) => entry.id === credentialId);
  const clientDataJSON = bytesToBase64Url(new Uint8Array(response.clientDataJSON));
  let clientData: WebAuthnClientData;
  try {
    clientData = parseClientData(clientDataJSON);
  } catch (error) {
    throw new WebAuthnError("protocol", "The assertion's clientDataJSON could not be read.", error);
  }
  return {
    credentialId,
    authenticatorData: bytesToBase64Url(new Uint8Array(response.authenticatorData)),
    clientDataJSON,
    signature: bytesToBase64Url(new Uint8Array(response.signature)),
    userHandle: response.userHandle ? bytesToBase64Url(new Uint8Array(response.userHandle)) : null,
    ...(known?.publicKey ? { publicKey: known.publicKey } : {}),
    algorithm: known?.algorithm ?? coseAlgorithmOfSpkiBase64(known?.publicKey) ?? COSE_ALGORITHM.ES256,
    rpId: options.rpId,
    origin: clientData.origin,
    signedAt: (options.now ?? (() => new Date()))().toISOString()
  };
}

export interface VerifyAssertionOptions {
  /** The bytes the challenge must equal, base64url-compared as WebAuthn writes them. */
  expectedChallenge: Uint8Array;
  /** The origins the client may have written; the page's own for a page verifying itself. */
  expectedOrigins: readonly string[];
  rpId: string;
  /**
   * SPKI DER base64; the assertion's archived key when absent. `null` says no key is registered
   * for this credential: the `publicKey` and `signature` checks fail, and the archived key does not
   * stand in.
   */
  publicKey?: string | null;
  /** COSE algorithm of that key; absent, the key's type says (RSA RS256, EC ES256), else the assertion's. */
  algorithm?: number;
  requireUserVerification?: boolean;
  subtle?: SubtleCrypto;
}

export interface AssertionVerdict {
  valid: boolean;
  checks: {
    type: boolean;
    challenge: boolean;
    origin: boolean;
    /** The ceremony did not run in a cross-origin frame: no `crossOrigin: true`, no `topOrigin`. */
    crossOrigin: boolean;
    rpId: boolean;
    userPresent: boolean;
    userVerified: boolean;
    /** The flags are consistent: a credential reported backed up (BS) is backup eligible (BE). */
    backupState: boolean;
    /** A key is at hand and meets the policy: ES256 on P-256, or RS256 of at least 2048 bits. */
    publicKey: boolean;
    signature: boolean;
  };
  flags: AuthenticatorFlags;
  signCount: number;
  /** The first check that failed, worded. */
  reason?: string;
}

/** DER `SEQUENCE { INTEGER r, INTEGER s }` → `r‖s` as WebCrypto verifies ECDSA. */
export function ecdsaDerToP1363(der: Uint8Array, size = 32): Uint8Array {
  if (der[0] !== 0x30) {
    throw new Error("not a DER ECDSA signature");
  }
  let offset = der[1]! & 0x80 ? 2 + (der[1]! & 0x7f) : 2;
  const out = new Uint8Array(size * 2);
  for (let part = 0; part < 2; part += 1) {
    if (der[offset] !== 0x02) {
      throw new Error("not a DER ECDSA signature");
    }
    const length = der[offset + 1]!;
    let start = offset + 2;
    let take = length;
    while (take > size && der[start] === 0) {
      start += 1;
      take -= 1;
    }
    if (take > size) {
      throw new Error("ECDSA integer is longer than the curve size");
    }
    out.set(der.subarray(start, start + take), part * size + (size - take));
    offset += 2 + length;
  }
  return out;
}

/** The verification key, when the key and the algorithm meet the policy: ES256 on P-256, RS256 of at least 2048 bits. */
async function importVerificationKey(spki: Uint8Array, algorithm: number, subtle: SubtleCrypto): Promise<CryptoKey | undefined> {
  if (!meetsKeyPolicy(readSpki(spki), algorithm)) {
    return undefined;
  }
  try {
    if (algorithm === COSE_ALGORITHM.ES256) {
      const key = await subtle.importKey("spki", spki as BufferSource, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
      return (key.algorithm as EcKeyAlgorithm).namedCurve === "P-256" ? key : undefined;
    }
    const key = await subtle.importKey("spki", spki as BufferSource, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return (key.algorithm as RsaHashedKeyAlgorithm).modulusLength >= MIN_RSA_MODULUS_BITS ? key : undefined;
  } catch {
    return undefined;
  }
}

async function verifySignature(algorithm: number, key: CryptoKey, data: Uint8Array, signature: Uint8Array, subtle: SubtleCrypto): Promise<boolean> {
  if (algorithm === COSE_ALGORITHM.ES256) {
    return subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, ecdsaDerToP1363(signature) as BufferSource, data as BufferSource);
  }
  return subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, signature as BufferSource, data as BufferSource);
}

/**
 * The relying party's checks over an archived assertion: type, challenge, origin, no
 * cross-origin frame, rpIdHash, user presence (and verification when required), consistent
 * backup flags, a key that meets the policy (ES256 on P-256, RS256 of at least 2048 bits), then
 * the signature over `authenticatorData || SHA-256(clientDataJSON)`. The algorithm is the
 * option's, else the key's type (RSA RS256, EC ES256), else the assertion's. Never throws for a
 * failed check — the verdict says which one; throws a {@link WebAuthnError} only when the bundle
 * cannot be read (`protocol`), no key is at hand (`no_credentials`) or there is no WebCrypto
 * (`unsupported`).
 */
export async function verifyAssertion(assertion: WebAuthnAssertion, options: VerifyAssertionOptions): Promise<AssertionVerdict> {
  const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new WebAuthnError("unsupported", "WebCrypto is not available here; give the verifier a SubtleCrypto.");
  }
  const unregistered = options.publicKey === null;
  const publicKey = unregistered ? undefined : (options.publicKey ?? assertion.publicKey);
  if (!unregistered && !publicKey) {
    throw new WebAuthnError("no_credentials", "No public key is known for this credential.");
  }
  let clientData: WebAuthnClientData;
  let authenticatorData: Uint8Array;
  let parsed: ReturnType<typeof parseAuthenticatorData>;
  try {
    clientData = parseClientData(assertion.clientDataJSON);
    authenticatorData = base64UrlToBytes(assertion.authenticatorData);
    parsed = parseAuthenticatorData(authenticatorData);
  } catch (error) {
    throw new WebAuthnError("protocol", "The assertion could not be read.", error);
  }
  const rpIdHash = sha256(new TextEncoder().encode(options.rpId));
  const checks: AssertionVerdict["checks"] = {
    type: clientData.type === "webauthn.get",
    challenge: clientData.challenge === bytesToBase64Url(options.expectedChallenge),
    origin: options.expectedOrigins.includes(clientData.origin),
    crossOrigin: clientData.crossOrigin !== true && clientData.topOrigin === undefined,
    rpId: parsed.rpIdHash.length === rpIdHash.length && parsed.rpIdHash.every((byte, index) => byte === rpIdHash[index]),
    userPresent: parsed.flags.userPresent,
    userVerified: options.requireUserVerification ? parsed.flags.userVerified : true,
    backupState: parsed.flags.backupEligible || !parsed.flags.backedUp,
    publicKey: false,
    signature: false
  };
  const clientDataHash = sha256(base64UrlToBytes(assertion.clientDataJSON));
  const signed = new Uint8Array(authenticatorData.length + clientDataHash.length);
  signed.set(authenticatorData, 0);
  signed.set(clientDataHash, authenticatorData.length);
  if (publicKey) {
    let spki: Uint8Array | undefined;
    try {
      spki = base64ToBytes(publicKey);
    } catch {
      spki = undefined;
    }
    const algorithm = options.algorithm ?? (spki ? coseAlgorithmOfSpki(spki) : undefined) ?? assertion.algorithm;
    const key = spki ? await importVerificationKey(spki, algorithm, subtle) : undefined;
    checks.publicKey = key !== undefined;
    if (key) {
      try {
        checks.signature = await verifySignature(algorithm, key, signed, base64UrlToBytes(assertion.signature), subtle);
      } catch {
        checks.signature = false;
      }
    }
  }
  const failed = (Object.keys(checks) as Array<keyof AssertionVerdict["checks"]>).find((key) => !checks[key]);
  return {
    valid: failed === undefined,
    checks,
    flags: parsed.flags,
    signCount: parsed.signCount,
    ...(failed ? { reason: failed === "publicKey" && unregistered ? UNREGISTERED_CREDENTIAL : REASONS[failed] } : {})
  };
}

/** The reason on a signature whose credential the verifier has no key registered for. */
const UNREGISTERED_CREDENTIAL = "the credential is not registered with this verifier";

const REASONS: Record<keyof AssertionVerdict["checks"], string> = {
  type: "the client data is not a webauthn.get assertion",
  challenge: "the challenge is not the hash of this document",
  origin: "the origin is not one the verifier accepts",
  crossOrigin: "the assertion was made in a cross-origin frame (crossOrigin or topOrigin), which the verifier refuses",
  rpId: "the relying party id hash does not match",
  userPresent: "the authenticator reports no user presence",
  userVerified: "user verification was required and not performed",
  backupState: "the authenticator reports a backed-up credential that is not backup eligible",
  publicKey: "the public key is not one the verifier accepts (ES256 on P-256, or RS256 of at least 2048 bits)",
  signature: "the signature does not verify with the registered public key"
};
