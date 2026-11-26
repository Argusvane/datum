/**
 * PDF/A: what turns a finished document into one that declares an archival level
 * and keeps the promise. Runs once every page is drawn and every widget has its appearance,
 * because fonts are frozen here: the pass embeds them (`flush`), then completes what pdf-lib
 * leaves out of a conforming file —
 *
 * - the output intent (`/OutputIntents`, `GTS_PDFA1`) with its ICC profile, and a `DefaultRGB`
 *   colour space on every page and appearance when that intent is not RGB, since everything
 *   the kernel draws is DeviceRGB;
 * - `CIDSet` and `Length1` on every embedded TrueType subset, `CIDSet` on every CFF one;
 * - appearance dictionaries with `/N` alone (pdf-lib writes `/D` for check boxes), an empty
 *   appearance for a widget without one, no `NeedAppearances`;
 * - (associated files — the submission data under part 3, uploaded files in any PDF — are
 *   `attachments.ts`'s, written before this pass);
 * - the XMP packet, equivalent to the Info dictionary, with `pdfaid:part` / `conformance`;
 * - for level "a", the check that the file is tagged and its language is a tag a reader can
 *   use — else the letter drops to "u", which the file then is by construction.
 *
 * pdf-lib's own `convertToPDFA()` is not used: its metadata sync goes through `Date`, which the
 * sandbox forbids, and it would run again on every save. Everything here is strings and
 * bytes, so the same request gives the same file on every host.
 */
import {
  PDFArray,
  PDFBool,
  PDFDict,
  PDFDocument,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
  extractForeignXmpDescriptions,
  getDefaultSRGBProfile
} from "@cantoo/pdf-lib";
import type { PdfAConformance } from "@argusvane/datum-engine/core";
import { PDF_BUILTIN_ASSET_STORAGE, pdfALevel, pdfAWithLevel, readIccColorSpace } from "@argusvane/datum-engine/core";
import type { PdfDocumentConformance, PdfKernelEnv, PdfOutputIntent, PdfWarning } from "@argusvane/datum-engine/render";
import { base64ToBytes } from "@argusvane/datum-engine/render";
import { builtinProfile } from "./profiles.js";
import { sha256Hex } from "./util/sha256.js";

const SRGB_IDENTIFIER = "sRGB IEC61966-2.1";
const SRGB_REGISTRY = "http://www.color.org";
const XPACKET_ID = "W5M0MpCehiHzreSzNTczkc9d";

export interface PdfAOptions {
  /** The level to declare. */
  claim: PdfAConformance;
  /** The output condition, as the model carries it. Associated files are `attachments.ts`'s, written before this pass. */
  conformance: Pick<PdfDocumentConformance, "outputIntent">;
  env: PdfKernelEnv;
  warnings: PdfWarning[];
}

/** ISO 19005 part of a level. */
export function pdfAPartOf(level: PdfAConformance): 1 | 2 | 3 {
  return Number(level[0]) as 1 | 2 | 3;
}

/** The XMP packet the catalog carries, decoded; `undefined` when there is none. */
export function readMetadataXml(pdf: PDFDocument): string | undefined {
  const stream = pdf.catalog.lookupMaybe(PDFName.of("Metadata"), PDFStream);
  if (!stream) {
    return undefined;
  }
  const bytes = stream instanceof PDFRawStream ? decodePDFRawStream(stream).decode() : stream.getContents();
  return new TextDecoder("utf-8").decode(bytes);
}

/**
 * The PDF/A level a loaded document declares in its XMP, in the ABI's spelling (`"2b"`). The
 * kernel's own reading: pdf-lib's `parsePDFAConformanceFromXmp` knows the letters B and U only.
 */
export function declaredPdfA(pdf: PDFDocument): PdfAConformance | undefined {
  const xml = readMetadataXml(pdf);
  if (!xml) {
    return undefined;
  }
  const part = /<pdfaid:part(?:\s[^>]*)?>\s*([123])\s*<\/pdfaid:part>/.exec(xml) ?? /\bpdfaid:part\s*=\s*["']([123])["']/.exec(xml);
  const letter = /<pdfaid:conformance(?:\s[^>]*)?>\s*([ABUabu])\s*<\/pdfaid:conformance>/.exec(xml) ?? /\bpdfaid:conformance\s*=\s*["']([ABUabu])["']/.exec(xml);
  if (!part || !letter) {
    return undefined;
  }
  const level = `${part[1]}${letter[1]!.toLowerCase()}`;
  return part[1] === "1" && level === "1u" ? undefined : (level as PdfAConformance);
}

/** The colour components an ICC profile describes, from its header; `undefined` when the bytes are not a profile. */
export function iccComponents(bytes: Uint8Array): 1 | 3 | 4 | undefined {
  return readIccColorSpace(bytes);
}

/** A language tag as PDF/A reads one (RFC 3066 syntax, or empty for "unknown") — the test veraPDF runs on `/Lang`. */
export function isLanguageTag(value: string): boolean {
  return value === "" || /^[a-zA-Z]{1,8}(-[a-zA-Z0-9]{1,8})*$/.test(value);
}

/**
 * Level "a" is a promise about the whole file: a structure tree, `MarkInfo`, a language a
 * reader can use. When the document keeps it, the claim stands; otherwise the letter drops
 * to "u" (a level-"a" file is level-"u" by construction) and `pdfa.level` says why.
 */
function accessibleClaim(pdf: PDFDocument, claim: PdfAConformance, warnings: PdfWarning[]): PdfAConformance {
  if (pdfALevel(claim) !== "a") {
    return claim;
  }
  const demote = (reason: string): PdfAConformance => {
    const level = pdfAWithLevel(claim, "u");
    warnings.push({ code: "pdfa.level", message: `PDF/A-${claim} was asked for, but ${reason}; the document declares PDF/A-${level}.` });
    return level;
  };
  if (!pdf.catalog.has(PDFName.of("StructTreeRoot"))) {
    return demote("the document has no structure tree");
  }
  const marked = pdf.catalog.lookupMaybe(PDFName.of("MarkInfo"), PDFDict)?.lookup(PDFName.of("Marked"));
  if (!(marked instanceof PDFBool) || !marked.asBoolean()) {
    return demote("the document is not marked as tagged");
  }
  const lang = pdf.catalog.lookupMaybe(PDFName.of("Lang"), PDFString, PDFHexString);
  if (lang && !isLanguageTag(lang.decodeText())) {
    return demote(`its language "${lang.decodeText()}" is not a language tag`);
  }
  return claim;
}

function xmlEscape(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/**
 * A PDF date (`D:YYYYMMDDHHmmSS`, then `Z` or `±HH'mm'`) as the XMP ISO 8601 form — the two
 * must name the same instant. `undefined` for a string that is not a PDF date.
 */
export function pdfDateToXmp(value: string): string | undefined {
  const match = /^D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(?:(Z)|([+-])(\d{2})'?(\d{2})?'?)?/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  const [, year, month = "01", day = "01", hour = "00", minute = "00", second = "00", utc, sign, offsetHour, offsetMinute = "00"] = match;
  const zone = utc || !sign ? "Z" : `${sign}${offsetHour}:${offsetMinute}`;
  return `${year}-${month}-${day}T${hour}:${minute}:${second}${zone}`;
}

function infoText(info: PDFDict | undefined, key: string): string | undefined {
  const value = info?.lookup(PDFName.of(key));
  if (value instanceof PDFString || value instanceof PDFHexString) {
    return value.decodeText();
  }
  return undefined;
}

/**
 * The XMP packet for a document at a level, mirroring the Info dictionary key for key (PDF/A
 * asks that the two agree), foreign descriptions the file already carried kept as they were.
 */
export function buildXmpPacket(pdf: PDFDocument, claim: PdfAConformance, warnings: PdfWarning[]): string {
  const infoRef = pdf.context.trailerInfo.Info;
  const info = infoRef ? pdf.context.lookupMaybe(infoRef, PDFDict) : undefined;
  const date = (key: string): string | undefined => {
    const raw = infoText(info, key);
    if (raw === undefined) {
      return undefined;
    }
    const iso = pdfDateToXmp(raw);
    if (iso === undefined) {
      // An Info date XMP cannot mirror would leave the two in disagreement; the entry goes.
      info?.delete(PDFName.of(key));
      warnings.push({ code: "pdfa.info", message: `The document's ${key} ("${raw}") is not a PDF date and was dropped so the metadata stays consistent.` });
    }
    return iso;
  };
  const title = infoText(info, "Title");
  const author = infoText(info, "Author");
  const subject = infoText(info, "Subject");
  const keywords = infoText(info, "Keywords");
  const creator = infoText(info, "Creator");
  const producer = infoText(info, "Producer");
  const created = date("CreationDate");
  const modified = date("ModDate");

  const dc = ["<dc:format>application/pdf</dc:format>"];
  if (title !== undefined) {
    dc.push(`<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(title)}</rdf:li></rdf:Alt></dc:title>`);
  }
  if (author !== undefined) {
    dc.push(`<dc:creator><rdf:Seq><rdf:li>${xmlEscape(author)}</rdf:li></rdf:Seq></dc:creator>`);
  }
  if (subject !== undefined) {
    dc.push(`<dc:description><rdf:Alt><rdf:li xml:lang="x-default">${xmlEscape(subject)}</rdf:li></rdf:Alt></dc:description>`);
  }
  const xmp: string[] = [];
  if (creator !== undefined) {
    xmp.push(`<xmp:CreatorTool>${xmlEscape(creator)}</xmp:CreatorTool>`);
  }
  if (created !== undefined) {
    xmp.push(`<xmp:CreateDate>${created}</xmp:CreateDate>`);
  }
  if (modified !== undefined) {
    xmp.push(`<xmp:ModifyDate>${modified}</xmp:ModifyDate>`, `<xmp:MetadataDate>${modified}</xmp:MetadataDate>`);
  }
  const pdfNs: string[] = [];
  if (producer !== undefined) {
    pdfNs.push(`<pdf:Producer>${xmlEscape(producer)}</pdf:Producer>`);
  }
  if (keywords !== undefined) {
    pdfNs.push(`<pdf:Keywords>${xmlEscape(keywords)}</pdf:Keywords>`);
  }

  const descriptions = [`<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">${dc.join("")}</rdf:Description>`];
  if (xmp.length > 0) {
    descriptions.push(`<rdf:Description rdf:about="" xmlns:xmp="http://ns.adobe.com/xap/1.0/">${xmp.join("")}</rdf:Description>`);
  }
  if (pdfNs.length > 0) {
    descriptions.push(`<rdf:Description rdf:about="" xmlns:pdf="http://ns.adobe.com/pdf/1.3/">${pdfNs.join("")}</rdf:Description>`);
  }
  descriptions.push(
    `<rdf:Description rdf:about="" xmlns:pdfaid="http://www.aiim.org/pdfa/ns/id/"><pdfaid:part>${pdfAPartOf(claim)}</pdfaid:part><pdfaid:conformance>${claim[1]!.toUpperCase()}</pdfaid:conformance></rdf:Description>`
  );
  const existing = readMetadataXml(pdf);
  if (existing) {
    descriptions.push(...extractForeignXmpDescriptions(existing));
  }
  return (
    `<?xpacket begin="\uFEFF" id="${XPACKET_ID}"?>\n` +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="Datum PDF kernel">\n' +
    '<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    descriptions.join("\n") +
    "\n</rdf:RDF>\n</x:xmpmeta>\n" +
    '<?xpacket end="w"?>'
  );
}

/** Writes the packet as the catalog's `/Metadata`: unfiltered, as PDF/A asks, reusing the stream's ref when there is one. */
function writeMetadata(pdf: PDFDocument, xml: string): void {
  const context = pdf.context;
  const stream = context.stream(new TextEncoder().encode(xml), { Type: "Metadata", Subtype: "XML" });
  const existing = pdf.catalog.get(PDFName.of("Metadata"));
  if (existing instanceof PDFRef) {
    context.assign(existing, stream);
  } else {
    pdf.catalog.set(PDFName.of("Metadata"), context.register(stream));
  }
}

function ensureTrailerId(pdf: PDFDocument, env: PdfKernelEnv): void {
  const context = pdf.context;
  if (context.trailerInfo.ID && context.lookup(context.trailerInfo.ID)) {
    return;
  }
  const id = sha256Hex(env.documentId).slice(0, 32);
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
}

export interface Intent {
  components: number;
  /** The intent's own ICC stream, for `DefaultRGB` when it is RGB. */
  profileRef: PDFRef;
}

/** The PDF/A output intent the document carries, if any. */
export function existingIntent(pdf: PDFDocument): Intent | undefined {
  const intents = pdf.catalog.lookupMaybe(PDFName.of("OutputIntents"), PDFArray);
  if (!intents) {
    return undefined;
  }
  for (let i = 0; i < intents.size(); i += 1) {
    const intent = intents.lookupMaybe(i, PDFDict);
    const subtype = intent?.lookup(PDFName.of("S"));
    if (!intent || !(subtype instanceof PDFName) || subtype.decodeText() !== "GTS_PDFA1") {
      continue;
    }
    const profileRef = intent.get(PDFName.of("DestOutputProfile"));
    const profile = intent.lookupMaybe(PDFName.of("DestOutputProfile"), PDFStream);
    const n = profile?.dict.lookupMaybe(PDFName.of("N"), PDFNumber);
    if (profileRef instanceof PDFRef && n) {
      return { components: n.asNumber(), profileRef };
    }
    return { components: 3, profileRef: profileRef instanceof PDFRef ? profileRef : pdf.context.register(profile ?? pdf.context.obj({})) };
  }
  return undefined;
}

/** The configured profile as bytes and components, or nothing (with a warning) when it cannot be used. */
function configuredProfile(intent: PdfOutputIntent | undefined, warnings: PdfWarning[]): { bytes: Uint8Array; components: 1 | 3 | 4 } | undefined {
  if (!intent) {
    return undefined;
  }
  let bytes: Uint8Array;
  if ("data" in intent.profile) {
    try {
      bytes = base64ToBytes(intent.profile.data);
    } catch {
      bytes = new Uint8Array(0);
    }
  } else {
    // A built-in profile is the kernel's own; anything else had to be resolved before the request.
    const { source } = intent.profile;
    const builtin = source.storage === PDF_BUILTIN_ASSET_STORAGE && typeof source.ref === "string" ? builtinProfile(source.ref) : undefined;
    if (!builtin) {
      warnings.push({
        code: "pdfa.outputIntent",
        message:
          source.storage === PDF_BUILTIN_ASSET_STORAGE
            ? `The output intent names a built-in profile "${String(source.ref)}" this kernel does not carry; the document declares ${SRGB_IDENTIFIER} instead.`
            : `The output intent profile "${source.name}" reached the kernel unresolved (storage "${source.storage}"); the document declares ${SRGB_IDENTIFIER} instead.`
      });
      return undefined;
    }
    bytes = builtin;
  }
  const components = iccComponents(bytes);
  if (components === undefined) {
    warnings.push({ code: "pdfa.outputIntent", message: `The output intent profile for "${intent.identifier}" is not an ICC profile; the document declares ${SRGB_IDENTIFIER} instead.` });
    return undefined;
  }
  return { bytes, components };
}

/** Declares the output intent: the configured one, else sRGB; an existing PDF/A intent (a template's) stays. */
function writeOutputIntent(pdf: PDFDocument, configured: PdfOutputIntent | undefined, warnings: PdfWarning[]): Intent {
  const present = existingIntent(pdf);
  if (present) {
    if (configured) {
      warnings.push({ code: "pdfa.outputIntent", message: "The document already declares a PDF/A output intent, which stays; the configured one was not applied." });
    }
    return present;
  }
  const context = pdf.context;
  const custom = configuredProfile(configured, warnings);
  const bytes = custom?.bytes ?? getDefaultSRGBProfile();
  const components = custom?.components ?? 3;
  const profileRef = context.register(context.flateStream(bytes, { N: components }));
  const identifier = custom ? configured!.identifier : SRGB_IDENTIFIER;
  const info = custom ? configured!.info : SRGB_IDENTIFIER;
  const registry = custom ? configured!.registry : SRGB_REGISTRY;
  const intent = context.obj({
    Type: "OutputIntent",
    S: "GTS_PDFA1",
    OutputConditionIdentifier: PDFString.of(identifier),
    Info: PDFString.of(info),
    ...(registry ? { RegistryName: PDFString.of(registry) } : {}),
    DestOutputProfile: profileRef
  });
  pdf.catalog.set(PDFName.of("OutputIntents"), context.obj([context.register(intent)]));
  return { components, profileRef };
}

/** `/Resources` of a page or stream dictionary, made when absent. */
function resourcesOf(dict: PDFDict, context: PDFDocument["context"]): PDFDict {
  let resources = dict.lookupMaybe(PDFName.of("Resources"), PDFDict);
  if (!resources) {
    resources = context.obj({});
    dict.set(PDFName.of("Resources"), resources);
  }
  return resources;
}

/** Every appearance stream an annotation carries under `/N` (one stream, or one per state). */
function normalAppearances(annotation: PDFDict, context: PDFDocument["context"]): PDFStream[] {
  const ap = annotation.lookupMaybe(PDFName.of("AP"), PDFDict);
  const normal = ap?.lookup(PDFName.of("N"));
  if (normal instanceof PDFStream) {
    return [normal];
  }
  if (normal instanceof PDFDict) {
    return normal
      .entries()
      .map(([, value]) => context.lookupMaybe(value, PDFStream))
      .filter((stream): stream is PDFStream => stream !== undefined);
  }
  return [];
}

function annotationsOf(pdf: PDFDocument): PDFDict[] {
  const out: PDFDict[] = [];
  for (const page of pdf.getPages()) {
    const annots = page.node.Annots();
    if (!annots) {
      continue;
    }
    for (let i = 0; i < annots.size(); i += 1) {
      const annotation = annots.lookupMaybe(i, PDFDict);
      if (annotation) {
        out.push(annotation);
      }
    }
  }
  return out;
}

/**
 * Under a Gray or CMYK intent, DeviceRGB is allowed where a `DefaultRGB` colour space names
 * what it means: every page and every appearance stream gets one that is sRGB.
 */
function declareDefaultRgb(pdf: PDFDocument): void {
  const context = pdf.context;
  const srgb = context.register(context.flateStream(getDefaultSRGBProfile(), { N: 3, Alternate: "DeviceRGB" }));
  const colorSpace = context.obj(["ICCBased", srgb]);
  const declare = (dict: PDFDict): void => {
    const resources = resourcesOf(dict, context);
    let spaces = resources.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
    if (!spaces) {
      spaces = context.obj({});
      resources.set(PDFName.of("ColorSpace"), spaces);
    }
    if (!spaces.has(PDFName.of("DefaultRGB"))) {
      spaces.set(PDFName.of("DefaultRGB"), colorSpace);
    }
  };
  for (const page of pdf.getPages()) {
    declare(page.node);
  }
  for (const annotation of annotationsOf(pdf)) {
    for (const stream of normalAppearances(annotation, context)) {
      declare(stream.dict);
    }
  }
}

/** `numGlyphs` from a TrueType program's `maxp` table; `undefined` when the bytes are not one. */
export function trueTypeGlyphCount(program: Uint8Array): number | undefined {
  if (program.length < 12) {
    return undefined;
  }
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const tables = view.getUint16(4);
  for (let i = 0; i < tables; i += 1) {
    const record = 12 + i * 16;
    if (record + 16 > program.length) {
      return undefined;
    }
    const tag = String.fromCharCode(program[record]!, program[record + 1]!, program[record + 2]!, program[record + 3]!);
    if (tag === "maxp") {
      const offset = view.getUint32(record + 8);
      return offset + 6 <= program.length ? view.getUint16(offset + 4) : undefined;
    }
  }
  return undefined;
}

/** A `CIDSet` bitmap: one bit per CID, set for every glyph the subset program holds (CIDs are GIDs, `CIDToGIDMap /Identity`). */
export function cidSetBitmap(glyphCount: number): Uint8Array {
  const bitmap = new Uint8Array(Math.ceil(glyphCount / 8));
  for (let cid = 0; cid < glyphCount; cid += 1) {
    bitmap[cid >> 3]! |= 0x80 >> (cid & 7);
  }
  return bitmap;
}

/** A CFF INDEX at `offset`: its item count and where the next structure starts; `undefined` when it does not fit. */
function cffIndex(view: DataView, offset: number): { count: number; end: number; items: Array<[number, number]> } | undefined {
  if (offset + 2 > view.byteLength) {
    return undefined;
  }
  const count = view.getUint16(offset);
  if (count === 0) {
    return { count, end: offset + 2, items: [] };
  }
  const offSize = view.getUint8(offset + 2);
  if (offSize < 1 || offSize > 4 || offset + 3 + (count + 1) * offSize > view.byteLength) {
    return undefined;
  }
  const readOffset = (index: number): number => {
    let value = 0;
    for (let i = 0; i < offSize; i += 1) {
      value = (value << 8) | view.getUint8(offset + 3 + index * offSize + i);
    }
    return value >>> 0;
  };
  const base = offset + 3 + (count + 1) * offSize - 1;
  const items: Array<[number, number]> = [];
  for (let i = 0; i < count; i += 1) {
    items.push([base + readOffset(i), base + readOffset(i + 1)]);
  }
  const end = base + readOffset(count);
  return end <= view.byteLength ? { count, end, items } : undefined;
}

/** The operand of a DICT operator: the last number before it, decoded as CFF spells integers (32–246, 247–254, 28, 29). */
function cffDictOperand(view: DataView, start: number, end: number, operator: number): number | undefined {
  const operands: number[] = [];
  let at = start;
  while (at < end) {
    const b0 = view.getUint8(at);
    if (b0 <= 21) {
      const op = b0 === 12 ? 1200 + view.getUint8(at + 1) : b0;
      at += b0 === 12 ? 2 : 1;
      if (op === operator) {
        return operands[operands.length - 1];
      }
      operands.length = 0;
    } else if (b0 === 28) {
      operands.push(view.getInt16(at + 1));
      at += 3;
    } else if (b0 === 29) {
      operands.push(view.getInt32(at + 1));
      at += 5;
    } else if (b0 === 30) {
      // A real number: nibbles to 0xf; its value is not one this reader needs.
      at += 1;
      while (at < end && (view.getUint8(at) & 0x0f) !== 0x0f && (view.getUint8(at) >> 4) !== 0x0f) {
        at += 1;
      }
      at += 1;
      operands.push(0);
    } else if (b0 >= 32 && b0 <= 246) {
      operands.push(b0 - 139);
      at += 1;
    } else if (b0 >= 247 && b0 <= 250) {
      operands.push((b0 - 247) * 256 + view.getUint8(at + 1) + 108);
      at += 2;
    } else if (b0 >= 251 && b0 <= 254) {
      operands.push(-(b0 - 251) * 256 - view.getUint8(at + 1) - 108);
      at += 2;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/**
 * The glyph count of a bare CFF program (`FontFile3` / `CIDFontType0C`): header → Name INDEX
 * → Top DICT INDEX → the `CharStrings` operator (17) → that INDEX's count. `undefined` when
 * the bytes are not a CFF.
 */
export function cffGlyphCount(program: Uint8Array): number | undefined {
  if (program.length < 4 || program[0] !== 1) {
    return undefined;
  }
  const view = new DataView(program.buffer, program.byteOffset, program.byteLength);
  const names = cffIndex(view, program[2]!);
  const topDicts = names ? cffIndex(view, names.end) : undefined;
  const top = topDicts?.items[0];
  if (!top) {
    return undefined;
  }
  const charStrings = cffDictOperand(view, top[0], top[1], 17);
  if (charStrings === undefined || charStrings < 0) {
    return undefined;
  }
  return cffIndex(view, charStrings)?.count;
}

/**
 * Completes every embedded font descriptor: `Length1` (the program's length) and `CIDSet`
 * for a TrueType subset (`FontFile2`), `CIDSet` alone for a CFF one (`FontFile3`, whose
 * program carries its own length). A `CIDToGIDMap` on a `CIDFontType0` — meaningless there,
 * and pdf-lib writes one — goes.
 */
export function completeFontDescriptors(pdf: PDFDocument, warnings: PdfWarning[]): void {
  const context = pdf.context;
  for (const [, object] of context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFDict)) {
      continue;
    }
    const type = object.lookup(PDFName.of("Type"));
    const subtype = object.lookup(PDFName.of("Subtype"));
    if (type instanceof PDFName && type.decodeText() === "Font" && subtype instanceof PDFName && subtype.decodeText() === "CIDFontType0") {
      object.delete(PDFName.of("CIDToGIDMap"));
      continue;
    }
    if (!(type instanceof PDFName) || type.decodeText() !== "FontDescriptor") {
      continue;
    }
    const trueType = object.lookupMaybe(PDFName.of("FontFile2"), PDFStream);
    const cff = trueType ? undefined : object.lookupMaybe(PDFName.of("FontFile3"), PDFStream);
    const file = trueType ?? cff;
    if (!(file instanceof PDFRawStream)) {
      continue;
    }
    const program = decodePDFRawStream(file).decode();
    if (trueType && !file.dict.has(PDFName.of("Length1"))) {
      file.dict.set(PDFName.of("Length1"), PDFNumber.of(program.length));
    }
    if (object.has(PDFName.of("CIDSet"))) {
      continue;
    }
    // A `FontFile3` is a bare CFF (`CIDFontType0C`), or an OpenType wrapper (`OpenType`) with a maxp table.
    const glyphs = trueType ? trueTypeGlyphCount(program) : (cffGlyphCount(program) ?? trueTypeGlyphCount(program));
    if (glyphs === undefined) {
      const name = object.lookup(PDFName.of("FontName"));
      warnings.push({
        code: "pdfa.font",
        message: `The font program of "${name instanceof PDFName ? name.decodeText() : "?"}" has no ${trueType ? "maxp table" : "CharStrings"}; no CIDSet was written.`
      });
      continue;
    }
    object.set(PDFName.of("CIDSet"), context.register(context.flateStream(cidSetBitmap(glyphs))));
  }
}

/** Appearance dictionaries carry `/N` alone; a widget without one gets an empty appearance; `NeedAppearances` goes. */
function completeAnnotations(pdf: PDFDocument): void {
  const context = pdf.context;
  for (const annotation of annotationsOf(pdf)) {
    const ap = annotation.lookupMaybe(PDFName.of("AP"), PDFDict);
    if (ap) {
      ap.delete(PDFName.of("D"));
      ap.delete(PDFName.of("R"));
      continue;
    }
    const subtype = annotation.lookup(PDFName.of("Subtype"));
    if (!(subtype instanceof PDFName) || subtype.decodeText() !== "Widget") {
      continue;
    }
    const rect = annotation.lookupMaybe(PDFName.of("Rect"), PDFArray);
    const numbers = rect ? rect.asArray().map((entry) => (entry instanceof PDFNumber ? entry.asNumber() : 0)) : [0, 0, 0, 0];
    const width = Math.abs((numbers[2] ?? 0) - (numbers[0] ?? 0));
    const height = Math.abs((numbers[3] ?? 0) - (numbers[1] ?? 0));
    const empty = context.register(context.formXObject([], { BBox: [0, 0, width, height], Resources: {} }));
    annotation.set(PDFName.of("AP"), context.obj({ N: empty }));
  }
  const acroForm = pdf.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  acroForm?.delete(PDFName.of("NeedAppearances"));
}

/**
 * Makes the finished document declare `claim` and hold to it. Call after the last drawing
 * operation and the last appearance update, before `save`. Returns the level declared: the
 * one asked for, or its "u" when level "a" was asked of a document that is not tagged.
 */
export async function applyPdfA(pdf: PDFDocument, options: PdfAOptions): Promise<PdfAConformance> {
  const { conformance, env, warnings } = options;
  const claim = accessibleClaim(pdf, options.claim, warnings);
  ensureTrailerId(pdf, env);
  const intent = writeOutputIntent(pdf, conformance.outputIntent, warnings);
  // Fonts are embedded here — after this nothing may draw, since a subset is what it is.
  await pdf.flush();
  completeFontDescriptors(pdf, warnings);
  completeAnnotations(pdf);
  if (intent.components !== 3) {
    // After the annotations pass, so the appearances it made are covered too.
    declareDefaultRgb(pdf);
  }
  writeMetadata(pdf, buildXmpPacket(pdf, claim, warnings));
  return claim;
}
