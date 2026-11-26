/**
 * What changed after a signature: given a signed PDF and where the revision one
 * signature covers ends, the objects the later incremental revisions added, changed or freed,
 * each classified by what it is, and whether a DocMDP certification with given permissions
 * allows every one of them (ISO 32000-1 §12.8.2.2, with PAdES's DSS additions allowed under
 * any permissions).
 *
 * Both revisions are read the way a reader reads a file, never by scanning its text: the last
 * `startxref` in the final kilobyte names the newest cross-reference section (a table, a
 * cross-reference stream, or a table with a hybrid `/XRefStm`), `/Prev` leads to the older
 * ones, the newest entry for an object number wins, and an object is parsed at the offset its
 * entry gives or from the object stream slot it names. The trailer is the newest section's.
 * A loop, an offset outside the file, an entry that points at no object, a stream whose
 * `/Length` does not reach `endstream` or a chain longer than any real file has throws: the
 * caller reports the signature's later revisions as undecidable, never as a partial answer.
 *
 * The signed revision is the file's bytes up to the signature's end, read from its own
 * `startxref`. An object number that resolves to the same place in both revisions is unchanged
 * by construction; one that resolves elsewhere is compared by a canonical form (dictionaries
 * with sorted keys, strings as bytes, streams as their dictionary without `/Length` and a
 * SHA-256 of their bytes). Only objects the later document reaches from its trailer count.
 *
 * Roles (page, annotation, field, widget, the lists that hold them) are taken from the signed
 * revision for every object that existed there; only objects new in an update take a role from
 * the later structure, and a stream never has one. So an update cannot make an existing
 * object, a page's content say, pass for something form filling may change.
 */
import { PDFArray, PDFContext, PDFDict, PDFHexString, PDFName, PDFNumber, PDFObjectParser, PDFRawStream, PDFRef, PDFStream, PDFString, decodePDFRawStream, type PDFObject } from "@cantoo/pdf-lib";
import { PdfKernelError } from "@argusvane/datum-engine/render";
import { sha256 } from "../util/sha256.js";
import { parseSignedData, digestFor } from "./cms.js";
import { OID, bytesEqual, concat, fromHex, toHex } from "./der.js";

export type LaterChangeKind =
  | "signature-dictionary" // this signature's own dictionary redefined (never permitted)
  | "signature-field" // another signature: a new /Sig dict, its widget, its field
  | "field-value" // a form field's /V (or a widget's /AS, /AP for a filled field) changed
  | "annotation" // a non-widget annotation added, removed or changed
  | "acroform" // the AcroForm dictionary changed (fields added for a new signature, /SigFlags, /DA…)
  | "page-annots" // a page's /Annots list changed (widgets added for signing or annotations)
  | "info" // the Info dictionary
  | "dss" // /DSS and what it references (PAdES LTV)
  | "other"; // anything else: page content, catalog beyond AcroForm/DSS, fonts…

export interface LaterChange {
  ref: string;
  kind: LaterChangeKind;
  detail?: string;
}

export interface LaterRevisionsReport {
  /** How many cross-reference sections of the file's chain sit after the signed end. */
  revisions: number;
  changes: LaterChange[];
  /** Whether a DocMDP certification with these permissions allows every change; null for an approval signature (no permissions given). */
  permitted: boolean | null;
  /**
   * The later signatures the classification relied on to call a new signature field signing.
   * The kernel checks that each one's CMS digests exactly the revision it closes, but not the
   * signature value (that is the host's crypto): a certification is intact only if every
   * signature listed here is itself valid.
   */
  reliedOnSignatures: ReliedOnSignature[];
}

export interface ReliedOnSignature {
  ref: string;
  byteRange: [number, number, number, number];
  contentsHex: string;
}

export type DocMdpPermissionName = "noChanges" | "formFilling" | "annotations";

export interface LaterRevisionsOptions {
  permissions?: DocMdpPermissionName;
  /** The signature's `/Contents` as hex, as the file holds it (whitespace and case do not matter). */
  signatureContentsHex?: string;
  /** The signature field's full name, parts joined with dots. */
  fieldName?: string;
}

/**
 * What each DocMDP permission level allows (ISO 32000-1 §12.8.2.2, ETSI EN 319 142-1 §5.4):
 *
 * | kind                 | P=1 | P=2 | P=3 |
 * | -------------------- | --- | --- | --- |
 * | field-value          | no  | yes | yes |
 * | signature-field      | no  | yes | yes |
 * | acroform             | no  | yes | yes |
 * | page-annots          | no  | yes | yes |
 * | dss                  | no  | yes | yes |
 * | annotation           | no  | no  | yes |
 * | signature-dictionary | no  | no  | no  |
 * | info                 | no  | no  | no  |
 * | other                | no  | no  | no  |
 *
 * P=1 allows no change at all, so even a DSS added later breaks it here; a host that wants to
 * treat LTV material under P=1 differently can look at the kinds itself. `info` is
 * deliberately never allowed: Acrobat reports an Info dictionary (or XMP metadata) changed
 * after certification as a disallowed change under P=2 and P=3.
 */
const FORM_FILLING_KINDS: ReadonlySet<LaterChangeKind> = new Set(["field-value", "signature-field", "acroform", "page-annots", "dss"]);
const ANNOTATION_KINDS: ReadonlySet<LaterChangeKind> = new Set([...FORM_FILLING_KINDS, "annotation"]);

export function permittedUnder(changes: readonly LaterChange[], permissions: DocMdpPermissionName | undefined): boolean | null {
  if (permissions === undefined) {
    return null;
  }
  if (permissions === "noChanges") {
    return changes.length === 0;
  }
  const allowed = permissions === "formFilling" ? FORM_FILLING_KINDS : ANNOTATION_KINDS;
  return changes.every((change) => allowed.has(change.kind));
}

/** Past this many nested inline values an object is compared by pdf-lib's own text. */
const MAX_DEPTH = 64;
/** Cross-reference sections and entries past any real file: the chain is refused. */
const MAX_SECTIONS = 4096;
const MAX_ENTRIES = 2_000_000;
/** Readers look for `startxref` in the file's last kilobyte. */
const STARTXREF_WINDOW = 1024;

/** What a widget or field may change under form filling, and only with a new value for appearance keys. */
const FIELD_VALUE_KEYS = new Set(["V", "DV", "I"]);
const FIELD_APPEARANCE_KEYS = new Set(["AS", "AP", "MK"]);
/** What signing an empty signature field changes on it. */
const SIGNATURE_FIELD_KEYS = new Set(["V", "AP", "AS", "TU", "Contents", "M", "MK", "DA"]);
/** What a signature field or widget new in an update may carry: no actions. */
const NEW_SIGNATURE_FIELD_KEYS = new Set(["Type", "Subtype", "FT", "T", "TU", "Contents", "M", "V", "Rect", "P", "F", "AP", "AS", "MK", "DA", "Parent", "Kids", "Lock", "SV", "Ff"]);
/** What the AcroForm dictionary may change for form filling and signing. */
const ACROFORM_KEYS = new Set(["Fields", "SigFlags", "DA", "DR", "NeedAppearances"]);
const ACTION_KEYS = ["A", "AA"];

export async function analyzeLaterRevisions(bytes: Uint8Array, signedEnd: number, options: LaterRevisionsOptions = {}): Promise<LaterRevisionsReport> {
  if (!Number.isInteger(signedEnd) || signedEnd <= 0 || signedEnd > bytes.length) {
    throw new PdfKernelError("signature", `The signed revision's end (${signedEnd}) is not inside the file`);
  }
  const finish = (revisions: number, changes: LaterChange[], reliedOnSignatures: ReliedOnSignature[] = []): LaterRevisionsReport => ({
    revisions,
    changes,
    permitted: permittedUnder(changes, options.permissions),
    reliedOnSignatures
  });
  if (isBlank(bytes, signedEnd, bytes.length)) {
    return finish(0, []);
  }
  const signed = readRevision(bytes, signedEnd, "signed revision");
  const full = readRevision(bytes, bytes.length, "file");
  if (signed.trailer.has(PDFName.of("Encrypt")) || full.trailer.has(PDFName.of("Encrypt"))) {
    throw new PdfKernelError("signature", "An encrypted document's later revisions are not read");
  }
  const revisions = full.sections.filter((offset) => offset >= signedEnd).length;
  const analysis = new Analysis(bytes, signed, full, options);
  const changes = analysis.run();
  return finish(revisions, changes, analysis.reliedOn());
}

function isBlank(bytes: Uint8Array, from: number, to: number): boolean {
  for (let i = from; i < to; i += 1) {
    const code = bytes[i]!;
    if (code !== 0x20 && code !== 0x0a && code !== 0x0d && code !== 0x09 && code !== 0x0c) {
      return false;
    }
  }
  return true;
}

function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let i = 0; i < bytes.length; i += 8192) {
    text += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return text;
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

const STREAM_KEYWORD = ascii("stream");

/** A `/Length` that must be written as a number: cross-reference streams, trailers, object streams' contents. */
function directLength(value: PDFObject | undefined): number | undefined {
  return value instanceof PDFNumber ? value.asNumber() : undefined;
}
const ENDSTREAM_KEYWORD = ascii("endstream");

function fail(where: string, message: string): never {
  throw new PdfKernelError("signature", `The ${where} cannot be read as a reader would: ${message}`);
}

// ---------------------------------------------------------------------------------------------
// Reading a revision

type ByteStreamOf = ConstructorParameters<typeof PDFObjectParser>[0];

/**
 * pdf-lib's object parser, except that a stream is exactly as long as its `/Length` says
 * (an indirect length resolved in the revision) and must end with `endstream` there; pdf-lib
 * would otherwise search for the keyword, which no reader does.
 */
class RevisionParser extends PDFObjectParser {
  private constructor(
    stream: ByteStreamOf,
    context: PDFContext,
    private readonly size: number,
    private readonly lengthOf: (value: PDFObject | undefined) => number | undefined
  ) {
    super(stream, context);
  }

  static over(data: Uint8Array, context: PDFContext, lengthOf: (value: PDFObject | undefined) => number | undefined): RevisionParser {
    const base = PDFObjectParser.forBytes(data, context) as unknown as { bytes: ByteStreamOf };
    return new RevisionParser(base.bytes, context, data.length, lengthOf);
  }

  protected override parseDictOrStream(ref?: PDFRef): PDFDict | PDFStream {
    const dict = this.parseDict(ref);
    const after = this.bytes.offset();
    this.skipWhitespaceAndComments();
    if (!this.matchKeyword(STREAM_KEYWORD)) {
      this.bytes.moveTo(after);
      return dict;
    }
    if (!this.bytes.done() && this.bytes.peek() === 0x0d) {
      this.bytes.next();
    }
    if (!this.bytes.done() && this.bytes.peek() === 0x0a) {
      this.bytes.next();
    }
    const start = this.bytes.offset();
    const length = this.lengthOf(dict.get(PDFName.of("Length")));
    if (length === undefined || !Number.isInteger(length) || length < 0 || start + length > this.size) {
      throw new Error("a stream's /Length is missing or runs past the data");
    }
    this.bytes.moveTo(start + length);
    this.skipWhitespace();
    if (!this.matchKeyword(ENDSTREAM_KEYWORD)) {
      throw new Error("a stream's /Length does not end at endstream");
    }
    return PDFRawStream.of(dict, this.bytes.slice(start, start + length));
  }
}

type XrefEntry =
  | { kind: "free"; generation: number; section: number }
  | { kind: "offset"; generation: number; offset: number; section: number }
  | { kind: "stream"; stream: number; index: number; section: number };

interface ObjectStream {
  data: Uint8Array;
  first: number;
  slots: Array<[number, number]>;
}

/** One revision as a reader resolves it: the cross-reference chain from its own `startxref`. */
class Revision {
  readonly entries = new Map<number, XrefEntry>();
  /** Section offsets, newest first. */
  readonly sections: number[] = [];
  /** Every entry each section lists, newest or not: what that revision wrote. */
  readonly sectionEntries = new Map<number, Array<[number, XrefEntry]>>();
  trailer!: PDFDict;
  readonly context = PDFContext.create();
  /** Streams whose `/Length` is another object: their parse depends on it. */
  readonly lengthDependencies = new Map<PDFRef, PDFRef>();
  private readonly cache = new Map<PDFRef, PDFObject | null>();
  private readonly resolving = new Set<PDFRef>();
  private readonly objectStreams = new Map<number, ObjectStream>();
  private entryCount = 0;

  constructor(
    readonly data: Uint8Array,
    readonly where: string
  ) {}

  get root(): PDFRef | undefined {
    const root = this.trailer.get(PDFName.of("Root"));
    return root instanceof PDFRef ? root : undefined;
  }

  get info(): PDFObject | undefined {
    return this.trailer.get(PDFName.of("Info"));
  }

  get encrypt(): PDFObject | undefined {
    return this.trailer.get(PDFName.of("Encrypt"));
  }

  readChain(): void {
    const head = this.startxref();
    const seen = new Set<number>();
    let offset: number | undefined = head;
    while (offset !== undefined) {
      if (seen.has(offset)) {
        fail(this.where, `the cross-reference chain loops at offset ${offset}`);
      }
      if (seen.size >= MAX_SECTIONS) {
        fail(this.where, `more than ${MAX_SECTIONS} cross-reference sections`);
      }
      seen.add(offset);
      this.sections.push(offset);
      const trailer = this.readSection(offset);
      if (this.sections.length === 1) {
        this.trailer = trailer;
      }
      const prev = trailer.get(PDFName.of("Prev"));
      offset = prev instanceof PDFNumber ? prev.asNumber() : undefined;
      if (prev !== undefined && !(prev instanceof PDFNumber)) {
        fail(this.where, "/Prev is not a number");
      }
    }
    if (!this.root) {
      fail(this.where, "the newest trailer names no /Root");
    }
  }

  /** The offset after the last `startxref` in the final kilobyte. */
  private startxref(): number {
    const data = this.data;
    const needle = ascii("startxref");
    const floor = Math.max(0, data.length - STARTXREF_WINDOW);
    for (let at = data.length - needle.length; at >= floor; at -= 1) {
      if (needle.every((code, i) => data[at + i] === code)) {
        const [value] = readInt(data, skipWhitespace(data, at + needle.length));
        if (value === undefined) {
          fail(this.where, "startxref is not followed by an offset");
        }
        return value;
      }
    }
    return fail(this.where, "no startxref in the last kilobyte");
  }

  private checkOffset(offset: number): void {
    if (!Number.isInteger(offset) || offset < 0 || offset >= this.data.length) {
      fail(this.where, `offset ${offset} is outside the file`);
    }
  }

  private merge(number: number, entry: XrefEntry): void {
    this.entryCount += 1;
    const listed = this.sectionEntries.get(entry.section) ?? [];
    listed.push([number, entry]);
    this.sectionEntries.set(entry.section, listed);
    if (this.entryCount > MAX_ENTRIES) {
      fail(this.where, `more than ${MAX_ENTRIES} cross-reference entries`);
    }
    if (number > 0 && !this.entries.has(number)) {
      this.entries.set(number, entry);
    }
  }

  /** One section: its entries merged under the newer ones, its trailer returned. */
  private readSection(offset: number): PDFDict {
    this.checkOffset(offset);
    const data = this.data;
    const pos = skipWhitespace(data, offset);
    if (startsWith(data, pos, "xref")) {
      const trailer = this.readTable(offset, pos + 4);
      const hybrid = trailer.get(PDFName.of("XRefStm"));
      if (hybrid instanceof PDFNumber) {
        this.readStreamSection(offset, hybrid.asNumber());
      }
      return trailer;
    }
    return this.readStreamSection(offset, offset);
  }

  private readTable(section: number, from: number): PDFDict {
    const data = this.data;
    let pos = from;
    for (;;) {
      pos = skipWhitespace(data, pos);
      if (startsWith(data, pos, "trailer")) {
        pos += 7;
        break;
      }
      const [first, afterFirst] = readInt(data, pos);
      const [count, afterCount] = readInt(data, skipWhitespace(data, afterFirst));
      if (first === undefined || count === undefined) {
        fail(this.where, `a cross-reference table at ${section} is malformed`);
      }
      pos = afterCount;
      for (let i = 0; i < count; i += 1) {
        const [field1, after1] = readInt(data, skipWhitespace(data, pos));
        const [field2, after2] = readInt(data, skipWhitespace(data, after1));
        const typeAt = skipWhitespace(data, after2);
        const type = data[typeAt];
        if (field1 === undefined || field2 === undefined || (type !== 0x6e && type !== 0x66)) {
          fail(this.where, `a cross-reference table at ${section} has a malformed entry`);
        }
        pos = typeAt + 1;
        this.merge(first + i, type === 0x66 ? { kind: "free", generation: field2, section } : { kind: "offset", generation: field2, offset: field1, section });
      }
    }
    let trailer: PDFObject;
    try {
      trailer = RevisionParser.over(data.subarray(pos), this.context, directLength).parseObject();
    } catch (error) {
      return fail(this.where, `the trailer at ${section} does not parse (${error instanceof Error ? error.message : String(error)})`);
    }
    if (!(trailer instanceof PDFDict)) {
      fail(this.where, `the trailer at ${section} is not a dictionary`);
    }
    return trailer;
  }

  private readStreamSection(section: number, offset: number): PDFDict {
    this.checkOffset(offset);
    const { object } = this.parseIndirect(offset, undefined, directLength);
    if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of("Type")) !== PDFName.of("XRef")) {
      fail(this.where, `offset ${offset} holds no cross-reference stream`);
    }
    const dict = object.dict;
    const numbers = (value: PDFObject | undefined): number[] | undefined => {
      if (!(value instanceof PDFArray)) {
        return undefined;
      }
      const out = value.asArray().map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : NaN));
      return out.every((n) => Number.isInteger(n) && n >= 0) ? out : undefined;
    };
    const widths = numbers(dict.get(PDFName.of("W")));
    const size = dict.get(PDFName.of("Size"));
    if (!widths || widths.length !== 3 || widths.some((w) => w > 8) || !(size instanceof PDFNumber)) {
      fail(this.where, `the cross-reference stream at ${offset} has no usable /W or /Size`);
    }
    const index = dict.has(PDFName.of("Index")) ? numbers(dict.get(PDFName.of("Index"))) : [0, size.asNumber()];
    if (!index || index.length % 2 !== 0) {
      fail(this.where, `the cross-reference stream at ${offset} has a malformed /Index`);
    }
    const data = decodeStream(object, this.where, undefined);
    const [typeWidth, secondWidth, thirdWidth] = widths as [number, number, number];
    const rowWidth = typeWidth + secondWidth + thirdWidth;
    let at = 0;
    const field = (width: number): number => {
      let value = 0;
      for (let i = 0; i < width; i += 1) {
        value = value * 256 + data[at++]!;
      }
      return value;
    };
    for (let r = 0; r < index.length; r += 2) {
      const first = index[r]!;
      const count = index[r + 1]!;
      for (let i = 0; i < count; i += 1) {
        if (at + rowWidth > data.length) {
          fail(this.where, `the cross-reference stream at ${offset} is shorter than its /Index`);
        }
        const type = typeWidth === 0 ? 1 : field(typeWidth);
        const second = field(secondWidth);
        const third = field(thirdWidth);
        // A type the standard reserves reads as a reference to null.
        const entry: XrefEntry =
          type === 1 ? { kind: "offset", generation: third, offset: second, section } : type === 2 ? { kind: "stream", stream: second, index: third, section } : { kind: "free", generation: type === 0 ? third : 0, section };
        this.merge(first + i, entry);
      }
    }
    return dict;
  }

  /** `n g obj` at an offset and the object after it. */
  private parseIndirect(offset: number, expect: PDFRef | undefined, lengthOf: (value: PDFObject | undefined) => number | undefined): { ref: PDFRef; object: PDFObject } {
    const data = this.data;
    const pos = skipWhitespace(data, offset);
    const [number, afterNumber] = readInt(data, pos);
    const [generation, afterGeneration] = readInt(data, skipWhitespace(data, afterNumber));
    const keywordAt = skipWhitespace(data, afterGeneration);
    if (number === undefined || generation === undefined || !startsWith(data, keywordAt, "obj")) {
      return fail(this.where, `offset ${offset} holds no object`);
    }
    const ref = PDFRef.of(number, generation);
    if (expect && ref !== expect) {
      return fail(this.where, `offset ${offset} holds ${ref.toString()}, not ${expect.toString()}`);
    }
    try {
      return { ref, object: RevisionParser.over(data.subarray(keywordAt + 3), this.context, lengthOf).parseObject() };
    } catch (error) {
      return fail(this.where, `${ref.toString()} does not parse (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  private lengthResolver(ref: PDFRef): (value: PDFObject | undefined) => number | undefined {
    return (value) => {
      if (value instanceof PDFNumber) {
        return value.asNumber();
      }
      if (value instanceof PDFRef) {
        this.lengthDependencies.set(ref, value);
        const resolved = this.lookup(value);
        return resolved instanceof PDFNumber ? resolved.asNumber() : undefined;
      }
      return undefined;
    };
  }

  /** The object a reader of this revision finds for the reference; undefined for null, free or absent. */
  lookup(ref: PDFRef): PDFObject | undefined {
    const cached = this.cache.get(ref);
    if (cached !== undefined) {
      return cached ?? undefined;
    }
    const entry = this.entries.get(ref.objectNumber);
    let object: PDFObject | undefined;
    if (entry && entry.kind !== "free") {
      if (this.resolving.has(ref)) {
        fail(this.where, `${ref.toString()} refers to itself while being read`);
      }
      this.resolving.add(ref);
      try {
        if (entry.kind === "offset" && entry.generation === ref.generationNumber) {
          this.checkOffset(entry.offset);
          object = this.parseIndirect(entry.offset, ref, this.lengthResolver(ref)).object;
        } else if (entry.kind === "stream" && ref.generationNumber === 0) {
          object = this.fromObjectStream(ref, entry.stream, entry.index);
        }
      } finally {
        this.resolving.delete(ref);
      }
    }
    this.cache.set(ref, object ?? null);
    if (object !== undefined) {
      this.context.assign(ref, object);
    }
    return object;
  }

  private fromObjectStream(ref: PDFRef, streamNumber: number, index: number): PDFObject {
    let stream = this.objectStreams.get(streamNumber);
    if (!stream) {
      const entry = this.entries.get(streamNumber);
      if (!entry || entry.kind !== "offset") {
        return fail(this.where, `object stream ${streamNumber} is not at an offset`);
      }
      const object = this.lookup(PDFRef.of(streamNumber, entry.generation));
      if (!(object instanceof PDFRawStream) || object.dict.get(PDFName.of("Type")) !== PDFName.of("ObjStm")) {
        return fail(this.where, `object ${streamNumber} is not an object stream`);
      }
      const n = object.dict.get(PDFName.of("N"));
      const first = object.dict.get(PDFName.of("First"));
      if (!(n instanceof PDFNumber) || !(first instanceof PDFNumber)) {
        return fail(this.where, `object stream ${streamNumber} has no /N or /First`);
      }
      const data = decodeStream(object, this.where, (value) => this.lookup(value));
      const slots: Array<[number, number]> = [];
      let pos = 0;
      for (let i = 0; i < n.asNumber(); i += 1) {
        const [number, afterNumber] = readInt(data, skipWhitespace(data, pos));
        const [offset, afterOffset] = readInt(data, skipWhitespace(data, afterNumber));
        if (number === undefined || offset === undefined) {
          return fail(this.where, `object stream ${streamNumber} has a malformed header`);
        }
        slots.push([number, offset]);
        pos = afterOffset;
      }
      stream = { data, first: first.asNumber(), slots };
      this.objectStreams.set(streamNumber, stream);
    }
    const slot = stream.slots[index];
    if (!slot || slot[0] !== ref.objectNumber || stream.first + slot[1] >= stream.data.length) {
      return fail(this.where, `slot ${index} of object stream ${streamNumber} does not hold ${ref.toString()}`);
    }
    try {
      return RevisionParser.over(stream.data.subarray(stream.first + slot[1]), this.context, directLength).parseObject();
    } catch (error) {
      return fail(this.where, `${ref.toString()} in object stream ${streamNumber} does not parse (${error instanceof Error ? error.message : String(error)})`);
    }
  }

  /** Where the newest entry puts an object number; equal strings mean the same bytes. */
  location(number: number, depth = 0): string | undefined {
    const entry = this.entries.get(number);
    if (!entry) {
      return undefined;
    }
    if (entry.kind === "free") {
      return `free ${entry.generation}`;
    }
    if (entry.kind === "offset") {
      return `at ${entry.offset} ${entry.generation}`;
    }
    return depth > 1 ? `slot ${entry.stream} ${entry.index}` : `slot ${entry.stream} ${entry.index} in ${this.location(entry.stream, depth + 1) ?? "none"}`;
  }

  /**
   * Where the revision a section belongs to ends: just past the `%%EOF` after the `startxref`
   * that names the section, or one or two end-of-line bytes later.
   */
  revisionEnds(section: number): number[] {
    const data = this.data;
    const keyword = ascii("startxref");
    let at = section;
    for (; at + keyword.length <= data.length; at += 1) {
      if (keyword.every((code, i) => data[at + i] === code)) {
        break;
      }
    }
    const [named, afterNumber] = readInt(data, skipWhitespace(data, at + keyword.length));
    if (named !== section) {
      return [];
    }
    let pos = afterNumber;
    while (pos < data.length && isWhitespace(data[pos])) {
      pos += 1;
    }
    if (!startsWith(data, pos, "%%EOF")) {
      return [];
    }
    const end = pos + 5;
    const ends = [end];
    if (data[end] === 0x0d || data[end] === 0x0a) {
      ends.push(end + 1);
      if (data[end] === 0x0d && data[end + 1] === 0x0a) {
        ends.push(end + 2);
      }
    }
    return ends;
  }

  /** Where an object's bytes start in the file: its own offset, or its object stream's. */
  fileOffset(number: number): number | undefined {
    const entry = this.entries.get(number);
    if (!entry || entry.kind === "free") {
      return undefined;
    }
    if (entry.kind === "offset") {
      return entry.offset;
    }
    const stream = this.entries.get(entry.stream);
    return stream?.kind === "offset" ? stream.offset : undefined;
  }

  /** The section an object's newest entry came from. */
  sectionOf(number: number): number | undefined {
    return this.entries.get(number)?.section;
  }

  resolve(value: PDFObject | undefined): PDFObject | undefined {
    return value instanceof PDFRef ? this.lookup(value) : value;
  }

  /** A plain dictionary, never a stream's. */
  dict(value: PDFObject | undefined): PDFDict | undefined {
    const resolved = this.resolve(value);
    return resolved instanceof PDFDict ? resolved : undefined;
  }

  get(dict: PDFDict | undefined, key: string): PDFObject | undefined {
    return dict ? this.resolve(dict.get(PDFName.of(key))) : undefined;
  }

  name(dict: PDFDict | undefined, key: string): string | undefined {
    const value = this.get(dict, key);
    return value instanceof PDFName ? value.decodeText() : undefined;
  }

  array(value: PDFObject | undefined): PDFArray | undefined {
    const resolved = this.resolve(value);
    return resolved instanceof PDFArray ? resolved : undefined;
  }

  get catalog(): PDFDict | undefined {
    return this.root ? this.dict(this.root) : undefined;
  }

  /** A field's inherited entry, walking `/Parent`. */
  inherited(dict: PDFDict | undefined, key: string): PDFObject | undefined {
    let cursor = dict;
    for (let depth = 0; cursor && depth < 32; depth += 1) {
      const value = cursor.get(PDFName.of(key));
      if (value !== undefined) {
        return this.resolve(value);
      }
      cursor = this.dict(cursor.get(PDFName.of("Parent")));
    }
    return undefined;
  }

  /** Every reference reached from the trailer's roots, whether or not it resolves. */
  reachable(): Set<PDFRef> {
    const seen = new Set<PDFRef>();
    const queue: PDFRef[] = [];
    const visit = (value: PDFObject | undefined, depth: number): void => {
      if (value === undefined || depth > MAX_DEPTH) {
        return;
      }
      if (value instanceof PDFRef) {
        if (!seen.has(value)) {
          seen.add(value);
          queue.push(value);
        }
      } else if (value instanceof PDFStream) {
        visit(value.dict, depth + 1);
      } else if (value instanceof PDFDict) {
        for (const [, entry] of value.entries()) {
          visit(entry, depth + 1);
        }
      } else if (value instanceof PDFArray) {
        for (const entry of value.asArray()) {
          visit(entry, depth + 1);
        }
      }
    };
    visit(this.root, 0);
    visit(this.info, 0);
    visit(this.encrypt, 0);
    while (queue.length > 0) {
      visit(this.lookup(queue.pop()!), 0);
    }
    return seen;
  }
}

function readRevision(bytes: Uint8Array, end: number, where: string): Revision {
  const revision = new Revision(bytes.subarray(0, end), where);
  revision.readChain();
  return revision;
}

function isWhitespace(code: number | undefined): boolean {
  return code === 0x20 || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x0c || code === 0x00;
}

/** Skips whitespace and `%` comments. */
function skipWhitespace(data: Uint8Array, from: number): number {
  let pos = from;
  while (pos < data.length) {
    if (isWhitespace(data[pos])) {
      pos += 1;
    } else if (data[pos] === 0x25) {
      while (pos < data.length && data[pos] !== 0x0a && data[pos] !== 0x0d) {
        pos += 1;
      }
    } else {
      break;
    }
  }
  return pos;
}

function readInt(data: Uint8Array, from: number): [number | undefined, number] {
  let pos = from;
  let value = 0;
  while (pos < data.length && data[pos]! >= 0x30 && data[pos]! <= 0x39 && pos - from < 16) {
    value = value * 10 + (data[pos]! - 0x30);
    pos += 1;
  }
  return pos === from ? [undefined, from] : [value, pos];
}

function startsWith(data: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (data[at + i] !== text.charCodeAt(i)) {
      return false;
    }
  }
  return true;
}

/**
 * A stream's decoded bytes, PNG predictors undone (pdf-lib's decoder leaves them in). `/Filter`
 * and `/DecodeParms` are resolved first when `resolve` is given (a cross-reference stream must
 * write them directly); each parameters dictionary goes with the filter at its index, and only
 * the last filter may carry a predictor.
 */
function decodeStream(stream: PDFRawStream, where: string, resolve: ((ref: PDFRef) => PDFObject | undefined) | undefined): Uint8Array {
  const direct = (value: PDFObject | undefined): PDFObject | undefined => {
    if (!(value instanceof PDFRef)) {
      return value;
    }
    return resolve ? resolve(value) : fail(where, "a cross-reference stream's /Filter or /DecodeParms is indirect");
  };
  const filterValue = direct(stream.dict.get(PDFName.of("Filter")));
  const filters = filterValue instanceof PDFArray ? filterValue.asArray().map(direct) : filterValue === undefined ? [] : [filterValue];
  if (!filters.every((filter) => filter instanceof PDFName)) {
    return fail(where, "a stream's /Filter is not a name or an array of names");
  }
  const parmsValue = direct(stream.dict.get(PDFName.of("DecodeParms")));
  const parmsList = (parmsValue instanceof PDFArray ? parmsValue.asArray().map(direct) : [parmsValue]).map((entry) => (entry instanceof PDFDict ? entry : undefined));
  const context = PDFContext.create();
  const decodeDict = context.obj({}) as PDFDict;
  if (filters.length > 0) {
    decodeDict.set(PDFName.of("Filter"), context.obj(filters as PDFName[]));
    decodeDict.set(PDFName.of("DecodeParms"), context.obj(filters.map((_, index) => parmsList[index] ?? context.obj({}))));
  }
  let data: Uint8Array;
  try {
    data = decodePDFRawStream(PDFRawStream.of(decodeDict, stream.asUint8Array())).decode();
  } catch (error) {
    return fail(where, `a stream does not decode (${error instanceof Error ? error.message : String(error)})`);
  }
  const predictorOf = (parms: PDFDict | undefined): number => {
    const value = direct(parms?.get(PDFName.of("Predictor")));
    return value instanceof PDFNumber ? value.asNumber() : 1;
  };
  for (let index = 0; index < filters.length - 1; index += 1) {
    if (predictorOf(parmsList[index]) !== 1) {
      return fail(where, "a predictor on a filter other than the last is not supported");
    }
  }
  const parms = filters.length > 0 ? parmsList[filters.length - 1] : undefined;
  const predictor = predictorOf(parms);
  if (predictor === 1) {
    return data;
  }
  if (predictor < 10) {
    return fail(where, `predictor ${predictor} is not supported`);
  }
  const number = (key: string, fallback: number): number => {
    const value = direct(parms!.get(PDFName.of(key)));
    return value instanceof PDFNumber ? value.asNumber() : fallback;
  };
  const colors = number("Colors", 1);
  const bits = number("BitsPerComponent", 8);
  const columns = number("Columns", 1);
  const bytesPerPixel = Math.max(1, Math.ceil((colors * bits) / 8));
  const rowLength = Math.ceil((columns * colors * bits) / 8);
  if (!Number.isInteger(rowLength) || rowLength <= 0 || data.length % (rowLength + 1) !== 0) {
    return fail(where, "predictor data is not a whole number of rows");
  }
  const rows = data.length / (rowLength + 1);
  const out = new Uint8Array(rows * rowLength);
  for (let row = 0; row < rows; row += 1) {
    const filter = data[row * (rowLength + 1)]!;
    const source = row * (rowLength + 1) + 1;
    const target = row * rowLength;
    for (let i = 0; i < rowLength; i += 1) {
      const raw = data[source + i]!;
      const left = i >= bytesPerPixel ? out[target + i - bytesPerPixel]! : 0;
      const up = row > 0 ? out[target - rowLength + i]! : 0;
      const upLeft = row > 0 && i >= bytesPerPixel ? out[target - rowLength + i - bytesPerPixel]! : 0;
      let value: number;
      if (filter === 0) {
        value = raw;
      } else if (filter === 1) {
        value = raw + left;
      } else if (filter === 2) {
        value = raw + up;
      } else if (filter === 3) {
        value = raw + Math.floor((left + up) / 2);
      } else if (filter === 4) {
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
      } else {
        return fail(where, `PNG filter ${filter} is not defined`);
      }
      out[target + i] = value & 0xff;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Comparing and classifying

/** A form that is equal for two objects exactly when a reader would see the same object. */
function canonical(object: PDFObject | undefined, depth = 0): string {
  if (object === undefined) {
    return "";
  }
  if (depth > MAX_DEPTH) {
    return object.toString();
  }
  if (object instanceof PDFStream) {
    const contents = object instanceof PDFRawStream ? object.asUint8Array() : object.getContents();
    return `stream${canonicalDict(object.dict, depth + 1, "Length")}${toHex(sha256(contents))}`;
  }
  if (object instanceof PDFDict) {
    return canonicalDict(object, depth + 1);
  }
  if (object instanceof PDFArray) {
    return `[${object
      .asArray()
      .map((entry) => canonical(entry, depth + 1))
      .join(" ")}]`;
  }
  if (object instanceof PDFString || object instanceof PDFHexString) {
    return `<${toHex(object.asBytes())}>`;
  }
  return object.toString();
}

function canonicalDict(dict: PDFDict, depth: number, skip?: string): string {
  const entries = dict
    .entries()
    .filter(([key]) => key.decodeText() !== skip)
    .map(([key, value]) => `${key.toString()} ${canonical(value, depth)}`)
    .sort();
  return `<<${entries.join(" ")}>>`;
}

function plainDict(object: PDFObject | undefined): PDFDict | undefined {
  return object instanceof PDFDict ? object : undefined;
}

function dictOf(object: PDFObject | undefined): PDFDict | undefined {
  if (object instanceof PDFStream) {
    return object.dict;
  }
  return plainDict(object);
}

/** The keys whose values differ, by their raw values (a reference compares as the reference). */
function diffKeys(before: PDFDict | undefined, after: PDFDict | undefined): Set<string> {
  const keys = new Set<string>();
  const values = (dict: PDFDict | undefined): Map<string, string> => {
    const out = new Map<string, string>();
    for (const [key, value] of dict?.entries() ?? []) {
      out.set(key.decodeText(), canonical(value));
    }
    return out;
  };
  const a = values(before);
  const b = values(after);
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    if (a.get(key) !== b.get(key)) {
      keys.add(key);
    }
  }
  return keys;
}

function keysOf(dict: PDFDict | undefined): string[] {
  return (dict?.entries() ?? []).map(([key]) => key.decodeText());
}

function normalizeHex(hex: string): string {
  return hex.replace(/\s+/g, "").toLowerCase();
}

function textOf(value: PDFObject | undefined): string | undefined {
  return value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : undefined;
}

function isSignatureDict(view: Revision, dict: PDFDict | undefined): boolean {
  if (!dict) {
    return false;
  }
  const type = view.name(dict, "Type");
  if (type === "Sig" || type === "DocTimeStamp") {
    return true;
  }
  return dict.has(PDFName.of("ByteRange")) && dict.has(PDFName.of("Contents")) && (dict.has(PDFName.of("Filter")) || dict.has(PDFName.of("SubFilter")));
}

/** What a reachable object that only an annotation's appearance, a signature, the DSS, the form's resources or the Info dictionary references belongs to. */
type Owner = { type: "appearance"; annotation: PDFRef } | { type: "signature"; signature: PDFRef } | { type: "dss" } | { type: "resources" } | { type: "info" } | { type: "encrypt" };

interface Classified {
  kind: LaterChangeKind;
  detail?: string;
}

function rank(kind: LaterChangeKind): number {
  if (FORM_FILLING_KINDS.has(kind)) {
    return 1;
  }
  return kind === "annotation" ? 2 : 3;
}

/** FieldMDP: which fields a signature in the signed revision locks. */
interface FieldLock {
  action: string;
  fields: string[];
}

/** The roles objects play: pages, annotations, fields and widgets, the lists that hold them. */
class Roles {
  readonly pages = new Set<PDFRef>();
  readonly annotations = new Set<PDFRef>();
  readonly fields = new Set<PDFRef>();
  readonly annotsArrays = new Map<PDFRef, PDFRef>();
  readonly kidsArrays = new Map<PDFRef, PDFRef>();
  readonly formRefs = new Set<PDFRef>();
  readonly metadataRefs = new Set<PDFRef>();
  /** Full field names, in the revision the roles were learnt from. */
  readonly names = new Map<PDFRef, string>();

  /**
   * Learns the roles `view` gives; `adopt` says which references may take one (the signed
   * revision's for every object, a later revision's only for objects new in it).
   */
  learn(view: Revision, adopt: (ref: PDFRef) => boolean): void {
    const catalog = view.catalog;
    const visitedPages = new Set<PDFRef>();
    const visitPages = (value: PDFObject | undefined, depth: number): void => {
      if (!(value instanceof PDFRef) || depth > MAX_DEPTH || visitedPages.has(value)) {
        return;
      }
      visitedPages.add(value);
      const node = view.dict(value);
      const type = view.name(node, "Type");
      if (type === "Pages") {
        for (const kid of view.array(node?.get(PDFName.of("Kids")))?.asArray() ?? []) {
          visitPages(kid, depth + 1);
        }
      } else if (type === "Page" && node) {
        if (adopt(value)) {
          this.pages.add(value);
        }
        const annots = node.get(PDFName.of("Annots"));
        const list = view.array(annots);
        if (annots instanceof PDFRef && list && adopt(annots)) {
          this.annotsArrays.set(annots, value);
        }
        for (const entry of list?.asArray() ?? []) {
          if (entry instanceof PDFRef && view.dict(entry) && adopt(entry)) {
            this.annotations.add(entry);
          }
        }
      }
    };
    visitPages(catalog?.get(PDFName.of("Pages")), 0);
    const metadata = catalog?.get(PDFName.of("Metadata"));
    if (metadata instanceof PDFRef && adopt(metadata)) {
      this.metadataRefs.add(metadata);
    }
    const formValue = catalog?.get(PDFName.of("AcroForm"));
    const form = view.dict(formValue);
    if (formValue instanceof PDFRef && form && adopt(formValue)) {
      this.formRefs.add(formValue);
    }
    const fields = form?.get(PDFName.of("Fields"));
    const fieldList = view.array(fields);
    if (fields instanceof PDFRef && fieldList && adopt(fields)) {
      this.formRefs.add(fields);
    }
    const visitedFields = new Set<PDFRef>();
    const visit = (value: PDFObject, prefix: string, depth: number): void => {
      if (!(value instanceof PDFRef) || depth > 32 || visitedFields.has(value)) {
        return;
      }
      visitedFields.add(value);
      const dict = view.dict(value);
      if (!dict) {
        return;
      }
      const partial = textOf(view.get(dict, "T"));
      const name = partial !== undefined ? (prefix ? `${prefix}.${partial}` : partial) : prefix;
      if (adopt(value)) {
        this.fields.add(value);
        this.names.set(value, name);
      }
      const kids = dict.get(PDFName.of("Kids"));
      const kidList = view.array(kids);
      if (kids instanceof PDFRef && kidList && adopt(kids)) {
        this.kidsArrays.set(kids, value);
      }
      for (const kid of kidList?.asArray() ?? []) {
        visit(kid, name, depth + 1);
      }
    };
    for (const field of fieldList?.asArray() ?? []) {
      visit(field, "", 0);
    }
  }
}

class Analysis {
  private readonly changes: LaterChange[] = [];
  private readonly seen = new Set<string>();
  /** The signature's own dictionary, and its field and widgets, in the signed revision. */
  private readonly ownSignatures = new Set<PDFRef>();
  private readonly ownFields = new Set<PDFRef>();
  private readonly ownContents: string | undefined;
  private readonly roles = new Roles();
  private readonly locks: FieldLock[] = [];
  private signedReach = new Set<PDFRef>();
  private mainReach = new Set<PDFRef>();
  private owners = new Map<PDFRef, Owner[]>();
  private readonly sealing = new Map<PDFRef, boolean>();
  private readonly relied = new Map<PDFRef, ReliedOnSignature>();

  constructor(
    private readonly bytes: Uint8Array,
    private readonly signed: Revision,
    private readonly full: Revision,
    private readonly options: LaterRevisionsOptions
  ) {
    this.ownContents = options.signatureContentsHex !== undefined ? normalizeHex(options.signatureContentsHex) : undefined;
  }

  run(): LaterChange[] {
    if (!this.signed.catalog) {
      fail(this.signed.where, "it has no document catalog");
    }
    this.roles.learn(this.signed, () => true);
    this.roles.learn(this.full, (ref) => this.signed.lookup(ref) === undefined);
    this.learnSignatures();
    this.signedReach = this.walkMain(this.signed).reach;
    const main = this.walkMain(this.full);
    this.mainReach = main.reach;
    this.owners = main.owners;
    const reachable = this.full.reachable();
    this.signed.reachable();

    const numbers = new Set<number>([...this.signed.entries.keys(), ...this.full.entries.keys()]);
    const moved = new Set<number>();
    for (const number of numbers) {
      if (this.signed.location(number) !== this.full.location(number)) {
        moved.add(number);
      }
    }
    // A stream whose /Length is an object that moved reads differently even where it sits
    // still, and so does every object in an object stream that reads differently: to a fixpoint.
    for (let grew = true; grew; ) {
      grew = false;
      const mark = (number: number): void => {
        if (!moved.has(number)) {
          moved.add(number);
          grew = true;
        }
      };
      for (const revision of [this.signed, this.full]) {
        for (const [stream, length] of revision.lengthDependencies) {
          if (moved.has(length.objectNumber)) {
            mark(stream.objectNumber);
          }
        }
        for (const [number, entry] of revision.entries) {
          if (entry.kind === "stream" && moved.has(entry.stream)) {
            mark(number);
          }
        }
      }
    }
    const candidates = new Set<PDFRef>();
    for (const number of moved) {
      for (const revision of [this.signed, this.full]) {
        const entry = revision.entries.get(number);
        if (entry) {
          candidates.add(PDFRef.of(number, entry.kind === "stream" ? 0 : entry.generation));
        }
      }
    }

    this.compareTrailer();
    this.compareCatalog();
    this.compareForm();
    for (const ref of candidates) {
      if (!reachable.has(ref)) {
        continue;
      }
      const before = this.signed.lookup(ref);
      const after = this.full.lookup(ref);
      if (before === undefined && after === undefined) {
        continue;
      }
      if (before !== undefined && after !== undefined && canonical(before) === canonical(after)) {
        continue;
      }
      this.classify(ref, before, after);
    }
    return this.changes.sort((a, b) => order(a.ref) - order(b.ref) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  }

  private add(ref: PDFRef | string, classified: Classified): void {
    const text = typeof ref === "string" ? ref : ref.toString();
    const key = `${text}|${classified.kind}|${classified.detail ?? ""}`;
    if (this.seen.has(key)) {
      return;
    }
    this.seen.add(key);
    this.changes.push({ ref: text, kind: classified.kind, ...(classified.detail !== undefined ? { detail: classified.detail } : {}) });
  }

  private isNew(ref: PDFRef): boolean {
    return this.signed.lookup(ref) === undefined;
  }

  private isAnnotation(ref: PDFRef): boolean {
    return this.roles.annotations.has(ref);
  }

  /** In the form's field tree, or a widget listed on a page; never a stream. */
  private isFieldOrWidget(ref: PDFRef): boolean {
    if (this.roles.fields.has(ref)) {
      return true;
    }
    if (!this.roles.annotations.has(ref)) {
      return false;
    }
    const view = this.isNew(ref) ? this.full : this.signed;
    return view.name(view.dict(ref), "Subtype") === "Widget";
  }

  /** The signed field, its signature and the FieldMDP locks the signed revision's signatures set. */
  private learnSignatures(): void {
    const view = this.signed;
    for (const ref of this.roles.fields) {
      if (this.isNew(ref)) {
        continue;
      }
      const dict = view.dict(ref)!;
      const type = view.inherited(dict, "FT");
      if (!(type instanceof PDFName) || type.decodeText() !== "Sig") {
        continue;
      }
      const valueRef = dict.get(PDFName.of("V"));
      const value = view.dict(valueRef);
      if (!value) {
        continue;
      }
      const contents = value.get(PDFName.of("Contents"));
      const contentsMatch = this.ownContents !== undefined && contents instanceof PDFHexString && normalizeHex(contents.asString()) === this.ownContents;
      const name = this.roles.names.get(ref);
      if ((name !== undefined && name === this.options.fieldName && dict.has(PDFName.of("T"))) || contentsMatch) {
        this.ownFields.add(ref);
        for (const kid of view.array(dict.get(PDFName.of("Kids")))?.asArray() ?? []) {
          if (kid instanceof PDFRef) {
            this.ownFields.add(kid);
          }
        }
        if (valueRef instanceof PDFRef) {
          this.ownSignatures.add(valueRef);
        }
      }
      const lock = view.dict(dict.get(PDFName.of("Lock")));
      if (lock) {
        this.locks.push(this.lockOf(lock));
      }
      for (const reference of view.array(value.get(PDFName.of("Reference")))?.asArray() ?? []) {
        const sigRef = view.dict(reference);
        if (sigRef && view.name(sigRef, "TransformMethod") === "FieldMDP") {
          const params = view.dict(sigRef.get(PDFName.of("TransformParams")));
          if (params) {
            this.locks.push(this.lockOf(params));
          }
        }
      }
    }
  }

  private lockOf(dict: PDFDict): FieldLock {
    const view = this.signed;
    const fields = (view.array(dict.get(PDFName.of("Fields")))?.asArray() ?? []).map((entry) => textOf(view.resolve(entry))).filter((name): name is string => name !== undefined);
    return { action: view.name(dict, "Action") ?? "All", fields };
  }

  private isLocked(name: string | undefined): boolean {
    if (name === undefined) {
      return this.locks.length > 0;
    }
    const covers = (field: string): boolean => name === field || name.startsWith(`${field}.`);
    return this.locks.some((lock) => (lock.action === "Include" ? lock.fields.some(covers) : lock.action === "Exclude" ? !lock.fields.some(covers) : true));
  }

  /**
   * Everything a revision reaches from its catalog except through a signature dictionary, an
   * annotation's `/AP`, the catalog's `/DSS` or the form's `/DR`; what only those reach belongs
   * to them, so a new appearance stream or a font only it uses counts with the widget it draws.
   */
  private walkMain(view: Revision): { reach: Set<PDFRef>; owners: Map<PDFRef, Owner[]> } {
    const reach = new Set<PDFRef>();
    const owners = new Map<PDFRef, Owner[]>();
    const roots: Array<{ owner: Owner; value: PDFObject }> = [];
    const catalog = view.catalog;
    const form = view.dict(catalog?.get(PDFName.of("AcroForm")));
    const queue: PDFRef[] = [];
    const scan = (value: PDFObject | undefined, holder: PDFRef, top: boolean, depth: number): void => {
      if (value === undefined || depth > MAX_DEPTH) {
        return;
      }
      if (value instanceof PDFRef) {
        if (!reach.has(value)) {
          reach.add(value);
          queue.push(value);
        }
        return;
      }
      if (value instanceof PDFArray) {
        for (const entry of value.asArray()) {
          scan(entry, holder, false, depth + 1);
        }
        return;
      }
      if (value instanceof PDFStream) {
        scan(value.dict, holder, false, depth + 1);
        return;
      }
      const dict = plainDict(value);
      if (!dict) {
        return;
      }
      if (isSignatureDict(view, dict)) {
        roots.push({ owner: { type: "signature", signature: holder }, value: dict });
        return;
      }
      const annotation = top && this.isAnnotation(holder);
      for (const [key, entry] of dict.entries()) {
        const name = key.decodeText();
        if (dict === catalog && name === "DSS") {
          roots.push({ owner: { type: "dss" }, value: entry });
        } else if (annotation && name === "AP") {
          roots.push({ owner: { type: "appearance", annotation: holder }, value: entry });
        } else if (dict === form && name === "DR") {
          roots.push({ owner: { type: "resources" }, value: entry });
        } else {
          scan(entry, holder, false, depth + 1);
        }
      }
    };
    if (view.root) {
      reach.add(view.root);
      queue.push(view.root);
    }
    while (queue.length > 0) {
      const ref = queue.pop()!;
      scan(view.lookup(ref), ref, true, 0);
    }
    if (view.info !== undefined) {
      roots.push({ owner: { type: "info" }, value: view.info });
    }
    if (view.encrypt !== undefined) {
      roots.push({ owner: { type: "encrypt" }, value: view.encrypt });
    }
    for (const { owner, value } of roots) {
      const visited = new Set<PDFRef>();
      const stack: PDFObject[] = [value];
      while (stack.length > 0) {
        const current = stack.pop()!;
        if (current instanceof PDFRef) {
          if (reach.has(current) || visited.has(current)) {
            continue;
          }
          visited.add(current);
          const list = owners.get(current) ?? [];
          list.push(owner);
          owners.set(current, list);
          const object = view.lookup(current);
          if (object !== undefined) {
            stack.push(object);
          }
        } else if (current instanceof PDFStream) {
          stack.push(current.dict);
        } else if (current instanceof PDFDict) {
          for (const [, entry] of current.entries()) {
            stack.push(entry);
          }
        } else if (current instanceof PDFArray) {
          stack.push(...current.asArray());
        }
      }
    }
    return { reach, owners };
  }

  private compareTrailer(): void {
    if (this.signed.root !== this.full.root) {
      this.add("trailer", { kind: "other", detail: "/Root replaced" });
    }
    if (canonical(this.signed.info) !== canonical(this.full.info)) {
      this.add("trailer", { kind: "info", detail: "/Info" });
    }
  }

  /** The catalog, key by key, compared across revisions whatever its object number. */
  private compareCatalog(): void {
    const ref = this.full.root ?? this.signed.root!;
    for (const key of diffKeys(this.signed.catalog, this.full.catalog)) {
      if (key === "AcroForm") {
        continue; // compareForm
      }
      if (key === "DSS") {
        this.add(ref, { kind: "dss" });
      } else if (key === "Metadata") {
        this.add(ref, { kind: "info", detail: "metadata" });
      } else {
        this.add(ref, { kind: "other", detail: `catalog /${key}` });
      }
    }
  }

  /** The AcroForm dictionary and its `/Fields`, wherever they live. */
  private compareForm(): void {
    const formValueAfter = this.full.catalog?.get(PDFName.of("AcroForm"));
    const ref = formValueAfter instanceof PDFRef ? formValueAfter : (this.full.root ?? this.signed.root!);
    const before = this.signed.dict(this.signed.catalog?.get(PDFName.of("AcroForm")));
    const after = this.full.dict(formValueAfter);
    const fieldsBefore = this.signed.array(before?.get(PDFName.of("Fields")));
    const fieldsAfter = this.full.array(after?.get(PDFName.of("Fields")));
    if (canonical(before) === canonical(after) && canonical(fieldsBefore) === canonical(fieldsAfter)) {
      return;
    }
    if (!after) {
      this.add(ref, { kind: "other", detail: "AcroForm removed or not a dictionary" });
      return;
    }
    const keys = diffKeys(before, after);
    if (canonical(fieldsBefore) !== canonical(fieldsAfter)) {
      keys.add("Fields");
    }
    let form = false;
    for (const key of keys) {
      if (key === "Fields") {
        if (after.has(PDFName.of("Fields")) && !fieldsAfter) {
          this.add(ref, { kind: "other", detail: "AcroForm /Fields is not an array" });
        }
        for (const issue of this.listChanges(fieldsBefore, fieldsAfter, "field")) {
          this.add(ref, issue);
        }
        form = true;
      } else if (ACROFORM_KEYS.has(key)) {
        form = true;
      } else {
        this.add(ref, { kind: "other", detail: `AcroForm /${key}` });
      }
    }
    if (form) {
      this.add(ref, { kind: "acroform" });
    }
  }

  /**
   * What a changed list of annotations or fields removed or moved in: a widget or field taken
   * away, or an existing object listed anew, is never form filling; a non-widget annotation
   * removed or moved is an annotation change. New objects classify themselves.
   */
  private listChanges(before: PDFArray | undefined, after: PDFArray | undefined, what: "annotation" | "field"): Classified[] {
    const out: Classified[] = [];
    const a = (before?.asArray() ?? []).map((entry) => canonical(entry));
    const b = (after?.asArray() ?? []).map((entry) => canonical(entry));
    const removed = (before?.asArray() ?? []).filter((_, index) => !b.includes(a[index]!));
    const added = (after?.asArray() ?? []).filter((_, index) => !a.includes(b[index]!));
    for (const entry of removed) {
      const annotation = what === "annotation" && entry instanceof PDFRef && this.isAnnotation(entry) && !this.isFieldOrWidget(entry);
      const detail = what === "field" ? "a field removed" : entry instanceof PDFRef && this.isFieldOrWidget(entry) ? "a widget removed from a page" : "a non-annotation removed from a page";
      out.push(annotation ? { kind: "annotation", detail: "removed" } : { kind: "other", detail });
    }
    for (const entry of added) {
      if (!(entry instanceof PDFRef)) {
        out.push({ kind: "other", detail: `an inline ${what} listed` });
        continue;
      }
      if (this.isNew(entry)) {
        continue;
      }
      const annotation = what === "annotation" && this.isAnnotation(entry) && !this.isFieldOrWidget(entry);
      out.push(annotation ? { kind: "annotation", detail: "moved" } : { kind: "other", detail: what === "field" ? "an existing object listed as a field" : "an existing object listed on a page" });
    }
    return out;
  }

  private classify(ref: PDFRef, before: PDFObject | undefined, after: PDFObject | undefined): void {
    const signedType = this.signed.name(dictOf(before), "Type");
    const type = signedType ?? this.full.name(dictOf(after), "Type");
    if (ref === this.full.root || ref === this.signed.root || this.roles.formRefs.has(ref)) {
      return; // compareCatalog, compareForm
    }
    if (ref === this.full.info || ref === this.signed.info) {
      this.add(ref, { kind: "info" });
      return;
    }
    if (this.roles.metadataRefs.has(ref)) {
      this.add(ref, { kind: "info", detail: "metadata" });
      return;
    }
    if (after === undefined) {
      // Freed, yet something the later document reaches still names it.
      const annotation = this.isAnnotation(ref) && !this.isFieldOrWidget(ref);
      this.add(ref, annotation ? { kind: "annotation", detail: "freed" } : { kind: "other", detail: "freed while still referenced" });
      return;
    }
    if (isSignatureDict(this.signed, plainDict(before)) || (before === undefined && isSignatureDict(this.full, plainDict(after)))) {
      this.add(ref, this.signatureKind(ref, before));
      return;
    }
    if (this.isFieldOrWidget(ref)) {
      this.add(ref, this.fieldKind(ref, plainDict(before), plainDict(after)));
      return;
    }
    if (this.isAnnotation(ref)) {
      this.add(ref, this.annotationKind(plainDict(before), plainDict(after)));
      return;
    }
    if (this.roles.pages.has(ref)) {
      for (const classified of this.pageKinds(ref)) {
        this.add(ref, classified);
      }
      return;
    }
    const page = this.roles.annotsArrays.get(ref);
    if (page) {
      for (const classified of this.pageKinds(page)) {
        this.add(ref, classified);
      }
      return;
    }
    const field = this.roles.kidsArrays.get(ref);
    if (field) {
      this.add(ref, this.kidsKind(ref, field, before, after));
      return;
    }
    const detail = type ?? (after instanceof PDFStream ? "stream" : describe(after));
    if (before !== undefined && this.signedReach.has(ref)) {
      // The signed revision reached it from its catalog, outside any appearance: page content, a font, a resource.
      this.add(ref, { kind: "other", detail });
      return;
    }
    if (!this.mainReach.has(ref)) {
      const owners = this.owners.get(ref);
      if (owners && owners.length > 0) {
        this.add(ref, this.ownedKind(ref, owners));
        return;
      }
    }
    this.add(ref, { kind: "other", detail });
  }

  private isOwnSignature(ref: PDFRef, dict: PDFDict | undefined): boolean {
    if (this.ownSignatures.has(ref)) {
      return true;
    }
    const contents = dict?.get(PDFName.of("Contents"));
    return this.ownContents !== undefined && contents instanceof PDFHexString && normalizeHex(contents.asString()) === this.ownContents;
  }

  private signatureKind(ref: PDFRef, before: PDFObject | undefined): Classified {
    if (this.isOwnSignature(ref, plainDict(before)) || this.isOwnSignature(ref, plainDict(this.full.lookup(ref)))) {
      return { kind: "signature-dictionary" };
    }
    if (before !== undefined) {
      return { kind: "other", detail: "an earlier signature changed" };
    }
    return this.sealsItsUpdate(ref) ? { kind: "signature-field", detail: "signature dictionary" } : { kind: "other", detail: "a signature dictionary that seals nothing" };
  }

  /** The signatures `sealsItsUpdate` accepted, for the host to verify. */
  reliedOn(): ReliedOnSignature[] {
    return [...this.relied.values()].sort((a, b) => order(a.ref) - order(b.ref));
  }

  /**
   * Whether a signature dictionary new in an update is a finished signature closing exactly
   * that update. Memoised; an accepted one is recorded as relied on.
   */
  private sealsItsUpdate(ref: PDFRef): boolean {
    const known = this.sealing.get(ref);
    if (known !== undefined) {
      return known;
    }
    const sealed = this.checkSeal(ref);
    this.sealing.set(ref, sealed);
    return sealed;
  }

  /**
   * A signature closes its update when all of these hold:
   * - its `/ByteRange` is well formed from 0, around its own `/Contents`, whose hex is in the gap;
   * - `/Contents` is a CMS whose signed messageDigest is the SHA-256, -384 or -512 of the range;
   * - the range ends exactly where the revision whose section lists the dictionary ends;
   * - every object that revision wrote lies inside the range, none in the gap;
   * - exactly one field names it as `/V`, and that field, and any of its widgets and their
   *   appearances changed since the signed revision, were last written by that same revision,
   *   so nothing after it points at the signature differently.
   * Whether the signature value is good is the host's question (no crypto here), so an
   * accepted signature is reported in `reliedOnSignatures`.
   */
  private checkSeal(ref: PDFRef): boolean {
    const dict = this.full.dict(ref);
    if (!dict || !isSignatureDict(this.full, dict) || !this.isNew(ref)) {
      return false;
    }
    const range = dict.get(PDFName.of("ByteRange"));
    const contents = dict.get(PDFName.of("Contents"));
    if (!(range instanceof PDFArray) || range.size() !== 4 || !(contents instanceof PDFHexString)) {
      return false;
    }
    const numbers = range.asArray().map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : NaN));
    const [start0, length0, start1, length1] = numbers as [number, number, number, number];
    const end = start1 + length1;
    if (!numbers.every((n) => Number.isInteger(n) && n >= 0) || start0 !== 0 || length0 >= start1 || end > this.bytes.length) {
      return false;
    }
    if (this.bytes[length0] !== 0x3c || this.bytes[start1 - 1] !== 0x3e) {
      return false;
    }
    const hex = normalizeHex(contents.asString());
    if (/^0*$/.test(hex) || hex.length % 2 !== 0 || normalizeHex(latin1(this.bytes.subarray(length0 + 1, start1 - 1))) !== hex) {
      return false;
    }
    let digestMatches = false;
    try {
      const cms = parseSignedData(fromHex(hex));
      const algorithm = cms.digestAlgorithm;
      if ((algorithm === OID.sha256 || algorithm === OID.sha384 || algorithm === OID.sha512) && cms.messageDigest) {
        const digest = digestFor(algorithm, concat([this.bytes.subarray(0, length0), this.bytes.subarray(start1, end)]));
        digestMatches = digest !== undefined && bytesEqual(digest, cms.messageDigest);
      }
    } catch {
      digestMatches = false;
    }
    if (!digestMatches) {
      return false;
    }
    const section = this.full.sectionOf(ref.objectNumber);
    if (section === undefined || !this.full.revisionEnds(section).includes(end)) {
      return false;
    }
    for (const [number] of this.full.sectionEntries.get(section) ?? []) {
      const at = this.full.fileOffset(number);
      if (at !== undefined && this.full.sectionOf(number) === section && ((at >= length0 && at < start1) || at >= end)) {
        return false;
      }
    }
    const namers = [...new Set([...this.roles.fields, ...this.roles.annotations])].filter((candidate) => this.full.dict(candidate)?.get(PDFName.of("V")) === ref);
    if (namers.length !== 1) {
      return false;
    }
    const field = namers[0]!;
    if (this.full.sectionOf(field.objectNumber) !== section) {
      return false;
    }
    const fieldDict = this.full.dict(field)!;
    const widgets = [field, ...(this.full.array(fieldDict.get(PDFName.of("Kids")))?.asArray() ?? []).filter((kid): kid is PDFRef => kid instanceof PDFRef)];
    const written: PDFRef[] = [];
    for (const widget of widgets) {
      written.push(widget);
      const appearance = this.full.dict(this.full.dict(widget)?.get(PDFName.of("AP")));
      for (const [, value] of appearance?.entries() ?? []) {
        if (value instanceof PDFRef) {
          written.push(value);
        }
        for (const [, state] of this.full.dict(value)?.entries() ?? []) {
          if (state instanceof PDFRef) {
            written.push(state);
          }
        }
      }
    }
    for (const object of written) {
      const changed = this.signed.location(object.objectNumber) !== this.full.location(object.objectNumber);
      if (changed && this.full.sectionOf(object.objectNumber) !== section) {
        return false;
      }
    }
    this.relied.set(ref, { ref: ref.toString(), byteRange: [start0, length0, start1, length1], contentsHex: hex });
    return true;
  }

  /** The field a widget belongs to: itself when it carries `/T`, else its `/Parent`. */
  private fieldOf(ref: PDFRef, dict: PDFDict): PDFRef {
    if (dict.has(PDFName.of("T"))) {
      return ref;
    }
    const parent = dict.get(PDFName.of("Parent"));
    return parent instanceof PDFRef ? parent : ref;
  }

  /** A signature field ends up signed by a signature new in the update that seals it. */
  private newSignatureValue(fieldRef: PDFRef, object: PDFRef): Classified {
    const value = this.sealOf(fieldRef);
    if (!value) {
      return { kind: "other", detail: "a signature field without a new signature sealing its update" };
    }
    return this.vouchedFor(object, value, { kind: "signature-field" });
  }

  /** The signature dictionary a field names as `/V`, when it seals its update. */
  private sealOf(fieldRef: PDFRef): PDFRef | undefined {
    const value = this.full.dict(fieldRef)?.get(PDFName.of("V"));
    return value instanceof PDFRef && this.sealsItsUpdate(value) ? value : undefined;
  }

  /**
   * A seal vouches only for what it covers: an object counts as part of a signature's update
   * when its newest entry is in the section that signature closes, or when it has not changed
   * since the signed revision at all. Anything a later update wrote is outside it.
   */
  private vouchedFor(object: PDFRef, signature: PDFRef, classified: Classified): Classified {
    const unchanged = this.signed.location(object.objectNumber) === this.full.location(object.objectNumber);
    if (unchanged || this.full.sectionOf(object.objectNumber) === this.full.sectionOf(signature.objectNumber)) {
      return classified;
    }
    return { kind: "other", detail: "outside the signature that would vouch for it" };
  }

  /**
   * A field or widget dictionary that changed. `extra` names keys that changed through an
   * object the widget owns (an appearance stream rewritten in place counts as `/AP`).
   */
  private fieldKind(ref: PDFRef, before: PDFDict | undefined, after: PDFDict | undefined, extra: readonly string[] = []): Classified {
    if (!after) {
      return { kind: "other", detail: "a field or widget that is no longer a dictionary" };
    }
    const fieldRef = this.fieldOf(ref, before ?? after);
    const fieldBefore = this.signed.dict(fieldRef);
    const fieldAfter = this.full.dict(fieldRef);
    const fieldType = before ? this.signed.inherited(before, "FT") : this.full.inherited(after, "FT");
    const keys = diffKeys(before, after);
    for (const key of extra) {
      keys.add(key);
    }
    if (this.ownFields.has(ref) || this.ownFields.has(fieldRef)) {
      return keys.has("V") ? { kind: "signature-dictionary", detail: "its field's /V replaced" } : { kind: "other", detail: "the signed field changed" };
    }
    if (ACTION_KEYS.some((key) => keys.has(key) || (!before && after.has(PDFName.of(key))))) {
      return { kind: "other", detail: "an action on a field or widget" };
    }
    if (fieldType instanceof PDFName && fieldType.decodeText() === "Sig") {
      if (!before) {
        const outside = keysOf(after).filter((key) => !NEW_SIGNATURE_FIELD_KEYS.has(key));
        if (outside.length > 0) {
          return { kind: "other", detail: `new signature field ${slashed(outside)}` };
        }
        const kids = after.get(PDFName.of("Kids"));
        if (kids !== undefined) {
          const list = kids instanceof PDFArray ? kids : undefined;
          const valid = list?.asArray().every((kid) => kid instanceof PDFRef && this.isNew(kid) && this.full.name(this.full.dict(kid), "Subtype") === "Widget");
          if (!valid) {
            return { kind: "other", detail: "a new signature field's /Kids" };
          }
        }
        const parent = after.get(PDFName.of("Parent"));
        if (!after.has(PDFName.of("T")) && parent instanceof PDFRef) {
          // A widget joins a field through the field's /Kids, written with the signature; /Parent alone attaches nothing.
          const kidsValue = this.full.dict(parent)?.get(PDFName.of("Kids"));
          const listed = this.full.array(kidsValue)?.asArray().some((kid) => kid === ref) === true;
          if (!listed) {
            return { kind: "other", detail: "a widget attached only through /Parent" };
          }
          const seal = this.sealOf(parent);
          if (seal && kidsValue instanceof PDFRef && this.vouchedFor(kidsValue, seal, { kind: "signature-field" }).kind !== "signature-field") {
            return { kind: "other", detail: "outside the signature that would vouch for it" };
          }
        }
        return this.newSignatureValue(fieldRef, ref);
      }
      if (fieldBefore?.has(PDFName.of("V"))) {
        return { kind: "other", detail: "an earlier signature's field changed" };
      }
      const outside = [...keys].filter((key) => !SIGNATURE_FIELD_KEYS.has(key));
      if (outside.length > 0) {
        return { kind: "other", detail: `signature field ${slashed(outside)}` };
      }
      return this.newSignatureValue(fieldRef, ref);
    }
    if (!before) {
      return { kind: "other", detail: "a field added" };
    }
    const outside = [...keys].filter((key) => !FIELD_VALUE_KEYS.has(key) && !FIELD_APPEARANCE_KEYS.has(key));
    if (outside.length > 0) {
      return { kind: "other", detail: `field ${slashed(outside)}` };
    }
    const valueChanged = canonical(fieldBefore?.get(PDFName.of("V"))) !== canonical(fieldAfter?.get(PDFName.of("V")));
    if ([...keys].some((key) => FIELD_APPEARANCE_KEYS.has(key)) && !valueChanged) {
      return { kind: "other", detail: "an appearance changed without a new value" };
    }
    const flags = this.signed.inherited(fieldBefore, "Ff");
    if (flags instanceof PDFNumber && (flags.asNumber() & 1) === 1) {
      return { kind: "other", detail: "a read-only field's value" };
    }
    if (this.isLocked(this.roles.names.get(fieldRef))) {
      return { kind: "other", detail: "a locked field's value" };
    }
    return { kind: "field-value" };
  }

  /** A non-widget annotation: any change is an annotation change, unless it carries an action. */
  private annotationKind(before: PDFDict | undefined, after: PDFDict | undefined): Classified {
    if (!after) {
      return { kind: "other", detail: "an annotation that is no longer a dictionary" };
    }
    const keys = diffKeys(before, after);
    if (ACTION_KEYS.some((key) => keys.has(key) || (!before && after.has(PDFName.of(key))))) {
      return { kind: "other", detail: "an action on an annotation" };
    }
    return { kind: "annotation", ...(before === undefined ? { detail: "added" } : {}) };
  }

  /** A page dictionary: only its `/Annots` list may change. */
  private pageKinds(ref: PDFRef): Classified[] {
    const before = this.signed.dict(ref);
    const after = this.full.dict(ref);
    if (!before) {
      return [{ kind: "other", detail: "a page added" }];
    }
    if (!after) {
      return [{ kind: "other", detail: "a page removed" }];
    }
    const out: Classified[] = [];
    const keys = [...diffKeys(before, after)].filter((key) => key !== "Annots");
    if (keys.length > 0) {
      out.push({ kind: "other", detail: `page ${slashed(keys)}` });
    }
    const annotsBefore = this.signed.array(before.get(PDFName.of("Annots")));
    const annotsAfter = this.full.array(after.get(PDFName.of("Annots")));
    if (after.has(PDFName.of("Annots")) && !annotsAfter) {
      out.push({ kind: "other", detail: "page /Annots is not an array" });
    }
    if (canonical(annotsBefore) !== canonical(annotsAfter) || keys.length === 0) {
      out.push({ kind: "page-annots" }, ...this.listChanges(annotsBefore, annotsAfter, "annotation"));
    }
    return out;
  }

  /** A field's `/Kids` array: new widgets added to an empty signature field that gets signed is signing; anything else is not form filling. */
  private kidsKind(array: PDFRef, field: PDFRef, before: PDFObject | undefined, after: PDFObject | undefined): Classified {
    const fieldBefore = this.signed.dict(field);
    const fieldType = this.signed.inherited(fieldBefore, "FT");
    const beforeList = before instanceof PDFArray ? before.asArray() : [];
    const afterList = after instanceof PDFArray ? after.asArray() : undefined;
    const kept = (entry: PDFObject): boolean => afterList !== undefined && afterList.some((candidate) => canonical(candidate) === canonical(entry));
    const added = (afterList ?? []).filter((entry) => !beforeList.some((old) => canonical(old) === canonical(entry)));
    const onlyNewWidgets = added.every((entry) => entry instanceof PDFRef && this.isNew(entry) && this.full.name(this.full.dict(entry), "Subtype") === "Widget");
    if (fieldType instanceof PDFName && fieldType.decodeText() === "Sig" && fieldBefore && !fieldBefore.has(PDFName.of("V")) && beforeList.every(kept) && onlyNewWidgets && !this.ownFields.has(field)) {
      const signed = this.newSignatureValue(field, array);
      return signed.kind === "signature-field" ? { kind: "signature-field", detail: "widgets" } : signed;
    }
    return { kind: "other", detail: "a field's widgets" };
  }

  /** An object only an appearance, a signature, the DSS, the form's resources or the Info reaches: its owner's kind, the strictest when several. */
  private ownedKind(ref: PDFRef, owners: readonly Owner[]): Classified {
    let best: Classified | undefined;
    for (const owner of owners) {
      const classified = this.ownerKind(ref, owner);
      if (!best || rank(classified.kind) > rank(best.kind)) {
        best = classified;
      }
    }
    return best!;
  }

  /** The kind an owned object takes from its owner; one that leans on a seal must lie inside it. */
  private ownerKind(object: PDFRef, owner: Owner): Classified {
    switch (owner.type) {
      case "dss":
        return { kind: "dss" };
      case "resources":
        return { kind: "acroform", detail: "/DR" };
      case "info":
        return { kind: "info" };
      case "encrypt":
        return { kind: "other", detail: "encryption" };
      case "signature": {
        const classified = this.signatureKind(owner.signature, this.signed.lookup(owner.signature));
        return classified.kind === "signature-field" ? this.vouchedFor(object, owner.signature, classified) : classified;
      }
      case "appearance": {
        const ref = owner.annotation;
        const before = this.signed.dict(ref);
        const after = this.full.dict(ref);
        if (this.isFieldOrWidget(ref)) {
          const classified = this.fieldKind(ref, before, after, ["AP"]);
          if (classified.kind === "other" || classified.kind === "signature-dictionary") {
            return classified;
          }
          if (classified.kind === "signature-field") {
            const seal = this.sealOf(this.fieldOf(ref, (after ?? before)!));
            const vouched = seal ? this.vouchedFor(object, seal, classified) : { kind: "other" as const, detail: "a signature field without a new signature sealing its update" };
            if (vouched.kind !== "signature-field") {
              return vouched;
            }
          }
          return { ...classified, detail: "appearance" };
        }
        const classified = this.annotationKind(before, after);
        return classified.kind === "annotation" ? { kind: "annotation", detail: "appearance" } : classified;
      }
    }
  }
}

function slashed(keys: readonly string[]): string {
  return keys.map((key) => `/${key}`).join(" ");
}

function describe(object: PDFObject | undefined): string {
  if (object instanceof PDFDict) {
    return "dictionary";
  }
  if (object instanceof PDFArray) {
    return "array";
  }
  if (object instanceof PDFNumber) {
    return "number";
  }
  if (object instanceof PDFString || object instanceof PDFHexString) {
    return "string";
  }
  return "object";
}

/** "trailer" first, then object numbers. */
function order(ref: string): number {
  const number = Number.parseInt(ref, 10);
  return Number.isNaN(number) ? -1 : number;
}
