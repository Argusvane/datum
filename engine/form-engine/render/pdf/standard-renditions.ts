/**
 * The engine's built-in PDF renditions: the paper counterpart of `fieldHtml`'s
 * default markup. A component type the engine already draws on screen is drawn here too, and a
 * type it does not know falls to the generic rendition, so every component prints somehow.
 *
 * Ids are a small shared vocabulary, so a layout's `renditionDefaults: { "*": "field" }` means
 * the same thing across types:
 *
 * - `text`      the label and the value as text (the "filled record" rendition)
 * - `field`     an AcroForm widget carrying the value (the "fillable" rendition)
 * - `ruled`     the label and blank rules to write on (the "print and fill by hand" rendition)
 * - `checkmark` / `checklist`  a drawn box per option, ticked or not
 * - `image`     the picture itself
 * - `group` / `section` / `sections` / `table`  how containers and collections lay out
 */
import type { ComponentPdfDefinition } from "../../core/schema/contracts.js";
import { HTML_COMPONENT_TYPE } from "../../core/schema/static-html.js";
import { IMAGE_COMPONENT_TYPE } from "../../core/schema/image.js";
import { FILE_COMPONENT_TYPE, isBase64FileAttachment } from "../../core/schema/file-upload.js";
import { BUTTON_COMPONENT_TYPE } from "../../core/schema/button.js";
import { BUTTON_GROUP_COMPONENT_TYPE } from "../../core/schema/button-group.js";
import { DATA_GRID_COMPONENT_TYPE } from "../../core/schema/data-grid.js";
import { readGridColumnWidths } from "../../core/schema/grid.js";
import { GRID_TRACK_COUNT } from "../../core/schema/grid.js";
import { addressOf, resolveText } from "../../core/localization/translations.js";
import type { ComponentNode } from "../../core/schema/types.js";
import { readLegendMark } from "../../core/schema/legend-mark.js";
import { readTabDescriptors } from "../core/tab-slots.js";
import { rowHeadingOf } from "../core/error-wording.js";
import { scalarText } from "../core/scalar-text.js";
import { createFormTextResolver, type FormTextResolver } from "../../core/localization/form-texts.js";
import type {
  PdfBlock,
  PdfBoxBlock,
  PdfControlKind,
  PdfFormFieldKind,
  PdfFormFieldSpec,
  PdfHeadingBlock,
  PdfLabelValueBlock,
  PdfListBlock,
  PdfListItem,
  PdfTableCell,
  PdfTableRow,
  PdfTextRun,
  PdfWidgetBlock
} from "./pdf-document.js";
import type { RenderComponentModel } from "../core/component-model.js";
import { pdfBlocksPrint } from "./pdf-document.js";
import type { PdfRenditionContext, PdfRenditionRenderer } from "./pdf-renditions.js";
import { stripAnswerBidi, type PdfChoiceItem, type PdfFormattedValue } from "./pdf-values.js";

export const GENERIC_PDF_RENDITION_ID = "text";

type Renderer = PdfRenditionRenderer;

/** Component types whose answer is never printed back: what a reader of the paper sees is a mask. */
const MASKED_TYPES: ReadonlySet<string> = new Set(["password"]);

/** What a given masked answer prints in its place, the mask the review and print surfaces show. */
export const PDF_ANSWER_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022";

/** Whether a component's answer prints as {@link PDF_ANSWER_MASK}: by its type (after the `kinds` map was applied), as the review masks it. */
function isMasked(model: RenderComponentModel): boolean {
  return MASKED_TYPES.has(model.type);
}

/** A formatted answer as the text drawn for it: the theme's empty word for none, the mask for a masked type. */
function answerText(model: RenderComponentModel, formatted: PdfFormattedValue, empty: string): string {
  return formatted.empty ? empty : isMasked(model) ? PDF_ANSWER_MASK : formatted.text;
}

function valueRuns(context: PdfRenditionContext): PdfTextRun[] {
  return [{ text: answerText(context.model, context.value, context.texts.empty) }];
}

/** The option values a stored choice answer picks: one, several, or the ticked keys of a checkboxes object. */
function storedChoices(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry) => entry !== undefined && entry !== null).map(scalarText).filter((entry) => entry !== "");
  }
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, picked]) => picked === true)
      .map(([key]) => key);
  }
  const text = scalarText(value);
  return text === "" ? [] : [text];
}

/**
 * A choice's options, with every stored answer no option lists after them as a chosen item of
 * its own, labelled by the stored value: an answer from before the list changed, or one whose
 * data source failed to load, still prints, as print's filled choice keeps it.
 */
function choiceItems(context: PdfRenditionContext): PdfChoiceItem[] {
  const items = [...(context.value.items ?? [])];
  const listed = new Set(items.map((item) => item.value));
  for (const stored of storedChoices(context.model.value)) {
    if (!listed.has(stored)) {
      listed.add(stored);
      items.push({ value: stored, label: stripAnswerBidi(stored), checked: true });
    }
  }
  return items;
}

/**
 * An option value as one part of an AcroForm field name. A `.` separates a name's parts, so it
 * is written `%2E`, and `%` is written `%25` so two values never share a part.
 */
export function pdfFieldNamePart(value: string): string {
  return value.replace(/%/g, "%25").replace(/\./g, "%2E");
}

/** The words of the form a rendition draws that no field supplies (a row's heading, an untitled tab's caption). */
function formTextOf(context: PdfRenditionContext): FormTextResolver {
  return createFormTextResolver(context.locale, undefined, undefined, { translations: context.translations, catalog: context.translationCatalog });
}

function blockStyle(context: PdfRenditionContext) {
  const style = context.style;
  const out: NonNullable<PdfBlock["style"]> = {};
  if (style.spacingBefore !== undefined) {
    out.spacingBefore = style.spacingBefore;
  }
  if (style.spacingAfter !== undefined) {
    out.spacingAfter = style.spacingAfter;
  }
  if (style.color !== undefined) {
    out.color = style.color;
  }
  if (style.size !== undefined) {
    out.size = style.size;
  }
  return Object.keys(out).length > 0 ? { style: out } : {};
}

/**
 * What the theme draws beside a label: the field's hint when the theme shows
 * hints, and the required marker when the theme words one. Absent keys stay absent: a
 * theme that asks for neither adds nothing to the block.
 */
function fieldDecor(context: PdfRenditionContext): { hint?: string; labelSuffix?: string } {
  const out: { hint?: string; labelSuffix?: string } = {};
  if (context.theme.fields.hints === "shown" && context.model.description) {
    out.hint = context.model.description;
  }
  if (context.model.accessibility.required && context.texts.required !== "" && context.label !== undefined) {
    out.labelSuffix = ` ${context.texts.required}`;
  }
  return out;
}

/** A field's prefix and suffix, printed with its value under every theme — on screen they are part of the box. */
function affixes(model: RenderComponentModel): { prefix?: string; suffix?: string } {
  return {
    ...(model.prefix ? { prefix: model.prefix } : {}),
    ...(model.suffix ? { suffix: model.suffix } : {})
  };
}

/** The control a framed value stands in for, from the component's type. */
function controlKind(type: string): PdfControlKind {
  switch (type) {
    case "textarea":
      return "textarea";
    case "select":
    case "multiselect":
      return "select";
    case "date":
      return "date";
    case FILE_COMPONENT_TYPE:
      return "file";
    case "text":
    case "email":
    case "tel":
    case "url":
    case "number":
    case "time":
      return "text";
    default:
      return "other";
  }
}

/** The frame the theme puts around a stacked value, and the width the theme gives the type. */
function frameFor(context: PdfRenditionContext, arrangement: PdfLabelValueBlock["arrangement"], type: string): Pick<PdfLabelValueBlock, "frame" | "control" | "width"> {
  return {
    ...(context.theme.controls.valueFrame === "box" && arrangement === "stacked" ? { frame: true, control: controlKind(type) } : {}),
    ...(context.style.width !== undefined ? { width: context.style.width } : {})
  };
}

function labelValue(
  context: PdfRenditionContext,
  arrangement: PdfLabelValueBlock["arrangement"],
  lines?: number
): PdfLabelValueBlock {
  return {
    id: context.nextId(arrangement),
    kind: "labelValue",
    componentId: context.model.id,
    label: context.label ?? "",
    value: valueRuns(context),
    arrangement,
    ...(lines !== undefined ? { lines } : {}),
    ...fieldDecor(context),
    ...affixes(context.model),
    ...frameFor(context, arrangement, context.model.type),
    ...blockStyle(context)
  };
}

/** Label and value as text; the arrangement follows the theme's style for the type. */
const textRendition: Renderer = (_node, context) => [
  labelValue(context, context.style.labelArrangement ?? "stacked")
];

/** Label and rules to write on. Any value present is drawn on the first rule. */
function ruledRendition(defaultLines: number): Renderer {
  return (_node, context) => [labelValue(context, "ruled", context.style.ruledLines ?? defaultLines)];
}

function fieldSpec(context: PdfRenditionContext, kind: PdfFormFieldKind): PdfFormFieldSpec {
  const spec: PdfFormFieldSpec = { name: context.fieldName, kind };
  if (context.model.accessibility.required) {
    spec.required = true;
  }
  if (context.model.maxLength !== undefined) {
    // The form counts characters (code points), a PDF field UTF-16 units: the limit is widened to
    // the answer's own length in units, so an answer of astral characters within the limit, or
    // one stored past it, is written whole rather than refused by the field.
    const answer = !context.value.empty && !isMasked(context.model) ? context.value.text.length : 0;
    spec.maxLength = Math.max(context.model.maxLength, answer);
  }
  const tooltip = context.model.description ?? context.model.tooltip;
  if (tooltip) {
    spec.tooltip = tooltip;
  }
  return spec;
}

function widget(
  context: PdfRenditionContext,
  field: PdfFormFieldSpec,
  labelPosition: PdfWidgetBlock["labelPosition"] = "above",
  label: string | undefined = context.label
): PdfWidgetBlock {
  return {
    id: context.nextId("widget"),
    kind: "widget",
    componentId: context.model.id,
    field,
    ...(label !== undefined ? { label } : {}),
    labelPosition,
    ...(context.style.widgetHeight !== undefined ? { height: context.style.widgetHeight } : {}),
    ...(context.style.width !== undefined ? { width: context.style.width } : {}),
    ...fieldDecor(context),
    ...affixes(context.model),
    ...blockStyle(context)
  };
}

/** A text-carrying widget: single line, or multiline for a textarea. */
function textFieldRendition(kind: "text" | "multiline"): Renderer {
  return (_node, context) => {
    const field = fieldSpec(context, kind);
    // A masked answer is not written into the field, whose value a reader could copy out.
    if (!context.value.empty && !isMasked(context.model)) {
      field.value = context.value.text;
    }
    return [widget(context, field)];
  };
}

const checkboxFieldRendition: Renderer = (_node, context) => {
  const field = fieldSpec(context, "checkbox");
  field.value = context.value.checked === true;
  return [widget(context, field, "after")];
};

/**
 * Every option of a choice as its own checkbox widget, named `<field>.<option>` with the option
 * written by {@link pdfFieldNamePart}, its on state named by the option's value. Required means at
 * least one on screen, which no single box can say, so none of them is marked required.
 */
const checkboxesFieldRendition: Renderer = (_node, context) => {
  const blocks: PdfBlock[] = [];
  if (context.label !== undefined) {
    const suffix = fieldDecor(context).labelSuffix;
    blocks.push({
      id: context.nextId("label"),
      kind: "paragraph",
      componentId: context.model.id,
      runs: [{ text: context.label, bold: true }, ...(suffix !== undefined ? [{ text: suffix, bold: false }] : [])],
      role: "P"
    });
  }
  for (const item of choiceItems(context)) {
    const field = fieldSpec(context, "checkbox");
    delete field.required;
    field.name = `${context.fieldName}.${pdfFieldNamePart(item.value)}`;
    field.value = item.checked;
    field.exportValue = item.value;
    blocks.push(widget(context, field, "after", item.label));
  }
  return blocks;
};

/** A dropdown / radio group / listbox carrying the options and the picked one(s). */
function choiceFieldRendition(kind: "dropdown" | "radio" | "listbox"): Renderer {
  return (_node, context) => {
    const field = fieldSpec(context, kind);
    const items = choiceItems(context);
    field.options = items.map((item) => ({ value: item.value, label: item.label }));
    const picked = items.filter((item) => item.checked).map((item) => item.value);
    if (kind === "listbox") {
      field.value = picked;
    } else if (picked[0] !== undefined) {
      field.value = picked[0];
    }
    return [widget(context, field)];
  };
}

const checkmarkRendition: Renderer = (_node, context) => {
  const { hint } = fieldDecor(context);
  return [
    {
      id: context.nextId("checkmark"),
      kind: "checkmark",
      componentId: context.model.id,
      label: context.label ?? "",
      checked: context.value.checked === true,
      ...(hint !== undefined ? { hint } : {}),
      ...blockStyle(context)
    }
  ];
};

/** Every option with the picked ones marked: squares with ticks, or circles with a dot for a single choice. */
function checklistRendition(marker: "check" | "radio"): Renderer {
  return (_node, context) => [
    {
      id: context.nextId("checklist"),
      kind: "checklist",
      componentId: context.model.id,
      ...(context.label !== undefined ? { label: context.label } : {}),
      items: choiceItems(context).map((item) => ({
        label: item.label,
        checked: item.checked,
        ...(item.description ? { description: item.description } : {})
      })),
      marker,
      ...fieldDecor(context),
      ...blockStyle(context)
    }
  ];
}

/** A text-shaped widget listing the attached files' names; the bytes do not travel. */
const fileFieldRendition: Renderer = (_node, context) => {
  const field = fieldSpec(context, "text");
  field.readOnly = true;
  if (!context.value.empty) {
    field.value = context.value.text;
  }
  return [widget(context, field)];
};

/** The attached pictures themselves, when the attachment carries PNG or JPEG bytes; else the names. */
const fileImageRendition: Renderer = (node, context) => {
  const blocks: PdfBlock[] = [];
  for (const attachment of context.model.file?.attachments ?? []) {
    if (
      isBase64FileAttachment(attachment) &&
      (attachment.type === "image/png" || attachment.type === "image/jpeg")
    ) {
      const resourceId = context.addImage({ type: attachment.type, data: attachment.data });
      blocks.push({
        id: context.nextId("image"),
        kind: "image",
        componentId: context.model.id,
        resourceId,
        alt: attachment.name,
        role: "Figure",
        ...blockStyle(context)
      });
    }
  }
  return blocks.length > 0 ? blocks : textRendition(node, context);
};

const DATA_URL = /^data:(image\/(?:png|jpeg));base64,([A-Za-z0-9+/=\s]+)$/;

/** An `image` component: the picture, from its bytes when the URL carries them, else by URL for the host to fetch. */
const imageRendition: Renderer = (_node, context) => {
  const image = context.model.image;
  if (!image?.src) {
    return [];
  }
  const dataMatch = DATA_URL.exec(image.src);
  const resourceId = context.addImage(
    dataMatch
      ? { type: dataMatch[1] as "image/png" | "image/jpeg", data: dataMatch[2]!.replace(/\s+/g, "") }
      : { url: image.src }
  );
  return [
    {
      id: context.nextId("image"),
      kind: "image",
      componentId: context.model.id,
      resourceId,
      alt: image.alt,
      role: "Figure",
      ...(image.width !== undefined ? { width: image.width * 0.75 } : {}),
      ...(image.height !== undefined ? { height: image.height * 0.75 } : {}),
      ...blockStyle(context)
    }
  ];
};

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };

function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const code = entity[1]?.toLowerCase() === "x" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
      // As a browser decodes it: NUL, a surrogate or a number past U+10FFFF is the replacement character.
      return code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff) ? String.fromCodePoint(code) : "\uFFFD";
    }
    return ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

/** Tags that end the paragraph they meet; everything inside them is text for the next one. */
const PARAGRAPH_TAGS = new Set(["p", "div", "section", "article", "header", "footer", "blockquote", "pre", "table", "caption", "tr", "td", "th", "figure", "figcaption", "hr"]);

interface HtmlList {
  ordered: boolean;
  items: PdfListItem[];
  /** The item being filled, its runs so far. */
  current: PdfTextRun[] | undefined;
  /** The last item's `<li>` is still open after a list nested in it closed: text that follows is that item's. */
  resume: boolean;
}

/**
 * Authored HTML as blocks: paragraphs, headings, bulleted and numbered lists (one
 * level of nesting), with `strong`/`b` and `em`/`i` as bold and italic runs, `a` as a run in
 * the link colour, and `br` as a line break. Any other tag loses itself and keeps its text.
 * The engine sanitized the markup already.
 */
export function htmlToPdfBlocks(html: string, context: PdfRenditionContext): PdfBlock[] {
  const blocks: PdfBlock[] = [];
  const lists: HtmlList[] = [];
  let runs: PdfTextRun[] = [];
  let heading: PdfHeadingBlock["level"] | undefined;
  let bold = 0;
  let italic = 0;
  let link: string | undefined;

  const target = (): PdfTextRun[] => {
    const list = lists[lists.length - 1];
    if (list) {
      list.current ??= [];
      return list.current;
    }
    return runs;
  };
  const trimRuns = (list: PdfTextRun[]): PdfTextRun[] => {
    const out = list.map((run) => ({ ...run }));
    if (out.length > 0) {
      out[0]!.text = out[0]!.text.replace(/^\s+/, "");
      out[out.length - 1]!.text = out[out.length - 1]!.text.replace(/\s+$/, "");
    }
    return out.filter((run) => run.text !== "");
  };
  const flushParagraph = (): void => {
    const kept = trimRuns(runs);
    runs = [];
    if (kept.length === 0) {
      heading = undefined;
      return;
    }
    if (heading !== undefined) {
      blocks.push({ id: context.nextId("h"), kind: "heading", componentId: context.model.id, level: heading, runs: kept });
      heading = undefined;
    } else {
      blocks.push({ id: context.nextId("p"), kind: "paragraph", componentId: context.model.id, runs: kept, role: "P" });
    }
  };
  const endItem = (): void => {
    const list = lists[lists.length - 1];
    if (!list) {
      return;
    }
    const resume = list.resume;
    list.resume = false;
    if (list.current === undefined) {
      return;
    }
    const kept = trimRuns(list.current);
    list.current = undefined;
    const last = list.items[list.items.length - 1];
    // An item opened by text before any `<li>`, or a nested list's host: the runs join the item.
    if (last && last.runs.length === 0) {
      last.runs = kept;
    } else if (last && resume) {
      // Text after a nested list, inside the same `<li>`: a line of the item's own.
      last.runs = kept.length > 0 ? [...last.runs, { text: "\n" }, ...kept] : last.runs;
    } else if (kept.length > 0) {
      list.items.push({ runs: kept });
    }
  };
  const openItem = (): void => {
    const list = lists[lists.length - 1];
    if (!list) {
      return;
    }
    endItem();
    list.items.push({ runs: [] });
    list.current = [];
  };
  const endList = (): void => {
    // The list's own open item ends with it, before the list is closed.
    endItem();
    const list = lists.pop();
    if (!list) {
      return;
    }
    const items = list.items.filter((item) => item.runs.length > 0 || (item.blocks && item.blocks.length > 0));
    if (items.length === 0) {
      return;
    }
    const block: PdfListBlock = { id: context.nextId("list"), kind: "list", componentId: context.model.id, ordered: list.ordered, items };
    const parent = lists[lists.length - 1];
    if (parent) {
      // A list inside an item nests under it.
      const host = parent.items[parent.items.length - 1];
      if (host) {
        if (parent.current !== undefined) {
          host.runs = trimRuns(parent.current);
          parent.current = undefined;
          parent.resume = true;
        }
        host.blocks = [...(host.blocks ?? []), block];
      } else {
        parent.items.push({ runs: [], blocks: [block] });
      }
    } else {
      blocks.push(block);
    }
  };
  const pushText = (raw: string): void => {
    const text = decodeEntities(raw).replace(/\s+/g, " ");
    if (text === "") {
      return;
    }
    const list = target();
    const previous = list[list.length - 1];
    const style = { ...(bold > 0 ? { bold: true } : {}), ...(italic > 0 ? { italic: true } : {}), ...(link !== undefined ? { link } : {}) };
    if (previous && previous.bold === style.bold && previous.italic === style.italic && previous.link === style.link) {
      previous.text += text;
    } else {
      list.push({ text, ...style });
    }
  };

  const pattern = /<\/?([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    pushText(html.slice(cursor, match.index));
    cursor = match.index + match[0].length;
    const closing = match[0].startsWith("</");
    const tag = match[1]!.toLowerCase();
    const attributes = match[2] ?? "";
    const headingMatch = /^h([1-6])$/.exec(tag);
    if (headingMatch) {
      if (lists.length === 0) {
        flushParagraph();
        heading = closing ? undefined : (Number(headingMatch[1]) as PdfHeadingBlock["level"]);
      }
      continue;
    }
    switch (tag) {
      case "br": {
        // A break joins the run it interrupts, so ".\nThen" stays one run of one style.
        const list = target();
        const previous = list[list.length - 1];
        if (previous && !previous.bold && !previous.italic && previous.link === undefined) {
          previous.text += "\n";
        } else {
          list.push({ text: "\n" });
        }
        break;
      }
      case "ul":
      case "ol":
        if (closing) {
          endList();
        } else {
          if (lists.length === 0) {
            flushParagraph();
          }
          lists.push({ ordered: tag === "ol", items: [], current: undefined, resume: false });
        }
        break;
      case "li":
        if (closing) {
          endItem();
        } else {
          openItem();
        }
        break;
      case "strong":
      case "b":
        bold = Math.max(0, bold + (closing ? -1 : 1));
        break;
      case "em":
      case "i":
        italic = Math.max(0, italic + (closing ? -1 : 1));
        break;
      case "a": {
        if (closing) {
          link = undefined;
        } else {
          const href = /href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(attributes);
          link = (href?.[1] ?? href?.[2] ?? href?.[3] ?? "").trim() || undefined;
        }
        break;
      }
      default:
        if (PARAGRAPH_TAGS.has(tag) && lists.length === 0) {
          flushParagraph();
        } else if (PARAGRAPH_TAGS.has(tag)) {
          // A block tag inside a list item separates its lines.
          target().push({ text: "\n" });
        }
        break;
    }
  }
  pushText(html.slice(cursor));
  while (lists.length > 0) {
    endList();
  }
  flushParagraph();
  return blocks;
}

const htmlRendition: Renderer = (_node, context) => htmlToPdfBlocks(context.model.staticHtml ?? "", context);

/** A signature line: the label and one rule, the way a paper form asks for a signature. */
const signatureLineRendition: Renderer = (_node, context) => [labelValue(context, "ruled", 1)];

const signatureFieldRendition: Renderer = (_node, context) => [widget(context, fieldSpec(context, "signature"))];

/** A signature image when the value carries one (a host's capture component), else the line. */
const signatureImageRendition: Renderer = (node, context) => {
  const value = context.model.value;
  const data =
    typeof value === "string"
      ? DATA_URL.exec(value)
      : value && typeof value === "object" && typeof (value as { image?: unknown }).image === "string"
        ? DATA_URL.exec((value as { image: string }).image)
        : null;
  if (!data) {
    return signatureLineRendition(node, context);
  }
  const resourceId = context.addImage({
    type: data[1] as "image/png" | "image/jpeg",
    data: data[2]!.replace(/\s+/g, "")
  });
  return [
    {
      id: context.nextId("signature"),
      kind: "image",
      componentId: context.model.id,
      resourceId,
      alt: context.label ?? context.texts.signatureAlt ?? "Signature",
      role: "Figure",
      height: 48
    }
  ];
};

function headingLevel(context: PdfRenditionContext): 1 | 2 | 3 | 4 | 5 | 6 {
  return Math.min(6, Math.max(1, Math.round(context.headingLevel))) as 1 | 2 | 3 | 4 | 5 | 6;
}

/**
 * A container's heading. A labelled group that asks for the required legend mark
 * (`configuration.legendMark`) carries the theme's required word after its words, the
 * paper twin of the mark the form draws (parity); the optional mark has no paper
 * word, as a field's does not.
 */
function containerHeading(context: PdfRenditionContext): PdfBlock[] {
  if (context.label === undefined || context.label === "" || context.model.hideLabel) {
    return [];
  }
  const mark = readLegendMark(context.model.node.configuration) === "required" && context.texts.required !== "" ? ` ${context.texts.required}` : undefined;
  return [
    {
      id: context.nextId("heading"),
      kind: "heading",
      componentId: context.model.id,
      level: headingLevel(context),
      runs: [{ text: context.label }, ...(mark !== undefined ? [{ text: mark, bold: false }] : [])],
      keepWithNext: true
    }
  ];
}

/**
 * A titled box: the children inside the theme's panel border, its caption on the
 * header band — the paper twin of the panel the form draws on screen. The render model
 * numbers the caption with the other section headings.
 */
const panelRendition: Renderer = (_node, context) => {
  const blocks = context.children();
  if (!pdfBlocksPrint(blocks)) {
    return [];
  }
  const heading = containerHeading(context);
  const panel = context.theme.panel;
  const box: PdfBoxBlock = {
    id: context.nextId("panel"),
    kind: "box",
    componentId: context.model.id,
    role: "Sect",
    blocks,
    border: { width: panel.borderWidth, color: panel.borderColor ?? context.theme.colors.border },
    ...(panel.fill !== undefined ? { fill: panel.fill } : {}),
    padding: panel.padding,
    radius: panel.radius,
    ...(heading.length > 0
      ? { header: { blocks: heading, fill: panel.headerFill ?? context.theme.colors.surface, padding: panel.headerPadding } }
      : {})
  };
  return [box];
};

/** A container: its heading, then its children in slot order — nothing at all when none of them prints. */
function groupRendition(keepTogether: boolean): Renderer {
  return (_node, context) => {
    const blocks = context.children();
    if (!pdfBlocksPrint(blocks)) {
      return [];
    }
    return [
      ...containerHeading(context),
      {
        id: context.nextId("group"),
        kind: "group",
        componentId: context.model.id,
        role: "Sect",
        blocks,
        keepTogether
      }
    ];
  };
}

/** A label the author gave a component, as authored (before any translation). */
function configuredLabel(node: ComponentNode): string | undefined {
  const configuration = node.configuration;
  const raw = configuration && typeof configuration === "object" && !Array.isArray(configuration) ? (configuration as Record<string, unknown>)["label"] : undefined;
  return typeof raw === "string" && raw !== "" ? raw : undefined;
}

/** Tabs become sequential sections, one per tab, captioned with the tab's label. */
const tabsRendition: Renderer = (node, context) => {
  const blocks: PdfBlock[] = [...containerHeading(context)];
  const descriptors = readTabDescriptors(node);
  const sources = { translations: context.translations, catalog: context.translationCatalog };
  context.slotIds().forEach((slotId, index) => {
    const descriptor = descriptors.find((tab) => tab.id === slotId);
    // A tab is worded under its container, by the tab's id (the slot), never its place.
    const authored = typeof descriptor?.label === "string" && descriptor.label !== "" ? descriptor.label : undefined;
    const label = authored !== undefined ? resolveText(authored, { kind: "components", owner: node.id, path: ["tabs", slotId, "label"] }, context.locale, sources) : undefined;
    // An untitled tab is named by the label of the `tab` component that is its whole content, when
    // the author gave it one, else by its place: never its id, as on screen.
    const content = node.children?.[slotId] ?? [];
    const lone = content.length === 1 && content[0]?.type === "tab" ? content[0] : undefined;
    const loneLabel = lone ? configuredLabel(lone) : undefined;
    const own = lone && loneLabel !== undefined ? resolveText(loneLabel, addressOf.component(lone.id, "label"), context.locale, sources) : undefined;
    const caption =
      label !== undefined && label !== "" ? label : own !== undefined && own !== "" ? own : formTextOf(context)("tabFallback", { n: index + 1 });
    const children = context.children(slotId);
    blocks.push({
      id: context.nextId("tab"),
      kind: "heading",
      componentId: context.model.id,
      level: headingLevel({ ...context, headingLevel: context.headingLevel + (context.label ? 1 : 0) }),
      runs: [{ text: caption }],
      keepWithNext: true
    });
    blocks.push({
      id: context.nextId("tab-group"),
      kind: "group",
      componentId: context.model.id,
      role: "Sect",
      blocks: children,
      keepTogether: false
    });
  });
  return blocks;
};

/**
 * A grid becomes a borderless one-row table, a cell per column; a single column stacks. The
 * table is layout, not data: it is an artifact, which tags no structure of its own while the
 * fields in its cells are content under the grid's parent.
 */
const gridRendition: Renderer = (node, context) => {
  const slots = context.slotIds();
  if (slots.length <= 1) {
    return groupRendition(false)(node, context);
  }
  const widths = readGridColumnWidths(node.configuration);
  const cells: PdfTableCell[] = slots.map((slotId) => ({
    id: context.nextId(`cell-${slotId}`),
    blocks: context.children(slotId)
  }));
  return [
    ...containerHeading(context),
    {
      id: context.nextId("grid"),
      kind: "table",
      componentId: context.model.id,
      role: "Div",
      columns: slots.map((_slot, index) => ({
        width: widths ? { fraction: widths[index]! / GRID_TRACK_COUNT } : { fraction: 1 / slots.length }
      })),
      rows: [{ id: context.nextId("row"), cells, keepTogether: false }],
      repeatHeader: false,
      borders: "none",
      artifact: true
    }
  ];
};

/** A collection becomes a table: one column per item field, one row per collection row. */
const collectionTableRendition: Renderer = (_node, context) => {
  const fields = context.rowFields();
  const rows = context.rows();
  const header: PdfTableRow = {
    id: context.nextId("thead"),
    cells: fields.map((field) => ({
      id: context.nextId("th"),
      header: true,
      blocks: [{ id: context.nextId("th-p"), kind: "paragraph", runs: [{ text: field.label }] }]
    }))
  };
  const body: PdfTableRow[] = rows.map((row, index) => ({
    id: context.nextId(`row-${index}`),
    keepTogether: true,
    cells: fields.map((field) => {
      const formatted = context.format(field, row[field.rowKey ?? field.id]);
      return {
        id: context.nextId("td"),
        blocks: [
          {
            id: context.nextId("td-p"),
            kind: "paragraph",
            runs: [{ text: answerText(field, formatted, "") }]
          }
        ]
      } satisfies PdfTableCell;
    })
  }));
  return [
    ...containerHeading(context),
    {
      id: context.nextId("table"),
      kind: "table",
      componentId: context.model.id,
      role: "Table",
      columns: fields.map(() => ({})),
      header,
      rows: body,
      repeatHeader: true,
      borders: "all",
      ...(context.label ? { caption: context.label } : {})
    }
  ];
};

/** A collection as one labelled group per row, each field as label and value — for wide rows. */
const collectionSectionsRendition: Renderer = (_node, context) => {
  const fields = context.rowFields();
  const blocks: PdfBlock[] = [...containerHeading(context)];
  // A row is headed as on screen, in print and in the review: the container's `rowLabel`, else "Row n".
  const text = formTextOf(context);
  context.rows().forEach((row, index) => {
    blocks.push({
      id: context.nextId(`row-${index}`),
      kind: "group",
      componentId: context.model.id,
      role: "Sect",
      keepTogether: true,
      blocks: [
        {
          id: context.nextId("row-heading"),
          kind: "heading",
          level: headingLevel({ ...context, headingLevel: context.headingLevel + 1 }),
          runs: [{ text: rowHeadingOf(context.model.node, index + 1, context.locale, { translations: context.translations, catalog: context.translationCatalog }, text) }],
          keepWithNext: true
        },
        ...fields.map((field): PdfBlock => {
          const formatted = context.format(field, row[field.rowKey ?? field.id]);
          const arrangement = context.style.labelArrangement ?? "stacked";
          return {
            id: context.nextId("row-field"),
            kind: "labelValue",
            componentId: field.id,
            label: field.label,
            value: [{ text: answerText(field, formatted, context.texts.empty) }],
            arrangement,
            ...affixes(field),
            ...frameFor(context, arrangement, field.type)
          };
        })
      ]
    });
  });
  return blocks;
};

const NOTHING: Renderer = () => [];

function definition(
  defaultRendition: string,
  renditions: Record<string, Renderer>
): ComponentPdfDefinition {
  return {
    defaultRendition,
    renditions: Object.entries(renditions).map(([id, render]) => ({
      id,
      render: render as ComponentPdfDefinition["renditions"][number]["render"]
    }))
  };
}

const TEXT_FIELD = definition("text", {
  text: textRendition,
  field: textFieldRendition("text"),
  ruled: ruledRendition(1)
});

const TEXTAREA_FIELD = definition("text", {
  text: textRendition,
  field: textFieldRendition("multiline"),
  ruled: ruledRendition(3)
});

/** A single choice marks its options with circles, a multiple one with squares. */
const CHOICE_FIELD = (kind: "dropdown" | "radio" | "listbox") =>
  definition("text", {
    text: textRendition,
    field: choiceFieldRendition(kind),
    checklist: checklistRendition(kind === "listbox" ? "check" : "radio"),
    ruled: ruledRendition(1)
  });

const CHECKBOX_FIELD = definition("checkmark", {
  checkmark: checkmarkRendition,
  field: checkboxFieldRendition,
  text: textRendition
});

/** Containers the engine knows; anything else with children takes {@link GENERIC_CONTAINER_PDF_RENDITIONS}. */
const GROUP = definition("group", { group: groupRendition(false), section: groupRendition(true) });
/** A container that may draw as a titled box. */
const PANEL_GROUP = definition("group", { group: groupRendition(false), section: groupRendition(true), panel: panelRendition });
const SECTION = definition("section", { group: groupRendition(false), section: groupRendition(true), panel: panelRendition });

/** What a component carrying a `collection` takes, whatever its type says. */
export const COLLECTION_PDF_RENDITIONS: ComponentPdfDefinition = definition("table", {
  table: collectionTableRendition,
  sections: collectionSectionsRendition
});

export const BUILT_IN_PDF_RENDITIONS: Record<string, ComponentPdfDefinition> = {
  text: TEXT_FIELD,
  email: TEXT_FIELD,
  tel: TEXT_FIELD,
  url: TEXT_FIELD,
  number: TEXT_FIELD,
  date: TEXT_FIELD,
  time: TEXT_FIELD,
  textarea: TEXTAREA_FIELD,
  checkbox: CHECKBOX_FIELD,
  boolean: CHECKBOX_FIELD,
  checkboxes: definition("checklist", {
    checklist: checklistRendition("check"),
    field: checkboxesFieldRendition,
    text: textRendition
  }),
  select: CHOICE_FIELD("dropdown"),
  multiselect: CHOICE_FIELD("listbox"),
  radio: CHOICE_FIELD("radio"),
  [FILE_COMPONENT_TYPE]: definition("text", {
    text: textRendition,
    field: fileFieldRendition,
    image: fileImageRendition
  }),
  [IMAGE_COMPONENT_TYPE]: definition("image", { image: imageRendition }),
  [HTML_COMPONENT_TYPE]: definition("text", { text: htmlRendition }),
  signature: definition("line", {
    line: signatureLineRendition,
    field: signatureFieldRendition,
    image: signatureImageRendition
  }),
  [BUTTON_COMPONENT_TYPE]: definition("none", { none: NOTHING }),
  [BUTTON_GROUP_COMPONENT_TYPE]: definition("group", { group: groupRendition(false) }),
  // A data grid prints as a collection: its children are the row template, so the
  // header and the cells come from them, not from a rendition of the grid's own.
  [DATA_GRID_COMPONENT_TYPE]: COLLECTION_PDF_RENDITIONS,
  form: GROUP,
  container: PANEL_GROUP,
  panel: PANEL_GROUP,
  fieldset: SECTION,
  step: SECTION,
  tabs: definition("sections", { sections: tabsRendition, group: groupRendition(false) }),
  grid: definition("table", { table: gridRendition, group: groupRendition(false) })
};

/** What a type with children and no entry of its own takes. */
export const GENERIC_CONTAINER_PDF_RENDITIONS: ComponentPdfDefinition = GROUP;

/** What a leaf type with no entry of its own takes. */
export const GENERIC_LEAF_PDF_RENDITIONS: ComponentPdfDefinition = TEXT_FIELD;


