/**
 * WOFF (1.0) to sfnt (TrueType or CFF-flavoured OpenType), in the browser and in Node, with
 * nothing but the platform's `DecompressionStream`. The kernel embeds TTF/OTF only (its program
 * carries no WOFF decoder, and WOFF2's brotli is stubbed out of the bundle), while design systems
 * ship their faces as WOFF for the browser, so the host's font reader converts on load
 * (`createFaceFontProvider`): a page and a server load the same bytes.
 *
 * Lossless: every table's bytes come out as the font's author wrote them (inflated where the
 * WOFF compressed them, copied where it did not), the directory is rebuilt as the sfnt spec lays
 * it out, and `head.checkSumAdjustment` is recomputed. WOFF2 is not read: it throws.
 */

const WOFF_SIGNATURE = 0x774f4646; // "wOFF"
const WOFF2_SIGNATURE = 0x774f4632; // "wOF2"
const SFNT_HEADER = 12;
const WOFF_HEADER = 44;
const WOFF_TABLE_ENTRY = 20;

function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** Whether the bytes start as a WOFF 1.0 file does. */
export function isWoff(bytes: Uint8Array): boolean {
  return bytes.length >= WOFF_HEADER && viewOf(bytes).getUint32(0) === WOFF_SIGNATURE;
}

/** Whether the bytes start as a WOFF2 file does (not readable here). */
export function isWoff2(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && viewOf(bytes).getUint32(0) === WOFF2_SIGNATURE;
}

/** A zlib stream inflated by the platform (WOFF compresses each table with zlib, not raw deflate). */
async function inflate(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** The sfnt checksum of a table: the sum of its big-endian uint32 words, zero-padded to a multiple of four. */
function checksum(bytes: Uint8Array): number {
  let sum = 0;
  const words = Math.ceil(bytes.length / 4);
  for (let index = 0; index < words; index += 1) {
    const offset = index * 4;
    const word = ((bytes[offset] ?? 0) << 24) | ((bytes[offset + 1] ?? 0) << 16) | ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);
    sum = (sum + (word >>> 0)) >>> 0;
  }
  return sum >>> 0;
}

/** The sfnt header's binary-search helpers, as the spec defines them from the table count. */
function searchFields(numTables: number): { searchRange: number; entrySelector: number; rangeShift: number } {
  let entrySelector = 0;
  while (1 << (entrySelector + 1) <= numTables) {
    entrySelector += 1;
  }
  const searchRange = (1 << entrySelector) * 16;
  return { searchRange, entrySelector, rangeShift: numTables * 16 - searchRange };
}

/**
 * The WOFF's tables as an sfnt file: the same flavour, the tables in tag order (the spec's
 * directory order), each 4-byte padded, `head.checkSumAdjustment` recomputed over the whole.
 * Throws on anything that is not a WOFF 1.0 file or whose tables do not inflate to their
 * declared length.
 */
export async function woffToSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  if (!isWoff(bytes)) {
    throw new Error(isWoff2(bytes) ? "WOFF2 is not supported: convert the face to WOFF 1.0, TTF or OTF" : "Not a WOFF 1.0 file");
  }
  const view = viewOf(bytes);
  const flavor = view.getUint32(4);
  const numTables = view.getUint16(12);
  if (bytes.length < WOFF_HEADER + numTables * WOFF_TABLE_ENTRY) {
    throw new Error("The WOFF table directory runs past the end of the file");
  }
  const tables: Array<{ tag: string; data: Uint8Array }> = [];
  for (let index = 0; index < numTables; index += 1) {
    const entry = WOFF_HEADER + index * WOFF_TABLE_ENTRY;
    const tag = String.fromCharCode(bytes[entry]!, bytes[entry + 1]!, bytes[entry + 2]!, bytes[entry + 3]!);
    const offset = view.getUint32(entry + 4);
    const compLength = view.getUint32(entry + 8);
    const origLength = view.getUint32(entry + 12);
    if (offset + compLength > bytes.length) {
      throw new Error(`WOFF table ${tag} runs past the end of the file`);
    }
    const stored = bytes.subarray(offset, offset + compLength);
    // A table the WOFF did not compress (its compressed length is its original length) is stored as is.
    // A table that is not a zlib stream fails in the platform's DecompressionStream, whose error text
    // differs between runtimes (empty on some), so the failure is named here.
    let data: Uint8Array;
    try {
      data = compLength === origLength ? new Uint8Array(stored) : await inflate(stored);
    } catch {
      throw new Error(`WOFF table ${tag}: does not inflate as zlib, expected ${origLength} bytes`);
    }
    if (data.length !== origLength) {
      throw new Error(`WOFF table ${tag}: inflated to ${data.length} bytes, expected ${origLength}`);
    }
    tables.push({ tag, data });
  }
  tables.sort((a, b) => (a.tag < b.tag ? -1 : a.tag > b.tag ? 1 : 0));
  let offset = SFNT_HEADER + tables.length * 16;
  const placed = tables.map((table) => {
    const at = offset;
    offset += Math.ceil(table.data.length / 4) * 4;
    return { ...table, offset: at };
  });
  const out = new Uint8Array(offset);
  const outView = viewOf(out);
  outView.setUint32(0, flavor);
  outView.setUint16(4, tables.length);
  const { searchRange, entrySelector, rangeShift } = searchFields(tables.length);
  outView.setUint16(6, searchRange);
  outView.setUint16(8, entrySelector);
  outView.setUint16(10, rangeShift);
  placed.forEach((table, index) => {
    const entry = SFNT_HEADER + index * 16;
    for (let char = 0; char < 4; char += 1) {
      out[entry + char] = table.tag.charCodeAt(char);
    }
    // The head table's own checksum is taken with its adjustment field zeroed, as the spec says.
    const forSum = table.tag === "head" ? Uint8Array.from(table.data).fill(0, 8, 12) : table.data;
    outView.setUint32(entry + 4, checksum(forSum));
    outView.setUint32(entry + 8, table.offset);
    outView.setUint32(entry + 12, table.data.length);
    out.set(table.data, table.offset);
  });
  const head = placed.find((table) => table.tag === "head");
  if (head) {
    outView.setUint32(head.offset + 8, 0);
    outView.setUint32(head.offset + 8, (0xb1b0afba - checksum(out)) >>> 0);
  }
  return out;
}

const TTC_SIGNATURE = 0x74746366; // "ttcf"

/** Whether the bytes start as a single TrueType or OpenType (CFF) font does; a collection is not one. */
export function isSfnt(bytes: Uint8Array): boolean {
  if (bytes.length < SFNT_HEADER) {
    return false;
  }
  const tag = viewOf(bytes).getUint32(0);
  return tag === 0x00010000 || tag === 0x4f54544f /* OTTO */ || tag === 0x74727565 /* true */;
}

/** Whether the bytes start as a TrueType collection (`.ttc`) does: several fonts the kernel cannot embed. */
export function isTtc(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && viewOf(bytes).getUint32(0) === TTC_SIGNATURE;
}

/**
 * The bytes as an sfnt the kernel can embed: a WOFF 1.0 file converted, TTF and OTF bytes passed
 * through. Anything else (an HTML error page a server answered with, WOFF2, a TrueType collection)
 * throws, so a caller hears about a face that is no single font instead of failing the document
 * later inside the kernel.
 */
export async function toSfnt(bytes: Uint8Array): Promise<Uint8Array> {
  if (isWoff(bytes) || isWoff2(bytes)) {
    return woffToSfnt(bytes);
  }
  if (isTtc(bytes)) {
    throw new Error("A TrueType collection (.ttc) is not supported: give one face as TTF, OTF or WOFF 1.0");
  }
  if (!isSfnt(bytes)) {
    throw new Error("Not a font file (expected TTF, OTF or WOFF 1.0)");
  }
  return bytes;
}
