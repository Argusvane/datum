/**
 * PDF themes: a `PdfThemeDefinition` (`target: "pdf"`) with a
 * `pdf` block — page defaults, typography, colours, the geometry of the paper form (the control
 * box, the choice marks, the field rhythm, headings, tables, boxes, panels, lists, spacing),
 * per-component-type choices and the words a document needs. It registers in the PDF theme
 * registry (pdf-theme-registry.ts), keyed by id. Nothing is derived from a form look: a design
 * system's binding suggests a PDF theme, and a host registers it.
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
 * The defaults and shipped themes are in pdf-theme-defaults.ts and the
 * PDF theme registry and the id lookup in pdf-theme-registry.ts, both re-exported below; what is
 * left here (the merge, the scale, the faces a theme ships, `resolvePdfTheme`, `selectPdfTheme`)
 * is the resolution a document render needs, and loads with the PDF service.
 */
import type { LocalizedText, ThemeFontFace } from "../../core/schema/contracts.js";
import {
  resolvePdfConformance,
  resolvePdfOutputIntentConfiguration,
  type PdfAClaim,
  type PdfOutputIntentConfiguration,
  type PdfPageSetup
} from "../../core/schema/pdf-layout.js";
import { PDF_BLOCK_KINDS, type PdfBlock, type PdfWarning } from "./pdf-document.js";
import type { PdfThemeLookup } from "./pdf-theme-registry.js";
import {
  DEFAULT_PDF_BOX,
  DEFAULT_PDF_CHOICE,
  DEFAULT_PDF_COLORS,
  DEFAULT_PDF_COMPONENTS,
  DEFAULT_PDF_CONTROLS,
  DEFAULT_PDF_FIELDS,
  DEFAULT_PDF_HEADINGS,
  DEFAULT_PDF_LIST,
  DEFAULT_PDF_PANEL,
  DEFAULT_PDF_SPACING,
  DEFAULT_PDF_TABLE,
  DEFAULT_PDF_TEXTS,
  DEFAULT_PDF_THEME,
  DEFAULT_PDF_THEME_ID,
  DEFAULT_PDF_TYPOGRAPHY,
  PDF_KERNEL_FALLBACKS,
  PLAIN_PDF_THEME,
  PLAIN_PDF_THEME_ID,
  isPdfTheme,
  type OptionalTypeRole,
  type PdfBoxSettings,
  type PdfChoiceSettings,
  type PdfComponentStyle,
  type PdfControlSettings,
  type PdfFieldSettings,
  type PdfFontSpec,
  type PdfHeadingSettings,
  type PdfListSettings,
  type PdfPanelSettings,
  type PdfSpacingTable,
  type PdfTableSettings,
  type PdfThemeColors,
  type PdfThemeComponentChoice,
  type PdfThemeDefinition,
  type PdfThemeSettings,
  type PdfThemeTexts,
  type PdfTypography,
  type PdfTypographySettings,
  type PdfTextTransform,
  type ResolvedPdfTheme,
  type ResolvedPdfThemeColors
} from "./pdf-theme-defaults.js";

export * from "./pdf-theme-defaults.js";
export * from "./pdf-theme-registry.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function positive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function nonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : undefined;
}

function color(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** A required field: the theme's valid value, else the base's. */
function pick<T>(parsed: T | undefined, base: T): T {
  return parsed !== undefined ? parsed : base;
}

/**
 * An optional field: `null` takes it away, a valid value sets it, anything else keeps the
 * base's. Spread the result so an absent field stays absent.
 */
function optional<K extends string, T>(key: K, given: unknown, parsed: T | undefined, base: T | undefined): { [P in K]?: T } {
  if (given === null) {
    return {};
  }
  const value = parsed !== undefined ? parsed : base;
  return value !== undefined ? ({ [key]: value } as { [P in K]?: T }) : {};
}

function mergeFontSpec(base: PdfFontSpec, over: unknown): PdfFontSpec {
  if (!isRecord(over)) {
    return { ...base };
  }
  return {
    family: typeof over.family === "string" && over.family !== "" ? over.family : base.family,
    size: pick(positive(over.size), base.size),
    ...optional("lineHeight", over.lineHeight, positive(over.lineHeight), base.lineHeight),
    ...optional("bold", over.bold, typeof over.bold === "boolean" ? over.bold : undefined, base.bold),
    ...optional("weight", over.weight, positive(over.weight), base.weight),
    ...optional("color", over.color, color(over.color), base.color),
    ...optional("transform", over.transform, oneOf(over.transform, ["none", "uppercase"] as const), base.transform)
  };
}

/** An optional role: `null` takes it away; a partial merges over the base, whose family follows the theme's own. */
function mergeOptionalFontSpec(base: PdfFontSpec, family: string, over: unknown): PdfFontSpec | undefined {
  if (over === null) {
    return undefined;
  }
  return mergeFontSpec({ ...base, family }, over);
}

function mergeTypography(over: PdfTypographySettings | undefined): PdfTypography {
  const base = DEFAULT_PDF_TYPOGRAPHY;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  const heading: Record<string, unknown> = isRecord(given.heading) ? given.heading : {};
  const levels = (value: unknown, fallback: number[]): number[] =>
    Array.isArray(value) && value.length > 0 && value.every((entry: unknown) => positive(entry) !== undefined) ? [...(value as number[])] : [...fallback];
  const body = mergeFontSpec(base.body, given.body);
  const label = mergeFontSpec(base.label, given.label);
  const typography: PdfTypography = {
    body,
    label,
    heading: {
      family: typeof heading.family === "string" && heading.family !== "" ? heading.family : base.heading.family,
      sizes: levels(heading.sizes, base.heading.sizes),
      ...optional("lineHeights", heading.lineHeights, Array.isArray(heading.lineHeights) ? levels(heading.lineHeights, base.heading.lineHeights ?? [1.25]) : undefined, base.heading.lineHeights),
      ...optional("bold", heading.bold, typeof heading.bold === "boolean" ? heading.bold : undefined, base.heading.bold),
      ...optional("weight", heading.weight, positive(heading.weight), base.heading.weight),
      ...optional("color", heading.color, color(heading.color), base.heading.color)
    },
    mono: mergeFontSpec(base.mono!, given.mono)
  };
  // The optional roles: absent takes the form look's spec in the theme's own body (or label)
  // family, a partial merges over it, `null` leaves the role to the kernel's derived look.
  const roles: Array<[OptionalTypeRole, string]> = [
    ["hint", body.family],
    ["option", body.family],
    ["legend", label.family],
    ["required", label.family],
    ["small", body.family],
    ["affix", body.family],
    ["stepTag", body.family]
  ];
  for (const [role, family] of roles) {
    const spec = mergeOptionalFontSpec(base[role] as PdfFontSpec, family, given[role]);
    if (spec) {
      typography[role] = spec;
    }
  }
  if (isRecord(given.fallbacks)) {
    const fallbacks = Object.fromEntries(
      Object.entries(given.fallbacks).filter((entry): entry is [string, string] => typeof entry[1] === "string")
    );
    if (Object.keys(fallbacks).length > 0) {
      typography.fallbacks = fallbacks;
    }
  }
  return typography;
}

function mergeColors(over: unknown): ResolvedPdfThemeColors {
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  const five: PdfThemeColors = { ...DEFAULT_PDF_COLORS };
  for (const key of ["text", "muted", "border", "accent", "surface"] as const) {
    const value = color(given[key]);
    if (value !== undefined) {
      five[key] = value;
    }
  }
  return {
    ...five,
    controlBorder: color(given.controlBorder) ?? five.border,
    controlFill: color(given.controlFill) ?? "#ffffff",
    choiceMark: color(given.choiceMark) ?? five.text,
    link: color(given.link) ?? five.accent,
    onAccent: color(given.onAccent) ?? "#ffffff"
  };
}

function mergeControls(over: unknown): PdfControlSettings {
  const base = DEFAULT_PDF_CONTROLS;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    borderWidth: pick(nonNegative(given.borderWidth), base.borderWidth),
    radius: pick(nonNegative(given.radius), base.radius),
    padding: pick(nonNegative(given.padding), base.padding),
    minHeight: pick(positive(given.minHeight), base.minHeight),
    ...optional("textareaRows", given.textareaRows, positiveInteger(given.textareaRows), base.textareaRows),
    ...optional("fontSize", given.fontSize, positive(given.fontSize), base.fontSize),
    ...optional("maxWidth", given.maxWidth, positive(given.maxWidth), base.maxWidth),
    valueFrame: pick(oneOf(given.valueFrame, ["none", "box"] as const), base.valueFrame),
    selectMark: pick(oneOf(given.selectMark, ["none", "chevron"] as const), base.selectMark)
  };
}

function mergeChoice(over: unknown): PdfChoiceSettings {
  const base = DEFAULT_PDF_CHOICE;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    size: pick(positive(given.size), base.size),
    widgetSize: pick(positive(given.widgetSize), base.widgetSize),
    borderWidth: pick(nonNegative(given.borderWidth), base.borderWidth),
    radius: pick(nonNegative(given.radius), base.radius),
    markStroke: pick(positive(given.markStroke), base.markStroke),
    ...optional("dotSize", given.dotSize, positive(given.dotSize), base.dotSize),
    labelGap: pick(nonNegative(given.labelGap), base.labelGap),
    optionGap: pick(nonNegative(given.optionGap), base.optionGap),
    legendGap: pick(nonNegative(given.legendGap), base.legendGap),
    columns: pick(positiveInteger(given.columns), base.columns)
  };
}

function mergeFields(over: unknown): PdfFieldSettings {
  const base = DEFAULT_PDF_FIELDS;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  const width = given.inlineLabelWidth;
  const inlineLabelWidth =
    positive(width) ??
    (isRecord(width) && positive(width.fraction) !== undefined && (width.fraction as number) < 1 ? { fraction: width.fraction as number } : undefined);
  return {
    labelToValue: pick(nonNegative(given.labelToValue), base.labelToValue),
    labelToControl: pick(nonNegative(given.labelToControl), base.labelToControl),
    labelToHint: pick(nonNegative(given.labelToHint), base.labelToHint),
    hintToControl: pick(nonNegative(given.hintToControl), base.hintToControl),
    hints: pick(oneOf(given.hints, ["hidden", "shown"] as const), base.hints),
    hintPosition: pick(oneOf(given.hintPosition, ["afterLabel", "afterControl"] as const), base.hintPosition),
    ...optional("inlineLabelWidth", width, inlineLabelWidth, base.inlineLabelWidth)
  };
}

function mergeHeadings(over: unknown): PdfHeadingSettings {
  const base = DEFAULT_PDF_HEADINGS;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    numbered: pick(typeof given.numbered === "boolean" ? given.numbered : undefined, base.numbered),
    band: pick(oneOf(given.band, ["none", "surface", "accent"] as const), base.band),
    bandPadding: pick(nonNegative(given.bandPadding), base.bandPadding),
    titleRule: pick(typeof given.titleRule === "boolean" ? given.titleRule : undefined, base.titleRule),
    titleRuleWidth: pick(positive(given.titleRuleWidth), base.titleRuleWidth)
  };
}

function mergeTable(over: unknown): PdfTableSettings {
  const base = DEFAULT_PDF_TABLE;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    cellPadding: pick(nonNegative(given.cellPadding), base.cellPadding),
    borderWidth: pick(nonNegative(given.borderWidth), base.borderWidth),
    rowMinHeight: pick(nonNegative(given.rowMinHeight), base.rowMinHeight),
    ...optional("headerFill", given.headerFill, color(given.headerFill), base.headerFill),
    headerWeight: pick(positive(given.headerWeight), base.headerWeight),
    ...optional("stripeFill", given.stripeFill, color(given.stripeFill), base.stripeFill)
  };
}

function mergeBox(over: unknown): PdfBoxSettings {
  const base = DEFAULT_PDF_BOX;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    borderWidth: pick(nonNegative(given.borderWidth), base.borderWidth),
    padding: pick(nonNegative(given.padding), base.padding),
    radius: pick(nonNegative(given.radius), base.radius),
    ...optional("fill", given.fill, color(given.fill), base.fill)
  };
}

function mergePanel(over: unknown): PdfPanelSettings {
  const base = DEFAULT_PDF_PANEL;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    borderWidth: pick(nonNegative(given.borderWidth), base.borderWidth),
    ...optional("borderColor", given.borderColor, color(given.borderColor), base.borderColor),
    radius: pick(nonNegative(given.radius), base.radius),
    padding: pick(nonNegative(given.padding), base.padding),
    ...optional("fill", given.fill, color(given.fill), base.fill),
    ...optional("headerFill", given.headerFill, color(given.headerFill), base.headerFill),
    headerPadding: pick(nonNegative(given.headerPadding), base.headerPadding)
  };
}

function mergeList(over: unknown): PdfListSettings {
  const base = DEFAULT_PDF_LIST;
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  return {
    indent: pick(nonNegative(given.indent), base.indent),
    gap: pick(nonNegative(given.gap), base.gap),
    bullet: pick(typeof given.bullet === "string" && given.bullet !== "" ? given.bullet : undefined, base.bullet)
  };
}

function isSpacingPair(value: unknown): value is [number, number] {
  return Array.isArray(value) && value.length === 2 && value.every((entry: unknown) => nonNegative(entry) !== undefined);
}

/** The form look's table with the theme's pairs over it; a kind set to `null` is left to the kernel. */
function mergeSpacing(over: unknown): PdfSpacingTable {
  const table: PdfSpacingTable = { ...DEFAULT_PDF_SPACING };
  const given: Record<string, unknown> = isRecord(over) ? over : {};
  for (const kind of PDF_BLOCK_KINDS) {
    const pair = given[kind];
    if (pair === null) {
      delete table[kind];
    } else if (isSpacingPair(pair)) {
      table[kind] = [pair[0], pair[1]];
    }
  }
  return table;
}

function mergeTexts(over: PdfThemeTexts | undefined): Required<PdfThemeTexts> {
  const isText = (value: unknown): value is LocalizedText =>
    typeof value === "string" || (isRecord(value) && typeof value.default === "string");
  return {
    yes: isText(over?.yes) ? over.yes : DEFAULT_PDF_TEXTS.yes,
    no: isText(over?.no) ? over.no : DEFAULT_PDF_TEXTS.no,
    empty: isText(over?.empty) ? over.empty : DEFAULT_PDF_TEXTS.empty,
    pageOf: isText(over?.pageOf) ? over.pageOf : DEFAULT_PDF_TEXTS.pageOf,
    required: isText(over?.required) ? over.required : DEFAULT_PDF_TEXTS.required,
    stepOf: isText(over?.stepOf) ? over.stepOf : DEFAULT_PDF_TEXTS.stepOf,
    attachmentDescription: isText(over?.attachmentDescription) ? over.attachmentDescription : DEFAULT_PDF_TEXTS.attachmentDescription,
    signatureAlt: isText(over?.signatureAlt) ? over.signatureAlt : DEFAULT_PDF_TEXTS.signatureAlt
  };
}

function mergeComponents(over: unknown): Record<string, PdfThemeComponentChoice> {
  const components: Record<string, PdfThemeComponentChoice> = { ...DEFAULT_PDF_COMPONENTS };
  if (!isRecord(over)) {
    return components;
  }
  for (const [type, choice] of Object.entries(over)) {
    if (!isRecord(choice)) {
      continue;
    }
    const entry: PdfThemeComponentChoice = {};
    if (typeof choice.rendition === "string" && choice.rendition !== "") {
      entry.rendition = choice.rendition;
    }
    if (isRecord(choice.style)) {
      entry.style = choice.style as PdfComponentStyle;
    }
    components[type] = entry;
  }
  return components;
}

// --- Scale --------------------------------------------------------------------------------------

function scaled(value: number, scale: number): number {
  return Math.round(value * scale * 1000) / 1000;
}

function scaleFontSpec(spec: PdfFontSpec, scale: number): PdfFontSpec {
  return { ...spec, size: scaled(spec.size, scale) };
}

function scaleOptionalFontSpec(spec: PdfFontSpec | undefined, scale: number): PdfFontSpec | undefined {
  return spec ? scaleFontSpec(spec, scale) : undefined;
}

/** Every point value the theme states, multiplied; ratios, counts and fractions kept. */
function scaleTheme(theme: ResolvedPdfTheme, scale: number): ResolvedPdfTheme {
  const s = (value: number): number => scaled(value, scale);
  const opt = <K extends string>(key: K, value: number | undefined): { [P in K]?: number } =>
    value !== undefined ? ({ [key]: s(value) } as { [P in K]?: number }) : {};
  const { typography, controls, choice, fields, headings, table, box, panel, list } = theme;
  const roles = ["hint", "option", "legend", "required", "small", "affix", "stepTag"] as const;
  const scaledTypography: PdfTypography = {
    body: scaleFontSpec(typography.body, scale),
    label: scaleFontSpec(typography.label, scale),
    heading: { ...typography.heading, sizes: typography.heading.sizes.map(s) },
    ...(typography.mono ? { mono: scaleFontSpec(typography.mono, scale) } : {}),
    ...(typography.fallbacks ? { fallbacks: typography.fallbacks } : {})
  };
  for (const role of roles) {
    const spec = scaleOptionalFontSpec(typography[role], scale);
    if (spec) {
      scaledTypography[role] = spec;
    }
  }
  const spacing: PdfSpacingTable = {};
  for (const kind of PDF_BLOCK_KINDS) {
    const pair = theme.spacing[kind];
    if (pair) {
      spacing[kind] = [s(pair[0]), s(pair[1])];
    }
  }
  const components: Record<string, PdfThemeComponentChoice> = {};
  for (const [type, entry] of Object.entries(theme.components)) {
    const style = entry.style;
    components[type] = {
      ...entry,
      ...(style
        ? {
            style: {
              ...style,
              ...opt("spacingBefore", style.spacingBefore),
              ...opt("spacingAfter", style.spacingAfter),
              ...opt("widgetHeight", style.widgetHeight),
              ...opt("width", style.width),
              ...opt("size", style.size)
            }
          }
        : {})
    };
  }
  return {
    ...theme,
    typography: scaledTypography,
    controls: {
      ...controls,
      borderWidth: s(controls.borderWidth),
      radius: s(controls.radius),
      padding: s(controls.padding),
      minHeight: s(controls.minHeight),
      ...opt("fontSize", controls.fontSize),
      ...opt("maxWidth", controls.maxWidth)
    },
    choice: {
      ...choice,
      size: s(choice.size),
      widgetSize: s(choice.widgetSize),
      borderWidth: s(choice.borderWidth),
      radius: s(choice.radius),
      markStroke: s(choice.markStroke),
      ...opt("dotSize", choice.dotSize),
      labelGap: s(choice.labelGap),
      optionGap: s(choice.optionGap),
      legendGap: s(choice.legendGap)
    },
    fields: {
      ...fields,
      labelToValue: s(fields.labelToValue),
      labelToControl: s(fields.labelToControl),
      labelToHint: s(fields.labelToHint),
      hintToControl: s(fields.hintToControl),
      ...(typeof fields.inlineLabelWidth === "number" ? { inlineLabelWidth: s(fields.inlineLabelWidth) } : {})
    },
    headings: { ...headings, bandPadding: s(headings.bandPadding), titleRuleWidth: s(headings.titleRuleWidth) },
    table: { ...table, cellPadding: s(table.cellPadding), borderWidth: s(table.borderWidth), rowMinHeight: s(table.rowMinHeight) },
    box: { ...box, borderWidth: s(box.borderWidth), padding: s(box.padding), radius: s(box.radius) },
    panel: { ...panel, borderWidth: s(panel.borderWidth), radius: s(panel.radius), padding: s(panel.padding), headerPadding: s(panel.headerPadding) },
    list: { ...list, indent: s(list.indent), gap: s(list.gap) },
    spacing,
    components
  };
}

/**
 * The theme a PDF renders under, defaults filled in. A theme that is not a PDF theme (a host
 * that passed another target by habit) contributes nothing: a form's CSS has no meaning on
 * paper, so the result is the engine default rather than a guess.
 */
export function resolvePdfTheme(theme: PdfThemeDefinition | { readonly target?: string } | undefined): ResolvedPdfTheme {
  const settings: PdfThemeSettings = isPdfTheme(theme) && isRecord(theme.pdf) ? theme.pdf : (DEFAULT_PDF_THEME.pdf ?? {});
  const resolved: ResolvedPdfTheme = {
    id: isPdfTheme(theme) ? theme.id : DEFAULT_PDF_THEME_ID,
    page: isRecord(settings.page) ? (settings.page as Partial<PdfPageSetup>) : undefined,
    typography: mergeTypography(settings.typography),
    colors: mergeColors(settings.colors),
    controls: mergeControls(settings.controls),
    choice: mergeChoice(settings.choice),
    fields: mergeFields(settings.fields),
    headings: mergeHeadings(settings.headings),
    table: mergeTable(settings.table),
    box: mergeBox(settings.box),
    panel: mergePanel(settings.panel),
    list: mergeList(settings.list),
    spacing: mergeSpacing(settings.spacing),
    components: mergeComponents(settings.components),
    texts: mergeTexts(settings.texts),
    tagged: typeof settings.tagged === "boolean" ? settings.tagged : undefined,
    pdfa: resolvePdfConformance({ pdfa: settings.pdfa })?.pdfa,
    outputIntent: resolvePdfOutputIntentConfiguration(settings.outputIntent)
  };
  const scale = positive(settings.scale);
  return scale !== undefined && scale !== 1 ? scaleTheme(resolved, scale) : resolved;
}

/**
 * The faces a theme ships (`assets.fonts`), malformed entries dropped; empty for a theme that
 * ships none.
 */
export function themeFontFaces(theme: PdfThemeDefinition | undefined): ThemeFontFace[] {
  const fonts = theme?.assets?.fonts as unknown;
  if (!Array.isArray(fonts)) {
    return [];
  }
  const out: ThemeFontFace[] = [];
  for (const entry of fonts) {
    if (!isRecord(entry) || typeof entry.family !== "string" || entry.family === "" || typeof entry.file !== "string" || entry.file === "") {
      continue;
    }
    const coverage = Array.isArray(entry.coverage) ? entry.coverage.filter((tag: unknown): tag is string => typeof tag === "string" && tag !== "") : undefined;
    out.push({
      family: entry.family,
      file: entry.file,
      ...(positive(entry.weight) !== undefined ? { weight: entry.weight as number } : {}),
      ...(entry.style === "normal" || entry.style === "italic" ? { style: entry.style } : {}),
      ...(coverage && coverage.length > 0 ? { coverage } : {})
    });
  }
  return out;
}

/** What a design-system binding says about paper: a suggestion, never a derivation. */
export interface PdfBindingSuggestion {
  /** The binding's id, for the warnings. */
  id: string;
  /** The PDF theme to print under when the host names none: an id the host's registry holds, or the theme itself. */
  pdfTheme?: string | PdfThemeDefinition | undefined;
}

export interface PdfThemeSelectionOptions {
  /** The theme the render call asks for by id; wins over everything. */
  themeId?: string | undefined;
  /** The theme the layout names (`PdfGeneratedLayout.theme`). */
  layoutThemeId?: string | undefined;
  /** The host's default PDF theme object, for a document that names none. */
  theme?: PdfThemeDefinition | undefined;
  /**
   * The binding the form is drawn by and the PDF theme it suggests. Read only when nothing above
   * answers: the document then prints under the suggestion (an id looked up through
   * `resolveTheme`, or the theme object itself) rather than the engine's own look.
   */
  binding?: PdfBindingSuggestion | undefined;
  resolveTheme?: PdfThemeLookup | undefined;
}

export interface PdfThemeSelection {
  /** The theme object to render under; `undefined` means the engine default. */
  theme: PdfThemeDefinition | undefined;
  /** Which rung answered. */
  source: "call" | "layout" | "host" | "binding" | "default";
  /** One `theme.notFound` per id that nothing could supply and one `theme.notPdf` per theme of another target. */
  warnings: PdfWarning[];
}

function blankId(id: string | undefined): boolean {
  return id === undefined || id.trim() === "";
}

/** The engine's built-in PDF themes by id: `datum-pdf` and `datum-plain`. */
function builtInPdfTheme(id: string): PdfThemeDefinition | undefined {
  return id === DEFAULT_PDF_THEME_ID ? DEFAULT_PDF_THEME : id === PLAIN_PDF_THEME_ID ? PLAIN_PDF_THEME : undefined;
}

/**
 * The theme a document renders under: the render call's `themeId`, then the layout's `theme`,
 * then the host's default object, then the PDF theme the form's binding suggests, then the
 * engine default (`datum-pdf`). Nothing is derived from a form look. A rung that cannot answer
 * says why and the next one answers, so a layout authored against one host's registry still
 * prints on another:
 *
 * - `theme.notFound`: an id nothing supplies (neither the host's lookup nor the engine's own
 *   `datum-pdf` / `datum-plain`), which is also what a layout naming a PDF theme that no longer
 *   exists gets;
 * - `theme.notPdf`: a theme whose target is not `"pdf"`, refused at every rung.
 */
export function selectPdfTheme(options: PdfThemeSelectionOptions): PdfThemeSelection {
  const warnings: PdfWarning[] = [];
  const accept = (theme: PdfThemeDefinition | undefined, asked: string): PdfThemeDefinition | undefined => {
    if (theme === undefined) {
      return undefined;
    }
    if (!isPdfTheme(theme)) {
      warnings.push({
        code: "theme.notPdf",
        message: `"${(theme as { id?: string }).id ?? "(no id)"}" (asked for by ${asked}) is not a PDF theme; a form look is never printed from. The next rung was used.`
      });
      return undefined;
    }
    return theme;
  };
  const lookUp = (id: string, asked: string): PdfThemeDefinition | undefined => {
    // The engine's own two answer by id with no host lookup (the program has none), so a layout
    // that names `datum-pdf` keeps it even where a host default would otherwise win.
    const raw = options.resolveTheme?.(id) ?? builtInPdfTheme(id);
    if (raw === undefined) {
      warnings.push({ code: "theme.notFound", message: `No PDF theme "${id}" is registered (asked for by ${asked}); the next rung was used.` });
      return undefined;
    }
    return accept(raw, asked);
  };

  if (!blankId(options.themeId)) {
    const theme = lookUp(options.themeId!, "the render call");
    if (theme) {
      return { theme, source: "call", warnings };
    }
  }
  if (!blankId(options.layoutThemeId)) {
    const theme = lookUp(options.layoutThemeId!, "the layout");
    if (theme) {
      return { theme, source: "layout", warnings };
    }
  }
  const host = accept(options.theme, "the host");
  if (host) {
    return { theme: host, source: "host", warnings };
  }
  const suggested = options.binding?.pdfTheme;
  if (suggested !== undefined) {
    const asked = `binding "${options.binding!.id}"`;
    const theme = typeof suggested === "string" ? (blankId(suggested) ? undefined : lookUp(suggested, asked)) : accept(suggested, asked);
    if (theme) {
      return { theme, source: "binding", warnings };
    }
  }
  return { theme: undefined, source: "default", warnings };
}

/** The theme's choice for a type: its own entry over the wildcard, style merged the same way. */
export function pdfThemeChoiceFor(theme: ResolvedPdfTheme, type: string): PdfThemeComponentChoice {
  const wildcard = theme.components["*"] ?? {};
  const own = theme.components[type] ?? {};
  const style = { ...(wildcard.style ?? {}), ...(own.style ?? {}) };
  const rendition = own.rendition ?? wildcard.rendition;
  return {
    ...(rendition !== undefined ? { rendition } : {}),
    ...(Object.keys(style).length > 0 ? { style } : {})
  };
}

