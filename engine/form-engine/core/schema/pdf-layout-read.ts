/**
 * Reading the PDF layouts a form definition declares: the tolerant readers,
 * the validator they filter by, the layout condition and the selection among layouts, with the
 * types and constants they stand on. Split out of pdf-layout.ts: `<datum-form>` lists
 * a form's layouts (`pdfLayouts()`) without the PDF module, so this stays in the bundle; the rest
 * of the schema (page setup, conformance, signature and area resolvers) is read only when a PDF
 * is made, and loads with the PDF service.
 */
import { kernelRuleExpression } from "../expressions/compile.js";
import { isEvaluableExpression } from "../expressions/condition-shape.js";
import type { ArithmeticExpression, BinaryExpression, Expression, LogicalExpression, RuleSource } from "../expressions/expression.js";
import { kernelParseFormula } from "../expressions/formula.js";
import type { FormulaFunctionSignature } from "../expressions/formula-types.js";
import { formulaFunctionSignatures } from "../expressions/function-table.js";
import { base64ToBytes } from "./file-upload.js";
import type { ComponentNode } from "./types.js";


/** The root type of a generated layout's tree. */
export const PDF_DOCUMENT_COMPONENT_TYPE = "pdf-document";

// --- Page setup ---------------------------------------------------------------------------

export type PdfNamedPageSize = "A4" | "Letter" | "Legal";

/** A page size in PDF points (1/72 in), portrait. */
export interface PdfCustomPageSize {
  width: number;
  height: number;
}

export type PdfPageSize = PdfNamedPageSize | PdfCustomPageSize;

export type PdfPageOrientation = "portrait" | "landscape";

export interface PdfPageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PdfPageSetup {
  size: PdfPageSize;
  orientation: PdfPageOrientation;
  /** Points. */
  margins: PdfPageMargins;
  /** Height of the running header region, inside the top margin. Absent: no header band. */
  header?: { height: number };
  /** Height of the running footer region, inside the bottom margin. Absent: no footer band. */
  footer?: { height: number };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// --- Accessibility ------------------------------------------------------------------------

export interface PdfAccessibilityConfiguration {
  /** Emit a tagged PDF (structure tree, marked content). Default `true`. */
  tagged?: boolean;
  /** Document language (`/Lang`). Absent: the locale the PDF is rendered in. */
  lang?: string;
  /** Document title (`/Title`, shown in the viewer's title bar). Absent: the form's title. */
  title?: string;
  /** Ask viewers to show the title rather than the file name. Default `true`. */
  displayDocTitle?: boolean;
}

// --- Conformance ---------------------------------------------------------------

/** A PDF/A level a file may declare: ISO 19005 part and conformance letter. */
export type PdfAConformance = "1a" | "1b" | "2a" | "2b" | "2u" | "3a" | "3b" | "3u";

/** The levels a layout may ask the kernel to produce; part 1 is only ever preserved from a template. */
export type PdfAClaim = Exclude<PdfAConformance, "1a" | "1b">;

export const PDF_A_CLAIMS: readonly PdfAClaim[] = ["2b", "2u", "2a", "3b", "3u", "3a"];

/**
 * The output condition a PDF/A document declares: an ICC profile the host stores (the same
 * attachment envelope a template travels in) and the names the intent carries. Absent, the
 * kernel declares sRGB IEC61966-2.1 with its own profile.
 */
export interface PdfOutputIntentConfiguration {
  profile: PdfAssetSource;
  /** `/OutputConditionIdentifier`. Absent: the profile's file name without its extension. */
  identifier?: string;
  /** `/Info`, the human-readable condition. Absent: the identifier. */
  info?: string;
  /** `/RegistryName` (`http://www.color.org` for registered conditions). Absent: none written. */
  registry?: string;
}

export interface PdfAttachmentConfiguration {
  /** The embedded file's name. Default `submission.json`. */
  name?: string;
  /** What the file is, for the reader's attachment pane. Default "Submission data". */
  description?: string;
}

/** The archival profile a layout asks for. Absent or without `pdfa`: an ordinary PDF. */
export interface PdfConformanceConfiguration {
  pdfa?: PdfAClaim;
  outputIntent?: PdfOutputIntentConfiguration;
  /** Under part 3: embed the submission values (JSON) as an associated file. Default `false`. */
  attachData?: boolean;
  attachment?: PdfAttachmentConfiguration;
}

/**
 * The colour components an ICC profile describes, from its header (`acsp` at byte 36, the
 * colour space at 16); `undefined` when the bytes are not a profile. Shared by the designer's
 * upload control, the layout check and the kernel, so all three agree on what a profile is.
 */
export function readIccColorSpace(bytes: Uint8Array): 1 | 3 | 4 | undefined {
  if (bytes.length < 128) {
    return undefined;
  }
  const ascii = (offset: number): string => String.fromCharCode(bytes[offset]!, bytes[offset + 1]!, bytes[offset + 2]!, bytes[offset + 3]!);
  if (ascii(36) !== "acsp") {
    return undefined;
  }
  switch (ascii(16)) {
    case "GRAY":
      return 1;
    case "RGB ":
      return 3;
    case "CMYK":
      return 4;
    default:
      return undefined;
  }
}

/** The storage kind of a profile the kernel carries itself; `ref` names one of {@link PDF_BUILTIN_PROFILES}. */
export const PDF_BUILTIN_ASSET_STORAGE = "builtin";

export type PdfBuiltinProfileId = "srgb" | "gray" | "cmyk";

/** A built-in output condition: what the kernel declares for it, and what a picker shows. */
export interface PdfBuiltinProfile {
  id: PdfBuiltinProfileId;
  label: string;
  /** `/OutputConditionIdentifier`. */
  identifier: string;
  /** `/Info`. */
  info: string;
  /** `/RegistryName`, for a condition the ICC registry lists. */
  registry?: string;
  components: 1 | 3 | 4;
  /** The profile's file name in the envelope, and its byte length (the kernel's tests hold it to this). */
  file: string;
  size: number;
}

/**
 * The output conditions the kernel carries (no fetch, the same bytes on every host): sRGB —
 * the default when nothing names a profile — a gamma-2.2 grey for monochrome archives, and
 * a compact SWOP-compatible CMYK (CGATS TR 001). Press-grade profiles are uploaded or host-stored.
 */
export const PDF_BUILTIN_PROFILES: readonly PdfBuiltinProfile[] = [
  { id: "srgb", label: "sRGB IEC61966-2.1", identifier: "sRGB IEC61966-2.1", info: "sRGB IEC61966-2.1", registry: "http://www.color.org", components: 3, file: "sRGB IEC61966-2.1.icc", size: 3144 },
  { id: "gray", label: "Gray gamma 2.2", identifier: "Gray gamma 2.2", info: "Gray gamma 2.2, D65 white point", components: 1, file: "Gray gamma 2.2.icc", size: 376 },
  {
    id: "cmyk",
    label: "CMYK, SWOP-compatible (CGATS TR 001)",
    identifier: "CGATS TR 001",
    info: "CGATS TR 001 (U.S. Web Coated SWOP), compact compatible profile",
    registry: "http://www.color.org",
    components: 4,
    file: "CGATS TR 001 compatible.icc",
    size: 8464
  }
];

/** The built-in profile an envelope names, if it names one. */
export function builtinProfileOf(source: PdfAssetSource | undefined): PdfBuiltinProfile | undefined {
  if (!source || source.storage !== PDF_BUILTIN_ASSET_STORAGE) {
    return undefined;
  }
  return PDF_BUILTIN_PROFILES.find((entry) => entry.id === source.ref);
}

/**
 * Whether an asset is a profile as far as this side can tell: an inline (base64) one must
 * decode to an ICC profile, a built-in one must name a profile the kernel carries; a
 * host-stored one is trusted here and checked by the kernel.
 */
export function isIccProfileSource(source: PdfAssetSource): boolean {
  if (source.storage === PDF_BUILTIN_ASSET_STORAGE) {
    return builtinProfileOf(source) !== undefined;
  }
  if (source.storage !== "base64" || typeof source.data !== "string") {
    return true;
  }
  try {
    return readIccColorSpace(base64ToBytes(source.data)) !== undefined;
  } catch {
    return false;
  }
}

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function pdfAClaimOf(value: unknown): PdfAClaim | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const level = value.trim().toLowerCase();
  return PDF_A_CLAIMS.includes(level as PdfAClaim) ? (level as PdfAClaim) : undefined;
}

/** A bare file name for an embedded file: no path separators, nothing empty. */
/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function attachmentNameOf(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const name = value.trim();
  return name !== "" && !/[\\/]/.test(name) ? name : undefined;
}

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function isAssetSource(value: unknown): value is PdfAssetSource {
  return (
    isRecord(value) &&
    typeof value.storage === "string" &&
    value.storage !== "" &&
    (value.storage !== "base64" || typeof value.data === "string")
  );
}

// --- Attachments -----------------------------------------------------------------

/**
 * What happens when the uploaded files a document is to embed would take it past its budget:
 * `skip` leaves the file out with an `attachment.skipped` warning and keeps going (a later,
 * smaller file may still fit); `fail` refuses the document with the `attachment_budget` code.
 */
export type PdfAttachmentOverflowPolicy = "skip" | "fail";

/** A layout's say on the uploaded files it embeds, in the author's units. */
export interface PdfAttachmentsConfiguration {
  /** Total size of the files one document may embed, in MB. Absent: 4. */
  budgetMb?: number;
  /** Default `skip`. */
  onExceeded?: PdfAttachmentOverflowPolicy;
}

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function overflowPolicyOf(value: unknown): PdfAttachmentOverflowPolicy | undefined {
  return value === "skip" || value === "fail" ? value : undefined;
}

/** What is wrong with an `attachments` block; nothing for an absent one. */
function attachmentsProblems(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return ["attachments must be an object"];
  }
  const problems: string[] = [];
  if (value.budgetMb !== undefined && (typeof value.budgetMb !== "number" || !Number.isFinite(value.budgetMb) || value.budgetMb < 0)) {
    problems.push("attachments.budgetMb must be a number of megabytes, zero or more");
  }
  if (value.onExceeded !== undefined && overflowPolicyOf(value.onExceeded) === undefined) {
    problems.push('attachments.onExceeded must be "skip" or "fail"');
  }
  return problems;
}

// --- Signature ------------------------------------------------------------------

export type PdfSignatureSubFilterSetting = "ETSI.CAdES.detached" | "adbe.pkcs7.detached";
export type PdfSignatureCertifySetting = false | "noChanges" | "formFilling" | "annotations";

/** Where the visible signature is drawn when no field places it; `false` on the block for an invisible one. */
export interface PdfSignatureAppearanceConfiguration {
  /** 1-based page; absent: the last. */
  page?: number;
  /** Points from the page's top-left corner: x, y, width, height. */
  rect?: [number, number, number, number];
  /** The lines to draw; absent: "Digitally signed by …", the date, the reason. */
  lines?: string[];
  fontId?: string;
  fontSize?: number;
}

/**
 * How a layout asks its documents to be sealed: which field the server signs
 * into, whether the signature certifies the document, what it says. The host still supplies
 * the certificates and does the signing; a request may override any key.
 */
export interface PdfSignatureConfiguration {
  subFilter?: PdfSignatureSubFilterSetting;
  /** A certification signature with these permissions; absent or `false`: an approval signature. */
  certify?: PdfSignatureCertifySetting;
  /** The `pdf-signature` block (its `fieldName`) or template field the signature lands in; absent: an invisible field of its own. */
  field?: string;
  /** The signer as shown; absent: the certificate's common name. */
  name?: string;
  reason?: string;
  location?: string;
  contactInfo?: string;
  appearance?: false | PdfSignatureAppearanceConfiguration;
  /** Reserve room for an RFC 3161 timestamp. */
  timestamp?: boolean;
  /** A document rendered without certificates is refused rather than produced unsigned. */
  required?: boolean;
  placeholderBytes?: number;
  /** What the signer means by signing: a CAdES commitment type, with a statement, signed with the attributes. */
  commitment?: PdfSignatureCommitmentConfiguration;
}

export type PdfSignatureCommitmentTypeSetting = "origin" | "receipt" | "delivery" | "sender" | "approval" | "creation";

export const PDF_SIGNATURE_COMMITMENT_TYPE_SETTINGS: readonly PdfSignatureCommitmentTypeSetting[] = ["approval", "origin", "receipt", "delivery", "sender", "creation"];

export interface PdfSignatureCommitmentConfiguration {
  type: PdfSignatureCommitmentTypeSetting;
  statement?: string;
}

export const PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES = 65536;

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function signatureCommitmentOf(value: unknown): PdfSignatureCommitmentConfiguration | undefined {
  if (!isRecord(value) || typeof value.type !== "string" || !(PDF_SIGNATURE_COMMITMENT_TYPE_SETTINGS as readonly string[]).includes(value.type)) {
    return undefined;
  }
  const statement = value.statement;
  return { type: value.type as PdfSignatureCommitmentTypeSetting, ...(typeof statement === "string" && statement.trim() !== "" ? { statement } : {}) };
}

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function signatureSubFilterOf(value: unknown): PdfSignatureSubFilterSetting | undefined {
  return value === "ETSI.CAdES.detached" || value === "adbe.pkcs7.detached" ? value : undefined;
}

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function signatureCertifyOf(value: unknown): PdfSignatureCertifySetting | undefined {
  return value === false || value === "noChanges" || value === "formFilling" || value === "annotations" ? value : undefined;
}

/** Shared with the resolvers in pdf-layout.ts; not part of the package surface. */
export function isRect(value: unknown): value is [number, number, number, number] {
  return Array.isArray(value) && value.length === 4 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry));
}

/** What is wrong with a `signature` block; nothing for an absent one. */
function signatureProblems(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return ["signature must be an object"];
  }
  const problems: string[] = [];
  if (value.subFilter !== undefined && signatureSubFilterOf(value.subFilter) === undefined) {
    problems.push('signature.subFilter must be "ETSI.CAdES.detached" or "adbe.pkcs7.detached"');
  }
  if (value.certify !== undefined && signatureCertifyOf(value.certify) === undefined) {
    problems.push('signature.certify must be false, "noChanges", "formFilling" or "annotations"');
  }
  if (value.commitment !== undefined && signatureCommitmentOf(value.commitment) === undefined) {
    problems.push(`signature.commitment.type must be one of ${PDF_SIGNATURE_COMMITMENT_TYPE_SETTINGS.join(", ")}`);
  }
  if (value.field !== undefined && (typeof value.field !== "string" || value.field.trim() === "")) {
    problems.push("signature.field must be a field name");
  }
  if (value.appearance !== undefined && value.appearance !== false) {
    if (!isRecord(value.appearance)) {
      problems.push("signature.appearance must be false or an object");
    } else if (value.appearance.rect !== undefined && !isRect(value.appearance.rect)) {
      problems.push("signature.appearance.rect must be four numbers: x, y, width, height");
    }
  }
  if (value.placeholderBytes !== undefined && (typeof value.placeholderBytes !== "number" || !Number.isInteger(value.placeholderBytes) || value.placeholderBytes <= 0 || value.placeholderBytes > PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES)) {
    problems.push(`signature.placeholderBytes must be a whole number of bytes up to ${PDF_SIGNATURE_PLACEHOLDER_MAX_BYTES}`);
  }
  return problems;
}

// --- Layouts ------------------------------------------------------------------------------

export interface PdfGeneratedLayout {
  id: string;
  kind: "generated";
  /** What the layout is called where a person picks one ("Applicant copy"). */
  name?: string;
  /**
   * When a download that names no layout prints this one: a condition over the
   * form's answers as they would be submitted, by component id — the view a server holds.
   * Layouts are tried in list order and the first whose condition holds prints; when none
   * does, the default prints. A `when` the evaluator cannot run never holds. Absent: this
   * layout prints only when asked for by id, or as the default. A formula string or the rule
   * object form; a string the parser rejects never holds.
   */
  when?: RuleSource;
  page?: Partial<PdfPageSetup>;
  accessibility?: PdfAccessibilityConfiguration;
  /** The archival profile (PDF/A) the document declares. Absent: the theme's, else none. */
  conformance?: PdfConformanceConfiguration;
  /** The budget for the uploaded files this layout embeds. Absent: 4 MB, skip. */
  attachments?: PdfAttachmentsConfiguration;
  /** How the document is sealed when the host signs it. Absent: the host's request alone says. */
  signature?: PdfSignatureConfiguration;
  /** The `"pdf"`-target theme this layout renders under. Absent: the host's choice, else the engine default. */
  theme?: string;
  /**
   * The rendition a component type takes in this layout unless a binding or the instance
   * says otherwise, keyed by type with `"*"` as the wildcard. This is how one form has a
   * "filled record" layout (values as text) and a "blank fillable" layout (`"*": "field"`).
   */
  renditionDefaults?: Record<string, string>;
  /** The layout tree: a `pdf-document` root with `body`, `header` and `footer` slots. */
  root: ComponentNode;
}

/**
 * Where a template's bytes are. The envelope is the file attachment's
 * (`core/schema/file-upload.ts`): inline base64 travels with the definition, and any other
 * `storage` names a kind the host resolves (an asset id, a URL) through a `PdfTemplateResolver`.
 */
export interface PdfTemplateSource {
  storage: string;
  name: string;
  type: string;
  size: number;
  /** Present when `storage` is `"base64"`: the PDF bytes, no `data:` prefix. */
  data?: string;
  /** Present for host storages: whatever the host needs to find the bytes. */
  ref?: unknown;
}

/**
 * The same envelope for any binary asset a layout names — a template, an ICC profile — resolved
 * through the host's `PdfTemplateResolver`, which serves attachment envelopes of every kind.
 */
export type PdfAssetSource = PdfTemplateSource;

export type PdfFieldMappingSource =
  | { kind: "component"; componentId: string }
  | { kind: "path"; path: string }
  | { kind: "template"; text: string }
  /** A formula string or the rule object form; a string the parser rejects prints blank. */
  | { kind: "expression"; expression: RuleSource }
  | { kind: "literal"; value: string | number | boolean | null };

export interface PdfValueFormat {
  kind: "text" | "number" | "date" | "boolean";
  /** Format-specific pattern: decimals for numbers, a date pattern, `yes|no` texts for booleans. */
  pattern?: string;
}

/** What a field mapping and an area share: where the value comes from and how it is shaped. */
export interface PdfMappingBinding {
  source: PdfFieldMappingSource;
  /** For a checkbox, radio or check area: the value that means "checked" / the option to select. */
  checkedValue?: string;
  /**
   * Answer value -> the value written to the PDF: the export value of a radio, dropdown or list
   * option (a government form's radios are often `1`, `2`, `3` while the page shows words), or
   * any text. Keys are answers as strings; a boolean answer is keyed `"true"` / `"false"`. An
   * answer with no key passes through unchanged, with a `mapping.unmappedValue` warning. Applied
   * to the answer before `checkedValue` compares it and before `format` shapes it.
   */
  values?: Record<string, string>;
  format?: PdfValueFormat;
}

/** One AcroForm field of the template and what fills it. */
export interface PdfFieldMapping extends PdfMappingBinding {
  /** The fully qualified AcroForm field name (`topmostSubform[0].Page1[0].Name[0]`). */
  pdfField: string;
}

/** How an area draws its value: wrapped text, or a tick when the value means "checked". */
export type PdfTemplateAreaKind = "text" | "check";

export interface PdfTemplateAreaDraw {
  /** Default `text`. */
  kind?: PdfTemplateAreaKind;
  /** Points. Default 10. */
  fontSize?: number;
  /** Horizontal placement of the text in the box. Default `start`. */
  align?: "start" | "center" | "end";
  /** Vertical placement of the text in the box. Default `top`. */
  valign?: "top" | "middle" | "bottom";
  /** Points between the box's edge and the text. Default 2. */
  padding?: number;
  /** Wrap long text onto further lines. Default `true`; off, one line clipped at the box's edge. */
  wrap?: boolean;
  bold?: boolean;
  /** `#rrggbb`; absent, the kernel's text colour. */
  color?: string;
}

/**
 * The area is an AcroForm widget rather than page content — a text field for `draw.kind`
 * `text`, a check box for `check` — transparent but for its text, so the PDF becomes fillable
 * where the paper had a blank. The value, if any, fills the field; the drawing choices that
 * a widget can carry (size, alignment, bold, colour, wrap as multiline) carry over; `valign`
 * and `padding` do not (viewers place a field's text themselves).
 */
export interface PdfTemplateAreaField {
  /**
   * The AcroForm field name, kept as typed; two areas of one typed name share one field. Absent,
   * the area's label made a usable name (periods, which would make it a field path, become
   * spaces), else its id — unique among the layout's areas, so two areas never share a field
   * by an accident of their labels (see {@link resolvePdfAreaFields}).
   */
  name?: string;
  required?: boolean;
  readOnly?: boolean;
  /** The widget's tooltip (`/TU`); absent, the area's label. */
  tooltip?: string;
}

/**
 * A rectangle on a page of the template that an answer is drawn into — how a PDF that has no
 * form fields (a scanned or hand-laid form) is populated. Coordinates are points from the
 * page's left and top edges, the `PdfBoxAnchor` convention, and the designer's page viewer
 * reports them the same way.
 */
export interface PdfTemplateArea extends PdfMappingBinding {
  id: string;
  /** What the designer calls the area; absent, its id. */
  label?: string;
  /** 1-based, like the fields the kernel's `inspect` op lists. */
  page: number;
  rect: { x: number; y: number; width: number; height: number };
  draw?: PdfTemplateAreaDraw;
  /** Present: the area is a fillable field (see {@link PdfTemplateAreaField}). */
  field?: PdfTemplateAreaField;
}

export interface PdfTemplateFillOptions {
  /** Burn the values into the page content and drop the fields. Default `false`. */
  flatten?: boolean;
  /** Keep the fields but mark every filled one read-only. Default `false`. */
  readOnly?: boolean;
  /**
   * `regenerate` (default): the kernel draws each field's appearance so every viewer shows the
   * same thing; `viewer`: leave it to the viewer (`NeedAppearances`), which keeps the
   * template's own look for scripts and fonts the kernel cannot reproduce.
   */
  appearances?: "regenerate" | "viewer";
}

export interface PdfTemplateLayout {
  id: string;
  kind: "template";
  name?: string;
  /**
   * When a download that names no layout prints this one: a condition over the
   * form's answers as they would be submitted, by component id — the view a server holds.
   * Layouts are tried in list order and the first whose condition holds prints; when none
   * does, the default prints. A `when` the evaluator cannot run never holds. Absent: this
   * layout prints only when asked for by id, or as the default. A formula string or the rule
   * object form; a string the parser rejects never holds.
   */
  when?: RuleSource;
  accessibility?: PdfAccessibilityConfiguration;
  /** The archival profile to keep: a PDF/A template stays PDF/A through the fill. */
  conformance?: PdfConformanceConfiguration;
  /** The budget for the uploaded files the filled document embeds. Absent: 4 MB, skip. */
  attachments?: PdfAttachmentsConfiguration;
  /** How the filled document is sealed when the host signs it; `field` names one of the template's signature fields. */
  signature?: PdfSignatureConfiguration;
  template: PdfTemplateSource;
  /** The template's AcroForm fields and what fills each. Empty when the PDF has none. */
  fields: PdfFieldMapping[];
  /** Answers drawn onto the pages themselves, where the PDF has no field to fill. */
  areas?: PdfTemplateArea[];
  options?: PdfTemplateFillOptions;
}

export type PdfLayoutDocument = PdfGeneratedLayout | PdfTemplateLayout;

/**
 * The problems that make a layout unusable, in words the designer can show. An empty list means
 * the layout is well-formed enough to render (it may still warn while rendering — an unbound
 * field, an unknown rendition — but those are per-run findings, not schema faults).
 */
export function validatePdfLayout(layout: unknown): string[] {
  if (!isRecord(layout)) {
    return ["layout must be an object"];
  }
  const problems: string[] = [];
  if (typeof layout.id !== "string" || layout.id.trim() === "") {
    problems.push("layout.id is required");
  }
  if (layout.kind === "generated") {
    const root = layout.root;
    if (!isRecord(root) || typeof root.id !== "string" || typeof root.type !== "string") {
      problems.push("generated layout needs a root component node");
    } else if (root.type !== PDF_DOCUMENT_COMPONENT_TYPE) {
      problems.push(`generated layout root must be a "${PDF_DOCUMENT_COMPONENT_TYPE}" node`);
    }
    if (layout.renditionDefaults !== undefined && !isRecord(layout.renditionDefaults)) {
      problems.push("renditionDefaults must map component types to rendition ids");
    }
  } else if (layout.kind === "template") {
    const template = layout.template;
    if (!isRecord(template) || typeof template.storage !== "string" || template.storage === "") {
      problems.push("template layout needs a template source with a storage kind");
    } else if (template.storage === "base64" && typeof template.data !== "string") {
      problems.push("a base64 template source needs its data");
    }
    if (!Array.isArray(layout.fields)) {
      problems.push("template layout needs a fields list");
    } else {
      layout.fields.forEach((mapping, index) => {
        if (!isRecord(mapping) || typeof mapping.pdfField !== "string" || mapping.pdfField === "") {
          problems.push(`fields[${index}] needs a pdfField name`);
        } else if (!isRecord(mapping.source) || typeof mapping.source.kind !== "string") {
          problems.push(`fields[${index}] ("${mapping.pdfField}") needs a source`);
        }
      });
    }
    if (layout.areas !== undefined) {
      if (!Array.isArray(layout.areas)) {
        problems.push("template layout areas must be a list");
      } else {
        const ids = new Set<string>();
        layout.areas.forEach((area, index) => {
          if (!isRecord(area) || typeof area.id !== "string" || area.id.trim() === "") {
            problems.push(`areas[${index}] needs an id`);
            return;
          }
          const name = typeof area.label === "string" && area.label !== "" ? area.label : area.id;
          if (ids.has(area.id)) {
            problems.push(`areas[${index}] repeats the id "${area.id}"`);
          }
          ids.add(area.id);
          if (typeof area.page !== "number" || !Number.isInteger(area.page) || area.page < 1) {
            problems.push(`areas[${index}] ("${name}") needs a page number from 1`);
          }
          const rect = area.rect;
          const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
          if (!isRecord(rect) || !finite(rect.x) || !finite(rect.y) || !finite(rect.width) || !finite(rect.height) || rect.width <= 0 || rect.height <= 0) {
            problems.push(`areas[${index}] ("${name}") needs a rect with a positive width and height`);
          }
          if (!isRecord(area.source) || typeof area.source.kind !== "string") {
            problems.push(`areas[${index}] ("${name}") needs a source`);
          }
          if (area.field !== undefined) {
            if (!isRecord(area.field)) {
              problems.push(`areas[${index}] ("${name}") field must be an object`);
            } else if (area.field.name !== undefined && (typeof area.field.name !== "string" || area.field.name.trim() === "" || area.field.name.includes(".."))) {
              problems.push(`areas[${index}] ("${name}") field needs a name`);
            }
          }
        });
      }
    }
  } else {
    problems.push('layout.kind must be "generated" or "template"');
  }
  problems.push(...conformanceProblems(layout.conformance));
  problems.push(...attachmentsProblems(layout.attachments));
  problems.push(...signatureProblems(layout.signature));
  return problems;
}

/** What is wrong with a `conformance` block; nothing for an absent one. */
function conformanceProblems(value: unknown): string[] {
  if (value === undefined) {
    return [];
  }
  if (!isRecord(value)) {
    return ["conformance must be an object"];
  }
  const problems: string[] = [];
  if (value.pdfa !== undefined && pdfAClaimOf(value.pdfa) === undefined) {
    problems.push(`conformance.pdfa must be one of ${PDF_A_CLAIMS.join(", ")}`);
  }
  if (value.outputIntent !== undefined) {
    if (!isRecord(value.outputIntent)) {
      problems.push("conformance.outputIntent must be an object");
    } else if (!isAssetSource(value.outputIntent.profile)) {
      problems.push("conformance.outputIntent needs a profile with a storage kind (and its data when base64)");
    } else if (value.outputIntent.profile.storage === PDF_BUILTIN_ASSET_STORAGE && !isIccProfileSource(value.outputIntent.profile)) {
      problems.push(`conformance.outputIntent.profile names no built-in profile (${PDF_BUILTIN_PROFILES.map((entry) => entry.id).join(", ")})`);
    } else if (!isIccProfileSource(value.outputIntent.profile)) {
      problems.push("conformance.outputIntent.profile is not an ICC profile");
    }
  }
  if (value.attachment !== undefined) {
    if (!isRecord(value.attachment)) {
      problems.push("conformance.attachment must be an object");
    } else if (value.attachment.name !== undefined && attachmentNameOf(value.attachment.name) === undefined) {
      problems.push("conformance.attachment.name must be a bare file name");
    }
  }
  return problems;
}

/**
 * The layouts a definition declares, in order, skipping any that fail {@link validatePdfLayout}.
 * Never throws: a definition with no `pdf` key, or a hand-edited one, yields what is usable.
 */
export function readPdfConfiguration(definition: { pdf?: unknown } | undefined): PdfLayoutDocument[] {
  const pdf = definition?.pdf;
  if (!isRecord(pdf) || !Array.isArray(pdf.layouts)) {
    return [];
  }
  return pdf.layouts.filter(
    (layout): layout is PdfLayoutDocument => validatePdfLayout(layout).length === 0
  );
}

/** The `defaultLayoutId` a definition names, when it is a string. */
export function readDefaultPdfLayoutId(definition: { pdf?: unknown } | undefined): string | undefined {
  const pdf = definition?.pdf;
  if (!isRecord(pdf) || typeof pdf.defaultLayoutId !== "string" || pdf.defaultLayoutId === "") {
    return undefined;
  }
  return pdf.defaultLayoutId;
}

// --- Choosing a layout --------------------------------------------------------

/**
 * How the layout that printed was chosen: handed over whole by the caller (`given`), asked for
 * by id (`asked`), its `when` held (`condition`), the declared default (`default`), the first
 * layout for want of a declared one (`fallback`), or none — the form declares no usable layout,
 * or none by the id asked for — and one was derived from the form's tree (`derived`).
 */
export type PdfLayoutChoice = "given" | "asked" | "condition" | "default" | "fallback" | "derived";

/**
 * Runs a layout's condition over the answers keyed by component id. The result is read as
 * `Boolean(...)`, as a journey's page and route conditions are. Injected, so `core/` stays
 * free of the evaluator (the render layer passes `evaluateExpression`).
 */
export type PdfConditionEvaluate = (expression: Expression, values: Record<string, unknown>) => unknown;

/**
 * A layout's `when` as the chooser reads it: a condition the evaluator can run all the way
 * down, or something written there that it cannot — a string, a misspelt operator, a missing
 * operand — which never holds. Only the layout's top level is read; the designer lifts a `when`
 * edited on the document root back there, so there is one place to look.
 */
export type PdfLayoutCondition =
  | { evaluable: true; expression: Expression }
  | { evaluable: false; written: unknown };

/**
 * The signatures a PDF condition or an expression source is parsed against: the built-in
 * function table, plus the names of the functions a plugin registered with the program
 * (`__datum_pdf_register({ functions })`), whose arity the program does not know.
 */
export function pdfFormulaSignatures(functions?: readonly string[]): FormulaFunctionSignature[] {
  const signatures = formulaFunctionSignatures();
  for (const name of functions ?? []) {
    if (!signatures.some((entry) => entry.name === name)) {
      signatures.push({ name, min: 0, max: Number.POSITIVE_INFINITY });
    }
  }
  return signatures;
}

/**
 * A rule as a PDF layout carries it — a formula string or the rule object form, or a compiled
 * copy's tree — as the tree the evaluator runs; `undefined` for a string the parser rejects, or
 * no rule at all.
 */
export function pdfRuleExpression(source: unknown, functions?: readonly string[]): Expression | undefined {
  return kernelRuleExpression(source, kernelParseFormula, pdfFormulaSignatures(functions));
}

/**
 * The expression with every call to one of `names` replaced by a literal, so the shape check
 * (`isEvaluableExpression`, built-ins only) can pass judgement on the rest: a plugin's function
 * is one the evaluator runs through the registry on its context. A copy; the tree is not changed.
 */
function withPluginCallsMasked(expression: Expression, names: ReadonlySet<string>): Expression {
  switch (expression.kind) {
    case "unary":
      return { ...expression, operand: withPluginCallsMasked(expression.operand, names) };
    case "binary":
    case "logical":
    case "arithmetic": {
      // The left spine of a long chain (a and b and c ...) is walked with a list, not by
      // recursion, so a 20,000-term condition costs no call-stack depth; right operands recurse.
      const spine: Array<BinaryExpression | LogicalExpression | ArithmeticExpression> = [];
      let walk: Expression = expression;
      while (walk.kind === "binary" || walk.kind === "logical" || walk.kind === "arithmetic") {
        spine.push(walk);
        walk = walk.left;
      }
      let built: Expression = withPluginCallsMasked(walk, names);
      for (let at = spine.length - 1; at >= 0; at -= 1) {
        const link = spine[at] as BinaryExpression | LogicalExpression | ArithmeticExpression;
        built = { ...link, left: built, right: withPluginCallsMasked(link.right, names) } as Expression;
      }
      return built;
    }
    case "call":
      if (names.has(expression.name)) {
        return expression.args.every((arg) => isEvaluableExpression(withPluginCallsMasked(arg, names)))
          ? { kind: "literal", value: true }
          : expression;
      }
      return { ...expression, args: expression.args.map((arg) => withPluginCallsMasked(arg, names)) };
    case "if":
      return {
        ...expression,
        cases: expression.cases.map((entry) => ({ when: withPluginCallsMasked(entry.when, names), then: withPluginCallsMasked(entry.then, names) })),
        ...(expression.else !== undefined ? { else: withPluginCallsMasked(expression.else, names) } : {})
      };
    default:
      return expression;
  }
}

/**
 * The layout's condition; `undefined` when it has none (`when` absent, or `null` as JSON writes
 * a cleared one). A formula string or the rule object form is read through the parser; what the
 * author wrote stays as `written` when it cannot be run, so a finding can show it. `functions`
 * names the plugin functions a condition may call beside the built-ins.
 */
export function readPdfLayoutCondition(layout: { when?: unknown }, functions?: readonly string[]): PdfLayoutCondition | undefined {
  const written = layout.when;
  if (written === undefined || written === null) {
    return undefined;
  }
  const expression = pdfRuleExpression(written, functions);
  if (expression === undefined) {
    return { evaluable: false, written };
  }
  const shape = functions && functions.length > 0 ? withPluginCallsMasked(expression, new Set(functions)) : expression;
  return isEvaluableExpression(shape) ? { evaluable: true, expression } : { evaluable: false, written };
}

export interface PdfLayoutSelectionRequest {
  /** The caller's explicit choice, matched exactly: it wins over every condition. */
  layoutId?: string | undefined;
  /**
   * The answers a `when` reads: the submittable view keyed by component id. A thunk, so the
   * re-keying is done only when a layout has a condition to try.
   */
  values?: (() => Record<string, unknown>) | undefined;
  /** Absent (or `values` absent), no condition is tried: by id, else the default, else the first. */
  evaluate?: PdfConditionEvaluate | undefined;
  /** The names of the plugin functions a `when` may call beside the built-ins (the program's `functions` registry). */
  functions?: readonly string[] | undefined;
}

/** A condition that was tried and could not be evaluated: it counted as not holding. */
export interface PdfLayoutConditionFailure {
  layoutId: string;
  /** `invalid`: the `when` is no condition the evaluator can run; `threw`: running it threw. */
  reason: "invalid" | "threw";
  /** What the evaluator said, for `threw`. */
  message?: string;
}

export interface PdfLayoutSelection {
  /** `undefined`: derive a layout from the form. */
  layout: PdfLayoutDocument | undefined;
  choice: Exclude<PdfLayoutChoice, "given">;
  /** The conditions tried that could not be evaluated, in list order. Empty unless conditions were tried. */
  failed: PdfLayoutConditionFailure[];
}

/**
 * The layout a download prints, in one order everywhere: the layout asked for by id,
 * exactly — an unknown or unusable id derives one rather than guessing; else the first layout,
 * in list order, whose `when` holds on `values` (the default is tried in its place too); else
 * the declared default; else the first layout; else none, and one is derived from the form. A
 * definition with no `when` anywhere chooses the asked layout, else the default, else the first.
 */
export function selectPdfLayout(
  definition: { pdf?: unknown } | undefined,
  request: PdfLayoutSelectionRequest = {}
): PdfLayoutSelection {
  const layouts = readPdfConfiguration(definition);
  if (request.layoutId !== undefined) {
    const asked = layouts.find((layout) => layout.id === request.layoutId);
    return asked ? { layout: asked, choice: "asked", failed: [] } : { layout: undefined, choice: "derived", failed: [] };
  }
  const failed: PdfLayoutConditionFailure[] = [];
  const { evaluate, values: valuesOf } = request;
  if (evaluate && valuesOf) {
    let values: Record<string, unknown> | undefined;
    for (const layout of layouts) {
      const condition = readPdfLayoutCondition(layout, request.functions);
      if (!condition) {
        continue;
      }
      if (!condition.evaluable) {
        failed.push({ layoutId: layout.id, reason: "invalid" });
        continue;
      }
      values ??= valuesOf();
      let holds: boolean;
      try {
        holds = evaluate(condition.expression, values) === true;
      } catch (error) {
        failed.push({ layoutId: layout.id, reason: "threw", message: error instanceof Error ? error.message : String(error) });
        continue;
      }
      if (holds) {
        return { layout, choice: "condition", failed };
      }
    }
  }
  const defaultId = readDefaultPdfLayoutId(definition);
  const declared = defaultId !== undefined ? layouts.find((layout) => layout.id === defaultId) : undefined;
  if (declared) {
    return { layout: declared, choice: "default", failed };
  }
  const first = layouts[0];
  return first ? { layout: first, choice: "fallback", failed } : { layout: undefined, choice: "derived", failed };
}

/**
 * What a download that names no layout can print, in the order they are tried: every layout
 * whose `when` can hold, then the one printed when none does (the declared default, else the
 * first), each once. A host that must have a layout's template bytes, fonts or signer ready
 * before it knows the answers prepares for all of these. Empty: a layout is derived.
 */
export function pdfLayoutCandidates(definition: { pdf?: unknown } | undefined, functions?: readonly string[]): PdfLayoutDocument[] {
  const candidates = readPdfConfiguration(definition).filter((layout) => readPdfLayoutCondition(layout, functions)?.evaluable === true);
  const fallback = selectPdfLayout(definition).layout;
  if (fallback && !candidates.includes(fallback)) {
    candidates.push(fallback);
  }
  return candidates;
}

/**
 * The layout to render, blind to conditions: the one asked for by id, else the definition's
 * default, else the first declared. `undefined` when the definition declares none (or names
 * one it does not have), which is the pipeline's cue to derive a layout from the form tree.
 *
 * A layout's `when` is not read, so for a form with conditional layouts this is
 * what prints when none holds, not what a given person's download prints: that depends on
 * the answers, and `selectPdfLayoutForValues` (in the render layer) takes them.
 */
export function findPdfLayout(
  definition: { pdf?: unknown } | undefined,
  layoutId?: string
): PdfLayoutDocument | undefined {
  return selectPdfLayout(definition, { layoutId }).layout;
}