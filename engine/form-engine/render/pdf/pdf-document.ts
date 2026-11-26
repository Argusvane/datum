/**
 * The PDF document model: what the engine's render model produces and the kernel
 * lays out. Pure JSON — every value is a plain object, number, string or boolean — so it can
 * cross the ABI unchanged, be snapshot-tested, and be built and consumed on any host.
 *
 * It is a *pre-layout* model: blocks in flow order with pagination policy (breaks, keep-together,
 * repeating headers), never page numbers or coordinates. Which page a block lands on is the
 * kernel's answer, given fonts and measurements; the engine deliberately does not know.
 */
import type { TextDirection } from "../../core/accessibility/accessibility-semantics.js";
import type { PdfAClaim, PdfAssetSource, PdfBoxAnchor, ResolvedPdfPageSetup } from "../../core/schema/pdf-layout.js";
import type { PdfSignatureSettings } from "./pdf-abi.js";
import type {
  PdfBoxSettings,
  PdfChoiceSettings,
  PdfControlSettings,
  PdfFieldSettings,
  PdfHeadingSettings,
  PdfListSettings,
  PdfPanelSettings,
  PdfSpacingTable,
  PdfTableSettings,
  PdfThemeColors,
  PdfTypography
} from "./pdf-theme.js";

export const PDF_DOCUMENT_MODEL_VERSION = "1";

/** Tagged-PDF structure roles a block may carry (PDF 32000-1 §14.8.4). */
export type PdfStructureRole =
  | "Document"
  | "Sect"
  | "H1"
  | "H2"
  | "H3"
  | "H4"
  | "H5"
  | "H6"
  | "P"
  | "L"
  | "LI"
  | "LBody"
  | "Table"
  | "TR"
  | "TH"
  | "TD"
  | "Figure"
  | "Form"
  | "Div"
  | "Span";

/** A run of text drawn in one style. */
export interface PdfTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  /** Point size; absent: the block's default from the document typography. */
  size?: number;
  /** Font family; absent: the block's default. */
  family?: string;
  /** `#rrggbb`. */
  color?: string;
  /** A running-region token the kernel substitutes per page; `text` is the fallback. */
  token?: "pageNumber" | "pageCount";
  /** BCP-47 language of this run when it differs from the document's. */
  lang?: string;
  /** CSS weight (400 regular, 700 bold); wins over `bold`. */
  weight?: number;
  /** The href of a link in authored content: drawn in the theme's link colour, never annotated (a printed record). */
  link?: string;
  /** Applied by the kernel before shaping, so measurement and drawing agree. */
  transform?: "none" | "uppercase";
}

export interface PdfBlockStyle {
  /** Points of space before / after the block. */
  spacingBefore?: number;
  spacingAfter?: number;
  align?: "start" | "center" | "end";
  color?: string;
  size?: number;
  family?: string;
  /** Left indent in points. */
  indent?: number;
}

interface PdfBlockBase {
  /** Stable, unique within the document; the kernel reports pagination against it. */
  id: string;
  /** Structure role for tagging. Absent: the kernel's default for the block kind. */
  role?: PdfStructureRole;
  /** Alternative text (figures, decorative marks). */
  alt?: string;
  /** Decorative: tagged as an artifact rather than content. */
  artifact?: boolean;
  /** Keep on the same page as the block that follows. */
  keepWithNext?: boolean;
  /** The form component this block renders, for diagnostics and the designer. */
  componentId?: string;
  style?: PdfBlockStyle;
}

export interface PdfHeadingBlock extends PdfBlockBase {
  kind: "heading";
  level: 1 | 2 | 3 | 4 | 5 | 6;
  runs: PdfTextRun[];
  /** A line above the heading in the theme's step-tag type ("Step 1 of 3"), kept with it. */
  tag?: string;
  /** A section number the theme asked for ("1", "1.2"), drawn before the text. */
  number?: string;
  /** Draw the theme's band behind this heading (a section heading, never a `pdf-text` one). */
  band?: boolean;
  /** Draw the theme's rule beneath this heading (the document title). */
  rule?: boolean;
}

export interface PdfParagraphBlock extends PdfBlockBase {
  kind: "paragraph";
  runs: PdfTextRun[];
}

/**
 * A label and a value: stacked (label above), inline (label before, on one line while it
 * fits), or ruled (the label, then `lines` blank rules to write on — the "print and fill by
 * hand" rendition, where any value is drawn on the first rule).
 */
/** What kind of control a framed value stands in for: a textarea takes the theme's rows, a select its mark. */
export type PdfControlKind = "text" | "textarea" | "select" | "date" | "file" | "other";

export interface PdfLabelValueBlock extends PdfBlockBase {
  kind: "labelValue";
  label: string;
  value: PdfTextRun[];
  arrangement: "stacked" | "inline" | "ruled";
  /** Number of rules for `ruled`. */
  lines?: number;
  /** The field's hint, drawn where the theme's `fields.hintPosition` says. */
  hint?: string;
  /** The required marker ("(required)"), drawn after the label in the theme's required type. */
  labelSuffix?: string;
  /** Draw the value inside the theme's control box (the `stacked` arrangement only). */
  frame?: boolean;
  /** Which control the frame stands in for; absent: `text`. */
  control?: PdfControlKind;
  /** A prefix / suffix drawn with the value in the theme's affix type. */
  prefix?: string;
  suffix?: string;
  /** Frame width in points, left-aligned in the column; absent: the column, capped by the theme's `controls.maxWidth`. */
  width?: number;
}

export type PdfFormFieldKind =
  | "text"
  | "multiline"
  | "checkbox"
  | "radio"
  | "dropdown"
  | "listbox"
  | "signature";

export interface PdfFormFieldOption {
  value: string;
  label: string;
}

/** An AcroForm field the kernel creates. Two widgets with one `name` are one field. */
export interface PdfFormFieldSpec {
  name: string;
  kind: PdfFormFieldKind;
  /** The current value: text, a checkbox state, a selected option, or several for a listbox. */
  value?: string | boolean | string[];
  options?: PdfFormFieldOption[];
  required?: boolean;
  readOnly?: boolean;
  maxLength?: number;
  /** The export value of a checkbox; default `"Yes"`. */
  exportValue?: string;
  /** The tooltip / accessible description (`/TU`). */
  tooltip?: string;
}

export interface PdfWidgetBlock extends PdfBlockBase {
  kind: "widget";
  field: PdfFormFieldSpec;
  /** The visible label; absent: none drawn (the field still carries `tooltip`). */
  label?: string;
  labelPosition?: "above" | "before" | "after";
  /** Widget height in points; absent: the kernel's default for the kind. */
  height?: number;
  /** Widget width in points, left-aligned in the column; absent: the column's width. */
  width?: number;
  hint?: string;
  labelSuffix?: string;
  prefix?: string;
  suffix?: string;
}

/** A drawn check mark (or empty box) with its label — a checkbox's static rendition. */
export interface PdfCheckmarkBlock extends PdfBlockBase {
  kind: "checkmark";
  label: string;
  checked: boolean;
  hint?: string;
}

export interface PdfChecklistItem {
  label: string;
  checked: boolean;
  /** A second, muted line under the label — the option's hint on the form. */
  description?: string;
}

/** Every option of a choice with the picked ones marked — a select / radio / checkboxes rendition. */
export interface PdfChecklistBlock extends PdfBlockBase {
  kind: "checklist";
  label?: string;
  items: PdfChecklistItem[];
  /** The mark: a square with a tick, or a circle with a dot (a single choice). Absent: `check`. */
  marker?: "check" | "radio";
  hint?: string;
  labelSuffix?: string;
}

export interface PdfListItem {
  runs: PdfTextRun[];
  /** One nested list, drawn indented under the item. */
  blocks?: PdfListBlock[];
}

/** A bulleted or numbered list from authored content: markers at the start, text at a hanging indent. */
export interface PdfListBlock extends PdfBlockBase {
  kind: "list";
  ordered: boolean;
  items: PdfListItem[];
}

export type PdfTableColumnWidth = number | { fraction: number } | "auto";

export interface PdfTableColumn {
  /** Points, a fraction of the table width, or measured from content. Absent: equal share. */
  width?: PdfTableColumnWidth;
  align?: "start" | "center" | "end";
}

export interface PdfTableCell {
  id: string;
  blocks: PdfBlock[];
  colSpan?: number;
  /** A header cell (`TH`). */
  header?: boolean;
  align?: "start" | "center" | "end";
}

export interface PdfTableRow {
  id: string;
  cells: PdfTableCell[];
  /** Do not split this row across pages. */
  keepTogether?: boolean;
}

export interface PdfTableBlock extends PdfBlockBase {
  kind: "table";
  columns: PdfTableColumn[];
  /** Drawn first, and again at the top of every page the table continues on. */
  header?: PdfTableRow;
  rows: PdfTableRow[];
  repeatHeader: boolean;
  borders: "all" | "horizontal" | "none";
  caption?: string;
}

/** Image bytes the kernel embeds, or a URL the host resolves into bytes before the request. */
export type PdfImageResource =
  | { type: "image/png" | "image/jpeg"; data: string }
  | { url: string };

export interface PdfImageBlock extends PdfBlockBase {
  kind: "image";
  /** Key into `PdfDocument.resources.images`. */
  resourceId: string;
  alt: string;
  /** Points; absent: the image's own size, scaled down to fit the column. */
  width?: number;
  height?: number;
}

export interface PdfRuleBlock extends PdfBlockBase {
  kind: "rule";
  thickness?: number;
  color?: string;
}

export interface PdfSpacerBlock extends PdfBlockBase {
  kind: "spacer";
  height: number;
}

/** A panel's title band: blocks drawn on a fill above the body, inside the border. */
export interface PdfBoxHeader {
  blocks: PdfBlock[];
  fill?: string;
  padding?: number;
}

export interface PdfBoxBlock extends PdfBlockBase {
  kind: "box";
  blocks: PdfBlock[];
  border?: { width: number; color: string };
  fill?: string;
  padding?: number;
  /** Corner radius in points. */
  radius?: number;
  header?: PdfBoxHeader;
}

export interface PdfGroupBlock extends PdfBlockBase {
  kind: "group";
  blocks: PdfBlock[];
  keepTogether: boolean;
}

export interface PdfPageBreakBlock extends PdfBlockBase {
  kind: "pageBreak";
  /** Page setup for the pages that follow, when it changes. */
  page?: ResolvedPdfPageSetup;
}

export type PdfBlock =
  | PdfHeadingBlock
  | PdfParagraphBlock
  | PdfLabelValueBlock
  | PdfWidgetBlock
  | PdfCheckmarkBlock
  | PdfChecklistBlock
  | PdfListBlock
  | PdfTableBlock
  | PdfImageBlock
  | PdfRuleBlock
  | PdfSpacerBlock
  | PdfBoxBlock
  | PdfGroupBlock
  | PdfPageBreakBlock;

/** Every block kind, for validating what a theme keys by kind (its spacing table). */
export const PDF_BLOCK_KINDS: readonly PdfBlock["kind"][] = [
  "heading",
  "paragraph",
  "labelValue",
  "widget",
  "checkmark",
  "checklist",
  "list",
  "table",
  "image",
  "rule",
  "spacer",
  "box",
  "group",
  "pageBreak"
];

/** A box pinned at page coordinates, outside the flow. */
export interface PdfAnchoredBox {
  id: string;
  anchor: PdfBoxAnchor;
  box: PdfBoxBlock;
}

export interface PdfDocumentMetadata {
  title: string;
  /** BCP-47. */
  lang: string;
  textDirection: TextDirection;
  subject?: string;
  author?: string;
  keywords?: string[];
}

export interface PdfDocumentAccessibility {
  tagged: boolean;
  displayDocTitle: boolean;
}

/** How an embedded file relates to the document (PDF 2.0 `/AFRelationship`). */
export type PdfAttachmentRelationship = "Data" | "Source" | "Alternative" | "Supplement" | "Unspecified";

/** A file the kernel embeds as an associated file (PDF/A-3, or any ordinary PDF). */
export interface PdfAttachment {
  name: string;
  mimeType: string;
  description?: string;
  relationship: PdfAttachmentRelationship;
  /** The file's bytes, base64. */
  data: string;
}

/**
 * An uploaded file a host storage keeps: the envelope, no bytes. The host swaps it
 * for a {@link PdfAttachment} before the request (`resolvePdfAttachments`); the program cannot
 * fetch, so one reaching the kernel is left out with an `attachment.unresolved` warning.
 */
export interface PdfPendingAttachment extends Omit<PdfAttachment, "data"> {
  source: PdfAssetSource;
  componentId: string;
}

/** An uploaded file on its way into a document: resolved to bytes, or still to be. */
export type PdfDocumentAttachment = (PdfAttachment & { componentId?: string }) | PdfPendingAttachment;

export function isResolvedPdfAttachment(attachment: PdfDocumentAttachment): attachment is PdfAttachment & { componentId?: string } {
  return "data" in attachment && typeof attachment.data === "string";
}

/**
 * The output condition the document declares. `profile` is the ICC profile's bytes once the
 * host resolved the envelope, or the envelope itself until it does; the program cannot fetch,
 * so an unresolved profile reaching the kernel yields the sRGB default with a warning.
 */
export interface PdfOutputIntent {
  profile: { data: string } | { source: PdfAssetSource };
  identifier: string;
  info: string;
  registry?: string;
}

/** The archival profile the kernel produces, or keeps for a template. */
export interface PdfDocumentConformance {
  pdfa: PdfAClaim;
  outputIntent?: PdfOutputIntent;
  attachments?: PdfAttachment[];
}

export interface PdfDocumentResources {
  images: Record<string, PdfImageResource>;
}

/** What one document may cost to render: both overridable per layout as `limits: { pages, answerChars }`. */
export interface PdfRenderLimits {
  /** Pages a document may run to; past it the render is refused with `render_limit` (`render.pageCap`). */
  pages: number;
  /** Characters of one answer drawn; past it the answer is cut with a marker and `render.truncated` warns. */
  answerChars: number;
}

export const DEFAULT_PDF_RENDER_LIMITS: PdfRenderLimits = { pages: 200, answerChars: 20000 };

/** The most a layout's `limits` may ask for: past it the ceiling applies and the render warns `render.limitsCapped`. */
export const PDF_RENDER_LIMIT_CEILING: PdfRenderLimits = { pages: 1000, answerChars: 200000 };

function validLimit(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** The limits in force: each of the layout's whole numbers of 1 or more, at most {@link PDF_RENDER_LIMIT_CEILING}, else the default. */
export function resolvePdfRenderLimits(setting: unknown): PdfRenderLimits {
  const record = typeof setting === "object" && setting !== null ? (setting as Record<string, unknown>) : {};
  const pick = (value: unknown, fallback: number, ceiling: number): number => Math.min(validLimit(value) ?? fallback, ceiling);
  return {
    pages: pick(record.pages, DEFAULT_PDF_RENDER_LIMITS.pages, PDF_RENDER_LIMIT_CEILING.pages),
    answerChars: pick(record.answerChars, DEFAULT_PDF_RENDER_LIMITS.answerChars, PDF_RENDER_LIMIT_CEILING.answerChars)
  };
}

/** The `limits` keys a layout asked for past the ceiling. */
export function pdfRenderLimitsOverCeiling(setting: unknown): Array<keyof PdfRenderLimits> {
  const record = typeof setting === "object" && setting !== null ? (setting as Record<string, unknown>) : {};
  return (["pages", "answerChars"] as const).filter((key) => (validLimit(record[key]) ?? 0) > PDF_RENDER_LIMIT_CEILING[key]);
}

export interface PdfDocument {
  version: typeof PDF_DOCUMENT_MODEL_VERSION;
  page: ResolvedPdfPageSetup;
  metadata: PdfDocumentMetadata;
  accessibility: PdfDocumentAccessibility;
  /** Present when the document is to be PDF/A. */
  conformance?: PdfDocumentConformance;
  typography: PdfTypography;
  /** The theme's palette: text, muted text, borders, accent, surface fills. */
  colors: PdfThemeColors;
  /**
   * The theme's geometry: the control box, the choice marks, the field rhythm, the
   * headings, tables, boxes, panels, lists and the spacing table. Each is optional — a
   * document from an older engine carries none, and the kernel then draws as it always did.
   */
  controls?: PdfControlSettings;
  choice?: PdfChoiceSettings;
  fields?: PdfFieldSettings;
  headings?: PdfHeadingSettings;
  table?: PdfTableSettings;
  box?: PdfBoxSettings;
  panel?: PdfPanelSettings;
  list?: PdfListSettings;
  spacing?: PdfSpacingTable;
  /** Running regions, drawn on every page inside the header / footer bands. */
  header?: PdfBlock[];
  footer?: PdfBlock[];
  blocks: PdfBlock[];
  anchored: PdfAnchoredBox[];
  resources: PdfDocumentResources;
  /**
   * Uploaded files to embed as associated files, in any PDF. The kernel gates them
   * by PDF/A part: part 1 and 2 forbid them, so those documents warn `pdfa.attachments` and
   * carry none.
   */
  attachments?: PdfDocumentAttachment[];
  /** The layout's render caps (the `render-caps` feature): `pages` the kernel enforces, `answerChars` the model applied. */
  limits?: Partial<PdfRenderLimits>;
  /** How the host is to seal the document: the layout's settings, resolved; the request adds the certificates. */
  signature?: PdfSignatureSettings;
}

/** Something the render model or the kernel could not do as asked, in terms a host can act on. */
export interface PdfWarning {
  code: string;
  message: string;
  componentId?: string;
  blockId?: string;
}

const CONTAINER_KINDS: ReadonlySet<PdfBlock["kind"]> = new Set(["group", "box", "table"]);

/**
 * Whether anything in `blocks` prints: a leaf that is not an artifact, at any depth. Containers
 * are looked through — the grid rendition marks its whole table an artifact while its cells
 * hold fields — and a page break alone is no content: a container that skips when empty, or
 * a container component whose fields are all hidden, leaves no blank page or orphan heading
 * behind.
 */
export function pdfBlocksPrint(blocks: readonly PdfBlock[]): boolean {
  let found = false;
  walkPdfBlocks(blocks, (block) => {
    if (!CONTAINER_KINDS.has(block.kind) && block.kind !== "pageBreak" && block.artifact !== true) {
      found = true;
    }
  });
  return found;
}

/** Every block in a document, depth first, including cells, boxes and groups. */
export function walkPdfBlocks(blocks: readonly PdfBlock[], visit: (block: PdfBlock) => void): void {
  for (const block of blocks) {
    visit(block);
    if (block.kind === "group" || block.kind === "box") {
      if (block.kind === "box" && block.header) {
        walkPdfBlocks(block.header.blocks, visit);
      }
      walkPdfBlocks(block.blocks, visit);
    } else if (block.kind === "list") {
      for (const item of block.items) {
        if (item.blocks) {
          walkPdfBlocks(item.blocks, visit);
        }
      }
    } else if (block.kind === "table") {
      const rows = block.header ? [block.header, ...block.rows] : block.rows;
      for (const row of rows) {
        for (const cell of row.cells) {
          walkPdfBlocks(cell.blocks, visit);
        }
      }
    }
  }
}

/** The plain text of a run list, tokens included as their fallback text. */
export function runsText(runs: readonly PdfTextRun[]): string {
  return runs.map((run) => run.text).join("");
}
