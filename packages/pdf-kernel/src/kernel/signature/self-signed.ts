/**
 * A self-signed X.509 certificate for a key the host holds: what a submissions
 * server standing in a page mints for itself on first use, so its PDF signatures carry an
 * identity a verifier can name — the way `openssl req -x509` mints one for the server samples.
 * Version 3, ECDSA-with-SHA256 over a P-256 key, issuer = subject, BasicConstraints CA:false,
 * KeyUsage digitalSignature + nonRepudiation, a SubjectKeyIdentifier from the key. Written
 * with the kernel's own DER encoder; the one cryptographic step — the signature over the
 * TBSCertificate — is the host's, through `sign`, as every other signature in this kernel is.
 */
import { sha256 } from "@argusvane/datum-engine";

import { OID, TAG, boolean, concat, explicit, integer, octetString, oid, sequence, setOf, tlv, time, utf8String } from "./der.js";

export interface SelfSignedCertificateSubject {
  commonName: string;
  organization?: string;
  organizationalUnit?: string;
  country?: string;
}

export interface MintSelfSignedCertificateOptions {
  /** The SubjectPublicKeyInfo, DER — what WebCrypto exports as "spki". */
  spki: Uint8Array;
  subject: SelfSignedCertificateSubject;
  /** ISO 8601 instants; UTCTime up to 2049, GeneralizedTime after. */
  notBefore: string;
  notAfter: string;
  /** A positive INTEGER; 16 random bytes when absent (`random` supplies them). */
  serial?: Uint8Array;
  random?: (length: number) => Uint8Array;
  /**
   * Signs the DER TBSCertificate with SHA-256 and the key `spki` certifies. ECDSA values may
   * come back as WebCrypto's `r‖s` or as DER; both are taken.
   */
  sign: (toBeSigned: Uint8Array) => Promise<Uint8Array>;
}

const SUBJECT_KEY_IDENTIFIER = "2.5.29.14";

function name(subject: SelfSignedCertificateSubject): Uint8Array {
  const attribute = (type: string, value: string, tag: number = TAG.utf8String): Uint8Array => setOf([sequence(oid(type), tag === TAG.utf8String ? utf8String(value) : tlv(tag, new TextEncoder().encode(value)))]);
  const parts: Uint8Array[] = [];
  if (subject.country) {
    parts.push(attribute(OID.country, subject.country, TAG.printableString));
  }
  if (subject.organization) {
    parts.push(attribute(OID.organization, subject.organization));
  }
  if (subject.organizationalUnit) {
    parts.push(attribute(OID.organizationalUnit, subject.organizationalUnit));
  }
  parts.push(attribute(OID.commonName, subject.commonName));
  return sequence(...parts);
}

function bitString(bytes: Uint8Array, unusedBits = 0): Uint8Array {
  return tlv(TAG.bitString, concat([new Uint8Array([unusedBits]), bytes]));
}

/** `r‖s` (P1363) → DER `SEQUENCE { INTEGER r, INTEGER s }`; DER passes through. */
export function ecdsaSignatureToDer(value: Uint8Array): Uint8Array {
  if (value[0] === TAG.sequence) {
    return value;
  }
  if (value.length % 2 !== 0) {
    throw new Error("self-signed: an ECDSA signature must be DER or fixed-width r‖s");
  }
  const half = value.length / 2;
  return sequence(integer(value.subarray(0, half)), integer(value.subarray(half)));
}

/** The public key's bytes out of an SPKI: the BIT STRING's content without its unused-bits byte. */
function publicKeyBytesOf(spki: Uint8Array): Uint8Array {
  // SEQUENCE { SEQUENCE algorithm, BIT STRING key } — walk the two TLVs by hand; lengths here are short-form or two-byte.
  const lengthAt = (at: number): { length: number; next: number } => {
    const first = spki[at]!;
    if (first < 0x80) {
      return { length: first, next: at + 1 };
    }
    const count = first & 0x7f;
    let length = 0;
    for (let index = 0; index < count; index += 1) {
      length = length * 256 + spki[at + 1 + index]!;
    }
    return { length, next: at + 1 + count };
  };
  const outer = lengthAt(1);
  let at = outer.next;
  const algorithm = lengthAt(at + 1);
  at = algorithm.next + algorithm.length;
  if (spki[at] !== TAG.bitString) {
    throw new Error("self-signed: not a SubjectPublicKeyInfo");
  }
  const key = lengthAt(at + 1);
  return spki.subarray(key.next + 1, key.next + key.length);
}

export async function mintSelfSignedCertificate(options: MintSelfSignedCertificateOptions): Promise<Uint8Array> {
  const random = options.random ?? ((length: number) => (globalThis as { crypto: { getRandomValues: (array: Uint8Array) => Uint8Array } }).crypto.getRandomValues(new Uint8Array(length)));
  const serialBytes = options.serial ?? random(16);
  // A serial is a positive INTEGER: clear the top bit rather than let `integer` pad a sign byte in.
  const serial = serialBytes.slice();
  serial[0] = (serial[0] ?? 1) & 0x7f;
  if (serial.every((byte) => byte === 0)) {
    serial[serial.length - 1] = 1;
  }
  const signatureAlgorithm = sequence(oid(OID.ecdsaWithSHA256));
  const subject = name(options.subject);
  const keyId = sha256(publicKeyBytesOf(options.spki)).subarray(0, 20);
  const extensions = explicit(
    3,
    sequence(
      sequence(oid(OID.basicConstraints), boolean(true), octetString(sequence())),
      sequence(oid(OID.keyUsage), boolean(true), octetString(bitString(new Uint8Array([0xc0]), 6))),
      sequence(oid(SUBJECT_KEY_IDENTIFIER), octetString(octetString(keyId)))
    )
  );
  const tbs = sequence(
    explicit(0, integer(2)),
    integer(serial),
    signatureAlgorithm,
    subject,
    sequence(time(options.notBefore), time(options.notAfter)),
    subject,
    options.spki,
    extensions
  );
  const signature = ecdsaSignatureToDer(await options.sign(tbs));
  return sequence(tbs, signatureAlgorithm, bitString(signature));
}
