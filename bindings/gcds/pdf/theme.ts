/**
 * The GC Design System PDF theme: a standalone PDF theme of this package, beside the live
 * binding. The binding's look is not a source for it, so every value is read from GC Design System's
 * own published tokens (`@gcds-core/tokens`, the pinned release), written here as the `var()` the
 * design system's CSS uses (`T("var(--gcds-label-font-desktop)")`) and resolved against
 * `tokens.generated.ts`, which `scripts/generate-tokens.mjs` cuts from the release's CSS. Lengths
 * are converted at 1 rem = 12 pt (16 px at 0.75 pt per px: the PDF prints as the browser
 * would print the page) and only from px, rem or pt: any other unit throws (`lengthToPt`).
 *
 * The few values the tokens do not state are listed in `tokens.json` under `inferred` with where
 * they come from, and marked INFERRED here. The theme ships no font files: `assets.fonts` names
 * the WOFF files of `@gcds-core/fonts` relative to the folder the host serves for the live form
 * (its CDN, or node_modules), and the kernel converts WOFF to sfnt as it loads them.
 */
import type { PdfThemeDefinition } from "../../../engine/form-engine/render/pdf/pdf-theme-defaults.js";
import { lengthToPt } from "../../../packages/datum/binding-kit/lib/token-units.mjs";
import { GENERATED_FROM, TOKENS } from "./tokens.generated.js";

/** The tokens package this theme was cut from: the version a host can check. */
export const GCDS_TOKENS_VERSION = GENERATED_FROM.version;

/** A PDF theme id of its own: `target: "pdf"` keeps it apart from the binding's id. */
export const GCDS_PDF_THEME_ID = "gcds";

/** 1 rem = 12 pt. */
export const REM_PT = 12;

type TokenRef = `var(--gcds-${string})`;

/** A token's value as the release declares it. Throws for a token the generated table lacks: regenerate it. */
function T(ref: TokenRef): string {
  const name = /^var\((--[\w-]+)\)$/.exec(ref)?.[1] ?? ref;
  const value = TOKENS[name];
  if (value === undefined) {
    throw new Error(`${name} is not in tokens.generated.ts: run scripts/generate-tokens.mjs`);
  }
  return value;
}

/** A token length (`0.125rem`, `12px`, `0`) in points. */
export function pt(length: string): number {
  return length.trim() === "0" ? 0 : lengthToPt(length, { remPt: REM_PT });
}

/** The parts of a shorthand (`0 0 1.5rem`) in points, CSS order: top, right, bottom, left. */
export function box(shorthand: string): [number, number, number, number] {
  const parts = shorthand.trim().split(/\s+/).map(pt);
  const [top = 0, right = top, bottom = top, left = right] = parts;
  return [top, right, bottom, left];
}

interface TypeRole {
  family: string;
  size: number;
  lineHeight: number;
  weight: number;
}

/** A font shorthand token (`700 1.8125rem/137% 'Lato', sans-serif`) as a PDF type role: first family named, size in points, line height as a ratio. */
export function font(shorthand: string): TypeRole {
  const match = /^(?:(italic|normal)\s+)?(\d{3})\s+([\d.]+(?:rem|px|pt))\s*\/\s*([\d.]+%?)\s+(.+)$/.exec(shorthand.trim());
  if (!match) {
    throw new Error(`Not a font shorthand token: ${shorthand}`);
  }
  const [, , weight, size, line, families] = match as unknown as [string, string | undefined, string, string, string, string];
  const family = (families.split(",")[0] ?? "").trim().replace(/^['"]|['"]$/g, "");
  return { family, size: pt(size), lineHeight: line.endsWith("%") ? Number(line.slice(0, -1)) / 100 : Number(line), weight: Number(weight) };
}

const body = font(T("var(--gcds-text-size-body-desktop)"));
const label = font(T("var(--gcds-label-font-desktop)"));
const option = font(T("var(--gcds-radio-label-font-desktop)"));
const legend = font(T("var(--gcds-radio-legend-font-desktop)"));
const small = font(T("var(--gcds-text-size-small-desktop)"));
const stepper = font(T("var(--gcds-stepper-font-desktop)"));
const mono = font(T("var(--gcds-font-text-mono)"));
const input = font(T("var(--gcds-input-font-desktop)"));
// The form title at gcds-heading h3; sections and groups at the fieldset's h5 legend (GC Design
// System sizes a nested fieldset's legend down one step from the page's heading level; the PDF has no page h1/h2).
const headings = [T("var(--gcds-font-h3)"), T("var(--gcds-font-h5)"), T("var(--gcds-font-h5)"), T("var(--gcds-font-h6)"), T("var(--gcds-font-text)"), T("var(--gcds-font-text)")].map(font);

const labelBottom = box(T("var(--gcds-label-margin)"))[2];
const hintTop = box(T("var(--gcds-hint-margin)"))[0];
const hintBottom = box(T("var(--gcds-hint-margin)"))[2];
const fieldBottom = box(T("var(--gcds-input-margin)"))[2];
const radioBottom = box(T("var(--gcds-radio-margin)"))[2];
const legendHint = box(T("var(--gcds-radio-legend-hint-margin)"))[2];
const legendBottom = box(T("var(--gcds-fieldset-legend-margin)"))[2];
const cardPadding = box(T("var(--gcds-card-padding)"));
const tableCell = box(T("var(--gcds-table-cell-padding-desktop)"));

/** Where the faces are, relative to `@gcds-core/fonts`'s `fonts/` folder. */
const face = (dir: string, file: string, family: string, weight: number, style: "normal" | "italic") => ({ family, weight, style, file: `${dir}/${file}`, coverage: ["Latn"] });

export const GCDS_PDF_FACES = [
  face("noto-sans", "gcds-noto-sans-regular.woff", "Noto Sans", 400, "normal"),
  face("noto-sans", "gcds-noto-sans-regular-italic.woff", "Noto Sans", 400, "italic"),
  face("noto-sans", "gcds-noto-sans-medium.woff", "Noto Sans", 500, "normal"),
  face("noto-sans", "gcds-noto-sans-semibold.woff", "Noto Sans", 600, "normal"),
  face("noto-sans", "gcds-noto-sans-bold.woff", "Noto Sans", 700, "normal"),
  face("noto-sans", "gcds-noto-sans-bold-italic.woff", "Noto Sans", 700, "italic"),
  face("lato", "gcds-lato.woff", "Lato", 700, "normal"),
  face("noto-sans-mono", "gcds-noto-sans-mono.woff", "Noto Sans Mono", 400, "normal")
];

export const GCDS_PDF_THEME: PdfThemeDefinition = {
  id: GCDS_PDF_THEME_ID,
  version: `1.0.0+tokens.${GCDS_TOKENS_VERSION}`,
  target: "pdf",
  label: "GC Design System",
  assets: { fonts: GCDS_PDF_FACES },
  pdf: {
    // INFERRED: GC Design System states no print page. Letter with 0.75in margins.
    page: { size: "Letter", orientation: "portrait", margins: { top: 54, right: 54, bottom: 54, left: 54 } },
    typography: {
      body: { ...body, color: T("var(--gcds-text-primary)") },
      label: { ...label, color: T("var(--gcds-label-text)"), transform: "none" },
      hint: { ...body, color: T("var(--gcds-hint-text)") },
      option: { ...option, color: T("var(--gcds-radio-default-text)") },
      legend: { ...legend, color: T("var(--gcds-fieldset-default-text)"), transform: "none" },
      required: { ...label, weight: Number(T("var(--gcds-label-required-font-weight)")), color: T("var(--gcds-label-text)"), transform: "none" },
      small: { ...small, color: T("var(--gcds-text-secondary)") },
      affix: { ...body, color: T("var(--gcds-text-secondary)") },
      stepTag: { ...stepper, color: T("var(--gcds-text-primary)") },
      heading: {
        family: headings[0]!.family,
        weight: headings[0]!.weight,
        color: T("var(--gcds-heading-default-text)"),
        sizes: headings.map((entry) => entry.size),
        lineHeights: headings.map((entry) => entry.lineHeight)
      },
      mono: { family: mono.family, size: mono.size, lineHeight: mono.lineHeight },
      // The GC Design System faces are Latin subsets; every other script falls to the kernel's DejaVu pack.
      fallbacks: { Grek: "sans-serif", Cyrl: "sans-serif", Arab: "sans-serif", Hebr: "sans-serif" }
    },
    colors: {
      text: T("var(--gcds-text-primary)"),
      muted: T("var(--gcds-text-secondary)"),
      border: T("var(--gcds-border-default)"),
      accent: T("var(--gcds-bg-primary)"),
      surface: T("var(--gcds-bg-light)"),
      // gcds-input draws its border in currentColor, which is the input's text token.
      controlBorder: T("var(--gcds-input-default-text)"),
      controlFill: T("var(--gcds-input-default-background)"),
      // INFERRED: the checked radio's dot is painted with the system colour buttonText (component CSS, not a token).
      choiceMark: T("var(--gcds-color-black)"),
      link: T("var(--gcds-link-default)"),
      onAccent: T("var(--gcds-text-light)")
    },
    controls: {
      borderWidth: pt(T("var(--gcds-input-border-width)")),
      radius: pt(T("var(--gcds-input-border-radius)")),
      padding: pt(T("var(--gcds-input-padding)")),
      minHeight: pt(T("var(--gcds-input-min-width-and-height)")),
      // INFERRED: gcds-textarea's default rows (5) is a component property, not a token.
      textareaRows: 5,
      fontSize: input.size,
      // INFERRED: GC Design System's 75ch reading width in Noto Sans at 15pt; wider than a Letter column.
      maxWidth: 643,
      valueFrame: "box",
      selectMark: "chevron"
    },
    choice: {
      size: pt(T("var(--gcds-radio-input-height-and-width)")),
      widgetSize: pt(T("var(--gcds-checkbox-input-height-and-width)")),
      borderWidth: pt(T("var(--gcds-radio-input-border-width)")),
      radius: pt(T("var(--gcds-checkbox-input-border-radius)")),
      markStroke: pt(T("var(--gcds-checkbox-check-border-width)")),
      dotSize: pt(T("var(--gcds-radio-check-height-and-width)")),
      // The caption starts 3.75rem in; the box is 3rem: the gap is the difference.
      labelGap: box(T("var(--gcds-radio-label-padding)"))[3] - pt(T("var(--gcds-radio-input-height-and-width)")),
      optionGap: radioBottom,
      legendGap: legendHint,
      columns: 1
    },
    fields: {
      labelToValue: labelBottom,
      labelToControl: labelBottom,
      // The hint pulls itself 0.375rem up into the label's 0.5rem.
      labelToHint: labelBottom + hintTop,
      hintToControl: hintBottom,
      hints: "shown",
      hintPosition: "afterLabel"
    },
    headings: { numbered: false, band: "none", bandPadding: 3, titleRule: false, titleRuleWidth: 1 },
    // gcds-table: 0.75rem × 0.5rem cells (the kernel takes one padding: the horizontal), 0.0625rem rules.
    // INFERRED: GC Design System's header has no fill (a 0.125rem rule under it instead, which the kernel cannot draw); a light band is kept.
    table: { cellPadding: tableCell[1], borderWidth: pt(T("var(--gcds-table-border-width)")), rowMinHeight: 18, headerFill: T("var(--gcds-bg-light)"), headerWeight: Number(T("var(--gcds-table-header-cell-font-weight)")) },
    // A pdf-box as the gcds-card: its 0.0625rem border, md corners, 2.25rem × 1.5rem padding (one number: the horizontal).
    box: { borderWidth: pt(T("var(--gcds-border-width-sm)")), padding: cardPadding[1], radius: pt(T("var(--gcds-border-radius-md)")) },
    panel: { borderWidth: pt(T("var(--gcds-border-width-sm)")), borderColor: T("var(--gcds-border-default)"), radius: pt(T("var(--gcds-border-radius-md)")), padding: pt(T("var(--gcds-spacing-150)")), fill: T("var(--gcds-bg-white)"), headerFill: T("var(--gcds-bg-light)"), headerPadding: pt(T("var(--gcds-spacing-100)")) },
    // INFERRED: list geometry from GC Design System's text spacing scale.
    list: { indent: pt(T("var(--gcds-spacing-300)")), gap: pt(T("var(--gcds-spacing-100)")), bullet: "•" },
    spacing: {
      paragraph: [0, pt(T("var(--gcds-spacing-100)"))],
      labelValue: [0, fieldBottom],
      widget: [0, fieldBottom],
      checkmark: [0, fieldBottom],
      checklist: [0, fieldBottom],
      list: [0, pt(T("var(--gcds-spacing-100)"))],
      // A group's caption sits 0.125rem above the 1.5rem its first field carries.
      heading: [0, fieldBottom + legendBottom],
      table: [2, fieldBottom],
      box: [2, fieldBottom]
    },
    texts: {
      yes: { default: "Yes", locales: { fr: "Oui" } },
      no: { default: "No", locales: { fr: "Non" } },
      empty: "—",
      pageOf: { default: "Page {{page}} of {{pages}}", locales: { fr: "Page {{page}} de {{pages}}" } },
      // gcds-label's marker and gcds-stepper's tag, in GC Design System's own words (en/fr).
      required: { default: "(required)", locales: { fr: "(obligatoire)" } },
      stepOf: { default: "Step {{n}} of {{total}}", locales: { fr: "Étape {{n}} sur {{total}}" } }
    },
    components: { radio: { rendition: "checklist" }, panel: { rendition: "panel" } }
  }
};
