/**
 * The PDF layout tree's component types as `ComponentDefinition`s, so the PDF
 * designer is a `BuilderController` over an ordinary registry: slot constraints, the composed
 * inspector, drafts and undo all apply unchanged. Their paper semantics live in the render
 * model (`pdf-render-model.ts`). Their design-time faces on the builder canvas are the PDF
 * designer's live-renderer adapters (`builder/pdf-designer/pdf-canvas-adapters.ts`): these
 * definitions draw nothing themselves.
 */
import type {
  ComponentDefinition,
  PropertyEditorAssetChoice,
  PropertyEditorChoice,
  PropertyEditorField
} from "../../core/schema/contracts.js";
import type { ComponentNode } from "../../core/schema/types.js";
import {
  DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES,
  DEFAULT_PDF_ATTACHMENT_NAME,
  PDF_BOX_COMPONENT_TYPE,
  PDF_DOCUMENT_BODY_SLOT,
  PDF_DOCUMENT_COMPONENT_TYPE,
  PDF_DOCUMENT_FOOTER_SLOT,
  PDF_DOCUMENT_HEADER_SLOT,
  PDF_FIELD_COMPONENT_TYPE,
  PDF_IMAGE_COMPONENT_TYPE,
  PDF_PAGE_BREAK_COMPONENT_TYPE,
  PDF_REPEAT_COMPONENT_TYPE,
  PDF_RULE_COMPONENT_TYPE,
  PDF_SECTION_COMPONENT_TYPE,
  PDF_SIGNATURE_COMPONENT_TYPE,
  PDF_SPACER_COMPONENT_TYPE,
  PDF_TABLE_COMPONENT_TYPE,
  PDF_TEXT_COMPONENT_TYPE,
  PDF_BUILTIN_PROFILES,
  builtinProfileSource,
  emptyPdfTableChildren
} from "../../core/schema/pdf-layout.js";
import { PDF_RENDITION_LABELS } from "../../core/schema/pdf-renditions.js";
import type { PdfProfileOption } from "./pdf-provider.js";

/** A palette entry; structurally a `BuilderComponentType`, declared here so `render/` does not import `builder/`. */
export interface PdfComponentTypeEntry {
  type: string;
  label: string;
  icon?: string;
  group?: string;
}

export const PDF_PALETTE_GROUP_CONTENT = "PDF content";
export const PDF_PALETTE_GROUP_LAYOUT = "PDF layout";

/**
 * The English of the words this module shows an author: the palette, every property label, hint and
 * choice, the canvas faces and the defaults a new block starts with. The builder's catalog carries
 * the same keys (`builder/pdf-designer/pdf-texts-en.ts` spreads this table), so a host translates
 * them like the rest of the builder; `render/` takes the words as a function and never imports `builder/`.
 */
export const PDF_COMPONENT_TEXT_EN = {
  "pdfComponent.palette.formField": "Form field",
  "pdfComponent.palette.text": "Text",
  "pdfComponent.palette.image": "Image",
  "pdfComponent.palette.signature": "Signature",
  "pdfComponent.palette.section": "Section",
  "pdfComponent.palette.table": "Table",
  "pdfComponent.palette.repeat": "Repeat",
  "pdfComponent.palette.box": "Box",
  "pdfComponent.palette.rule": "Rule",
  "pdfComponent.palette.spacer": "Spacer",
  "pdfComponent.palette.pageBreak": "Page break",
  "pdfComponent.theme.label": "PDF theme",
  "pdfComponent.theme.idLabel": "PDF theme id",
  "pdfComponent.theme.description": "The look this layout prints with. The default is the host's PDF theme when it sets one, then the PDF theme the form's design system suggests, then Datum.",
  "pdfComponent.theme.match": "Host or design system default",
  "pdfComponent.theme.idDescription": "Empty uses the host's PDF theme, then the PDF theme the form's design system suggests, then Datum.",
  "pdfComponent.text.text": "Text",
  "pdfComponent.doc.attachName.hint": "Empty uses {name}.",
  "pdfComponent.doc.budget.hint": "Total size of the uploaded files one document may embed (file components with \"Attach uploaded files to the PDF\" on, or bound here with \"Attach uploaded files\"). Empty uses {megabytes} MB.",
  "pdfComponent.default.section": "Section",
  "pdfComponent.default.text": "Text",
  "pdfComponent.default.signature": "Signature",
  "pdfComponent.page.size": "Page size",
  "pdfComponent.page.orientation": "Orientation",
  "pdfComponent.page.portrait": "Portrait",
  "pdfComponent.page.landscape": "Landscape",
  "pdfComponent.doc.name": "Layout name",
  "pdfComponent.doc.marginTop": "Top margin (pt)",
  "pdfComponent.doc.marginRight": "Right margin (pt)",
  "pdfComponent.doc.marginBottom": "Bottom margin (pt)",
  "pdfComponent.doc.marginLeft": "Left margin (pt)",
  "pdfComponent.doc.headerHeight": "Header band height (pt)",
  "pdfComponent.doc.footerHeight": "Footer band height (pt)",
  "pdfComponent.doc.headerHeight.hint": "Space reserved on every page for the header slot; 0 for none.",
  "pdfComponent.doc.footerHeight.hint": "Space reserved on every page for the footer slot; 0 for none.",
  "pdfComponent.doc.tagged": "Tagged PDF (accessible)",
  "pdfComponent.doc.displayTitle": "Show the title in the viewer",
  "pdfComponent.doc.lang": "Document language",
  "pdfComponent.doc.lang.hint": "BCP-47 code; empty uses the locale the PDF is rendered in.",
  "pdfComponent.doc.title": "Document title",
  "pdfComponent.doc.title.hint": "Empty uses the form's title.",
  "pdfComponent.doc.pdfa": "Archival (PDF/A)",
  "pdfComponent.doc.pdfa.hint": "Declare an ISO 19005 level. Needs a font resource for every family. The \"a\" levels tag the document whatever the switch above says.",
  "pdfComponent.doc.profile": "Output intent profile (ICC)",
  "pdfComponent.doc.profile.hint": "The output condition the PDF/A file declares: one the kernel carries, one the host offers, or an ICC file of your own. None: the theme's, else sRGB IEC61966-2.1. A Gray or CMYK profile is declared with DefaultRGB for what the kernel draws.",
  "pdfComponent.doc.intentId": "Output condition identifier",
  "pdfComponent.doc.intentId.hint": "Empty uses the profile's file name.",
  "pdfComponent.doc.intentInfo": "Output condition description",
  "pdfComponent.doc.intentInfo.hint": "Empty uses the identifier.",
  "pdfComponent.doc.intentRegistry": "Output condition registry",
  "pdfComponent.doc.intentRegistry.hint": "http://www.color.org for a registered condition; empty writes none.",
  "pdfComponent.doc.attachData": "Attach the submission data (PDF/A-3)",
  "pdfComponent.doc.attachData.hint": "Embed the answers as a JSON file the reader lists beside the pages. Part 3 only.",
  "pdfComponent.doc.attachName": "Attachment file name",
  "pdfComponent.doc.attachDescription": "Attachment description",
  "pdfComponent.doc.attachDescription.hint": "What the reader's attachment pane says the file is.",
  "pdfComponent.doc.budget": "Attachment budget (MB)",
  "pdfComponent.doc.exceeded": "Past the attachment budget",
  "pdfComponent.doc.exceeded.hint": "What happens to a file that would take the document past the budget.",
  "pdfComponent.doc.exceeded.warn": "Leave it out and warn",
  "pdfComponent.doc.exceeded.fail": "Refuse the document",
  "pdfComponent.doc.sigRequired": "Require the server's signature",
  "pdfComponent.doc.sigRequired.hint": "A document rendered without the host's certificates is refused instead of produced unsigned.",
  "pdfComponent.doc.sigField": "Signature field",
  "pdfComponent.doc.sigField.hint": "The pdf-signature block (its field name) the server signs into. Empty: a signature block of its own at the bottom of the last page.",
  "pdfComponent.doc.certify": "Certification",
  "pdfComponent.doc.certify.hint": "A certification signature says what may still change afterwards; an approval signature says nothing.",
  "pdfComponent.doc.certify.approval": "Approval signature",
  "pdfComponent.doc.certify.noChanges": "Certify — no changes allowed",
  "pdfComponent.doc.certify.formFilling": "Certify — allow form filling and further signatures",
  "pdfComponent.doc.certify.annotations": "Certify — allow annotations too",
  "pdfComponent.doc.sigReason": "Signature reason",
  "pdfComponent.doc.sigReason.hint": "Shown in the signature and its panel, in the document's locale.",
  "pdfComponent.doc.commitment": "Commitment",
  "pdfComponent.doc.commitment.hint": "What signing means, signed by the key itself (the CAdES commitment type); the reason above sits in the dictionary only.",
  "pdfComponent.none": "None",
  "pdfComponent.doc.commitment.approval": "Proof of approval",
  "pdfComponent.doc.commitment.origin": "Proof of origin",
  "pdfComponent.doc.commitment.receipt": "Proof of receipt",
  "pdfComponent.doc.commitment.delivery": "Proof of delivery",
  "pdfComponent.doc.commitment.sender": "Proof of sender",
  "pdfComponent.doc.commitment.creation": "Proof of creation",
  "pdfComponent.doc.commitmentStatement": "Commitment statement",
  "pdfComponent.doc.commitmentStatement.hint": "Free text the signature vouches for, e.g. what the signer affirms.",
  "pdfComponent.doc.sigLocation": "Signature location",
  "pdfComponent.doc.sigName": "Signer's name",
  "pdfComponent.doc.sigName.hint": "Empty uses the certificate's common name.",
  "pdfComponent.doc.sigProfile": "Signature profile",
  "pdfComponent.doc.sigProfile.pades": "PAdES (ETSI.CAdES.detached)",
  "pdfComponent.doc.sigProfile.adobe": "Adobe PKCS#7 (adbe.pkcs7.detached)",
  "pdfComponent.doc.sigTimestamp": "Reserve room for a timestamp",
  "pdfComponent.doc.sigTimestamp.hint": "When the host adds an RFC 3161 token from a timestamp authority.",
  "pdfComponent.doc.renditionDefault": "Default rendition for every field",
  "pdfComponent.doc.renditionDefault.hint": "How bound fields appear unless a binding says otherwise.",
  "pdfComponent.rendition.default": "Default — the component's own setting, the theme, then its type",
  "pdfComponent.pdfa.off": "Off — an ordinary PDF",
  "pdfComponent.pdfa.2u": "PDF/A-2u (Unicode)",
  "pdfComponent.pdfa.2a": "PDF/A-2a (accessible: Unicode and tagged)",
  "pdfComponent.pdfa.3b": "PDF/A-3b (attachments allowed)",
  "pdfComponent.pdfa.3u": "PDF/A-3u (Unicode, attachments allowed)",
  "pdfComponent.pdfa.3a": "PDF/A-3a (accessible, attachments allowed)",
  "pdfComponent.profile.builtIn": "Built in",
  "pdfComponent.profile.host": "From the host",
  "pdfComponent.section.heading": "Heading",
  "pdfComponent.section.hideHeading": "Hide heading",
  "pdfComponent.section.keepTogether": "Keep on one page",
  "pdfComponent.section.keepTogether.hint": "Move the whole section to the next page rather than split it.",
  "pdfComponent.section.skipWhenEmpty.hint": "Leave the section out, heading included, when nothing inside it prints (every field in it hidden by a rule, say).",
  "pdfComponent.skipWhenEmpty": "Skip when empty",
  "pdfComponent.table.skipWhenEmpty.hint": "Leave the table out when no cell prints: no entries in its collection, or every field in it hidden by a rule.",
  "pdfComponent.box.skipWhenEmpty.hint": "Leave the box out, border and fill included, when nothing inside it prints (every field in it hidden by a rule, say).",
  "pdfComponent.field.component": "Form component",
  "pdfComponent.field.choose": "— choose —",
  "pdfComponent.field.rendition": "Rendition",
  "pdfComponent.field.rendition.hint": "How this component appears here; the default follows the layout, the theme, then the component.",
  "pdfComponent.field.label": "Label override",
  "pdfComponent.field.label.hint": "Empty keeps the component's own label.",
  "pdfComponent.field.hideLabel": "Hide label",
  "pdfComponent.field.attach": "Attach uploaded files",
  "pdfComponent.field.attach.hint": "For a file component: embed its uploaded files in this PDF as attachments. Untouched, the component's own PDF setting decides; once set, this binding decides either way.",
  "pdfComponent.field.widgetName": "PDF field name",
  "pdfComponent.field.widgetName.hint": "Name of the fillable field written into the PDF: what a viewer or a data-extraction tool sees, and what a submitted PDF reports the answer under. Only the Field rendition uses it. Empty uses the component's value path: its id, prefixed by any data-scoping container (applicant.email) and, inside a repeat or table, by the collection path and row (items[0].email). A checkboxes component gets one field per option, named <field>.<option>. Names must be unique across the layout, and a name set here is not row-numbered inside a repeat, so leave it empty there.",
  "pdfComponent.text.text.hint": "Write {{fieldId}} to insert an answer, {{row.fieldId}} inside a repeat, {{page}} and {{pages}} in a header or footer. The Variables panel on the strip lists every one.",
  "pdfComponent.text.style": "Style",
  "pdfComponent.text.body": "Body text",
  "pdfComponent.text.h1": "Heading 1",
  "pdfComponent.text.h2": "Heading 2",
  "pdfComponent.text.h3": "Heading 3",
  "pdfComponent.text.muted": "Muted",
  "pdfComponent.text.label": "Label",
  "pdfComponent.text.align": "Alignment",
  "pdfComponent.text.alignStart": "Start",
  "pdfComponent.text.alignCenter": "Centre",
  "pdfComponent.text.alignEnd": "End",
  "pdfComponent.text.expression": "Expression",
  "pdfComponent.text.expression.hint": "Replaces the text with a computed value: a sum, a formula, answers joined together. Leave blank to print the text.",
  "pdfComponent.table.rows": "Rows",
  "pdfComponent.table.columns": "Columns",
  "pdfComponent.table.header": "First row is a header",
  "pdfComponent.table.header.hint": "Drawn in bold and repeated when the table continues on another page.",
  "pdfComponent.table.borders": "Borders",
  "pdfComponent.table.bordersAll": "All cells",
  "pdfComponent.table.bordersHorizontal": "Between rows",
  "pdfComponent.table.collection": "Repeat rows from collection",
  "pdfComponent.table.collection.hint": "The first non-header row is drawn once per entry; write {{row.fieldId}} in its cells.",
  "pdfComponent.table.collectionNone": "— none —",
  "pdfComponent.table.collection.hintFree": "A repeating section's or data grid's id. The first non-header row is drawn once per entry; write {{row.fieldId}} in its cells.",
  "pdfComponent.repeat.collection": "Collection",
  "pdfComponent.repeat.collection.hint": "The repeating section's or data grid's id; the row slot is drawn once per entry.",
  "pdfComponent.repeat.emptyText": "Text when empty",
  "pdfComponent.repeat.keepRow": "Keep each entry on one page",
  "pdfComponent.repeat.maxRows": "At most",
  "pdfComponent.box.border": "Border",
  "pdfComponent.box.borderWidth": "Border width (pt)",
  "pdfComponent.box.borderColor": "Border colour",
  "pdfComponent.box.fill": "Fill colour",
  "pdfComponent.box.padding": "Padding (pt)",
  "pdfComponent.box.pin": "Pin to page",
  "pdfComponent.box.pin.hint": "Set a width and height to pin the box at a fixed position instead of flowing.",
  "pdfComponent.box.pinFirst": "First page",
  "pdfComponent.box.pinLast": "Last page",
  "pdfComponent.box.pinEvery": "Every page",
  "pdfComponent.box.x": "X (pt from left)",
  "pdfComponent.box.y": "Y (pt from top)",
  "pdfComponent.width": "Width (pt)",
  "pdfComponent.height": "Height (pt)",
  "pdfComponent.rule.thickness": "Thickness (pt)",
  "pdfComponent.rule.color": "Colour",
  "pdfComponent.image.src": "Image URL",
  "pdfComponent.image.src.hint": "PNG or JPEG. A data: URL embeds the bytes in the layout.",
  "pdfComponent.image.alt": "Alternative text",
  "pdfComponent.signature.fieldName": "Field name",
  "pdfComponent.signature.fieldName.hint": "The AcroForm signature field this block makes; unique across the layout. The layout's \"Signature field\" setting names it for the server to sign into.",
  "pdfComponent.signature.caption": "Caption",
  "pdfComponent.signature.caption.hint": "Printed above the box; {{path}} templates work as in a text block.",
  "pdfComponent.signature.kind": "Kind",
  "pdfComponent.signature.kindField": "Signature field — signed by the server or in a viewer",
  "pdfComponent.signature.kindLine": "Line to sign on — for a pen",
  "pdfComponent.signature.width.hint": "Empty: the column's width.",
  "pdfComponent.pageBreak.changePage": "Change page setup after the break",
  "pdfComponent.face.header": "header",
  "pdfComponent.face.footer": "footer",
  "pdfComponent.face.tableRepeats": "Rows repeat from “{path}”",
  "pdfComponent.face.tableUnbound": "Rows repeat from “{path}” — not a repeating section of the form",
  "pdfComponent.face.repeatEach": "Repeats for each “{path}”",
  "pdfComponent.face.repeatUnbound": "Repeats for each “{path}” — not a repeating section of the form",
  "pdfComponent.face.repeatNone": "Repeat: no collection chosen",
  "pdfComponent.face.boxPinned": "Pinned to page {page} at {x},{y} ({width}×{height} pt)",
  "pdfComponent.face.fieldNone": "No form component chosen",
  "pdfComponent.face.fieldPick": "Pick the form component this prints.",
  "pdfComponent.face.fieldBound": "{label} · {rendition}",
  "pdfComponent.face.fieldMissing": "{id} — not in the form",
  "pdfComponent.face.expression": "expression",
  "pdfComponent.face.imageNone": "Image: no URL yet",
  "pdfComponent.face.imageUnsupported": "Image: unsupported URL",
  "pdfComponent.face.signatureField": "Signature field",
  "pdfComponent.face.pageBreak": "Page break",
  "pdfComponent.face.pageBreakChange": "Page break · page setup changes after it"
} as const;

/** The keys of the words this module shows, in the builder's catalog. */
export type PdfComponentTextKey = keyof typeof PDF_COMPONENT_TEXT_EN;

/** The words for those keys, a `{name}` slot filled from `params`; the builder passes its own catalog's, English when absent. */
export type PdfComponentText = (key: PdfComponentTextKey, params?: Record<string, string | number>) => string;

const englishPdfComponentText: PdfComponentText = (key, params) =>
  PDF_COMPONENT_TEXT_EN[key].replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => (params !== undefined && name in params ? String(params[name]) : whole));

/** What the designer's palette offers; the root is not listed, a layout has exactly one. */
export function pdfComponentTypes(texts: PdfComponentText = englishPdfComponentText): PdfComponentTypeEntry[] {
  return [
    { type: PDF_FIELD_COMPONENT_TYPE, label: texts("pdfComponent.palette.formField"), icon: "▤", group: PDF_PALETTE_GROUP_CONTENT },
    { type: PDF_TEXT_COMPONENT_TYPE, label: texts("pdfComponent.palette.text"), icon: "¶", group: PDF_PALETTE_GROUP_CONTENT },
    { type: PDF_IMAGE_COMPONENT_TYPE, label: texts("pdfComponent.palette.image"), icon: "▨", group: PDF_PALETTE_GROUP_CONTENT },
    { type: PDF_SIGNATURE_COMPONENT_TYPE, label: texts("pdfComponent.palette.signature"), icon: "✎", group: PDF_PALETTE_GROUP_CONTENT },
    { type: PDF_SECTION_COMPONENT_TYPE, label: texts("pdfComponent.palette.section"), icon: "§", group: PDF_PALETTE_GROUP_LAYOUT },
    { type: PDF_TABLE_COMPONENT_TYPE, label: texts("pdfComponent.palette.table"), icon: "▦", group: PDF_PALETTE_GROUP_LAYOUT },
    { type: PDF_REPEAT_COMPONENT_TYPE, label: texts("pdfComponent.palette.repeat"), icon: "⟳", group: PDF_PALETTE_GROUP_LAYOUT },
    { type: PDF_BOX_COMPONENT_TYPE, label: texts("pdfComponent.palette.box"), icon: "▢", group: PDF_PALETTE_GROUP_LAYOUT },
    { type: PDF_RULE_COMPONENT_TYPE, label: texts("pdfComponent.palette.rule"), icon: "—", group: PDF_PALETTE_GROUP_LAYOUT },
    { type: PDF_SPACER_COMPONENT_TYPE, label: texts("pdfComponent.palette.spacer"), icon: "↕", group: PDF_PALETTE_GROUP_LAYOUT },
    { type: PDF_PAGE_BREAK_COMPONENT_TYPE, label: texts("pdfComponent.palette.pageBreak"), icon: "⤓", group: PDF_PALETTE_GROUP_LAYOUT }
  ];
}

/** One of the form's components, as the designer's binding picker lists it. */
export interface PdfBindableComponent {
  id: string;
  label: string;
  type: string;
  /** Has child slots: a panel, tabs, a grid. */
  container: boolean;
}

/** A collection a repeat or a table may draw its rows from. */
export interface PdfBindableCollection {
  path: string;
  label: string;
}

/** A registered `"pdf"`-target theme, as the document's "PDF theme" select offers it. */
export interface PdfThemeOption {
  id: string;
  label: string;
}

/**
 * What the definitions need from the form they lay out: the components a `pdf-field` may
 * bind (for the picker) and the collections a table or a repeat may draw from.
 */
export interface PdfComponentDefinitionOptions {
  formComponents?: readonly PdfBindableComponent[] | undefined;
  collections?: readonly PdfBindableCollection[] | undefined;
  /**
   * The PDF themes the host registered, for the document's "PDF theme" select. Absent or
   * empty, the theme is a free-text id (a host with no registry still authors one).
   */
  pdfThemes?: readonly PdfThemeOption[] | undefined;
  /**
   * The ICC profiles the host offers as PDF/A output conditions, listed under
   * "From the host" beside the kernel's built-in ones on the document's profile picker.
   */
  outputIntentProfiles?: readonly PdfProfileOption[] | undefined;
  /** The words of the document's theme field, in the builder's locale; English when absent. */
  texts?: PdfComponentText | undefined;
}

const PAGE_SIZE_CHOICES = [
  { value: "Letter", label: "Letter" },
  { value: "A4", label: "A4" },
  { value: "Legal", label: "Legal" }
];

function orientationChoices(t: PdfComponentText): PropertyEditorChoice[] {
  return [
    { value: "portrait", label: t("pdfComponent.page.portrait") },
    { value: "landscape", label: t("pdfComponent.page.landscape") }
  ];
}

/** The archival levels a layout may declare; the empty choice is an ordinary PDF. */
export const PDF_A_CHOICES: PropertyEditorChoice[] = [
  { value: "", label: "Off — an ordinary PDF" },
  { value: "2b", label: "PDF/A-2b" },
  { value: "2u", label: "PDF/A-2u (Unicode)" },
  { value: "2a", label: "PDF/A-2a (accessible: Unicode and tagged)" },
  { value: "3b", label: "PDF/A-3b (attachments allowed)" },
  { value: "3u", label: "PDF/A-3u (Unicode, attachments allowed)" },
  { value: "3a", label: "PDF/A-3a (accessible, attachments allowed)" }
];

/** The same levels worded by the builder's catalog; the level ids themselves are standards names. */
function pdfAChoices(t: PdfComponentText): PropertyEditorChoice[] {
  return [
    { value: "", label: t("pdfComponent.pdfa.off") },
    { value: "2b", label: "PDF/A-2b" },
    { value: "2u", label: t("pdfComponent.pdfa.2u") },
    { value: "2a", label: t("pdfComponent.pdfa.2a") },
    { value: "3b", label: t("pdfComponent.pdfa.3b") },
    { value: "3u", label: t("pdfComponent.pdfa.3u") },
    { value: "3a", label: t("pdfComponent.pdfa.3a") }
  ];
}

/** What the output-intent picker offers: ICC profiles by type, and by the extensions a picker sees when the OS reports no type. */
export const PDF_ICC_ACCEPT = "application/vnd.iccprofile,.icc,.icm";

/** The output conditions the profile picker lists ready-made: the kernel's built-ins, then the host's own. */
export function outputIntentProfileChoices(hostProfiles: readonly PdfProfileOption[] = [], t: PdfComponentText = englishPdfComponentText): PropertyEditorAssetChoice[] {
  return [
    ...PDF_BUILTIN_PROFILES.map((profile) => ({ id: `builtin:${profile.id}`, label: profile.label, group: t("pdfComponent.profile.builtIn"), source: builtinProfileSource(profile.id) })),
    ...hostProfiles.map((profile) => ({ id: `host:${profile.id}`, label: profile.label, group: t("pdfComponent.profile.host"), source: profile.source }))
  ];
}

/** Every rendition the engine's own types offer, for the binding picker; a bound type offers a subset. */
export const COMMON_RENDITION_CHOICES: PropertyEditorChoice[] = [
  { value: "", label: "Default — the component's own setting, the theme, then its type" },
  ...PDF_RENDITION_LABELS.filter((rendition) => rendition.id !== "none").map((rendition) => ({ value: rendition.id, label: rendition.label }))
];

/** The same choices with the default's line worded by the builder's catalog; the renditions' names are the engine's catalog (core/schema/pdf-renditions.ts). */
function renditionChoices(t: PdfComponentText): PropertyEditorChoice[] {
  return [{ value: "", label: t("pdfComponent.rendition.default") }, ...COMMON_RENDITION_CHOICES.slice(1)];
}

function number(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "number", propertyPath, label, ...extra };
}

function boolean(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "boolean", propertyPath, label, ...extra };
}

function text(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "text", propertyPath, label, ...extra };
}

function localized(id: string, propertyPath: string, label: string, extra: Partial<PropertyEditorField> = {}): PropertyEditorField {
  return { id, type: "localized-text", propertyPath, label, ...extra };
}

/** The page-setup fields, shared by the document root and a page break's override. */
function pageSetupFields(prefix: string, t: PdfComponentText): PropertyEditorField[] {
  return [
    { id: `${prefix}size`, type: "select", propertyPath: `${prefix}size`, label: t("pdfComponent.page.size"), choices: PAGE_SIZE_CHOICES, defaultValue: "Letter" },
    { id: `${prefix}orientation`, type: "select", propertyPath: `${prefix}orientation`, label: t("pdfComponent.page.orientation"), choices: orientationChoices(t), defaultValue: "portrait" }
  ];
}

// --- Definitions ------------------------------------------------------------------------

/** The document's theme field: a select of the host's PDF themes, or a free id when it lists none. */
function themeField(options: PdfComponentDefinitionOptions): PropertyEditorField {
  const themes = options.pdfThemes ?? [];
  const texts = options.texts ?? englishPdfComponentText;
  if (themes.length === 0) {
    return text("theme", "theme", texts("pdfComponent.theme.idLabel"), { description: texts("pdfComponent.theme.idDescription") });
  }
  return {
    id: "theme",
    type: "select",
    propertyPath: "theme",
    label: texts("pdfComponent.theme.label"),
    description: texts("pdfComponent.theme.description"),
    defaultValue: "",
    choices: [{ value: "", label: texts("pdfComponent.theme.match") }, ...themes.map((theme) => ({ value: theme.id, label: theme.label }))]
  };
}

function documentDefinition(options: PdfComponentDefinitionOptions = {}): ComponentDefinition {
  const t = options.texts ?? englishPdfComponentText;
  return {
    type: PDF_DOCUMENT_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "document",
      type: PDF_DOCUMENT_COMPONENT_TYPE,
      configuration: { page: { size: "Letter", orientation: "portrait" }, accessibility: { tagged: true } },
      children: { [PDF_DOCUMENT_BODY_SLOT]: [], [PDF_DOCUMENT_HEADER_SLOT]: [], [PDF_DOCUMENT_FOOTER_SLOT]: [] }
    }),
    capabilities: [],
    children: {
      slots: [
        { id: PDF_DOCUMENT_BODY_SLOT, multiple: true },
        { id: PDF_DOCUMENT_HEADER_SLOT, multiple: true },
        { id: PDF_DOCUMENT_FOOTER_SLOT, multiple: true }
      ]
    },
    propertyEditor: {
      mode: "replace",
      fields: [
        localized("name", "name", t("pdfComponent.doc.name")),
        ...pageSetupFields("page.", t),
        number("margin-top", "page.margins.top", t("pdfComponent.doc.marginTop"), { min: 0, defaultValue: 54 }),
        number("margin-right", "page.margins.right", t("pdfComponent.doc.marginRight"), { min: 0, defaultValue: 54 }),
        number("margin-bottom", "page.margins.bottom", t("pdfComponent.doc.marginBottom"), { min: 0, defaultValue: 54 }),
        number("margin-left", "page.margins.left", t("pdfComponent.doc.marginLeft"), { min: 0, defaultValue: 54 }),
        number("header-height", "page.header.height", t("pdfComponent.doc.headerHeight"), { min: 0, description: t("pdfComponent.doc.headerHeight.hint") }),
        number("footer-height", "page.footer.height", t("pdfComponent.doc.footerHeight"), { min: 0, description: t("pdfComponent.doc.footerHeight.hint") }),
        boolean("tagged", "accessibility.tagged", t("pdfComponent.doc.tagged"), { defaultValue: true }),
        boolean("displayDocTitle", "accessibility.displayDocTitle", t("pdfComponent.doc.displayTitle"), { defaultValue: true }),
        text("lang", "accessibility.lang", t("pdfComponent.doc.lang"), { description: t("pdfComponent.doc.lang.hint") }),
        localized("title", "accessibility.title", t("pdfComponent.doc.title"), { description: t("pdfComponent.doc.title.hint") }),
        {
          id: "pdfa",
          type: "select",
          propertyPath: "conformance.pdfa",
          label: t("pdfComponent.doc.pdfa"),
          description: t("pdfComponent.doc.pdfa.hint"),
          choices: pdfAChoices(t)
        },
        {
          id: "output-intent-profile",
          type: "file",
          propertyPath: "conformance.outputIntent.profile",
          label: t("pdfComponent.doc.profile"),
          accept: PDF_ICC_ACCEPT,
          assetChoices: outputIntentProfileChoices(options.outputIntentProfiles, t),
          description: t("pdfComponent.doc.profile.hint")
        },
        text("output-intent-identifier", "conformance.outputIntent.identifier", t("pdfComponent.doc.intentId"), { description: t("pdfComponent.doc.intentId.hint") }),
        text("output-intent-info", "conformance.outputIntent.info", t("pdfComponent.doc.intentInfo"), { description: t("pdfComponent.doc.intentInfo.hint") }),
        text("output-intent-registry", "conformance.outputIntent.registry", t("pdfComponent.doc.intentRegistry"), { description: t("pdfComponent.doc.intentRegistry.hint") }),
        boolean("attach-data", "conformance.attachData", t("pdfComponent.doc.attachData"), {
          description: t("pdfComponent.doc.attachData.hint")
        }),
        text("attachment-name", "conformance.attachment.name", t("pdfComponent.doc.attachName"), { description: t("pdfComponent.doc.attachName.hint", { name: DEFAULT_PDF_ATTACHMENT_NAME }) }),
        localized("attachment-description", "conformance.attachment.description", t("pdfComponent.doc.attachDescription"), { description: t("pdfComponent.doc.attachDescription.hint") }),
        number("attachments-budget", "attachments.budgetMb", t("pdfComponent.doc.budget"), {
          min: 0,
          description: t("pdfComponent.doc.budget.hint", { megabytes: DEFAULT_PDF_ATTACHMENT_BUDGET_BYTES / (1024 * 1024) })
        }),
        {
          id: "attachments-on-exceeded",
          type: "select",
          propertyPath: "attachments.onExceeded",
          label: t("pdfComponent.doc.exceeded"),
          description: t("pdfComponent.doc.exceeded.hint"),
          choices: [
            { value: "", label: t("pdfComponent.doc.exceeded.warn") },
            { value: "fail", label: t("pdfComponent.doc.exceeded.fail") }
          ]
        },
        boolean("signature-required", "signature.required", t("pdfComponent.doc.sigRequired"), {
          description: t("pdfComponent.doc.sigRequired.hint")
        }),
        text("signature-field", "signature.field", t("pdfComponent.doc.sigField"), {
          description: t("pdfComponent.doc.sigField.hint")
        }),
        {
          id: "signature-certify",
          type: "select",
          propertyPath: "signature.certify",
          label: t("pdfComponent.doc.certify"),
          description: t("pdfComponent.doc.certify.hint"),
          choices: [
            { value: "", label: t("pdfComponent.doc.certify.approval") },
            { value: "noChanges", label: t("pdfComponent.doc.certify.noChanges") },
            { value: "formFilling", label: t("pdfComponent.doc.certify.formFilling") },
            { value: "annotations", label: t("pdfComponent.doc.certify.annotations") }
          ]
        },
        localized("signature-reason", "signature.reason", t("pdfComponent.doc.sigReason"), { description: t("pdfComponent.doc.sigReason.hint") }),
        {
          id: "signature-commitment-type",
          type: "select",
          propertyPath: "signature.commitment.type",
          label: t("pdfComponent.doc.commitment"),
          description: t("pdfComponent.doc.commitment.hint"),
          choices: [
            { value: "", label: t("pdfComponent.none") },
            { value: "approval", label: t("pdfComponent.doc.commitment.approval") },
            { value: "origin", label: t("pdfComponent.doc.commitment.origin") },
            { value: "receipt", label: t("pdfComponent.doc.commitment.receipt") },
            { value: "delivery", label: t("pdfComponent.doc.commitment.delivery") },
            { value: "sender", label: t("pdfComponent.doc.commitment.sender") },
            { value: "creation", label: t("pdfComponent.doc.commitment.creation") }
          ]
        },
        text("signature-commitment-statement", "signature.commitment.statement", t("pdfComponent.doc.commitmentStatement"), { description: t("pdfComponent.doc.commitmentStatement.hint") }),
        text("signature-location", "signature.location", t("pdfComponent.doc.sigLocation")),
        text("signature-name", "signature.name", t("pdfComponent.doc.sigName"), { description: t("pdfComponent.doc.sigName.hint") }),
        {
          id: "signature-subfilter",
          type: "select",
          propertyPath: "signature.subFilter",
          label: t("pdfComponent.doc.sigProfile"),
          choices: [
            { value: "", label: t("pdfComponent.doc.sigProfile.pades") },
            { value: "adbe.pkcs7.detached", label: t("pdfComponent.doc.sigProfile.adobe") }
          ]
        },
        boolean("signature-timestamp", "signature.timestamp", t("pdfComponent.doc.sigTimestamp"), { description: t("pdfComponent.doc.sigTimestamp.hint") }),
        themeField(options),
        {
          id: "rendition-default",
          type: "select",
          propertyPath: "renditionDefaults.*",
          label: t("pdfComponent.doc.renditionDefault"),
          description: t("pdfComponent.doc.renditionDefault.hint"),
          choices: renditionChoices(t).filter((choice) => ["", "text", "field", "ruled"].includes(choice.value))
        }
      ]
    }
  };
}

function sectionDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_SECTION_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "section",
      type: PDF_SECTION_COMPONENT_TYPE,
      configuration: { label: t("pdfComponent.default.section") },
      children: { content: [] }
    }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: {
      mode: "replace",
      fields: [
        localized("label", "label", t("pdfComponent.section.heading")),
        boolean("hideLabel", "hideLabel", t("pdfComponent.section.hideHeading")),
        boolean("keepTogether", "keepTogether", t("pdfComponent.section.keepTogether"), { description: t("pdfComponent.section.keepTogether.hint") }),
        boolean("skipWhenEmpty", "skipWhenEmpty", t("pdfComponent.skipWhenEmpty"), {
          description: t("pdfComponent.section.skipWhenEmpty.hint")
        })
      ]
    }
  };
}

function fieldDefinition(options: PdfComponentDefinitionOptions): ComponentDefinition {
  const t = options.texts ?? englishPdfComponentText;
  const choices: PropertyEditorChoice[] = (options.formComponents ?? []).map((component) => ({
    value: component.id,
    label: `${component.label} (${component.id})`
  }));
  return {
    type: PDF_FIELD_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "field",
      type: PDF_FIELD_COMPONENT_TYPE,
      configuration: { componentId: "" }
    }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        {
          id: "componentId",
          type: choices.length > 0 ? "select" : "component-selector",
          propertyPath: "componentId",
          label: t("pdfComponent.field.component"),
          ...(choices.length > 0 ? { choices: [{ value: "", label: t("pdfComponent.field.choose") }, ...choices] } : {})
        },
        {
          id: "rendition",
          type: "select",
          propertyPath: "rendition",
          label: t("pdfComponent.field.rendition"),
          description: t("pdfComponent.field.rendition.hint"),
          choices: renditionChoices(t)
        },
        localized("label", "label", t("pdfComponent.field.label"), { description: t("pdfComponent.field.label.hint") }),
        boolean("hideLabel", "hideLabel", t("pdfComponent.field.hideLabel")),
        boolean("attach", "attach", t("pdfComponent.field.attach"), {
          description:
            t("pdfComponent.field.attach.hint")
        }),
        text("widgetName", "widgetName", t("pdfComponent.field.widgetName"), {
          description:
            t("pdfComponent.field.widgetName.hint")
        })
      ]
    }
  };
}

function textDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_TEXT_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "text",
      type: PDF_TEXT_COMPONENT_TYPE,
      configuration: { text: t("pdfComponent.default.text"), variant: "body" }
    }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        localized("text", "text", t("pdfComponent.text.text"), {
          description: t("pdfComponent.text.text.hint")
        }),
        {
          id: "variant",
          type: "select",
          propertyPath: "variant",
          label: t("pdfComponent.text.style"),
          defaultValue: "body",
          choices: [
            { value: "body", label: t("pdfComponent.text.body") },
            { value: "h1", label: t("pdfComponent.text.h1") },
            { value: "h2", label: t("pdfComponent.text.h2") },
            { value: "h3", label: t("pdfComponent.text.h3") },
            { value: "muted", label: t("pdfComponent.text.muted") },
            { value: "label", label: t("pdfComponent.text.label") }
          ]
        },
        {
          id: "align",
          type: "select",
          propertyPath: "align",
          label: t("pdfComponent.text.align"),
          defaultValue: "start",
          choices: [
            { value: "start", label: t("pdfComponent.text.alignStart") },
            { value: "center", label: t("pdfComponent.text.alignCenter") },
            { value: "end", label: t("pdfComponent.text.alignEnd") }
          ]
        },
        {
          id: "expression",
          type: "expression",
          propertyPath: "expression",
          label: t("pdfComponent.text.expression"),
          description:
            t("pdfComponent.text.expression.hint")
        }
      ]
    }
  };
}

function tableDefinition(options: PdfComponentDefinitionOptions): ComponentDefinition {
  const t = options.texts ?? englishPdfComponentText;
  const configuration = { rows: 2, columns: 2, header: true, borders: "all" };
  const collections = options.collections ?? [];
  return {
    type: PDF_TABLE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "table",
      type: PDF_TABLE_COMPONENT_TYPE,
      configuration: { ...configuration },
      children: emptyPdfTableChildren(configuration)
    }),
    capabilities: [],
    // Cells are derived from rows × columns (see `pdfTableSlotIds`), the way a grid's columns are.
    children: { slots: [] },
    propertyEditor: {
      mode: "replace",
      fields: [
        number("rows", "rows", t("pdfComponent.table.rows"), { min: 1, max: 50, step: 1, defaultValue: 2 }),
        number("columns", "columns", t("pdfComponent.table.columns"), { min: 1, max: 12, step: 1, defaultValue: 2 }),
        boolean("header", "header", t("pdfComponent.table.header"), { defaultValue: true, description: t("pdfComponent.table.header.hint") }),
        boolean("skipWhenEmpty", "skipWhenEmpty", t("pdfComponent.skipWhenEmpty"), {
          description: t("pdfComponent.table.skipWhenEmpty.hint")
        }),
        {
          id: "borders",
          type: "select",
          propertyPath: "borders",
          label: t("pdfComponent.table.borders"),
          defaultValue: "all",
          choices: [
            { value: "all", label: t("pdfComponent.table.bordersAll") },
            { value: "horizontal", label: t("pdfComponent.table.bordersHorizontal") },
            { value: "none", label: t("pdfComponent.none") }
          ]
        },
        collections.length > 0
          ? {
              id: "collectionPath",
              type: "select",
              propertyPath: "collectionPath",
              label: t("pdfComponent.table.collection"),
              description: t("pdfComponent.table.collection.hint"),
              choices: [{ value: "", label: t("pdfComponent.table.collectionNone") }, ...collections.map((collection) => ({ value: collection.path, label: collection.label }))]
            }
          : text("collectionPath", "collectionPath", t("pdfComponent.table.collection"), {
              description: t("pdfComponent.table.collection.hintFree")
            })
      ]
    }
  };
}

function repeatDefinition(options: PdfComponentDefinitionOptions): ComponentDefinition {
  const t = options.texts ?? englishPdfComponentText;
  const collections = options.collections ?? [];
  return {
    type: PDF_REPEAT_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "repeat",
      type: PDF_REPEAT_COMPONENT_TYPE,
      configuration: { collectionPath: collections[0]?.path ?? "" },
      children: { row: [] }
    }),
    capabilities: [],
    children: { slots: [{ id: "row", multiple: true }] },
    propertyEditor: {
      mode: "replace",
      fields: [
        collections.length > 0
          ? {
              id: "collectionPath",
              type: "select",
              propertyPath: "collectionPath",
              label: t("pdfComponent.repeat.collection"),
              choices: collections.map((collection) => ({ value: collection.path, label: collection.label }))
            }
          : text("collectionPath", "collectionPath", t("pdfComponent.repeat.collection"), { description: t("pdfComponent.repeat.collection.hint") }),
        localized("emptyText", "emptyText", t("pdfComponent.repeat.emptyText")),
        boolean("keepRowTogether", "keepRowTogether", t("pdfComponent.repeat.keepRow")),
        number("maxRows", "maxRows", t("pdfComponent.repeat.maxRows"), { min: 1, step: 1 })
      ]
    }
  };
}

function boxDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_BOX_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({
      id: "box",
      type: PDF_BOX_COMPONENT_TYPE,
      configuration: { border: true, padding: 6 },
      children: { content: [] }
    }),
    capabilities: [],
    children: { slots: [{ id: "content", multiple: true }] },
    propertyEditor: {
      mode: "replace",
      fields: [
        boolean("border", "border", t("pdfComponent.box.border"), { defaultValue: true }),
        number("borderWidth", "borderWidth", t("pdfComponent.box.borderWidth"), { min: 0, defaultValue: 0.75 }),
        { id: "borderColor", type: "color", propertyPath: "borderColor", label: t("pdfComponent.box.borderColor") },
        { id: "fill", type: "color", propertyPath: "fill", label: t("pdfComponent.box.fill") },
        number("padding", "padding", t("pdfComponent.box.padding"), { min: 0, defaultValue: 6 }),
        boolean("skipWhenEmpty", "skipWhenEmpty", t("pdfComponent.skipWhenEmpty"), {
          description: t("pdfComponent.box.skipWhenEmpty.hint")
        }),
        {
          id: "anchor-page",
          type: "select",
          propertyPath: "anchor.page",
          label: t("pdfComponent.box.pin"),
          description: t("pdfComponent.box.pin.hint"),
          choices: [
            { value: "first", label: t("pdfComponent.box.pinFirst") },
            { value: "last", label: t("pdfComponent.box.pinLast") },
            { value: "every", label: t("pdfComponent.box.pinEvery") }
          ]
        },
        number("anchor-x", "anchor.x", t("pdfComponent.box.x"), { min: 0 }),
        number("anchor-y", "anchor.y", t("pdfComponent.box.y"), { min: 0 }),
        number("anchor-width", "anchor.width", t("pdfComponent.width"), { min: 1 }),
        number("anchor-height", "anchor.height", t("pdfComponent.height"), { min: 1 })
      ]
    }
  };
}

function ruleDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_RULE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({ id: "rule", type: PDF_RULE_COMPONENT_TYPE, configuration: { thickness: 0.75 } }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        number("thickness", "thickness", t("pdfComponent.rule.thickness"), { min: 0.25, defaultValue: 0.75 }),
        { id: "color", type: "color", propertyPath: "color", label: t("pdfComponent.rule.color") }
      ]
    }
  };
}

function spacerDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_SPACER_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({ id: "spacer", type: PDF_SPACER_COMPONENT_TYPE, configuration: { height: 12 } }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [number("height", "height", t("pdfComponent.height"), { min: 1, defaultValue: 12 })]
    }
  };
}

function imageDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_IMAGE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({ id: "image", type: PDF_IMAGE_COMPONENT_TYPE, configuration: { src: "", alt: "" } }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        text("src", "src", t("pdfComponent.image.src"), { description: t("pdfComponent.image.src.hint") }),
        localized("alt", "alt", t("pdfComponent.image.alt")),
        number("width", "width", t("pdfComponent.width"), { min: 1 }),
        number("height", "height", t("pdfComponent.height"), { min: 1 })
      ]
    }
  };
}

function signatureDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_SIGNATURE_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({ id: "signature", type: PDF_SIGNATURE_COMPONENT_TYPE, configuration: { fieldName: "signature", label: t("pdfComponent.default.signature"), mode: "field" } }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        text("fieldName", "fieldName", t("pdfComponent.signature.fieldName"), {
          description: t("pdfComponent.signature.fieldName.hint")
        }),
        localized("label", "label", t("pdfComponent.signature.caption"), { description: t("pdfComponent.signature.caption.hint") }),
        {
          id: "mode",
          type: "select",
          propertyPath: "mode",
          label: t("pdfComponent.signature.kind"),
          choices: [
            { value: "field", label: t("pdfComponent.signature.kindField") },
            { value: "line", label: t("pdfComponent.signature.kindLine") }
          ],
          defaultValue: "field"
        },
        number("width", "width", t("pdfComponent.width"), { min: 8, description: t("pdfComponent.signature.width.hint") }),
        number("height", "height", t("pdfComponent.height"), { min: 8, defaultValue: 40 })
      ]
    }
  };
}

function pageBreakDefinition(t: PdfComponentText): ComponentDefinition {
  return {
    type: PDF_PAGE_BREAK_COMPONENT_TYPE,
    version: "1.0.0",
    createDefault: () => ({ id: "page-break", type: PDF_PAGE_BREAK_COMPONENT_TYPE, configuration: {} }),
    capabilities: [],
    propertyEditor: {
      mode: "replace",
      fields: [
        boolean("changePage", "changePage", t("pdfComponent.pageBreak.changePage")),
        ...pageSetupFields("page.", t)
      ]
    }
  };
}

/** Every PDF layout type's definition, the root included. */
export function pdfComponentDefinitions(options: PdfComponentDefinitionOptions = {}): ComponentDefinition[] {
  const t = options.texts ?? englishPdfComponentText;
  return [
    documentDefinition(options),
    sectionDefinition(t),
    fieldDefinition(options),
    textDefinition(t),
    tableDefinition(options),
    repeatDefinition(options),
    boxDefinition(t),
    ruleDefinition(t),
    spacerDefinition(t),
    imageDefinition(t),
    pageBreakDefinition(t),
    signatureDefinition(t)
  ];
}

/** A fresh, empty generated-layout root. */
export function createEmptyPdfDocumentRoot(id = "document"): ComponentNode {
  const root = documentDefinition().createDefault();
  return { ...root, id };
}
