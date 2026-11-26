/**
 * PDF layouts, authored on the form definition as `pdf.layouts[]`.
 *
 * A PDF is a different document from the form: a wizard becomes sections,
 * a tabbed form becomes one flow, several answers may land in one text block, and a form may
 * need more than one PDF — the applicant's copy, an internal summary, a government template
 * filled from the same answers. So a layout is its own tree beside the form's, named, and a
 * form may carry several. With none, the pipeline derives one from the form tree.
 *
 * Two kinds:
 * - `generated`: a flow tree of PDF components (`pdf-document` root with `body` / `header` /
 *   `footer` slots) the kernel paginates. Pages are an *output* of measurement — content flows,
 *   explicit breaks and keep-together control it, and an anchored `pdf-box` pins to a page.
 * - `template`: an existing AcroForm PDF plus a field mapping; the kernel fills it.
 *
 * This module is the schema and its tolerant readers only (it lives in `core/`, which imports
 * nothing above it); the render model, renditions and provider seam are in `render/pdf/`.
 *
 * The file is split: the layout reader and its validator are in pdf-layout-read.ts and the
 * visual table's grid in pdf-layout-table.ts (the slices a form bundle carries); what stays here
 * is resolved only when a PDF is made. Both are re-exported below, so imports do not change.
 */
import type { ComponentNode } from "./types.js";
import {
  PDF_DOCUMENT_COMPONENT_TYPE,
  type PdfNamedPageSize,
  type PdfCustomPageSize,
  type PdfPageSize,
  type PdfPageSetup,
  type PdfAccessibilityConfiguration,
  type PdfAConformance,
  type PdfAClaim,
  type PdfOutputIntentConfiguration,
  PDF_BUILTIN_ASSET_STORAGE,
  type PdfBuiltinProfileId,
  PDF_BUILTIN_PROFILES,
  type PdfAttachmentOverflowPolicy,
  type PdfSignatureAppearanceConfiguration,
  type PdfSignatureConfiguration,
  PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES,
  type PdfGeneratedLayout,
  type PdfAssetSource,
  type PdfTemplateAreaDraw,
  type PdfTemplateArea,
  type PdfTemplateLayout,
  type PdfLayoutDocument,
  pdfAClaimOf,
  attachmentNameOf,
  isAssetSource,
  overflowPolicyOf,
  signatureCommitmentOf,
  signatureSubFilterOf,
  signatureCertifyOf,
  isRect
} from "./pdf-layout-read.js";
import { PDF_TABLE_COMPONENT_TYPE, readPdfTableSpec, pdfTableSlotId, pdfTableSlotIds } from "./pdf-layout-table.js";

// The layout reader and the table grid live in their own modules so a bundle that only
// lists a form's layouts does not carry the resolvers below; everything stays importable from here.
// (The read module's few helpers the resolvers share are left out of the list: not package surface.)
export {
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_A_CLAIMS,
  readIccColorSpace,
  PDF_BUILTIN_ASSET_STORAGE,
  PDF_BUILTIN_PROFILES,
  builtinProfileOf,
  isIccProfileSource,
  PDF_SIGNATURE_COMMITMENT_TYPE_SETTINGS,
  PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES,
  validatePdfLayout,
  readPdfConfiguration,
  readDefaultPdfLayoutId,
  pdfFormulaSignatures,
  pdfRuleExpression,
  readPdfLayoutCondition,
  selectPdfLayout,
  pdfLayoutCandidates,
  findPdfLayout
} from "./pdf-layout-read.js";
export type {
  PdfNamedPageSize,
  PdfCustomPageSize,
  PdfPageSize,
  PdfPageOrientation,
  PdfPageMargins,
  PdfPageSetup,
  PdfAccessibilityConfiguration,
  PdfAConformance,
  PdfAClaim,
  PdfOutputIntentConfiguration,
  PdfAttachmentConfiguration,
  PdfConformanceConfiguration,
  PdfBuiltinProfileId,
  PdfBuiltinProfile,
  PdfAttachmentOverflowPolicy,
  PdfAttachmentsConfiguration,
  PdfSignatureSubFilterSetting,
  PdfSignatureCertifySetting,
  PdfSignatureAppearanceConfiguration,
  PdfSignatureConfiguration,
  PdfSignatureCommitmentTypeSetting,
  PdfSignatureCommitmentConfiguration,
  PdfGeneratedLayout,
  PdfTemplateSource,
  PdfAssetSource,
  PdfFieldMappingSource,
  PdfValueFormat,
  PdfMappingBinding,
  PdfFieldMapping,
  PdfTemplateAreaKind,
  PdfTemplateAreaDraw,
  PdfTemplateAreaField,
  PdfTemplateArea,
  PdfTemplateFillOptions,
  PdfTemplateLayout,
  PdfLayoutDocument,
  PdfLayoutChoice,
  PdfConditionEvaluate,
  PdfLayoutCondition,
  PdfLayoutSelectionRequest,
  PdfLayoutConditionFailure,
  PdfLayoutSelection
} from "./pdf-layout-read.js";
export * from "./pdf-layout-table.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * A binding's `values` as the fill reads it: the entries whose key and value are both
 * strings, in order. A hand-edited layout may hold anything there, and one bad entry must not
 * stop the others, so a malformed map yields what is usable; `undefined` when nothing is.
 */
export function readPdfValueMap(value: unknown): Map<string, string> | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const map = new Map<string, string>();
  for (const key of Object.keys(value)) {
    const target = value[key];
    if (typeof target === "string") {
      map.set(key, target);
    }
  }
  return map.size > 0 ? map : undefined;
}


export const PDF_LAYOUT_SCHEMA_VERSION = "1";
/** A heading with a group of content under it. */
export const PDF_SECTION_COMPONENT_TYPE = "pdf-section";
/** A form component bound into the layout. */
export const PDF_FIELD_COMPONENT_TYPE = "pdf-field";
/** Static text, with `{{path}}` templates or an expression. */
export const PDF_TEXT_COMPONENT_TYPE = "pdf-text";
/** A region repeated once per row of a collection. */
export const PDF_REPEAT_COMPONENT_TYPE = "pdf-repeat";
/** A bordered / filled container, in flow or anchored to a page. */
export const PDF_BOX_COMPONENT_TYPE = "pdf-box";
export const PDF_RULE_COMPONENT_TYPE = "pdf-rule";
export const PDF_SPACER_COMPONENT_TYPE = "pdf-spacer";
export const PDF_IMAGE_COMPONENT_TYPE = "pdf-image";
export const PDF_PAGE_BREAK_COMPONENT_TYPE = "pdf-page-break";
/** A signature block the layout places on its own: a named signature field, or a line to sign on. */
export const PDF_SIGNATURE_COMPONENT_TYPE = "pdf-signature";

/** Every layout-tree type, root included. */
export const PDF_COMPONENT_TYPES: readonly string[] = [
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_SECTION_COMPONENT_TYPE,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_TEXT_COMPONENT_TYPE,
  PDF_TABLE_COMPONENT_TYPE,
  PDF_REPEAT_COMPONENT_TYPE,
  PDF_BOX_COMPONENT_TYPE,
  PDF_RULE_COMPONENT_TYPE,
  PDF_SPACER_COMPONENT_TYPE,
  PDF_IMAGE_COMPONENT_TYPE,
  PDF_PAGE_BREAK_COMPONENT_TYPE,
  PDF_SIGNATURE_COMPONENT_TYPE
];

/** The `pdf-document` root's slots: the flow, and the running regions drawn on every page. */
export const PDF_DOCUMENT_BODY_SLOT = "body";
export const PDF_DOCUMENT_HEADER_SLOT = "header";
export const PDF_DOCUMENT_FOOTER_SLOT = "footer";

export function isPdfComponentType(type: string): boolean {
  return PDF_COMPONENT_TYPES.includes(type);
}

/** {@link PdfPageSetup} with every choice made; header/footer stay optional (none is a choice). */
export type ResolvedPdfPageSetup = Required<Pick<PdfPageSetup, "size" | "orientation" | "margins">> &
  Pick<PdfPageSetup, "header" | "footer">;

/** Named sizes in points, portrait. */
export const PDF_PAGE_SIZES: Record<PdfNamedPageSize, PdfCustomPageSize> = {
  A4: { width: 595.28, height: 841.89 },
  Letter: { width: 612, height: 792 },
  Legal: { width: 612, height: 1008 }
};

/** Three quarters of an inch all round: what most office documents print with. */
export const DEFAULT_PDF_MARGIN = 54;

export const DEFAULT_PDF_PAGE_SETUP: ResolvedPdfPageSetup = {
  size: "Letter",
  orientation: "portrait",
  margins: {
    top: DEFAULT_PDF_MARGIN,
    right: DEFAULT_PDF_MARGIN,
    bottom: DEFAULT_PDF_MARGIN,
    left: DEFAULT_PDF_MARGIN
  }
};

/** Smallest page dimension worth laying out on, in points (about half an inch). */
const MIN_PAGE_DIMENSION = 36;

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonNegative(value: unknown, fallback: number): number {
  const number = readFiniteNumber(value);
  return number !== undefined && number >= 0 ? number : fallback;
}

function readPageSize(value: unknown): PdfPageSize {
  if (typeof value === "string" && Object.prototype.hasOwnProperty.call(PDF_PAGE_SIZES, value)) {
    return value as PdfNamedPageSize;
  }
  if (isRecord(value)) {
    const width = readFiniteNumber(value.width);
    const height = readFiniteNumber(value.height);
    if (
      width !== undefined &&
      height !== undefined &&
      width >= MIN_PAGE_DIMENSION &&
      height >= MIN_PAGE_DIMENSION
    ) {
      return { width, height };
    }
  }
  return DEFAULT_PDF_PAGE_SETUP.size;
}

function readBand(value: unknown): { height: number } | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const height = readFiniteNumber(value.height);
  return height !== undefined && height > 0 ? { height } : undefined;
}

/**
 * A page setup with defaults filled in. Never throws: an unknown size name, a negative margin
 * or a band with no usable height each take the default, so a hand-edited layout still lays out.
 */
export function resolvePdfPageSetup(page: unknown): ResolvedPdfPageSetup {
  if (!isRecord(page)) {
    return { ...DEFAULT_PDF_PAGE_SETUP, margins: { ...DEFAULT_PDF_PAGE_SETUP.margins } };
  }
  const defaults = DEFAULT_PDF_PAGE_SETUP.margins;
  const margins = isRecord(page.margins) ? page.margins : {};
  const header = readBand(page.header);
  const footer = readBand(page.footer);
  return {
    size: readPageSize(page.size),
    orientation: page.orientation === "landscape" ? "landscape" : "portrait",
    margins: {
      top: readNonNegative(margins.top, defaults.top),
      right: readNonNegative(margins.right, defaults.right),
      bottom: readNonNegative(margins.bottom, defaults.bottom),
      left: readNonNegative(margins.left, defaults.left)
    },
    ...(header ? { header } : {}),
    ...(footer ? { footer } : {})
  };
}

/** The page's outer dimensions in points, orientation applied. */
export function pdfPageDimensions(setup: ResolvedPdfPageSetup): PdfCustomPageSize {
  const base = typeof setup.size === "string" ? PDF_PAGE_SIZES[setup.size] : setup.size;
  return setup.orientation === "landscape"
    ? { width: base.height, height: base.width }
    : { width: base.width, height: base.height };
}

export type ResolvedPdfAccessibility = Required<Omit<PdfAccessibilityConfiguration, "lang" | "title">> & {
  lang?: string;
  /** In the form's default language; its translations are in the definition's map. */
  title?: string;
};

export const DEFAULT_PDF_ACCESSIBILITY: ResolvedPdfAccessibility = {
  tagged: true,
  displayDocTitle: true
};

/** Accessibility choices with defaults filled in; the tagged default is "on". */
export function resolvePdfAccessibility(value: unknown): ResolvedPdfAccessibility {
  if (!isRecord(value)) {
    return { ...DEFAULT_PDF_ACCESSIBILITY };
  }
  const lang = typeof value.lang === "string" && value.lang.trim() !== "" ? value.lang : undefined;
  const title = typeof value.title === "string" ? value.title : undefined;
  return {
    tagged: typeof value.tagged === "boolean" ? value.tagged : DEFAULT_PDF_ACCESSIBILITY.tagged,
    displayDocTitle:
      typeof value.displayDocTitle === "boolean"
        ? value.displayDocTitle
        : DEFAULT_PDF_ACCESSIBILITY.displayDocTitle,
    ...(lang ? { lang } : {}),
    ...(title !== undefined ? { title } : {})
  };
}

/** ISO 19005 part of a level: `"2u"` → 2. */
export function pdfAPart(level: PdfAConformance): 1 | 2 | 3 {
  return Number(level[0]) as 1 | 2 | 3;
}

/** Conformance letter of a level: `"2u"` → `"u"`. "a" implies "u" (every glyph mapped) plus complete tagging. */
export function pdfALevel(level: PdfAConformance): "a" | "b" | "u" {
  return level[1] as "a" | "b" | "u";
}

/** The same part with another letter: `("3a", "u")` → `"3u"`. */
export function pdfAWithLevel(level: PdfAConformance, letter: "a" | "b" | "u"): PdfAConformance {
  return `${level[0]}${letter}` as PdfAConformance;
}

export interface ResolvedPdfConformance {
  pdfa: PdfAClaim;
  outputIntent?: PdfOutputIntentConfiguration;
  attachData: boolean;
  attachment: { name: string; description?: string };
}

export const DEFAULT_PDF_ATTACHMENT_NAME = "submission.json";

/** The envelope a layout or theme carries for a built-in profile. */
export function builtinProfileSource(id: PdfBuiltinProfileId): PdfAssetSource {
  const profile = PDF_BUILTIN_PROFILES.find((entry) => entry.id === id)!;
  return { storage: PDF_BUILTIN_ASSET_STORAGE, ref: id, name: profile.file, type: "application/vnd.iccprofile", size: profile.size };
}

/** The output condition as configured, or nothing when it names no usable profile. */
export function resolvePdfOutputIntentConfiguration(value: unknown): PdfOutputIntentConfiguration | undefined {
  if (!isRecord(value) || !isAssetSource(value.profile)) {
    return undefined;
  }
  const text = (entry: unknown): string | undefined => (typeof entry === "string" && entry.trim() !== "" ? entry.trim() : undefined);
  const identifier = text(value.identifier);
  const info = text(value.info);
  const registry = text(value.registry);
  return {
    profile: value.profile,
    ...(identifier ? { identifier } : {}),
    ...(info ? { info } : {}),
    ...(registry ? { registry } : {})
  };
}

/**
 * The conformance a layout asks for, defaults filled in; `undefined` when it asks for none.
 * Tolerant like {@link resolvePdfAccessibility}: a level in any case, an attachment name that
 * is not a bare file name replaced by the default, `attachData` honoured only under part 3.
 */
export function resolvePdfConformance(value: unknown): ResolvedPdfConformance | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const pdfa = pdfAClaimOf(value.pdfa);
  if (!pdfa) {
    return undefined;
  }
  const outputIntent = resolvePdfOutputIntentConfiguration(value.outputIntent);
  const attachment = isRecord(value.attachment) ? value.attachment : {};
  const description = typeof attachment.description === "string" ? attachment.description : undefined;
  return {
    pdfa,
    ...(outputIntent ? { outputIntent } : {}),
    attachData: value.attachData === true && pdfAPart(pdfa) === 3,
    attachment: {
      name: attachmentNameOf(attachment.name) ?? DEFAULT_PDF_ATTACHMENT_NAME,
      ...(description !== undefined ? { description } : {})
    }
  };
}

/** The same, as a host passes it per call, in bytes (the unit `FileUploadConfiguration.maxFileSize` uses). */
export interface PdfAttachmentPolicyOptions {
  budgetBytes?: number;
  onExceeded?: PdfAttachmentOverflowPolicy;
}

export interface PdfAttachmentPolicy {
  budgetBytes: number;
  onExceeded: PdfAttachmentOverflowPolicy;
}

/**
 * Four mebibytes of decoded bytes per document. A sandboxed program pays for every byte in
 * interpreted code — the request, the decode, the stream, the base64 reply — and at this size
 * a QuickJS host renders in a few seconds of its fifteen and frees its runtime cleanly; the
 * reply of a document past about six mebibytes trips quickjs-ng's runtime assertion on
 * dispose (measured, `quickjs-limits.test.ts`). An in-process host has no such ceiling and
 * may raise the budget per layout or per call.
 */
export const DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES = 4 * 1024 * 1024;

export const DEFAULT_PDF_ATTACHMENT_POLICY: PdfAttachmentPolicy = {
  budgetBytes: DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES,
  onExceeded: "skip"
};

/**
 * The attachment policy in force: the call's option, else the layout's setting, else the
 * default — each field on its own. Tolerant like {@link resolvePdfAccessibility}: a budget
 * that is not a positive finite number, or a policy that is neither word, falls through.
 */
export function resolvePdfAttachmentPolicy(layoutSetting: unknown, call?: PdfAttachmentPolicyOptions): PdfAttachmentPolicy {
  const layout = isRecord(layoutSetting) ? layoutSetting : {};
  const positive = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
  const budgetBytes = positive(call?.budgetBytes)
    ? call!.budgetBytes!
    : positive(layout.budgetMb)
      ? Math.round(layout.budgetMb * 1024 * 1024)
      : DEFAULT_PDF_ATTACHMENT_POLICY.budgetBytes;
  const onExceeded = overflowPolicyOf(call?.onExceeded) ?? overflowPolicyOf(layout.onExceeded) ?? DEFAULT_PDF_ATTACHMENT_POLICY.onExceeded;
  return { budgetBytes, onExceeded };
}


/** An area's field choices with the defaults applied: the name it is created under, and the rest. */
export interface ResolvedPdfAreaField {
  name: string;
  required: boolean;
  readOnly: boolean;
  tooltip?: string;
}

/**
 * An AcroForm field name made from an area's own name: a period would make it a path of
 * fields (`Sig. date` → `Sig` › ` date`) or an unusable one (`Policy No.`), so each run of them
 * becomes a space, and runs of whitespace one space. Empty after that: `undefined`.
 */
export function pdfFieldNameFromLabel(label: string): string | undefined {
  const name = label.replace(/\.+/g, " ").replace(/\s+/g, " ").trim();
  return name === "" ? undefined : name;
}

/** The words of a field name problem: the one key, with the name it is about. The builder passes its own catalog's. */
export type PdfFieldNameText = (key: "pdf.fieldName.period", params: { name: string }) => string;

const ENGLISH_FIELD_NAME_TEXT: PdfFieldNameText = (_key, params) =>
  `"${params.name}" cannot name a PDF field: a period separates the parts of a field's path, and no part may be empty.`;

/**
 * Why a typed AcroForm field name cannot be made, or `undefined` when it can: a name is a path
 * of parts split at periods, and no part may be empty (`Policy No.`, `.name`, `a..b`). Worded
 * by `text` (English when absent).
 */
export function pdfFieldNameProblem(name: string, text: PdfFieldNameText = ENGLISH_FIELD_NAME_TEXT): string | undefined {
  const trimmed = name.trim();
  if (trimmed === "") {
    return undefined;
  }
  return trimmed.split(".").some((part) => part === "") ? text("pdf.fieldName.period", { name: trimmed }) : undefined;
}

/** The name an area's field takes before it is made unique: the typed one, else its label made usable, else its id. */
function areaFieldBaseName(area: Pick<PdfTemplateArea, "id" | "label" | "field">): { name: string; typed: boolean } {
  const field = area.field;
  const typed = field && typeof field.name === "string" ? field.name.trim() : "";
  if (typed !== "") {
    return { name: typed, typed: true };
  }
  return { name: (area.label !== undefined ? pdfFieldNameFromLabel(area.label) : undefined) ?? area.id, typed: false };
}

/**
 * The area's `field`, resolved — `undefined` when the area is page content. On its own: a name
 * not typed is the label made usable, not yet made unique among other areas; a layout's areas
 * resolve together through {@link resolvePdfAreaFields}.
 */
export function resolvePdfAreaField(area: Pick<PdfTemplateArea, "id" | "label" | "field">, name?: string): ResolvedPdfAreaField | undefined {
  const field = area.field;
  if (!field || typeof field !== "object") {
    return undefined;
  }
  const tooltip = typeof field.tooltip === "string" && field.tooltip !== "" ? field.tooltip : area.label;
  return {
    name: name ?? areaFieldBaseName(area).name,
    required: field.required === true,
    readOnly: field.readOnly === true,
    ...(tooltip !== undefined ? { tooltip } : {})
  };
}

/**
 * Every area's `field` resolved, in order (`undefined` for page content): a typed name as it
 * is — two areas typing one name share one field — and a name taken from a label or an id
 * made unique (`Date`, `Date_2`) against every other area's, so labels alone never merge two fields.
 */
export function resolvePdfAreaFields(areas: ReadonlyArray<Pick<PdfTemplateArea, "id" | "label" | "field">>): Array<ResolvedPdfAreaField | undefined> {
  const bases = areas.map((area) => (area.field && typeof area.field === "object" ? areaFieldBaseName(area) : undefined));
  const taken = new Set(bases.filter((base) => base?.typed).map((base) => base!.name));
  return areas.map((area, index) => {
    const base = bases[index];
    if (!base) {
      return undefined;
    }
    if (base.typed) {
      return resolvePdfAreaField(area, base.name);
    }
    let name = base.name;
    for (let counter = 2; taken.has(name); counter += 1) {
      name = `${base.name}_${counter}`;
    }
    taken.add(name);
    return resolvePdfAreaField(area, name);
  });
}

/** An area's drawing choices with every default applied. */
export type ResolvedPdfAreaDraw = Required<Omit<PdfTemplateAreaDraw, "color">> & { color?: string };

export const DEFAULT_PDF_AREA_DRAW: ResolvedPdfAreaDraw = {
  kind: "text",
  fontSize: 10,
  align: "start",
  valign: "top",
  padding: 2,
  wrap: true,
  bold: false
};

function finiteAtLeast(value: unknown, floor: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= floor ? value : fallback;
}

/** The area's `draw` with the defaults filled in and anything unusable put back to its default. */
export function resolvePdfAreaDraw(draw: PdfTemplateAreaDraw | undefined): ResolvedPdfAreaDraw {
  const defaults = DEFAULT_PDF_AREA_DRAW;
  if (!draw) {
    return { ...defaults };
  }
  return {
    kind: draw.kind === "check" ? "check" : "text",
    fontSize: finiteAtLeast(draw.fontSize, 1, defaults.fontSize),
    align: draw.align === "center" || draw.align === "end" ? draw.align : "start",
    valign: draw.valign === "middle" || draw.valign === "bottom" ? draw.valign : "top",
    padding: finiteAtLeast(draw.padding, 0, defaults.padding),
    wrap: draw.wrap !== false,
    bold: draw.bold === true,
    ...(typeof draw.color === "string" && draw.color !== "" ? { color: draw.color } : {})
  };
}

export interface PdfConfiguration {
  /** In the order their conditions are tried. */
  layouts?: PdfLayoutDocument[];
  /**
   * What a "Download PDF" with no further choice produces when no layout's `when` holds —
   * with no conditions, simply what it produces. Absent: the first layout. A form with
   * conditional layouts declares it (the builder writes it as soon as one has a `when`), so
   * the programs that predate conditions print what the newer ones fall back to.
   */
  defaultLayoutId?: string;
}

export function isPdfGeneratedLayout(layout: PdfLayoutDocument): layout is PdfGeneratedLayout {
  return layout.kind === "generated";
}

export function isPdfTemplateLayout(layout: PdfLayoutDocument): layout is PdfTemplateLayout {
  return layout.kind === "template";
}

/** The cell slots of one 1-based row, left to right. */
export function pdfTableRowSlotIds(configuration: unknown, row: number): string[] {
  const spec = readPdfTableSpec(configuration);
  const out: string[] = [];
  for (let column = 1; column <= spec.columns; column += 1) {
    out.push(pdfTableSlotId(row, column));
  }
  return out;
}

/** An empty children map with one key per cell, for a freshly created table. */
export function emptyPdfTableChildren(configuration: unknown): Record<string, ComponentNode[]> {
  return Object.fromEntries(pdfTableSlotIds(configuration).map((slotId) => [slotId, []]));
}

/**
 * Re-files children left in cells the table no longer declares (a column or row removed)
 * into the last declared cell, so shrinking a table never loses what was in it. `undefined`
 * when there is nothing to move.
 */
export function foldPdfTableChildren(
  children: Record<string, ComponentNode[]> | undefined,
  cellIds: readonly string[]
): Record<string, ComponentNode[]> | undefined {
  const lastCell = cellIds[cellIds.length - 1];
  if (!children || lastCell === undefined) {
    return undefined;
  }
  const declared = new Set(cellIds);
  const stray = Object.keys(children).filter((slotId) => !declared.has(slotId));
  if (stray.length === 0) {
    return undefined;
  }
  const next: Record<string, ComponentNode[]> = {};
  for (const slotId of cellIds) {
    next[slotId] = [...(children[slotId] ?? [])];
  }
  for (const slotId of stray) {
    next[lastCell]!.push(...(children[slotId] ?? []));
  }
  return next;
}

// --- Anchored boxes ----------------------------------------------------------------------

export interface PdfBoxAnchor {
  /** Which page: a 1-based number, or every page, the first or the last. */
  page: number | "first" | "last" | "every";
  /** Points from the page's left and top edges. */
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Reads a `pdf-box`'s anchor; `undefined` when the box flows with the content. */
export function readPdfBoxAnchor(configuration: unknown): PdfBoxAnchor | undefined {
  if (!isRecord(configuration) || !isRecord(configuration.anchor)) {
    return undefined;
  }
  const anchor = configuration.anchor;
  const x = readFiniteNumber(anchor.x);
  const y = readFiniteNumber(anchor.y);
  const width = readFiniteNumber(anchor.width);
  const height = readFiniteNumber(anchor.height);
  if (x === undefined || y === undefined || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return undefined;
  }
  const rawPage = anchor.page;
  const page: PdfBoxAnchor["page"] =
    rawPage === "first" || rawPage === "last" || rawPage === "every"
      ? rawPage
      : typeof rawPage === "number" && Number.isFinite(rawPage) && rawPage >= 1
        ? Math.floor(rawPage)
        : "first";
  return { page, x, y, width, height };
}

// --- Per-component PDF options -----------------------------------------------------------

/**
 * What an ordinary form component says about its own PDF appearance, authored as
 * `configuration.pdf` in the form builder. The instance-level rung of the rendition ladder: a binding in a layout outranks it, a theme's default does not.
 */
export interface ComponentPdfOptions {
  /** The rendition this instance takes wherever a layout does not say otherwise. */
  rendition?: string;
  /** Leave this component out of every generated PDF (a "submit" note, a captcha). */
  exclude?: boolean;
  /**
   * For a `file` component: embed its uploaded files in the PDF as associated files. A layout binding's `attach` outranks it, as its `rendition` does.
   */
  attach?: boolean;
}

/** Reads `configuration.pdf` off a form component. Never throws. */
export function readComponentPdfOptions(configuration: unknown): ComponentPdfOptions {
  if (!isRecord(configuration) || !isRecord(configuration.pdf)) {
    return {};
  }
  const pdf = configuration.pdf;
  const options: ComponentPdfOptions = {};
  if (typeof pdf.rendition === "string" && pdf.rendition.trim() !== "") {
    options.rendition = pdf.rendition;
  }
  if (pdf.exclude === true) {
    options.exclude = true;
  }
  if (pdf.attach === true) {
    options.attach = true;
  }
  return options;
}

/** The largest PDF template a layout embeds or the kernel fills (25 MiB of file); larger ones are refused with the "template" error. */
export const MAX_PDF_TEMPLATE_BYTES = 25 * 1024 * 1024;