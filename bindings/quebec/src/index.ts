/**
 * The Québec design system (qc-trousse-sdg 1.6) binding on the engine contract:
 * `createBinding(lit, datum)`.
 *
 * Two tiers:
 * 1. Tier 1: each Datum type drawn with the toolkit's own component where it fits: text, number and
 *    textarea (`qc-textfield`), radios and checkboxes (`qc-choice-group`), a lone checkbox
 *    (`qc-checkbox`), button (`button.qc-button`), the date as three `qc-textfield`s in a
 *    `fieldset.qc-fieldset` (the toolkit has no date component), a fieldset, a stacked data grid,
 *    a button group; the error summary and the host's receipt (`qc-notice`); a journey page's
 *    heading and buttons.
 * 2. Tier 2: the select. `qc-select` is a custom listbox, drastically different from a Datum select,
 *    so `select` is Datum's native select in the toolkit's face (select.ts, css.ts) and the official
 *    component is the separate type `qc-select` (base `select`), shipped in the package's FormPlugin
 *    (`quebecPlugin`, plugin.ts). Under another binding the lookup chain draws the base.
 *
 * Nothing of the design system ships with this file: the host gives the addresses of the toolkit's
 * stylesheet and script as assets. The script is a classic script (it reads `document.currentScript`
 * when it loads: `{ url, classic: true, attributes: { "sdg-css-path", "sdg-assets-base-path" } }`)
 * and every component links the stylesheet into its own shadow root from the path it was given. No
 * version detection.
 *
 * The toolkit's script is a set of Svelte custom elements: each `qc-*` element upgrades itself
 * wherever it is connected, including inside the form's shadow root, so there is nothing to scope or
 * start and no `connect` at the binding. Tabs and steps are Datum's, drawn in the toolkit's tokens: the toolkit has
 * neither.
 *
 * The stylesheet's `rem` is the page's root font size, inside a shadow root as outside: the
 * `qc-sdg-rfz100` sheets expect a 16px root (`rootFontSize: 16`), the plain ones a 10px root. The
 * host picks the sheet that matches its root and gives the same file to `sdg-css-path`.
 */
import type { AdapterEntry, BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createContainers } from "./containers.js";
import { QUEBEC_CSS, QUEBEC_FALLBACK_TOKENS } from "./css.js";
import { createFields } from "./fields.js";
import { createForm } from "./form.js";
import { QUEBEC_SELECT_TYPE } from "./plugin.js";
import { createSelects } from "./select.js";
import { QUEBEC_MESSAGES, QUEBEC_TEXTS } from "./texts.js";

export { quebecPlugin, QUEBEC_PLUGIN_ID } from "./plugin.js";

/** The tier-2 type this package offers and the engine type it reads as: the binding's `kinds`, and what a definition's `kinds` map carries. */
export const quebecKinds: Readonly<Record<string, string>> = Object.freeze({ [QUEBEC_SELECT_TYPE]: "select" });

/** The components qc-* the binding relies on: defined when the toolkit's script has run. */
const TAGS = ["qc-textfield", "qc-choice-group", "qc-checkbox", "qc-notice", "qc-icon"] as const;

/** Classes an author may put in `configuration.cssClass`: the sizes and shapes the toolkit's attributes ask for. */
const CSS_CLASSES = ["qc-size-xs", "qc-size-sm", "qc-size-md", "qc-size-lg", "qc-size-xl", "qc-compact", "qc-selection-button", "qc-selection-button-inline"] as const;

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit, datum);
  const { select } = createSelects(lit);
  const containers = createContainers(lit, datum);
  const form = createForm(lit);

  /** A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind. */
  const gridOnly = (): AdapterEntry => containers.dataGrid;

  return {
    id: "quebec",
    label: "Québec design system",
    designSystem: {
      name: "Québec design system",
      // The stylesheets' rem is the page's root font size: rfz100 sheets expect 16px.
      rootFontSize: 16,
      // What the toolkit's own code changes outside the form's root. Reported, never a problem.
      sideEffects: [
        {
          target: "<html> class",
          effect:
            "the toolkit's script adds qc-dark-theme to <html> when the page loads under a dark system preference and never removes it; the form draws the host's colorScheme by the same class on the form element, so it is not dark by accident."
        },
        { target: "customElements", effect: "the script defines the qc-* elements in the page's one registry: one release of the toolkit per page." },
        { target: "window.__svelte", effect: "the Svelte runtime's version registry, defined by the script." },
        { target: "document, <body>, window", effect: "the Svelte runtime's delegated listeners (document click, keydown, change, focusout, reset; body click, keydown; window scroll), kept after the form is unmounted." }
      ],
      // What this binding relies on the toolkit to have drawn: its components defined as classic-script elements, a box in each field, a rem that measures as the sheet expects.
      selfCheck(root) {
        const problems: string[] = [];
        for (const tag of TAGS) {
          if (!customElements.get(tag)) {
            problems.push(`<${tag}> is not defined: the toolkit's script is not loaded as a classic script`);
          }
        }
        for (const element of root.querySelectorAll("qc-textfield")) {
          const input = element.querySelector("input, textarea");
          if (input && !input.id) {
            problems.push("<qc-textfield> lost its input's id");
          }
        }
        // The stylesheet's rem is the page's root font size: the rfz100 sheet makes body text 1rem (16px) at a 16px root.
        const probe = root.querySelector(".qc-label-text, input, textarea");
        if (probe) {
          const size = parseFloat(getComputedStyle(probe).fontSize);
          if (Math.abs(size - 16) > 0.5) {
            problems.push(`text measures ${size}px, not 16px: the stylesheet's rem does not match the page's root font size (${getComputedStyle(document.documentElement).fontSize}); load qc-sdg-rfz100 for a 16px root, qc-sdg for a 10px one`);
          }
        }
        return problems;
      }
    },
    components: {
      text: fields.text,
      number: fields.number,
      textarea: fields.textarea,
      // Tier 2's drawing: Datum's native select in the toolkit's face. The official component is the plugin's `qc-select`.
      select,
      radio: fields.radio,
      checkboxes: fields.checkboxes,
      checkbox: fields.checkbox,
      date: fields.date,
      button: fields.button,
      fieldset: containers.withGrid(containers.fieldset),
      "button-group": containers.withGrid(containers.buttonGroup),
      // A group type bound to a collection is a data grid, whatever its type: Datum draws each of these as a group when it is not.
      container: gridOnly(),
      panel: gridOnly(),
      grid: gridOnly(),
      step: gridOnly(),
      repeatingSection: gridOnly(),
      dataGrid: containers.dataGrid
    },
    kinds: quebecKinds,
    // The toolkit's dark scheme is a class: its tokens are set on `.qc-dark-theme` as well as on `:root.qc-dark-theme`.
    formClass: ({ colorScheme }) => (colorScheme === "dark" ? "qc-dark-theme" : ""),
    css: QUEBEC_CSS,
    fallbackTokens: QUEBEC_FALLBACK_TOKENS,
    texts: QUEBEC_TEXTS,
    messages: QUEBEC_MESSAGES,
    cssClasses: CSS_CLASSES,
    // qc-notice's box takes the focus after a refused submit; a link goes to the control.
    errorFocus: "summary",
    focusTarget: (field) => field.querySelector<HTMLElement>("input:not([type=hidden]), select, textarea"),
    summary: form.summary,
    notice: form.notice,
    requiredNote: form.requiredNote,
    languageSwitcher: form.languageSwitcher,
    page: form.page,
    // The components draw themselves after they are connected: this stands in for a `ready` of an adapter without one.
    ready: async () => {
      await Promise.all(TAGS.map((tag) => customElements.whenDefined(tag)));
    }
  };
};
