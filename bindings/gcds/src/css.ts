/**
 * The look of what the GC Design System binding draws itself. Every value is
 * one of the design system's own tokens (the host's `gcds.css` is tokens and the font import
 * alone; the components carry their own CSS in their shadow roots), so it follows the release the
 * host loads and nothing is restated. Spacing is the design system's too: each component carries
 * its own margin, as on a page written by hand, so the renderer's column adds none.
 */

/** Datum's tokens (the custom properties its own adapters read) to GC Design System's values: what the Datum adapters draw inside this binding (tabs, steps, files ...). */
export const GCDS_FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--font-family": "var(--gcds-font-families-body)",
  // INFERRED: the body text size (1.25rem); the tokens publish it only as a font shorthand and a unitless multiplier.
  "--font-size": "1.25rem",
  "--color-text": "var(--gcds-text-primary)",
  "--color-muted": "var(--gcds-text-secondary)",
  "--color-border": "var(--gcds-border-default)",
  "--color-input-border": "var(--gcds-text-primary)",
  "--color-input-bg": "var(--gcds-bg-white)",
  "--color-panel": "var(--gcds-bg-white)",
  "--color-panel-header": "var(--gcds-bg-light)",
  "--color-light": "var(--gcds-bg-light)",
  "--color-accent": "var(--gcds-link-default)",
  "--color-on-accent": "var(--gcds-text-light)",
  "--color-error": "var(--gcds-danger-text)",
  "--color-secondary": "var(--gcds-text-secondary)",
  "--color-dark": "var(--gcds-bg-dark)",
  "--color-on-dark": "var(--gcds-text-light)",
  "--radius-control": "var(--gcds-input-border-radius)",
  "--radius-button": "var(--gcds-button-border-radius)"
};

export const GCDS_CSS = `
  .datum-live, .datum-live-container { gap: 0; }
  .datum-gcds-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }
  /* What gcds-input's own wrapper sets, so the pieces inherit the same face. */
  .datum-gcds-field { color: var(--gcds-input-default-text); font: var(--gcds-input-font-desktop); max-width: 75ch; width: 100%; }
  .datum-gcds-affix { display: flex; align-items: stretch; margin: var(--gcds-input-margin, 0); }
  .datum-gcds-affix input {
    flex: 1 1 auto; min-width: 0; box-sizing: border-box; margin: 0;
    min-height: var(--gcds-input-min-width-and-height);
    padding: var(--gcds-input-padding);
    font: var(--gcds-input-font-desktop);
    color: var(--gcds-input-default-text);
    background: var(--gcds-input-default-background);
    border: var(--gcds-input-border-width) solid currentColor;
    border-radius: var(--gcds-input-border-radius);
  }
  .datum-gcds-affix input:focus { outline: var(--gcds-input-outline-width) solid var(--gcds-input-focus-border); outline-offset: var(--gcds-input-border-width); box-shadow: var(--gcds-input-focus-box-shadow); }
  .datum-gcds-affix input:disabled { color: var(--gcds-input-disabled-text); background: var(--gcds-input-disabled-background); }
  .datum-gcds-affix--invalid input { border-color: var(--gcds-input-danger-border); }
  .datum-gcds-affix__text { display: flex; align-items: center; padding: var(--gcds-input-padding); font: var(--gcds-input-font-desktop); color: var(--gcds-input-default-text); background: var(--gcds-input-disabled-background); border: var(--gcds-input-border-width) solid var(--gcds-input-default-text); }
  .datum-gcds-affix__text:first-child { border-inline-end: 0; }
  .datum-gcds-affix__text:last-child { border-inline-start: 0; }
  /* Beside a component: as gcds-textarea places its own count. */
  .datum-gcds-count { margin: var(--gcds-input-margin); }
  /* gcds-text keeps its colour in its own shadow root: the token it reads is the way in. */
  .datum-gcds-count--over gcds-text { --gcds-text-primary: var(--gcds-error-message-text-color); }
  /* A field's notices: hint styling and the severity word in bold. Never the error colour. */
  .datum-gcds-notices { margin: var(--gcds-hint-margin); color: var(--gcds-hint-text); font: var(--gcds-input-font-desktop); }
  .datum-gcds-notice { margin: 0 0 var(--gcds-spacing-100, 0.25rem); }
  .datum-gcds-notice strong { margin-inline-end: 0.25em; }
  .datum-gcds-notice gcds-icon { vertical-align: text-bottom; }
  /* The host's receipt: gcds-notice carries the look; the region is only where focus lands. */
  .datum-gcds-receipt { margin: 0 0 var(--gcds-spacing-400, 1rem); padding: 0; border: 0; background: none; box-shadow: none; }
  .datum-gcds-receipt:focus-visible { outline: var(--gcds-input-outline-width, 3px) solid var(--gcds-input-focus-border, currentColor); outline-offset: 2px; }
  .datum-gcds-receipt__details { margin: var(--gcds-spacing-200, 0.5rem) 0 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--gcds-spacing-50, 0.125rem) var(--gcds-spacing-300, 0.75rem); }
  .datum-gcds-receipt__details > div { display: contents; }
  .datum-gcds-receipt__details dt { font-weight: 700; }
  .datum-gcds-receipt__details dd { margin: 0; }
  /*
   * A panel is plain: its heading and its fields, nothing drawn around them, so no padding to inset
   * the fields and no clip to cut off a focus ring. The author's looks add the box, from the same
   * tokens the design system draws its own boxes with.
   */
  .datum-gcds-panel__body { display: block; }
  .datum-gcds-panel.panel-outlined, .datum-gcds-panel.panel-shaded, .datum-gcds-panel.panel-card { margin: 0 0 var(--gcds-spacing-400, 1rem); border-radius: var(--gcds-border-radius-md); }
  .datum-gcds-panel.panel-outlined, .datum-gcds-panel.panel-card { border: var(--gcds-border-width-sm) solid var(--gcds-border-default); }
  .datum-gcds-panel.panel-outlined, .datum-gcds-panel.panel-shaded { padding: var(--gcds-spacing-300, 0.75rem) var(--gcds-spacing-400, 1rem) var(--gcds-spacing-100, 0.5rem); }
  .datum-gcds-panel.panel-card > .datum-gcds-panel__body { padding: var(--gcds-spacing-300, 0.75rem) var(--gcds-spacing-400, 1rem) var(--gcds-spacing-100, 0.5rem); }
  .datum-gcds-panel.panel-shaded { background: var(--gcds-bg-light); }
  .datum-gcds-panel.panel-card { background: var(--gcds-bg-white); }
  .datum-gcds-panel.panel-card > .datum-gcds-panel__header { padding: var(--gcds-spacing-200, 0.5rem) var(--gcds-spacing-400, 1rem); background: var(--gcds-bg-light); border-bottom: var(--gcds-border-width-sm) solid var(--gcds-border-default); border-start-start-radius: inherit; border-start-end-radius: inherit; }
  /* A card whose heading the author hid and that has no hint has no band to draw: the header is visually hidden whole (the heading still names the section). */
  .datum-gcds-panel.panel-card > .datum-gcds-panel__header.datum-gcds-sr-only { padding: 0; background: none; border-bottom: 0; }
  /* Steps: a panel is a block; the stepper is its heading. */
  .datum-gcds-step[hidden] { display: none; }
  /* A data grid row's buttons, and a journey page's, spaced as GC Design System spaces a button group. */
  .datum-gcds-row-actions { display: flex; flex-wrap: wrap; gap: var(--gcds-spacing-200, 0.5rem); margin: 0 0 var(--gcds-spacing-300, 0.75rem); }
  .datum-gcds-page-actions { display: flex; flex-wrap: wrap; gap: var(--gcds-spacing-300, 0.75rem); margin-top: var(--gcds-spacing-400, 1rem); }
  .datum-gcds-form-errors { margin: 0 0 var(--gcds-spacing-300, 0.75rem); color: var(--gcds-error-message-text-color); font: var(--gcds-input-font-desktop); }

  /* Tier 2: Datum's date drawn in GC Design System's HTML. The pieces gcds-date-input, gcds-input and gcds-select would carry, from their tokens. */
  .datum-gcds-date { border: 0; padding: 0; margin: 0 0 var(--gcds-date-input-margin, 0.75rem); min-width: 0; color: var(--gcds-date-input-fieldset-text); }
  .datum-gcds-date__legend { padding: 0; font: var(--gcds-date-input-fieldset-font-desktop); color: var(--gcds-date-input-fieldset-text); }
  .datum-gcds-date__marker { font: var(--gcds-date-input-fieldset-required-font-desktop); margin: var(--gcds-date-input-fieldset-required-margin); }
  .datum-gcds-hint { margin: var(--gcds-date-input-fieldset-hint-margin); font: var(--gcds-input-font-desktop); color: var(--gcds-hint-text); }
  .datum-gcds-date__parts { display: flex; flex-wrap: wrap; gap: var(--gcds-spacing-300, 0.75rem); align-items: flex-start; }
  .datum-gcds-date__part { display: flex; flex-direction: column; }
  .datum-gcds-date__label { font: var(--gcds-date-input-label-font-desktop); color: var(--gcds-label-text); margin: var(--gcds-label-margin); }
  .datum-gcds-date__control {
    box-sizing: border-box; margin: 0; width: auto;
    height: var(--gcds-input-min-width-and-height);
    padding: var(--gcds-input-padding);
    font: var(--gcds-input-font-desktop);
    color: var(--gcds-input-default-text);
    background: var(--gcds-input-default-background);
    border: var(--gcds-input-border-width) solid currentColor;
    border-radius: var(--gcds-input-border-radius);
  }
  .datum-gcds-date__part--day .datum-gcds-date__control, .datum-gcds-date__part--month .datum-gcds-date__control--text { width: 4.5rem; }
  .datum-gcds-date__part--year .datum-gcds-date__control { width: 7rem; }
  .datum-gcds-date__control--select { padding: var(--gcds-select-padding); min-width: 10rem; }
  .datum-gcds-date__control:focus { outline: var(--gcds-input-outline-width) solid var(--gcds-input-focus-border); outline-offset: var(--gcds-input-border-width); box-shadow: var(--gcds-input-focus-box-shadow); }
  .datum-gcds-date__control:disabled { color: var(--gcds-input-disabled-text); background: var(--gcds-input-disabled-background); }
  .datum-gcds-date__control--invalid { border-color: var(--gcds-date-input-danger-border); }
`;
