/**
 * Existing PDFs: fill one's AcroForm fields from resolved values, draw answers
 * into its areas, or list its fields. Every pdf-lib call for a template's fields is
 * here; areas draw through the writer.
 *
 * A PDF/A template stays PDF/A through the fill: the claim is the template's own
 * (its part raised to 3 when the layout asks for that, its level letter kept), appearance
 * fonts are always embedded, nothing is left to the viewer, and the conformance pass finishes
 * the file. Under level "a" the areas drawn and the widgets made join the template's
 * structure tree. A template that declares nothing is filled as any PDF, whatever the layout asks.
 */
import {
  PDFArray,
  PDFBool,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFOptionList,
  PDFRadioGroup,
  PDFRawStream,
  PDFRef,
  PDFString,
  PDFTextField,
  StandardFonts,
  type PDFField,
  type PDFFont,
  type PDFForm,
  type PDFObject,
  type PDFPageLeaf,
  type PDFWidgetAnnotation
} from "@cantoo/pdf-lib";
import { readEmbeddedFiles } from "./embedded-files.js";
import * as fontkit from "fontkit";
import { PdfKernelError, base64ToBytes } from "@argusvane/datum-engine/render";
import type { PdfAConformance, PdfAttachmentPolicy, PdfTemplateFillOptions } from "@argusvane/datum-engine/core";
import { MAX_PDF_TEMPLATE_BYTES, pdfALevel, pdfAWithLevel } from "@argusvane/datum-engine/core";
import type {
  PdfAreaReport,
  PdfDocumentAttachment,
  PdfDocumentConformance,
  PdfFillArea,
  PdfFillReport,
  PdfFillValue,
  PdfFontResource,
  PdfKernelEnv,
  PdfTemplateFieldInfo,
  PdfTemplateInfo,
  PdfTemplatePermissions,
  PdfWarning, PdfThemeColors, PdfTypography } from "@argusvane/datum-engine/render";
import { drawAreas } from "./areas.js";
import { pageSpace, userRectToDisplay } from "./page-space.js";
import { embedAttachments } from "./attachments.js";
import { applyPdfA, declaredPdfA, pdfAPartOf } from "./pdfa.js";
import { findSignatureFields } from "./signature/field.js";
import { ExistingTagging } from "./tagging.js";
import { asText, truthy } from "./util/fill-value.js";
import { pdfDateString } from "./writer.js";

export interface FilledTemplate {
  bytes: Uint8Array;
  pageCount: number;
  fields: PdfFillReport[];
  areas: PdfAreaReport[];
  warnings: PdfWarning[];
  /** The PDF/A level the filled document declares, when it does. */
  pdfa?: PdfAConformance;
  /** The embedded files' names as written; absent when none were asked for. */
  attachments?: string[];
}

/**
 * The words a reader announces for a field (`/TU`): in many fillable PDFs the only
 * readable name a field has, where its name is `Text1` or a path of subforms.
 */
function fieldTooltip(field: PDFField): string | undefined {
  const value = field.acroField.dict.lookup(PDFName.of("TU"));
  const text = value instanceof PDFString || value instanceof PDFHexString ? value.decodeText().trim() : "";
  return text === "" ? undefined : text;
}

function kindOf(field: PDFField): PdfTemplateFieldInfo["kind"] {
  if (field instanceof PDFTextField) {
    return "text";
  }
  if (field instanceof PDFCheckBox) {
    return "checkbox";
  }
  if (field instanceof PDFRadioGroup) {
    return "radio";
  }
  if (field instanceof PDFDropdown) {
    return "dropdown";
  }
  if (field instanceof PDFOptionList) {
    return "listbox";
  }
  const type = field.acroField.dict.lookup(PDFName.of("FT"));
  const name = type instanceof PDFName ? type.decodeText() : "";
  return name === "Sig" ? "signature" : name === "Btn" ? "button" : "unknown";
}

/** How far two widget rectangles may differ, in points, and still be the same box. */
const RECT_EPSILON = 0.01;

interface WidgetRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** One widget annotation a page lists: where it sits in `/Annots`, and what it says about itself. */
interface PageWidgetEntry {
  position: number;
  ref: PDFRef | undefined;
  rect: WidgetRect | undefined;
  /** Its own `/T`, when the field and the widget are one dictionary. */
  name: string | undefined;
  /** Its `/Parent`, when the widget is a kid. */
  parent: PDFRef | undefined;
}

/** A page's widgets, indexed for placing a field's own. */
interface PageWidgets {
  /** 1-based, as the ABI reports pages. */
  index: number;
  ref: PDFRef;
  node: PDFPageLeaf;
  annots: PDFArray | undefined;
  entries: PageWidgetEntry[];
}

/** Where a widget was found (or, `entry` absent, inferred) to belong. */
interface WidgetPlacement {
  page: PageWidgets;
  /** The page's own listing of this widget — or of a stray copy of it. */
  entry?: PageWidgetEntry;
}

function rectOf(dict: PDFDict): WidgetRect | undefined {
  const array = dict.lookupMaybe(PDFName.of("Rect"), PDFArray);
  try {
    return array?.asRectangle();
  } catch {
    return undefined;
  }
}

function sameRect(a: WidgetRect, b: WidgetRect): boolean {
  return Math.abs(a.x - b.x) <= RECT_EPSILON && Math.abs(a.y - b.y) <= RECT_EPSILON && Math.abs(a.width - b.width) <= RECT_EPSILON && Math.abs(a.height - b.height) <= RECT_EPSILON;
}

function textOf(dict: PDFDict, key: string): string | undefined {
  const value = dict.lookupMaybe(PDFName.of(key), PDFString, PDFHexString);
  return value?.decodeText();
}

function refOf(dict: PDFDict, key: string): PDFRef | undefined {
  const value = dict.get(PDFName.of(key));
  return value instanceof PDFRef ? value : undefined;
}

/** Every page's `/Annots`, the widgets among them read once. */
function indexPageWidgets(pdf: PDFDocument): PageWidgets[] {
  return pdf.getPages().map((page, index) => {
    const annots = page.node.Annots();
    const entries: PageWidgetEntry[] = [];
    for (let position = 0; annots && position < annots.size(); position += 1) {
      const raw = annots.get(position);
      const ref = raw instanceof PDFRef ? raw : undefined;
      const dict = ref ? pdf.context.lookupMaybe(ref, PDFDict) : raw instanceof PDFDict ? raw : undefined;
      if (!dict || dict.get(PDFName.of("Subtype")) !== PDFName.of("Widget")) {
        continue;
      }
      entries.push({ position, ref, rect: rectOf(dict), name: textOf(dict, "T"), parent: refOf(dict, "Parent") });
    }
    return { index: index + 1, ref: page.ref, node: page.node, annots, entries };
  });
}

/**
 * Widget placement: which page a field's widget is on. A widget in a page's `/Annots` is
 * there; one with `/P` is where it says. Some producers leave neither — macOS re-saves a form
 * with two copies of every widget, the page listing one and the field the other, so a widget
 * is also placed by its *shape*: a page widget with the same rectangle that names the same
 * field (its `/T`, or its `/Parent` for a kid) is taken to be its copy. On one page, a widget
 * with a rectangle is on that page.
 */
class WidgetPlacer {
  private readonly pages: PageWidgets[];
  private readonly refs = new Map<PDFObject, PDFRef>();
  private readonly byRef = new Map<string, WidgetPlacement>();
  /** The refs of every field's own widgets: a page entry among them is nobody's stray copy. */
  private readonly owned = new Set<string>();

  constructor(pdf: PDFDocument, form: PDFForm) {
    this.pages = indexPageWidgets(pdf);
    for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
      this.refs.set(object, ref);
    }
    for (const page of this.pages) {
      for (const entry of page.entries) {
        if (entry.ref && !this.byRef.has(entry.ref.toString())) {
          this.byRef.set(entry.ref.toString(), { page, entry });
        }
      }
    }
    for (const field of form.getFields()) {
      for (const widget of field.acroField.getWidgets()) {
        const ref = this.refOfWidget(widget, field);
        if (ref) {
          this.owned.add(ref.toString());
        }
      }
    }
  }

  /** The widget's own ref: its dictionary's, or the field's when the two are one. */
  refOfWidget(widget: PDFWidgetAnnotation, field: PDFField): PDFRef | undefined {
    return this.refs.get(widget.dict) ?? (widget.dict === field.acroField.dict ? field.ref : undefined);
  }

  /** The page listing this very widget, if one does. */
  listed(widget: PDFWidgetAnnotation, field: PDFField): WidgetPlacement | undefined {
    const ref = this.refOfWidget(widget, field);
    return ref ? this.byRef.get(ref.toString()) : undefined;
  }

  place(widget: PDFWidgetAnnotation, field: PDFField): WidgetPlacement | undefined {
    const listed = this.listed(widget, field);
    if (listed) {
      return listed;
    }
    const p = widget.P();
    const own = p ? this.pages.find((page) => page.ref.toString() === p.toString()) : undefined;
    if (own) {
      return { page: own };
    }
    const rect = rectOf(widget.dict);
    if (!rect) {
      return undefined;
    }
    const name = field.acroField.getPartialName();
    const fieldRef = field.ref.toString();
    for (const page of this.pages) {
      for (const entry of page.entries) {
        if (!entry.rect || !sameRect(entry.rect, rect) || (entry.ref && this.owned.has(entry.ref.toString()))) {
          continue;
        }
        const named = entry.parent ? entry.parent.toString() === fieldRef : entry.name !== undefined ? entry.name === name : true;
        if (named) {
          return { page, entry };
        }
      }
    }
    return this.pages.length === 1 ? { page: this.pages[0]! } : undefined;
  }

  /** The widget takes the place found for it: its copy's slot in the page's `/Annots`, or a new one. */
  claim(placement: WidgetPlacement, ref: PDFRef): void {
    const { page, entry } = placement;
    if (entry) {
      page.annots!.set(entry.position, ref);
      entry.ref = ref;
    } else {
      page.node.addAnnot(ref);
      page.entries.push({ position: page.node.Annots()!.size() - 1, ref, rect: undefined, name: undefined, parent: undefined });
    }
    this.byRef.set(ref.toString(), placement);
    this.owned.add(ref.toString());
  }
}

/** Whether the catalog's AcroForm carries XFA — asked before `getForm()`, which removes it. */
function hasXfa(pdf: PDFDocument): boolean {
  return pdf.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)?.has(PDFName.of("XFA")) ?? false;
}

/** Whether `value` is an action dictionary whose type is JavaScript, anywhere along its `/Next` chain. */
function isJavaScriptAction(value: unknown, depth = 0): boolean {
  if (!(value instanceof PDFDict) || depth > 16) {
    return false;
  }
  if (value.lookupMaybe(PDFName.of("S"), PDFName)?.asString() === "/JavaScript") {
    return true;
  }
  const next = value.lookup(PDFName.of("Next"));
  if (next instanceof PDFArray) {
    // PDFArray.lookup resolves a reference through the document's context (its `context` is private).
    for (let index = 0; index < next.size(); index += 1) {
      if (isJavaScriptAction(next.lookup(index), depth + 1)) {
        return true;
      }
    }
    return false;
  }
  return isJavaScriptAction(next, depth + 1);
}

/** The JavaScript actions in an `/AA` dictionary. */
function additionalJavaScript(owner: PDFDict | undefined): number {
  const aa = owner?.lookupMaybe(PDFName.of("AA"), PDFDict);
  if (!aa) {
    return 0;
  }
  let count = 0;
  for (const key of aa.keys()) {
    if (isJavaScriptAction(aa.lookup(key))) {
      count += 1;
    }
  }
  return count;
}

/** The leaves of a name tree (`/Names` pairs, `/Kids` nodes), cycle-safe. */
function nameTreeSize(node: PDFDict | undefined, seen = new Set<PDFDict>()): number {
  if (!node || seen.has(node)) {
    return 0;
  }
  seen.add(node);
  let count = (node.lookupMaybe(PDFName.of("Names"), PDFArray)?.size() ?? 0) >> 1;
  const kids = node.lookupMaybe(PDFName.of("Kids"), PDFArray);
  for (let at = 0; kids && at < kids.size(); at += 1) {
    count += nameTreeSize(kids.lookupMaybe(at, PDFDict), seen);
  }
  return count;
}

/**
 * Scripts a template carries: a document `/OpenAction`, `/AA` additional actions on the
 * document, its pages and its fields, and the `/Names` JavaScript tree. They are kept as they
 * are, so the output bytes do not change, and said once per kind with a count: they run only
 * in a viewer that runs scripts.
 */
function javaScriptWarnings(pdf: PDFDocument): PdfWarning[] {
  const catalog = pdf.catalog;
  const openAction = isJavaScriptAction(catalog.lookup(PDFName.of("OpenAction"))) ? 1 : 0;
  let additional = additionalJavaScript(catalog);
  for (const page of pdf.getPages()) {
    additional += additionalJavaScript(page.node);
  }
  const seen = new Set<PDFDict>();
  const walk = (field: PDFDict | undefined, depth: number): void => {
    if (!field || seen.has(field) || depth > 32) {
      return;
    }
    seen.add(field);
    additional += additionalJavaScript(field);
    const kids = field.lookupMaybe(PDFName.of("Kids"), PDFArray);
    for (let at = 0; kids && at < kids.size(); at += 1) {
      walk(kids.lookupMaybe(at, PDFDict), depth + 1);
    }
  };
  const fields = catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  for (let at = 0; fields && at < fields.size(); at += 1) {
    walk(fields.lookupMaybe(at, PDFDict), 0);
  }
  const names = nameTreeSize(catalog.lookupMaybe(PDFName.of("Names"), PDFDict)?.lookupMaybe(PDFName.of("JavaScript"), PDFDict));
  const found: Array<[string, string, number]> = [
    ["template.javascript_open_action", "a JavaScript action that runs when the document opens", openAction],
    ["template.javascript_additional_actions", "JavaScript additional actions on the document, its pages or its fields", additional],
    ["template.javascript_names", "document-level JavaScript in its name tree", names]
  ];
  return found
    .filter(([, , count]) => count > 0)
    .map(([code, what, count]) => ({
      code,
      message: `The template carries ${what} (${count}). The scripts are kept, unchanged, and run only in a viewer that runs scripts.`
    }));
}

/**
 * A field's widget that no page lists is never drawn: a viewer paints a page's `/Annots`, so a
 * value set on such a widget shows nowhere. macOS leaves forms like that — the page listing a
 * copy of every widget, the field keeping the original — so before the values land, each such
 * widget takes its copy's place on the page (the copy goes) or joins the page it names, or the
 * only page there is. Said once, with what could not be placed.
 */
function reattachWidgets(pdf: PDFDocument, form: PDFForm, warnings: PdfWarning[]): void {
  const placer = new WidgetPlacer(pdf, form);
  let reattached = 0;
  let stranded = 0;
  for (const field of form.getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      const ref = placer.refOfWidget(widget, field);
      if (!ref || placer.listed(widget, field)) {
        continue;
      }
      const placement = placer.place(widget, field);
      if (!placement) {
        stranded += 1;
        continue;
      }
      const copy = placement.entry?.ref;
      placer.claim(placement, ref);
      if (copy) {
        pdf.context.delete(copy);
      }
      widget.setP(placement.page.ref);
      reattached += 1;
    }
  }
  const count = (n: number): string => `${n} of the template's field widget${n === 1 ? "" : "s"} ${n === 1 ? "was" : "were"} on no page`;
  if (reattached > 0) {
    const tail = stranded > 0 ? ` ${stranded} could not be placed and will not show.` : "";
    warnings.push({
      code: "template.widgets_relinked",
      message: `${count(reattached)} (the PDF was re-saved by another application, such as macOS Preview); ${reattached === 1 ? "it was" : "they were"} reattached so the answers show.${tail}`
    });
  } else if (stranded > 0) {
    warnings.push({ code: "template.widgets_detached", message: `${count(stranded)} and will not show.` });
  }
}

/** Chars a standard font cannot show; when any value has one, the appearances need an embedded font. */
function needsEmbeddedFont(texts: Iterable<string>): boolean {
  for (const text of texts) {
    for (const char of text) {
      const code = char.codePointAt(0)!;
      if (code > 0xff) {
        return true;
      }
    }
  }
  return false;
}

/** The text every field's appearance may have to show: the mapped values and the fillable areas' values. */
function appearanceTexts(values: Record<string, PdfFillValue>, areas: readonly PdfFillArea[]): string[] {
  return [...Object.values(values).map(asText), ...areas.filter((area) => area.field).map((area) => asText(area.value))];
}

async function embedResource(pdf: PDFDocument, resource: PdfFontResource, customName: string): Promise<PDFFont> {
  pdf.registerFontkit(fontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
  return pdf.embedFont(base64ToBytes(resource.data), { subset: true, customName });
}

/**
 * The face the appearances are drawn with: the first resource when a value needs one, else
 * Helvetica — or, under PDF/A, always the resource, since a standard font is not embedded.
 */
async function appearanceFont(pdf: PDFDocument, fonts: PdfFontResource[], texts: readonly string[], strict: boolean): Promise<PDFFont> {
  const first = fonts[0];
  if (first && (strict || needsEmbeddedFont(texts))) {
    return embedResource(pdf, first, "DatumFillFont");
  }
  if (strict) {
    throw new PdfKernelError("font", "PDF/A needs every font embedded, and the fill request carries no font resource for the field appearances; supply one.");
  }
  return pdf.embedFont(StandardFonts.Helvetica);
}

/** The bold face for a fillable area that asks for one: the first bold resource, else Helvetica-Bold (under PDF/A: the regular resource). */
async function boldAppearanceFont(pdf: PDFDocument, fonts: PdfFontResource[], texts: readonly string[], strict: boolean, warnings: PdfWarning[]): Promise<PDFFont> {
  const bold = fonts.find((resource) => (resource.weight ?? 400) >= 600 && resource.style !== "italic");
  if (bold && (strict || needsEmbeddedFont(texts))) {
    return embedResource(pdf, bold, "DatumFillFontBold");
  }
  if (strict) {
    warnings.push({ code: "pdfa.boldFallback", message: "No bold font resource was supplied; bold areas use the regular face, since PDF/A allows no standard font." });
    return appearanceFont(pdf, fonts, texts, strict);
  }
  return pdf.embedFont(StandardFonts.HelveticaBold);
}

/**
 * The level a filled template declares: the template's own, its part raised to 3
 * when the layout asks for that — part 3 differs from 2 only in allowing attachments — and
 * its level letter kept, since "u" and "a" are promises about text and structure the
 * template already has. A template that declares nothing is filled as any PDF: the kernel
 * cannot vouch for what it did not draw.
 */
export function fillClaim(own: PdfAConformance | undefined, asked: PdfAConformance | undefined, warnings: PdfWarning[]): PdfAConformance | undefined {
  if (!asked) {
    return undefined;
  }
  if (!own) {
    warnings.push({ code: "pdfa.template", message: `The template declares no PDF/A level, so the filled document cannot claim PDF/A-${asked}; supply a PDF/A template.` });
    return undefined;
  }
  const ownPart = pdfAPartOf(own);
  const askedPart = pdfAPartOf(asked);
  const part = ownPart === 2 && askedPart === 3 ? 3 : ownPart;
  const level = pdfALevel(own);
  const askedLevel = pdfALevel(asked);
  if (askedLevel !== level && askedLevel !== "b" && !(askedLevel === "u" && level === "a")) {
    warnings.push({
      code: "pdfa.level",
      message: `The template declares PDF/A-${own}; the "${askedLevel}" level asked for is a promise about its ${askedLevel === "a" ? "structure" : "text"} the kernel cannot make, so the document declares PDF/A-${part}${level}.`
    });
  }
  return `${part}${level}` as PdfAConformance;
}

/** Level "a" given up for "u" — what the file then is by construction — with the reason on record. */
function withoutAccessibleLevel(claim: PdfAConformance, reason: string, warnings: PdfWarning[]): PdfAConformance {
  const level = pdfAWithLevel(claim, "u");
  warnings.push({ code: "pdfa.level", message: `The template declares PDF/A-${claim}, but ${reason}; the filled document declares PDF/A-${level}.` });
  return level;
}

/**
 * What a template's encryption was before it was read. Loading with the password
 * leaves a document that no longer says it was encrypted, so the fact and the owner's
 * permissions are taken first and carried beside it.
 */
interface TemplateEncryption {
  permissions: PdfTemplatePermissions;
}

interface LoadedTemplate {
  pdf: PDFDocument;
  /** Present when the template as supplied was encrypted (and has been read decrypted). */
  encryption?: TemplateEncryption;
}

/** One bit of /P, numbered from 1 as ISO 32000-1 Table 22 numbers them (bit 3 is `1 << 2`). */
function permissionBit(flags: number, bit: number): boolean {
  return (flags & (1 << (bit - 1))) !== 0;
}

/** The owner's permissions as /P and the revision /R state them (ISO 32000-1 Table 22). */
function decodePermissions(flags: number, revision: number): PdfTemplatePermissions {
  const print = permissionBit(flags, 3);
  const modify = permissionBit(flags, 4);
  const annotate = permissionBit(flags, 6);
  const advanced = revision >= 3;
  return {
    print,
    // Revision 2 has one print bit; from 3 a low-resolution print leaves bit 12 clear.
    printHighQuality: print && (!advanced || permissionBit(flags, 12)),
    modify,
    copy: permissionBit(flags, 5),
    annotate,
    // Bit 9 fills even where bit 6 forbids annotating; below revision 3 only bit 6 governs.
    fillForms: annotate || (advanced && permissionBit(flags, 9)),
    assemble: advanced ? permissionBit(flags, 11) : modify
  };
}

function numberEntry(dict: PDFDict, key: string): number | undefined {
  return dict.lookupMaybe(PDFName.of(key), PDFNumber)?.asNumber();
}

/**
 * What the decrypted read still carries of the encryption. The reader keeps the file's
 * cross-reference streams as objects (unreadable ones in the decrypted read: they are never
 * encrypted, so decrypting them yields noise), and each names the `/Encrypt` dictionary;
 * written back they would make the unencrypted output read as encrypted wherever the body is
 * scanned. They are dropped (the writer builds its own cross-reference table), found in the
 * as-supplied read where they parse, and the dictionary goes with them, which holds the keys'
 * verifiers and nothing the output needs.
 */
function dropEncryptionRemnants(decrypted: PDFDocument, asSupplied: PDFDocument): void {
  const drop: PDFRef[] = [];
  for (const [ref, object] of asSupplied.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream && object.dict.lookup(PDFName.of("Type")) === PDFName.of("XRef")) {
      drop.push(ref);
    }
  }
  const encrypt = asSupplied.context.trailerInfo.Encrypt;
  if (encrypt instanceof PDFRef) {
    drop.push(encrypt);
  }
  for (const ref of drop) {
    decrypted.context.delete(ref);
  }
}

/**
 * Puts back the streams the decryption must not have touched. The reader decrypts every
 * stream with the document's stream cipher, and does not skip a stream whose filter list names
 * `/Crypt` with the Identity filter (the default) although that stream is stored in the clear
 * (measured on ISP-2500: its XMP comes out as noise), nor the metadata streams of a file that
 * sets `/EncryptMetadata false`, which the specification leaves in the clear whatever their
 * filters. The reader also has no `/Crypt` decoder, so the filter would stop everything that
 * reads the stream, and it would be written back out unencrypted but still named. Such a stream
 * takes its bytes from the as-supplied read (and any other filter it has, Flate included, stays
 * to decode them); a stream named for a real crypt filter keeps what was decrypted. Either way
 * the `/Crypt` name goes.
 */
function restoreClearStreams(decrypted: PDFDocument, asSupplied: PDFDocument, encryptMetadata: boolean): void {
  const restore: Array<[PDFRef, PDFRawStream]> = [];
  for (const [ref, object] of decrypted.context.enumerateIndirectObjects()) {
    if (!(object instanceof PDFRawStream)) {
      continue;
    }
    const crypt = cryptFilterOf(object.dict);
    const metadata = !encryptMetadata && object.dict.lookup(PDFName.of("Type")) === PDFName.of("Metadata");
    if (!crypt && !metadata) {
      continue;
    }
    // A named crypt filter says how the stream is encrypted, whatever it is; otherwise metadata is in the clear.
    const clear = crypt ? crypt.identity : metadata;
    const original = asSupplied.context.lookup(ref);
    restore.push([ref, PDFRawStream.of(object.dict, clear && original instanceof PDFRawStream ? original.contents : object.contents)]);
    if (crypt) {
      crypt.strip();
    }
  }
  for (const [ref, stream] of restore) {
    decrypted.context.assign(ref, stream);
  }
}

/** The `/Crypt` entry of a stream's filters: whether it names the Identity filter, and how to remove it. */
function cryptFilterOf(dict: PDFDict): { identity: boolean; strip(): void } | undefined {
  const filter = dict.lookup(PDFName.of("Filter"));
  const parms = dict.lookup(PDFName.of("DecodeParms"));
  const isCrypt = (entry: PDFObject | undefined): boolean => dict.context.lookup(entry) === PDFName.of("Crypt");
  const at = filter instanceof PDFArray ? filter.asArray().findIndex(isCrypt) : isCrypt(filter) ? 0 : -1;
  if (at < 0) {
    return undefined;
  }
  const own = parms instanceof PDFArray ? parms.lookupMaybe(at, PDFDict) : parms instanceof PDFDict ? parms : undefined;
  const name = own?.lookupMaybe(PDFName.of("Name"), PDFName);
  return {
    identity: name === undefined || name === PDFName.of("Identity"),
    strip() {
      if (filter instanceof PDFArray && filter.size() > 1) {
        filter.remove(at);
        if (parms instanceof PDFArray && at < parms.size()) {
          parms.remove(at);
        }
        return;
      }
      dict.delete(PDFName.of("Filter"));
      dict.delete(PDFName.of("DecodeParms"));
    }
  };
}

/**
 * What the reader (`CipherTransformFactory`, @cantoo/pdf-lib 2.9.1) throws when the password
 * does not open the file: with the empty password it is the first, and the second is for a
 * password that was given. Plain `Error`s with no class to test, so the message is the test.
 */
const WRONG_PASSWORD = ["NEEDS PASSWORD", "Password incorrect"];

/**
 * Loads a template, refusing one over the cap or one that is not a readable PDF as the
 * "template" error. An encrypted template is read once as it stands to learn that and to take
 * its /Encrypt dictionary, then again decrypted with the empty user password — the "owner
 * permissions only" form most published forms use. The kernel never takes or asks for a
 * password: one that needs a real password, or a handler it does not know, is the "template"
 * error saying so.
 */
async function loadTemplate(template: Uint8Array): Promise<LoadedTemplate> {
  if (template.length > MAX_PDF_TEMPLATE_BYTES) {
    throw new PdfKernelError("template", `The template is ${template.length} bytes, over the ${MAX_PDF_TEMPLATE_BYTES} byte (25 MiB) cap a layout fills.`);
  }
  let asSupplied: PDFDocument;
  try {
    asSupplied = await PDFDocument.load(template, { updateMetadata: false, ignoreEncryption: true });
  } catch (error) {
    throw new PdfKernelError("template", `The template is not a readable PDF: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!asSupplied.isEncrypted) {
    return { pdf: asSupplied };
  }
  const dict = asSupplied.context.lookup(asSupplied.context.trailerInfo.Encrypt, PDFDict);
  const filter = dict?.get(PDFName.of("Filter"));
  if (!dict || !(filter instanceof PDFName) || filter.asString() !== "/Standard") {
    throw new PdfKernelError("template", "The template is encrypted with a security handler the kernel does not support; supply an unencrypted copy of the template.");
  }
  let pdf: PDFDocument;
  try {
    pdf = await PDFDocument.load(template, { updateMetadata: false, password: "" });
  } catch (error) {
    const cause = error instanceof Error ? error.message : String(error);
    // Only the reader's own wrong-password failures say the template needs a password; a
    // missing /ID, a truncated file or a parse failure after a correct decrypt do not.
    if (WRONG_PASSWORD.includes(cause)) {
      throw new PdfKernelError("template", "The template is encrypted with a password; supply an unencrypted copy of the template.");
    }
    throw new PdfKernelError("template", `The template is encrypted and could not be read: ${cause}`);
  }
  dropEncryptionRemnants(pdf, asSupplied);
  restoreClearStreams(pdf, asSupplied, dict.lookupMaybe(PDFName.of("EncryptMetadata"), PDFBool)?.asBoolean() !== false);
  const flags = numberEntry(dict, "P");
  const revision = numberEntry(dict, "R");
  if (flags === undefined || revision === undefined) {
    throw new PdfKernelError("template", "The template is encrypted and its permissions could not be read; supply an unencrypted copy of the template.");
  }
  return { pdf, encryption: { permissions: decodePermissions(flags, revision) } };
}

/**
 * The owner's terms for a template read with the empty user password: a fill the
 * permissions forbid is refused; one that goes beyond them only by changing page content
 * (flattening, drawn areas) is done and said so, since the output is the host's own document
 * and not the owner's. The output is written unencrypted in every case.
 */
function decryptedTemplateTerms(permissions: PdfTemplatePermissions, changesContent: boolean, warnings: PdfWarning[]): void {
  if (!permissions.fillForms) {
    throw new PdfKernelError("template", "The template is encrypted and the owner's permissions do not allow filling its form fields; supply an unencrypted copy of the template.");
  }
  warnings.push({
    code: "template.decrypted",
    message: "The template was encrypted with owner permissions only (no password to open it); it was read decrypted and the filled document is written unencrypted, so the original's restrictions are not carried over."
  });
  if (changesContent && !permissions.modify) {
    warnings.push({
      code: "template.permissions",
      message: "The template's owner does not allow modifying it; flattening the form or drawing areas changes its page content, so the output goes beyond those permissions."
    });
  }
}

export async function fillTemplate(
  template: Uint8Array,
  values: Record<string, PdfFillValue>,
  options: Required<PdfTemplateFillOptions>,
  fonts: PdfFontResource[],
  env: PdfKernelEnv,
  areas: readonly PdfFillArea[] = [],
  conformance?: PdfDocumentConformance,
  attachments?: readonly PdfDocumentAttachment[],
  theme: { typography?: PdfTypography | undefined; colors?: PdfThemeColors | undefined } = {},
  attachmentPolicy?: PdfAttachmentPolicy
): Promise<FilledTemplate> {
  const warnings: PdfWarning[] = [];
  const reports: PdfFillReport[] = [];
  const { pdf, encryption } = await loadTemplate(template);
  if (conformance?.pdfa && encryption) {
    // PDF/A forbids encryption either way: no fill of it can claim a level. Keyed on what the
    // template was as supplied; the decrypted document no longer says it was encrypted.
    throw new PdfKernelError("conformance", `The template is encrypted, which PDF/A forbids; supply an unencrypted template for PDF/A-${conformance.pdfa}.`);
  }
  if (encryption) {
    decryptedTemplateTerms(encryption.permissions, options.flatten || areas.length > 0, warnings);
  }
  let claim = fillClaim(declaredPdfA(pdf), conformance?.pdfa, warnings);
  const strict = claim !== undefined;
  if (strict && options.appearances === "viewer") {
    warnings.push({ code: "pdfa.appearances", message: "PDF/A leaves nothing to the viewer; the appearances were regenerated although the layout asked to leave them." });
    options = { ...options, appearances: "regenerate" };
  }
  // Level "a": what the fill adds joins the template's structure tree. Flattening would turn
  // the widgets' appearances into page content no element owns, and a tree this kernel
  // cannot extend leaves the additions outside it — either way the letter drops to "u".
  let tagging: ExistingTagging | undefined;
  if (claim && pdfALevel(claim) === "a") {
    if (options.flatten) {
      claim = withoutAccessibleLevel(claim, "flattening makes the field appearances untagged page content", warnings);
    } else {
      tagging = new ExistingTagging(pdf);
      if (!tagging.extendable) {
        claim = withoutAccessibleLevel(claim, "its structure tree is one this kernel cannot extend", warnings);
        tagging = undefined;
      }
    }
  }
  // A PDF with no form and nothing to put into one is left without one: `getForm()` would
  // otherwise write an empty AcroForm into a document that only has areas to draw. A fillable
  // area is a reason to have one.
  const hasForm = pdf.catalog.has(PDFName.of("AcroForm")) || Object.keys(values).length > 0 || areas.some((area) => area.field);
  // Read before `getForm()`, which strips the XFA on its way through.
  const hadXfa = hasXfa(pdf);
  warnings.push(...javaScriptWarnings(pdf));
  const form = hasForm ? pdf.getForm() : undefined;
  if (form) {
    if (hadXfa) {
      form.deleteXFA();
      warnings.push({ code: "template.xfa_removed", message: "The template carried XFA, which is not supported; it was removed so the AcroForm fields fill." });
    }
    reattachWidgets(pdf, form, warnings);
    setFieldValues(form, values, options, reports, warnings);
  }
  // Content areas are drawn and fillable areas' widgets created before the form's appearances
  // are regenerated, so the new widgets get theirs in the same pass and flatten sees them all.
  const placed = await drawAreas(pdf, areas, fonts, warnings, form, {
    strict,
    ...(tagging ? { tagging } : {}),
    ...(theme.typography ? { typography: theme.typography } : {}),
    ...(theme.colors ? { colors: theme.colors } : {})
  });
  tagging?.finish();
  if (form) {
    await finishForm(pdf, form, options, fonts, values, areas, placed.fields, warnings, strict);
  }
  pdf.setProducer(env.producer ?? "Datum PDF kernel");
  const infoRef = pdf.context.trailerInfo.Info;
  if (infoRef) {
    const info = pdf.context.lookup(infoRef, PDFDict);
    info.set(PDFName.of("ModDate"), PDFString.of(pdfDateString(env.createdAt)));
  }
  // Under the level the fill declares: a part-2 template raised to 3 takes them, one that declares nothing takes them as any PDF.
  const embedded = embedAttachments(pdf, { claim, conformance, attachments, attachmentPolicy, env, warnings });
  // The template's own output intent stays (a file declares one): a configured one is reported and not applied.
  const pdfa = claim ? await applyPdfA(pdf, { claim, conformance: conformance ?? {}, env, warnings }) : undefined;
  const bytes = await pdf.save({ useObjectStreams: false, updateFieldAppearances: false, objectsPerTick: Infinity });
  return {
    bytes,
    pageCount: pdf.getPageCount(),
    fields: reports,
    areas: placed.reports,
    warnings,
    ...(pdfa ? { pdfa } : {}),
    ...(embedded ? { attachments: embedded } : {})
  };
}

/**
 * The most characters a text field takes: its own /MaxLen when it declares one (at most
 * `FIELD_TEXT_MAX_LEN_CAP`, under the ~65k pdf-lib argument limit), else `FIELD_TEXT_MAX_CHARS`.
 * pdf-lib lays a multi-line field's text out in time that grows faster than the square of the length
 * (about 10 s at 2,000 characters), so the appearance of such a field is drawn from at most
 * `MULTILINE_APPEARANCE_CHARS` characters while `/V` keeps the whole value.
 */
const FIELD_TEXT_MAX_CHARS = 4096;
const FIELD_TEXT_MAX_LEN_CAP = 32000;
const MULTILINE_APPEARANCE_CHARS = 1000;

/**
 * Runs `work` with every long multi-line field among `names` holding a cut value, then puts the whole value
 * back in `/V` and asks the viewer to redraw (`NeedAppearances`); a `field.overflow` warning says so. When the
 * form is flattened there is no field left to hold the value nor a viewer to redraw it: the page draws the cut
 * text alone (pdf-lib's layout of more is too slow to offer), and the warning says what is not in the output.
 */
async function withClampedMultiline(pdf: PDFDocument, form: PDFForm, names: readonly string[], warnings: PdfWarning[], flatten: boolean, work: () => void | Promise<void>): Promise<void> {
  const restore: Array<() => void> = [];
  for (const name of names) {
    const field = form.getFieldMaybe(name);
    if (!(field instanceof PDFTextField) || !field.isMultiline()) {
      continue;
    }
    const full = field.getText() ?? "";
    if (full.length <= MULTILINE_APPEARANCE_CHARS) {
      continue;
    }
    const cut = full.slice(0, MULTILINE_APPEARANCE_CHARS);
    field.setText(/[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut);
    if (!flatten) {
      restore.push(() => field.acroField.setValue(PDFHexString.fromText(full)));
    }
    warnings.push({
      code: "field.overflow",
      message: flatten
        ? `Field "${name}" holds ${full.length} characters; the flattened page draws only the first ${MULTILINE_APPEARANCE_CHARS}, the rest is not in the output.`
        : `Field "${name}" holds ${full.length} characters; its appearance shows the first ${MULTILINE_APPEARANCE_CHARS} and the viewer redraws the rest (the value is kept whole).`
    });
  }
  try {
    await work();
  } finally {
    for (const put of restore) {
      try {
        put();
      } catch {
        // The field was flattened away: its value went with it.
      }
    }
    if (restore.length > 0) {
      form.acroForm.dict.set(PDFName.of("NeedAppearances"), pdf.context.obj(true));
    }
  }
}

/** Sets the mapped values on the template's own fields, reporting each. */
function setFieldValues(form: PDFForm, values: Record<string, PdfFillValue>, options: Required<PdfTemplateFillOptions>, reports: PdfFillReport[], warnings: PdfWarning[]): void {
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!field) {
      reports.push({ pdfField: name, status: "missing", message: `No field named "${name}" in the template.` });
      continue;
    }
    const kind = kindOf(field);
    try {
      if (field instanceof PDFTextField) {
        if (value === null) {
          field.setText(undefined);
          reports.push({ pdfField: name, status: "cleared", kind });
        } else {
          // A value past the field's /MaxLen, or past a bound, is cut with a warning: one huge value
          // must not make appearance regeneration fail for every field.
          const full = asText(value);
          const declared = field.getMaxLength();
          const limit = declared === undefined ? FIELD_TEXT_MAX_CHARS : Math.min(declared, FIELD_TEXT_MAX_LEN_CAP);
          const text = full.length > limit ? full.slice(0, limit) : full;
          if (text !== full) {
            warnings.push({ code: "field.overflow", message: `Field "${name}" was given ${full.length} characters; only the first ${limit} were set.` });
          }
          field.setText(text);
          reports.push({ pdfField: name, status: "filled", kind });
        }
      } else if (field instanceof PDFCheckBox) {
        if (truthy(value)) {
          field.check();
          reports.push({ pdfField: name, status: "filled", kind });
        } else {
          field.uncheck();
          reports.push({ pdfField: name, status: "cleared", kind });
        }
      } else if (field instanceof PDFRadioGroup) {
        // An empty answer clears the group, as an absent one does.
        const option = typeof value === "string" && value !== "" ? value : Array.isArray(value) ? value[0] : undefined;
        if (option !== undefined && field.getOptions().includes(option)) {
          field.select(option);
          reports.push({ pdfField: name, status: "filled", kind });
        } else {
          field.clear();
          reports.push({ pdfField: name, status: option === undefined ? "cleared" : "unsupported", kind, ...(option !== undefined ? { message: `"${option}" is not one of the options` } : {}) });
        }
      } else if (field instanceof PDFDropdown) {
        const option = typeof value === "string" && value !== "" ? value : Array.isArray(value) ? value[0] : undefined;
        if (option !== undefined && field.getOptions().includes(option)) {
          field.select(option);
          reports.push({ pdfField: name, status: "filled", kind });
        } else if (option !== undefined && field.isEditable()) {
          field.select(option);
          reports.push({ pdfField: name, status: "filled", kind });
        } else {
          field.clear();
          reports.push({ pdfField: name, status: option === undefined ? "cleared" : "unsupported", kind, ...(option !== undefined ? { message: `"${option}" is not one of the options` } : {}) });
        }
      } else if (field instanceof PDFOptionList) {
        const picked = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
        const available = field.getOptions();
        const selected = picked.filter((option) => available.includes(option));
        if (selected.length > 0) {
          field.select(selected);
          reports.push({ pdfField: name, status: "filled", kind });
        } else {
          field.clear();
          reports.push({ pdfField: name, status: "cleared", kind });
        }
      } else {
        reports.push({ pdfField: name, status: "unsupported", kind, message: `A ${kind} field cannot be filled.` });
        continue;
      }
      if (options.readOnly) {
        field.enableReadOnly();
      }
    } catch (error) {
      reports.push({ pdfField: name, status: "unsupported", kind, message: error instanceof Error ? error.message : String(error) });
    }
  }
}

/**
 * A single-line text field whose text is wider than its widget at the size the appearance
 * chose (the default appearance records it) is clipped at the widget; says so, as an area does.
 */
function warnFieldOverflow(form: PDFForm, values: Record<string, PdfFillValue>, face: PDFFont, warnings: PdfWarning[]): void {
  for (const [name, value] of Object.entries(values)) {
    const field = form.getFieldMaybe(name);
    if (!(field instanceof PDFTextField) || value === null || field.isMultiline()) {
      continue;
    }
    const text = asText(value);
    if (text === "") {
      continue;
    }
    try {
      for (const widget of field.acroField.getWidgets()) {
        const size = Number(/([\d.]+)\s+Tf/.exec(widget.getDefaultAppearance() ?? field.acroField.getDefaultAppearance() ?? "")?.[1] ?? 0);
        if (!(size > 0)) {
          continue;
        }
        const width = widget.getRectangle().width;
        if (face.widthOfTextAtSize(text, size) > width + 0.01) {
          warnings.push({ code: "field.overflow", message: `Field "${name}" holds more than its box at ${size} pt; the rest is clipped.` });
          break;
        }
      }
    } catch {
      // A glyph the face cannot measure: the appearance step reports it; no overflow claim.
    }
  }
}

/**
 * The form's tail once every field has its value and every fillable area its widget: the
 * appearances (regenerated here, or left to the viewer), a bold face for the areas that ask
 * for one, then flattening when asked.
 */
async function finishForm(
  pdf: PDFDocument,
  form: PDFForm,
  options: Required<PdfTemplateFillOptions>,
  fonts: PdfFontResource[],
  values: Record<string, PdfFillValue>,
  areas: readonly PdfFillArea[],
  placed: ReadonlyMap<string, PDFTextField | PDFCheckBox>,
  warnings: PdfWarning[],
  strict = false
): Promise<void> {
  const acroDict = form.acroForm.dict;
  if (options.readOnly) {
    // As for the template's own fields: a filled one is locked, an empty one stays fillable.
    for (const area of areas) {
      const field = area.field ? placed.get(area.id) : undefined;
      if (field && (field instanceof PDFTextField ? asText(area.value) !== "" : truthy(area.value))) {
        field.enableReadOnly();
      }
    }
  }
  // A long multi-line value is laid out from a cut copy wherever pdf-lib draws it.
  const drawn = options.appearances === "viewer" && !options.flatten ? [] : [...Object.keys(values), ...[...placed.values()].filter((f): f is PDFTextField => f instanceof PDFTextField).map((f) => f.getName())];
  await withClampedMultiline(pdf, form, drawn, warnings, options.flatten, async () => {
    if (options.appearances === "viewer") {
      // A filled field's old appearance would show the template's value to a viewer that ignores
      // NeedAppearances, contradicting /V; drop it so the viewer draws the new one.
      for (const name of Object.keys(values)) {
        const field = form.getFieldMaybe(name);
        if (field instanceof PDFTextField || field instanceof PDFDropdown || field instanceof PDFOptionList) {
          for (const widget of field.acroField.getWidgets()) {
            widget.dict.delete(PDFName.of("AP"));
          }
        }
      }
      acroDict.set(PDFName.of("NeedAppearances"), pdf.context.obj(true));
    } else {
      try {
        const texts = appearanceTexts(values, areas);
        const face = await appearanceFont(pdf, fonts, texts, strict);
        form.updateFieldAppearances(face);
        warnFieldOverflow(form, values, face, warnings);
        const boldTexts = areas.filter((area) => area.field && area.draw.bold).map((area) => asText(area.value));
        if (boldTexts.length > 0) {
          const bold = await boldAppearanceFont(pdf, fonts, boldTexts, strict, warnings);
          for (const area of areas) {
            const field = area.field && area.draw.bold ? placed.get(area.id) : undefined;
            if (field instanceof PDFTextField) {
              field.updateAppearances(bold);
            }
          }
        }
      } catch (error) {
        if (strict) {
          // Leaving the appearances to the viewer would break the claim; a missing font already says so.
          if (error instanceof PdfKernelError) {
            throw error;
          }
          throw new PdfKernelError("conformance", `Field appearances could not be regenerated, which PDF/A needs: ${error instanceof Error ? error.message : String(error)}`);
        }
        warnings.push({ code: "template.appearances", message: `Field appearances could not be regenerated: ${error instanceof Error ? error.message : String(error)}` });
        acroDict.set(PDFName.of("NeedAppearances"), pdf.context.obj(true));
      }
    }
    if (options.flatten) {
      try {
        // Under PDF/A the appearances were just drawn with an embedded face; letting `flatten`
        // redraw them would bring in pdf-lib's unembedded Helvetica.
        form.flatten({ updateFieldAppearances: !strict });
      } catch (error) {
        warnings.push({ code: "template.flatten", message: `The form could not be flattened: ${error instanceof Error ? error.message : String(error)}` });
      }
    }
  });
}

/**
 * What `inspectTemplate` lists of a template: the designer draws one row
 * per field and one sheet per page, so a template holding 60,000 widgets or 100,000 pages under
 * the 25 MiB cap would hold the tab for minutes. Past either the answer lists the first of them
 * and carries a `template.truncated` warning; `pageCount` is still the document's.
 */
export const MAX_INSPECTED_PAGES = 500;
export const MAX_INSPECTED_FIELDS = 5000;

export interface InspectTemplateOptions {
  /** The embedded files too: their names and digests, or their bytes as well. Default none. */
  attachments?: "none" | "digest" | "data";
  /** Lower caps than {@link MAX_INSPECTED_PAGES} and {@link MAX_INSPECTED_FIELDS} (a test's; never higher). */
  limits?: { pages?: number; fields?: number };
}

export async function inspectTemplate(template: Uint8Array, options: InspectTemplateOptions = {}): Promise<PdfTemplateInfo> {
  const { pdf, encryption } = await loadTemplate(template);
  const warnings: PdfWarning[] = [];
  const attachments = options.attachments && options.attachments !== "none" ? readEmbeddedFiles(pdf, warnings, { data: options.attachments === "data" }) : undefined;
  const pages = pdf.getPages();
  // Read before `getForm()`, which strips the XFA on its way through.
  const xfa = hasXfa(pdf);
  warnings.push(...javaScriptWarnings(pdf));
  const pdfa = declaredPdfA(pdf);
  // Signature states by name, read on the dictionaries before `getForm()` rewrites anything.
  const signatureStates = new Map(findSignatureFields(pdf).map((entry) => [entry.name, entry.state]));
  const form = pdf.getForm();
  const placer = new WidgetPlacer(pdf, form);
  // Each page as a reader sees it (crop box, `/Rotate`): the sizes and boxes reported are in it,
  // the space the designer's viewer draws and an area is drawn back in.
  const maxPages = Math.min(MAX_INSPECTED_PAGES, options.limits?.pages ?? MAX_INSPECTED_PAGES);
  const maxFields = Math.min(MAX_INSPECTED_FIELDS, options.limits?.fields ?? MAX_INSPECTED_FIELDS);
  const spaces = pages.slice(0, maxPages).map((page) => pageSpace(page));
  const allFields = form.getFields();
  if (pages.length > maxPages || allFields.length > maxFields) {
    warnings.push({
      code: "template.truncated",
      message: `The template has ${pages.length} pages and ${allFields.length} fields; ${Math.min(pages.length, maxPages)} pages and ${Math.min(allFields.length, maxFields)} fields are listed.`
    });
  }
  const fields: PdfTemplateFieldInfo[] = allFields.slice(0, maxFields).map((field) => {
    const kind = kindOf(field);
    const widgets = field.acroField.getWidgets();
    const first = widgets[0];
    const page = first ? placer.place(first, field)?.page.index : undefined;
    const raw = first?.getRectangle();
    const space = page !== undefined ? spaces[page - 1] : undefined;
    const rectangle = raw && space ? userRectToDisplay(space, raw) : raw;
    const info: PdfTemplateFieldInfo = {
      name: field.getName(),
      kind,
      readOnly: field.isReadOnly(),
      required: field.isRequired(),
      ...(page !== undefined ? { page } : {}),
      ...(rectangle ? { rect: { x: rectangle.x, y: rectangle.y, width: rectangle.width, height: rectangle.height } } : {}),
      ...(kind === "signature" ? { signed: signatureStates.get(field.getName()) === "signed" } : {})
    };
    const tooltip = fieldTooltip(field);
    if (tooltip !== undefined) {
      info.tooltip = tooltip;
    }
    if (field instanceof PDFTextField) {
      const maxLength = field.getMaxLength();
      if (maxLength !== undefined) {
        info.maxLength = maxLength;
      }
      if (field.isMultiline()) {
        info.multiline = true;
      }
      const value = field.getText();
      if (value !== undefined) {
        info.value = value;
      }
    } else if (field instanceof PDFCheckBox) {
      info.value = field.isChecked();
      info.exportValues = widgets.map((widget) => widget.getOnValue()?.decodeText() ?? "").filter((v) => v !== "");
    } else if (field instanceof PDFRadioGroup) {
      info.options = field.getOptions();
      const selected = field.getSelected();
      if (selected !== undefined) {
        info.value = selected;
      }
    } else if (field instanceof PDFDropdown) {
      info.options = field.getOptions();
      const selected = field.getSelected();
      if (selected.length > 0) {
        info.value = selected[0]!;
      }
    } else if (field instanceof PDFOptionList) {
      info.options = field.getOptions();
      info.value = field.getSelected();
    }
    return info;
  });
  return {
    pageCount: pages.length,
    // 1-based, like each field's `page`, so a host can join the two.
    pages: spaces.map((space, index) => ({ index: index + 1, width: space.width, height: space.height })),
    fields,
    hasXfa: xfa,
    // As supplied: the document read here is the decrypted one.
    encrypted: encryption !== undefined,
    ...(encryption ? { permissions: encryption.permissions } : {}),
    ...(pdfa ? { pdfa } : {}),
    signatures: fields.filter((field) => field.signed === true).length,
    ...(attachments ? { attachments } : {}),
    ...(warnings.length > 0 ? { warnings } : {})
  };
}
