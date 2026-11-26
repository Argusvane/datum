/**
 * The Fluent UI reference binding on the engine's binding contract: `createBinding(lit, datum)`.
 * Fluent UI Web Components 3.2.1 (Fluent 2, the design system Microsoft Teams draws with), themed by
 * the host: a theme sheet from theme/ (Teams light, dark and high contrast; web light and dark), or
 * the host's own `setTheme()` from the package.
 *
 * Two tiers, then Datum's own:
 * 1. Tier 1: Fluent's own element. Text, number and textarea (`fluent-field` with `fluent-text-input` /
 *    `fluent-textarea`, text.ts; a prefix and suffix in the text input's start and end slots), select
 *    (`fluent-dropdown`), radio, checkboxes, a lone checkbox and the button (fields.ts), tabs
 *    (`fluent-tablist`, containers.ts), the receipt (`fluent-message-bar`) and a journey page's
 *    heading and buttons (chrome.ts).
 * 2. Tier 2: Datum's component in Fluent's HTML and tokens. The date, fieldset (date.ts,
 *    containers.ts), the error summary, the language switcher, the required note (chrome.ts).
 * Datum's own adapters draw everything else (data grids, steps, files, signatures, button groups,
 *    chrome parts), tinted with `fallbackTokens`, and are listed in `unsupported()`.
 *
 * Nothing of Fluent ships with this file: the host gives the theme stylesheet and the components'
 * module script (`dist/web-components.min.js`) as assets. The script defines every `fluent-*`
 * element on the page's registry, and each upgrades wherever it connects, the form's shadow root
 * included: nothing to start, no `connect`. No language pack (Fluent words nothing a field shows;
 * the engine's English stands). No print theme and no PDF theme (the form prints under Datum's).
 */
import type { BindingFactory, FieldState, LiveBinding } from "../../../engine/form-engine/render/live/contract.js";
import { createChrome } from "./chrome.js";
import { createContainers } from "./containers.js";
import { FLUENT_CSS, FLUENT_FALLBACK_TOKENS } from "./css.js";
import { createFields } from "./fields.js";
import { readyAll } from "./shared.js";
import { createText } from "./text.js";

/** Where focus goes in a field drawn with a Fluent field: the control in its `input` slot (a Fluent host delegates focus to its box). */
const fluentFocusTarget = (field: HTMLElement, _state: FieldState): HTMLElement | null => field.querySelector<HTMLElement>("fluent-field > [slot='input']");

/**
 * What the binding relies on Fluent to have drawn: every `fluent-*` tag in the form defined (the
 * script loaded), each text component's box, a dropdown's control, a radio group with one radio per
 * option field, a tablist whose tabs upgraded and whose `activeid` names one of them, and each
 * field's label naming its control.
 */
function selfCheck(root: ShadowRoot): string[] {
  const problems: string[] = [];
  const missing = new Set<string>();
  for (const element of root.querySelectorAll<HTMLElement>("*")) {
    if (element.localName.startsWith("fluent-") && customElements.get(element.localName) === undefined) {
      missing.add(element.localName);
    }
  }
  for (const tag of missing) {
    problems.push(`<${tag}> is not defined: is the Fluent UI script loaded?`);
  }
  if (missing.size > 0) {
    // Nothing below can be read from an element that never upgraded.
    return problems;
  }
  for (const host of root.querySelectorAll<HTMLElement>("fluent-text-input, fluent-textarea")) {
    const inner = host.localName === "fluent-textarea" ? "textarea" : "input";
    if (!host.shadowRoot?.querySelector(inner)) {
      problems.push(`<${host.localName} id="${host.id}"> drew no ${inner}: is the Fluent UI script loaded?`);
    }
  }
  for (const dropdown of root.querySelectorAll<HTMLElement & { control?: unknown }>("fluent-dropdown")) {
    if (!dropdown.control) {
      problems.push(`<fluent-dropdown id="${dropdown.id}"> drew no control`);
    }
  }
  for (const group of root.querySelectorAll<HTMLElement>("fluent-radio-group")) {
    const radios = group.querySelectorAll("fluent-radio").length;
    const optionFields = group.querySelectorAll(":scope > fluent-field").length;
    if (radios === 0 || radios !== optionFields) {
      problems.push(`<fluent-radio-group id="${group.id}"> holds ${radios} radios for ${optionFields} option fields`);
    }
  }
  for (const list of root.querySelectorAll<HTMLElement>("fluent-tablist")) {
    const tabs = Array.from(list.querySelectorAll<HTMLElement>("fluent-tab"));
    for (const tab of tabs) {
      if (!tab.shadowRoot) {
        problems.push(`<fluent-tab id="${tab.id}"> drew nothing: is the Fluent UI script loaded?`);
      }
    }
    const active = list.getAttribute("activeid");
    if (active !== null && !tabs.some((tab) => tab.id === active)) {
      problems.push(`<fluent-tablist> activeid "${active}" names no tab`);
    }
  }
  for (const field of root.querySelectorAll("fluent-field")) {
    const label = field.querySelector<HTMLLabelElement>(":scope > label[slot='label']");
    const input = field.querySelector<HTMLElement>(":scope > [slot='input']");
    if (label && input && label.htmlFor !== input.id) {
      problems.push(`<fluent-field>'s label is for "${label.htmlFor}", its control is "${input.id}"`);
    }
  }
  return problems;
}

export const createBinding: BindingFactory = (lit, datum): LiveBinding => {
  const text = createText(lit);
  const chrome = createChrome(lit);
  return {
    id: "fluent",
    label: "Fluent UI",
    designSystem: {
      name: "Fluent UI",
      // What Fluent's script defines outside the form's root, measured on 3.2.1. Reported, never a problem.
      sideEffects: [
        { target: "customElements", effect: "the script defines 42 fluent-* elements in the page's one registry: one release of Fluent UI Web Components per page." },
        { target: "window", effect: "two globals: Fluent ({ setTheme }) and __FOCUSGROUP_POLYFILL__ (the focusgroup polyfill's shared state, used where the browser has no native focusgroup)." },
        { target: "trustedTypes", effect: "the policy fast-element (FAST's HTML policy), created when the script loads: a page that enforces Trusted Types lists it beside datum-assets." }
      ],
      selfCheck
    },
    components: {
      text: text.text,
      number: text.number,
      textarea: text.textarea,
      ...createFields(lit, datum),
      ...createContainers(lit, datum)
    },
    css: FLUENT_CSS,
    fallbackTokens: FLUENT_FALLBACK_TOKENS,
    errorFocus: "summary",
    focusTarget: fluentFocusTarget,
    ready: readyAll,
    ...chrome
  };
};
