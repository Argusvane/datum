/**
 * The Québec design system binding's own CSS: rules for what the binding draws itself, written from
 * the toolkit's tokens (`--qc-*`, set on `:root` in the release's stylesheet, which the renderer
 * reads as `:host`), each with the release's value behind it. They are counted in `budgetKb`.
 *
 * This is a template literal: no backticks in the rules or the comments.
 */

/** Datum's tokens in Québec's values, for what Datum draws inside this binding (tabs, steps, files, signatures, chrome parts). */
export const QUEBEC_FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--color-text": "var(--qc-color-text-primary, #223654)",
  "--color-muted": "var(--qc-color-grey-medium, #6b778a)",
  "--color-accent": "var(--qc-color-blue-regular, #1472bf)",
  "--color-border": "var(--qc-color-grey-light, #c5cad2)",
  "--color-input-border": "var(--qc-color-formfield-border, #6b778a)",
  "--color-input-bg": "var(--qc-color-background, #fff)",
  "--color-panel": "var(--qc-color-background, #fff)",
  "--color-panel-header": "var(--qc-color-grey-pale, #f1f1f2)",
  "--color-light": "var(--qc-color-grey-pale, #f1f1f2)",
  "--color-dark": "var(--qc-color-blue-dark, #223654)",
  "--color-on-accent": "var(--qc-color-white, #fff)",
  "--color-on-dark": "var(--qc-color-white, #fff)",
  "--color-choice-mark": "var(--qc-color-blue-regular, #1472bf)",
  "--color-secondary": "var(--qc-color-grey-medium, #6b778a)",
  "--color-error": "var(--qc-color-red-regular, #cb381f)",
  "--color-error-border": "var(--qc-color-red-regular, #cb381f)",
  "--color-error-bg": "var(--qc-color-red-pale, #ffdbd6)",
  "--color-success": "var(--qc-color-green-regular, #4f813d)",
  "--color-warning": "var(--qc-color-yellow-regular, #e0ad03)",
  "--color-warning-bg": "var(--qc-color-yellow-pale, #f8e69a)",
  "--color-on-warning": "var(--qc-color-blue-dark, #223654)",
  "--color-info": "var(--qc-color-blue-regular, #1472bf)",
  "--color-disabled-bg": "var(--qc-color-grey-pale, #f1f1f2)",
  "--focus-ring-color": "var(--qc-color-formfield-focus-outline, #4a98d9)",
  "--font-family": "var(--qc-font-family-content, 'Open Sans', sans-serif)",
  "--font-size": "var(--qc-font-size-md, 1rem)",
  "--line-height": "var(--qc-line-height-md, 1.5rem)",
  "--radius-control": "0",
  "--radius-button": "0",
  "--radius-panel": "0",
  "--radius-message": "0",
  "--radius-frame": "0",
  "--radius-tooltip": "0",
  "--control-border-width": "1px",
  "--control-padding": "0.4375rem",
  "--control-min-height": "2.375rem",
  "--button-padding": "0.5rem 1.5rem",
  "--button-font-weight": "600",
  "--font-weight-label": "700",
  "--font-size-label": "var(--qc-font-size-md, 1rem)",
  "--font-size-hint": "var(--qc-font-size-sm, 0.875rem)",
  "--font-size-error": "var(--qc-font-size-md, 1rem)",
  "--font-weight-error": "600"
};

export const QUEBEC_CSS = `
  /* The toolkit's components carry their own margins (2rem under a field): fields are plain blocks, so margins collapse through the form as they do on a page. */
  .datum-live-field { margin: 0; }
  /*
   * The dark scheme: the toolkit sets its dark palette on .qc-dark-theme, which the form element carries. Its semantic tokens
   * (background, formfield borders, links) are aliases declared once on :root, resolved there, so on a class below the root
   * they are declared again to follow the dark palette. The form paints the page's colours itself.
   */
  .datum-live.qc-dark-theme { background-color: var(--qc-color-background); color: var(--qc-color-text-primary); }
  .qc-dark-theme {
    --qc-color-blue-extra-pale: var(--qc-color-blue-pale); --qc-color-grey-extra-pale: var(--qc-color-grey-pale);
    --qc-color-red-pale: var(--qc-color-pink-pale); --qc-color-red-light: var(--qc-color-pink-regular);
    --qc-color-background: var(--qc-color-white); --qc-color-success: var(--qc-color-green-regular);
    --qc-color-error: var(--qc-color-red-regular); --qc-color-danger: var(--qc-color-red-dark);
    --qc-color-link-text: var(--qc-color-blue-piv); --qc-color-link-hover: var(--qc-color-blue-piv);
    --qc-color-link-visited: var(--qc-color-purple); --qc-color-link-active: var(--qc-color-red-regular);
    --qc-color-link-focus-outline: var(--qc-color-blue-light); --qc-color-formfield-border: var(--qc-color-grey-medium);
    --qc-color-formfield-focus-border: var(--qc-color-blue-dark); --qc-color-formfield-focus-outline: var(--qc-color-blue-light);
    --qc-color-searchinput-icon: var(--qc-color-blue-piv);
  }
  qc-textfield:not(:defined), qc-choice-group:not(:defined), qc-checkbox:not(:defined) { visibility: hidden; }

  /* .qc-description is styled only under qc-textfield in the toolkit; restated for the places Datum puts one (a group's hint, an option's, a select's, a date's). */
  .qc-description { display: block; font-size: var(--qc-font-size-sm, 0.875rem); line-height: var(--qc-line-height-sm, 1.25rem); font-weight: var(--qc-font-weight-regular, 400); color: var(--qc-color-blue-dark, #223654); max-inline-size: var(--qc-max-content-width, 825px); }
  qc-choice-group > .qc-description { margin-block: -0.5rem 0; }
  .datum-qc-option-hint { margin-block-start: 0.25rem; }
  /* A lone checkbox's hint, slotted under its label: lined up with the label's text, past the box and its gap. */
  qc-checkbox > .qc-description { margin-block-start: 0.25rem; margin-inline-start: calc(var(--qc-spacer-md, 1.5rem) + var(--qc-spacer-xs, 0.5rem)); }
  qc-checkbox[compact] > .qc-description { margin-inline-start: calc(var(--qc-spacer-sm, 1rem) + var(--qc-spacer-xs, 0.5rem)); }
  .datum-qc-group-hint { margin-bottom: var(--qc-spacer-sm, 1rem); }
  .qc-fieldset > legend { margin-bottom: var(--qc-spacer-xs, 0.5rem); }
  .datum-qc-date > .qc-description { margin-bottom: var(--qc-spacer-xs, 0.5rem); }

  /* An invalid date marks the boxes that need work with the toolkit's red box (its [invalid] > input rule cannot reach a box whose parent is not marked). */
  .datum-qc-invalid input { border: 2px solid var(--qc-color-red-regular, #cb381f); padding: 0.375rem; }
  .datum-qc-date .qc-formfield-row { margin-bottom: 0; }

  /* Warnings and info: the toolkit's notice, set under the field it concerns. */
  .datum-qc-notices { display: grid; gap: var(--qc-spacer-xs, 0.5rem); margin-top: var(--qc-spacer-xs, 0.5rem); margin-bottom: var(--qc-spacer-md, 1.5rem); }
  qc-textfield .datum-qc-notices { margin-bottom: 0; }
  .datum-qc-notice-text { margin: 0; }

  /* The select in the toolkit's face (tier 2, the text box's tokens): the toolkit styles no native select. */
  .datum-qc-select { display: block; margin-bottom: 2rem; max-width: 100%; }
  .datum-qc-select > .qc-label { margin-bottom: 0.25rem; }
  .datum-qc-select__control { display: block; box-sizing: border-box; width: 100%; max-width: var(--qc-size-max-width-md, 15.5625rem); min-height: 2.375rem; margin-top: 0.25rem; padding: 0.4375rem; color: var(--qc-color-text-primary, #223654); background-color: var(--qc-color-background, #fff); border: 1px solid var(--qc-color-formfield-border, #6b778a); border-radius: 0; font: inherit; }
  .datum-qc-select__control:focus, .datum-qc-select__control:focus-visible { outline: 2px solid var(--qc-color-formfield-focus-outline, #4a98d9); border: 2px solid var(--qc-color-formfield-focus-border, #223654); padding: 0.375rem; }
  .datum-qc-select__control:disabled { cursor: not-allowed; background-color: var(--qc-color-grey-pale, #f1f1f2); border: 1px solid var(--qc-color-grey-regular, #8893a2); }
  .datum-qc-select--invalid .datum-qc-select__control { border: 2px solid var(--qc-color-red-regular, #cb381f); padding: 0.375rem; }
  .datum-qc-select-description { margin-bottom: 0.25rem; }

  /* The summary and the receipt are the toolkit's notice; its box is a block, so the form spaces it. */
  .datum-qc-summary, .datum-qc-receipt { display: block; margin-bottom: var(--qc-spacer-md, 1.5rem); }
  .datum-qc-receipt-details { margin: var(--qc-spacer-xs, 0.5rem) 0 0; }
  .datum-qc-receipt-details > div { display: flex; gap: var(--qc-spacer-xs, 0.5rem); }
  .datum-qc-receipt-details dt { font-weight: var(--qc-font-weight-bold, 700); }
  .datum-qc-receipt-details dd { margin: 0; }
  .datum-qc-required-note { margin: 0 0 var(--qc-spacer-md, 1.5rem); }

  .datum-qc-language { display: flex; gap: var(--qc-spacer-sm, 1rem); margin-bottom: var(--qc-spacer-sm, 1rem); }
  .datum-qc-progress { margin: 0 0 var(--qc-spacer-xs, 0.5rem); }
  .datum-qc-page-title { margin: 0 0 var(--qc-spacer-sm, 1rem); }
  .datum-qc-page-actions { margin: var(--qc-spacer-md, 1.5rem) 0; }
  .qc-button.qc-disabled { cursor: not-allowed; }

  /* A data grid stacked: a fieldset per row, the row buttons under the cells. */
  .datum-qc-row { margin-bottom: var(--qc-spacer-md, 1.5rem); padding-left: var(--qc-spacer-sm, 1rem); border-left: 2px solid var(--qc-color-grey-light, #c5cad2); }
  .datum-qc-row-actions { margin-top: var(--qc-spacer-xs, 0.5rem); column-gap: var(--qc-spacer-sm, 1rem); }
  .datum-qc-grid-add { margin-top: var(--qc-spacer-sm, 1rem); }
`;
