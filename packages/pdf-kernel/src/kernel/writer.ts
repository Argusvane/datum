/**
 * Drawables to pdf-lib calls: pages, text, rules, boxes, images and AcroForm widgets, then
 * the document's metadata — with the structure tree beside them when the document is tagged.
 * Every pdf-lib call the kernel makes for a generated document is in this file, so swapping
 * the library touches one place. Templates fill their fields in `template.ts` and draw their
 * areas through {@link drawDrawables} here.
 */
import {
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFHexString,
  PDFImage,
  PDFName,
  PDFOptionList,
  PDFRadioGroup,
  PDFString,
  PDFTextField,
  clip,
  concatTransformationMatrix,
  endPath,
  popGraphicsState,
  pushGraphicsState,
  rectangle,
  type PDFForm,
  type PDFPage,
  type PDFRef
} from "@cantoo/pdf-lib";
import type { PdfDocument, PdfFormFieldSpec, PdfKernelEnv, PdfWarning } from "@argusvane/datum-engine/render";
import type { FontSet, LoadedFont } from "./fonts.js";
import type { Drawable, LaidOutPage, Rect } from "./layout.js";
import type { LayoutSettings } from "./settings.js";
import { Tagging } from "./tagging.js";
import { parseColor } from "./util/color.js";
import { sha256Hex } from "./util/sha256.js";

export interface WriteContext {
  document: PDFDocument;
  /** The model being written; its accessibility choice decides whether a structure tree is built. */
  model: PdfDocument;
  fonts: FontSet;
  images: Map<string, PDFImage>;
  colors: PdfDocument["colors"];
  warnings: PdfWarning[];
  /** The font widget appearances are generated with. */
  widgetFont: LoadedFont;
  /** The theme's geometry: widget borders, fills and font size. */
  settings: LayoutSettings;
}

/**
 * What drawing content (no widgets) needs: the embedded images and the fallback colours, and —
 * on a template page shown cropped or turned — the displayed page's height and the matrix from
 * it to the page's own space (see `page-space.ts`), so what is drawn top-down on the displayed
 * page lands there.
 */
export type DrawContext = Pick<WriteContext, "images" | "colors"> & {
  space?: { height: number; matrix: [number, number, number, number, number, number] } | undefined;
};

type FieldHandle = PDFTextField | PDFCheckBox | PDFRadioGroup | PDFDropdown | PDFOptionList | "signature";

interface WidgetPlacement {
  dict: PDFDict;
  ref: PDFRef;
}

/** A top-down layout rectangle in PDF space: the page's own coordinates, y from the bottom. */
export function pdfRect(page: PDFPage, rect: Rect, height = page.getHeight()): { x: number; y: number; width: number; height: number } {
  return { x: rect.x, y: height - rect.y - rect.height, width: rect.width, height: rect.height };
}

export async function writePages(pages: readonly LaidOutPage[], ctx: WriteContext): Promise<void> {
  const form = ctx.document.getForm();
  const fields = new Map<string, FieldHandle>();
  const tagging = ctx.model.accessibility.tagged ? new Tagging(ctx.document, ctx.model) : undefined;
  pages.forEach((laid, index) => {
    const page = ctx.document.addPage([laid.width, laid.height]);
    // Tab order follows the page's structure (reading order), which is how the widgets were laid out.
    page.node.set(PDFName.of("Tabs"), PDFName.of("S"));
    tagging?.beginPage(page, index);
    for (const drawable of laid.drawables) {
      if (drawable.kind === "widget") {
        tagging?.closeContent(page);
        const placed = drawWidget(drawable, page, form, fields, ctx);
        if (placed && tagging && !drawable.artifact) {
          tagging.attachWidget(page, drawable.blockId, placed.dict, placed.ref);
        }
        continue;
      }
      const decoration = drawable.kind === "rect" || drawable.kind === "line";
      tagging?.markFor(page, drawable.blockId, decoration || drawable.artifact === true);
      drawOne(drawable, page, ctx);
    }
    tagging?.closeContent(page);
  });
  form.updateFieldAppearances(ctx.widgetFont.font);
  tagging?.finish();
}

/**
 * Content drawables onto a page — one the kernel made or one it loaded. With `clip`, nothing
 * lands outside that rectangle: a value longer than its area stops at the area's edge instead
 * of running over what the page already prints. Widgets are not content; `writePages` places them.
 */
export function drawDrawables(page: PDFPage, drawables: readonly Drawable[], ctx: DrawContext, clipTo?: Rect): void {
  const space = ctx.space;
  if (space) {
    // Drawn on the displayed page: the matrix takes it to where the page keeps it.
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...space.matrix));
  }
  if (clipTo) {
    const rect = pdfRect(page, clipTo, space?.height);
    page.pushOperators(pushGraphicsState(), rectangle(rect.x, rect.y, rect.width, rect.height), clip(), endPath());
  }
  for (const drawable of drawables) {
    if (drawable.kind !== "widget") {
      drawOne(drawable, page, ctx);
    }
  }
  if (clipTo) {
    page.pushOperators(popGraphicsState());
  }
  if (space) {
    page.pushOperators(popGraphicsState());
  }
}

function drawOne(drawable: Exclude<Drawable, { kind: "widget" }>, page: PDFPage, ctx: DrawContext): void {
  const height = ctx.space?.height ?? page.getHeight();
  switch (drawable.kind) {
    case "text": {
      const { piece } = drawable;
      page.drawText(piece.text, {
        x: drawable.x,
        y: height - drawable.baselineY,
        size: piece.size,
        font: piece.font.font,
        color: parseColor(piece.color, ctx.colors.text)
      });
      return;
    }
    case "line":
      page.drawLine({
        start: { x: drawable.x1, y: height - drawable.y1 },
        end: { x: drawable.x2, y: height - drawable.y2 },
        thickness: drawable.thickness,
        color: parseColor(drawable.color, ctx.colors.border)
      });
      return;
    case "rect": {
      const rect = pdfRect(page, drawable.rect, height);
      page.drawRectangle({
        ...rect,
        ...(drawable.fill ? { color: parseColor(drawable.fill, ctx.colors.surface) } : {}),
        ...(drawable.stroke ? { borderWidth: drawable.stroke.width, borderColor: parseColor(drawable.stroke.color, ctx.colors.border) } : { borderWidth: 0 }),
        // Rounded corners (a theme's control radius); with none the operators are the plain rectangle's.
        ...(drawable.radius ? { rx: drawable.radius, ry: drawable.radius } : {})
      });
      return;
    }
    case "image": {
      const image = ctx.images.get(drawable.resourceId);
      if (!image) {
        return;
      }
      page.drawImage(image, pdfRect(page, drawable.rect, height));
      return;
    }
    case "checkmark": {
      const rect = pdfRect(page, drawable.rect, height);
      const color = parseColor(drawable.color, ctx.colors.text);
      const borderWidth = drawable.borderWidth ?? 0.75;
      if (drawable.shape === "circle") {
        // A radio: a circle, and a dot in the mark colour when chosen.
        const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        if (drawable.border !== false) {
          page.drawCircle({ ...centre, size: rect.width / 2, borderWidth, borderColor: color });
        }
        if (drawable.checked) {
          const dot = drawable.dotSize ?? rect.width * 0.45;
          page.drawCircle({ ...centre, size: dot / 2, color: parseColor(drawable.markColor ?? drawable.color, ctx.colors.text) });
        }
        return;
      }
      if (drawable.border !== false) {
        page.drawRectangle({ ...rect, borderWidth, borderColor: color, ...(drawable.radius ? { rx: drawable.radius, ry: drawable.radius } : {}) });
      }
      if (drawable.checked) {
        const thickness = drawable.markStroke ?? 1.2;
        const { x, y, width, height } = rect;
        page.drawLine({ start: { x: x + width * 0.2, y: y + height * 0.5 }, end: { x: x + width * 0.42, y: y + height * 0.22 }, thickness, color });
        page.drawLine({ start: { x: x + width * 0.42, y: y + height * 0.22 }, end: { x: x + width * 0.82, y: y + height * 0.8 }, thickness, color });
      }
      return;
    }
  }
}

/** A text-carrying widget's look: the theme's control border and fill (pdf-lib fills white when none is given, so the fallback changes nothing). */
function fieldOptions(rect: { x: number; y: number; width: number; height: number }, ctx: WriteContext) {
  const controls = ctx.settings.controls;
  return {
    ...rect,
    font: ctx.widgetFont.font,
    borderWidth: controls.borderWidth,
    borderColor: parseColor(ctx.colors.controlBorder ?? ctx.colors.border, "#999999"),
    backgroundColor: parseColor(ctx.colors.controlFill ?? "#ffffff", "#ffffff"),
    textColor: parseColor(ctx.colors.text, "#111111")
  };
}

/** A check box or radio widget's look: the theme's choice border, in the control border colour. */
function choiceOptions(rect: { x: number; y: number; width: number; height: number }, ctx: WriteContext) {
  return {
    ...rect,
    borderWidth: ctx.settings.choice.borderWidth,
    borderColor: parseColor(ctx.colors.controlBorder ?? ctx.colors.border, "#999999")
  };
}

/**
 * The appearance's font size: the theme's, unless a single-line value would not
 * fit the widget at that size — then the viewer's automatic size, which shrinks to fit. A
 * theme that names none leaves the automatic size, as every document did before.
 */
function sizeAppearance(field: PDFTextField | PDFDropdown | PDFOptionList, spec: PdfFormFieldSpec, rect: { width: number }, ctx: WriteContext): void {
  const size = ctx.settings.controls.fontSize;
  if (size === undefined) {
    return;
  }
  if (spec.kind === "text" && typeof spec.value === "string" && spec.value.length > 0) {
    const available = rect.width - 2 * (ctx.settings.controls.borderWidth + 1);
    if (ctx.widgetFont.font.widthOfTextAtSize(ctx.fonts.encodable(spec.value, ctx.widgetFont), size) > available) {
      return;
    }
  }
  field.setFontSize(size);
}

/** The tooltip a reader announces for a field (`/TU`); pdf-lib has no setter for it. */
export function setFieldTooltip(field: { acroField: { dict: PDFDict } }, tooltip: string | undefined): void {
  if (tooltip) {
    field.acroField.dict.set(PDFName.of("TU"), PDFHexString.fromText(tooltip));
  }
}

function setTooltip(field: { acroField: { dict: PDFDict } }, spec: PdfFormFieldSpec): void {
  setFieldTooltip(field, spec.tooltip);
}

/** The widget a field most recently gained, for the structure tree. */
function lastWidget(field: { acroField: { getWidgets(): Array<{ dict: PDFDict }> } }, ctx: WriteContext): WidgetPlacement | undefined {
  const widgets = field.acroField.getWidgets();
  const widget = widgets[widgets.length - 1];
  const ref = widget ? ctx.document.context.getObjectRef(widget.dict) : undefined;
  return widget && ref ? { dict: widget.dict, ref } : undefined;
}

function drawWidget(
  drawable: Extract<Drawable, { kind: "widget" }>,
  page: PDFPage,
  form: PDFForm,
  fields: Map<string, FieldHandle>,
  ctx: WriteContext
): WidgetPlacement | undefined {
  const spec = drawable.field;
  const rect = pdfRect(page, drawable.rect);
  const existing = fields.get(spec.name);
  try {
    switch (spec.kind) {
      case "text":
      case "multiline": {
        let field: PDFTextField;
        if (existing instanceof PDFTextField) {
          field = existing;
        } else {
          field = form.createTextField(spec.name);
          fields.set(spec.name, field);
          if (spec.kind === "multiline") {
            field.enableMultiline();
          }
          if (spec.maxLength !== undefined) {
            field.setMaxLength(spec.maxLength);
          }
          if (spec.required) {
            field.enableRequired();
          }
          if (spec.readOnly) {
            field.enableReadOnly();
          }
          if (typeof spec.value === "string" && spec.value.length > 0) {
            field.setText(ctx.fonts.encodable(spec.value, ctx.widgetFont));
          }
          setTooltip(field, spec);
        }
        field.addToPage(page, fieldOptions(rect, ctx));
        sizeAppearance(field, spec, rect, ctx);
        return lastWidget(field, ctx);
      }
      case "checkbox": {
        let field: PDFCheckBox;
        if (existing instanceof PDFCheckBox) {
          field = existing;
        } else {
          field = form.createCheckBox(spec.name);
          fields.set(spec.name, field);
          if (spec.value === true) {
            field.check();
          }
          if (spec.required) {
            field.enableRequired();
          }
          if (spec.readOnly) {
            field.enableReadOnly();
          }
          setTooltip(field, spec);
        }
        field.addToPage(page, choiceOptions(rect, ctx));
        return lastWidget(field, ctx);
      }
      case "radio": {
        let field: PDFRadioGroup;
        if (existing instanceof PDFRadioGroup) {
          field = existing;
        } else {
          field = form.createRadioGroup(spec.name);
          fields.set(spec.name, field);
          if (spec.required) {
            field.enableRequired();
          }
          if (spec.readOnly) {
            field.enableReadOnly();
          }
          setTooltip(field, spec);
        }
        const option = drawable.option ?? "";
        field.addOptionToPage(option, page, choiceOptions(rect, ctx));
        if (typeof spec.value === "string" && spec.value === option) {
          field.select(option);
        }
        return lastWidget(field, ctx);
      }
      case "dropdown":
      case "listbox": {
        const labels = (spec.options ?? []).map((option) => ctx.fonts.encodable(option.label, ctx.widgetFont));
        const labelFor = (value: string): string | undefined => {
          const index = (spec.options ?? []).findIndex((option) => option.value === value);
          return index >= 0 ? labels[index] : undefined;
        };
        if (spec.kind === "dropdown") {
          let field: PDFDropdown;
          if (existing instanceof PDFDropdown) {
            field = existing;
          } else {
            field = form.createDropdown(spec.name);
            fields.set(spec.name, field);
            field.addOptions(labels);
            const selected = typeof spec.value === "string" ? labelFor(spec.value) : undefined;
            if (selected !== undefined) {
              field.select(selected);
            }
            if (spec.required) {
              field.enableRequired();
            }
            if (spec.readOnly) {
              field.enableReadOnly();
            }
            setTooltip(field, spec);
          }
          field.addToPage(page, fieldOptions(rect, ctx));
          sizeAppearance(field, spec, rect, ctx);
          return lastWidget(field, ctx);
        }
        let field: PDFOptionList;
        if (existing instanceof PDFOptionList) {
          field = existing;
        } else {
          field = form.createOptionList(spec.name);
          fields.set(spec.name, field);
          field.addOptions(labels);
          field.enableMultiselect();
          const values = Array.isArray(spec.value) ? spec.value : typeof spec.value === "string" ? [spec.value] : [];
          const selected = values.map(labelFor).filter((label): label is string => label !== undefined);
          if (selected.length > 0) {
            field.select(selected);
          }
          if (spec.required) {
            field.enableRequired();
          }
          if (spec.readOnly) {
            field.enableReadOnly();
          }
          setTooltip(field, spec);
        }
        field.addToPage(page, fieldOptions(rect, ctx));
        sizeAppearance(field, spec, rect, ctx);
        return lastWidget(field, ctx);
      }
      case "signature": {
        if (existing === "signature") {
          ctx.warnings.push({ code: "widget.duplicateSignature", message: `Signature field "${spec.name}" appears more than once; only the first is a field.` });
          page.drawRectangle({ ...rect, borderWidth: 0.5, borderColor: parseColor(ctx.colors.border, "#999999") });
          return undefined;
        }
        fields.set(spec.name, "signature");
        const context = ctx.document.context;
        const dict = context.obj({
          FT: "Sig",
          T: PDFHexString.fromText(spec.name),
          Type: "Annot",
          Subtype: "Widget",
          Rect: [rect.x, rect.y, rect.x + rect.width, rect.y + rect.height],
          F: 4,
          P: page.ref,
          ...(spec.tooltip ? { TU: PDFHexString.fromText(spec.tooltip) } : {}),
          ...(spec.required ? { Ff: 2 } : {})
        });
        const ref = context.register(dict);
        form.acroForm.addField(ref);
        page.node.addAnnot(ref);
        page.drawRectangle({ ...rect, borderWidth: 0.5, borderColor: parseColor(ctx.colors.border, "#999999") });
        return { dict, ref };
      }
    }
  } catch (error) {
    ctx.warnings.push({
      code: "widget.failed",
      message: `Field "${spec.name}" (${spec.kind}) could not be created: ${error instanceof Error ? error.message : String(error)}`
    });
    return undefined;
  }
}

/** `D:YYYYMMDDHHmmSSZ`, the PDF date string, from an ISO instant — no `Date` needed. */
export function pdfDateString(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso);
  if (!match) {
    return "D:20000101000000Z";
  }
  return `D:${match[1]}${match[2]}${match[3]}${match[4]}${match[5]}${match[6]}Z`;
}

export function writeMetadata(pdf: PDFDocument, document: PdfDocument, env: PdfKernelEnv): void {
  pdf.setTitle(document.metadata.title, { showInWindowTitleBar: document.accessibility.displayDocTitle });
  pdf.setLanguage(document.metadata.lang);
  pdf.setProducer(env.producer ?? "Datum PDF kernel");
  pdf.setCreator(env.creator ?? "Datum");
  if (document.metadata.subject) {
    pdf.setSubject(document.metadata.subject);
  }
  if (document.metadata.author) {
    pdf.setAuthor(document.metadata.author);
  }
  if (document.metadata.keywords && document.metadata.keywords.length > 0) {
    pdf.setKeywords(document.metadata.keywords);
  }
  const context = pdf.context;
  const infoRef = context.trailerInfo.Info;
  const info = infoRef ? context.lookup(infoRef, PDFDict) : undefined;
  if (info) {
    const stamp = PDFString.of(pdfDateString(env.createdAt));
    info.set(PDFName.of("CreationDate"), stamp);
    info.set(PDFName.of("ModDate"), stamp);
  }
  const id = sha256Hex(env.documentId).slice(0, 32);
  context.trailerInfo.ID = context.obj([PDFHexString.of(id), PDFHexString.of(id)]);
}
