/**
 * The GC Design System reference binding on the engine's binding contract: `createBinding(lit, datum)`.
 *
 * Two tiers:
 * 1. Tier 1: each Datum type drawn with the design system's own web component where it fits
 *    (text, number, textarea, select, radios, checkboxes, a lone checkbox, fieldset, data grid, steps, button,
 *    error summary, the host's receipt, language toggle, journey page). A panel is a section
 *    headed by `gcds-heading`, plain unless the author ticks a look (`cssClasses`).
 * 2. Tier 2: the date. `date` is Datum's date drawn in GC Design System's HTML and tokens (the
 *    date adapter, css.ts); the official `<gcds-date-input>` is the separate type `gcds-date`
 *    (base `date`), which ships in the package's FormPlugin (`gcdsPlugin`, plugin.ts) beside the
 *    other types only this design system has.
 *
 * Nothing of GC Design System ships with this file: the host gives the addresses of the
 * components' script and stylesheet as assets (stylesheets: gcds.css, scripts: gcds.esm.js).
 * No version detection.
 *
 * The design system's script is a Stencil library: each `gcds-*` element upgrades itself wherever
 * it is connected, including inside the form's shadow root, so there is nothing to scope or start
 * and no `connect`.
 */
import type { BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createChrome } from "./chrome.js";
import { createContainers, GCDS_PANEL_LOOKS } from "./containers.js";
import { GCDS_CSS, GCDS_FALLBACK_TOKENS } from "./css.js";
import { createDate, GCDS_DATE_TYPE, gcdsDateOrder } from "./date.js";
export { gcdsPlugin, GCDS_PLUGIN_ID } from "./plugin.js";
import { createFields } from "./fields.js";
import type { Hydrating } from "./shared.js";
import { GCDS_MESSAGES, GCDS_TEXTS } from "./texts.js";
import { createText } from "./text.js";

/** The tier-2 types this package offers and the engine type each reads as: the binding's `kinds`, and what a definition's `kinds` map carries. */
export const gcdsKinds: Readonly<Record<string, string>> = Object.freeze({ [GCDS_DATE_TYPE]: "date" });

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const text = createText(lit);
  const fields = createFields(lit);
  const { date } = createDate(lit, datum);
  const containers = createContainers(lit);
  const chrome = createChrome(lit);

  return {
    id: "gcds",
    label: "GC Design System",
    designSystem: {
      name: "GC Design System",
      // What this binding relies on GC Design System to draw: a box with the id it gave, one radio per option, the summary's links property.
      selfCheck(root) {
        const problems: string[] = [];
        for (const [tag, attribute, inner] of [["gcds-input", "input-id", "input"], ["gcds-textarea", "textarea-id", "textarea"], ["gcds-select", "select-id", "select"]] as const) {
          for (const element of root.querySelectorAll(tag)) {
            const id = element.getAttribute(attribute) ?? "";
            if (id === "") {
              problems.push(`<${tag}> lost its ${attribute}`);
            } else if (!element.shadowRoot?.querySelector(`${inner}#${CSS.escape(id)}`)) {
              problems.push(`<${tag}> drew no ${inner} with the id "${id}" given as ${attribute}`);
            }
          }
        }
        for (const element of root.querySelectorAll("gcds-radios")) {
          const expected = (JSON.parse(element.getAttribute("options") ?? "[]") as unknown[]).length;
          const drawn = element.shadowRoot?.querySelectorAll('input[type="radio"]').length ?? 0;
          if (drawn !== expected) {
            problems.push(`<gcds-radios> drew ${drawn} radios for ${expected} options`);
          }
        }
        for (const element of root.querySelectorAll("gcds-error-summary")) {
          if (!("errorLinks" in element)) {
            problems.push("<gcds-error-summary> has no errorLinks property");
          }
        }
        return problems;
      }
    },
    components: {
      text: text.text,
      number: text.number,
      textarea: fields.textarea,
      select: fields.select,
      radio: fields.radio,
      checkboxes: fields.checkboxes,
      checkbox: fields.checkbox,
      // Tier 2: Datum's date in GC Design System's HTML and tokens. The official component is the plugin's `gcds-date`.
      date,
      button: chrome.button,
      fieldset: containers.fieldset,
      panel: containers.panel,
      dataGrid: containers.dataGrid,
      steps: containers.steps
    },
    kinds: gcdsKinds,
    // gcds-date-input's order, which both of the binding's dates draw: month, day, year in English.
    dateOrder: gcdsDateOrder,
    // Paper: the PDF theme registered under this id (`pdfThemes.register(gcdsPdfTheme)`, pdf/); a host that registered none prints under datum-pdf.
    pdfTheme: "gcds",
    css: GCDS_CSS,
    fallbackTokens: GCDS_FALLBACK_TOKENS,
    texts: GCDS_TEXTS,
    messages: GCDS_MESSAGES,
    // The panel's looks; a panel with none ticked is plain.
    cssClasses: GCDS_PANEL_LOOKS,
    summary: chrome.summary,
    notice: chrome.notice,
    page: chrome.page,
    languageSwitcher: chrome.languageSwitcher,
    // GC Design System loads each component's code the first time it is used. Every one of its elements says when it has
    // drawn itself (`componentOnReady`). Every field adapter has a `ready` of its own: this stands in for one without.
    ready: async (root) => {
      const elements = Array.from(root.querySelectorAll<Hydrating>("*")).filter((element) => element.localName.startsWith("gcds-"));
      await Promise.all(elements.map((element) => element.componentOnReady?.()));
    }
  };
};
