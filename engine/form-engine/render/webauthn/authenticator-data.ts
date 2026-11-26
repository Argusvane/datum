/**
 * The authenticator data an assertion carries (WebAuthn §6.1): the hash of the relying party
 * id, the flags — user present, user verified, backup eligibility and state — and the
 * signature counter. Parsed here for verification and for what a page shows about a token.
 */

export interface AuthenticatorFlags {
  userPresent: boolean;
  userVerified: boolean;
  backupEligible: boolean;
  backedUp: boolean;
  attestedCredentialData: boolean;
  extensionData: boolean;
}

export interface ParsedAuthenticatorData {
  /** SHA-256 of the relying party id, 32 bytes. */
  rpIdHash: Uint8Array;
  flags: AuthenticatorFlags;
  /** The authenticator's signature counter; 0 from authenticators that keep none. */
  signCount: number;
}

const MIN_LENGTH = 37;

export function parseAuthenticatorData(bytes: Uint8Array): ParsedAuthenticatorData {
  if (bytes.length < MIN_LENGTH) {
    throw new Error(`authenticatorData is ${bytes.length} bytes; at least ${MIN_LENGTH} are needed`);
  }
  const flagByte = bytes[32]!;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return {
    rpIdHash: bytes.slice(0, 32),
    flags: {
      userPresent: (flagByte & 0x01) !== 0,
      userVerified: (flagByte & 0x04) !== 0,
      backupEligible: (flagByte & 0x08) !== 0,
      backedUp: (flagByte & 0x10) !== 0,
      attestedCredentialData: (flagByte & 0x40) !== 0,
      extensionData: (flagByte & 0x80) !== 0
    },
    signCount: view.getUint32(33, false)
  };
}
