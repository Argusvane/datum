// @vitest-environment jsdom
/*
 * The Datum binding's seams (render/live/datum/options.ts): `createDatumBinding` assembles every
 * Datum adapter, and each option (tokens, the dark set, frames, parts, renderers, chrome,
 * controls, field order, the language pack, author classes, composition) is proved by mounting
 * a form through `mountLive` with and without it and finding the drawn tree changed where the
 * option says, and nowhere it does not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode } from "../form-engine/core/schema/types.js";
import type { FormNotice } from "../form-engine/core/submission/form-notice.js";
import type { AdapterEntry, FieldAdapter, FieldEvents, FieldState, PageState, GroupAdapter } from "../form-engine/render/live/contract.js";
import { DATUM_PART_NAMES } from "../form-engine/render/live/datum/parts.js";
import {
  composeDatumOptions,
  createDatumBinding,
  createDatumFeatures,
  datumFieldStateBuilders,
  datumFrameOptions,
  tabsNarrowBelowOf,
  type DatumBindingOptions,
  type DatumFeatureOptions
} from "../form-engine/render/live/datum/options.js";
import { html, render } from "../form-engine/render/live/lit.js";
import type { LiveMountOptions } from "../form-engine/render/live/mount.js";
import { definitionOf, mounted, settled, unmountAll, wrapper, type Mounted } from "./live-datum-parts-kit.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

afterEach(unmountAll);

// The sheets are read back as the <style> text the renderer places where a root takes no constructed sheets.
let restoreSheets = (): void => undefined;
beforeEach(() => {
  restoreSheets = hideConstructedSheets();
});
afterEach(() => {
  restoreSheets();
});

const quiet = (): void => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};

async function draw(
  children: ComponentNode[],
  options: DatumBindingOptions = {},
  mount: Omit<Partial<LiveMountOptions>, "features" | "runtime"> & { featureOptions?: DatumFeatureOptions; root?: Record<string, unknown>; extra?: Record<string, unknown> } = {}
): Promise<Mounted & { binding: ReturnType<typeof createDatumBinding> }> {
  const { featureOptions, root, extra, ...rest } = mount;
  const binding = createDatumBinding(options);
  const m = await mounted(definitionOf(children, (extra ?? {}) as never, root ?? {}), { binding, datum: binding, features: createDatumFeatures(options, featureOptions), ...rest });
  return { ...m, binding };
}

const one = (scope: ParentNode, selector: string): HTMLElement => {
  const found = scope.querySelector<HTMLElement>(selector);
  expect(found, selector).not.toBeNull();
  return found as HTMLElement;
};
const cssOf = (root: ShadowRoot): string => Array.from(root.querySelectorAll("style[data-datum-live]")).map((style) => style.textContent ?? "").join("\n");
const formOf = (root: ShadowRoot): HTMLFormElement => one(root, "form") as HTMLFormElement;
const text = (node: Element | null | undefined): string => (node?.textContent ?? "").replace(/\s+/g, " ").trim();

const NAME: ComponentNode = { id: "name", type: "text", configuration: { label: "Name", required: true, description: "As on your passport", tooltip: "Given and family names" } };
const COLOUR: ComponentNode = {
  id: "colour",
  type: "radio",
  configuration: { label: "Colour", required: true, options: [{ value: "r", label: "Red" }, { value: "g", label: "Green" }] }
};
const COUNT: ComponentNode = { id: "count", type: "number", configuration: { label: "Count" } };
const BORN: ComponentNode = { id: "born", type: "date", configuration: { label: "Date of birth", required: true } };
const SEND: ComponentNode = { id: "send", type: "button", configuration: { label: "Send", action: "submit" } };

// ── Assembly ───────────────────────────────────────────────────────────────────────────────

describe("createDatumBinding: the assembly", () => {
  it("draws every engine type with Datum's adapters and nothing unsupported", async () => {
    quiet();
    const fields: ComponentNode[] = [
      NAME,
      { id: "bio", type: "textarea", configuration: { label: "Bio" } },
      COUNT,
      COLOUR,
      { id: "pick", type: "checkboxes", configuration: { label: "Pick", options: [{ value: "a", label: "A" }] } },
      { id: "agree", type: "checkbox", configuration: { label: "Agree" } },
      { id: "prov", type: "select", configuration: { label: "Province", options: [{ value: "on", label: "Ontario" }] } },
      BORN,
      { id: "doc", type: "file", configuration: { label: "Document" } },
      { id: "blurb", type: "html", configuration: { html: "<p>Hello</p>" } },
      { id: "pic", type: "image", configuration: { src: "https://example.org/a.png", alt: "A" } },
      { id: "fs", type: "fieldset", configuration: { label: "Group" }, children: { content: [{ id: "in_fs", type: "text", configuration: { label: "In" } }] } },
      { id: "panel", type: "panel", configuration: { label: "Panel" }, children: { content: [{ id: "in_panel", type: "text", configuration: { label: "In" } }] } },
      { id: "bg", type: "button-group", configuration: {}, children: { content: [SEND] } }
    ];
    const m = await draw(fields);
    expect(m.form.unsupported()).toEqual([]);
    expect(m.errors).toEqual([]);
    for (const id of ["name", "bio", "count", "colour", "pick", "agree", "prov", "born", "doc", "blurb", "pic", "send"]) {
      expect(m.form.adapterOf(id)?.from, id).toBe("binding");
    }
    expect(m.binding.id).toBe("datum");
    expect(m.binding.label).toBe("Datum");
    expect(formOf(m.root).classList.contains("datum-form")).toBe(true);
    // The container layout rules come with the binding's css.
    expect(cssOf(m.root)).toContain(".datum-form__layout--grid");
    // One button group: the containers' (author classes kept).
    expect(m.form.adapterOf("bg")?.name).toBe("datum-button-group");
  });

  it("is the fallback inside a design-system binding: what that binding does not draw, Datum's adapters do", async () => {
    quiet();
    const datum = createDatumBinding();
    const ds = { id: "ds", label: "DS", components: {} };
    const m = await mounted(definitionOf([BORN]), { binding: ds, datum, features: createDatumFeatures() });
    expect(m.form.adapterOf("born")).toMatchObject({ from: "datum", name: "datum-date" });
    expect(wrapper(m.root, "born").hasAttribute("data-fallback")).toBe(true);
  });
});

// ── tokens, responsive sets, dark ──────────────────────────────────────────────────────────

describe("tokens and the dark set", () => {
  it("sets the host's tokens over Datum's light set", async () => {
    const plain = await draw([NAME]);
    expect(cssOf(plain.root)).not.toContain("#123456");
    unmountAll();
    const m = await draw([NAME], { tokens: { "color-accent": "#123456" } });
    expect(cssOf(m.root)).toMatch(/\.datum-form \{[^}]*--color-accent: #123456/);
  });

  it("adds responsive token sets as media rules", async () => {
    const m = await draw([NAME], { responsiveTokens: [{ media: "(min-width: 40em)", tokens: { "spacing-field-gap": "30px" } }] });
    expect(cssOf(m.root)).toMatch(/@media \(min-width: 40em\)[^]*--spacing-field-gap: 30px/);
  });

  it("draws the dark set while the scheme is dark, with the host's dark tokens over it", async () => {
    const light = await draw([NAME], { dark: { "color-accent": "#abcdef" } });
    expect(formOf(light.root).classList.contains("datum-form--dark")).toBe(false);
    expect(cssOf(light.root)).toMatch(/\.datum-form\.datum-form--dark \{[^}]*--color-accent: #abcdef/);
    unmountAll();
    const dark = await draw([NAME], {}, { colorScheme: "dark" });
    expect(formOf(dark.root).classList.contains("datum-form--dark")).toBe(true);
  });

  it("keeps the light look in a dark scheme when `dark` is false", async () => {
    const m = await draw([NAME], { dark: false }, { colorScheme: "dark" });
    expect(formOf(m.root).classList.contains("datum-form--dark")).toBe(false);
  });

  it("appends the host's rules and its form classes", async () => {
    const m = await draw([NAME], { css: ".datum-form { outline: 1px solid red; }", formClass: "acme-form" });
    expect(cssOf(m.root)).toContain("outline: 1px solid red");
    expect(formOf(m.root).classList.contains("acme-form")).toBe(true);
  });
});

// ── frames ─────────────────────────────────────────────────────────────────────────────────

describe("frame presets", () => {
  const card = { card: { label: { default: "Card", locales: { fr: "Carte" } }, css: ".datum-form--frame-card { border: 3px double; }" } };

  it("adopts a preset's rules, and the chrome's frame puts its class on the form", async () => {
    const m = await draw([NAME], { frame: card }, { root: { chrome: { frame: "card" } } });
    expect(cssOf(m.root)).toContain(".datum-form--frame-card { border: 3px double; }");
    expect(formOf(m.root).classList.contains("datum-form--frame-card")).toBe(true);
    expect(formOf(m.root).dataset.frame).toBe("card");
  });

  it("offers the built-ins then its own to a picker, a preset under a built-in id relabelling it", () => {
    const binding = createDatumBinding({ frame: { ...card, paper: { label: "Sheet" }, "bad id": { label: "X" } } });
    expect(datumFrameOptions(binding)).toEqual([
      { id: "seamless", label: "Seamless (no frame)" },
      { id: "outlined", label: "Outlined" },
      { id: "paper", label: "Sheet" },
      { id: "card", label: "Card" }
    ]);
    expect(datumFrameOptions(binding, "fr").at(-1)).toEqual({ id: "card", label: "Carte" });
    expect(datumFrameOptions(createDatumBinding()).map((option) => option.id)).toEqual(["seamless", "outlined", "paper"]);
  });
});

// ── parts ──────────────────────────────────────────────────────────────────────────────────

describe("parts: typed templates over Datum's own drawing", () => {
  it("names every part the Datum binding draws through", () => {
    expect([...DATUM_PART_NAMES].sort()).toEqual(
      ["button", "errorMessage", "fieldShell", "journeyActions", "journeyHeading", "journeyReview", "labelMarks", "notice", "optionRow", "requiredNote", "status", "stepBack", "summary", "tooltipMark"].sort()
    );
  });

  it("labelMarks draws the marker, told whether it is announced", async () => {
    const seen: boolean[] = [];
    const m = await draw([NAME, COLOUR], {
      parts: {
        labelMarks: (part) => {
          seen.push(part.announced);
          return part.required ? html`<abbr class="acme-req" title="required">${part.marker}</abbr>` : part.default;
        }
      }
    });
    expect(wrapper(m.root, "name").querySelector("abbr.acme-req")?.textContent).toBe("*");
    expect(wrapper(m.root, "name").querySelector(".datum-form__required")).toBeNull();
    // A label's marker is hidden (marked ARIA states); a legend's is announced.
    expect(seen).toEqual(expect.arrayContaining([false, true]));
  });

  it("tooltipMark draws the help mark; its id still describes the control", async () => {
    const m = await draw([NAME], { parts: { tooltipMark: (part) => html`<button type="button" class="acme-help" aria-label=${part.label}></button><span id=${part.id} hidden>${part.tooltip}</span>` } });
    const field = wrapper(m.root, "name");
    expect(field.querySelector(".acme-help")).not.toBeNull();
    expect(field.querySelector(".datum-form__tooltip")).toBeNull();
    const input = one(field, "input");
    const bubble = field.querySelector("span[hidden]");
    expect(input.getAttribute("aria-describedby")?.split(" ")).toContain(bubble?.id);
  });

  it("errorMessage draws the inline error with the id the control names", async () => {
    const m = await draw([NAME], { parts: { errorMessage: (part) => html`<p id=${part.id} class="acme-error" role=${part.role ?? "none"}>${part.prefix} ${part.message}</p>` } });
    await m.runtime.validate();
    await settled(m.form);
    const field = wrapper(m.root, "name");
    const error = one(field, "p.acme-error");
    expect(field.querySelector(".datum-form__error")).toBeNull();
    expect(error.getAttribute("role")).toBe("alert");
    expect(one(field, "input").getAttribute("aria-describedby")?.split(" ")).toContain(error.id);
  });

  it("optionRow draws each radio row around Datum's input", async () => {
    const m = await draw([COLOUR], { parts: { optionRow: (part) => html`<div class="acme-option" data-value=${part.option.value}>${part.input}${part.text}</div>` } });
    const rows = Array.from(wrapper(m.root, "colour").querySelectorAll(".acme-option"));
    expect(rows.map((row) => row.getAttribute("data-value"))).toEqual(["r", "g"]);
    expect(rows.every((row) => row.querySelector("input[type=radio]") !== null)).toBe(true);
    expect(wrapper(m.root, "colour").querySelector(".datum-form__radio-option")).toBeNull();
  });

  it("fieldShell wraps every value-bearing field, never a button", async () => {
    const kinds: string[] = [];
    const m = await draw([NAME, COLOUR, SEND], {
      parts: {
        fieldShell: (part) => {
          kinds.push(part.kind);
          return html`<div class="acme-group">${part.default}</div>`;
        }
      }
    });
    expect(one(wrapper(m.root, "name"), ".acme-group > label.datum-form__field")).not.toBeNull();
    expect(one(wrapper(m.root, "colour"), ".acme-group > fieldset")).not.toBeNull();
    expect(wrapper(m.root, "send").querySelector(".acme-group")).toBeNull();
    expect(kinds).toEqual(expect.arrayContaining(["text", "radio"]));
  });

  it("button draws the action button from its figures; the press mark is kept", async () => {
    const m = await draw([SEND], { parts: { button: (part) => html`<button type="button" class=${`acme-btn ${part.className}`} data-button-action=${part.action ?? ""}>${part.label}!</button>` } });
    const button = one(wrapper(m.root, "send"), "button");
    expect(button.classList.contains("acme-btn")).toBe(true);
    expect(button.classList.contains("datum-form__button")).toBe(true);
    expect(text(button)).toBe("Send!");
    button.click();
    expect(m.events("datum-form-action").map((event) => (event.detail as { action: string }).action)).toEqual(["submit"]);
  });

  it("stepBack draws the steps' Back, and its go() moves back a step", async () => {
    quiet();
    const step = (id: string, label: string, field: string): ComponentNode => ({ id, type: "step", configuration: { label }, children: { content: [{ id: field, type: "text", configuration: { label: field } }] } });
    const steps: ComponentNode = { id: "flow", type: "steps", configuration: {}, children: { content: [step("one", "One", "a"), step("two", "Two", "b")] } };
    const m = await draw([steps], { parts: { stepBack: (part) => html`<a href="#" class="acme-back" @click=${(event: Event) => (event.preventDefault(), part.go())}>${part.label}</a>` } });
    one(m.root, ".datum-form__step-continue").click();
    await settled(m.form);
    const back = one(m.root, "a.acme-back");
    expect(m.root.querySelector(".datum-form__step-back")).toBeNull();
    back.click();
    await settled(m.form);
    expect(m.root.querySelector("a.acme-back")).toBeNull();
    expect(text(one(m.root, ".datum-form__step-current"))).toBe("One");
  });

  it("summary, notice and requiredNote wrap Datum's drawing", async () => {
    const receipt: FormNotice = { kind: "success", title: { default: "Thanks" } };
    const m = await draw(
      [NAME],
      {
        parts: {
          summary: (part) => html`<section class="acme-summary" data-count=${part.entries.length}>${part.default}</section>`,
          notice: (part) => html`<div class="acme-notice" data-kind=${part.state.kind}>${part.default}</div>`,
          requiredNote: (part) => html`<p class="acme-note">${part.state.note}</p>`
        }
      },
      { featureOptions: { formNotices: { notice: () => receipt } }, texts: { requiredNote: "Marked * are required" } }
    );
    expect(one(m.root, ".acme-notice > .datum-form__notice").textContent).toContain("Thanks");
    expect(text(one(m.root, "p.acme-note"))).toBe("Marked * are required");
    expect(m.root.querySelector(".datum-form__required-note")).toBeNull();
    await m.runtime.validate();
    await settled(m.form);
    const summary = one(m.root, ".acme-summary");
    expect(summary.dataset.count).toBe("1");
    expect(summary.querySelector(".datum-form__summary")).not.toBeNull();
  });

  it("status draws the in-flight line", async () => {
    const m = await draw([NAME], { parts: { status: (part) => html`<p class="acme-status" role=${part.state.echo ? "none" : "status"}>${part.state.message}</p>` } });
    m.live().setBusy("submitting", true);
    await settled(m.form);
    expect(m.root.querySelector(".acme-status")).not.toBeNull();
    expect(m.root.querySelector(".datum-form__status")).toBeNull();
  });

  it("journeyHeading and journeyActions draw a journey page's chrome over Datum's", () => {
    const binding = createDatumBinding({
      parts: {
        journeyHeading: (part) => html`<header class="acme-page">${part.default}</header>`,
        journeyActions: (part) => html`<nav class="acme-actions">${part.state.nextLabel}</nav>`
      }
    });
    const state = { journeyId: "j", pageId: "p", title: "Your details", headingId: "p__page-heading", headingLevel: 2, backLabel: "Back", nextLabel: "Continue", final: false, busy: false, words: (() => "") as never, next: () => undefined } as PageState;
    const host = document.createElement("div");
    render(html`${binding.page?.heading(state)}${binding.page?.actions(state)}`, host);
    expect(host.querySelector(".acme-page > h2#p__page-heading")?.textContent).toContain("Your details");
    expect(host.querySelector(".acme-actions")?.textContent).toBe("Continue");
    expect(host.querySelector(".datum-form__journey-actions")).toBeNull();
    // Without journey parts the binding leaves the page to the journey module's Datum drawing.
    expect(createDatumBinding().page).toBeUndefined();
  });

  it("draws Datum's part when a part throws or returns nothing", async () => {
    quiet();
    const m = await draw([NAME], {
      parts: {
        labelMarks: () => {
          throw new Error("boom");
        },
        errorMessage: () => undefined
      }
    });
    await m.runtime.validate();
    await settled(m.form);
    expect(wrapper(m.root, "name").querySelector(".datum-form__required")).not.toBeNull();
    expect(wrapper(m.root, "name").querySelector(".datum-form__error")).not.toBeNull();
    expect(m.errors).toEqual([]);
  });
});

// ── renderers and chrome ───────────────────────────────────────────────────────────────────

describe("renderers: adapters over Datum's, by type", () => {
  it("replaces a type's adapter", async () => {
    const own: FieldAdapter = { kind: "field", name: "acme-text", capabilities: { hideLabel: "drawn" }, template: (state) => html`<input id=${state.id} class="acme-input" .value=${state.value} />` };
    const m = await draw([NAME, { id: "other", type: "textarea", configuration: { label: "Other" } }], { renderers: { text: own } });
    expect(m.form.adapterOf("name")?.name).toBe("acme-text");
    expect(one(wrapper(m.root, "name"), "input.acme-input")).not.toBeNull();
    expect(m.form.adapterOf("other")?.name).toBe("datum-textarea");
  });

  it("wraps Datum's adapter, keeping its hooks", async () => {
    const wrap = (base: AdapterEntry | undefined): AdapterEntry => {
      const adapter = base as FieldAdapter;
      return { ...adapter, name: "wrapped-number", template: (state: FieldState, on: FieldEvents) => html`<div class="acme-wrap">${adapter.template(state, on)}</div>` };
    };
    const m = await draw([COUNT], { renderers: { number: wrap } });
    expect(one(wrapper(m.root, "count"), ".acme-wrap input")).not.toBeNull();
    expect(m.form.adapterOf("count")?.name).toBe("wrapped-number");
    // The number adapter's `after` still writes the value.
    m.runtime.setValue("count", 42);
    await settled(m.form);
    expect((one(wrapper(m.root, "count"), "input") as HTMLInputElement).value).toBe("42");
  });

  it("takes a container adapter under a container type", async () => {
    const group: GroupAdapter = { kind: "group", name: "acme-fieldset", template: (state, children) => html`<div class="acme-fieldset" data-legend=${state.legend ?? ""}>${children}</div>` };
    const m = await draw([{ id: "fs", type: "fieldset", configuration: { label: "Group" }, children: { content: [NAME] } }], { renderers: { fieldset: group } });
    expect(one(m.root, ".acme-fieldset").dataset.legend).toBe("Group");
    expect(m.form.adapterOf("fs")?.name).toBe("acme-fieldset");
  });

  it("takes chrome part adapters, and the language switcher wrapped", async () => {
    const definition = {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }
    };
    const m = await draw(
      [NAME],
      {
        chrome: { heading: (base) => ({ template: (state) => html`<div class="acme-heading">${base?.template(state)}</div>` }) },
        languageSwitcher: (state, base) => html`<div class="acme-lang" data-current=${state.current}>${base(state)}</div>`
      },
      { root: { chrome: { header: [{ id: "h", type: "heading", text: "Welcome" }, { id: "lang", type: "language-switcher" }] } }, extra: definition }
    );
    expect(text(one(m.root, ".acme-heading"))).toBe("Welcome");
    expect(one(m.root, ".acme-lang").dataset.current).toBe("en");
    expect(one(m.root, ".acme-lang select")).not.toBeNull();
  });
});

// ── controls ───────────────────────────────────────────────────────────────────────────────

describe("controls", () => {
  it("defaults a number to a text box with a number keyboard", async () => {
    expect(createDatumBinding().components.number).toMatchObject({ name: "datum-number-text" });
  });

  it("field controls: a number as a text box (the default), no ARIA states, plain inline errors", async () => {
    const plain = await draw([NAME, COUNT]);
    expect(one(wrapper(plain.root, "count"), "input").getAttribute("type")).toBe("text");
    unmountAll();
    const native = await draw([NAME, COUNT], { controls: { number: "number" } });
    expect(one(wrapper(native.root, "count"), "input").getAttribute("type")).toBe("number");
    unmountAll();
    const plain2 = await draw([NAME, COUNT]);
    expect(one(wrapper(plain2.root, "name"), "input").getAttribute("aria-required")).toBe("true");
    unmountAll();
    const m = await draw([NAME, COUNT], { controls: { number: "text", ariaStates: "none", inlineErrors: "plain" } });
    expect(one(wrapper(m.root, "count"), "input").getAttribute("type")).toBe("text");
    expect(one(wrapper(m.root, "name"), "input").hasAttribute("aria-required")).toBe(false);
    await m.runtime.validate();
    await settled(m.form);
    expect(one(wrapper(m.root, "name"), ".datum-form__error").hasAttribute("role")).toBe(false);
  });

  it("drawn controls are form classes; the chevron also gives the select its face", async () => {
    const select: ComponentNode = { id: "prov", type: "select", configuration: { label: "Province", options: [{ value: "on", label: "Ontario" }] } };
    const plain = await draw([select]);
    expect(formOf(plain.root).classList.contains("datum-form--error-icon-drawn")).toBe(true);
    expect(wrapper(plain.root, "prov").querySelector(".datum-form__select-face")).toBeNull();
    unmountAll();
    const m = await draw([select], { controls: { choiceMarks: "drawn", selectChevron: "drawn", errorIcon: "none" } });
    const classes = formOf(m.root).classList;
    expect(classes.contains("datum-form--choice-marks-drawn")).toBe(true);
    expect(classes.contains("datum-form--select-chevron-drawn")).toBe(true);
    expect(classes.contains("datum-form--error-icon-drawn")).toBe(false);
    expect(one(wrapper(m.root, "prov"), ".datum-form__select-face > select")).not.toBeNull();
  });

  it("container controls: a button group as a list, steps' segments as text", async () => {
    const group: ComponentNode = { id: "bg", type: "button-group", configuration: {}, children: { content: [SEND] } };
    const steps: ComponentNode = { id: "flow", type: "steps", configuration: {}, children: { content: [{ id: "s1", type: "step", configuration: { label: "One" }, children: { content: [NAME] } }] } };
    const plain = await draw([group, steps]);
    expect(one(plain.root, ".datum-form__button-group").tagName).toBe("DIV");
    expect(plain.root.querySelector(".datum-form__step button.datum-form__step-label")).not.toBeNull();
    unmountAll();
    const m = await draw([group, steps], { controls: { buttonGroup: "list", stepSegments: "text" } });
    expect(one(m.root, ".datum-form__button-group").tagName).toBe("UL");
    expect(m.root.querySelector(".datum-form__step button.datum-form__step-label")).toBeNull();
    expect(m.root.querySelector(".datum-form__step span.datum-form__step-label")).not.toBeNull();
  });

  it("the summary list, error focus and the tabs width", async () => {
    const m = await draw([NAME], { controls: { summaryList: "ordered", errorFocus: "field", tabsFrom: "40em" } });
    await m.runtime.validate();
    await settled(m.form);
    expect(one(m.root, ".datum-form__summary ol")).not.toBeNull();
    expect(m.binding.errorFocus).toBe("field");
    expect(m.binding.tabsNarrowBelow).toBe(640);
    expect(createDatumBinding().errorFocus).toBeUndefined();
    expect([tabsNarrowBelowOf("always"), tabsNarrowBelowOf(600), tabsNarrowBelowOf("641px"), tabsNarrowBelowOf("wide")]).toEqual([undefined, 600, 641, undefined]);
  });

  it("the date's controls: the browser's box, or a select of months", async () => {
    const native = await draw([BORN], { controls: { date: { control: "native" } } });
    expect(one(wrapper(native.root, "born"), "input").getAttribute("type")).toBe("date");
    unmountAll();
    const m = await draw([BORN], { controls: { date: { month: "select" } } });
    expect(one(wrapper(m.root, "born"), "select[data-value-part='month']")).not.toBeNull();
  });

  it("the switcher as links", async () => {
    const extra = { localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } };
    const m = await draw([NAME], { controls: { languageLinks: {} } }, { root: { chrome: { header: [{ id: "lang", type: "language-switcher" }] } }, extra });
    expect(m.root.querySelector(".datum-form__header select")).toBeNull();
    expect(m.root.querySelector(".datum-form__header a")).not.toBeNull();
  });
});

// ── fieldOrder ─────────────────────────────────────────────────────────────────────────────

describe("fieldOrder", () => {
  const classesInOrder = (scope: Element): string[] =>
    Array.from(scope.querySelectorAll(".datum-form__label, .datum-form__description, .datum-form__control, .datum-form__error")).map((element) => element.classList[0] as string);

  it("puts a field's parts in the order given", async () => {
    const m = await draw([NAME], { fieldOrder: ["label", "error", "description", "control"] });
    await m.runtime.validate();
    await settled(m.form);
    expect(classesInOrder(wrapper(m.root, "name"))).toEqual(["datum-form__label", "datum-form__error", "datum-form__description", "datum-form__control"]);
  });

  it("puts a date's parts in the order given, by locale, and the state's missing parts follow it", async () => {
    const options: DatumBindingOptions = { fieldOrder: { date: (locale) => (locale.startsWith("en") ? ["month", "day", "year"] : ["day", "month", "year"]) } };
    const m = await draw([BORN], options);
    const parts = Array.from(wrapper(m.root, "born").querySelectorAll("[data-value-part]")).map((element) => element.getAttribute("data-value-part"));
    expect(parts).toEqual(["month", "day", "year"]);
    expect((m.live().field("born")?.state as FieldState & { missingParts: string[] }).missingParts).toEqual(["month", "day", "year"]);
    expect(Object.keys(datumFieldStateBuilders(options))).toEqual(["date"]);
  });
});

// ── language pack, classes, composition ───────────────────────────────────────────────────

describe("language pack, author classes and composition", () => {
  it("keeps the shared looks' declarations (group and types) when a host names one of them as a bare class", () => {
    const declared = createDatumBinding({ cssClasses: ["panel-card", "acme-wide"] }).cssClasses ?? [];
    const card = declared.find((entry) => typeof entry !== "string" && entry.name === "panel-card");
    expect(card).toMatchObject({ name: "panel-card", label: "Card", types: ["panel"], group: "panel-look" });
    expect(declared.map((entry) => (typeof entry === "string" ? entry : entry.name))).toEqual(["panel-plain", "panel-outlined", "panel-shaded", "panel-card", "acme-wide"]);
    // A host's own declaration under a look's name still relabels it, in its place.
    const relabelled = createDatumBinding({ cssClasses: [{ name: "panel-card", label: "Boxed", types: ["panel"], group: "panel-look" }] }).cssClasses ?? [];
    expect(relabelled.filter((entry) => typeof entry !== "string" && entry.name === "panel-card")).toEqual([{ name: "panel-card", label: "Boxed", types: ["panel"], group: "panel-look" }]);
  });

  it("words the form from the binding's pack under the host's texts", async () => {
    const m = await draw([NAME], { texts: { en: { required: "(required)" } }, cssClasses: ["acme-wide"] });
    expect(text(one(wrapper(m.root, "name"), ".datum-form__required"))).toBe("(required)");
    // The four panel looks Datum always declares, then the host's own.
    expect(m.binding.cssClasses?.map((entry) => (typeof entry === "string" ? entry : entry.name))).toEqual(["panel-plain", "panel-outlined", "panel-shaded", "panel-card", "acme-wide"]);
    unmountAll();
    const hosted = await draw([NAME], { texts: { en: { required: "(required)" } } }, { texts: { required: "[req]" } });
    expect(text(one(wrapper(hosted.root, "name"), ".datum-form__required"))).toBe("[req]");
  });

  it("builds one option set on another", async () => {
    const base: DatumBindingOptions = {
      label: "Acme",
      tokens: { "color-accent": "#111111", "color-text": "#222222" },
      css: ".a { color: red; }",
      controls: { number: "text", date: { month: "select" } },
      renderers: { text: (entry) => ({ ...(entry as FieldAdapter), name: "acme-text" }) },
      cssClasses: ["a"],
      texts: { en: { required: "(req)" } }
    };
    const accent: DatumBindingOptions = {
      tokens: { "color-accent": "#333333" },
      css: [".b { color: blue; }"],
      dark: false,
      controls: { date: { partHints: true } },
      renderers: { text: (entry) => ({ ...(entry as FieldAdapter), name: `${(entry as FieldAdapter).name}+accent` }) },
      cssClasses: ["b", "a"],
      texts: { en: { optional: "(opt)" } }
    };
    const composed = composeDatumOptions(base, accent);
    expect(composed.label).toBe("Acme");
    expect(composed.tokens).toEqual({ "color-accent": "#333333", "color-text": "#222222" });
    expect(composed.css).toEqual([".a { color: red; }", ".b { color: blue; }"]);
    expect(composed.dark).toBe(false);
    expect(composed.controls).toEqual({ number: "text", date: { month: "select", partHints: true } });
    expect(composed.cssClasses).toEqual(["a", "b"]);
    expect(composed.texts).toEqual({ en: { required: "(req)", optional: "(opt)" } });
    const m = await draw([NAME, COUNT, BORN], composed, { colorScheme: "dark" });
    // The later wrapper wraps what the earlier one made of Datum's adapter.
    expect(m.form.adapterOf("name")?.name).toBe("acme-text+accent");
    expect(one(wrapper(m.root, "count"), "input").getAttribute("type")).toBe("text");
    expect(one(wrapper(m.root, "born"), "select[data-value-part='month']")).not.toBeNull();
    expect(formOf(m.root).classList.contains("datum-form--dark")).toBe(false);
    expect(cssOf(m.root)).toContain(".b { color: blue; }");
  });
});
