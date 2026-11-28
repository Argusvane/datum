/**
 * What a credential's SPKI (DER `SubjectPublicKeyInfo`, as `getPublicKey()` returns it) says
 * about its key: an RSA key and its modulus size, or an EC key and its curve. Read synchronously,
 * so a registration check and the archived algorithm label need no WebCrypto. The key policy is
 * the one the JVM verifier holds: ES256 on P-256, or RS256 with a modulus of at least 2048 bits.
 */
import { base64ToBytes } from "../../core/schema/file-upload.js";
import { COSE_ALGORITHM } from "../../core/submission/webauthn-assertion.js";

export type SpkiKey = { type: "rsa"; modulusBits: number } | { type: "ec"; curve: "P-256" | "other" } | { type: "other" };

/** The smallest RSA modulus a credential may have. */
export const MIN_RSA_MODULUS_BITS = 2048;

const RSA_ENCRYPTION = [0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01];
const EC_PUBLIC_KEY = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01];
const PRIME256V1 = [0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07];

interface Tlv {
  tag: number;
  start: number;
  end: number;
}

function tlvAt(bytes: Uint8Array, offset: number, limit = bytes.length): Tlv | undefined {
  if (offset + 2 > limit) {
    return undefined;
  }
  const tag = bytes[offset]!;
  let length = bytes[offset + 1]!;
  let start = offset + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || start + count > limit) {
      return undefined;
    }
    length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + bytes[start + index]!;
    }
    start += count;
  }
  return start + length > limit ? undefined : { tag, start, end: start + length };
}

function contentIs(bytes: Uint8Array, tlv: Tlv, expected: readonly number[]): boolean {
  return tlv.end - tlv.start === expected.length && expected.every((byte, index) => bytes[tlv.start + index] === byte);
}

/** The key an SPKI holds; `undefined` when the bytes are not an SPKI. */
export function readSpki(spki: Uint8Array): SpkiKey | undefined {
  const outer = tlvAt(spki, 0);
  const algorithm = outer?.tag === 0x30 ? tlvAt(spki, outer.start, outer.end) : undefined;
  const oid = algorithm?.tag === 0x30 ? tlvAt(spki, algorithm.start, algorithm.end) : undefined;
  if (!outer || !algorithm || !oid || oid.tag !== 0x06) {
    return undefined;
  }
  const bits = tlvAt(spki, algorithm.end, outer.end);
  if (!bits || bits.tag !== 0x03) {
    return undefined;
  }
  if (contentIs(spki, oid, RSA_ENCRYPTION)) {
    // The BIT STRING holds RSAPublicKey: SEQUENCE { INTEGER modulus, INTEGER exponent }.
    const sequence = tlvAt(spki, bits.start + 1, bits.end);
    const modulus = sequence?.tag === 0x30 ? tlvAt(spki, sequence.start, sequence.end) : undefined;
    if (!modulus || modulus.tag !== 0x02) {
      return undefined;
    }
    let start = modulus.start;
    while (start < modulus.end && spki[start] === 0) {
      start += 1;
    }
    const lead = start < modulus.end ? spki[start]! : 0;
    const modulusBits = start < modulus.end ? (modulus.end - start - 1) * 8 + (32 - Math.clz32(lead)) : 0;
    return { type: "rsa", modulusBits };
  }
  if (contentIs(spki, oid, EC_PUBLIC_KEY)) {
    const curve = tlvAt(spki, oid.end, algorithm.end);
    return { type: "ec", curve: curve?.tag === 0x06 && contentIs(spki, curve, PRIME256V1) ? "P-256" : "other" };
  }
  return { type: "other" };
}

/** The COSE algorithm a key's type implies: RS256 for RSA, ES256 for EC; `undefined` for any other key or bytes that are not an SPKI. */
export function coseAlgorithmOfSpki(spki: Uint8Array): number | undefined {
  const key = readSpki(spki);
  return key?.type === "rsa" ? COSE_ALGORITHM.RS256 : key?.type === "ec" ? COSE_ALGORITHM.ES256 : undefined;
}

/** Whether a key may sign under a COSE algorithm here: ES256 on P-256, or RS256 of at least 2048 bits. */
export function meetsKeyPolicy(key: SpkiKey | undefined, algorithm: number): boolean {
  if (algorithm === COSE_ALGORITHM.ES256) {
    return key?.type === "ec" && key.curve === "P-256";
  }
  if (algorithm === COSE_ALGORITHM.RS256) {
    return key?.type === "rsa" && key.modulusBits >= MIN_RSA_MODULUS_BITS;
  }
  return false;
}

/** {@link coseAlgorithmOfSpki} over SPKI base64, as records keep it; `undefined` when absent or unreadable. */
export function coseAlgorithmOfSpkiBase64(publicKey: string | undefined): number | undefined {
  if (!publicKey) {
    return undefined;
  }
  try {
    return coseAlgorithmOfSpki(base64ToBytes(publicKey));
  } catch {
    return undefined;
  }
}
