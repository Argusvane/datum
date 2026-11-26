import type { DatumTokens } from "./tokens.js";

/**
 * Datum's own look as token sets: the studio look the builder draws its controls in
 * (`studio-tokens.ts`), so a form on the builder's canvas and the inspector beside it read as one
 * surface, and a form rendered on its own looks like the builder that made it. Every value is a
 * literal copied from the studio token list rather than a `var(--db-*)` read, because the form
 * must stand on a page the builder is not on. Only what the studio look sets is set; everything
 * else (the frame shadow, the tab and step geometry) comes from the fallbacks in the stylesheet.
 *
 * `DATUM_TOKENS` is the light set; `DATUM_DARK_TOKENS` is what a dark page changes. The dark set
 * names every colour the stylesheet reads, because a dark palette cannot leave any of the light
 * fallbacks showing through, and it owns the form's surface (`color-surface`) and its colour
 * scheme, so the native parts a stylesheet cannot reach (the date picker, the select popup, the
 * scrollbars) follow it. The geometry and type below are shared, so the two are one form in two
 * palettes.
 */

/**
 * The studio's shape and type, as the form's tokens: the 10px input corner, a 40px control
 * (14px text at 1.45 inside 9px of padding and a 1px line), pill buttons at 36px with weight 500,
 * 13px/500 labels, 16px between fields, the card corner on panels and the frame, and the
 * builder's face (Geist when the page has loaded it, the system face otherwise).
 *
 * Every size is in rem, so a person who raised the browser's text size gets a larger form
 * (WCAG 1.4.4). Hints, errors and counts are 13px, and the error reads at weight 600 beside its
 * drawn icon. The text under a control stops at 65ch and the controls at 75ch of their own
 * text, or the column where that is narrower.
 */
const STUDIO_GEOMETRY: DatumTokens = {
  "font-family": '"Geist", system-ui, -apple-system, "Segoe UI", sans-serif',
  "font-size": "0.875rem",
  "line-height": "1.45",
  "font-weight-label": "500",
  "font-size-label": "0.8125rem",
  "font-size-hint": "0.8125rem",
  "font-size-error": "0.8125rem",
  "font-weight-error": "600",
  "font-size-title": "1.125rem",
  "font-size-heading": "1rem",
  "font-size-group-label": "0.875rem",
  "spacing-field-gap": "16px",
  "spacing-field-inner-gap": "6px",
  "radius-control": "10px",
  "control-padding": "9px 12px",
  "control-min-height": "40px",
  "control-max-width": "min(75ch, 100%)",
  "text-max-width": "65ch",
  "radius-button": "999px",
  "button-padding": "8px 16px",
  "button-font-size": "0.875rem",
  "button-font-weight": "500",
  "radius-panel": "14px",
  "radius-frame": "14px",
  "radius-message": "10px",
  "radius-tooltip": "8px"
};

/**
 * The light palette. Contrast on white (WCAG ratios): text 17.9:1, muted 7.8:1, the accent 6.8:1
 * as a link and under white text, the error 6.6:1 and 5.6:1 on its wash, the input line 3.9:1
 * (1.4.11's 3:1 non-text minimum), the card line 2.6:1; white text at least 5.7:1 on every
 * button variant. The light well is 1.16:1 off the surface, a step an HDR display's tone mapping
 * cannot flatten.
 */
export const DATUM_TOKENS: DatumTokens = {
  // The ink and the muted ink.
  "color-text": "#16171a",
  "color-muted": "#4e525b",
  // The card line around panels and the frame; the input line on the controls themselves.
  "color-border": "#9aa2ad",
  "color-input-border": "#7b828c",
  "color-input-bg": "#ffffff",
  "color-panel": "#ffffff",
  // The sunken surface: panel headers, affixes and the light button.
  "color-panel-header": "#eceef1",
  "color-light": "#eceef1",
  // The ink as the dark button, and as the mark of a checked box, as the inspector's.
  "color-dark": "#16171a",
  "color-on-dark": "#ffffff",
  "color-choice-mark": "#16171a",
  "color-accent": "#2f4bd6",
  "color-on-accent": "#ffffff",
  // The danger colour, its wash and its line.
  "color-error": "#b42318",
  "color-error-bg": "#fce9e7",
  "color-error-border": "#d9776d",
  // The muted ink as the secondary button; the ok green; the warning brown, which carries white text.
  "color-secondary": "#4e525b",
  "color-success": "#1e6b3a",
  "color-warning": "#8a4b00",
  // A warning notice's fill: the amber wash, 15.99:1 under color-text and 6.07:1 under the warning edge.
  "color-warning-bg": "#fdf1d6",
  "color-on-warning": "#ffffff",
  // The studio has no info colour; this teal sits with its palette and carries white at 5.7:1.
  "color-info": "#1c6e8c",
  // A disabled box: the sunken fill the affixes and the light button use, muted ink 6.7:1 on it.
  "color-disabled-bg": "#eceef1",
  ...STUDIO_GEOMETRY
};

/**
 * What a dark page changes. Contrast against the surface unless said otherwise: text 15:1,
 * muted 8.4:1, the accent 7.5:1 as a link, the error 7.2:1; the input border 3.8:1 against the
 * input's own background; on-accent text 7.5:1 on the accent and at least 7:1 on every button
 * variant that inherits it. The surface steps (page, input, panel, panel header) are 1.12:1 or
 * wider, far enough apart that an HDR display's tone mapping cannot flatten them into one dark.
 */
export const DATUM_DARK_TOKENS: DatumTokens = {
  "color-scheme": "dark",
  "color-surface": "#0f1720",
  "color-panel": "#172230",
  "color-panel-header": "#1f2b3a",
  "color-input-bg": "#1b2633",
  "color-text": "#e6edf3",
  "color-muted": "#9fb3c8",
  "color-border": "#4a5d70",
  // The frame around the form: paper is one surface step up, on a shadow the dark page can still show.
  "color-frame-border": "#4a5d70",
  "color-frame-surface": "#172230",
  "shadow-frame": "0 1px 2px rgba(0, 0, 0, .4), 0 8px 24px rgba(0, 0, 0, .45)",
  "color-input-border": "#6b8194",
  "color-accent": "#6ea8fe",
  // The mark of a checked radio or checkbox: the accent, where the light set uses its ink.
  "color-choice-mark": "#6ea8fe",
  "color-on-accent": "#0f1720",
  "color-secondary": "#9fb3c8",
  "color-success": "#3fb950",
  "color-info": "#58c4dd",
  "color-danger": "#ff7b7b",
  "color-error": "#ff7b7b",
  "color-error-bg": "#2e161b",
  "color-error-border": "#8a3a40",
  "color-warning": "#e8a317",
  // A warning notice's fill: a dark amber wash, 12.9:1 under color-text and 7.0:1 under the warning edge.
  "color-warning-bg": "#2e2410",
  "color-light": "#3a4d62",
  "color-dark": "#2b3a4a",
  // The warning button's text: the palette's dark, which the amber still carries.
  "color-on-warning": "#2b3a4a",
  "color-on-dark": "#e6edf3",
  // A disabled box: one step off the input's own dark, muted ink 6.0:1 on it.
  "color-disabled-bg": "#243245",
  ...STUDIO_GEOMETRY
};

/**
 * The native checkbox and radio at the studio's size (the inspector draws its own at 24px, past
 * WCAG 2.5.8's 24px target; a form row at 14px text takes 20px, the row itself still 24px tall
 * through `--target-min-size`). A native control, not a drawn mark: the inspector paints its
 * boxes through `accent-color`, and `color-choice-mark` does the same here.
 */
export const DATUM_CHOICE_CSS = ".datum-form__control--checkbox, .datum-form__control--radio { inline-size: 20px; block-size: 20px; flex: none; }";

/**
 * Rules the dark palette adds: an affix sits on color-light, a light well in this palette, where
 * the muted ink is 4.0:1 and the text 7.4:1; and the help bubble's drop shadow vanishes against
 * a dark surface, so an edge keeps it a bubble.
 */
export const DATUM_DARK_CSS: readonly string[] = [
  ".datum-form--dark .datum-form__affix { color: var(--color-text); }",
  ".datum-form--dark :is(.datum-form__tooltip-text, [data-tooltip-text]) { border: 1px solid var(--color-input-border); }"
];
