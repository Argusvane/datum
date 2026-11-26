/**
 * The Nova Scotia UI Pattern Library (Bootstrap 3, saltire.css) binding on the engine contract:
 * `createBinding(lit, datum)`.
 *
 * Draws the library's markup for the leaf components (text, textarea, number, select, radios,
 * checkboxes, a lone checkbox, date, button) and containers (fieldset, a data grid as its table,
 * the steps container as its progress tracker, button group), the error summary and the receipt
 * (its alert block), the required note, the language links and a journey page's heading and
 * buttons. Everything else (tabs, files, signatures, chrome parts, the submitting line) is drawn by
 * Datum's adapter tinted with the library's colours (`fallbackTokens`) and recorded as
 * unsupported: the library has no such component.
 *
 * Host files (never the binding's): saltire.css as a stylesheet asset, and Font Awesome 4.7 (the
 * glyphs its snippets write) as a second one. The library ships no script, so the binding asks for
 * none and has no `connect`: every component is its plain HTML and CSS, nothing is started and
 * nothing is left running outside the form. The library's Bootstrap 3 sheet
 * is trimmed: what it dropped and a form needs is restated in `css.ts`.
 *
 * Focus: the library links an error to the control, so `focusTarget` is the first control (a date
 * goes to the first box it lacks).
 *
 * No tier-2 types: every component the library has is plain HTML and CSS, and Datum's behaviour
 * drives it directly. The date, which the library has no component for, is three boxes in its
 * label and box markup, a tier-1 draw compared with its own baseline (tests/tier2).
 */
import type { AdapterEntry, BindingFactory, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createContainers } from "./containers.js";
import { CSS, FALLBACK_TOKENS } from "./css.js";
import { createFields } from "./fields.js";
import { createForm } from "./form.js";
import { firstControl } from "./shared.js";
import { NOVA_SCOTIA_TEXTS } from "./texts.js";

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const fields = createFields(lit, datum);
  const containers = createContainers(lit);
  const form = createForm(lit);

  // A collection-bound container of any group type is a data grid: the lookup picks the adapter of the node's kind.
  const withGrid = (adapter: AdapterEntry): AdapterEntry => [...(Array.isArray(adapter) ? adapter : [adapter]), containers.grid];

  return {
    id: "nova-scotia",
    label: "Nova Scotia UI Pattern Library",
    designSystem: {
      name: "Nova Scotia UI Pattern Library",
      // saltire.css sets no custom properties; the one state rule the binding relies on is probed instead: `.has-error` colours its group.
      selfCheck(root) {
        const probe = document.createElement("div");
        probe.className = "has-error";
        probe.style.cssText = "position:absolute;visibility:hidden";
        root.append(probe);
        const colour = getComputedStyle(probe).color;
        probe.remove();
        return colour === "rgb(169, 68, 66)" ? [] : [`the stylesheet's .has-error colour is ${colour}, not the library's #a94442 (saltire.css is not the stylesheet)`];
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
      steps: containers.steps
    },
    // The date's boxes stand day, month, year: what the date's state follows.
    dateOrder: () => ["day", "month", "year"],
    css: CSS,
    texts: NOVA_SCOTIA_TEXTS,
    fallbackTokens: FALLBACK_TOKENS,
    // The library has no error summary of its own: its alert block takes focus after a refused submit and links to the first control.
    errorFocus: "summary",
    focusTarget: (field) => firstControl(field),
    summary: form.summary,
    notice: form.notice,
    requiredNote: form.requiredNote,
    languageSwitcher: form.languageSwitcher,
    page: form.page
  };
};
