/**
 * The Alberta Design System (3.x) binding on the engine contract: `createBinding(lit, datum)`.
 *
 * Two tiers:
 * 1. Tier 1: each Datum type drawn with the design system's own web component where it fits: text,
 *    number (`goa-input`), textarea, select (`goa-dropdown`, native), radios, checkboxes, a lone
 *    checkbox, button, each inside a `goa-form-item`; a data grid (`goa-table`); the error summary
 *    and the host's receipt (`goa-callout`); a journey page's heading and buttons.
 * 2. Tier 2: the date. `date` is Datum's date in Alberta's pieces (date.ts, css.ts); the official
 *    `<goa-date-picker>` is the separate type `goa-date-picker` (base `date`), and the dropdown's own
 *    listbox is `goa-dropdown` (base `select`). Both ship in the package's FormPlugin
 *    (`albertaPlugin`, plugin.ts). Under another binding the lookup chain draws the base.
 *
 * Nothing of the design system ships with this file: the host gives the addresses of the
 * components' script (`index.js`) and stylesheet (`index.css`) as assets, and Ionicons for
 * `goa-icon`, which the design system asks its pages to load. No version detection.
 *
 * The design system's script is a set of Svelte custom elements: each `goa-*` element upgrades
 * itself wherever it is connected, including inside the form's shadow root, so there is nothing to
 * scope or start and no `connect` at the binding. Tabs and steps are Datum's, drawn in Alberta's tokens: goa-tabs and
 * goa-form-stepper own their selection and cannot be driven from the renderer's state.
 */
import type { AdapterEntry, BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createContainers } from "./containers.js";
import { ALBERTA_CSS, ALBERTA_FALLBACK_TOKENS } from "./css.js";
import { albertaDateOrder, ALBERTA_DATE_TYPE, createDate } from "./date.js";
import { ALBERTA_DROPDOWN_TYPE } from "./plugin.js";
import { createFields } from "./fields.js";
import { createForm } from "./form.js";
import { ALBERTA_TEXTS } from "./texts.js";

export { albertaPlugin, ALBERTA_PLUGIN_ID } from "./plugin.js";

/** The tier-2 types this package offers and the engine type each reads as: the binding's `kinds`, and what a definition's `kinds` map carries. */
export const albertaKinds: Readonly<Record<string, string>> = Object.freeze({ [ALBERTA_DATE_TYPE]: "date", [ALBERTA_DROPDOWN_TYPE]: "select" });

/** The components goa-* the binding relies on: defined when the design system's script has run. */
const TAGS = ["goa-form-item", "goa-input", "goa-textarea", "goa-radio-group", "goa-radio-item", "goa-checkbox-list", "goa-checkbox", "goa-dropdown", "goa-dropdown-item", "goa-callout", "goa-button"] as const;

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit);
  const { date } = createDate(lit);
  const containers = createContainers(lit, datum);
  const form = createForm(lit);

  /** A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind. */
  const gridOnly = (): AdapterEntry => containers.dataGrid;

  return {
    id: "alberta",
    label: "Alberta Design System",
    designSystem: {
      name: "Alberta Design System",
      // What this binding relies on the design system to have drawn: its components defined, a box in each input, one radio per option.
      selfCheck(root) {
        const problems: string[] = [];
        for (const tag of TAGS) {
          if (!customElements.get(tag)) {
            problems.push(`<${tag}> is not defined`);
          }
        }
        for (const element of root.querySelectorAll("goa-input")) {
          if (!element.shadowRoot?.querySelector("input")) {
            problems.push("<goa-input> drew no <input> in its shadow root");
          }
        }
        for (const element of root.querySelectorAll("goa-radio-group")) {
          const expected = element.querySelectorAll("goa-radio-item").length;
          const drawn = Array.from(element.querySelectorAll("goa-radio-item")).filter((item) => item.shadowRoot?.querySelector('input[type="radio"]')).length;
          if (drawn !== expected) {
            problems.push(`<goa-radio-group> drew ${drawn} radios for ${expected} options`);
          }
        }
        return problems;
      }
    },
    components: {
      text: fields.text,
      number: fields.number,
      textarea: fields.textarea,
      select: fields.select,
      radio: fields.radio,
      checkboxes: fields.checkboxes,
      checkbox: fields.checkbox,
      // Tier 2: Datum's date in Alberta's pieces. The official component is the plugin's `goa-date-picker`.
      date,
      button: fields.button,
      fieldset: containers.withGrid(containers.fieldset),
      // A group type bound to a collection is a data grid, whatever its type: Datum draws each of these as a group when it is not.
      container: gridOnly(),
      panel: gridOnly(),
      grid: gridOnly(),
      step: gridOnly(),
      "button-group": gridOnly(),
      repeatingSection: gridOnly(),
      dataGrid: containers.dataGrid
    },
    kinds: albertaKinds,
    // Alberta's date picker draws month, day, year: both of the binding's dates do.
    dateOrder: albertaDateOrder,
    css: ALBERTA_CSS,
    fallbackTokens: ALBERTA_FALLBACK_TOKENS,
    texts: ALBERTA_TEXTS,
    // goa-fieldset's error callout takes focus when no control can; a link goes to the control.
    errorFocus: "summary",
    summary: form.summary,
    notice: form.notice,
    page: form.page,
    // The components draw themselves a frame after they are connected: this stands in for a `ready` of an adapter without one.
    ready: async () => {
      await Promise.all(TAGS.map((tag) => customElements.whenDefined(tag)));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
    }
  };
};
