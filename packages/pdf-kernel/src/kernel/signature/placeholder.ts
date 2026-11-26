/**
 * The bytes of a PDF signature (ISO 32000-2 §12.8.1): the `/ByteRange` and
 * `/Contents` placeholders written into the signature dictionary, where they land in the
 * saved file, the digest over everything but `/Contents`, and the hex the CMS goes back in
 * as. Widths never change, so nothing else in the file moves: the cross-reference written
 * before the patch stays right.
 */
import { PDFHexString, PDFInvalidObject } from "@cantoo/pdf-lib";
import { PdfKernelError } from "@argusvane/datum-engine/render";
import { Sha256 } from "../util/sha256.js";
import { toHex } from "./der.js";

/** 36 bytes: `[0 a b c]` with room for ten-digit offsets (files to ten gigabytes). */
export const BYTE_RANGE_PLACEHOLDER = "[0 0000000000 0000000000 0000000000]";

const BYTE_RANGE_NEEDLE = ascii(`/ByteRange ${BYTE_RANGE_PLACEHOLDER}`);
const CONTENTS_NEEDLE = ascii("/Contents <");
const ENDOBJ_NEEDLE = ascii("endobj");

export const MIN_PLACEHOLDER_BYTES = 8192;
export const MAX_PLACEHOLDER_BYTES = 65536;
/** What an RFC 3161 token needs on top of the signature: its own SignedData with the TSA's certificate. */
const TIMESTAMP_RESERVE = 8192;

export type ByteRange = [number, number, number, number];

function ascii(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i += 1) {
    out[i] = text.charCodeAt(i) & 0xff;
  }
  return out;
}

export function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const first = needle[0]!;
  const last = haystack.length - needle.length;
  outer: for (let i = Math.max(0, from); i <= last; i += 1) {
    if (haystack[i] !== first) {
      continue;
    }
    for (let j = 1; j < needle.length; j += 1) {
      if (haystack[i + j] !== needle[j]) {
        continue outer;
      }
    }
    return i;
  }
  return -1;
}

/**
 * How many bytes `/Contents` reserves: room for the certificates, the signature and the
 * attributes, a token when one is expected, rounded up to a kilobyte, never under 8 KiB
 * nor over 64 KiB. An explicit ask is honoured when the certificates fit in it.
 */
export function placeholderBytes(certificates: readonly Uint8Array[], asked: number | undefined, timestamp: boolean): number {
  let total = 0;
  for (const certificate of certificates) {
    total += certificate.length;
  }
  if (asked !== undefined) {
    if (!Number.isInteger(asked) || asked <= 0 || asked > MAX_PLACEHOLDER_BYTES) {
      throw new PdfKernelError("signature", `placeholderBytes must be a whole number of bytes up to ${MAX_PLACEHOLDER_BYTES}`);
    }
    if (asked < total + 1024) {
      throw new PdfKernelError("signature", `placeholderBytes (${asked}) leaves no room for the signature beside ${total} bytes of certificates`);
    }
    return asked;
  }
  const needed = total + 2048 + (timestamp ? TIMESTAMP_RESERVE : 0);
  return Math.min(MAX_PLACEHOLDER_BYTES, Math.max(MIN_PLACEHOLDER_BYTES, Math.ceil(needed / 1024) * 1024));
}

/** The two placeholder objects, written into the signature dictionary in this order. */
export function placeholderObjects(capacity: number): { ByteRange: PDFInvalidObject; Contents: PDFHexString } {
  return {
    ByteRange: PDFInvalidObject.of(ascii(BYTE_RANGE_PLACEHOLDER)),
    Contents: PDFHexString.of("0".repeat(capacity * 2))
  };
}

export interface LocatedPlaceholder {
  /** Where `[` of the ByteRange array sits. */
  byteRangeAt: number;
  /** Where `<` sits. */
  contentsStart: number;
  /** Just past `>`. */
  contentsEnd: number;
  /** Hex digits between the brackets. */
  hexLength: number;
}

/**
 * The placeholder the last save wrote, looked for from `from` on (the original bytes of an
 * incremental update are never scanned: an earlier signature's array holds real numbers by
 * now, and a placeholder left there was refused before signing).
 */
export function locatePlaceholder(bytes: Uint8Array, from: number): LocatedPlaceholder {
  const at = indexOfBytes(bytes, BYTE_RANGE_NEEDLE, from);
  if (at < 0) {
    throw new PdfKernelError("signature", "The saved file carries no signature placeholder");
  }
  if (indexOfBytes(bytes, BYTE_RANGE_NEEDLE, at + 1) >= 0) {
    throw new PdfKernelError("signature", "The saved file carries more than one signature placeholder");
  }
  const byteRangeAt = at + BYTE_RANGE_NEEDLE.length - BYTE_RANGE_PLACEHOLDER.length;
  const endobj = indexOfBytes(bytes, ENDOBJ_NEEDLE, at);
  const contentsKey = indexOfBytes(bytes, CONTENTS_NEEDLE, at);
  if (contentsKey < 0 || (endobj >= 0 && contentsKey > endobj)) {
    throw new PdfKernelError("signature", "The signature dictionary has no /Contents beside its /ByteRange");
  }
  const contentsStart = contentsKey + CONTENTS_NEEDLE.length - 1;
  let close = contentsStart + 1;
  while (close < bytes.length && bytes[close] !== 0x3e) {
    close += 1;
  }
  if (close >= bytes.length) {
    throw new PdfKernelError("signature", "The /Contents placeholder is not closed");
  }
  return { byteRangeAt, contentsStart, contentsEnd: close + 1, hexLength: close - contentsStart - 1 };
}

/** Writes `[0 a b c]` over the placeholder, padded with spaces to its width. */
export function patchByteRange(bytes: Uint8Array, at: number, range: ByteRange): void {
  const text = `[0 ${range[1]} ${range[2]} ${range[3]}]`;
  if (text.length > BYTE_RANGE_PLACEHOLDER.length) {
    throw new PdfKernelError("signature", "The file is too large for a ten-digit byte range");
  }
  bytes.set(ascii(text.padEnd(BYTE_RANGE_PLACEHOLDER.length, " ")), at);
}

export interface UnfilledSignature extends LocatedPlaceholder {
  byteRange: ByteRange;
}

/**
 * The one signature whose `/Contents` is still all zeros — a file `sign` prepared and no one
 * completed. Every `/ByteRange [0 ` in the file is read; the range must land on the hex
 * string, which must be blank.
 */
export function locateUnfilled(bytes: Uint8Array): UnfilledSignature | undefined {
  const key = ascii("/ByteRange [");
  const found: UnfilledSignature[] = [];
  let at = indexOfBytes(bytes, key, 0);
  while (at >= 0) {
    const arrayAt = at + key.length - 1;
    const close = indexOfBytes(bytes, ascii("]"), arrayAt);
    if (close >= 0 && close - arrayAt < 64) {
      const text = String.fromCharCode(...bytes.subarray(arrayAt + 1, close));
      const numbers = text.trim().split(/\s+/).map((part) => Number(part));
      if (numbers.length === 4 && numbers.every((n) => Number.isInteger(n) && n >= 0) && numbers[0] === 0) {
        const range = numbers as ByteRange;
        const [, start, end] = range;
        if (end > start && end <= bytes.length && bytes[start] === 0x3c && bytes[end - 1] === 0x3e && blankHex(bytes, start + 1, end - 1)) {
          found.push({ byteRange: range, byteRangeAt: arrayAt, contentsStart: start, contentsEnd: end, hexLength: end - start - 2 });
        }
      }
    }
    at = indexOfBytes(bytes, key, at + 1);
  }
  if (found.length > 1) {
    throw new PdfKernelError("signature", "The file carries more than one unfinished signature");
  }
  return found[0];
}

function blankHex(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    if (bytes[i] !== 0x30) {
      return false;
    }
  }
  return to > from;
}

/** SHA-256 over the two spans the range names. */
export function digestOverRanges(bytes: Uint8Array, range: ByteRange): Uint8Array {
  const [start0, length0, start1, length1] = range;
  return new Sha256().update(bytes.subarray(start0, start0 + length0)).update(bytes.subarray(start1, start1 + length1)).digest();
}

/** Whether the range is the ISO 32000-2 / PAdES shape: from 0, around the hex string, to `length` at most. */
export function rangeIsWellFormed(bytes: Uint8Array, range: ByteRange): boolean {
  const [start0, length0, start1, length1] = range;
  return start0 === 0 && length0 < start1 && start1 + length1 <= bytes.length && bytes[length0] === 0x3c && bytes[start1 - 1] === 0x3e;
}

/** The CMS, hex, into the placeholder; zeros fill what is left. */
export function writeContents(bytes: Uint8Array, located: LocatedPlaceholder, cms: Uint8Array): void {
  const hex = toHex(cms);
  if (hex.length > located.hexLength) {
    throw new PdfKernelError("signature", `The signature (${cms.length} bytes) does not fit the ${located.hexLength / 2}-byte placeholder; prepare it again with a larger placeholderBytes`);
  }
  bytes.set(ascii(hex.padEnd(located.hexLength, "0")), located.contentsStart + 1);
}
