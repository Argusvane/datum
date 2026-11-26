/**
 * A software authenticator for tests: a P-256 or RSA key on Node's WebCrypto that
 * answers `create()` and `get()` the way a platform does — clientDataJSON, authenticatorData
 * with the rpId hash, flags and a counter, a DER (ES256) or PKCS#1 (RS256) signature — plus
 * the globals a page has (`navigator.credentials`, `PublicKeyCredential`). Shared by the
 * engine and web-components suites.
 */
import { sha256, bytesToBase64, COSE_ALGORITHM, bytesToBase64Url, base64UrlToBytes } from "@argusvane/datum-engine/core";
import type { WebAuthnCredentialRecord } from "@argusvane/datum-engine/render";

export interface SoftwareAuthenticatorOptions {
  rpId?: string;
  origin?: string;
  algorithm?: "ES256" | "RS256";
  userPresent?: boolean;
  userVerified?: boolean;
  backupEligible?: boolean;
  backedUp?: boolean;
  signCount?: number;
  transports?: string[];
  subtle?: SubtleCrypto;
}

export interface AssertOverrides {
  origin?: string;
  type?: string;
  userPresent?: boolean;
  userVerified?: boolean;
  /** Sign with another key: a signature that does not verify. */
  wrongKey?: boolean;
}

function subtleOf(options: { subtle?: SubtleCrypto }): SubtleCrypto {
  const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error("no WebCrypto here");
  }
  return subtle;
}

/** `r‖s` → DER `SEQUENCE { INTEGER r, INTEGER s }`, as an authenticator emits ES256. */
export function p1363ToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  const integer = (bytes: Uint8Array): Uint8Array => {
    let start = 0;
    while (start < bytes.length - 1 && bytes[start] === 0) {
      start += 1;
    }
    const body = bytes.subarray(start);
    const padded = body[0]! & 0x80 ? new Uint8Array([0, ...body]) : body;
    return new Uint8Array([0x02, padded.length, ...padded]);
  };
  const r = integer(raw.subarray(0, half));
  const s = integer(raw.subarray(half));
  return new Uint8Array([0x30, r.length + s.length, ...r, ...s]);
}

/** A minimal CBOR writer (RFC 8949) for what a `none` attestation object and a COSE key hold. */
export function cbor(value: unknown): Uint8Array {
  const out: number[] = [];
  const head = (major: number, length: number): void => {
    if (length < 24) {
      out.push((major << 5) | length);
    } else if (length < 0x100) {
      out.push((major << 5) | 24, length);
    } else if (length < 0x10000) {
      out.push((major << 5) | 25, length >> 8, length & 0xff);
    } else {
      out.push((major << 5) | 26, (length >>> 24) & 0xff, (length >> 16) & 0xff, (length >> 8) & 0xff, length & 0xff);
    }
  };
  const write = (entry: unknown): void => {
    if (typeof entry === "number") {
      if (entry >= 0) {
        head(0, entry);
      } else {
        head(1, -1 - entry);
      }
    } else if (typeof entry === "string") {
      const bytes = new TextEncoder().encode(entry);
      head(3, bytes.length);
      out.push(...bytes);
    } else if (entry instanceof Uint8Array) {
      head(2, entry.length);
      out.push(...entry);
    } else if (entry instanceof Map) {
      head(5, entry.size);
      for (const [key, item] of entry) {
        write(key);
        write(item);
      }
    } else {
      throw new Error("cbor: unsupported value");
    }
  };
  write(value);
  return new Uint8Array(out);
}

export class SoftwareAuthenticator {
  public readonly calls: { create: PublicKeyCredentialCreationOptions[]; get: PublicKeyCredentialRequestOptions[] } = { create: [], get: [] };
  public signCount: number;
  /** The credential public key as COSE (what attested credential data carries). */
  public coseKey: Uint8Array = new Uint8Array(0);
  /** The user handle the last `create()` was for, base64url; a discoverable credential returns it on `get()`. */
  public userHandle: string | null = null;

  constructor(
    public readonly rpId: string,
    public readonly origin: string,
    public readonly algorithm: number,
    public readonly credentialId: Uint8Array,
    public readonly publicKeySpki: Uint8Array,
    private readonly privateKey: CryptoKey,
    private readonly wrongPrivateKey: CryptoKey,
    private readonly options: SoftwareAuthenticatorOptions,
    private readonly subtle: SubtleCrypto
  ) {
    this.signCount = options.signCount ?? 0;
  }

  public get id(): string {
    return bytesToBase64Url(this.credentialId);
  }

  public get publicKey(): string {
    return bytesToBase64(this.publicKeySpki);
  }

  /** The record a relying party would keep after registering this authenticator. */
  public record(name = "Test key", createdAt = "2026-09-15T00:00:00.000Z"): WebAuthnCredentialRecord {
    return {
      id: this.id,
      name,
      publicKey: this.publicKey,
      algorithm: this.algorithm,
      transports: this.options.transports ?? ["usb"],
      signCount: this.signCount,
      flags: { userVerified: this.options.userVerified ?? true, backupEligible: this.options.backupEligible ?? false, backedUp: this.options.backedUp ?? false },
      createdAt
    };
  }

  public authenticatorData(overrides: AssertOverrides = {}, attested = false): Uint8Array {
    const flags =
      ((overrides.userPresent ?? this.options.userPresent ?? true) ? 0x01 : 0) |
      ((overrides.userVerified ?? this.options.userVerified ?? true) ? 0x04 : 0) |
      ((this.options.backupEligible ?? false) ? 0x08 : 0) |
      ((this.options.backedUp ?? false) ? 0x10 : 0) |
      (attested ? 0x40 : 0);
    // With AT: the attested credential data — an all-zero AAGUID, the id's length, the id, the COSE key.
    const attestedData = attested ? 16 + 2 + this.credentialId.length + this.coseKey.length : 0;
    const out = new Uint8Array(37 + attestedData);
    out.set(sha256(new TextEncoder().encode(this.rpId)), 0);
    out[32] = flags;
    new DataView(out.buffer).setUint32(33, this.signCount, false);
    if (attested) {
      new DataView(out.buffer).setUint16(37 + 16, this.credentialId.length, false);
      out.set(this.credentialId, 37 + 18);
      out.set(this.coseKey, 37 + 18 + this.credentialId.length);
    }
    return out;
  }

  public clientData(challenge: Uint8Array, overrides: AssertOverrides = {}): Uint8Array {
    return new TextEncoder().encode(JSON.stringify({ type: overrides.type ?? "webauthn.get", challenge: bytesToBase64Url(challenge), origin: overrides.origin ?? this.origin, crossOrigin: false }));
  }

  /** Signs `authenticatorData || SHA-256(clientDataJSON)` the way the platform does. */
  public async sign(authenticatorData: Uint8Array, clientDataJSON: Uint8Array, wrongKey = false): Promise<Uint8Array> {
    const hash = sha256(clientDataJSON);
    const data = new Uint8Array(authenticatorData.length + hash.length);
    data.set(authenticatorData, 0);
    data.set(hash, authenticatorData.length);
    const key = wrongKey ? this.wrongPrivateKey : this.privateKey;
    if (this.algorithm === COSE_ALGORITHM.ES256) {
      const raw = new Uint8Array(await this.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data as BufferSource));
      return p1363ToDer(raw);
    }
    return new Uint8Array(await this.subtle.sign({ name: "RSASSA-PKCS1-v1_5" }, key, data as BufferSource));
  }

  /** An assertion over `challenge`, ready to archive, without going through a container. */
  public async assert(challenge: Uint8Array, overrides: AssertOverrides = {}): Promise<{ credentialId: string; authenticatorData: string; clientDataJSON: string; signature: string; userHandle: string | null; publicKey: string; algorithm: number; rpId: string; origin: string; signedAt: string }> {
    this.signCount += 1;
    const authenticatorData = this.authenticatorData(overrides);
    const clientDataJSON = this.clientData(challenge, overrides);
    const signature = await this.sign(authenticatorData, clientDataJSON, overrides.wrongKey ?? false);
    return {
      credentialId: this.id,
      authenticatorData: bytesToBase64Url(authenticatorData),
      clientDataJSON: bytesToBase64Url(clientDataJSON),
      signature: bytesToBase64Url(signature),
      userHandle: this.userHandle,
      publicKey: this.publicKey,
      algorithm: this.algorithm,
      rpId: this.rpId,
      origin: overrides.origin ?? this.origin,
      signedAt: "2026-09-15T12:00:00.000Z"
    };
  }

  /** A `navigator.credentials` stand-in: `create()` registers this key, `get()` asserts over the request's challenge. */
  public container(behaviour: { createError?: Error; getError?: Error; refuseUnknownAllowList?: boolean } = {}): CredentialsContainer {
    const self = this;
    return {
      async create(options?: CredentialCreationOptions): Promise<Credential | null> {
        const request = options?.publicKey;
        if (!request) {
          throw new TypeError("no publicKey options");
        }
        self.calls.create.push(request);
        if (behaviour.createError) {
          throw behaviour.createError;
        }
        self.userHandle = bytesToBase64Url(new Uint8Array(request.user.id as ArrayBuffer));
        const authenticatorData = self.authenticatorData({}, true);
        const clientDataJSON = new TextEncoder().encode(JSON.stringify({ type: "webauthn.create", challenge: bytesToBase64Url(new Uint8Array(request.challenge as ArrayBuffer)), origin: self.origin, crossOrigin: false }));
        const attestationObject = cbor(new Map<string, unknown>([["fmt", "none"], ["attStmt", new Map()], ["authData", authenticatorData]]));
        return {
          id: self.id,
          type: "public-key",
          rawId: bufferOf(self.credentialId),
          authenticatorAttachment: "cross-platform",
          response: {
            clientDataJSON: bufferOf(clientDataJSON),
            attestationObject: bufferOf(attestationObject),
            getPublicKey: () => bufferOf(self.publicKeySpki),
            getPublicKeyAlgorithm: () => self.algorithm,
            getTransports: () => self.options.transports ?? ["usb"],
            getAuthenticatorData: () => bufferOf(authenticatorData)
          },
          getClientExtensionResults: () => ({})
        } as unknown as Credential;
      },
      async get(options?: CredentialRequestOptions): Promise<Credential | null> {
        const request = options?.publicKey;
        if (!request) {
          throw new TypeError("no publicKey options");
        }
        self.calls.get.push(request);
        if (behaviour.getError) {
          throw behaviour.getError;
        }
        const allowed = request.allowCredentials ?? [];
        if (behaviour.refuseUnknownAllowList !== false && allowed.length > 0 && !allowed.some((entry) => bytesToBase64Url(new Uint8Array(entry.id as ArrayBuffer)) === self.id)) {
          throw Object.assign(new Error("The operation either timed out or was not allowed."), { name: "NotAllowedError" });
        }
        const assertion = await self.assert(new Uint8Array(request.challenge as ArrayBuffer));
        return {
          id: self.id,
          type: "public-key",
          rawId: bufferOf(self.credentialId),
          response: {
            clientDataJSON: bufferOf(base64UrlToBytes(assertion.clientDataJSON)),
            authenticatorData: bufferOf(base64UrlToBytes(assertion.authenticatorData)),
            signature: bufferOf(base64UrlToBytes(assertion.signature)),
            userHandle: assertion.userHandle ? bufferOf(base64UrlToBytes(assertion.userHandle)) : null
          },
          getClientExtensionResults: () => ({})
        } as unknown as Credential;
      },
      async store(credential: Credential): Promise<Credential> {
        return credential;
      },
      async preventSilentAccess(): Promise<void> {}
    } as unknown as CredentialsContainer;
  }
}

function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function createSoftwareAuthenticator(options: SoftwareAuthenticatorOptions = {}): Promise<SoftwareAuthenticator> {
  const subtle = subtleOf(options);
  const algorithm = options.algorithm === "RS256" ? COSE_ALGORITHM.RS256 : COSE_ALGORITHM.ES256;
  const params = algorithm === COSE_ALGORITHM.RS256 ? { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" } : { name: "ECDSA", namedCurve: "P-256" };
  const pair = (await subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const other = (await subtle.generateKey(params, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const credentialId = new Uint8Array(16);
  (globalThis as { crypto: { getRandomValues: (array: Uint8Array) => Uint8Array } }).crypto.getRandomValues(credentialId);
  const authenticator = new SoftwareAuthenticator(options.rpId ?? "localhost", options.origin ?? "http://localhost:5173", algorithm, credentialId, spki, pair.privateKey, other.privateKey, options, subtle);
  const jwk = await subtle.exportKey("jwk", pair.publicKey);
  authenticator.coseKey =
    algorithm === COSE_ALGORITHM.RS256
      ? cbor(new Map<number, unknown>([[1, 3], [3, algorithm], [-1, base64UrlToBytes(jwk.n!)], [-2, base64UrlToBytes(jwk.e!)]]))
      : cbor(new Map<number, unknown>([[1, 2], [3, algorithm], [-1, 1], [-2, base64UrlToBytes(jwk.x!)], [-3, base64UrlToBytes(jwk.y!)]]));
  return authenticator;
}

/**
 * Installs what a page has and a test DOM (or Node) lacks: `PublicKeyCredential` (with the
 * Signal statics when asked) and `navigator.credentials`. Returns the undo.
 */
export function installWebAuthnGlobals(container: CredentialsContainer, options: { signals?: boolean } = {}): { restore: () => void; signals: Array<{ method: string; args: unknown }> } {
  const signals: Array<{ method: string; args: unknown }> = [];
  const g = globalThis as { PublicKeyCredential?: unknown; navigator?: Navigator };
  const hadPkc = Object.prototype.hasOwnProperty.call(g, "PublicKeyCredential");
  const previousPkc = g.PublicKeyCredential;
  class FakePublicKeyCredential {
    static isUserVerifyingPlatformAuthenticatorAvailable = async (): Promise<boolean> => true;
    static isConditionalMediationAvailable = async (): Promise<boolean> => false;
  }
  if (options.signals) {
    Object.assign(FakePublicKeyCredential, {
      signalUnknownCredential: async (args: unknown) => {
        signals.push({ method: "signalUnknownCredential", args });
      },
      signalAllAcceptedCredentials: async (args: unknown) => {
        signals.push({ method: "signalAllAcceptedCredentials", args });
      },
      signalCurrentUserDetails: async (args: unknown) => {
        signals.push({ method: "signalCurrentUserDetails", args });
      }
    });
  }
  g.PublicKeyCredential = FakePublicKeyCredential;
  const hadNavigator = g.navigator !== undefined;
  let restoreNavigator: () => void;
  if (hadNavigator) {
    const descriptor = Object.getOwnPropertyDescriptor(g.navigator, "credentials");
    Object.defineProperty(g.navigator, "credentials", { value: container, configurable: true });
    restoreNavigator = () => {
      if (descriptor) {
        Object.defineProperty(g.navigator, "credentials", descriptor);
      } else {
        delete (g.navigator as unknown as Record<string, unknown>).credentials;
      }
    };
  } else {
    Object.defineProperty(g, "navigator", { value: { credentials: container }, configurable: true });
    restoreNavigator = () => {
      delete (g as Record<string, unknown>).navigator;
    };
  }
  return {
    signals,
    restore: () => {
      restoreNavigator();
      if (hadPkc) {
        g.PublicKeyCredential = previousPkc;
      } else {
        delete g.PublicKeyCredential;
      }
    }
  };
}
