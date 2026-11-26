/**
 * What a signature looks like on the page: a plain block — who signed, when, why —
 * drawn into the widget's `/AP /N` with an embedded font and DeviceRGB alone, the way the
 * PDF/A pass expects an appearance to be; or an empty appearance for an invisible signature.
 * The widget also gets `/TU` and `/Contents`, so a screen reader announces the signature.
 */
import { PDFDict, PDFDocument, PDFHexString, PDFName, PDFOperator, StandardFonts, degrees, drawRectangle, drawText, getDefaultSRGBProfile, rgb, type PDFFont } from "@cantoo/pdf-lib";
import * as fontkit from "fontkit";
import { PdfKernelError, base64ToBytes, type PdfFontResource, type PdfWarning } from "@argusvane/datum-engine/render";
import type { AcquiredField } from "./field.js";

export interface AppearanceOptions {
  lines: string[];
  fonts: readonly PdfFontResource[];
  fontId?: string;
  fontSize?: number;
  /** PDF/A: no standard font, ever. */
  strict: boolean;
  /** The document's output intent is not RGB: the stream declares `DefaultRGB`. */
  declareRgb: boolean;
  warnings: PdfWarning[];
}

const PADDING = 4;
const DEFAULT_FONT_SIZE = 8;

async function appearanceFont(pdf: PDFDocument, options: AppearanceOptions): Promise<PDFFont> {
  const resource = (options.fontId !== undefined ? options.fonts.find((candidate) => candidate.id === options.fontId) : undefined) ?? options.fonts[0];
  if (resource) {
    pdf.registerFontkit(fontkit as unknown as Parameters<PDFDocument["registerFontkit"]>[0]);
    return pdf.embedFont(base64ToBytes(resource.data), { subset: true, customName: "DatumSignatureFont" });
  }
  if (options.strict) {
    throw new PdfKernelError("font", "PDF/A needs every font embedded, and the signature request carries no font resource for the appearance; supply one.");
  }
  return pdf.embedFont(StandardFonts.Helvetica);
}

function encodable(font: PDFFont, line: string): string {
  try {
    font.encodeText(line);
    return line;
  } catch {
    return line.replace(/[^\x20-\x7e]/g, "?");
  }
}

/** The line cut to the width, an ellipsis marking the cut. */
function fit(font: PDFFont, line: string, size: number, width: number): string {
  if (font.widthOfTextAtSize(line, size) <= width) {
    return line;
  }
  let text = line;
  while (text.length > 1 && font.widthOfTextAtSize(`${text}…`, size) > width) {
    text = text.slice(0, -1);
  }
  return `${text}…`;
}

function defaultRgb(pdf: PDFDocument, field: AcquiredField): PDFDict | undefined {
  const resources = field.page.node.Resources();
  const spaces = resources?.lookupMaybe(PDFName.of("ColorSpace"), PDFDict);
  const existing = spaces?.get(PDFName.of("DefaultRGB"));
  const context = pdf.context;
  if (existing) {
    return context.obj({ DefaultRGB: existing });
  }
  const srgb = context.register(context.flateStream(getDefaultSRGBProfile(), { N: 3, Alternate: "DeviceRGB" }));
  return context.obj({ DefaultRGB: context.obj(["ICCBased", srgb]) });
}

/** An `/AP /N` with nothing in it — an invisible signature, or one PDF/A can still accept. */
export function emptyAppearance(pdf: PDFDocument, field: AcquiredField): void {
  const context = pdf.context;
  const empty = context.register(context.formXObject([], { BBox: [0, 0, field.rect.width, field.rect.height], Resources: {} }));
  field.widgetDict.set(PDFName.of("AP"), context.obj({ N: empty }));
}

/** The block drawn into the widget's rectangle: a border, the first line a little larger, the rest under it. */
export async function drawAppearance(pdf: PDFDocument, field: AcquiredField, options: AppearanceOptions): Promise<void> {
  const { width, height } = field.rect;
  if (width <= 0 || height <= 0 || options.lines.length === 0) {
    emptyAppearance(pdf, field);
    return;
  }
  const font = await appearanceFont(pdf, options);
  const size = options.fontSize ?? DEFAULT_FONT_SIZE;
  const titleSize = size + 2;
  const context = pdf.context;
  const operators: PDFOperator[] = [
    ...drawRectangle({
      x: 0.25,
      y: 0.25,
      width: width - 0.5,
      height: height - 0.5,
      color: undefined,
      borderWidth: 0.5,
      borderColor: rgb(0.6, 0.6, 0.6),
      rotate: degrees(0),
      xSkew: degrees(0),
      ySkew: degrees(0)
    })
  ];
  let baseline = height - PADDING - titleSize;
  const usable = width - PADDING * 2;
  options.lines.forEach((line, index) => {
    const lineSize = index === 0 ? titleSize : size;
    if (baseline < 0) {
      return;
    }
    const text = fit(font, encodable(font, line), lineSize, usable);
    operators.push(
      ...drawText(font.encodeText(text), {
        color: rgb(0, 0, 0),
        font: "F1",
        size: lineSize,
        x: PADDING,
        y: baseline,
        rotate: degrees(0),
        xSkew: degrees(0),
        ySkew: degrees(0)
      })
    );
    baseline -= lineSize * 1.3;
  });
  const colorSpace = options.declareRgb ? defaultRgb(pdf, field) : undefined;
  const resources = context.obj({ Font: context.obj({ F1: font.ref }), ...(colorSpace ? { ColorSpace: colorSpace } : {}) });
  const stream = context.register(context.formXObject(operators, { BBox: [0, 0, width, height], Resources: resources }));
  field.widgetDict.set(PDFName.of("AP"), context.obj({ N: stream }));
  const spoken = options.lines.slice(0, 2).join(", ");
  field.widgetDict.set(PDFName.of("TU"), PDFHexString.fromText(spoken));
  field.widgetDict.set(PDFName.of("Contents"), PDFHexString.fromText(spoken));
}
