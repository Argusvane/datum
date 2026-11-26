/**
 * Template areas: answers drawn onto the pages of an existing PDF where it has no
 * field to fill — a scanned form, a hand-laid one. Each area is a rectangle in points from the
 * page's top-left; its value is laid out as a paragraph by the same measurer generated
 * documents use and drawn by the same writer, clipped to the rectangle so a long answer stops
 * at the box's edge rather than running over what the page prints.
 *
 * A *fillable* area (`field`) is a widget instead: a text field or a check box created at the
 * rectangle with no border and no background, so nothing but its text shows over the page —
 * the PDF becomes fillable where the paper had a blank. Its value, if any, fills the field.
 */
import { PDFCheckBox, PDFDict, PDFRef, PDFTextField, TextAlignment, degrees, type Color, type PDFDocument, type PDFForm, type PDFPage } from "@cantoo/pdf-lib";
import { PDF_KERNEL_FALLBACKS } from "@argusvane/datum-engine/render";
import type { PdfAreaReport, PdfBlock, PdfFillArea, PdfFontResource, PdfThemeColors, PdfTypography, PdfWarning } from "@argusvane/datum-engine/render";
import { FontSet } from "./fonts.js";
import { measureFragment, translate, type Drawable, type LayoutContext } from "./layout.js";
import { resolveLayoutSettings } from "./settings.js";
import type { ExistingTagging } from "./tagging.js";
import { parseColor } from "./util/color.js";
import { asText, truthy } from "./util/fill-value.js";
import { displayRectToUser, pageSpace, type PageSpace } from "./page-space.js";
import { drawDrawables, setFieldTooltip, type DrawContext } from "./writer.js";

/** Wide enough that no answer wraps; the clip does the rest. */
const NO_WRAP_WIDTH = 1e6;
const EPSILON = 0.01;

/**
 * No border, no background: pdf-lib paints white and black unless the keys are *present* and
 * empty (it tests `'key' in options`), so they are spelled out here rather than left out.
 */
const NO_PAINT = { backgroundColor: undefined, borderColor: undefined, borderWidth: 0 } as unknown as { backgroundColor?: Color; borderColor?: Color; borderWidth: number };

const ALIGNMENT: Record<PdfFillArea["draw"]["align"], TextAlignment> = {
  start: TextAlignment.Left,
  center: TextAlignment.Center,
  end: TextAlignment.Right
};

export interface PlacedAreas {
  /** One per area, in request order. */
  reports: PdfAreaReport[];
  /** The widget-bearing field of each fillable area that got one, by area id. */
  fields: Map<string, PDFTextField | PDFCheckBox>;
}

function lineExtent(drawables: readonly Drawable[]): number {
  let extent = 0;
  for (const drawable of drawables) {
    if (drawable.kind === "text") {
      extent = Math.max(extent, drawable.x + drawable.piece.width);
    }
  }
  return extent;
}

/**
 * The fillable area's widget on its page: a text field (multiline when the area wraps, aligned
 * as the area is, at the area's size and colour) or a check box, transparent but for its text.
 * Two areas naming one field share it — the second gets another widget — while a name the
 * template already has is refused rather than taken over.
 */
function placeAreaField(
  form: PDFForm,
  page: PDFPage,
  area: PdfFillArea & { field: NonNullable<PdfFillArea["field"]> },
  created: Map<string, PDFTextField | PDFCheckBox>,
  warnings: PdfWarning[]
): { report: PdfAreaReport; field?: PDFTextField | PDFCheckBox } {
  const { rect, draw: style, field: spec } = area;
  const label = area.label ?? area.id;
  const name = spec.name;
  const refuse = (message: string): { report: PdfAreaReport } => {
    warnings.push({ code: "area.field", message: `Area "${label}": ${message}` });
    return { report: { id: area.id, page: area.page, status: "unsupported", field: name, message } };
  };
  const existing = created.get(name);
  if (!existing && form.getFieldMaybe(name)) {
    return refuse(`the template already has a field named "${name}"; the area was not made a field.`);
  }
  const box = widgetBox(pageSpace(page), rect);
  const textColor = parseColor(style.color, PDF_KERNEL_FALLBACKS.colors.text);
  try {
    if (style.kind === "check") {
      if (existing && !(existing instanceof PDFCheckBox)) {
        return refuse(`"${name}" is a text field made by another area; a check box cannot share it.`);
      }
      let field = existing;
      if (!field) {
        field = form.createCheckBox(name);
        if (spec.required) {
          field.enableRequired();
        }
        if (spec.readOnly) {
          field.enableReadOnly();
        }
        setFieldTooltip(field, spec.tooltip);
        created.set(name, field);
      }
      field.addToPage(page, { ...box, ...NO_PAINT, textColor });
      const on = truthy(area.value);
      if (on) {
        field.check();
      }
      return { report: { id: area.id, page: area.page, status: on ? "filled" : "empty", field: name }, field };
    }
    if (existing && !(existing instanceof PDFTextField)) {
      return refuse(`"${name}" is a check box made by another area; a text field cannot share it.`);
    }
    const text = asText(area.value);
    let field = existing;
    if (!field) {
      field = form.createTextField(name);
      if (style.wrap) {
        field.enableMultiline();
      }
      field.setAlignment(ALIGNMENT[style.align]);
      if (spec.required) {
        field.enableRequired();
      }
      if (spec.readOnly) {
        field.enableReadOnly();
      }
      setFieldTooltip(field, spec.tooltip);
      if (text !== "") {
        field.setText(text);
      }
      created.set(name, field);
    }
    field.addToPage(page, { ...box, ...NO_PAINT, textColor });
    // After the widget exists: a fresh field's default appearance carries no font operator to
    // resize until an appearance was generated. This marks the field dirty, so the form's
    // appearance pass redraws it at the size asked for.
    field.setFontSize(style.fontSize);
    return { report: { id: area.id, page: area.page, status: text === "" ? "empty" : "filled", field: name }, field };
  } catch (error) {
    return refuse(`the field could not be made: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * Where pdf-lib is to put the area's widget: the area is drawn on the displayed page (cropped,
 * turned by `/Rotate`), so its box goes into the page's own space, and the widget is turned
 * with the page (`/MK /R`, the way Acrobat makes fields on a turned page) so its text reads
 * upright. pdf-lib turns a widget about the corner it is given, counterclockwise, which is
 * the corner named here.
 */
function widgetBox(space: PageSpace, rect: { x: number; y: number; width: number; height: number }) {
  const user = displayRectToUser(space, rect);
  switch (space.rotation) {
    case 90:
      return { x: user.x + user.width, y: user.y, width: rect.width, height: rect.height, rotate: degrees(90) };
    case 180:
      return { x: user.x + user.width, y: user.y + user.height, width: rect.width, height: rect.height, rotate: degrees(180) };
    case 270:
      return { x: user.x, y: user.y + user.height, width: rect.width, height: rect.height, rotate: degrees(270) };
    default:
      return user;
  }
}

/** The widget `addToPage` just made: the last annotation of the page. */
function lastWidget(pdf: PDFDocument, page: PDFPage): { dict: PDFDict; ref: PDFRef } | undefined {
  const annots = page.node.Annots();
  const ref = annots && annots.size() > 0 ? annots.get(annots.size() - 1) : undefined;
  const dict = ref instanceof PDFRef ? pdf.context.lookupMaybe(ref, PDFDict) : undefined;
  return ref instanceof PDFRef && dict ? { dict, ref } : undefined;
}

export interface DrawAreasOptions {
  /** PDF/A: embedded fonts only. */
  strict?: boolean;
  /** PDF/A level "a": every drawn area and every widget made joins the template's structure tree. */
  tagging?: ExistingTagging;
  /**
   * The theme the fill plan was built under: what a content area draws with when
   * its own `draw` says nothing. Absent (a plan from an older engine): the kernel's fallbacks,
   * in the first resource's family.
   */
  typography?: PdfTypography;
  colors?: PdfThemeColors;
}

export async function drawAreas(
  pdf: PDFDocument,
  areas: readonly PdfFillArea[],
  fonts: PdfFontResource[],
  warnings: PdfWarning[],
  form?: PDFForm,
  options: DrawAreasOptions = {}
): Promise<PlacedAreas> {
  const fields = new Map<string, PDFTextField | PDFCheckBox>();
  if (areas.length === 0) {
    return { reports: [], fields };
  }
  const { tagging } = options;
  // Embeds nothing until a content area needs a face, so fillable-only requests cost no font.
  const fontSet = new FontSet(pdf, fonts, {}, { strict: options.strict === true, noPrivateUse: tagging !== undefined });
  const fallback = PDF_KERNEL_FALLBACKS.typography;
  const family = fonts[0]?.family ?? fallback.body.family;
  const colors = options.colors ?? PDF_KERNEL_FALLBACKS.colors;
  const ctx: LayoutContext = {
    fonts: fontSet,
    typography: options.typography ?? { ...fallback, body: { ...fallback.body, family } },
    colors,
    settings: resolveLayoutSettings(),
    textDirection: "ltr",
    images: new Map(),
    warnings
  };
  const drawBase: DrawContext = { images: new Map(), colors };
  const pages = pdf.getPages();
  const reports: PdfAreaReport[] = [];
  const createdByName = new Map<string, PDFTextField | PDFCheckBox>();
  for (const area of areas) {
    const name = area.label ?? area.id;
    const page = pages[area.page - 1];
    if (!page) {
      warnings.push({ code: "area.page", message: `Area "${name}" is on page ${area.page}, which the template does not have.` });
      reports.push({ id: area.id, page: area.page, status: "missing", message: `The template has ${pages.length} page${pages.length === 1 ? "" : "s"}.` });
      continue;
    }
    if (area.field) {
      if (!form) {
        warnings.push({ code: "area.field", message: `Area "${name}" asks for a field, but the document has no form to hold one.` });
        reports.push({ id: area.id, page: area.page, status: "unsupported", field: area.field.name, message: "No form to hold the field." });
        continue;
      }
      const placed = placeAreaField(form, page, { ...area, field: area.field }, createdByName, warnings);
      reports.push(placed.report);
      if (placed.field) {
        fields.set(area.id, placed.field);
        const widget = tagging ? lastWidget(pdf, page) : undefined;
        if (tagging && widget) {
          tagging.attachWidget(page, widget.dict, widget.ref);
        }
      }
      continue;
    }
    const { rect, draw: style } = area;
    // Drawn on the page as it is shown (cropped, turned), like the designer's viewer shows it.
    const space = pageSpace(page);
    const draw: DrawContext = space.identity ? drawBase : { ...drawBase, space: { height: space.height, matrix: space.matrix } };
    const padding = style.padding;
    const inner = { width: Math.max(1, rect.width - 2 * padding), height: Math.max(0, rect.height - 2 * padding) };

    if (style.kind === "check") {
      if (!truthy(area.value)) {
        reports.push({ id: area.id, page: area.page, status: "empty" });
        continue;
      }
      const side = Math.min(inner.width, inner.height);
      const box = { x: rect.x + (rect.width - side) / 2, y: rect.y + (rect.height - side) / 2, width: side, height: side };
      tagging?.markContent(page, "P");
      drawDrawables(page, [{ kind: "checkmark", rect: box, checked: true, color: style.color ?? "", border: false }], draw);
      tagging?.closeContent();
      reports.push({ id: area.id, page: area.page, status: "filled" });
      continue;
    }

    const text = asText(area.value);
    if (text === "") {
      reports.push({ id: area.id, page: area.page, status: "empty" });
      continue;
    }
    const block: PdfBlock = {
      id: area.id,
      kind: "paragraph",
      runs: [{ text, ...(style.bold ? { bold: true } : {}), ...(style.color ? { color: style.color } : {}) }],
      // Wrapped text is aligned line by line by the measurer; a single unwrapped line is shifted below.
      style: { size: style.fontSize, spacingBefore: 0, spacingAfter: 0, ...(style.wrap ? { align: style.align } : {}) }
    };
    const measured = await measureFragment([block], style.wrap ? inner.width : NO_WRAP_WIDTH, ctx);
    let drawables = measured.drawables;
    // The measurer centres each line's glyphs in a line box `lineHeight` tall; what has to fit
    // the area is the glyphs, from the first line's top to the last line's bottom, so the
    // leading outside them is set aside for the fit and the placement both.
    const lead = Math.max(0, ((ctx.typography.body.lineHeight ?? 1.35) - 1) * style.fontSize) / 2;
    const glyphHeight = measured.height - 2 * lead;
    let overflow = glyphHeight > inner.height + EPSILON;
    if (!style.wrap) {
      const extent = lineExtent(drawables);
      overflow = overflow || extent > inner.width + EPSILON;
      const slack = inner.width - extent;
      const shift = style.align === "center" ? slack / 2 : style.align === "end" ? slack : 0;
      drawables = shift === 0 ? drawables : translate(drawables, shift, 0);
    }
    const free = Math.max(0, inner.height - glyphHeight);
    const dy = -lead + (style.valign === "middle" ? free / 2 : style.valign === "bottom" ? free : 0);
    // The marked-content sequence encloses the clip's `q … Q`, so the two nest.
    tagging?.markContent(page, "P");
    drawDrawables(page, translate(drawables, rect.x + padding, rect.y + padding + dy), draw, rect);
    tagging?.closeContent();
    if (overflow) {
      warnings.push({ code: "area.overflow", message: `Area "${name}" on page ${area.page} holds more than its box; the rest is clipped.` });
      reports.push({ id: area.id, page: area.page, status: "overflow", message: "The value did not fit; it was clipped at the box's edge." });
    } else {
      reports.push({ id: area.id, page: area.page, status: "filled" });
    }
  }
  warnings.push(...fontSet.takeWarnings());
  return { reports, fields };
}
