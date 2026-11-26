/**
 * What a WebAuthn ceremony returns, archived whole. A WebAuthn assertion signs
 * `authenticatorData || SHA-256(clientDataJSON)` and nothing else, so a document is bound to
 * it by putting the document's hash in the challenge — Yubico's own guidance for signing with
 * WebAuthn — and keeping everything the authenticator handed back: a verifier recomputes the
 * hash, checks the archived challenge equals it, and verifies the assertion with the public
 * key registered for the credential. Bytes are base64url, as WebAuthn's JSON forms spell them.
 */
import { base64ToBytes, bytesToBase64 } from "../schema/file-upload.js";

export interface WebAuthnAssertion {
  /** The credential that signed, base64url. */
  credentialId: string;
  /** `AuthenticatorAssertionResponse.authenticatorData`, base64url. */
  authenticatorData: string;
  /** `AuthenticatorAssertionResponse.clientDataJSON`, base64url — carries the challenge, the origin and the type. */
  clientDataJSON: string;
  /** The assertion signature, base64url: DER ECDSA for ES256, PKCS#1 v1.5 for RS256. */
  signature: string;
  /** The user handle the authenticator returned, base64url, when it did. */
  userHandle?: string | null;
  /** The credential's public key as registered, SPKI DER base64, so the bundle verifies on its own. */
  publicKey?: string;
  /** The COSE algorithm of the credential: -7 (ES256) or -257 (RS256). */
  algorithm: number;
  /** The relying party id the ceremony ran under. */
  rpId: string;
  /** The origin the client wrote into `clientDataJSON`, copied out for readers. */
  origin: string;
  /** When the page received the assertion, ISO 8601. */
  signedAt: string;
}

/** COSE algorithm identifiers a WebAuthn credential signs with (RFC 9053). */
export const COSE_ALGORITHM = { ES256: -7, RS256: -257 } as const;

/** Base64url (RFC 4648 §5, no padding) from bytes — the form WebAuthn's JSON uses. */
export function bytesToBase64Url(bytes: Uint8Array): string {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Bytes from base64url or plain base64: the decoder accepts both alphabets and ignores padding. */
export function base64UrlToBytes(text: string): Uint8Array {
  return base64ToBytes(text);
}

/** The `clientDataJSON` fields a verifier reads (WebAuthn §5.8.1). */
export interface WebAuthnClientData {
  type: string;
  challenge: string;
  origin: string;
  crossOrigin?: boolean;
  topOrigin?: string;
}

/** Parses an assertion's `clientDataJSON`; throws when it is not the JSON WebAuthn writes. */
export function parseClientData(clientDataJSON: string): WebAuthnClientData {
  const text = new TextDecoder().decode(base64UrlToBytes(clientDataJSON));
  const parsed = JSON.parse(text) as Partial<WebAuthnClientData>;
  if (typeof parsed.type !== "string" || typeof parsed.challenge !== "string" || typeof parsed.origin !== "string") {
    throw new Error("clientDataJSON has no type, challenge and origin");
  }
  return parsed as WebAuthnClientData;
}
