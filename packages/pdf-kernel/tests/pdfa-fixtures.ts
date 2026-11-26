import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, StandardFonts } from "@cantoo/pdf-lib";
import * as fontkit from "fontkit";
import { DEFAULT_PDF_TYPOGRAPHY, base64ToBytes, bytesToBase64, type PdfAttachment, type PdfBlock, type PdfDocument, type PdfFontResource } from "@argusvane/datum-engine/render";
import { RED_PNG_BASE64, document, fonts, paragraph } from "./helpers.js";

/** pdf.js's CMYK profile with its device class set to "prtr": PDF/A wants an output or monitor profile, and the file is a scanner one. */
export function cmykProfile(): Uint8Array {
  const path = join(dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json")), "iccs", "CGATS001Compat-v2-micro.icc");
  const bytes = new Uint8Array(readFileSync(path));
  bytes.set([0x70, 0x72, 0x74, 0x72], 12);
  return bytes;
}

export const CFF_FAMILY = "Noto Sans Canadian Aboriginal";

/** A CFF-flavoured OpenType face (Noto Sans Canadian Aboriginal, OFL, `tests/fixtures`): syllabics only, no Latin. */
export function cffFont(): PdfFontResource {
  const path = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "NotoSansCanadianAboriginal-Regular.otf");
  return { id: "noto-cans", family: CFF_FAMILY, weight: 400, style: "normal", data: bytesToBase64(new Uint8Array(readFileSync(path))), coverage: ["Cans"] };
}

/** nēhiyawēwin, the Cree language, in Plains Cree syllabics. */
export const SYLLABICS = "ᓀᐦᐃᔭᐍᐏᐣ";

/** Two UCAS Extended letters (OY, AY) the default pack lacks and the CFF face has: what makes the script fall back. */
export const EXTENDED_SYLLABICS = "ᢰᢱ";

/**
 * A document with the CFF face beside the default one, under a claim: a run set in it by
 * name, and a run whose extended syllabics fall back to it through the theme's `Cans` mapping
 * while the Latin around them stays in the default face.
 */
export function syllabicsDocument(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return document(
    [
      { id: "h", kind: "heading", level: 1, runs: [{ text: "Syllabics" }] },
      { id: "p", kind: "paragraph", role: "P", runs: [{ text: "Plains Cree: " }, { text: SYLLABICS, family: CFF_FAMILY }, { text: " (2026)" }] },
      paragraph("q", `Extended: ${EXTENDED_SYLLABICS} (2026)`)
    ],
    {
      metadata: { title: "Syllabics", lang: "cr", textDirection: "ltr" },
      typography: { ...DEFAULT_PDF_TYPOGRAPHY, fallbacks: { Cans: CFF_FAMILY } },
      conformance: { pdfa: "2u" },
      ...overrides
    }
  );
}

/** The same template with its parent tree turned into one with `Kids` — a shape the fill's tagging does not extend. */
export async function withParentTreeKids(template: Uint8Array): Promise<Uint8Array> {
  const pdf = await PDFDocument.load(template, { updateMetadata: false });
  const root = pdf.catalog.lookup(PDFName.of("StructTreeRoot"), PDFDict);
  const tree = root.lookup(PDFName.of("ParentTree"), PDFDict);
  const nums = tree.lookup(PDFName.of("Nums"), PDFArray);
  const keys = nums.asArray().filter((entry): entry is PDFNumber => entry instanceof PDFNumber).map((entry) => entry.asNumber());
  const leaf = pdf.context.register(pdf.context.obj({ Nums: nums, Limits: [Math.min(...keys), Math.max(...keys)] }));
  tree.delete(PDFName.of("Nums"));
  tree.set(PDFName.of("Kids"), pdf.context.obj([leaf]));
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false, objectsPerTick: Infinity });
}

export const WIDGETS: PdfBlock[] = [
  { id: "w1", kind: "widget", label: "First name", field: { name: "first", kind: "text", value: "Ada", required: true, maxLength: 40, tooltip: "Given name" } },
  { id: "w2", kind: "widget", label: "Notes", field: { name: "notes", kind: "multiline", value: "Line one\nLine two" } },
  { id: "w3", kind: "widget", label: "I agree", labelPosition: "after", field: { name: "agree", kind: "checkbox", value: true } },
  { id: "w4", kind: "widget", label: "Colour", field: { name: "colour", kind: "radio", value: "g", options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }] } },
  { id: "w5", kind: "widget", label: "Country", field: { name: "country", kind: "dropdown", value: "CA", options: [{ value: "CA", label: "Canada" }, { value: "FR", label: "France" }] } },
  { id: "w6", kind: "widget", label: "Toppings", field: { name: "toppings", kind: "listbox", value: ["a"], options: [{ value: "a", label: "Olives" }, { value: "b", label: "Onions" }] } },
  { id: "w7", kind: "widget", label: "Signature", field: { name: "sig", kind: "signature" } }
];

/** A document with text in three scripts, an image, and every widget kind: what an archival form needs the kernel to get right. */
export function archivalDocument(overrides: Partial<PdfDocument> = {}): PdfDocument {
  return document(
    [
      { id: "h", kind: "heading", level: 1, runs: [{ text: "Archival form" }] },
      paragraph("p", "Plain text → with an arrow, Arabic مرحبا and Hebrew שלום inside."),
      { id: "img", kind: "image", resourceId: "logo", alt: "Logo", width: 50 },
      ...WIDGETS
    ],
    {
      metadata: { title: "Fixture & <title>", lang: "en", textDirection: "ltr", author: "Ada", subject: "Smoke", keywords: ["a", "b"] },
      resources: { images: { logo: { type: "image/png", data: RED_PNG_BASE64 } } },
      typography: { ...DEFAULT_PDF_TYPOGRAPHY, fallbacks: { Arab: "sans-serif", Hebr: "sans-serif" } },
      conformance: { pdfa: "2b" },
      ...overrides
    }
  );
}

export const SUBMISSION: PdfAttachment = {
  name: "submission.json",
  mimeType: "application/json",
  description: "Submission data",
  relationship: "Data",
  data: bytesToBase64(new TextEncoder().encode('{"a":1}'))
};

/** A PDF/A template the way pdf-lib makes one: an embedded face, two fields, its own intent. */
export async function pdfLibTemplate(conformance: "1B" | "2B", intent: "srgb" | "cmyk" = "srgb"): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  pdf.registerFontkit(fontkit as never);
  const font = await pdf.embedFont(base64ToBytes((await fonts())[0]!.data), { subset: true, customName: "FixtureFont" });
  const page = pdf.addPage([400, 400]);
  page.drawText("Fixture template", { x: 20, y: 370, size: 14, font });
  const form = pdf.getForm();
  form.createTextField("Name").addToPage(page, { x: 20, y: 300, width: 200, height: 20, font });
  form.createCheckBox("Agree").addToPage(page, { x: 20, y: 260, width: 14, height: 14 });
  form.updateFieldAppearances(font);
  pdf.setTitle("Fixture template");
  pdf.setProducer("fixture");
  pdf.setCreationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.setModificationDate(new Date("2026-01-01T00:00:00Z"));
  pdf.convertToPDFA(intent === "cmyk" ? { conformance, iccProfile: cmykProfile(), outputConditionIdentifier: "CGATS TR 001", colorComponents: 4 } : { conformance });
  return pdf.save({ useObjectStreams: false, updateFieldAppearances: false, objectsPerTick: Infinity });
}

/** A template with no claim and an unembedded face. */
export async function plainTemplate(): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const page = pdf.addPage([300, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  pdf.getForm().createTextField("Name").addToPage(page, { x: 10, y: 250, width: 200, height: 20, font });
  return pdf.save({ useObjectStreams: false, objectsPerTick: Infinity });
}

export const FILL_OPTIONS = { flatten: false, readOnly: false, appearances: "regenerate" as const };

/** The same document with no claim: what the kernel produces without a conformance claim. */
export function withoutClaim(doc: PdfDocument): PdfDocument {
  const { conformance: _claim, ...rest } = doc;
  return rest;
}
