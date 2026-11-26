/**
 * The signing stand-in's own identity: an RSA key pair made with WebCrypto when the example first
 * signs, and a self-signed X.509 v3 certificate for it, the way `openssl req -x509` makes one for a
 * server to try with. Nothing is published and nothing is kept: a reload makes a new pair. No PDF
 * viewer trusts the certificate; a real server signs with its own.
 *
 * The built modules this site loads expose no certificate writer, so the certificate is encoded
 * here, with just enough DER (ITU-T X.690) for one self-signed RSA certificate. Every value is a
 * TLV: a tag byte, a length, then the content.
 */
import { toBase64 } from "./server-stand-in";

// --- DER ---------------------------------------------------------------------------------------

const TAG = {
  boolean: 0x01,
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31
} as const;

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** A length: one byte below 128, else 0x80 + the count of big-endian bytes that follow. */
function length(count: number): Uint8Array {
  if (count < 0x80) return new Uint8Array([count]);
  const bytes: number[] = [];
  for (let rest = count; rest > 0; rest = Math.floor(rest / 256)) bytes.unshift(rest % 256);
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([new Uint8Array([tag]), length(content.length), content]);
}

const sequence = (...items: Uint8Array[]): Uint8Array => tlv(TAG.sequence, concat(items));
const set = (...items: Uint8Array[]): Uint8Array => tlv(TAG.set, concat(items));
const octetString = (bytes: Uint8Array): Uint8Array => tlv(TAG.octetString, bytes);
const utf8String = (text: string): Uint8Array => tlv(TAG.utf8String, new TextEncoder().encode(text));
const derNull = (): Uint8Array => tlv(TAG.null, new Uint8Array());
const derTrue = (): Uint8Array => tlv(TAG.boolean, new Uint8Array([0xff]));
/** `[n] EXPLICIT`: a context-specific, constructed wrapper around one value. */
const explicit = (n: number, value: Uint8Array): Uint8Array => tlv(0xa0 | n, value);

/**
 * An INTEGER from big-endian bytes, read as unsigned: leading zero bytes dropped (one kept), and
 * a zero byte put in front when the top bit is set, or it would read as negative.
 */
function integer(bytes: Uint8Array): Uint8Array {
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const trimmed = bytes.subarray(start);
  return tlv(TAG.integer, (trimmed[0] ?? 0) & 0x80 ? concat([new Uint8Array([0]), trimmed]) : trimmed);
}

/** A BIT STRING: the count of unused bits in the last byte, then the bytes. */
const bitString = (bytes: Uint8Array, unusedBits = 0): Uint8Array => tlv(TAG.bitString, concat([new Uint8Array([unusedBits]), bytes]));

/** An OBJECT IDENTIFIER: the first two arcs as 40 × a + b, then each arc in base 128, high bit on all but its last byte. */
function oid(dotted: string): Uint8Array {
  const arcs = dotted.split(".").map(Number);
  const bytes: number[] = [];
  for (const arc of [40 * arcs[0]! + arcs[1]!, ...arcs.slice(2)]) {
    const chunk = [arc & 0x7f];
    for (let rest = Math.floor(arc / 128); rest > 0; rest = Math.floor(rest / 128)) chunk.unshift(0x80 | (rest & 0x7f));
    bytes.push(...chunk);
  }
  return tlv(TAG.oid, new Uint8Array(bytes));
}

/** UTCTime (YYMMDDHHMMSSZ) through 2049, GeneralizedTime (YYYYMMDDHHMMSSZ) after, as RFC 5280 asks. */
function time(date: Date): Uint8Array {
  const digits = date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:T]/g, "");
  return date.getUTCFullYear() < 2050 ? tlv(TAG.utcTime, new TextEncoder().encode(digits.slice(2))) : tlv(TAG.generalizedTime, new TextEncoder().encode(digits));
}

// --- the certificate ---------------------------------------------------------------------------

const OID = {
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSAEncryption: "1.2.840.113549.1.1.11",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  basicConstraints: "2.5.29.19"
} as const;

export const SIGNER_COMMON_NAME = "Intake service (demo)";
export const SIGNER_ORGANIZATION = "Example Org";

const RSA_SHA256 = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } as const;

/** `CN=…, O=…`: one attribute per relative distinguished name, in that order. */
function name(): Uint8Array {
  const attribute = (type: string, value: string): Uint8Array => set(sequence(oid(type), utf8String(value)));
  return sequence(attribute(OID.commonName, SIGNER_COMMON_NAME), attribute(OID.organization, SIGNER_ORGANIZATION));
}

/** The subjectPublicKey out of a SubjectPublicKeyInfo: the BIT STRING after the algorithm, without its unused-bits byte. */
function subjectPublicKey(spki: Uint8Array): Uint8Array {
  // Read one TLV header at `at`: where its content starts and how long it is.
  const header = (at: number): { start: number; size: number } => {
    const first = spki[at + 1]!;
    if (first < 0x80) return { start: at + 2, size: first };
    let size = 0;
    for (let index = 0; index < (first & 0x7f); index += 1) size = size * 256 + spki[at + 2 + index]!;
    return { start: at + 2 + (first & 0x7f), size };
  };
  const algorithm = header(header(0).start);
  const keyAt = algorithm.start + algorithm.size;
  if (spki[keyAt] !== TAG.bitString) throw new Error("Not a SubjectPublicKeyInfo");
  const key = header(keyAt);
  return spki.subarray(key.start + 1, key.start + key.size);
}

export interface ThrowawaySigner {
  /** The private key, which never leaves this page: it cannot be exported. */
  key: CryptoKey;
  /** The certificate, DER. */
  certificate: Uint8Array;
  /** The same, base64: what the PDF program takes in `certificates`. */
  certificateBase64: string;
  serialHex: string;
  /** The certificate's SHA-256, as `openssl x509 -fingerprint -sha256` prints it. */
  fingerprint: string;
  notBefore: string;
  notAfter: string;
}

const hex = (bytes: Uint8Array, separator = ""): string => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join(separator);

async function makeSigner(): Promise<ThrowawaySigner> {
  const pair = await crypto.subtle.generateKey({ ...RSA_SHA256, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) }, false, ["sign", "verify"]);
  const spki = new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));

  // A positive 16-byte serial: the top bit cleared so no sign byte is needed, never all zero.
  const serial = crypto.getRandomValues(new Uint8Array(16));
  serial[0] = (serial[0]! & 0x7f) | 0x01;

  // Valid from an hour ago, so a clock a little behind still accepts it, for a year.
  const notBefore = new Date(Math.floor(Date.now() / 1000) * 1000 - 60 * 60 * 1000);
  const notAfter = new Date(notBefore.getTime() + 365 * 24 * 60 * 60 * 1000);

  // AlgorithmIdentifier for sha256WithRSAEncryption: the OID with NULL parameters (RFC 4055).
  const signatureAlgorithm = sequence(oid(OID.sha256WithRSAEncryption), derNull());
  // The subject key identifier: the SHA-1 of the subjectPublicKey, RFC 5280's method (1).
  const keyId = new Uint8Array(await crypto.subtle.digest("SHA-1", subjectPublicKey(spki) as BufferSource));
  // Extension ::= SEQUENCE { extnID, critical BOOLEAN DEFAULT FALSE, extnValue OCTET STRING (the value's DER) }
  const extensions = explicit(
    3,
    sequence(
      // BasicConstraints CA:FALSE: an empty SEQUENCE, since cA defaults to FALSE.
      sequence(oid(OID.basicConstraints), octetString(sequence())),
      // KeyUsage, critical: digitalSignature (bit 0) and nonRepudiation (bit 1), so 0b11000000 with 6 unused bits.
      sequence(oid(OID.keyUsage), derTrue(), octetString(bitString(new Uint8Array([0xc0]), 6))),
      sequence(oid(OID.subjectKeyIdentifier), octetString(octetString(keyId)))
    )
  );
  const subject = name();
  // TBSCertificate: version v3 (2), serial, signature algorithm, issuer, validity, subject (the issuer: self-signed), key, extensions.
  const tbs = sequence(explicit(0, integer(new Uint8Array([2]))), integer(serial), signatureAlgorithm, subject, sequence(time(notBefore), time(notAfter)), subject, spki, extensions);
  const signature = new Uint8Array(await crypto.subtle.sign(RSA_SHA256, pair.privateKey, tbs as BufferSource));
  const certificate = sequence(tbs, signatureAlgorithm, bitString(signature));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", certificate as BufferSource));
  return {
    key: pair.privateKey,
    certificate,
    certificateBase64: toBase64(certificate),
    serialHex: hex(serial),
    fingerprint: hex(digest, ":").toUpperCase(),
    notBefore: notBefore.toISOString(),
    notAfter: notAfter.toISOString()
  };
}

let signer: Promise<ThrowawaySigner> | undefined;

/** Made once per page load, so the sign and verify endpoints agree on who signed; tried again after a failure. */
export function throwawaySigner(): Promise<ThrowawaySigner> {
  signer ??= makeSigner().catch((error: unknown) => {
    signer = undefined;
    throw error;
  });
  return signer;
}
