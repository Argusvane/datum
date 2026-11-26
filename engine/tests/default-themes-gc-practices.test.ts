// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { parseCssRules, styleRules } from "../form-engine/render/core/css-rules.js";
import { DATUM_DARK_CSS, DATUM_DARK_TOKENS, DATUM_TOKENS } from "../form-engine/render/live/datum/default-tokens.js";
import { DATUM_STYLES } from "../form-engine/render/live/datum/css.js";
import { FORM_TOKENS, formTokenSpec } from "../form-engine/render/live/datum/tokens.js";
import type { FormDefinition } from "../form-engine/core/schema/types.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import { createFieldConstraintsStage } from "../form-engine/validation/core/field-constraints.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import {
  DATUM_FORM_RENDERER_TAG,
  defineDatumFormRendererElement,
  type DatumFormRendererElement
} from "../form-engine/render/web-component/form-renderer-element.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";

/*
 * The Datum look against GC Design System's practices: the token sets and the stylesheet as the strings they
 * carry, because jsdom paints no shadow CSS, and the real element's help bubble, focus and steps.
 */

const themes = [
  { id: "datum-light", tokens: { ...DATUM_TOKENS } as Record<string, string> },
  { id: "datum-dark", tokens: { ...DATUM_TOKENS, ...DATUM_DARK_TOKENS } as Record<string, string> }
];

function form(children: ComponentNode[]): ComponentNode {
  return { id: "root", type: "form", configuration: {}, children: { content: children } };
}

/** The declarations of the rules whose selector list contains `selector`, as `property: value`. */
function declarationsOf(sheet: string, selector: string): string[] {
  const out: string[] = [];
  for (const rule of styleRules(parseCssRules(sheet))) {
    if (rule.selectors.includes(selector)) {
      for (const declaration of rule.declarations) {
        out.push(`${declaration.property}: ${declaration.value}`);
      }
    }
  }
  return out;
}

describe("sizes in rem", () => {
  it("states every font size of both token sets in rem, from the studio's pixel values over 16", () => {
    for (const theme of themes) {
      const sizes = Object.entries(theme.tokens).filter(([name]) => /^font-size(-|$)/.test(name) || name === "button-font-size");
      expect(sizes.length).toBeGreaterThanOrEqual(8);
      for (const [name, value] of sizes) {
        expect(value, `${theme.id} ${name}`).toMatch(/^\d*\.?\d+rem$/);
      }
    }
    const t = DATUM_TOKENS;
    expect(t["font-size"]).toBe("0.875rem");
    expect(t["font-size-label"]).toBe("0.8125rem");
    expect(t["font-size-title"]).toBe("1.125rem");
    expect(t["font-size-heading"]).toBe("1rem");
    expect(t["button-font-size"]).toBe("0.875rem");
  });
});

describe("the type and the line", () => {
  it("sets hints, errors and counts at 13px, the error at weight 600, and the lines at 65ch and 75ch", () => {
    for (const theme of themes) {
      const t = theme.tokens;
      expect(t["font-size-hint"], theme.id).toBe("0.8125rem");
      expect(t["font-size-error"], theme.id).toBe("0.8125rem");
      expect(t["font-size"], theme.id).toBe("0.875rem");
      expect(t["font-weight-error"], theme.id).toBe("600");
      expect(t["control-max-width"], theme.id).toBe("min(75ch, 100%)");
      expect(t["text-max-width"], theme.id).toBe("65ch");
    }
  });

  it("caps hint, error, count and group description text through one token the stylesheet reads, none by default", () => {
    for (const selector of [".datum-form__description", ".datum-form__error", ".datum-form__count", ".datum-form__group-description"]) {
      expect(declarationsOf(DATUM_STYLES, selector), selector).toContain("max-width: var(--text-max-width, none)");
    }
    expect(formTokenSpec("text-max-width")).toMatchObject({ group: "layout", tier: "geometry", fallback: "none", since: "0.2.0" });
  });

  it("draws a number as a text box with a decimal keypad and no spellcheck", async () => {
    const drawn = await markupOf(form([{ id: "amount", type: "number", configuration: { label: "Amount" } }]).children!.content!);
    expect(drawn.html).toContain('type="text"');
    expect(drawn.html).toContain('inputmode="decimal"');
    expect(drawn.html).toContain('spellcheck="false"');
    expect(drawn.html).toContain("datum-form__control--number");
  });
});

describe("the invalid line and the disabled look", () => {
  it("draws an invalid box in the error colour, at one class of specificity", () => {
    for (const kind of ["text", "number", "date", "select", "textarea"]) {
      expect(declarationsOf(DATUM_STYLES, `.datum-form__control--${kind}:where([aria-invalid="true"])`), kind).toEqual(["border-color: var(--color-error, #c53a3a)"]);
    }
    expect(declarationsOf(DATUM_STYLES, ":where([data-invalid]) .datum-form__affix")).toEqual(["border-color: var(--color-error, #c53a3a)"]);
    // A choice keeps its mark; only the boxed kinds change line.
    expect(DATUM_STYLES).not.toContain(".datum-form__control--checkbox:where([aria-invalid");
  });

  it("draws a disabled box sunken, muted and not-allowed, but not in read-only mode", () => {
    const selector = ':where(.datum-form:not([data-mode="readonly"])) .datum-form__control--text:where(:disabled)';
    expect(declarationsOf(DATUM_STYLES, selector)).toEqual([
      "background: var(--color-disabled-bg, var(--color-light, #eef3f8))",
      "border-color: var(--color-border, #a9bbcb)",
      "color: var(--color-muted, #536b7f)",
      "-webkit-text-fill-color: currentColor"
    ]);
    expect(declarationsOf(DATUM_STYLES, ':where(.datum-form:not([data-mode="readonly"])) .datum-form__control:where(:disabled)')).toEqual(["cursor: not-allowed"]);
    // After the kind rules, whose background it replaces.
    expect(DATUM_STYLES.indexOf(selector)).toBeGreaterThan(DATUM_STYLES.indexOf(".datum-form__control--textarea { resize"));
  });

  it("names color-disabled-bg in the manifest, derived from color-light, and sets it in both sets", () => {
    expect(formTokenSpec("color-disabled-bg")).toMatchObject({ group: "state", tier: "derived", fallback: "var(--color-light, #eef3f8)", since: "0.2.0" });
    expect(FORM_TOKENS.filter((spec) => spec.name === "color-disabled-bg")).toHaveLength(1);
    for (const theme of themes) {
      expect(theme.tokens["color-disabled-bg"], theme.id).toMatch(/^#[0-9a-f]{6}$/);
      expect(theme.tokens["color-disabled-bg"]).not.toBe(theme.tokens["color-input-bg"]);
    }
  });
});

describe("reflow and focus", () => {
  it("lets a field shrink below its content", () => {
    expect(declarationsOf(DATUM_STYLES, ".datum-form__field")).toContain("min-width: 0");
    expect(declarationsOf(DATUM_STYLES, ".datum-form__file .datum-form__control--file")).toContain("min-width: 0");
  });

  it("draws the focus ring on step labels, the help mark and links in html, and themes the date picker button's ring", () => {
    const ring = declarationsOf(DATUM_STYLES, ".datum-form__step-label:focus-visible");
    expect(ring).toContain("outline: var(--focus-ring-width, 2px) solid var(--focus-ring-color, var(--color-accent, #2f6feb))");
    expect(declarationsOf(DATUM_STYLES, ".datum-form__tooltip-mark:focus-visible")).toEqual(ring);
    // :where keeps the link rule at element-and-pseudo specificity, so a host's own link focus rule outranks it.
    expect(declarationsOf(DATUM_STYLES, ":where(.datum-form__html) a:focus-visible")).toEqual(ring);
    // The UA draws the picker button's own ring; no author state selector reaches it, so colour and offset are set outright.
    expect(declarationsOf(DATUM_STYLES, ".datum-form__control--date::-webkit-calendar-picker-indicator")).toEqual([
      "outline-color: var(--focus-ring-color, var(--color-accent, #2f6feb))",
      "outline-offset: var(--focus-ring-offset, 2px)"
    ]);
  });
});

describe("the dark set's tokens", () => {
  it("reads the affix in the text colour in the dark set, where the muted ink is 4.0:1 on the light well", () => {
    expect(DATUM_DARK_CSS.join("\n")).toContain(".datum-form__affix { color: var(--color-text); }");
  });
});

// --- jsdom: wiring, Escape, focus to the summary ---------------------------------------------

afterEach(() => {
  unmountAll();
  document.body.innerHTML = "";
});

const wait = (ms = 15) => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(read: () => T | null | undefined | false, tries = 200): Promise<T> {
  for (let attempt = 0; attempt < tries; attempt += 1) {
    const value = read();
    if (value) {
      return value;
    }
    await wait(5);
  }
  throw new Error("never became true");
}

function helpForm(): FormDefinition {
  return {
    id: "help",
    version: "1",
    schemaVersion: "1",
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Your name", description: "As on your ID", tooltip: "Use the name on your card", required: true } },
          { id: "city", type: "text", configuration: { label: "City" } }
        ]
      }
    }
  } as FormDefinition;
}

/** The element as a host mounts it: the Datum binding (Datum's theme), which it draws with by default. */
function mount(definition: FormDefinition) {
  defineDatumFormRendererElement();
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  const element = document.createElement(DATUM_FORM_RENDERER_TAG) as DatumFormRendererElement;
  element.runtime = new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([createFieldConstraintsStage(definition.root)]) });
  document.body.append(element);
  return { element, root: element.shadowRoot! };
}

/** The control in the field wrapper the DOM contract names by component id. */
const controlOf = (root: ShadowRoot, componentId: string): HTMLInputElement | null =>
  root.querySelector<HTMLInputElement>(`[data-component-id="${componentId}"] input`);

/** The help mark (the contract's `data-tooltip-mark`) in a field's wrapper. */
const markOf = (root: ShadowRoot, componentId: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-component-id="${componentId}"] [data-tooltip-mark]`);

describe("the help bubble in a real element", () => {
  it("describes the control by its hint and then the bubble, and puts no title on it", async () => {
    const { root } = mount(helpForm());
    const input = await until(() => controlOf(root, "name"));
    const described = (input.getAttribute("aria-describedby") ?? "").split(/\s+/).map((id) => root.getElementById(id)?.textContent?.trim());
    expect(described).toEqual(["As on your ID", "Use the name on your card"]);
    expect(input.hasAttribute("title")).toBe(false);
    const mark = markOf(root, "name")!;
    expect(mark.getAttribute("tabindex")).toBe("0");
    expect(mark.getAttribute("role")).toBe("button");
    expect(root.getElementById(mark.getAttribute("aria-describedby")!)?.textContent).toBe("Use the name on your card");
    expect(mark.closest("[aria-hidden]")).toBeNull();
  });

  it("dismisses the bubble with Escape while the mark holds focus, and lets it come back after focus leaves", async () => {
    const { root } = mount(helpForm());
    const mark = await until(() => markOf(root, "name"));
    const tooltip = mark.closest<HTMLElement>("[data-tooltip]")!;
    mark.focus();
    expect(root.activeElement).toBe(mark);
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    mark.dispatchEvent(escape);
    expect(tooltip.hasAttribute("data-dismissed")).toBe(true);
    expect(escape.defaultPrevented).toBe(true);
    // Focus leaving the bubble clears the dismissal.
    const city = controlOf(root, "city")!;
    mark.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true, relatedTarget: city }));
    expect(tooltip.hasAttribute("data-dismissed")).toBe(false);
  });

  it("leaves Escape alone when no bubble is open", async () => {
    const { root } = mount(helpForm());
    const city = await until(() => controlOf(root, "city"));
    const escape = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, composed: true, cancelable: true });
    city.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(root.querySelector("[data-dismissed]")).toBeNull();
  });
});

/** The error summary: the alert that lists the problems and takes focus. */
const summaryOf = (root: ShadowRoot): HTMLElement | null => root.querySelector<HTMLElement>('[role="alert"][tabindex="-1"]');

describe("an invalid submit moves focus to the error summary under the Datum binding", () => {
  it("focuses the summary, not the first invalid field", async () => {
    const { element, root } = mount(helpForm());
    await element.painted();
    await element.validate();
    const summary = await until(() => summaryOf(root));
    await until(() => root.activeElement === summary);
    expect(root.activeElement).toBe(summary);
    expect(summary.textContent).toContain("Your name");
  });
});


// --- The help mark stays out of the name; the click and the keys ----------

/** The names `aria-labelledby` composes for each element that has them, with the elements named. */
function labelledNames(html: string): { id: string; referenced: Element[]; name: string }[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const out: { id: string; referenced: Element[]; name: string }[] = [];
  for (const element of Array.from(doc.querySelectorAll("[aria-labelledby]"))) {
    const referenced = element
      .getAttribute("aria-labelledby")!
      .split(/\s+/)
      .map((id) => doc.getElementById(id))
      .filter((found): found is HTMLElement => found !== null);
    out.push({
      id: element.id || element.getAttribute("data-component-id") || element.tagName,
      referenced,
      name: referenced.map((found) => found.textContent).join(" ").replace(/\s+/g, " ").trim()
    });
  }
  return out;
}

async function bodyOf(children: ComponentNode[]): Promise<string> {
  unmountAll();
  return (await markupOf(children)).html;
}

describe("the help mark is not part of a field's name", () => {
  const tip = (node: ComponentNode): ComponentNode => ({ ...node, configuration: { ...(node.configuration as Record<string, unknown>), tooltip: "Some help" } });
  const nodes: ComponentNode[] = [
    tip({ id: "name", type: "text", configuration: { label: "Full name", required: true } }),
    tip({ id: "agree", type: "checkbox", configuration: { label: "I agree" } }),
    tip({ id: "way", type: "radio", configuration: { label: "Contact", options: [{ value: "a", label: "A" }, { value: "b", label: "B" }] } }),
    tip({ id: "likes", type: "checkboxes", configuration: { label: "Interests", options: [{ value: "a", label: "A" }] } }),
    tip({ id: "doc", type: "file", configuration: { label: "Supporting document" } })
  ];

  it("names an input, a checkbox, a legend and the engine's file input by the words alone", async () => {
    const html = await bodyOf(nodes);
    const named = labelledNames(html);
    for (const label of ["Full name", "I agree", "Contact", "Interests", "Supporting document"]) {
      const entry = named.find((candidate) => candidate.name.startsWith(label));
      expect(entry, label).toBeDefined();
      expect(entry!.name, label).not.toMatch(/Help/);
      for (const element of entry!.referenced) {
        expect(element.querySelector(".datum-form__tooltip-mark"), label).toBeNull();
      }
    }
    // The file input is a native <label for> target and says what names it.
    expect(new DOMParser().parseFromString(html, "text/html").querySelector("#doc")!.getAttribute("aria-labelledby")).toBe("doc__label");
    // The mark itself is still drawn, after the named span, inside the label.
    const doc = new DOMParser().parseFromString(html, "text/html");
    const label = doc.getElementById("name__label")!;
    expect(label.parentElement!.classList.contains("datum-form__label")).toBe(true);
    expect(label.nextElementSibling?.classList.contains("datum-form__tooltip")).toBe(true);
    expect(label.textContent).toBe("Full name *");
  });

  it("keeps the label id on the label itself where there is no help", async () => {
    const html = await bodyOf([{ id: "plain", type: "text", configuration: { label: "Plain" } }]);
    expect(html).toContain('<span id="plain__label" class="datum-form__label">Plain</span>');
  });
});

describe("the help mark in a real element: click and keys", () => {
  function checkboxForm(): FormDefinition {
    return {
      id: "tip",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: {},
        children: { content: [{ id: "agree", type: "checkbox", configuration: { label: "I agree", tooltip: "What you agree to" } }] }
      }
    } as FormDefinition;
  }

  it("does not toggle a lone checkbox, or move focus to it, when the mark or the bubble is clicked", async () => {
    const { root } = mount(checkboxForm());
    const box = await until(() => controlOf(root, "agree"));
    const mark = markOf(root, "agree")!;
    const bubble = root.getElementById(mark.getAttribute("aria-describedby")!)!;
    for (const target of [mark, bubble]) {
      const click = new MouseEvent("click", { bubbles: true, composed: true, cancelable: true });
      target.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(true);
      expect(box.checked).toBe(false);
    }
    // The label itself still toggles it: a click on the words is a click on the field.
    box.labels![0]!.click();
    expect(box.checked).toBe(true);
  });

  it("opens and closes the bubble with Enter or Space on the mark, and Space does not scroll the page", async () => {
    const { root } = mount(helpForm());
    const mark = await until(() => markOf(root, "name"));
    const tooltip = mark.closest<HTMLElement>("[data-tooltip]")!;
    for (const key of ["Enter", " "]) {
      const press = () => {
        const event = new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true });
        mark.dispatchEvent(event);
        return event;
      };
      const first = press();
      expect(first.defaultPrevented, key).toBe(true);
      expect(tooltip.hasAttribute("data-dismissed"), key).toBe(true);
      press();
      expect(tooltip.hasAttribute("data-dismissed"), key).toBe(false);
    }
    // Other keys are left alone, on the mark and anywhere else.
    const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, composed: true, cancelable: true });
    mark.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    const space = new KeyboardEvent("keydown", { key: " ", bubbles: true, composed: true, cancelable: true });
    controlOf(root, "city")!.dispatchEvent(space);
    expect(space.defaultPrevented).toBe(false);
  });
});

describe("the error summary and the hidden step", () => {
  const stepsForm = (presentation: Record<string, unknown>): FormDefinition =>
    ({
      id: "steps",
      version: "1",
      schemaVersion: "1",
      root: {
        id: "root",
        type: "form",
        configuration: presentation,
        children: {
          content: [
            {
              id: "wizard",
              type: "steps",
              configuration: {},
              children: {
                content: [
                  { id: "step_1", type: "step", configuration: { label: "One" }, children: { content: [{ id: "first", type: "text", configuration: { label: "First" } }] } },
                  { id: "step_2", type: "step", configuration: { label: "Two" }, children: { content: [{ id: "second", type: "text", configuration: { label: "Second", required: true } }] } }
                ]
              }
            }
          ]
        }
      }
    }) as FormDefinition;

  /** The steps shown: each step's container (`data-container-id`, the step's id) outside every hidden panel. */
  const shownStep = (root: ShadowRoot) =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-kind="step"][data-container-id]'))
      .filter((step) => step.closest("[hidden]") === null)
      .map((step) => step.dataset.containerId);

  it("opens the step that holds the error before focusing the summary under errorFocus summary", async () => {
    const { element, root } = mount(stepsForm({}));
    await element.painted();
    expect(shownStep(root)).toEqual(["step_1"]);
    await element.validate();
    const summary = await until(() => summaryOf(root));
    await until(() => root.activeElement === summary);
    expect(shownStep(root)).toEqual(["step_2"]);
  });
});
