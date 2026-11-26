/**
 * The binding's own rules, adopted after saltire.css, and Datum's tokens in the library's values.
 * Written without backticks (each block is a template literal).
 *
 * saltire.css is Bootstrap 3.3.5 trimmed to what the province's pattern library uses: it keeps the
 * feedback states (`.has-error`, `.has-warning`, `.has-success`) and the bare-element rules for
 * labels, legends, fieldsets and the text boxes, and leaves out the layout classes its own
 * snippets still write (`.form-group`, `.form-control`, `.help-block`, `.radio`, `.checkbox`,
 * `.sr-only`, `.input-group`). `RESTATED_CSS` puts back the few of those a form needs, from
 * Bootstrap 3.3.5's own sources (less/forms.less, less/input-groups.less, less/utilities.less), with
 * the colours and sizes of the library's sheet. `OWN_CSS` is what the library has no markup for.
 *
 * The references (reference/*.html) carry this whole sheet as a `<style>` of their own, because the
 * kit draws a reference with the design system's files only: what the library leaves out is the
 * same on both sides of the comparison.
 */

/** Bootstrap 3.3.5 rules the library's sheet dropped, restated. */
export const RESTATED_CSS = `
  .sr-only { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
  .form-group { margin-bottom: 1.5em; }
  .form-control { max-width: 100%; }
  .help-block { display: block; margin-top: 5px; margin-bottom: 10px; }
  .radio, .checkbox { display: block; margin-top: 10px; margin-bottom: 10px; }
  .radio label, .checkbox label { margin-bottom: 0; font-weight: 400; cursor: pointer; }
  .radio .help-block, .checkbox .help-block { margin-top: 0; }
  /* A legend that names a group of choices is the group's label, not a section heading (the library's legend is 1.5em with a rule). */
  legend.control-label { font-size: inherit; font-weight: bold; color: inherit; border: 0; margin-bottom: 5px; }
  /* Bootstrap's input group, for a prefix and a suffix: the box and its addons in one row. */
  .input-group { display: inline-flex; align-items: stretch; max-width: 100%; }
  .input-group .form-control { flex: 1 1 auto; min-width: 0; margin: 0; }
  .input-group-addon { padding: 1px 12px; line-height: 1.6875; color: #555; text-align: center; white-space: nowrap; background-color: #eee; border: 1px solid #a2a2a2; }
  .input-group > .input-group-addon:first-child { border-right: 0; }
  .input-group > .input-group-addon:last-child { border-left: 0; }
  /* The button size classes carry a page-level margin (54px auto): inside a form a button stands where it is written. */
  .btn.btn-lg { margin: 0; }
`;

/** The rules that hold a table as blocks, for the grid asked for stacked and, narrow, the grid left to the form. */
const STACKED = (scope: string): string => `  ${scope} thead { display: none; }
  ${scope}, ${scope} tbody, ${scope} tr, ${scope} td, ${scope} th { display: block; width: 100%; }
  ${scope} tr { border-top: 1px solid #ddd; padding: 0.5em 0; }
  ${scope} td, ${scope} th { border: 0; padding: 0.25em 8px; }`;

/** What the library draws no markup for, and the few places a notice or a summary needs a colour its sheet gives only to a whole group. */
export const OWN_CSS = `
  .datum-ns-required { border: 0; text-decoration: none; cursor: default; color: #a94442; }
  /* Notices: the library's warning colour and its icon, never the error colour, whichever group they sit in. */
  .datum-ns-notice.help-block { margin-top: 5px; margin-bottom: 5px; }
  .datum-ns-notice.datum-ns-notice--warning.help-block { color: #8a6d3b; }
  .datum-ns-notice.datum-ns-notice--info.help-block { color: #444; }
  .datum-ns-notice .fa { margin-right: 0.25em; }
  .datum-ns-count--over.help-block { color: #a94442; }
  .datum-ns-choice-error .fa { margin-right: 0.25em; }
  /* The summary and the receipt are the library's alert block; its heading is a heading element drawn as the block's bold line. */
  .alert-block > .alert-message > .datum-ns-alert-title { margin: 0.25em 0 0; font-size: 1em; line-height: inherit; }
  .alert-block > .alert-message > .datum-ns-alert-title + * { margin-top: 0.5em; }
  .alert-block ul { margin: 0.5em 0 0; }
  .datum-ns-details { margin: 0.5em 0 0; }
  .datum-ns-details div { display: flex; gap: 0.5em; }
  .datum-ns-details dt { font-weight: 700; }
  .datum-ns-details dd { margin: 0; }
  /* A date: three boxes in a row, each under its own label (the library has no date). */
  .datum-ns-date { display: flex; flex-wrap: wrap; gap: 0 1em; }
  .datum-ns-date-part label { font-weight: 400; }
  .datum-ns-date-part .form-control { max-width: 100%; }
  /* A data grid: the library's table, or the same table held as blocks. Left to the form (auto) it is a table while its box is wide, with the cells' own labels read out but not shown (the column headings name them), and blocks with the labels shown when the box is narrow. */
  .datum-ns-grid-box { container-type: inline-size; }
  .datum-ns-grid { margin-bottom: 0.5em; }
  .datum-ns-grid th, .datum-ns-grid td { vertical-align: top; }
  .datum-ns-grid td .form-group { margin-bottom: 0; }
  .datum-ns-grid-actions { white-space: nowrap; }
  .datum-ns-grid-actions .btn + .btn { margin-left: 0.25em; }
  .datum-ns-grid--auto td label.control-label { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0, 0, 0, 0); border: 0; }
${STACKED(".datum-ns-grid--stacked")}
  @container (max-width: 40em) {
${STACKED(".datum-ns-grid--auto")}
    .datum-ns-grid--auto td label.control-label { position: static; width: auto; height: auto; margin: 0 0 5px; overflow: visible; clip: auto; }
  }
  /* Steps: the library's progress tracker, then the shown step, then the buttons. */
  .datum-ns-steps-indicator { display: flow-root; }
  .datum-ns-steps-indicator .pagination { margin: 0 0 1.5em; display: block; }
  .datum-ns-step-panel[hidden] { display: none; }
  .datum-ns-actions { display: flex; flex-wrap: wrap; gap: 0.75em; margin: 1.5em 0 0; }
  .datum-ns-button-group { display: flex; flex-wrap: wrap; gap: 0.75em; margin-bottom: 1.5em; }
  .datum-ns-caption { display: block; color: #777; font-size: 0.875em; }
  .datum-ns-languages { margin: 0 0 1.5em; }
  .datum-ns-languages ul { display: flex; gap: 1em; list-style: none; margin: 0; padding: 0; }
  .datum-ns-languages [aria-current] { font-family: "open_sansbold", Helvetica, Arial, Tahoma, sans-serif; }
  .datum-ns-required-note { margin: 0 0 1.5em; }
`;

/** The whole sheet the binding adopts. */
export const CSS = RESTATED_CSS + OWN_CSS;

/**
 * Datum's tokens in the library's values, for what Datum draws inside this binding. saltire.css
 * sets no custom properties, so these are the values of its own rules: body text #444 (line 1201),
 * links #0058a4, focus #f8d44c, error #a94442, warning #8a6d3b, success #468430, input border
 * #a2a2a2, headings #000, panel greys #eee/#f9f9f9/#ddd, the Open Sans face, line height 1.6875.
 */
export const FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--color-text": "#444",
  "--color-muted": "#777777",
  "--color-accent": "#0058a4",
  "--color-border": "#ddd",
  "--color-input-border": "#a2a2a2",
  "--color-input-bg": "#fff",
  "--color-panel": "#fff",
  "--color-panel-header": "#f9f9f9",
  "--color-light": "#eee",
  "--color-dark": "#000",
  "--color-on-accent": "#fff",
  "--color-on-dark": "#fff",
  "--color-secondary": "#0058a4",
  "--color-error": "#a94442",
  "--color-error-border": "#a94442",
  "--color-error-bg": "#f2dede",
  "--color-success": "#4a8b32",
  "--color-warning": "#f8d44c",
  "--color-warning-bg": "#fcf8e3",
  "--color-on-warning": "#000",
  "--color-info": "#0058a4",
  "--color-disabled-bg": "#eee",
  "--focus-ring-color": "#f8d44c",
  "--font-family": '"open_sansregular", Helvetica, Arial, Tahoma, sans-serif',
  "--font-size": "1em",
  "--line-height": "1.6875",
  "--radius-control": "0",
  "--radius-button": "4px",
  "--radius-panel": "0",
  "--radius-message": "0",
  "--radius-frame": "0",
  "--radius-tooltip": "4px",
  "--control-border-width": "1px",
  "--control-padding": "1px 2px",
  "--button-padding": "5px 12px",
  "--font-weight-label": "700",
  "--font-weight-error": "400"
};
