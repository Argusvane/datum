/**
 * The Bootstrap (5.3) binding on the engine contract: `createBinding(lit, datum)`.
 *
 * Draws Bootstrap's markup for the leaf components (text, textarea, number, select, radios,
 * checkboxes, a lone checkbox, a date, button) and containers (fieldset, tabs as `nav-tabs`, a data
 * grid as `table` or `card`s, the steps container as `nav-pills`, button group), the error summary
 * (an `alert-danger`), the host's receipt, the required note, the language switcher and a journey
 * page's heading and buttons. Everything else (files, signatures, chrome parts, the submitting
 * line) is drawn by Datum's adapter tinted with Bootstrap's colours (`fallbackTokens`) and recorded
 * as unsupported.
 *
 * Host files (never the binding's): Bootstrap's stylesheet in `assets.stylesheets`. The binding
 * asks for no script. Bootstrap's behaviour is `bootstrap.bundle.js`, which starts itself on
 * `document` from `data-bs-*` attributes and its delegated handlers cannot see into the form's
 * shadow root; Bootstrap offers no scope to start it on (no scoped start where the design
 * system offers none). Every component here is therefore drawn as its no-JavaScript
 * baseline, with the behaviour the renderer's (the tabs, the reveal, the character count), and
 * nothing is left running outside the form, so there is no `connect`.
 *
 * Focus: Bootstrap's feedback sits under the control, so a summary link goes to the field's first
 * control (a date to the first box it lacks).
 *
 * No tier-2 types: Bootstrap has no component whose behaviour differs from Datum's (it draws
 * nothing for a date, and its scripted pieces are not drawn here), so no type beside the engine's
 * is offered.
 */
import type { AdapterEntry, BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createContainers } from "./containers.js";
import { createFields, firstControl } from "./fields.js";
import { createForm } from "./form.js";

/** The form's own rules for what the binding draws itself, adopted after Bootstrap's stylesheet. Written without backticks (it is a template literal). */
const CSS = `
  /* Bootstrap components carry their own margins (mb-3 between fields), as in its examples: fields are plain blocks, so margins collapse through the form. */
  /* A field in a table cell stands where it is: the table spaces its rows. */
  .datum-bs-grid td .mb-3, .datum-bs-grid td fieldset { margin-bottom: 0; }
  .datum-bs-grid td > .datum-live-field > .mb-3 { margin-bottom: 0; }
  /* A button that is a list item of a button group is the item's own child: the renderer's wrapper takes no box. */
  ul.d-flex > li > .datum-live-field { display: contents; }
  .datum-bs-tabs .tab-pane[hidden], .datum-bs-step-panel[hidden] { display: none; }
`;

/**
 * Datum's tokens in Bootstrap's values, for what Datum draws inside this binding. Read from
 * Bootstrap's own custom properties (`--bs-*`, set on `:root` in the pinned release's stylesheet),
 * with the release's values behind them.
 */
const FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--color-text": "var(--bs-body-color, #212529)",
  "--color-muted": "var(--bs-secondary-color, rgba(33, 37, 41, 0.75))",
  "--color-accent": "var(--bs-primary, #0d6efd)",
  "--color-border": "var(--bs-border-color, #dee2e6)",
  "--color-input-border": "var(--bs-border-color, #dee2e6)",
  "--color-input-bg": "var(--bs-body-bg, #fff)",
  "--color-panel": "var(--bs-body-bg, #fff)",
  "--color-panel-header": "var(--bs-tertiary-bg, #f8f9fa)",
  "--color-light": "var(--bs-light, #f8f9fa)",
  "--color-dark": "var(--bs-dark, #212529)",
  "--color-on-accent": "#fff",
  "--color-on-dark": "#fff",
  "--color-choice-mark": "var(--bs-primary, #0d6efd)",
  "--color-secondary": "var(--bs-secondary, #6c757d)",
  "--color-error": "var(--bs-danger, #dc3545)",
  "--color-error-border": "var(--bs-danger, #dc3545)",
  "--color-error-bg": "var(--bs-danger-bg-subtle, #f8d7da)",
  "--color-success": "var(--bs-success, #198754)",
  "--color-warning": "var(--bs-warning, #ffc107)",
  "--color-warning-bg": "var(--bs-warning-bg-subtle, #fff3cd)",
  "--color-on-warning": "#000",
  "--color-info": "var(--bs-info, #0dcaf0)",
  "--color-disabled-bg": "var(--bs-secondary-bg, #e9ecef)",
  "--focus-ring-color": "var(--bs-focus-ring-color, rgba(13, 110, 253, 0.25))",
  "--font-family": "var(--bs-body-font-family, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif)",
  "--font-size": "1rem",
  "--line-height": "1.5",
  "--radius-control": "var(--bs-border-radius, 0.375rem)",
  "--radius-button": "var(--bs-border-radius, 0.375rem)",
  "--radius-panel": "var(--bs-border-radius, 0.375rem)",
  "--radius-message": "var(--bs-border-radius, 0.375rem)",
  "--radius-frame": "var(--bs-border-radius, 0.375rem)",
  "--radius-tooltip": "var(--bs-border-radius, 0.375rem)",
  "--control-border-width": "1px",
  "--control-padding": "0.375rem 0.75rem",
  "--control-min-height": "calc(1.5em + 0.75rem + 2px)",
  "--button-padding": "0.375rem 0.75rem",
  "--button-font-weight": "400",
  "--font-weight-label": "400",
  "--font-size-label": "1rem",
  "--font-size-hint": "0.875em",
  "--font-size-error": "0.875em",
  "--font-weight-error": "400"
};

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit, datum);
  const containers = createContainers(lit);
  const form = createForm(lit);

  // A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind.
  const withGrid = (adapter: AdapterEntry): AdapterEntry => [...(Array.isArray(adapter) ? adapter : [adapter]), containers.grid];

  return {
    id: "bootstrap",
    label: "Bootstrap",
    designSystem: {
      name: "Bootstrap",
      // The stylesheet styles what the binding draws: it sets its custom properties on the page element (the form's host) and gives a label its margin.
      selfCheck(root) {
        const problems: string[] = [];
        if (getComputedStyle(root.host).getPropertyValue("--bs-body-font-family").trim() === "") {
          problems.push("the stylesheet sets none of Bootstrap's --bs-* properties on the page element");
        }
        const label = root.querySelector(".form-label");
        if (label !== null && getComputedStyle(label).marginBottom === "0px") {
          problems.push("the stylesheet does not style .form-label (no margin under the label)");
        }
        return problems;
      }
    },
    components: {
      text: fields.text,
      textarea: fields.textarea,
      number: fields.number,
      select: fields.select,
      radio: fields.radio,
      checkboxes: fields.checkboxes,
      checkbox: fields.checkbox,
      date: fields.date,
      button: fields.button,
      fieldset: withGrid(containers.fieldset),
      "button-group": withGrid(containers.buttonGroup),
      dataGrid: containers.grid,
      // A group type bound to a collection is a data grid, whatever its type: Datum draws each of these as a group when it is not.
      container: containers.grid,
      row: containers.grid,
      columns: containers.grid,
      table: containers.grid,
      panel: containers.grid,
      grid: containers.grid,
      step: containers.grid,
      repeatingSection: containers.grid,
      tabs: containers.tabs,
      steps: containers.steps
    },
    css: CSS,
    fallbackTokens: FALLBACK_TOKENS,
    // Bootstrap has no summary of its own: its alert takes focus after a refused submit and links to the first control.
    errorFocus: "summary",
    focusTarget: (field) => firstControl(field),
    summary: form.summary,
    notice: form.notice,
    requiredNote: form.requiredNote,
    languageSwitcher: form.languageSwitcher,
    page: form.page
  };
};
