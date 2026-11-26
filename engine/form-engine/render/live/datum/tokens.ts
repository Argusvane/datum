import { CHECK_ICON, CHEVRON_ICON, ERROR_ICON, RADIO_ICON } from "./icons.js";

/**
 * The Datum token vocabulary, declared once: every custom property the Datum
 * stylesheet (`css.ts`, with the container layout rules) reads, with the fallback it reads it
 * with, what it drives, and which tier it belongs to. An engine test holds this manifest and the
 * stylesheet to each other both ways, so the manifest cannot name a token nothing reads nor miss
 * one the stylesheet started reading.
 *
 * Tiers say what a token set is expected to set:
 *
 * - `base` — what a design system always publishes: its palette, its type scale, the
 *   spacing of a form's body, the geometry it prescribes for controls and buttons. The
 *   coverage check reports a base token a binding leaves unset.
 * - `derived` — a token whose engine fallback is another token (`color-input-border` reads
 *   `color-border`; `focus-ring-color` reads `color-accent`), plus the form's own surface and
 *   colour scheme, which a light binding leaves to the page. Setting one is a
 *   refinement, never an obligation.
 * - `geometry` — a literal a design system rarely prescribes (a control's minimum height,
 *   the reading-width cap, a frame's shadow). The engine's value stands until a binding says
 *   otherwise.
 *
 * Naming: property-first for the colour, radius, font, spacing and shadow groups
 * (`radius-control`, `font-size-label`, `spacing-field-gap`); part-first for the control and
 * button geometry (`control-padding`, `button-font-size`). A new token mirrors the nearest
 * existing token's pattern. `since` is the engine version the token first appeared in.
 */

export type FormTokenGroup = "palette" | "state" | "surface" | "spacing" | "type" | "focus" | "controls" | "layout";

export type FormTokenTier = "base" | "derived" | "geometry";

export interface FormTokenSpec {
  /** The token name without the leading `--`. */
  readonly name: string;
  readonly group: FormTokenGroup;
  readonly tier: FormTokenTier;
  /** The value the stylesheet reads when nothing sets the token, as the first read site writes it. */
  readonly fallback: string;
  /** What the token drives, in the words the Integrate reference shows. */
  readonly what: string;
  /** The engine version the token first appeared in. */
  readonly since: string;
}

const V0 = "0.1.0";
/** The release that made the engine look's literals tokens. */
const V1 = "0.2.0";

function token(name: string, group: FormTokenGroup, tier: FormTokenTier, fallback: string, what: string, since = V0) {
  return { name, group, tier, fallback, what, since } as const;
}

export const FORM_TOKENS = [
  // --- Palette -----------------------------------------------------------------------------
  token("color-text", "palette", "base", "#14212b", "The form's text."),
  token("color-muted", "palette", "base", "#536b7f", "Field descriptions, option hints, the character count, the optional mark, the required note and the size line under an attached file."),
  token("color-accent", "palette", "base", "#2f6feb", "The default and primary buttons, link-style buttons, the download link on an attached file's name, the active step, and the focus ring's fallback."),
  token("color-border", "palette", "base", "#a9bbcb", "Input borders (unless color-input-border is set), panel and tab outlines, the step bar, table cells, the status line and the file Remove button."),
  token("color-input-border", "palette", "derived", "var(--color-border, #7e95ab)", "Input borders alone, for a binding that treats them apart from panel outlines; falls back to color-border. Keep it 3:1 against color-input-bg."),
  token("color-input-bg", "palette", "base", "#fff", "The controls themselves: text inputs, selects, textareas and the language switcher."),
  token("color-panel", "palette", "base", "#fff", "A panel's surface and the active tab."),
  token("color-panel-header", "palette", "base", "#eef3f8", "A panel's header band."),
  token("color-light", "palette", "base", "#eef3f8", "The light fill: affixes, the --light button, the step numbers, the status line and a notice's ground."),
  token("color-dark", "palette", "base", "#1f2933", "The dark fill: the --dark button and the help-mark bubble."),
  token("color-on-accent", "palette", "base", "#fff", "Text on the filled buttons: primary, start, secondary, success, danger and info, and the active and completed step numbers."),
  token("color-on-dark", "palette", "base", "#fff", "Text on color-dark: the dark button and the help-mark bubble."),
  token("color-choice-mark", "palette", "derived", "var(--color-accent, auto)", "The mark of a checked radio or checkbox — the dot, the tick — through the native accent-color; falls back to color-accent. A theme drawing its own marks reads it for them."),
  // --- State -------------------------------------------------------------------------------
  token("color-error", "state", "base", "#c53a3a", "Inline errors, the over-limit count, the summary's text, links and focus ring, an error notice's edge, and what color-danger falls back to."),
  token("color-error-bg", "state", "base", "#fff5f5", "The error summary's fill and an error notice's, whose words are color-error."),
  token("color-error-border", "state", "base", "#efc6c6", "The error summary's edge."),
  token("color-danger", "state", "derived", "var(--color-error, #c92a2a)", "The --danger button; falls back to color-error."),
  token("color-secondary", "state", "base", "#5b6b7a", "The --secondary button's border and, unless color-secondary-bg says otherwise, its fill."),
  token("color-secondary-bg", "state", "derived", "var(--color-secondary, #5b6b7a)", "The --secondary button's fill; falls back to color-secondary. \"transparent\" draws the outline button most design systems have.", V1),
  token("color-on-secondary", "state", "derived", "var(--color-on-accent, #fff)", "Text on the --secondary button; falls back to color-on-accent. An outline secondary sets it to color-secondary.", V1),
  token("button-hover-filter", "controls", "geometry", "none", "A filter over every button under the pointer — brightness(90%) for a design system that darkens all its buttons the same way; none by default.", V1),
  token("button-active-filter", "controls", "geometry", "none", "A filter over every button while pressed; none by default.", V1),
  token("color-success", "state", "base", "#2f855a", "The --success and --start buttons, a completed step, and a success notice's edge."),
  token("color-warning", "state", "base", "#e8a317", "The --warning button, which draws color-dark text on it, and a warning notice's edge."),
  token("color-warning-bg", "state", "derived", "var(--color-light, #eef3f8)", "A warning notice's fill; falls back to color-light, the ground of a success or info notice, so the amber edge alone sets it apart. color-text sits on it: keep it 4.5:1 against that.", V1),
  token("color-info", "state", "base", "#2b8aa8", "The --info button and an info notice's edge."),
  token("color-disabled-bg", "state", "derived", "var(--color-light, #eef3f8)", "The fill of a disabled text box, number, date, select or textarea (outside read-only mode, which keeps the answers at full contrast); falls back to color-light. The text on it is color-muted: keep that 4.5:1 against this.", V1),
  // --- Surface and frames ---------------------------------------------
  token("color-surface", "surface", "derived", "transparent", "The form's own page: transparent unless set, so the form sits on the host's. A dark binding sets it and paints itself; the builder's canvas sheet takes the same colour."),
  token("color-scheme", "surface", "derived", "normal", "light or dark, emitted as the form's CSS color-scheme so the native parts a stylesheet cannot reach (date picker, select popup, scrollbars) follow the scheme."),
  token("color-frame-surface", "surface", "derived", "var(--color-surface, #fff)", "The fill of the paper frame; falls back to color-surface, then white — paper needs a colour of its own on a transparent form."),
  token("color-frame-border", "surface", "derived", "var(--color-border, #a9bbcb)", "The border of the outlined and paper frames (chrome.frame); falls back to color-border."),
  token("radius-frame", "surface", "geometry", "10px", "The corner radius of the outlined and paper frames."),
  token("shadow-frame", "surface", "geometry", "0 1px 2px rgba(13, 36, 53, .06), 0 8px 24px rgba(13, 36, 53, .07)", "The paper frame's drop shadow; \"none\" for a flat design system."),
  token("spacing-frame-padding", "surface", "geometry", "24px", "The room between a frame's edge and the fields."),
  token("radius-panel", "surface", "base", "10px", "A panel's corners."),
  // --- Spacing -----------------------------------------------------------------------------
  token("spacing-field-gap", "spacing", "base", "12px", "The gap between fields, between the rows of a layout, and inside panels, tabs and steps."),
  token("spacing-field-inner-gap", "spacing", "base", "4px", "The gap between a field's label, hint, control and error, and above the character count; zero for a design system that spaces them by margins."),
  token("spacing-option-gap", "spacing", "base", "6px", "The gap between the options of a radio or checkbox group."),
  token("target-min-size", "controls", "geometry", "24px", "The smallest height of a choice row, a summary link and the Back link (WCAG 2.5.8)."),
  token("target-touch-size", "controls", "geometry", "44px", "The minimum height of a journey's Continue, Submit and Back buttons, the size a thumb needs."),
  token("layout-max-width", "layout", "geometry", "none", "Caps the width of the fields column — the line-length limit every government design system puts on a form."),
  token("layout-grid-column-min", "layout", "geometry", "220px", "How narrow a grid column may get before the grid wraps it onto the next row."),
  // --- Type --------------------------------------------------------------------------------
  token("font-family", "type", "base", 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', "The form's body face, set on its root and inherited by every control."),
  token("font-family-heading", "type", "derived", "inherit", "The heading face — the form title, a chrome heading, a group's label, a panel's title, a notice's title, the summary heading and a step heading; the body face unless set."),
  token("font-size", "type", "base", "14px", "The form's body size, inherited by every control and the affixes."),
  token("line-height", "type", "base", "1.45", "The form's body line height, inherited by every control."),
  token("font-weight-label", "type", "base", "600", "Labels, and the legends of radio and checkbox groups."),
  token("font-size-label", "type", "base", "14px", "Labels and legends."),
  token("font-size-hint", "type", "base", "12px", "Field descriptions, option hints, the character count, the required note, a group's description and the step labels."),
  token("font-size-error", "type", "base", "12px", "The inline error text."),
  token("font-weight-error", "type", "base", "400", "The inline error text and the over-limit count."),
  token("font-size-title", "type", "base", "20px", "The form's own title."),
  token("font-size-heading", "type", "base", "17px", "A chrome heading and a step's heading."),
  token("font-size-group-label", "type", "base", "15px", "A group's label (its legend)."),
  token("font-size-panel-title", "type", "base", "14px", "A panel's title."),
  // --- Focus -------------------------------------------------------------------------------
  token("focus-ring-color", "focus", "derived", "var(--color-accent, #2f6feb)", "The keyboard focus ring on controls, buttons, tabs, step headings and the summary's links; the accent unless set."),
  token("focus-ring-width", "focus", "base", "2px", "The focus ring's width."),
  token("focus-ring-offset", "focus", "base", "2px", "The focus ring's offset from the control's edge."),
  token("focus-ring-inset", "focus", "geometry", "none", "An inset box-shadow under the ring, for a design system that thickens the control's own edge on focus."),
  // --- Controls and buttons ----------------------------------------------------------------
  token("radius-control", "controls", "base", "8px", "The corner radius of the boxed controls, the affixes and the language switcher."),
  token("radius-button", "controls", "base", "8px", "The buttons' corner radius at every size."),
  token("control-border-width", "controls", "base", "1px", "The boxed controls' and affixes' border width."),
  token("control-padding", "controls", "base", "7px 9px", "The boxed controls' and affixes' padding."),
  token("control-min-height", "controls", "geometry", "auto", "The boxed controls' minimum height."),
  token("control-max-width", "controls", "geometry", "none", "The boxed controls' maximum width."),
  token("text-max-width", "layout", "geometry", "none", "Caps the width of the text under a control — the hint, the error, the character count and a group's description — to a reading line (65ch in the studio themes).", V1),
  token("textarea-min-height", "controls", "geometry", "72px", "The textarea's minimum height."),
  token("button-padding", "controls", "base", "8px 16px", "Buttons at their default size; the small and large variants keep their own padding."),
  token("button-font-size", "controls", "base", "14px", "Buttons at their default size."),
  token("button-font-weight", "controls", "base", "400", "Buttons at their default size."),
  // --- The engine look, tokenised (0.2.0): every literal a binding would otherwise restate a rule for --
  token("color-on-warning", "state", "derived", "var(--color-dark, #14212b)", "Text on the --warning button; falls back to color-dark. A dark palette whose dark fill is light sets it to a dark the yellow can carry.", V1),
  token("field-part-justify", "spacing", "geometry", "auto", "How a field's text parts — label, hint, error, count, a group's legend, the required note — sit in the field's grid: auto (the engine's: a grid item stretches to its column), or start, as wide as their words (as some design systems draw their labels). One token instead of a rule per part.", V1),
  token("spacing-option-row-gap", "spacing", "geometry", "8px", "The gap between a radio or checkbox and its label.", V1),
  token("spacing-option-text-gap", "spacing", "geometry", "2px", "The gap between an option's label and its hint.", V1),
  token("spacing-group-gap", "spacing", "geometry", "6px", "The gap between a labelled group's legend, description and body.", V1),
  token("spacing-file-list-gap", "spacing", "geometry", "4px", "The gap between the rows of attached files.", V1),
  token("spacing-file-item-gap", "spacing", "geometry", "8px", "The gap between a file row's name, size and controls.", V1),
  token("spacing-chrome-gap", "spacing", "geometry", "8px", "The gap between the rows of the form's header and footer.", V1),
  token("spacing-chrome-group-gap", "spacing", "geometry", "8px 16px", "The row and column gaps between the parts of a chrome group.", V1),
  token("spacing-language-switcher-gap", "spacing", "geometry", "6px", "The gap between the language switcher's label and its select.", V1),
  token("spacing-tab-gap", "spacing", "geometry", "2px", "The gap between tabs.", V1),
  token("spacing-step-gap", "spacing", "geometry", "6px", "The gap between the entries of a step indicator, and between the indicator and its progress line.", V1),
  token("spacing-actions-gap", "spacing", "geometry", "8px", "The gap between a step's Back and Continue.", V1),
  token("radius-message", "surface", "geometry", "8px", "The corners of the error summary, the status line and a notice.", V1),
  token("radius-tooltip", "surface", "geometry", "6px", "The help bubble's corners.", V1),
  token("radius-tab", "surface", "geometry", "8px 8px 0 0", "A tab's corners.", V1),
  token("radius-file-remove", "controls", "geometry", "6px", "A file row's Remove button corners.", V1),
  token("radius-button-sm", "controls", "derived", "var(--radius-button, 6px)", "The small button's corners; falls back to radius-button.", V1),
  token("radius-button-lg", "controls", "derived", "var(--radius-button, 10px)", "The large and start buttons' corners; falls back to radius-button.", V1),
  token("padding-message", "spacing", "geometry", "8px 10px", "The padding of the error summary and the status line.", V1),
  token("padding-notice", "spacing", "geometry", "10px 12px", "A notice's padding.", V1),
  token("padding-panel-header", "spacing", "geometry", "8px 12px", "A panel header's padding.", V1),
  token("padding-panel-body", "spacing", "geometry", "12px", "A panel body's padding.", V1),
  token("padding-tab", "spacing", "geometry", "7px 12px", "A tab's padding.", V1),
  token("padding-tooltip", "spacing", "geometry", "6px 9px", "The help bubble's padding.", V1),
  token("padding-file-remove", "spacing", "geometry", "2px 8px", "A file row's Remove button padding.", V1),
  token("padding-table-cell", "spacing", "geometry", "4px 8px", "A cell of a table inside author-written html.", V1),
  token("padding-language-switcher", "spacing", "geometry", "5px 8px", "The language switcher select's padding.", V1),
  token("button-padding-sm", "controls", "geometry", "4px 10px", "The small button's padding.", V1),
  token("button-padding-lg", "controls", "geometry", "11px 22px", "The large and start buttons' padding.", V1),
  token("button-font-size-sm", "controls", "geometry", "12px", "The small button's size.", V1),
  token("button-font-size-lg", "controls", "geometry", "16px", "The large and start buttons' size.", V1),
  token("button-font-weight-start", "controls", "geometry", "600", "The start button's weight — the big call to action is bold.", V1),
  token("font-weight-heading", "type", "geometry", "600", "Every heading the form draws: its title, a chrome heading, a group's legend, a panel's title, a notice's title, the summary heading and a step heading.", V1),
  token("font-size-notice-title", "type", "geometry", "15px", "A notice's title.", V1),
  token("font-size-chrome-text", "type", "geometry", "14px", "A chrome text or description part.", V1),
  token("line-height-chrome-text", "type", "geometry", "1.5", "A chrome text or description part.", V1),
  token("line-height-title", "type", "geometry", "1.25", "The form's own title.", V1),
  token("line-height-heading", "type", "geometry", "1.3", "A chrome heading.", V1),
  token("font-size-file-item", "type", "geometry", "13px", "A row of attached files.", V1),
  token("font-size-file-meta", "type", "geometry", "12px", "The size line under an attached file, and the read-only file field's \"none\" line.", V1),
  token("font-size-file-remove", "type", "geometry", "12px", "A file row's Remove button.", V1),
  token("font-size-tab", "type", "geometry", "14px", "A tab's caption.", V1),
  token("font-weight-tab-active", "type", "geometry", "600", "The active tab's caption.", V1),
  token("font-size-tooltip", "type", "geometry", "12px", "The help bubble's text.", V1),
  token("font-size-language-switcher", "type", "geometry", "13px", "The language switcher's label.", V1),
  token("font-weight-language-switcher", "type", "geometry", "600", "The language switcher's label.", V1),
  token("width-message-border", "surface", "geometry", "1px", "The edge of the error summary, the status line and a notice.", V1),
  token("width-notice-bar", "surface", "geometry", "4px", "The bar down a notice's start edge, in the outcome's colour.", V1),
  token("width-button-border", "controls", "geometry", "1px", "The buttons' border width.", V1),
  token("width-panel-border", "surface", "geometry", "1px", "A panel's outline and the rule under its header.", V1),
  token("width-tab-border", "surface", "geometry", "1px", "A tab's outline and the rule under the tab list.", V1),
  token("width-step-bar", "surface", "geometry", "4px", "The bar over each entry of a step indicator, coloured by its status.", V1),
  token("width-file-remove-border", "controls", "geometry", "1px", "A file row's Remove button border width.", V1),
  token("size-step-number", "spacing", "geometry", "1.5em", "The circle around a step's number.", V1),
  token("size-tooltip-mark", "spacing", "geometry", "15px", "The help mark beside a label.", V1),
  token("shadow-tooltip", "surface", "geometry", "0 4px 12px rgba(13, 36, 53, .2)", "The help bubble's drop shadow.", V1),
  token("opacity-button-disabled", "controls", "geometry", ".5", "How far a disabled button fades.", V1),
  // --- Drawn marks, chevron and error icon (0.2.0): opt-in through DatumControls -------------
  token("icon-check", "controls", "geometry", CHECK_ICON, "The tick of a drawn checkbox (controls.choiceMarks: \"drawn\"): an SVG data URI the engine masks in color-choice-mark. A theme's own glyph goes here (svgDataUri).", V1),
  token("icon-radio", "controls", "geometry", RADIO_ICON, "The dot of a drawn radio, masked in color-choice-mark.", V1),
  token("icon-chevron", "controls", "geometry", CHEVRON_ICON, "The chevron of a drawn select (controls.selectChevron: \"drawn\"), masked in the control's text colour.", V1),
  token("icon-error", "controls", "geometry", ERROR_ICON, "The icon before an inline error (controls.errorIcon: \"drawn\"), masked in color-error.", V1),
  token("size-choice", "controls", "geometry", "16px", "A drawn checkbox's or radio's box.", V1),
  token("width-choice-border", "controls", "derived", "var(--control-border-width, 1px)", "A drawn checkbox's or radio's border width; falls back to control-border-width.", V1),
  token("radius-choice", "controls", "geometry", "4px", "A drawn checkbox's corners (a radio is round).", V1),
  token("size-chevron", "controls", "geometry", "12px", "A drawn select chevron's box.", V1),
  token("spacing-chevron-inset", "controls", "geometry", "9px", "The room between a drawn chevron and the select's end edge; the select's end padding leaves twice this plus the chevron.", V1),
  token("size-error-icon", "controls", "geometry", "1em", "A drawn error icon's box.", V1),
  token("spacing-error-icon-gap", "controls", "geometry", ".35em", "The gap between a drawn error icon and the message.", V1)
] as const satisfies readonly FormTokenSpec[];

/** A token name the engine's stylesheet reads. */
export type FormTokenName = (typeof FORM_TOKENS)[number]["name"];

/** Every token name, sorted. */
export const FORM_TOKEN_NAMES: readonly FormTokenName[] = [...FORM_TOKENS.map((spec) => spec.name)].sort();

const BY_NAME: ReadonlyMap<string, FormTokenSpec> = new Map(FORM_TOKENS.map((spec) => [spec.name, spec]));

/** The manifest entry for a token, or `undefined` for a name the engine does not read. */
export function formTokenSpec(name: string): FormTokenSpec | undefined {
  return BY_NAME.get(name.replace(/^--/, ""));
}

/** The engine's own fallback for a token — what the stylesheet reads when nothing sets it — or `undefined` for an unknown name. */
export function formTokenFallback(name: string): string | undefined {
  return formTokenSpec(name)?.fallback;
}

/** The names of one tier, sorted. */
export function formTokenNamesOfTier(tier: FormTokenTier): FormTokenName[] {
  return FORM_TOKEN_NAMES.filter((name) => BY_NAME.get(name)?.tier === tier);
}

/**
 * A token set of Datum's binding (`createDatumBinding({ tokens, dark })`) as the manifest names it:
 * every engine token is a known key (an editor completes it), and a set's private tokens — a
 * pinned `--bs-*` name, a value its own css reads back — are still admitted. A misspelt engine token is not a type error (the
 * index signature admits it); the coverage check's `stale` list is what catches it.
 */
export type DatumTokens = Partial<Record<FormTokenName, string>> & Record<string, string>;
