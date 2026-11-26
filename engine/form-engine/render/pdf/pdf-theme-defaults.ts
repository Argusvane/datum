/**
 * PDF themes: a `PdfThemeDefinition` (`target: "pdf"`) with a
 * `pdf` block — page defaults, typography, colours, the geometry of the paper form (the control
 * box, the choice marks, the field rhythm, headings, tables, boxes, panels, lists, spacing),
 * per-component-type choices and the words a document needs. It registers in the PDF theme
 * registry (pdf-theme-registry.ts), keyed by id. A design-system binding suggests one
 * (`LiveBinding.pdfTheme`); nothing is ever derived from a form look.
 *
 * A PDF theme has no CSS: paper is not styled with stylesheets (rule 20). What it says about a
 * type is a rendition and a style; the rendition ladder in `pdf-renditions.ts` says where
 * that ranks.
 *
 * Two layers of defaults, kept apart on purpose:
 * - what the kernel draws when a document carries no setting at all ({@link PDF_KERNEL_FALLBACKS}):
 *   the constants it always had, so a document from an older engine renders as it did;
 * - what {@link resolvePdfTheme} fills in when a theme says nothing (the `DEFAULT_PDF_*`
 *   values): the engine's form look — a label above a boxed answer, numbered sections on
 *   bands, a title block, uppercase captions — which every registered theme takes unless it
 *   says otherwise.
 * {@link PLAIN_PDF_THEME} spells the fallbacks out as a theme, for a host that wants the
 * earlier, plainer document.
 *
 * Split out of pdf-theme.ts: the defaults and the two shipped themes are what the theme
 * registry registers when the bundle loads, so they stay eager; the merge, scale and selection
 * logic that resolves a theme for a document lives in pdf-theme.ts and loads with the PDF service.
 */
import type { LocalizedText, ThemeAssets, ThemeSource } from "../../core/schema/contracts.js";
import type { PdfAClaim, PdfOutputIntentConfiguration, PdfPageSetup } from "../../core/schema/pdf-layout.js";
import { PDF_BLOCK_KINDS, type PdfBlock, type PdfWarning } from "./pdf-document.js";

export type PdfTextTransform = "none" | "uppercase";

export interface PdfFontSpec {
  family: string;
  /** Points. */
  size: number;
  /** Multiple of `size`. */
  lineHeight?: number;
  /** The shorthand for `weight: 700`; `weight` wins when both are given. */
  bold?: boolean;
  /** CSS weight: 400 regular, 600 semibold, 700 bold. The nearest face the host supplies is used. */
  weight?: number;
  color?: string;
  /**
   * Applied by the kernel before it shapes the text, so measurement and drawing agree. The
   * kernel has no locale-aware casing (QuickJS), so a Turkish dotless i stays as `toUpperCase`
   * leaves it.
   */
  transform?: PdfTextTransform;
}

export interface PdfHeadingTypography {
  family: string;
  /** Point sizes for H1..H6; a missing level takes the last given. */
  sizes: number[];
  /** Line heights per level, multiples of the size; a missing level takes the last given. Default 1.25. */
  lineHeights?: number[];
  color?: string;
  bold?: boolean;
  weight?: number;
}

/**
 * The type roles a document draws with. `body`, `label`, `heading` and `mono` are always
 * resolved; the seven others are optional — a theme that leaves one out gets the kernel's
 * derived look for that role (a hint at body size in the muted colour, an option caption in
 * body type, a legend in label type, and so on), which is the look of a document that
 * sets none of them.
 */
export interface PdfTypography {
  body: PdfFontSpec;
  label: PdfFontSpec;
  heading: PdfHeadingTypography;
  mono?: PdfFontSpec;
  /** A field's hint. */
  hint?: PdfFontSpec;
  /** A choice option's caption. */
  option?: PdfFontSpec;
  /** A choice group's caption. */
  legend?: PdfFontSpec;
  /** The required marker after a label. */
  required?: PdfFontSpec;
  /** The `muted` text variant and the running footer's page numbers. */
  small?: PdfFontSpec;
  /** A field's prefix / suffix. */
  affix?: PdfFontSpec;
  /** The "Step 1 of 3" line above a step heading. */
  stepTag?: PdfFontSpec;
  /**
   * Font family per Unicode script (`Arab`, `Hebr`, `Hani`, …) when the main family lacks the
   * glyphs. The kernel itemizes text by script and picks the fallback per run.
   */
  fallbacks?: Record<string, string>;
}

/** The roles a theme may leave out (the kernel then derives their look) or take away with `null`. */
export type OptionalTypeRole = "hint" | "option" | "legend" | "required" | "small" | "affix" | "stepTag";

/** A settings block as a theme may write it: every field optional, `null` for "the base's value" (or nothing, for an optional field). */
type Nullable<T> = { [K in keyof T]?: T[K] | null };

/**
 * What a theme may say about its typography: any role, any field; `null` on a field leaves
 * it out (a plain theme takes the form look's `transform` off a label that way), `null` on
 * an optional role takes the role away.
 */
export interface PdfTypographySettings {
  body?: Nullable<PdfFontSpec>;
  label?: Nullable<PdfFontSpec>;
  heading?: Nullable<PdfHeadingTypography>;
  mono?: Nullable<PdfFontSpec>;
  hint?: Nullable<PdfFontSpec> | null;
  option?: Nullable<PdfFontSpec> | null;
  legend?: Nullable<PdfFontSpec> | null;
  required?: Nullable<PdfFontSpec> | null;
  small?: Nullable<PdfFontSpec> | null;
  affix?: Nullable<PdfFontSpec> | null;
  stepTag?: Nullable<PdfFontSpec> | null;
  fallbacks?: Record<string, string>;
}

export interface PdfThemeColors {
  text: string;
  muted: string;
  border: string;
  accent: string;
  /** Fill behind a table header row and a box that asks for the theme's fill. */
  surface: string;
  /** The control box's border; absent: `border`. */
  controlBorder?: string;
  /** The control box's fill; absent: white. */
  controlFill?: string;
  /** A checked radio's dot; absent: `text`. */
  choiceMark?: string;
  /** A link in authored content; absent: `accent`. */
  link?: string;
  /** Heading text on an `accent` band; absent: white. */
  onAccent?: string;
}

export type ResolvedPdfThemeColors = Required<PdfThemeColors>;

/** The box a value is drawn in (the `text` rendition under a theme that frames) and a widget takes its geometry from. */
export interface PdfControlSettings {
  borderWidth: number;
  radius: number;
  padding: number;
  minHeight: number;
  /** A textarea's rows (its frame and multiline widget); absent: the kernel's 56pt widget, a one-row frame. */
  textareaRows?: number;
  /** The widget appearance's font size; absent: the viewer's automatic size. */
  fontSize?: number;
  /** The widest a frame or widget grows, in points; absent: the column. */
  maxWidth?: number;
  /** Whether the `text` rendition draws the box around the answer. */
  valueFrame: "none" | "box";
  /** A select's mark inside its frame. */
  selectMark: "none" | "chevron";
}

/** The drawn check box / radio and the AcroForm choice widgets. */
export interface PdfChoiceSettings {
  /** The drawn box's side. */
  size: number;
  /** The AcroForm check box / radio widget's side. */
  widgetSize: number;
  borderWidth: number;
  /** The check box's corner radius; a radio is always a circle. */
  radius: number;
  /** The tick's stroke width. */
  markStroke: number;
  /** The radio dot's diameter; absent: 45% of the box. */
  dotSize?: number;
  /** Box → caption. */
  labelGap: number;
  /** Between options. */
  optionGap: number;
  /** A choice group's caption → its first option. */
  legendGap: number;
  /** Options laid out in this many equal columns, row by row. */
  columns: number;
}

/** The rhythm inside one field. */
export interface PdfFieldSettings {
  /** Label → a value drawn as text. */
  labelToValue: number;
  /** Label → a widget. */
  labelToControl: number;
  labelToHint: number;
  hintToControl: number;
  hints: "hidden" | "shown";
  hintPosition: "afterLabel" | "afterControl";
  /** A label column for the `inline` arrangement and a widget's `before` label: points, or a fraction of the column. */
  inlineLabelWidth?: number | { fraction: number };
}

export interface PdfHeadingSettings {
  /** Section headings count "1", "2", nested "1.1". */
  numbered: boolean;
  /** A filled strip behind section headings: the surface with the heading colour, or the accent with `onAccent`. */
  band: "none" | "surface" | "accent";
  bandPadding: number;
  /** A rule under a level-1 heading (the document title). */
  titleRule: boolean;
  titleRuleWidth: number;
}

export interface PdfTableSettings {
  cellPadding: number;
  borderWidth: number;
  rowMinHeight: number;
  /** Behind the header row; absent: `surface`. */
  headerFill?: string;
  headerWeight: number;
  /** Behind every second body row; absent: none. */
  stripeFill?: string;
}

/** What a `pdf-box` draws when the node says nothing. */
export interface PdfBoxSettings {
  borderWidth: number;
  padding: number;
  radius: number;
  fill?: string;
}

/** The `panel` rendition: a titled box. */
export interface PdfPanelSettings {
  borderWidth: number;
  /** Absent: `border`. */
  borderColor?: string;
  radius: number;
  padding: number;
  fill?: string;
  /** Behind the title band; absent: `surface`. */
  headerFill?: string;
  headerPadding: number;
}

/** Lists from authored content. */
export interface PdfListSettings {
  /** The hanging indent the text takes. */
  indent: number;
  /** Between items. */
  gap: number;
  bullet: string;
}

/** Points of space before and after a block kind; a kind left out keeps the kernel's own. */
export type PdfSpacingTable = Partial<Record<PdfBlock["kind"], [number, number]>>;

/** How a rendition of one component type is drawn under this theme. */
export interface PdfComponentStyle {
  spacingBefore?: number;
  spacingAfter?: number;
  /** For label + value renditions. */
  labelArrangement?: "stacked" | "inline";
  /** Rules to draw for the `ruled` rendition. */
  ruledLines?: number;
  /** Widget height in points for the `field` rendition. */
  widgetHeight?: number;
  /** Frame / widget width in points, for a short field (a date, a postal code). */
  width?: number;
  color?: string;
  size?: number;
}

export interface PdfThemeComponentChoice {
  rendition?: string;
  style?: PdfComponentStyle;
}

/**
 * The words a PDF needs that no field supplies: a checkbox's yes/no, an empty value's dash,
 * the required marker (`""` draws none, as the HTML engine reads empty wording), the step
 * tag (`""` draws none).
 */
export interface PdfThemeTexts {
  yes?: LocalizedText;
  no?: LocalizedText;
  empty?: LocalizedText;
  pageOf?: LocalizedText;
  required?: LocalizedText;
  stepOf?: LocalizedText;
  /** The attached submission data's description in the reader's attachment pane, when the layout words none. */
  attachmentDescription?: LocalizedText;
  /** The alt text of an unlabelled signature image in the tagged PDF. */
  signatureAlt?: LocalizedText;
}

export interface PdfThemeSettings {
  /**
   * Multiplies every point size and gap the theme states — type sizes, geometry, spacing, the
   * per-type styles — at resolve time. Page margins, line-height ratios, row and column counts
   * and fractions are not scaled. A host prints a screen-scale theme smaller with `scale: 0.8`.
   */
  scale?: number;
  page?: Partial<PdfPageSetup>;
  typography?: PdfTypographySettings;
  colors?: Partial<PdfThemeColors>;
  /** Keyed by component type; `"*"` is the wildcard rung of the rendition ladder. */
  components?: Record<string, PdfThemeComponentChoice>;
  texts?: PdfThemeTexts;
  controls?: Nullable<PdfControlSettings>;
  choice?: Nullable<PdfChoiceSettings>;
  fields?: Nullable<PdfFieldSettings>;
  headings?: Nullable<PdfHeadingSettings>;
  table?: Nullable<PdfTableSettings>;
  box?: Nullable<PdfBoxSettings>;
  panel?: Nullable<PdfPanelSettings>;
  list?: Nullable<PdfListSettings>;
  /** Overrides per block kind; `null` for a kind keeps the kernel's own pair. */
  spacing?: { [K in PdfBlock["kind"]]?: [number, number] | null };
  /** Whether documents under this theme are tagged unless the layout says otherwise. */
  tagged?: boolean;
  /** The PDF/A level documents under this theme declare unless the layout says otherwise. */
  pdfa?: PdfAClaim;
  /** The output condition PDF/A documents under this theme declare unless the layout names one. */
  outputIntent?: PdfOutputIntentConfiguration;
}

/**
 * A theme for the generated PDF: what it says about the paper (`pdf`), the faces it ships
 * (`assets.fonts`) and how a picker names it. It registers in a {@link PdfThemeRegistry} of its
 * own, keyed by id.
 */
export interface PdfThemeDefinition {
  id: string;
  version: string;
  target: "pdf";
  /**
   * The id of a registered PDF theme this one builds on. The registry resolves it at
   * registration (the base must already be registered) and stores the merged definition: each
   * field this theme sets (its whole `pdf` block included) over the base's.
   */
  extends?: string;
  /** How a picker names the theme; the id stands in when absent. */
  label?: LocalizedText;
  /** Never set: paper is not styled with stylesheets. */
  css?: never;
  /** The faces the kernel embeds for the families `pdf.typography` names (`assets.fonts`). */
  assets?: ThemeAssets;
  /** The design system the theme was read from. */
  source?: ThemeSource;
  pdf?: PdfThemeSettings;
}

export const DEFAULT_PDF_THEME_ID = "datum-pdf";
export const PLAIN_PDF_THEME_ID = "datum-plain";

// --- The kernel's fallbacks: what a document without a setting draws ---------------------------

/**
 * What the kernel draws when a document says nothing — the constants it always had. The
 * kernel reads these (so the two cannot drift), and {@link PLAIN_PDF_THEME} states them as a
 * theme. Not the engine's defaults: those are the form look below.
 */
export const PDF_KERNEL_FALLBACKS = {
  typography: {
    body: { family: "sans-serif", size: 10, lineHeight: 1.35 },
    label: { family: "sans-serif", size: 8, lineHeight: 1.3, bold: true, color: "#555555" },
    heading: { family: "sans-serif", sizes: [18, 14, 12, 11, 10, 10], bold: true },
    mono: { family: "monospace", size: 9, lineHeight: 1.35 }
  } satisfies PdfTypography as PdfTypography,
  colors: { text: "#111111", muted: "#555555", border: "#999999", accent: "#1a4480", surface: "#f2f2f2" } satisfies PdfThemeColors as PdfThemeColors,
  controls: { borderWidth: 0.5, radius: 0, padding: 0, minHeight: 20, valueFrame: "none", selectMark: "none" } satisfies PdfControlSettings as PdfControlSettings,
  choice: { size: 9, widgetSize: 12, borderWidth: 0.75, radius: 0, markStroke: 1.2, labelGap: 5, optionGap: 2, legendGap: 2, columns: 1 } satisfies PdfChoiceSettings as PdfChoiceSettings,
  fields: { labelToValue: 1.5, labelToControl: 2, labelToHint: 1.5, hintToControl: 3, hints: "hidden", hintPosition: "afterLabel" } satisfies PdfFieldSettings as PdfFieldSettings,
  headings: { numbered: false, band: "none", bandPadding: 3, titleRule: false, titleRuleWidth: 1 } satisfies PdfHeadingSettings as PdfHeadingSettings,
  table: { cellPadding: 4, borderWidth: 0.5, rowMinHeight: 12, headerWeight: 700 } satisfies PdfTableSettings as PdfTableSettings,
  box: { borderWidth: 0.75, padding: 6, radius: 0 } satisfies PdfBoxSettings as PdfBoxSettings,
  panel: { borderWidth: 0.75, radius: 0, padding: 6, headerPadding: 6 } satisfies PdfPanelSettings as PdfPanelSettings,
  list: { indent: 12, gap: 2, bullet: "•" } satisfies PdfListSettings as PdfListSettings,
  /** Every kind: the table the kernel had, the `list` kind spaced like a paragraph. */
  spacing: {
    heading: [10, 4],
    paragraph: [0, 4],
    labelValue: [0, 6],
    widget: [0, 6],
    checkmark: [0, 3],
    checklist: [0, 6],
    list: [0, 4],
    table: [2, 8],
    image: [2, 6],
    rule: [4, 4],
    spacer: [0, 0],
    box: [2, 6],
    group: [0, 0],
    pageBreak: [0, 0]
  } satisfies Record<PdfBlock["kind"], [number, number]> as Record<PdfBlock["kind"], [number, number]>
};

// --- The engine's defaults: the form look --------------------------------------------------------

const SANS = "sans-serif";

/** The form look's type: a 10pt body, uppercase 8pt captions, bold headings. */
export const DEFAULT_PDF_TYPOGRAPHY: PdfTypography = {
  body: { family: SANS, size: 10, lineHeight: 1.3 },
  label: { family: SANS, size: 8, lineHeight: 1.3, weight: 700, transform: "uppercase" },
  heading: { family: SANS, sizes: [16, 11, 10, 10, 10, 10], lineHeights: [1.25, 1.3, 1.3, 1.3, 1.3, 1.3], weight: 700 },
  mono: { family: "monospace", size: 9, lineHeight: 1.3 },
  hint: { family: SANS, size: 8, lineHeight: 1.3, weight: 400 },
  option: { family: SANS, size: 10, lineHeight: 1.3, weight: 400 },
  legend: { family: SANS, size: 8, lineHeight: 1.3, weight: 700, transform: "uppercase" },
  required: { family: SANS, size: 8, lineHeight: 1.3, weight: 400 },
  small: { family: SANS, size: 8, lineHeight: 1.3, weight: 400 },
  affix: { family: SANS, size: 10, lineHeight: 1.3, weight: 400 },
  stepTag: { family: SANS, size: 8, lineHeight: 1.3, weight: 700 }
};

export const DEFAULT_PDF_COLORS: PdfThemeColors = PDF_KERNEL_FALLBACKS.colors;

export const DEFAULT_PDF_CONTROLS: PdfControlSettings = {
  borderWidth: 0.75,
  radius: 2,
  padding: 4,
  minHeight: 22,
  textareaRows: 3,
  fontSize: 10,
  valueFrame: "box",
  selectMark: "chevron"
};

export const DEFAULT_PDF_CHOICE: PdfChoiceSettings = {
  size: 11,
  widgetSize: 11,
  borderWidth: 0.75,
  radius: 2,
  markStroke: 1.5,
  dotSize: 5,
  labelGap: 5,
  optionGap: 4,
  legendGap: 3,
  columns: 1
};

export const DEFAULT_PDF_FIELDS: PdfFieldSettings = {
  labelToValue: 2,
  labelToControl: 2,
  labelToHint: 1,
  hintToControl: 3,
  hints: "shown",
  hintPosition: "afterLabel"
};

export const DEFAULT_PDF_HEADINGS: PdfHeadingSettings = { numbered: true, band: "surface", bandPadding: 3, titleRule: true, titleRuleWidth: 1 };

export const DEFAULT_PDF_TABLE: PdfTableSettings = { cellPadding: 4, borderWidth: 0.5, rowMinHeight: 12, headerWeight: 700 };

export const DEFAULT_PDF_BOX: PdfBoxSettings = { borderWidth: 0.75, padding: 6, radius: 2 };

export const DEFAULT_PDF_PANEL: PdfPanelSettings = { borderWidth: 0.75, radius: 2, padding: 6, headerPadding: 4 };

export const DEFAULT_PDF_LIST: PdfListSettings = { indent: 12, gap: 2, bullet: "•" };

/**
 * The form look's per-type choices: a radio prints every option with the chosen one marked,
 * as the form shows it, rather than the chosen caption alone. A theme's own entries merge
 * over these; an empty entry (`radio: {}`) hands the type back to its catalog default.
 */
export const DEFAULT_PDF_COMPONENTS: Record<string, PdfThemeComponentChoice> = { radio: { rendition: "checklist" } };

/** The form look's rhythm: 8pt between fields, headings led by 12pt. */
export const DEFAULT_PDF_SPACING: Record<PdfBlock["kind"], [number, number]> = {
  heading: [12, 6],
  paragraph: [0, 4],
  labelValue: [0, 8],
  widget: [0, 8],
  checkmark: [0, 8],
  checklist: [0, 8],
  list: [0, 4],
  table: [2, 8],
  image: [2, 6],
  rule: [4, 4],
  spacer: [0, 0],
  box: [2, 8],
  group: [0, 0],
  pageBreak: [0, 0]
};

/** The required marker is the HTML engine's default (`form-texts.ts`), so a form and its PDF agree. */
export const DEFAULT_PDF_TEXTS: Required<PdfThemeTexts> = {
  yes: "Yes",
  no: "No",
  empty: "—",
  pageOf: "Page {{page}} of {{pages}}",
  required: "*",
  stepOf: "Step {{n}} of {{total}}",
  attachmentDescription: "Submission data",
  signatureAlt: "Signature"
};

/**
 * The engine's own PDF theme: what a form renders under when the host registers none — the
 * form look at print size. Its control border is a step darker than its panel grey, as the
 * HTML engine borders its inputs.
 */
export const DEFAULT_PDF_THEME: PdfThemeDefinition = {
  id: DEFAULT_PDF_THEME_ID,
  version: "2.0.0",
  target: "pdf",
  label: "Datum (default)",
  pdf: {
    typography: DEFAULT_PDF_TYPOGRAPHY,
    colors: { ...DEFAULT_PDF_COLORS, controlBorder: "#555555" },
    controls: DEFAULT_PDF_CONTROLS,
    choice: DEFAULT_PDF_CHOICE,
    fields: DEFAULT_PDF_FIELDS,
    headings: DEFAULT_PDF_HEADINGS,
    table: DEFAULT_PDF_TABLE,
    box: DEFAULT_PDF_BOX,
    panel: DEFAULT_PDF_PANEL,
    list: DEFAULT_PDF_LIST,
    spacing: DEFAULT_PDF_SPACING,
    texts: DEFAULT_PDF_TEXTS,
    components: DEFAULT_PDF_COMPONENTS
  }
};

/**
 * The plain document: the kernel's fallbacks as a
 * theme — no frame, no bands, no numbering, no captions in capitals, hints and markers left
 * out. A host that wants the plain record registers this beside the default.
 */
export const PLAIN_PDF_THEME: PdfThemeDefinition = {
  id: PLAIN_PDF_THEME_ID,
  version: "1.0.0",
  target: "pdf",
  label: "Datum (plain)",
  pdf: {
    typography: {
      body: PDF_KERNEL_FALLBACKS.typography.body,
      // The form look's weight, capitals and per-level leading taken off in so many words.
      label: { ...PDF_KERNEL_FALLBACKS.typography.label, weight: null, transform: null },
      heading: { ...PDF_KERNEL_FALLBACKS.typography.heading, lineHeights: null, weight: null },
      mono: { family: "monospace", size: 9, lineHeight: 1.35 },
      hint: null,
      option: null,
      legend: null,
      required: null,
      small: null,
      affix: null,
      stepTag: null
    },
    colors: PDF_KERNEL_FALLBACKS.colors,
    // An optional field the fallbacks leave out must be taken away in so many words (`null`), or the form look's value fills it.
    controls: { ...PDF_KERNEL_FALLBACKS.controls, textareaRows: null, fontSize: null, maxWidth: null },
    choice: { ...PDF_KERNEL_FALLBACKS.choice, dotSize: null },
    fields: { ...PDF_KERNEL_FALLBACKS.fields, inlineLabelWidth: null },
    headings: PDF_KERNEL_FALLBACKS.headings,
    table: { ...PDF_KERNEL_FALLBACKS.table, headerFill: null, stripeFill: null },
    box: { ...PDF_KERNEL_FALLBACKS.box, fill: null },
    panel: { ...PDF_KERNEL_FALLBACKS.panel, borderColor: null, fill: null, headerFill: null },
    list: PDF_KERNEL_FALLBACKS.list,
    spacing: PDF_KERNEL_FALLBACKS.spacing,
    texts: { ...DEFAULT_PDF_TEXTS, required: "", stepOf: "" },
    // Every type back on its catalog default: a radio as the chosen caption.
    components: { radio: {} }
  }
};

/** A PDF theme with every choice made. */
export interface ResolvedPdfTheme {
  id: string;
  page: Partial<PdfPageSetup> | undefined;
  typography: PdfTypography;
  colors: ResolvedPdfThemeColors;
  controls: PdfControlSettings;
  choice: PdfChoiceSettings;
  fields: PdfFieldSettings;
  headings: PdfHeadingSettings;
  table: PdfTableSettings;
  box: PdfBoxSettings;
  panel: PdfPanelSettings;
  list: PdfListSettings;
  spacing: PdfSpacingTable;
  components: Record<string, PdfThemeComponentChoice>;
  texts: Required<PdfThemeTexts>;
  tagged: boolean | undefined;
  pdfa: PdfAClaim | undefined;
  outputIntent: PdfOutputIntentConfiguration | undefined;
}

/** Whether a value is a PDF theme: anything that names another target (`"builder"`, a form look from a plain-JS host) is not. */
export function isPdfTheme(theme: { readonly target?: string } | undefined): theme is PdfThemeDefinition {
  return !!theme && theme.target === "pdf";
}

// --- Reading what a theme says ----------------------------------------------------------------

