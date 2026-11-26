/**
 * `render` and `layout`: a `PdfDocument` to bytes, or to its page report alone.
 * Fonts first (measurement needs them), images next (their sizes shape the flow), then the
 * layout, then the writer, then metadata, then the attachments, then — for PDF/A
 * — the conformance pass, then the deterministic save.
 */
import { PDFDocument, type PDFImage } from "@cantoo/pdf-lib";
import type { PdfAConformance } from "@argusvane/datum-engine/core";
import { pdfALevel } from "@argusvane/datum-engine/core";
import type { PdfDocument, PdfFontResource, PdfKernelEnv, PdfPageReport, PdfRenderOptions, PdfWarning } from "@argusvane/datum-engine/render";
import { base64ToBytes } from "@argusvane/datum-engine/render";
import { embedAttachments } from "./attachments.js";
import { FontSet } from "./fonts.js";
import { resolveLayoutSettings } from "./settings.js";
import { weightOf } from "./text.js";
import { layoutDocument, type LayoutContext } from "./layout.js";
import { applyPdfA } from "./pdfa.js";
import { writeMetadata, writePages } from "./writer.js";

export interface RenderedDocument {
  bytes: Uint8Array;
  pages: PdfPageReport[];
  warnings: PdfWarning[];
  /** The PDF/A level the file declares, when it does. */
  pdfa?: PdfAConformance;
  /** The embedded files' names as written; absent when none were asked for. */
  attachments?: string[];
}

/** Whether a JPEG has four components (CMYK), from its start-of-frame marker. */
function jpegIsCmyk(bytes: Uint8Array): boolean {
  let offset = 2;
  while (offset + 9 < bytes.length && bytes[offset] === 0xff) {
    const marker = bytes[offset + 1]!;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return bytes[offset + 9] === 4;
    }
    offset += 2 + length;
  }
  return false;
}

async function embedImages(pdf: PDFDocument, document: PdfDocument, warnings: PdfWarning[], strict: boolean): Promise<{ images: Map<string, PDFImage>; sizes: Map<string, { width: number; height: number }> }> {
  const images = new Map<string, PDFImage>();
  const sizes = new Map<string, { width: number; height: number }>();
  for (const [id, resource] of Object.entries(document.resources.images)) {
    if ("url" in resource) {
      warnings.push({ code: "image.unresolved", message: `Image "${resource.url}" reached the kernel as a URL; the host must resolve images to bytes.` });
      continue;
    }
    try {
      if (strict && resource.type === "image/jpeg" && jpegIsCmyk(base64ToBytes(resource.data))) {
        // DeviceCMYK needs a CMYK output intent, which the document does not declare.
        warnings.push({ code: "pdfa.image", message: `Image "${id}" is a CMYK JPEG, which PDF/A does not allow under an RGB output intent; it was left out.` });
        continue;
      }
      const image = resource.type === "image/png" ? await pdf.embedPng(resource.data) : await pdf.embedJpg(resource.data);
      images.set(id, image);
      sizes.set(id, { width: image.width, height: image.height });
    } catch (error) {
      warnings.push({ code: "image.invalid", message: `Image "${id}" could not be embedded: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  return { images, sizes };
}

/** The level a render declares: the request's override, else the document's own. */
function claimFor(document: PdfDocument, options: PdfRenderOptions): PdfAConformance | undefined {
  if (options.pdfa === false) {
    return undefined;
  }
  return options.pdfa ?? document.conformance?.pdfa;
}

async function prepare(document: PdfDocument, fonts: PdfFontResource[], claim: PdfAConformance | undefined) {
  const warnings: PdfWarning[] = [];
  const strict = claim !== undefined;
  const pdf = await PDFDocument.create({ updateMetadata: false });
  const fontSet = new FontSet(pdf, fonts, document.typography.fallbacks ?? {}, { strict, noPrivateUse: strict && pdfALevel(claim) === "a" });
  const embedded = await embedImages(pdf, document, warnings, strict);
  const context: LayoutContext = {
    fonts: fontSet,
    typography: document.typography,
    colors: document.colors,
    settings: resolveLayoutSettings(document),
    textDirection: document.metadata.textDirection,
    images: embedded.sizes,
    warnings
  };
  const laid = await layoutDocument(document, context);
  return { pdf, fontSet, embedded, warnings, laid };
}

export async function layoutOnly(document: PdfDocument, fonts: PdfFontResource[], options: PdfRenderOptions = {}): Promise<{ pages: PdfPageReport[]; warnings: PdfWarning[] }> {
  // The report must say what a render would do, strict fonts included.
  const { fontSet, warnings, laid } = await prepare(document, fonts, claimFor(document, options));
  return { pages: laid.report, warnings: [...warnings, ...fontSet.takeWarnings()] };
}

export async function renderDocument(document: PdfDocument, fonts: PdfFontResource[], env: PdfKernelEnv, options: PdfRenderOptions = {}): Promise<RenderedDocument> {
  const asked = claimFor(document, options);
  const { pdf, fontSet, embedded, warnings, laid } = await prepare(document, fonts, asked);
  const widgetFont = await fontSet.get(document.typography.body.family, weightOf(document.typography.body) ?? 400, false);
  let tagged = options.tagged ?? document.accessibility.tagged;
  if (asked && pdfALevel(asked) === "a" && !tagged) {
    // Level "a" is the claim that the document is tagged; the layout's switch yields to it.
    warnings.push({ code: "pdfa.tagged", message: `PDF/A-${asked} is a tagged-PDF level; the document was tagged although the layout turned tagging off.` });
    tagged = true;
  }
  await writePages(laid.pages, {
    document: pdf,
    model: tagged === document.accessibility.tagged ? document : { ...document, accessibility: { ...document.accessibility, tagged } },
    fonts: fontSet,
    images: embedded.images,
    colors: document.colors,
    warnings,
    widgetFont,
    settings: resolveLayoutSettings(document)
  });
  writeMetadata(pdf, document, env);
  // Before the PDF/A pass: it flushes the fonts, and nothing may be added to the file after that.
  const attachments = embedAttachments(pdf, { claim: asked, conformance: document.conformance, attachments: document.attachments, env, warnings });
  const pdfa = asked ? await applyPdfA(pdf, { claim: asked, conformance: document.conformance ?? {}, env, warnings }) : undefined;
  const bytes = await pdf.save({
    useObjectStreams: options.compact === true,
    addDefaultPage: false,
    updateFieldAppearances: false,
    objectsPerTick: Infinity
  });
  return {
    bytes,
    pages: laid.report,
    warnings: [...warnings, ...fontSet.takeWarnings()],
    ...(pdfa ? { pdfa } : {}),
    ...(attachments ? { attachments } : {})
  };
}
