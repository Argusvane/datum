// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ChromeAdapter } from "../form-engine/render/live/contract.js";
import type { FormNotice } from "../form-engine/core/submission/form-notice.js";
import { chromeFeature } from "../form-engine/render/live/chrome.js";
import { createFormNoticesFeature } from "../form-engine/render/live/form-notices.js";
import { lit, render } from "../form-engine/render/live/lit.js";
import { createSummaryFeature } from "../form-engine/render/live/summary.js";
import { datumChrome, datumLanguageSwitcher } from "../form-engine/render/live/datum/chrome.js";
import { definitionOf, mounted, partsBinding, shape, settled, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

const TWO_LOCALES = {
  localization: {
    supportedLocales: [
      { code: "en", label: "English" },
      { code: "fr-CA", label: "Français (Canada)" }
    ]
  }
};

function one(scope: ParentNode, selector: string): HTMLElement {
  const found = scope.querySelector<HTMLElement>(selector);
  expect(found, selector).not.toBeNull();
  return found as HTMLElement;
}

const NAME = { id: "name", type: "text", configuration: { label: "Name", required: true } };

describe("Datum chrome parts", () => {
  const chrome = {
    header: [
      { id: "logo", type: "image", src: "https://example.org/logo.png", alt: "Acme", href: "https://example.org", width: 120, height: 40 },
      { id: "hello", type: "heading", text: "Welcome", level: 3 },
      { id: "para", type: "text", text: "Fill this in." },
      { id: "rich", type: "html", html: '<p>See <a href="https://example.org/help">help</a><script>alert(1)</script></p>' },
      { id: "title", type: "form-title", level: 2 },
      { id: "about", type: "form-description" },
      { id: "bar", type: "group", justify: "end", verticalAlign: "start", parts: [{ id: "g1", type: "heading", text: "Left" }, { id: "g2", type: "text", text: "Right" }] },
      { id: "lang", type: "language-switcher" }
    ],
    footer: [{ id: "fine", type: "text", text: "Fine print", align: "end" }]
  };
  const root = { chrome, title: "Intake form", description: "About this form" };
  const definition = definitionOf([NAME], TWO_LOCALES, root);

  it("draws the header and footer parts", async () => {
    const m = await mounted(definition, { features: [chromeFeature()] });
    const header = one(m.root, ".datum-form__header");
    expect(header.querySelector("img")?.getAttribute("alt")).toBe("Acme");
    expect(header.querySelector("a[href='https://example.org']")).not.toBeNull();
    expect(header.querySelector("h3")?.textContent).toBe("Welcome");
    expect(header.textContent).toContain("Fill this in.");
    // The html part keeps its link and drops the script.
    expect(header.querySelector("a[href='https://example.org/help']")).not.toBeNull();
    expect(header.querySelector("script")).toBeNull();
    expect(header.querySelector("h2")?.textContent).toBe("Intake form");
    expect(header.textContent).toContain("About this form");
    expect(header.textContent).toContain("Left");
    expect(header.textContent).toContain("Right");
    expect(one(m.root, ".datum-form__footer").textContent).toContain("Fine print");
  });

  it("draws the same markup the renderer draws for a part when no adapter answers", async () => {
    const { chrome: _chrome, languageSwitcher: _switcher, ...plain } = partsBinding();
    const withoutAdapters = await mounted(definition, { binding: plain, features: [chromeFeature()] });
    const header = shape(one(withoutAdapters.root, ".datum-form__header"));
    unmountAll();
    const withAdapters = await mounted(definition, { features: [chromeFeature()] });
    expect(shape(one(withAdapters.root, ".datum-form__header"))).toBe(header);
  });

  it("draws the form's title as a caption, not a second heading, over a journey page's own", () => {
    const host = document.createElement("div");
    const state = { part: "form-title", region: "header", locale: "en", dir: "ltr", busy: undefined, words: (key: string) => key, text: "Intake", level: 1, content: undefined } as never;
    render((datumChrome["form-title"] as ChromeAdapter).template({ ...(state as object), caption: true } as never), host);
    expect(host.querySelector("h1")).toBeNull();
    expect(host.querySelector("p.datum-form__chrome-title.datum-form__journey-title")?.textContent).toBe("Intake");
    render((datumChrome["form-title"] as ChromeAdapter).template(state), host);
    expect(host.querySelector("h1.datum-form__title.datum-form__chrome-title")?.textContent).toBe("Intake");
    expect(host.querySelector("p")).toBeNull();
  });

  it("draws a picture with no link or size, and none for an unsafe address", async () => {
    const parts = { header: [{ id: "a", type: "image", src: "https://example.org/a.png" }, { id: "b", type: "image", src: "javascript:alert(1)" }] };
    const def = definitionOf([NAME], {}, { chrome: parts });
    const m = await mounted(def, { features: [chromeFeature()] });
    const images = m.root.querySelectorAll("img");
    expect(images).toHaveLength(1);
    expect(images[0]?.getAttribute("src")).toBe("https://example.org/a.png");
    expect(images[0]?.closest("a")).toBeNull();
    expect(m.root.innerHTML).not.toContain("javascript:");
  });

  it("switches the language from the select and reports the outcome", async () => {
    const def = definitionOf([NAME], TWO_LOCALES, { chrome: { header: [{ id: "lang", type: "language-switcher" }] } });
    const m = await mounted(def, { features: [chromeFeature()] });
    const select = one(m.root, "select.datum-form__language-switcher-select") as HTMLSelectElement;
    expect(select.value).toBe("en");
    expect(one(m.root, "label.datum-form__language-switcher-label").getAttribute("for")).toBe(select.id);
    select.value = "fr-CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await settled(m.form);
    expect(m.runtime.state().locale).toBe("fr-CA");
    expect(m.events("datum-locale-applied").map((event) => event.detail)).toEqual([{ locale: "fr-CA" }]);
  });

  it("is the switcher the binding hooks in by default", () => {
    expect(partsBinding().languageSwitcher).toBe(datumLanguageSwitcher);
  });
});

describe("Datum language links", () => {
  const def = definitionOf([NAME], TWO_LOCALES, { chrome: { header: [{ id: "lang", type: "language-switcher" }] } });
  const cases = [
    { current: "text" as const },
    { current: "omit" as const, heading: false, names: { en: "English", fr: "Français" } },
    { current: "link" as const, abbreviation: true, separator: "|", className: "wrap", linkClass: "item" },
    { heading: true, abbreviation: true, names: { fr: "Français" } }
  ];

  it.each(cases)("draws the language switcher as links (%o)", async (options) => {
    const m = await mounted(def, { features: [chromeFeature()], binding: partsBinding({ languageLinks: options }) });
    const switcher = one(m.root, ".datum-form__language-switcher");
    expect(switcher.querySelector("select")).toBeNull();
    // The other language is a link to switch to; the current one is a link only when asked to be.
    expect(switcher.querySelector("a[data-locale-switch='fr-CA']")).not.toBeNull();
    expect(switcher.querySelector("a[data-locale-switch='en']") !== null).toBe(options.current === "link");
  });

  it("switches the language from a link, and leaves the page where it is", async () => {
    const m = await mounted(def, { features: [chromeFeature()], binding: partsBinding({ languageLinks: { current: "text" } }) });
    const link = one(m.root, "a[data-locale-switch='fr-CA']");
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    link.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    await settled(m.form);
    expect(m.runtime.state().locale).toBe("fr-CA");
    // The current language is now the other one, drawn as plain text.
    expect(one(m.root, ".datum-form__language-current").getAttribute("lang")).toBe("fr");
  });
});

describe("Datum error summary", () => {
  const fields = [
    { id: "name", type: "text", configuration: { label: "Name", required: true } },
    { id: "email", type: "text", configuration: { label: "Email", required: true } }
  ];
  const def = definitionOf(fields);

  it("draws the heading and one link per problem", async () => {
    const m = await mounted(def, { features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    const box = one(m.root, ".datum-form__summary");
    expect(box.getAttribute("role")).toBe("alert");
    expect(box.getAttribute("tabindex")).toBe("-1");
    expect(Array.from(box.querySelectorAll("a")).map((link) => link.getAttribute("href"))).toEqual(["#name", "#email"]);
    // The heading carries the id the state names.
    expect(one(box, "h2").id).not.toBe("");
  });

  it("moves focus to the field a link names, without navigating", async () => {
    const m = await mounted(def, { features: [createSummaryFeature()] });
    await m.runtime.validate();
    await settled(m.form);
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, composed: true });
    one(m.root, ".datum-form__summary a[href='#email']").dispatchEvent(click);
    expect(click.defaultPrevented).toBe(true);
    expect(m.root.activeElement?.id).toBe("email");
  });

  it("numbers the problems where the form's controls ask, and sets the heading level", async () => {
    const m = await mounted(def, { features: [createSummaryFeature()], parts: { summary: { list: "ordered", headingLevel: 3 } } });
    await m.runtime.validate();
    await settled(m.form);
    const box = one(m.root, ".datum-form__summary");
    expect(box.querySelector("ol")).not.toBeNull();
    expect(box.querySelector("ul")).toBeNull();
    expect(box.querySelector("h3.datum-form__summary-heading")).not.toBeNull();
  });
});

describe("Datum receipt, status line and required note", () => {
  const def = definitionOf([NAME]);
  const receipt: FormNotice = {
    kind: "success",
    title: { default: "Thank you" },
    message: { default: "We have your form." },
    details: [{ label: { default: "Confirmation number" }, value: "GC-48213" }]
  };

  it("draws the receipt at each kind: the kind said once, the title, the message and the details", async () => {
    const words = { success: "Success: ", info: "Information: ", warning: "Warning: ", error: "Error: " };
    for (const kind of ["success", "info", "warning", "error"] as const) {
      const notice: FormNotice = { ...receipt, kind };
      const m = await mounted(def, { features: [createFormNoticesFeature({ notice: () => notice })] });
      const box = one(m.root, ".datum-form__notice");
      expect(one(box, ".datum-form__visually-hidden").textContent, kind).toBe(words[kind]);
      expect(box.textContent, kind).toContain("Thank you");
      expect(box.textContent, kind).toContain("We have your form.");
      expect(box.textContent, kind).toContain("Confirmation number");
      expect(box.textContent, kind).toContain("GC-48213");
      unmountAll();
    }
  });

  it("draws a receipt with only a message, or only a title, the kind said once", async () => {
    for (const notice of [{ message: { default: "Saved." } }, { title: { default: "Saved" } }] as FormNotice[]) {
      const m = await mounted(def, { features: [createFormNoticesFeature({ notice: () => notice })] });
      expect(one(m.root, ".datum-form__notice .datum-form__visually-hidden").textContent).toBe("Success: ");
      unmountAll();
    }
  });

  it("puts the top copy in the region and a hidden echo at the bottom when it goes at both ends", async () => {
    const notice: FormNotice = { ...receipt, placement: ["top", "bottom"] };
    const m = await mounted(def, { features: [createFormNoticesFeature({ notice: () => notice })] });
    const copies = Array.from(m.root.querySelectorAll(".datum-form__notice"));
    expect(copies).toHaveLength(2);
    expect(copies[0]?.classList.contains("datum-form__notice--echo")).toBe(false);
    expect(copies[1]?.classList.contains("datum-form__notice--echo")).toBe(true);
    expect(copies[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(copies[1]?.hasAttribute("role")).toBe(false);
    // The first copy is above the fields, the echo below them.
    const form = one(m.root, "form");
    expect(Array.from(form.children).indexOf(copies[0] as Element)).toBeLessThan(Array.from(form.children).indexOf(one(m.root, ".datum-live-field")));
    expect(Array.from(form.children).indexOf(copies[1] as Element)).toBeGreaterThan(Array.from(form.children).indexOf(one(m.root, ".datum-live-field")));
  });

  it("is an alert for an error receipt on the draw that first shows it, and a status after", async () => {
    const notice: FormNotice = { ...receipt, kind: "error" };
    const m = await mounted(def, { features: [createFormNoticesFeature({ notice: () => notice })] });
    expect(one(m.root, ".datum-form__notice").getAttribute("role")).toBe("alert");
    m.live().redraw();
    expect(one(m.root, ".datum-form__notice").getAttribute("role")).toBe("status");
  });

  it("moves focus to the receipt", async () => {
    const feature = createFormNoticesFeature({ notice: () => receipt });
    const m = await mounted(def, { features: [feature] });
    expect(feature.focusNotice()).toBe(true);
    expect(m.root.activeElement?.classList.contains("datum-form__notice")).toBe(true);
    const none = createFormNoticesFeature();
    await mounted(def, { features: [none] });
    expect(none.focusNotice()).toBe(false);
  });

  it("draws nothing for no notice, an unusable one, or an end the notice does not go to", async () => {
    const m = await mounted(def, { features: [createFormNoticesFeature({ notice: () => ({ placement: ["bottom"], message: { default: "Hi" } }) })] });
    const notices = m.root.querySelectorAll(".datum-form__notice");
    expect(notices).toHaveLength(1);
    const form = one(m.root, "form");
    expect(Array.from(form.children).indexOf(notices[0] as Element)).toBeGreaterThan(Array.from(form.children).indexOf(one(m.root, ".datum-live-field")));
  });

  it("says a submission is in flight, and dims the form meanwhile", async () => {
    const m = await mounted(def, { features: [createFormNoticesFeature({ submittingPlacement: () => ["top", "bottom"] })] });
    expect(m.root.querySelector(".datum-form__status")).toBeNull();
    m.live().setBusy("submitting", true);
    await settled(m.form);
    const lines = Array.from(m.root.querySelectorAll(".datum-form__status"));
    expect(lines).toHaveLength(2);
    expect(lines[0]?.getAttribute("role")).toBe("status");
    expect(lines[0]?.textContent?.trim()).toBe("Submitting…");
    expect(lines[1]?.getAttribute("aria-hidden")).toBe("true");
    expect(one(m.root, "form").classList.contains("datum-form--submitting")).toBe(true);
    m.live().setBusy("submitting", false);
    await settled(m.form);
    expect(m.root.querySelector(".datum-form__status")).toBeNull();
    expect(one(m.root, "form").classList.contains("datum-form--submitting")).toBe(false);
  });

  it("draws the required note only when worded and a drawn field is required", async () => {
    const m = await mounted(def, { features: [createFormNoticesFeature()], texts: { requiredNote: "Fields marked * are required" } });
    expect(one(m.root, ".datum-form__required-note").textContent?.trim()).toBe("Fields marked * are required");
    unmountAll();
    const unworded = await mounted(def, { features: [createFormNoticesFeature()] });
    expect(unworded.root.querySelector(".datum-form__required-note")).toBeNull();
    unmountAll();
    const noneRequired = await mounted(definitionOf([{ id: "x", type: "text", configuration: { label: "X" } }]), { features: [createFormNoticesFeature()], texts: { requiredNote: "Fields marked * are required" } });
    expect(noneRequired.root.querySelector(".datum-form__required-note")).toBeNull();
  });

  it("lets a binding draw the receipt, the status and the note its own way, and falls back when its hook throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const binding = partsBinding({}, {
      notice: (state) => lit.html`<aside class="ds-notice" data-kind=${state.kind}>${state.title}</aside>`,
      requiredNote: (state) => lit.html`<p class="ds-note">${state.note}</p>`,
      status: () => {
        throw new Error("boom");
      }
    });
    const m = await mounted(def, { binding, texts: { requiredNote: "Required marked *" }, features: [createFormNoticesFeature({ notice: () => receipt })] });
    expect(one(m.root, "aside.ds-notice").dataset.kind).toBe("success");
    expect(m.root.querySelector(".datum-form__notice")).toBeNull();
    expect(one(m.root, "p.ds-note").textContent).toBe("Required marked *");
    m.live().setBusy("submitting", true);
    await settled(m.form);
    // The status hook threw: Datum's line stands in, and the problem is reported.
    expect(m.root.querySelector(".datum-form__status")).not.toBeNull();
    expect(m.errors.some((error) => error.hook === "status")).toBe(true);
  });
});
