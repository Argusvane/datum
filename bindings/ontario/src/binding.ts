/**
 * The Ontario Design System binding on the engine's binding contract: `createBinding(lit, datum)`.
 *
 * Two tiers:
 * 1. Tier 1: each Datum type drawn with the design system's own web component where it fits (text,
 *    number, textarea, select, radios, checkboxes, fieldset, a data grid as stacked fieldsets, steps,
 *    button, error summary, the host's receipt, language toggle, journey page).
 * 2. Tier 2: the date. `date` is Datum's date drawn in Ontario's HTML and tokens (date.ts, css.ts):
 *    `<ontario-date-input>` validates by itself and has no property for an error someone else found. The
 *    official component is the separate type `ontario-date` (base `date`), which ships in the package's
 *    FormPlugin (`ontarioPlugin`, plugin.ts).
 *
 * Nothing of the design system ships with this file: the host gives the addresses of the components'
 * script and stylesheet as assets (stylesheets: ontario-theme.min.css, scripts: the components' ESM).
 * No version detection.
 *
 * The design system's script is a Stencil library: each `ontario-*` element upgrades itself wherever it
 * is connected, including inside the form's shadow root, so there is nothing to scope or start and
 * no `connect`. Its cross-boundary side effects are the language toggle writing `<html lang>` and
 * window events every component listens to.
 */
import type { BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createChrome } from "./chrome.js";
import { createContainers } from "./containers.js";
import { ONTARIO_CSS, ONTARIO_FALLBACK_TOKENS } from "./css.js";
import { createDate, ONTARIO_DATE_TYPE, ontarioDateOrder } from "./date.js";
import { createFields } from "./fields.js";
import type { Hydrating } from "./shared.js";
import { ONTARIO_MESSAGES, ONTARIO_TEXTS } from "./texts.js";
export { ontarioPlugin, ONTARIO_PLUGIN_ID } from "./plugin.js";

/** The tier-2 types this package offers and the engine type each reads as: the binding's `kinds`, and what a definition's `kinds` map carries. */
export const ontarioKinds: Readonly<Record<string, string>> = Object.freeze({ [ONTARIO_DATE_TYPE]: "date" });

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit);
  const { date } = createDate(lit, datum);
  const containers = createContainers(lit);
  const chrome = createChrome(lit, datum);

  return {
    id: "ontario",
    label: "Ontario Design System",
    designSystem: {
      name: "Ontario Design System",
      // What Ontario's own code changes outside the form's root. Reported, never a problem.
      sideEffects: [
        {
          target: "<html lang>",
          effect:
            "a connected <ontario-language-toggle> sets the page's <html lang> to the form's language and emits setAppLanguage on window, which every Ontario component listens to; nothing undoes it. The toggle is drawn only for a form in one English and one French locale, and its own click is kept from it."
        },
        { target: "customElements", effect: "the component library defines the ontario-* elements in the page's one registry: one release of the design system per page." },
        { target: "document.head", effect: "Stencil's loader adds one <style data-styles> (ontario-* hidden until hydrated) for the life of the page." },
        { target: "document", effect: "the library adds one keydown listener while a form is drawn, and one listener it keeps for the life of the page." }
      ],
      // What this binding relies on the design system to draw: a box with the id it gave, one input per option, the date's parts.
      selfCheck(root) {
        const problems: string[] = [];
        for (const [tag, inner] of [["ontario-input", "input"], ["ontario-textarea", "textarea"], ["ontario-dropdown-list", "select"]] as const) {
          for (const element of root.querySelectorAll(tag)) {
            const id = element.getAttribute("element-id") ?? "";
            if (id === "") {
              problems.push(`<${tag}> lost its element-id`);
            } else if (!element.shadowRoot?.querySelector(`${inner}#${CSS.escape(id)}`)) {
              problems.push(`<${tag}> drew no ${inner} with the id "${id}" given as element-id`);
            }
          }
        }
        for (const [tag, kind] of [["ontario-radio-buttons", "radio"], ["ontario-checkboxes", "checkbox"]] as const) {
          for (const element of root.querySelectorAll(tag)) {
            const expected = (JSON.parse(element.getAttribute("options") ?? "[]") as unknown[]).length;
            const drawn = element.shadowRoot?.querySelectorAll(`input[type="${kind}"]`).length ?? 0;
            if (drawn !== expected) {
              problems.push(`<${tag}> drew ${drawn} inputs for ${expected} options`);
            }
          }
        }
        for (const element of root.querySelectorAll("ontario-date-input")) {
          const id = element.getAttribute("element-id") ?? "";
          for (const part of ["year", "month", "day"]) {
            if (!element.shadowRoot?.querySelector(`input#${part}-${CSS.escape(id)}`)) {
              problems.push(`<ontario-date-input> drew no ${part} box`);
            }
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
      // Tier 2: Datum's date in Ontario's HTML and tokens. The official component is the plugin's `ontario-date`.
      date,
      button: chrome.button,
      fieldset: containers.fieldset,
      dataGrid: containers.dataGrid,
      steps: containers.steps
    },
    kinds: ontarioKinds,
    // ontario-date-input's order, which both of the binding's dates draw: year, month, day.
    dateOrder: ontarioDateOrder,
    css: ONTARIO_CSS,
    fallbackTokens: ONTARIO_FALLBACK_TOKENS,
    texts: ONTARIO_TEXTS,
    messages: ONTARIO_MESSAGES,
    summary: chrome.summary,
    notice: chrome.notice,
    page: chrome.page,
    languageSwitcher: chrome.languageSwitcher,
    // The design system loads each component's code the first time it is used. Every one of its elements says when it has
    // drawn itself (`componentOnReady`). Every field adapter has a `ready` of its own: this stands in for one without.
    ready: async (root) => {
      const elements = Array.from(root.querySelectorAll<Hydrating>("*")).filter((element) => element.localName.startsWith("ontario-"));
      await Promise.all(elements.map((element) => element.componentOnReady?.()));
    }
  };
};
