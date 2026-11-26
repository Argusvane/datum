/**
 * The GOV.UK Frontend (6.x) binding on the engine contract: `createBinding(lit)`.
 *
 * Draws GOV.UK's markup for the leaf components (text, textarea, number, select, radios,
 * checkboxes, a lone checkbox, date input, button) and containers (fieldset, tabs, a data grid as
 * stacked fieldsets, button group), the error summary, the language navigation, a journey
 * page's heading and buttons, a Check answers page's list (summary lists and summary cards), and
 * the host's receipt (a notification banner). Everything else
 * (steps, files, signatures, chrome parts) is drawn by Datum's adapter tinted with GOV.UK's colours (`fallbackTokens`)
 * and recorded as unsupported.
 *
 * Host files (never the binding's): GOV.UK Frontend's stylesheet in `assets.stylesheets`, and
 * optionally its `all.bundle.js` as a classic script in `assets.scripts` (defines
 * `window.GOVUKFrontend`). The page's `<body>` needs `class="govuk-frontend-supported"` for the
 * scoped script to start (see scripts.ts); without the script or the class the form stays on the
 * no-JavaScript baseline, which is complete.
 *
 * Cross-boundary side effects: the scoped start adds `pageshow` / `keyup` /
 * `beforematch` listeners to `window` and `document` for some components and GOV.UK has no
 * teardown, so `connect` records and removes them on unmount; it marks `<body>` only for Exit
 * this page, which the binding never draws. The binding writes nothing else outside the form's
 * shadow root. The host's page font (GDS Transport is licensed and is never shipped here) falls
 * back to Arial, as GOV.UK's own stylesheet does.
 *
 * Focus: GOV.UK links an error to the first control of the field, so `focusTarget` is the first
 * control (a date goes to the first box it lacks). English and Welsh words are GOV.UK's, French is
 * for a form in French (texts.ts).
 */
import type { AdapterEntry, BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createContainers, TABLET_BREAKPOINT_PX } from "./containers.js";
import { createFields, firstControl } from "./fields.js";
import { createForm } from "./form.js";
import { SUPPORTED_CLASS, connectScripts, frontendOf } from "./scripts.js";
export { connectScripts, frontendOf, startScripts, SUPPORTED_CLASS } from "./scripts.js";
import { GOVUK_TEXTS } from "./texts.js";

/** The form's own rules for what the binding draws itself, adopted after GOV.UK's stylesheet. */
const CSS = `
  /* GOV.UK components carry their own margins, as on a page written by hand: fields are plain blocks, so margins collapse through the form. */
  /* The page's text colour is the page's: GOV.UK's components set their own, and a disabled input inherits it (as on a GOV.UK page). */
  .datum-live { font-family: "GDS Transport", arial, sans-serif; }
  .datum-govuk-row { margin-bottom: 20px; }
  .datum-govuk-row > .govuk-button-group { margin-bottom: 0; }
  /* GOV.UK zeroes the last form-group's margin inside another form-group (its fieldset pattern); here every field is its own last of type. */
  .govuk-fieldset .datum-live-field > .govuk-form-group { margin-bottom: 20px; }
  .datum-govuk-notices { margin-bottom: 20px; }
  .datum-govuk-notices .govuk-warning-text { margin-bottom: 10px; }
  .datum-govuk-notices .govuk-inset-text { margin: 10px 0; }
  .datum-govuk-tabpanel { margin-bottom: 20px; }
  .datum-govuk-tabs--contents > .govuk-list { margin-bottom: 20px; }
  /* GOV.UK sizes a summary list's cells in content-box (a key is 30% plus its padding); Datum's sheet puts border-box on every element. */
  .govuk-summary-list__key, .govuk-summary-list__value, .govuk-summary-list__actions { box-sizing: content-box; }
`;

/** Datum's tokens in GOV.UK's values, for what Datum draws inside this binding (read from GOV.UK's own custom properties, with its literals behind). */
const FALLBACK_TOKENS: Readonly<Record<string, string>> = {
  "--color-text": "var(--govuk-text-colour, #0b0c0c)",
  "--color-muted": "var(--govuk-secondary-text-colour, #484949)",
  "--color-accent": "var(--govuk-brand-colour, #1d70b8)",
  "--color-border": "var(--govuk-border-colour, #b1b4b6)",
  "--color-input-border": "var(--govuk-input-border-colour, #0b0c0c)",
  "--color-input-bg": "var(--govuk-body-background-colour, #fff)",
  "--color-panel": "var(--govuk-body-background-colour, #fff)",
  "--color-panel-header": "#f3f2f1",
  "--color-light": "#f3f2f1",
  "--color-dark": "var(--govuk-text-colour, #0b0c0c)",
  "--color-on-accent": "#fff",
  "--color-on-dark": "#fff",
  "--color-error": "var(--govuk-error-colour, #ca3535)",
  "--color-error-border": "var(--govuk-error-colour, #ca3535)",
  "--color-error-bg": "#fff",
  "--color-success": "var(--govuk-success-colour, #0f7a52)",
  "--color-warning": "#ffdd00",
  "--color-info": "var(--govuk-brand-colour, #1d70b8)",
  "--focus-ring-color": "var(--govuk-focus-colour, #fd0)",
  "--font-family": '"GDS Transport", arial, sans-serif',
  "--font-size": "1.1875rem",
  "--line-height": "1.3157894737",
  "--radius-control": "0",
  "--radius-button": "0",
  "--radius-panel": "0",
  "--radius-message": "0",
  "--radius-frame": "0",
  "--control-border-width": "2px"
};

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit, datum);
  const containers = createContainers(lit);
  const form = createForm(lit);

  // A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind.
  const withGrid = (adapter: AdapterEntry): AdapterEntry => [...(Array.isArray(adapter) ? adapter : [adapter]), containers.grid];

  return {
    id: "govuk",
    label: "GOV.UK Frontend",
    designSystem: {
      name: "GOV.UK Frontend",
      selfCheck(root) {
        const problems: string[] = [];
        // The stylesheet styles what the binding draws: a label in GOV.UK's face.
        const label = root.querySelector(".govuk-label");
        if (label !== null && !getComputedStyle(label).fontFamily.includes("GDS Transport")) {
          problems.push("the stylesheet does not style .govuk-label (no GDS Transport face)");
        }
        // GOV.UK's script refuses to start without its body class: a host page precondition, which the form cannot set.
        if (frontendOf() !== undefined && !document.body.classList.contains(SUPPORTED_CLASS)) {
          problems.push(`GOV.UK Frontend's script is loaded but <body> lacks class "${SUPPORTED_CLASS}", so it starts nothing (the form stays on the no-JavaScript baseline)`);
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
      container: containers.grid,
      row: containers.grid,
      columns: containers.grid,
      table: containers.grid,
      panel: containers.grid,
      tabs: containers.tabs
    },
    // GOV.UK's date input is day, month, year in every language: what the date's state follows.
    dateOrder: () => ["day", "month", "year"],
    css: CSS,
    // GOV.UK styles what its script has set up only under `.govuk-frontend-supported`, which its page template puts on <body>.
    // Every such rule is a descendant one, so the form element carrying the class is enough for the styles; only the script reads <body>.
    formClass: SUPPORTED_CLASS,
    texts: GOVUK_TEXTS,
    fallbackTokens: FALLBACK_TOKENS,
    // GOV.UK's summary takes focus after a refused submit; its links go to the first control.
    errorFocus: "summary",
    tabsNarrowBelow: TABLET_BREAKPOINT_PX,
    focusTarget: (field) => firstControl(field),
    connect: (_root, formElement) => connectScripts(formElement),
    summary: form.summary,
    languageSwitcher: form.languageSwitcher,
    page: form.page,
    review: form.review,
    notice: form.notice
  };
};
