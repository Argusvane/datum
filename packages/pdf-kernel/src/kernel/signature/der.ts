/**
 * DER (X.690) — the little the kernel needs to write a CMS `SignedData` and read a
 * certificate or a timestamp token back. An encoder for the handful of types a
 * signature uses, a TLV reader that never recurses on its own, and the SET OF ordering rule.
 * No library: the sandbox has no `crypto`, `Date` or `Buffer`, and the program budget has no
 * room for pkijs.
 */
import { PdfKernelError } from "@argusvane/datum-engine/render";

export const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  /** ESS `signingCertificate` (RFC 2634): an ESSCertID, the certificate's SHA-1. Older TSAs still write it. */
  signingCertificate: "1.2.840.113549.1.9.16.2.12",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  /** CAdES `commitment-type-indication` (ETSI EN 319 122-1 §5.2.3): what the signer meant by signing. */
  commitmentType: "1.2.840.113549.1.9.16.2.16",
  proofOfOrigin: "0.4.0.1733.2.1",
  proofOfReceipt: "0.4.0.1733.2.2",
  proofOfDelivery: "0.4.0.1733.2.3",
  proofOfSender: "0.4.0.1733.2.4",
  proofOfApproval: "0.4.0.1733.2.5",
  proofOfCreation: "0.4.0.1733.2.6",
  /** Datum's commitment-type qualifier: the statement the signer typed, UTF8String (a UUID-based arc, ITU-T X.667). */
  datumStatement: "2.25.205113798666900692560415870500066909807",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  sha1: "1.3.14.3.2.26",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  rsassaPss: "1.2.840.113549.1.1.10",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
  ecdsaWithSHA384: "1.2.840.10045.4.3.3",
  prime256v1: "1.2.840.10045.3.1.7",
  secp384r1: "1.3.132.0.34",
  secp521r1: "1.3.132.0.35",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  organizationalUnit: "2.5.4.11",
  country: "2.5.4.6",
  locality: "2.5.4.7",
  state: "2.5.4.8",
  serialNumberAttribute: "2.5.4.5",
  emailAddress: "1.2.840.113549.1.9.1",
  subjectKeyIdentifier: "2.5.29.14",
  keyUsage: "2.5.29.15",
  basicConstraints: "2.5.29.19"
} as const;

export const TAG = {
  integer: 0x02,
  bitString: 0x03,
  octetString: 0x04,
  null: 0x05,
  oid: 0x06,
  utf8String: 0x0c,
  printableString: 0x13,
  ia5String: 0x16,
  utcTime: 0x17,
  generalizedTime: 0x18,
  sequence: 0x30,
  set: 0x31
} as const;

/** Nesting a reader accepts before calling the input hostile. */
export const MAX_DEPTH = 32;

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  let length = 0;
  for (const part of parts) {
    length += part.length;
  }
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function lengthBytes(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  if (length < 0x100) {
    return new Uint8Array([0x81, length]);
  }
  if (length < 0x10000) {
    return new Uint8Array([0x82, length >>> 8, length & 0xff]);
  }
  if (length < 0x1000000) {
    return new Uint8Array([0x83, length >>> 16, (length >>> 8) & 0xff, length & 0xff]);
  }
  return new Uint8Array([0x84, length >>> 24, (length >>> 16) & 0xff, (length >>> 8) & 0xff, length & 0xff]);
}

/** One tag-length-value: the tag byte, the definite length, the content. */
export function tlv(tag: number, content: Uint8Array | readonly Uint8Array[]): Uint8Array {
  // `ArrayBuffer.isView`, not `instanceof`: a `TextEncoder` from another realm (a test DOM over Node) hands back a Uint8Array `instanceof` would not recognise.
  const body = ArrayBuffer.isView(content) ? (content as Uint8Array) : concat(content);
  return concat([new Uint8Array([tag]), lengthBytes(body.length), body]);
}

export function sequence(...parts: Uint8Array[]): Uint8Array {
  return tlv(TAG.sequence, parts);
}

/**
 * X.690 §11.6: the elements of a SET OF are sorted by their encodings, compared as octet
 * strings with the shorter one padded with zeros. Every CMS attribute starts with the same
 * OID prefix, so the length byte decides — sort by the whole encoding, never by OID.
 */
export function compareEncodings(a: Uint8Array, b: Uint8Array): number {
  const length = Math.max(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = i < a.length ? a[i]! : 0;
    const y = i < b.length ? b[i]! : 0;
    if (x !== y) {
      return x - y;
    }
  }
  return 0;
}

export function setOf(elements: readonly Uint8Array[]): Uint8Array {
  return tlv(TAG.set, [...elements].sort(compareEncodings));
}

/** `[n] IMPLICIT`: the inner encoding with its tag replaced by the context tag. */
export function implicit(n: number, inner: Uint8Array, constructed = true): Uint8Array {
  const out = new Uint8Array(inner);
  out[0] = (constructed ? 0xa0 : 0x80) | n;
  return out;
}

/** `[n] EXPLICIT`: the inner encoding wrapped in a constructed context tag. */
export function explicit(n: number, inner: Uint8Array): Uint8Array {
  return tlv(0xa0 | n, inner);
}

/** An INTEGER: a non-negative number, or a big-endian magnitude (a serial, an ECDSA r or s). */
export function integer(value: number | Uint8Array): Uint8Array {
  let magnitude: Uint8Array;
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 0) {
      throw new Error("der: integer must be a non-negative whole number");
    }
    const digits: number[] = [];
    let rest = value;
    do {
      digits.unshift(rest % 256);
      rest = Math.floor(rest / 256);
    } while (rest > 0);
    magnitude = new Uint8Array(digits);
  } else {
    let start = 0;
    while (start < value.length - 1 && value[start] === 0) {
      start += 1;
    }
    magnitude = value.subarray(start);
  }
  if (magnitude.length === 0) {
    magnitude = new Uint8Array([0]);
  }
  const body = magnitude[0]! & 0x80 ? concat([new Uint8Array([0]), magnitude]) : magnitude;
  return tlv(TAG.integer, body);
}

/** Sub-identifiers are unbounded (a `2.25.<uuid>` arc is 128 bits), so they are handled as BigInt. */
export function oid(dotted: string): Uint8Array {
  const texts = dotted.split(".");
  if (texts.length < 2 || texts.some((part) => !/^\d+$/.test(part))) {
    throw new Error(`der: bad object identifier "${dotted}"`);
  }
  const parts = texts.map((part) => BigInt(part));
  const first = parts[0]! * 40n + parts[1]!;
  if (first > 0x7fn && parts[0]! < 2n) {
    throw new Error(`der: bad object identifier "${dotted}"`);
  }
  const bytes: number[] = [];
  for (const part of [first, ...parts.slice(2)]) {
    const chunk: number[] = [Number(part & 0x7fn)];
    let rest = part >> 7n;
    while (rest > 0n) {
      chunk.unshift(Number(rest & 0x7fn) | 0x80);
      rest >>= 7n;
    }
    bytes.push(...chunk);
  }
  return tlv(TAG.oid, new Uint8Array(bytes));
}

export function octetString(bytes: Uint8Array): Uint8Array {
  return tlv(TAG.octetString, bytes);
}

export const NULL: Uint8Array = new Uint8Array([TAG.null, 0]);

export function boolean(value: boolean): Uint8Array {
  return new Uint8Array([0x01, 1, value ? 0xff : 0]);
}

export function utf8String(text: string): Uint8Array {
  return tlv(TAG.utf8String, new TextEncoder().encode(text));
}

/** The date part of an ISO instant as X.680 time: UTCTime up to 2049, GeneralizedTime after. */
export function time(iso: string): Uint8Array {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) {
    throw new PdfKernelError("signature", `The instant "${iso}" is not an ISO 8601 date-time`);
  }
  const [, year, month, day, hour, minute, second] = match;
  const encoder = new TextEncoder();
  if (Number(year) < 2050) {
    return tlv(TAG.utcTime, encoder.encode(`${year!.slice(2)}${month}${day}${hour}${minute}${second}Z`));
  }
  return tlv(TAG.generalizedTime, encoder.encode(`${year}${month}${day}${hour}${minute}${second}Z`));
}

export interface Tlv {
  tag: number;
  /** Where the content starts. */
  start: number;
  /** Where the content ends (exclusive). */
  end: number;
  /** Where the tag byte sits. */
  headerStart: number;
}

function fail(message: string): never {
  throw new PdfKernelError("signature", `Malformed DER: ${message}`);
}

/** Reads one TLV at `at`; definite lengths only, and never past the buffer. */
export function read(bytes: Uint8Array, at: number): Tlv {
  if (at + 2 > bytes.length) {
    fail("truncated header");
  }
  const tag = bytes[at]!;
  if ((tag & 0x1f) === 0x1f) {
    fail("multi-byte tags are not supported");
  }
  let cursor = at + 1;
  let length = bytes[cursor]!;
  cursor += 1;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4) {
      fail("indefinite or oversized length");
    }
    if (cursor + count > bytes.length) {
      fail("truncated length");
    }
    length = 0;
    for (let i = 0; i < count; i += 1) {
      length = length * 256 + bytes[cursor + i]!;
    }
    cursor += count;
  }
  if (cursor + length > bytes.length) {
    fail("length past the end of the data");
  }
  return { tag, start: cursor, end: cursor + length, headerStart: at };
}

/** The TLVs inside a constructed node, in order; `depth` guards against a nesting bomb. */
export function children(bytes: Uint8Array, node: Tlv, depth = 0): Tlv[] {
  if (depth > MAX_DEPTH) {
    fail("nesting too deep");
  }
  const out: Tlv[] = [];
  let cursor = node.start;
  while (cursor < node.end) {
    const child = read(bytes, cursor);
    if (child.end > node.end) {
      fail("child past its parent");
    }
    out.push(child);
    cursor = child.end;
  }
  return out;
}

/** The whole encoding of a node, header included. */
export function raw(bytes: Uint8Array, node: Tlv): Uint8Array {
  return bytes.subarray(node.headerStart, node.end);
}

export function content(bytes: Uint8Array, node: Tlv): Uint8Array {
  return bytes.subarray(node.start, node.end);
}

export function expect(node: Tlv, tag: number, what: string): Tlv {
  if (node.tag !== tag) {
    fail(`expected ${what} (tag 0x${tag.toString(16)}), found tag 0x${node.tag.toString(16)}`);
  }
  return node;
}

export function readOid(bytes: Uint8Array, node: Tlv): string {
  expect(node, TAG.oid, "an object identifier");
  const body = content(bytes, node);
  if (body.length === 0) {
    fail("empty object identifier");
  }
  // The first sub-identifier may itself run past one byte (arc 2 with a large third node).
  const parts: string[] = [];
  let value = 0n;
  let first = true;
  for (let i = 0; i < body.length; i += 1) {
    value = value * 128n + BigInt(body[i]! & 0x7f);
    if ((body[i]! & 0x80) === 0) {
      if (first) {
        first = false;
        if (value < 80n) {
          parts.push(String(value / 40n), String(value % 40n));
        } else {
          parts.push("2", String(value - 80n));
        }
      } else {
        parts.push(String(value));
      }
      value = 0n;
    }
  }
  return parts.join(".");
}

/** A UTCTime or GeneralizedTime as an ISO instant (`YYYY-MM-DDTHH:MM:SSZ`); fractions dropped. */
export function readTime(bytes: Uint8Array, node: Tlv): string {
  const text = latin1(content(bytes, node));
  if (node.tag === TAG.utcTime) {
    const match = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(text);
    if (!match) {
      fail(`UTCTime "${text}"`);
    }
    const year = Number(match[1]) < 50 ? `20${match[1]}` : `19${match[1]}`;
    return `${year}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}Z`;
  }
  if (node.tag === TAG.generalizedTime) {
    const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:[.,]\d+)?Z$/.exec(text);
    if (!match) {
      fail(`GeneralizedTime "${text}"`);
    }
    return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6] ?? "00"}Z`;
  }
  return fail("expected a time");
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) {
    text += String.fromCharCode(bytes[i]!);
  }
  return text;
}

/** A directory string of any of the usual tags, as text. */
export function readString(bytes: Uint8Array, node: Tlv): string {
  const body = content(bytes, node);
  switch (node.tag) {
    case TAG.utf8String:
      return new TextDecoder().decode(body);
    case 0x1e: {
      let text = "";
      for (let i = 0; i + 1 < body.length; i += 2) {
        text += String.fromCharCode((body[i]! << 8) | body[i + 1]!);
      }
      return text;
    }
    case TAG.printableString:
    case TAG.ia5String:
    case 0x14:
    case 0x1a:
    case 0x1b:
    case 0x1c:
      return latin1(body);
    default:
      return toHex(body);
  }
}

/** The magnitude of an INTEGER (the leading sign byte dropped). */
export function readIntegerBytes(bytes: Uint8Array, node: Tlv): Uint8Array {
  expect(node, TAG.integer, "an integer");
  const body = content(bytes, node);
  return body.length > 1 && body[0] === 0 ? body.subarray(1) : body;
}

export function readSmallInteger(bytes: Uint8Array, node: Tlv): number {
  const body = readIntegerBytes(bytes, node);
  if (body.length > 6) {
    fail("integer too large");
  }
  let value = 0;
  for (const byte of body) {
    value = value * 256 + byte;
  }
  return value;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function toHex(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 1) {
    text += bytes[i]!.toString(16).padStart(2, "0");
  }
  return text;
}

export function fromHex(text: string): Uint8Array {
  const clean = text.replace(/\s+/g, "");
  const out = new Uint8Array(Math.ceil(clean.length / 2));
  for (let i = 0; i < out.length; i += 1) {
    const pair = clean.slice(i * 2, i * 2 + 2).padEnd(2, "0");
    const value = parseInt(pair, 16);
    if (Number.isNaN(value)) {
      throw new PdfKernelError("signature", "Bad hexadecimal text");
    }
    out[i] = value;
  }
  return out;
}
