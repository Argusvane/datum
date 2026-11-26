// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ComponentNode, FormDefinition } from "../form-engine/core/schema/types.js";
import { sourceHash } from "../form-engine/core/localization/translations.js";
import { SubmissionModeRegistry } from "../form-engine/core/submission/submission-modes.js";
import { FormRuntime } from "../form-engine/runtime/browser/form-runtime.js";
import { ValidationPipeline } from "../form-engine/validation/core/validation-pipeline.js";
import type { FieldAdapter, LiveBinding, TextFieldState } from "../form-engine/render/live/contract.js";
import { chromeFeature, LOCALE_APPLIED_EVENT, LOCALE_REJECTED_EVENT, type ChromeFeatureOptions } from "../form-engine/render/live/chrome.js";
import { lit, type Lit } from "../form-engine/render/live/lit.js";
import { mountLive, type LiveContext, type LiveFeature, type LiveForm, type LiveMountOptions } from "../form-engine/render/live/mount.js";

/*
 * Form chrome and frames (render/live/chrome.ts): the header and footer
 * regions drawn from the form's own parts and the host's, the form's title over the fields, the
 * language switch and its outcome events, the binding's chrome adapters and switcher, the
 * submission lock, and the frame on the form element.
 */

function textAdapter({ html, live }: Lit): FieldAdapter<TextFieldState> {
  return {
    kind: "field",
    name: "ds-text",
    template: (s, on) => html`<label for=${s.id}>${s.label}</label><input id=${s.id} .value=${live(s.value)} @input=${(event: Event) => on.input((event.target as HTMLInputElement).value)} />`
  };
}

function bindingOf(l: Lit, extra: Partial<LiveBinding> = {}): LiveBinding {
  return { id: "test-ds", label: "Test DS", components: { text: textAdapter(l) }, ...extra };
}

type Chrome = Record<string, unknown>;

function formWith(configuration: Record<string, unknown>, extra: Partial<FormDefinition> = {}): FormDefinition {
  const children: ComponentNode[] = [{ id: "name", type: "text", configuration: { label: "Name" } }];
  return { id: "f", version: "1", schemaVersion: "1", root: { id: "root", type: "form", configuration, children: { content: children } }, localization: { defaultLocale: "en" }, ...extra };
}

function runtimeOf(definition: FormDefinition): FormRuntime {
  const modes = new SubmissionModeRegistry();
  modes.register({ id: "submit", validate: true, sign: false, serverValidation: false });
  return new FormRuntime(definition, { submissionModes: modes, validationPipeline: new ValidationPipeline([]) });
}

interface Mounted {
  runtime: FormRuntime;
  host: HTMLElement;
  root: ShadowRoot;
  form: LiveForm;
  live: () => LiveContext;
  events: Array<{ type: string; detail: unknown }>;
}

const forms: LiveForm[] = [];

async function mounted(
  definition: FormDefinition,
  chrome: ChromeFeatureOptions = {},
  options: Partial<LiveMountOptions> = {}
): Promise<Mounted> {
  const runtime = runtimeOf(definition);
  const host = document.createElement("div");
  document.body.append(host);
  const root = host.attachShadow({ mode: "open" });
  const events: Mounted["events"] = [];
  for (const type of [LOCALE_APPLIED_EVENT, LOCALE_REJECTED_EVENT]) {
    host.addEventListener(type, (event) => events.push({ type, detail: (event as CustomEvent).detail }));
  }
  let context: LiveContext | undefined;
  const grab: LiveFeature = {
    id: "grab",
    start: (live) => {
      context = live;
    }
  };
  const form = mountLive(root, { binding: bindingOf(lit), features: [chromeFeature(chrome), grab], ...options, runtime });
  forms.push(form);
  await form.ready;
  return { runtime, host, root, form, live: () => context as LiveContext, events };
}

async function settled(form: LiveForm): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await form.updated();
}

afterEach(() => {
  for (const form of forms.splice(0)) {
    form.unmount();
  }
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

const quiet = (): void => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
};

const authored = (parts: Chrome[]): Record<string, unknown> => ({ chrome: { header: parts } });

// ── The regions ────────────────────────────────────────────────────────────────────────────

describe("live chrome: the header and footer regions", () => {
  it("loads a data: picture but never links to one, and guards a new-tab link in html", async () => {
    quiet();
    const dataImage = "data:image/svg+xml;base64,PHN2Zy8+";
    const { root } = await mounted(
      formWith(
        authored([
          { id: "logo", type: "image", src: dataImage, alt: "Acme", href: dataImage },
          { id: "rich", type: "html", html: '<a href="https://example.org/t" target="_blank" rel="opener">terms</a>' }
        ])
      )
    );
    const header = root.querySelector<HTMLElement>(".datum-form__header");
    const img = header?.querySelector("img");
    expect(img?.getAttribute("src")).toBe(dataImage);
    expect(img?.parentElement?.hasAttribute("href")).toBe(false);
    expect(header?.querySelector("figure a")).toBeNull();
    const link = header?.querySelector(".datum-form__chrome-html a");
    expect(link?.getAttribute("rel")).toBe("noopener noreferrer");
  });

  it("draws the form's own parts in rows, in order, in the header and the footer", async () => {
    quiet();
    const { root } = await mounted(
      formWith({
        chrome: {
          header: [
            { id: "logo", type: "image", src: "https://example.org/logo.png", alt: "Acme", href: "https://example.org", width: 120 },
            { id: "intro", type: "heading", text: "Welcome", level: 2 },
            { id: "para", type: "text", text: "Fill this in." },
            { id: "rich", type: "html", html: '<p>See <a href="https://example.org/help">help</a><script>alert(1)</script></p>' }
          ],
          footer: [{ id: "fine", type: "text", text: "Fine print", align: "end" }]
        }
      })
    );
    const header = root.querySelector<HTMLElement>(".datum-form__header");
    const rows = Array.from(header?.children ?? []);
    expect(rows.map((row) => row.firstElementChild?.getAttribute("data-chrome-part"))).toEqual(["image", "heading", "text", "html"]);
    expect(rows.every((row) => row.classList.contains("datum-form__chrome-row--start"))).toBe(true);
    const img = header?.querySelector("img");
    expect(img?.getAttribute("src")).toBe("https://example.org/logo.png");
    expect(img?.getAttribute("alt")).toBe("Acme");
    expect(img?.getAttribute("width")).toBe("120");
    expect(img?.hasAttribute("height")).toBe(false);
    expect(img?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(img?.parentElement?.getAttribute("href")).toBe("https://example.org");
    expect(header?.querySelector("h2.datum-form__chrome-heading")?.textContent).toBe("Welcome");
    expect(header?.querySelector("p.datum-form__chrome-text")?.textContent).toBe("Fill this in.");
    // The markup went through the allowlist.
    expect(header?.querySelector(".datum-form__chrome-html a")?.getAttribute("href")).toBe("https://example.org/help");
    expect(header?.querySelector("script")).toBeNull();
    const footer = root.querySelector(".datum-form__footer");
    expect(footer?.querySelector(".datum-form__chrome-row--end")?.textContent).toContain("Fine print");
    // Header, then the fields, then the footer.
    const form = root.querySelector("form") as HTMLFormElement;
    const order = Array.from(form.children).map((child) => child.className);
    expect(order.indexOf("datum-form__header")).toBeLessThan(order.findIndex((name) => name.includes("datum-live-container") || name.includes("datum-live-field")));
    expect(order.at(-1)).toBe("datum-form__footer");
  });

  it("draws nothing for a region with nothing to draw, and drops a picture whose address is unsafe", async () => {
    quiet();
    const none = await mounted(formWith({}));
    expect(none.root.querySelector(".datum-form__header, .datum-form__footer")).toBeNull();
    const unsafe = await mounted(formWith(authored([{ id: "logo", type: "image", src: "javascript:alert(1)" }, { id: "blank", type: "text", text: "  " }])));
    expect(unsafe.root.querySelector(".datum-form__header")).toBeNull();
  });

  it("draws a group of parts on one row, justified, dropping the empty ones", async () => {
    quiet();
    const { root } = await mounted(
      formWith(authored([{ id: "bar", type: "group", justify: "start", verticalAlign: "end", parts: [{ id: "a", type: "text", text: "Left" }, { id: "b", type: "text", text: " " }, { id: "c", type: "text", text: "Right" }] }]))
    );
    const group = root.querySelector(".datum-form__chrome-group");
    expect(group?.className).toContain("datum-form__chrome-group--start");
    expect(group?.className).toContain("datum-form__chrome-group--valign-end");
    expect(Array.from(group?.querySelectorAll(".datum-form__chrome-text") ?? []).map((p) => p.textContent)).toEqual(["Left", "Right"]);
  });

  it("adds the host's parts after the form's, reading the host's chrome again at every draw", async () => {
    quiet();
    let hostChrome: unknown = { header: [{ type: "text", text: { default: "From the host" } }] };
    const { root, form } = await mounted(formWith(authored([{ id: "mine", type: "text", text: "From the form" }])), { chrome: () => hostChrome });
    expect(Array.from(root.querySelectorAll(".datum-form__header .datum-form__chrome-text")).map((p) => p.textContent)).toEqual(["From the form", "From the host"]);
    hostChrome = undefined;
    form.redraw();
    expect(Array.from(root.querySelectorAll(".datum-form__header .datum-form__chrome-text")).map((p) => p.textContent)).toEqual(["From the form"]);
  });

  it("words an authored part from the form's translations", async () => {
    quiet();
    const definition = formWith(authored([{ id: "intro", type: "text", text: "Hello" }]), {
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
      translations: { fr: { chrome: { intro: { text: { text: "Bonjour", source: sourceHash("Hello") } } } } }
    });
    const { root, runtime, form } = await mounted(definition);
    expect(root.querySelector(".datum-form__chrome-text")?.textContent).toBe("Hello");
    runtime.setLocale("fr");
    await settled(form);
    expect(root.querySelector(".datum-form__chrome-text")?.textContent).toBe("Bonjour");
  });
});

// ── The title ──────────────────────────────────────────────────────────────────────────────

describe("live chrome: the form's title", () => {
  it("heads the form with the title typed in Form settings, at the level the host sets", async () => {
    quiet();
    const { root } = await mounted(formWith({ title: "Grant application" }), { headingLevel: () => 2 });
    const title = root.querySelector("h2.datum-form__title");
    expect(title?.textContent).toBe("Grant application");
    // After the chrome header, before the fields.
    const form = root.querySelector("form") as HTMLFormElement;
    expect(form.firstElementChild).toBe(title);
  });

  it("does not read the title twice when a form-title part already says it, and draws that part as a heading", async () => {
    quiet();
    const { root } = await mounted(formWith({ title: "Grant application", chrome: { header: [{ id: "t", type: "form-title" }, { id: "d", type: "form-description" }], footer: [] }, description: "Apply here." }));
    expect(root.querySelectorAll(".datum-form__title")).toHaveLength(1);
    expect(root.querySelector('h1[data-chrome-part="form-title"]')?.textContent).toBe("Grant application");
    expect(root.querySelector('[data-chrome-part="form-description"]')?.textContent).toBe("Apply here.");
  });

  it.each([[""], ["   "], ["\n"]])("draws no heading at all for a blank title (%j), implicit or as a form-title part", async (blank) => {
    quiet();
    const implicit = await mounted(formWith({ title: blank }));
    expect(implicit.root.querySelectorAll("h1, h2, h3, h4, h5, h6, .datum-form__title")).toHaveLength(0);
    const part = await mounted(formWith({ title: blank, chrome: { header: [{ id: "t", type: "form-title" }], footer: [] } }));
    expect(part.root.querySelectorAll("h1, h2, h3, h4, h5, h6, .datum-form__title")).toHaveLength(0);
    // A title that is translated away to nothing is no title either.
    const translated = await mounted(formWith({ title: "Hello" }, { localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] }, translations: { fr: { form: { title: { text: blank, source: sourceHash("Hello") } } } } }));
    translated.runtime.setLocale("fr");
    await settled(translated.form);
    expect([...translated.root.querySelectorAll("h1, h2, h3")].filter((heading) => (heading.textContent ?? "").trim() === "")).toHaveLength(0);
  });

  it("draws nothing for a form-title part when the form has no title", async () => {
    quiet();
    const { root } = await mounted(formWith(authored([{ id: "t", type: "form-title" }])));
    expect(root.querySelector(".datum-form__header")).toBeNull();
  });
});

// ── The language switch ────────────────────────────────────────────────────────────────────

describe("live chrome: the language switch", () => {
  const bilingual = (parts: Chrome[] = [{ id: "lang", type: "language-switcher" }]): FormDefinition =>
    formWith(authored(parts), { localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }] } });

  it("draws a labelled select over the form's locales and switches the form, telling the host", async () => {
    quiet();
    const { root, runtime, events, form } = await mounted(bilingual());
    const select = root.querySelector<HTMLSelectElement>("select[data-locale-switch]") as HTMLSelectElement;
    const label = root.querySelector<HTMLLabelElement>("label.datum-form__language-switcher-label");
    expect(label?.htmlFor).toBe(select.id);
    expect(label?.textContent).toBe("Language");
    expect(Array.from(select.options).map((option) => [option.value, option.textContent, option.lang])).toEqual([["en", "English", "en"], ["fr", "Français", "fr"]]);
    expect(select.value).toBe("en");
    // The switcher's row sits at the end by default.
    expect(root.querySelector(".datum-form__chrome-row--end")).not.toBeNull();
    select.value = "fr";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(runtime.state().locale).toBe("fr");
    expect(events).toEqual([{ type: LOCALE_APPLIED_EVENT, detail: { locale: "fr" } }]);
    await settled(form);
    expect(root.querySelector("form")?.getAttribute("lang")).toBe("fr");
    expect(root.querySelector<HTMLSelectElement>("select[data-locale-switch]")?.value).toBe("fr");
  });

  it("reports a locale the runtime refuses and puts the select back", async () => {
    quiet();
    const { root, runtime, events } = await mounted(bilingual());
    const select = root.querySelector<HTMLSelectElement>("select[data-locale-switch]") as HTMLSelectElement;
    vi.spyOn(runtime, "setLocale").mockImplementation(() => {
      throw new Error('Locale "fr" is not supported');
    });
    select.value = "fr";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(events).toEqual([{ type: LOCALE_REJECTED_EVENT, detail: { locale: "fr", message: 'Locale "fr" is not supported' } }]);
    expect(select.value).toBe("en");
    expect(runtime.state().locale).toBe("en");
  });

  it("draws no switcher over fewer than two locales, or when the host leaves translations out", async () => {
    quiet();
    const one = await mounted(formWith(authored([{ id: "lang", type: "language-switcher" }])));
    expect(one.root.querySelector("select")).toBeNull();
    const off = await mounted(bilingual(), { translations: () => false });
    expect(off.root.querySelector("select")).toBeNull();
  });

  it("uses the part's own label and hides it visually on request", async () => {
    quiet();
    const { root } = await mounted(bilingual([{ id: "lang", type: "language-switcher", label: "Langue", hideLabel: true }]));
    const label = root.querySelector("label.datum-form__language-switcher-label");
    expect(label?.textContent).toBe("Langue");
    expect(label?.classList.contains("datum-form__visually-hidden")).toBe(true);
  });

  it("draws the binding's own switcher in the part's place, handing it the figures and the switch", async () => {
    quiet();
    const binding = bindingOf(lit, {
      languageSwitcher: (state) => lit.html`<nav class="ds-languages" data-current=${state.current} data-id=${state.controlId}>${state.locales.map(
        (entry) => lit.html`<a href="#" data-code=${entry.code} @click=${(event: Event) => { event.preventDefault(); state.switchTo(entry.code); }}>${entry.label}</a>`
      )}</nav>`
    });
    const { root, runtime } = await mounted(bilingual(), {}, { binding });
    expect(root.querySelector("select")).toBeNull();
    expect(root.querySelector(".ds-languages")?.getAttribute("data-id")).toBe("datum-form-language-header");
    root.querySelector<HTMLElement>('a[data-code="fr"]')?.click();
    expect(runtime.state().locale).toBe("fr");
  });

  it("locks the regions while a submission is in flight, so a locale cannot change under the answers", async () => {
    quiet();
    const { root, form, live } = await mounted(bilingual());
    expect(root.querySelector(".datum-form__header")?.hasAttribute("inert")).toBe(false);
    live().setBusy("submitting", true);
    await settled(form);
    expect(root.querySelector(".datum-form__header")?.hasAttribute("inert")).toBe(true);
    const select = root.querySelector<HTMLSelectElement>("select[data-locale-switch]") as HTMLSelectElement;
    select.value = "fr";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    expect(live().runtime.state().locale).toBe("en");
    live().setBusy("submitting", false);
    await settled(form);
    expect(root.querySelector(".datum-form__header")?.hasAttribute("inert")).toBe(false);
  });
});

// ── The binding's chrome adapters ──────────────────────────────────────────────────────────

describe("live chrome: the binding draws the parts", () => {
  it("hands an adapter the part's figures and the renderer's own drawing, and falls back when the adapter throws", async () => {
    quiet();
    const seen: Array<{ part: string; text?: string; level?: number; region: string; content: boolean }> = [];
    const binding = bindingOf(lit, {
      chrome: {
        heading: {
          template: (state) => {
            seen.push({ part: state.part, ...(state.text !== undefined ? { text: state.text } : {}), ...(state.level !== undefined ? { level: state.level } : {}), region: state.region, content: state.content !== undefined });
            return lit.html`<div class="ds-heading" role="heading" aria-level=${state.level ?? 2}>${state.text}</div>`;
          }
        },
        text: {
          template: () => {
            throw new Error("no text today");
          }
        }
      }
    });
    const { root } = await mounted(formWith(authored([{ id: "h", type: "heading", text: "Welcome", level: 3 }, { id: "t", type: "text", text: "Plain" }])), {}, { binding });
    expect(root.querySelector(".ds-heading")?.textContent).toBe("Welcome");
    expect(root.querySelector("h3.datum-form__chrome-heading")).toBeNull();
    expect(seen).toEqual([{ part: "heading", text: "Welcome", level: 3, region: "header", content: true }]);
    // The throwing adapter's part is drawn by the renderer's own markup.
    expect(root.querySelector("p.datum-form__chrome-text")?.textContent).toBe("Plain");
  });

  it("takes Datum's adapter for a part the binding leaves out", async () => {
    quiet();
    const datum = bindingOf(lit, { id: "datum", chrome: { text: { template: (state) => lit.html`<p class="datum-text">${state.text}</p>` } } });
    const { root } = await mounted(formWith(authored([{ id: "t", type: "text", text: "Plain" }])), {}, { datum });
    expect(root.querySelector("p.datum-text")?.textContent).toBe("Plain");
  });
});

// ── Frames ─────────────────────────────────────────────────────────────────────────────────

describe("live chrome: the frame", () => {
  it("puts the frame class and attribute on the form element; seamless adds nothing", async () => {
    quiet();
    const outlined = await mounted(formWith({ chrome: { frame: "outlined" } }));
    const form = outlined.root.querySelector("form") as HTMLFormElement;
    expect(form.classList.contains("datum-live")).toBe(true);
    expect(form.classList.contains("datum-form--frame-outlined")).toBe(true);
    expect(form.getAttribute("data-frame")).toBe("outlined");
    const seamless = await mounted(formWith({ chrome: { frame: "seamless" } }));
    const plain = seamless.root.querySelector("form") as HTMLFormElement;
    expect(plain.className).toBe("datum-live");
    expect(plain.hasAttribute("data-frame")).toBe(false);
  });

  it("lets the host's fixed frame win, takes the author's otherwise, and drops the attribute when the frame goes", async () => {
    quiet();
    let host: unknown = { frame: { id: "paper", fixed: true } };
    const { root, form } = await mounted(formWith({ chrome: { frame: "outlined" } }), { chrome: () => host });
    const element = root.querySelector("form") as HTMLFormElement;
    expect(element.getAttribute("data-frame")).toBe("paper");
    expect(element.classList.contains("datum-form--frame-paper")).toBe(true);
    expect(element.classList.contains("datum-form--frame-outlined")).toBe(false);
    host = { frame: "paper" };
    form.redraw();
    expect(element.getAttribute("data-frame")).toBe("outlined");
    host = undefined;
    form.redraw();
    expect(element.getAttribute("data-frame")).toBe("outlined");
  });

  it("removes the frame attribute when the frame is gone", async () => {
    quiet();
    let host: unknown = { frame: "paper" };
    const { root, form } = await mounted(formWith({}), { chrome: () => host });
    const element = root.querySelector("form") as HTMLFormElement;
    expect(element.getAttribute("data-frame")).toBe("paper");
    host = undefined;
    form.redraw();
    expect(element.hasAttribute("data-frame")).toBe(false);
    expect(element.className).toBe("datum-live");
  });

  it("draws a frame the binding adds (LiveBinding.frames), and the default frame for one no binding draws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const frames = { card: { label: { default: "Card" }, css: ".datum-form--frame-card { border: 1px solid; }" } };
    const own = await mounted(formWith({ chrome: { frame: "card" } }), {}, { binding: bindingOf(lit, { frames }) });
    const framed = own.root.querySelector("form") as HTMLFormElement;
    expect(framed.getAttribute("data-frame")).toBe("card");
    expect(framed.classList.contains("datum-form--frame-card")).toBe(true);
    const other = await mounted(formWith({ chrome: { frame: "card" } }));
    expect((other.root.querySelector("form") as HTMLFormElement).hasAttribute("data-frame")).toBe(false);
    expect(warn.mock.calls.some((call) => String(call[0]).includes('The frame "card" is drawn by no binding'))).toBe(true);
  });
});

describe("live chrome: Trusted Types", () => {
  it("draws an html part through lit's own template (unsafeHTML), never by setting an element's innerHTML", async () => {
    quiet();
    // Under Trusted Types, setting innerHTML to a string is refused; lit's template parse goes through its lit-html policy.
    const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "innerHTML") as PropertyDescriptor;
    const written: string[] = [];
    Object.defineProperty(Element.prototype, "innerHTML", {
      configurable: true,
      get(this: Element) {
        return descriptor.get?.call(this);
      },
      set(this: Element, value: string) {
        if (this.localName !== "template") {
          written.push(this.localName);
        }
        descriptor.set?.call(this, value);
      }
    });
    try {
      const { root } = await mounted(formWith(authored([{ id: "rich", type: "html", html: '<p>See <a href="https://example.org/help" onclick="steal()">help</a><script>alert(1)</script></p>' }])));
      const part = root.querySelector(".datum-form__chrome-html");
      expect(part?.querySelector("a")?.getAttribute("href")).toBe("https://example.org/help");
      expect(part?.querySelector("a")?.hasAttribute("onclick")).toBe(false);
      expect(part?.querySelector("script")).toBeNull();
      expect(written).toEqual([]);
    } finally {
      Object.defineProperty(Element.prototype, "innerHTML", descriptor);
    }
  });
});
