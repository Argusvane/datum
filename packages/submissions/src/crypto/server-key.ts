import { createWebCryptoPdfSigner, type PdfSigner } from "@argusvane/datum-engine";
import { mintSelfSignedCertificate, parseCertificate } from "@argusvane/datum-pdf-kernel";

import { base64ToBytes, bytesToBase64 } from "../pdf/submission-attachment.js";
import type { SubmissionStore } from "../store/submission-store.js";
import type { StoredKeyMaterial } from "../types.js";

/**
 * The server's signing identity: an ECDSA P-256 key and a self-signed
 * certificate, minted with the platform's WebCrypto the first time a signature is wanted and
 * kept in the store — the demo equivalent of the `openssl req -x509` line at the top of the
 * server samples. The key never leaves the host: the `PdfSigner` the kernel is handed signs
 * with it and hands back the value. A deployment replaces this with a key file, a hardware
 * token or a KMS behind the same `PdfSigner` shape.
 */
export interface ServerKeyOptions {
  commonName?: string;
  organization?: string;
  /** How long the certificate is good for; ten years when absent. */
  days?: number;
  subtle?: SubtleCrypto;
  clock?: () => Date;
}

export interface ServerKeys {
  /** The material, minted on first call. */
  material(): Promise<StoredKeyMaterial>;
  /** A signer over it, for the PDF kernel. */
  signer(): Promise<PdfSigner>;
  /** What a verifier needs to trust this server: the certificate, and the key for a person who wants to move it. */
  export(): Promise<{ certificatePem: string; privateKeyPem: string; subject: string }>;
  /** The certificate as the store has it, or nothing before the first signature. */
  certificate(): Promise<{ der: string; subject: string; createdAt: string } | undefined>;
}

function subtleOf(options: ServerKeyOptions): SubtleCrypto {
  const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto is not available here; give the server keys a SubtleCrypto");
  }
  return subtle;
}

/** How far back a fresh certificate's validity starts: five minutes. */
export const NOT_BEFORE_SKEW_MS = 5 * 60_000;

export function pem(label: string, der: Uint8Array): string {
  const lines = bytesToBase64(der).match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/** Mints the material: a P-256 pair, the key exported as PKCS#8, the certificate over the SPKI, signed by the pair. */
export async function mintServerKey(options: ServerKeyOptions = {}): Promise<StoredKeyMaterial> {
  const subtle = subtleOf(options);
  const now = (options.clock ?? (() => new Date()))();
  const pair = (await subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = new Uint8Array(await subtle.exportKey("spki", pair.publicKey));
  const pkcs8 = new Uint8Array(await subtle.exportKey("pkcs8", pair.privateKey));
  const notAfter = new Date(now.getTime() + (options.days ?? 3650) * 86_400_000);
  // Backdated a little, as `openssl req -x509` effectively is: the first signature is often
  // over a document stamped a moment before the key existed, and a verifier's clock may lag.
  const notBefore = new Date(now.getTime() - NOT_BEFORE_SKEW_MS);
  const der = await mintSelfSignedCertificate({
    spki,
    subject: { commonName: options.commonName ?? "Datum Data tab (demo)", organization: options.organization ?? "Datum" },
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString(),
    sign: async (tbs) => new Uint8Array(await subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, tbs as BufferSource))
  });
  return {
    algorithm: "ECDSA-P256-SHA256",
    privateKeyPkcs8: bytesToBase64(pkcs8),
    certificateDer: bytesToBase64(der),
    subject: parseCertificate(der).subject,
    createdAt: now.toISOString()
  };
}

/** A `PdfSigner` over stored material: WebCrypto with the key imported once. */
export function createServerSigner(material: StoredKeyMaterial, subtle?: SubtleCrypto): PdfSigner {
  return createWebCryptoPdfSigner({ privateKey: material.privateKeyPkcs8, certificates: [material.certificateDer], ...(subtle ? { subtle } : {}) });
}

export function createServerKeys(store: SubmissionStore, options: ServerKeyOptions = {}): ServerKeys {
  let pending: Promise<StoredKeyMaterial> | undefined;
  let signerCache: { for: string; signer: PdfSigner } | undefined;
  const material = async (): Promise<StoredKeyMaterial> => {
    const existing = await store.getKeyMaterial();
    if (existing) {
      return existing;
    }
    if (!pending) {
      pending = mintServerKey(options)
        .then(async (minted) => {
          await store.putKeyMaterial(minted);
          return minted;
        })
        .finally(() => {
          pending = undefined;
        });
    }
    return pending;
  };
  return {
    material,
    async signer() {
      const current = await material();
      if (!signerCache || signerCache.for !== current.certificateDer) {
        signerCache = { for: current.certificateDer, signer: createServerSigner(current, options.subtle) };
      }
      return signerCache.signer;
    },
    async export() {
      const current = await material();
      return {
        certificatePem: pem("CERTIFICATE", base64ToBytes(current.certificateDer)),
        privateKeyPem: pem("PRIVATE KEY", base64ToBytes(current.privateKeyPkcs8)),
        subject: current.subject
      };
    },
    async certificate() {
      const current = await store.getKeyMaterial();
      return current ? { der: current.certificateDer, subject: current.subject, createdAt: current.createdAt } : undefined;
    }
  };
}
