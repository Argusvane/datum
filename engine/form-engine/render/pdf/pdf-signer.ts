/**
 * Signers a host can wire into `renderFormPdf`. The engine takes no crypto
 * dependency: this one uses the platform's WebCrypto (`globalThis.crypto.subtle`, in browsers
 * and in Node), with the private key imported once. A server with a hardware token or a cloud
 * KMS writes its own `PdfSigner` — the same two-line shape, a different `sign`.
 */
import { base64ToBytes } from "../../core/schema/file-upload.js";
import type { PdfSignatureAlgorithm, PdfSignatureSpec } from "./pdf-abi.js";
import type { PdfSigner, PdfTimestamper } from "./pdf-provider.js";

export interface WebCryptoPdfSignerOptions {
  /** The private key, PKCS#8 — base64 DER, or PEM. */
  privateKey: string;
  /** The signer's certificate chain, DER base64, leaf first. */
  certificates: string[];
  /** Defaults to `globalThis.crypto.subtle`. */
  subtle?: SubtleCrypto;
}

function pemToBase64(text: string): string {
  return text.replace(/-----BEGIN [^-]+-----/g, "").replace(/-----END [^-]+-----/g, "").replace(/\s+/g, "");
}

function importParameters(algorithm: PdfSignatureAlgorithm): { algorithm: RsaHashedImportParams | EcKeyImportParams; sign: AlgorithmIdentifier | EcdsaParams } {
  if (algorithm === "RSASSA-PKCS1-v1_5-SHA256") {
    return { algorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, sign: { name: "RSASSA-PKCS1-v1_5" } };
  }
  return { algorithm: { name: "ECDSA", namedCurve: algorithm === "ECDSA-P384-SHA256" ? "P-384" : "P-256" }, sign: { name: "ECDSA", hash: "SHA-256" } };
}

/** A signer on WebCrypto. ECDSA values come back as `r‖s`, which the kernel accepts as they are. */
export function createWebCryptoPdfSigner(options: WebCryptoPdfSignerOptions): PdfSigner {
  const subtle = options.subtle ?? (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle;
  if (!subtle) {
    throw new Error("WebCrypto is not available here; give the signer a SubtleCrypto");
  }
  const keyBytes = base64ToBytes(pemToBase64(options.privateKey));
  const keys = new Map<PdfSignatureAlgorithm, Promise<CryptoKey>>();
  return {
    certificates: options.certificates,
    async sign(toBeSigned: Uint8Array, algorithm: PdfSignatureAlgorithm): Promise<Uint8Array> {
      const parameters = importParameters(algorithm);
      let key = keys.get(algorithm);
      if (!key) {
        key = subtle.importKey("pkcs8", keyBytes as BufferSource, parameters.algorithm, false, ["sign"]);
        keys.set(algorithm, key);
      }
      return new Uint8Array(await subtle.sign(parameters.sign, await key, toBeSigned as BufferSource));
    }
  };
}

/** Verifies a signature the kernel reported, with WebCrypto, from the signer's SPKI the report carries. */
export async function verifyWithWebCrypto(
  report: { toBeVerified: string; signature: string; signatureP1363?: string; signatureAlgorithm: string; signer: { publicKey: string } | null },
  subtle: SubtleCrypto | undefined = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto?.subtle
): Promise<boolean> {
  if (!subtle || !report.signer) {
    return false;
  }
  const spki = base64ToBytes(report.signer.publicKey) as BufferSource;
  const data = base64ToBytes(report.toBeVerified) as BufferSource;
  if (report.signatureAlgorithm === "1.2.840.113549.1.1.11" || report.signatureAlgorithm === "1.2.840.113549.1.1.1") {
    const key = await subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    return subtle.verify({ name: "RSASSA-PKCS1-v1_5" }, key, base64ToBytes(report.signature) as BufferSource, data);
  }
  if (report.signatureP1363) {
    for (const namedCurve of ["P-256", "P-384"] as const) {
      try {
        const key = await subtle.importKey("spki", spki, { name: "ECDSA", namedCurve }, false, ["verify"]);
        return await subtle.verify({ name: "ECDSA", hash: "SHA-256" }, key, base64ToBytes(report.signatureP1363) as BufferSource, data);
      } catch {
        // the other curve
      }
    }
  }
  return false;
}

/** A timestamper that POSTs the kernel's request to an RFC 3161 authority over HTTP. */
export function createFetchTimestamper(url: string, fetchImpl?: typeof fetch): PdfTimestamper {
  return {
    async timestamp(request: Uint8Array): Promise<Uint8Array> {
      const doFetch = fetchImpl ?? (globalThis as { fetch?: typeof fetch }).fetch;
      if (!doFetch) {
        throw new Error("fetch is not available here; give the timestamper a fetch");
      }
      const response = await doFetch(url, { method: "POST", headers: { "Content-Type": "application/timestamp-query" }, body: request as BufferSource });
      if (!response.ok) {
        throw new Error(`The timestamp authority answered ${response.status}`);
      }
      return new Uint8Array(await response.arrayBuffer());
    }
  };
}

/** The signature settings a layout or a host wrote, without the certificates a signer adds. */
export type PdfSignatureRequestSettings = Partial<Omit<PdfSignatureSpec, "certificates">>;
