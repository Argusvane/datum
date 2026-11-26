/**
 * The U.S. Web Design System (3.x) binding on the engine contract: `createBinding(lit)`.
 *
 * Draws USWDS's markup for the leaf components (text, textarea, number, select, radios,
 * checkboxes, a lone checkbox, memorable date, button) and containers (fieldset, tabs built from
 * the segmented button group, a data grid as usa-table, the steps container as usa-step-indicator,
 * button group), the error summary (USWDS's error alert), the host's receipt, the required note,
 * the language selector and a journey page's heading and buttons. Everything else (files,
 * signatures, chrome parts, the submitting line) is drawn by Datum's adapter tinted with USWDS's
 * colours (`fallbackTokens`) and recorded as unsupported.
 *
 * Host files (never the binding's): USWDS's stylesheet in `assets.stylesheets`; its fonts follow
 * from the stylesheet's own `@font-face` rules. The binding asks for no script. USWDS ships its
 * behaviour as `uswds.min.js`, one browserify bundle that starts itself on `document.body`
 * and exports nothing, and its handlers are delegated from the body, so they cannot see into the
 * form's shadow root and cannot be started on a scope (no scoped start where the design
 * system offers none). Every component here is therefore drawn as its no-JavaScript
 * baseline, or as its script leaves it where the behaviour is the renderer's (the character
 * count: the renderer counts and announces). Nothing is left running outside the form, so there
 * is no `connect`.
 *
 * Focus: USWDS links an error to the first control of the field, so `focusTarget` is the first
 * control (a date goes to the first box it lacks, in USWDS's order, month first).
 *
 * No tier-2 types: USWDS's components that differ from Datum's (combo box, date picker, time
 * picker, input mask, file input) are built by its script from markup the author does not write,
 * and the script cannot be scoped to a form, so no type beside the engine's is offered.
 */
import type { AdapterEntry, BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createContainers } from "./containers.js";
import { createFields, firstControl } from "./fields.js";
import { createForm } from "./form.js";
import { USWDS_TEXTS } from "./texts.js";

/** The form's own rules for what the binding draws itself, adopted after USWDS's stylesheet. Written without backticks (it is a template literal). */
const CSS = `
  /* USWDS components carry their own margins, as on a page written by hand: fields are plain blocks, so margins collapse through the form. */
  .datum-live { color: var(--color-text, #1b1b1b); }
  /* A field in a table cell or a step panel stands where it is: USWDS spaces a form group from what comes before it. */
  .datum-usa-grid td .usa-form-group, .datum-usa-grid td .usa-character-count .usa-form-group { margin-top: 0; }
  .datum-usa-grid td .usa-form-group--error { margin-left: 0; }
  .datum-usa-grid th, .datum-usa-grid td { vertical-align: top; }
  .datum-usa-grid-actions .usa-button-group { margin-top: 0; }
  /* usa-form puts a top margin on every button: a link-styled row button stands level with its fields. */
  .datum-usa-grid-actions .usa-button--unstyled { margin-top: 0; margin-right: 0.5rem; }
  .datum-usa-grid--stacked .datum-usa-grid-actions { padding-bottom: 0.75rem; }
  .datum-usa-grid-actions .datum-usa-remove { color: #b50909; }
  .datum-usa-grid { margin-bottom: 0.5rem; }
  /* The stacked layout is usa-table--stacked held at every width: the cells keep the labels of their own fields. */
  .datum-usa-grid--stacked thead { display: none; }
  .datum-usa-grid--stacked th, .datum-usa-grid--stacked td { display: block; width: 100%; border-bottom-width: 0; }
  .datum-usa-grid--stacked tr { display: block; border-bottom: 0.25rem solid #1b1b1b; }
  /* A button in a USWDS button group is the group item's own child, as USWDS writes it: the renderer's wrapper takes no box. */
  .usa-button-group__item > .datum-live-field { display: contents; }
  .datum-usa-notices { margin-top: 0.5rem; }
  .datum-usa-notices .usa-alert + .usa-alert { margin-top: 0.5rem; }
  .datum-usa-notice-details { margin: 0.5rem 0 0; }
  .datum-usa-notice-details div { display: flex; gap: 0.5rem; }
  .datum-usa-notice-details dt { font-weight: 700; }
  .datum-usa-notice-details dd { margin: 0; }
  .datum-usa-tablist { margin-top: 1.5rem; margin-bottom: 0; }
  .datum-usa-tablist .usa-button { margin-top: 0; margin-right: 0; }
  .datum-usa-tabpanel { margin-top: 1rem; }
  .datum-usa-tabpanel[hidden] { display: none; }
  .datum-usa-tab-errors { background-color: #b50909; margin-left: 0.25rem; margin-right: 0; }
  .datum-usa-steps .usa-step-indicator { margin-top: 1.5rem; }
  .datum-usa-step-panel[hidden] { display: none; }
  .datum-usa-step-actions, .datum-usa-page-actions { margin-top: 1.5rem; }
  .datum-usa-languages { align-items: center; }
  .datum-usa-language-current { font-weight: 700; }
`;

/**
 * Datum's tokens in USWDS's values, for what Datum draws inside this binding. USWDS's stylesheet
 * is built from Sass and publishes no custom properties, so these are its system-token values
 * (design tokens documented at designsystem.digital.gov/design-tokens), read from the pinned
 * release's own compiled rules: ink #1b1b1b, base-dark #565c65, primary #005ea2, error-dark
 * #b50909, success-dark #008817, focus #2491ff, the Source Sans Pro face.
 */
const FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--color-text": "#1b1b1b",
  "--color-muted": "#565c65",
  "--color-accent": "#005ea2",
  "--color-border": "#a9aeb1",
  "--color-input-border": "#565c65",
  "--color-input-bg": "#fff",
  "--color-panel": "#fff",
  "--color-panel-header": "#f0f0f0",
  "--color-light": "#f0f0f0",
  "--color-dark": "#1b1b1b",
  "--color-on-accent": "#fff",
  "--color-on-dark": "#fff",
  "--color-choice-mark": "#005ea2",
  "--color-secondary": "#565c65",
  "--color-error": "#b50909",
  "--color-error-border": "#b50909",
  "--color-error-bg": "#f4e3db",
  "--color-success": "#008817",
  "--color-warning": "#ffbe2e",
  "--color-warning-bg": "#faf3d1",
  "--color-on-warning": "#1b1b1b",
  "--color-info": "#00bde3",
  "--color-disabled-bg": "#e6e6e6",
  "--focus-ring-color": "#2491ff",
  "--font-family": '"Source Sans Pro Web", "Helvetica Neue", Helvetica, Roboto, Arial, sans-serif',
  "--font-size": "1.06rem",
  "--line-height": "1.3",
  "--radius-control": "0",
  "--radius-button": "0.25rem",
  "--radius-panel": "0",
  "--radius-message": "0",
  "--radius-frame": "0",
  "--radius-tooltip": "0.25rem",
  "--control-border-width": "1px",
  "--control-padding": "0.5rem",
  "--control-min-height": "2.5rem",
  "--button-padding": "0.75rem 1.25rem",
  "--button-font-weight": "700",
  "--font-weight-label": "400",
  "--font-size-label": "1.06rem",
  "--font-size-hint": "1.06rem",
  "--font-size-error": "1.06rem",
  "--font-weight-error": "700"
};

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit, datum);
  const containers = createContainers(lit);
  const form = createForm(lit);

  // A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind.
  const withGrid = (adapter: AdapterEntry): AdapterEntry => [...(Array.isArray(adapter) ? adapter : [adapter]), containers.grid];

  return {
    id: "uswds",
    label: "U.S. Web Design System",
    designSystem: {
      name: "U.S. Web Design System",
      // The stylesheet styles what the binding draws: a label in USWDS's face.
      selfCheck(root) {
        const label = root.querySelector(".usa-label");
        return label !== null && !getComputedStyle(label).fontFamily.includes("Source Sans")
          ? ["the stylesheet does not style .usa-label (no Source Sans face)"]
          : [];
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
    // USWDS's memorable date is month, day, year in every language: what the date's state follows.
    dateOrder: () => ["month", "day", "year"],
    css: CSS,
    // usa-form as USWDS's form templates open (usa-address-form: usa-form usa-form--large): its face, width and link colours.
    formClass: "usa-form usa-form--large",
    texts: USWDS_TEXTS,
    fallbackTokens: FALLBACK_TOKENS,
    // USWDS has no error summary of its own: its alert takes focus after a refused submit and links to the first control.
    errorFocus: "summary",
    focusTarget: (field) => firstControl(field),
    summary: form.summary,
    notice: form.notice,
    requiredNote: form.requiredNote,
    languageSwitcher: form.languageSwitcher,
    page: form.page
  };
};
