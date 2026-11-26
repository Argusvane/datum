/**
 * The look of what the Alberta Design System binding draws itself: a group (Alberta has no group
 * component), the tier-2 date's legend, help text and error, the character count, a field's
 * notices, the error summary's list, the receipt and a journey page, and Datum's own tabs and
 * steps in the design system's tokens. Every value is one of the design system's own tokens
 * (`--goa-*`, which the host's `index.css` defines on the form's host), so it follows the release
 * the host loads and nothing is restated. No backticks in the comments (this is a template literal).
 */

/** Datum's tokens (the custom properties its own adapters read) to Alberta's values: what the Datum adapters draw inside this binding (tabs, steps, files ...). */
export const ALBERTA_FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--font-family": "var(--goa-font-family-sans)",
  "--font-size": "var(--goa-font-size-4)",
  "--line-height": "var(--goa-line-height-3)",
  "--color-text": "var(--goa-color-text-default)",
  "--color-muted": "var(--goa-color-text-secondary)",
  "--color-border": "var(--goa-color-greyscale-200)",
  "--color-input-border": "var(--goa-input-color-border-default)",
  "--color-input-bg": "var(--goa-input-color-background-default)",
  "--color-panel": "var(--goa-color-greyscale-white)",
  "--color-panel-header": "var(--goa-color-greyscale-50)",
  "--color-light": "var(--goa-color-greyscale-50)",
  "--color-accent": "var(--goa-color-interactive-default)",
  "--color-on-accent": "var(--goa-color-text-light)",
  "--color-dark": "var(--goa-color-greyscale-black)",
  "--color-on-dark": "var(--goa-color-greyscale-white)",
  "--color-secondary": "var(--goa-color-text-secondary)",
  "--color-error": "var(--goa-color-emergency-dark)",
  "--color-error-border": "var(--goa-color-interactive-error)",
  "--color-error-bg": "var(--goa-color-emergency-light)",
  "--color-success": "var(--goa-color-success-default)",
  "--color-warning": "var(--goa-color-important-default)",
  "--color-warning-bg": "var(--goa-color-important-light)",
  "--color-info": "var(--goa-color-info-default)",
  "--color-disabled-bg": "var(--goa-input-color-background-disabled)",
  "--focus-ring-color": "var(--goa-color-interactive-focus)",
  "--radius-control": "var(--goa-input-border-radius-input)",
  "--radius-button": "var(--goa-button-border-radius)",
  "--radius-panel": "var(--goa-border-radius-xl)",
  "--radius-message": "var(--goa-border-radius-m)",
  "--radius-frame": "var(--goa-border-radius-xl)",
  "--radius-tooltip": "var(--goa-border-radius-m)",
  "--spacing-field-gap": "var(--goa-space-xl)",
  "--font-weight-label": "var(--goa-font-weight-semi-bold)",
  "--font-weight-error": "var(--goa-font-weight-regular)"
};

export const ALBERTA_CSS = `
  /* goa-form-item carries its own spacing inside; items sit one step apart, as in goa-block gap="xl". */
  .datum-live { display: flex; flex-direction: column; gap: var(--goa-space-xl); }
  .datum-goa-sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip-path: inset(50%); white-space: nowrap; border: 0; }

  /* The count under a text box: goa-textarea's own counter face. */
  .datum-goa-count { font: var(--goa-text-area-typography-counter); color: var(--goa-text-area-color-text-counter); margin-top: var(--goa-space-xs); }
  .datum-goa-count--over { color: var(--goa-text-area-color-text-counter-error); }

  /* A field's notices: Alberta's callout, low emphasis, under the control. Never the error colour. */
  .datum-goa-notices { display: grid; gap: var(--goa-space-xs); margin-top: var(--goa-space-s); }
  .datum-goa-notices goa-callout { display: block; }

  /* A group (Alberta has no group component): a legend as heading-s, no box. */
  .datum-goa-group { --datum-goa-gap: var(--goa-space-xl); display: flex; flex-direction: column; gap: var(--datum-goa-gap); border: 0; padding: 0; margin: 0; min-width: 0; }
  .datum-goa-date { display: block; }
  .datum-goa-group.datum-goa-date > .datum-goa-hint { margin-bottom: var(--goa-space-s); }
  .datum-goa-legend { padding: 0 0 var(--goa-space-m); font: var(--goa-typography-heading-s); color: var(--goa-color-text-default); }
  .datum-goa-hint { font: var(--goa-form-item-message-typography); color: var(--goa-form-item-help-message-color); margin: 0 0 var(--goa-space-s); }
  .datum-goa-group > .datum-goa-hint { margin-bottom: calc(var(--goa-space-m) - var(--datum-goa-gap)); }
  .datum-goa-requirement { font: var(--goa-form-item-optional-label-typography); color: var(--goa-form-item-optional-label-color); }

  /* Tier 2: Datum's date drawn in Alberta's pieces. The legend, help text and error goa-form-item writes, from its tokens. */
  .datum-goa-label { padding: 0 0 var(--goa-form-item-label-padding-bottom); font: var(--goa-form-item-label-typography); color: var(--goa-color-text-default); }
  .datum-goa-error { display: flex; align-items: flex-start; gap: var(--goa-space-2xs); margin: 0 0 var(--goa-space-xs); font: var(--goa-form-item-message-typography); color: var(--goa-form-item-error-message-color); }
  .datum-goa-error goa-icon { --fill-color: var(--goa-color-interactive-error); flex: none; }
  .datum-goa-date__parts { display: flex; flex-wrap: wrap; align-items: flex-end; gap: var(--goa-space-m); }
  .datum-goa-date__parts goa-form-item { flex: none; }

  /* The error summary: goa-callout over a list of links, as goa-fieldset draws its own (no bullets, the emergency colour). */
  .datum-goa-summary { padding: 0; }
  .datum-goa-summary li { list-style-type: none; }
  .datum-goa-summary a, .datum-goa-summary a:visited { color: var(--goa-color-emergency-dark); }

  /* The host's receipt. */
  .datum-goa-receipt { margin: 0 0 var(--goa-space-l); }
  .datum-goa-receipt:focus-visible { outline: var(--goa-border-width-l) solid var(--goa-color-interactive-focus); outline-offset: var(--goa-space-3xs); }
  .datum-goa-receipt__message { margin: 0; }
  .datum-goa-receipt__details { margin: var(--goa-space-s) 0 0; display: grid; grid-template-columns: max-content 1fr; gap: var(--goa-space-3xs) var(--goa-space-m); }
  .datum-goa-receipt__details > div { display: contents; }
  .datum-goa-receipt__details dt { font-weight: var(--goa-font-weight-bold); }
  .datum-goa-receipt__details dd { margin: 0; }

  /* A journey page. */
  .datum-goa-progress { margin: 0 0 var(--goa-space-xs); font: var(--goa-typography-body-s); color: var(--goa-color-text-secondary); }
  .datum-goa-page-title { margin: 0 0 var(--goa-space-m); font: var(--goa-typography-heading-l); letter-spacing: var(--goa-typography-heading-l-letter-spacing); color: var(--goa-color-text-default); }
  .datum-goa-page-description { margin: 0 0 var(--goa-space-l); font: var(--goa-typography-body-m); }
  .datum-goa-page-actions { display: flex; margin-top: var(--goa-space-xl); }
  .datum-goa-page-actions goa-button { margin-inline-end: var(--goa-space-m); }

  /*
   * Datum's own tabs (goa-tabs keeps its own selection and arrow keys, which the renderer owns),
   * in goa-tabs' face: its tokens, the indicator bar under the selected tab.
   */
  .datum-form__tablist[role="tablist"] { display: flex; flex-wrap: wrap; gap: var(--goa-tabs-gap); border: 0; border-bottom: var(--goa-tabs-bottom-border); margin-bottom: var(--goa-space-xl); padding: 0; }
  .datum-form__tab { position: relative; display: flex; justify-content: center; min-width: var(--goa-space-2xl); padding: var(--goa-tab-padding); margin: 0; border: 0; border-radius: 0; background: none; cursor: pointer; font: var(--goa-tab-typography); color: var(--goa-tab-color-text-not-selected); }
  .datum-form__tab.is-active, .datum-form__tab[aria-selected="true"] { background: none; font: var(--goa-tab-typography-selected); color: var(--goa-tab-color-text-selected); }
  .datum-form__tab::after { content: ""; position: absolute; left: 0; right: 0; bottom: 0; height: var(--goa-tab-indicator-width); background: transparent; border-radius: var(--goa-tab-indicator-border-radius-desktop); }
  .datum-form__tab[aria-selected="true"]::after { background: var(--goa-tab-indicator-color-active); }
  .datum-form__tab:hover:not([aria-selected="true"]) { color: var(--goa-tab-color-text-hover); }
  .datum-form__tab:hover:not([aria-selected="true"])::after { background: var(--goa-tab-indicator-color-hover); }
  .datum-form__tab:focus-visible { outline: var(--goa-tab-border-focus); border-radius: var(--goa-border-radius-xs); }
  .datum-form__tab[data-has-errors] { color: var(--goa-form-item-error-message-color); }

  /* A data grid: the row buttons, and a row's fields in a table cell with no label of their own. */
  .datum-goa-row-actions { display: flex; flex-wrap: wrap; gap: var(--goa-space-xs); }
  .datum-goa-grid { --datum-goa-gap: var(--goa-space-m); }
  .datum-goa-grid td goa-form-item { display: block; }
  .datum-goa-grid td.datum-goa-rownum { white-space: nowrap; }
  .datum-goa-grid-add { margin-top: var(--goa-space-m); }
  .datum-goa-row { margin: 0 0 var(--goa-space-l); }
`;
