import { randomBytes } from "node:crypto";

// The kernel's DER module, reached by a path through node_modules/@argusvane/datum-pdf-kernel: that package exports only its root
// (the whole PDF program) and has no subpath export for der.ts, so this import bypasses its exports map and relies on
// the file: link layout (a deviation from the suite's other imports, which use package specifiers; a './signature/der'
// subpath export from the pdf-kernel owner would remove it). The host check wants just the reader and writer the PAdES
// timestamp code already uses (reused, never re-implemented).
import { NULL, boolean, children, integer, oid, octetString, read, readSmallInteger, sequence } from "../../../node_modules/@argusvane/datum-pdf-kernel/src/kernel/signature/der.js";

/**
 * The little DER the TSA cases need (the Java kit's Der.java): write an RFC 3161 TimeStampReq over a SHA-256 digest
 * with a nonce, read the PKIStatus of the TimeStampResp, find bytes in it, and check that a body is one DER element.
 * The writing and reading come from the PDF kernel's DER module. The token itself is not parsed further:
 * the Java contract looks for the digest and the nonce as byte strings in the reply, and so does this port.
 */
const SHA256_OID = "2.16.840.1.101.3.4.2.1";

/** A positive 63-bit nonce as the minimal big-endian bytes of BigInteger(63, random).toByteArray() (no leading zero byte unless the high bit needs one). */
export function randomNonce(): Uint8Array {
  const bytes = randomBytes(8);
  bytes[0] = (bytes[0] as number) & 0x7f;
  let start = 0;
  while (start < bytes.length - 1 && bytes[start] === 0) start += 1;
  const minimal = bytes.subarray(start);
  return (minimal[0] as number) & 0x80 ? Uint8Array.from([0, ...minimal]) : Uint8Array.from(minimal);
}

/** A version 1 TimeStampReq over a SHA-256 digest, with a nonce and certReq TRUE (what `openssl ts -query -sha256 -cert` sends). */
export function timeStampRequest(sha256: Uint8Array, nonce: Uint8Array): Uint8Array {
  const imprint = sequence(sequence(oid(SHA256_OID), NULL), octetString(sha256));
  return sequence(integer(1), imprint, integer(nonce), boolean(true));
}

/** The PKIStatus of a TimeStampResp (0 granted, 1 granted with modifications, 2 rejection, ...). Throws when the bytes are not one. */
export function pkiStatus(timeStampResp: Uint8Array): number {
  const outer = read(timeStampResp, 0);
  if (outer.end !== timeStampResp.length) throw new Error("bytes after the outermost element");
  const statusInfo = children(timeStampResp, outer)[0];
  const status = statusInfo === undefined ? undefined : children(timeStampResp, statusInfo)[0];
  if (status === undefined) throw new Error("no PKIStatusInfo in the TimeStampResp");
  return readSmallInteger(timeStampResp, status);
}

/** Whether `needle` occurs in `haystack`. */
export function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  return Buffer.from(haystack).includes(Buffer.from(needle));
}

/** The tag of the outermost element of `der`, which must be the whole of it (Der.parse(...).tag()). */
export function outermostTag(der: Uint8Array): number {
  const outer = read(der, 0);
  if (outer.end !== der.length) throw new Error("bytes after the outermost element");
  return outer.tag;
}
