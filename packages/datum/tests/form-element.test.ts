import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";

import "../src/form.js";
import type {
  DatumDownloadDetail,
  DatumErrorDetail,
  DatumFormChangeDetail,
  DatumFormElement,
  DatumFormSubmitDetail,
  DatumFormWasmReadyDetail,
  DatumFormWasmValidatedDetail,
  LiveBinding,
  WasmPluginSource
} from "../src/form.js";
import {
  type ComponentDefinition,
  type DraftStore,
  type FormDefinition,
  type FormDraft,
  RemoteDataSourceProvider,
  WASM_ABI_VERSION
} from "@argusvane/datum-engine";

import { ACME_PDF_HEADING_COLOR, ACME_PDF_THEME } from "./fixtures/acme-theme.js";
import "./fixtures/acme-theme-bundle.js";

import { mount, paintedForm, sampleDefinition, until, withEngineWords } from "./helpers.js";
import { createDatumBinding } from "../../../engine/form-engine/render/live/renderer.js";
import { box, control, describedBy, headingText, inSummary, inputOf, invalidIds, noticeOf, receiptsTitled, selectOf, standsBefore, statusLinesSaying, summaryCopies, summaryOf, type } from "./live-dom.js";
import { hideConstructedSheets } from "./setup/constructed-sheets.js";

const COUNTRIES = [
  { value: "CA", label: "Canada" },
  { value: "US", label: "United States" }
];

afterEach(() => {
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

function listen<T>(element: HTMLElement, type: string): T[] {
  const seen: T[] = [];
  element.addEventListener(type, (event) => seen.push((event as CustomEvent<T>).detail));
  return seen;
}

describe("<datum-form>", () => {
  it("defines the element", () => {
    expect(customElements.get("datum-form")).toBeTruthy();
  });

  it("renders the definition's fields, and nothing but the form", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    expect(control(form, "fullName")).toBeTruthy();
    expect(control(form, "country")).toBeTruthy();
    // No host toolbar: neither <datum-form-host> nor its Validate/Print buttons are in play.
    expect(element.shadowRoot!.querySelector("datum-form-host")).toBeNull();
    expect(element.shadowRoot!.querySelector("[data-validate], [data-print]")).toBeNull();
    expect(element.runtime).toBeTruthy();
  });

  it("stores what is typed into the text box Datum draws for a number as a number (controls.number)", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content!.push({
      id: "age",
      type: "number",
      configuration: { label: "Age", min: 0, max: 120 }
    });
    const element = mount((el) => {
      el.definition = definition;
    });
    const form = await paintedForm(element);
    const age = (): HTMLInputElement => control(form, "age");
    // A text box with a number keyboard, no spinner and no bounds attribute; still a number field.
    expect(age().type).toBe("text");
    expect(age().getAttribute("inputmode")).toBe("decimal");
    expect(age().hasAttribute("min")).toBe(false);
    expect(box(form, "age").getAttribute("data-kind")).toBe("number");

    type(age(), "42");
    await until(() => element.values.age === 42);
    type(age(), "42.5");
    await until(() => element.values.age === 42.5);
    // Not a number: kept as typed for validation to word, rather than dropped like a number box would.
    type(age(), "4x");
    await until(() => element.values.age === "4x");
    // Emptied: the empty string every cleared text control stores.
    type(age(), "");
    await until(() => element.values.age === "");

    // A binding that draws the native number box keeps it, bounds and all (Datum draws text).
    element.binding = createDatumBinding({ controls: { number: "number" } });
    await until(() => control(form, "age")?.type === "number");
    expect(age().getAttribute("min")).toBe("0");
    type(age(), "7");
    await until(() => element.values.age === 7);
  });

  it("takes the definition from the attribute as JSON, and reports bad JSON as datum-error", async () => {
    const element = mount((el) => {
      el.setAttribute("definition", JSON.stringify(sampleDefinition()));
    });
    const form = await paintedForm(element);
    expect(control(form, "fullName")).toBeTruthy();

    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    element.setAttribute("definition", "{not json");
    expect(errors.length).toBe(1);
    expect(errors[0]!.message).toContain("definition attribute is not valid JSON");
    consoleError.mockRestore();
  });

  it("loads the definition from src", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(sampleDefinition()), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const element = mount((el) => {
      el.setAttribute("src", "/forms/sample.json");
    });
    const form = await paintedForm(element);
    expect(fetchMock).toHaveBeenCalledWith("/forms/sample.json");
    expect(control(form, "fullName")).toBeTruthy();
    expect(element.definition?.id).toBe("sample-form");
  });

  it("reports a definition that fails to load", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 404, statusText: "Not Found", json: async () => ({}) }))
    );
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const element = mount();
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    element.src = "/forms/missing.json";
    await until(() => errors.length > 0);
    expect(errors[0]!.message).toContain("/forms/missing.json");
    expect(element.runtime).toBeUndefined();
    consoleError.mockRestore();
  });

  it("feeds a select from the page's data sources and reports value changes", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    await until(() => box(form, "country").querySelectorAll('option[value="CA"]').length === 1);

    const changes = listen<DatumFormChangeDetail>(element, "datum-change");
    type(control(form, "fullName")!, "Ada Lovelace");
    await until(() => changes.length > 0);
    expect(changes[0]!.path).toBe("fullName");
    expect(changes[0]!.value).toBe("Ada Lovelace");
    expect(changes[0]!.values.fullName).toBe("Ada Lovelace");
    expect(element.values.fullName).toBe("Ada Lovelace");
  });

  it("words a validation error from the page's messages over the form's, and from the form's for a code the page leaves out", async () => {
    const definition = sampleDefinition();
    definition.root.configuration = { ...(definition.root.configuration as object), messages: { required: "The form says: needed." } };
    const fullName = definition.root.children!.content!.find((node) => node.id === "fullName")!;
    fullName.configuration = { ...(fullName.configuration as object), messages: { required: "The field says: your name." } };
    const element = mount((el) => {
      el.messages = { required: "The page says: required." };
      el.definition = definition;
    });
    const form = await paintedForm(element);

    expect((await element.submit()).accepted).toBe(false);
    await until(() => describedBy(control(form, "fullName")) === "The page says: required.");
    expect("messagesOverride" in element).toBe(false);

    element.messages = { minLength: "The page says: longer." };
    await until(() => describedBy(control(form, "fullName")) === "The field says: your name.");
  });

  it("also accepts data sources as a JSON attribute", async () => {
    const element = mount((el) => {
      el.setAttribute("data-sources", JSON.stringify({ countries: COUNTRIES }));
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    await until(() => box(form, "country").querySelectorAll('option[value="US"]').length === 1);
    expect(element.dataSources?.ids()).toEqual(["countries"]);
  });

  it("submits through the form's own submit button and reports the outcome", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
    const rawActions = listen<unknown>(element, "datum-form-action");

    // The required name is empty: rejected, with the error the field-constraints stage raised.
    form.querySelector<HTMLElement>('[data-button-action="submit"]')!.click();
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(false);
    expect(submits[0]!.errors.some((error) => error.code === "required" && error.componentId === "fullName")).toBe(true);
    // The element acted on the submit itself; the raw engine event did not leak out.
    expect(rawActions).toEqual([]);

    type(control(form, "fullName")!, "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    form.querySelector<HTMLElement>('[data-button-action="submit"]')!.click();
    await until(() => submits.length === 2);
    expect(submits[1]!.accepted).toBe(true);
    expect(submits[1]!.submission).toMatchObject({
      versionContext: { form: { id: "sample-form", version: "2.0.0" }, client: { schemaVersion: "1" } },
      submission: { locale: "en", values: { fullName: "Ada Lovelace" } }
    });
  });

  it("submits and downloads the envelope through a download button, unless the page takes the file", async () => {
    const definition = sampleDefinition();
    definition.root.children = {
      content: [
        ...(definition.root.children?.content ?? []),
        { id: "save", type: "button", configuration: { label: "Save a copy", action: "download" } }
      ]
    };
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = definition;
    });
    const form = await paintedForm(element);
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
    const downloads = listen<DatumDownloadDetail>(element, "datum-download");
    const rawActions = listen<unknown>(element, "datum-form-action");

    // jsdom has no object URLs and no navigation: capture the blob and swallow the click.
    const blobs: Blob[] = [];
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: (blob: Blob) => {
        blobs.push(blob);
        return "blob:submission";
      }
    });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      // The required name is empty: rejected, its errors shown, and nothing downloaded.
      form.querySelector<HTMLElement>('[data-button-action="download"]')!.click();
      await until(() => submits.length === 1);
      expect(submits[0]!.accepted).toBe(false);
      expect(downloads).toEqual([]);
      expect(blobs).toEqual([]);
      // The element acted on the download itself; the raw engine event did not leak out.
      expect(rawActions).toEqual([]);

      type(control(form, "fullName")!, "Ada Lovelace");
      await until(() => element.values.fullName === "Ada Lovelace");
      form.querySelector<HTMLElement>('[data-button-action="download"]')!.click();
      await until(() => downloads.length === 1);
      expect(submits[1]!.accepted).toBe(true);
      // What the file holds is the canonical envelope `datum-submit` carried, pretty-printed.
      expect(downloads[0]!.submission).toBe(submits[1]!.submission);
      expect(JSON.parse(downloads[0]!.json)).toEqual(submits[1]!.submission);
      expect(downloads[0]!.json).toContain('\n  "submission": {');
      expect(downloads[0]!.fileName).toMatch(/^sample-form-submission-\d{8}-\d{6}\.json$/);
      expect(blobs).toHaveLength(1);
      expect(blobs[0]!.type).toBe("application/json");
      expect(blobs[0]!.size).toBe(new TextEncoder().encode(downloads[0]!.json).length);
      expect(click).toHaveBeenCalledTimes(1);

      // A page that cancels `datum-download` takes the file over: no browser download.
      element.addEventListener("datum-download", (event) => event.preventDefault(), { once: true });
      form.querySelector<HTMLElement>('[data-button-action="download"]')!.click();
      await until(() => downloads.length === 2);
      expect(blobs).toHaveLength(1);
      expect(click).toHaveBeenCalledTimes(1);

      // The same route is a method, for a page's own control.
      expect((await element.submitAndDownload()).accepted).toBe(true);
      await until(() => downloads.length === 3);
      expect(blobs).toHaveLength(2);
    } finally {
      click.mockRestore();
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      // The no-op revokeObjectURL stays: the helper revokes each URL on a one-second timer,
      // which would otherwise fire into a later test and find nothing to call.
    }
  });

  it("shows errors the page reports after an accepted submit, until the next submit", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    type(control(form, "fullName")!, "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    expect((await element.submit()).accepted).toBe(true);
    expect(summaryOf(form)).toBeNull();

    // The server's verdict on the delivered envelope: one field it rejected.
    const stored = element.setErrors([{ componentId: "fullName", code: "taken", message: "Already registered." }]);
    expect(stored).toMatchObject([{ componentId: "fullName", code: "taken", stage: "host", source: "server" }]);
    expect(element.errors).toEqual(stored);
    await until(() => summaryOf(form));
    expect(summaryOf(form)!.textContent).toContain("Already registered.");
    const name = control(form, "fullName")!;
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(control(form, "fullName"))).toBe("Already registered.");
    // The summary takes focus under Datum; the field it names has the error.
    await until(() => inSummary(form));

    // Nowhere to deliver it: an error of the form's own, listed in the summary, which takes focus.
    element.setErrors([{ code: "delivery.failed", message: "The form could not be sent." }]);
    const formError = () => [...(summaryOf(form)?.querySelectorAll("li") ?? [])].find((item) => item.querySelector("a") === null);
    await until(() => formError());
    expect(formError()!.textContent?.trim()).toBe("The form could not be sent.");
    expect(control(form, "fullName")!.getAttribute("aria-invalid")).toBe("false");
    await until(() => inSummary(form));

    // The summary's start is scrolled into view before it takes focus (a long summary
    // would otherwise be focused with its heading off-screen), without a second scroll.
    const order: string[] = [];
    const proto = HTMLElement.prototype as { scrollIntoView?: unknown; focus: HTMLElement["focus"] };
    const realScroll = proto.scrollIntoView;
    const realFocus = proto.focus;
    proto.scrollIntoView = function (this: HTMLElement, options?: ScrollIntoViewOptions) {
      if (summaryOf(form)?.contains(this)) order.push(`scroll:${options?.block}`);
    };
    proto.focus = function (this: HTMLElement, options?: FocusOptions) {
      if (summaryOf(form)?.contains(this)) order.push(`focus:${options?.preventScroll}`);
      realFocus.call(this, options);
    };
    element.setErrors([{ code: "delivery.failed", message: "The form could not be sent." }]);
    await until(() => order.includes("focus:true"));
    expect(order[order.indexOf("focus:true") - 1]).toBe("scroll:start");
    proto.scrollIntoView = realScroll;
    proto.focus = realFocus;

    // Submitting again validates afresh: the page's errors are gone.
    form.querySelector<HTMLElement>('[data-button-action="submit"]')!.click();
    await until(() => element.errors.length === 0);
    await until(() => summaryOf(form) === null);
  });

  it("validates on demand, reporting the errors", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await paintedForm(element);
    const validated = listen<{ errors: Array<{ code: string }> }>(element, "datum-validated");
    const errors = await element.validate();
    expect(errors.some((error) => error.code === "required")).toBe(true);
    expect(validated[0]!.errors).toEqual(errors);
    expect(element.errors).toEqual(errors);
  });

  it("validates without moving focus when asked (a page showing the errors, not asking for a fix)", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const errors = await element.validate({ focus: false });
    expect(errors.length).toBeGreaterThan(0);
    await until(() => form.querySelector('[aria-invalid="true"]') !== null);
    // Nothing in the form took focus.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(form.activeElement).toBeNull();
  });

  it("renders in the locale attribute's language and offers a language switcher on request", async () => {
    const element = mount((el) => {
      el.setAttribute("locale", "fr-CA");
      el.setAttribute("language-switcher", "");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    await until(() => form.textContent?.includes("Nom complet"));
    expect(element.runtime!.state().locale).toBe("fr-CA");
    expect(form.querySelector("[data-locale-switch]")).toBeTruthy();
  });

  it("keeps a locale picked in the switcher, and the typed answers, across a translations rebuild", async () => {
    const element = mount((el) => {
      el.setAttribute("language-switcher", "");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const select = form.querySelector<HTMLSelectElement>("select[data-locale-switch]")!;
    select.value = "fr-CA";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await until(() => element.runtime!.state().locale === "fr-CA");
    type(control(form, "fullName")!, "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    const before = element.runtime;
    element.translations = { "fr-CA": { "demo.key": "Bonjour" } } as never;
    await until(() => element.runtime !== before);
    expect(element.runtime!.state().locale).toBe("fr-CA");
    expect(element.locale).toBe("fr-CA");
    expect(element.values.fullName).toBe("Ada Lovelace");
  });

  it("takes a chrome attribute as JSON and draws its parts, one switcher where chrome and language-switcher both give one", async () => {
    const element = mount((el) => {
      el.setAttribute("language-switcher", "");
      el.setAttribute(
        "chrome",
        JSON.stringify({
          header: [{ type: "heading", text: { default: "Welcome", locales: { "fr-CA": "Bienvenue" } } }],
          footer: [{ type: "language-switcher", label: "Choose" }]
        })
      );
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    await until(() => form.querySelector('[data-chrome-part="heading"]') !== null);
    expect(form.querySelector('[data-chrome-part="heading"]')?.textContent).toBe("Welcome");
    expect(form.querySelectorAll("[data-locale-switch]")).toHaveLength(1);
    // The footer part draws after the fields, under its own label.
    const switcher = form.querySelector<HTMLElement>('[data-chrome-part="language-switcher"]')!;
    expect(switcher.querySelector("label")?.textContent).toBe("Choose");
    expect(box(form, "fullName").compareDocumentPosition(switcher) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(switcher.querySelector("[data-locale-switch]")).toBeTruthy();
    expect(element.chrome?.footer?.[0]?.type).toBe("language-switcher");
  });

  it("frames the form from the frame attribute as a default, fixed when asked, chrome.frame winning", async () => {
    const authored = sampleDefinition();
    authored.root.configuration = { ...(authored.root.configuration as Record<string, unknown>), chrome: { frame: "outlined" } };
    const element = mount((el) => {
      el.setAttribute("frame", "paper");
      el.definition = authored;
    });
    const form = await paintedForm(element);
    // The page's default yields to the author's outlined frame.
    const frame = () => form.querySelector("form")?.getAttribute("data-frame");
    await until(() => frame() === "outlined");
    // Fixed, the page's paper frame replaces it.
    element.setAttribute("frame-fixed", "");
    await until(() => frame() === "paper");
    // Where chrome gives a frame too, chrome's wins over both attributes.
    element.chrome = { frame: { id: "seamless", fixed: true } };
    await until(() => form.querySelector("form") !== null && frame() === null);
    // Without a definition frame, the attribute alone applies.
    element.chrome = undefined;
    element.removeAttribute("frame-fixed");
    element.definition = sampleDefinition();
    await until(() => frame() === "paper");
  });

  it("merges language-switcher, frame and frame-fixed into a chrome the page sets, chrome winning where both give the setting", async () => {
    const authored = sampleDefinition();
    authored.root.configuration = { ...(authored.root.configuration as Record<string, unknown>), chrome: { frame: "outlined" } };
    const element = mount((el) => {
      el.setAttribute("language-switcher", "");
      el.setAttribute("frame", "paper");
      el.chrome = { header: [{ type: "heading", text: { default: "Welcome" } }] };
      el.definition = authored;
    });
    const form = await paintedForm(element);
    const frame = () => form.querySelector("form")?.getAttribute("data-frame");
    // chrome names no switcher and no frame: the attributes add theirs. The frame is a default
    // the author's own pick (outlined) beats, as it is with no chrome.
    await until(() => form.querySelector('[data-chrome-part="heading"]') !== null && form.querySelector("[data-locale-switch]") !== null);
    expect(form.querySelectorAll("[data-locale-switch]")).toHaveLength(1);
    expect(form.querySelector('[data-chrome-part="heading"]')!.compareDocumentPosition(form.querySelector("[data-locale-switch]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    await until(() => frame() === "outlined");
    // frame-fixed still makes the attribute's frame win over the author's.
    element.setAttribute("frame-fixed", "");
    await until(() => frame() === "paper");
    // A frame in chrome is the same setting: chrome's wins, and its string is not fixed.
    element.chrome = { header: [{ type: "heading", text: { default: "Welcome" } }], frame: "seamless" };
    await until(() => frame() === "outlined");
    element.chrome = { frame: { id: "seamless", fixed: true } };
    await until(() => frame() === null);
    // A switcher in chrome is the same setting too: still one, as chrome placed it.
    element.chrome = { footer: [{ type: "language-switcher", label: "Choose" }] };
    await until(() => form.querySelector('[data-chrome-part="language-switcher"] label')?.textContent === "Choose");
    expect(form.querySelectorAll("[data-locale-switch]")).toHaveLength(1);
  });

  it("draws the chrome the form's author composed with no page wiring, and one switcher when the page adds its own", async () => {
    const authored = sampleDefinition();
    authored.root.configuration = {
      ...(authored.root.configuration as Record<string, unknown>),
      chrome: {
        header: [
          { id: "brand", type: "group", parts: [{ id: "logo", type: "image", src: "/logo.svg", alt: "Acme" }, { id: "switcher", type: "language-switcher" }] },
          { id: "title", type: "form-title" }
        ]
      }
    };
    const element = mount((el) => {
      el.definition = authored;
    });
    const form = await paintedForm(element);
    await until(() => form.querySelector('[data-chrome-part="image"]') !== null);
    expect(form.querySelector('[data-chrome-part="image"] img')?.getAttribute("alt")).toBe("Acme");
    expect(form.querySelector('[data-chrome-part="form-title"]')?.textContent).toBe("Sample");
    expect(form.querySelectorAll("[data-locale-switch]")).toHaveLength(1);
    // The page's short form fills the author's slot rather than adding a second switcher.
    element.languageSwitcher = true;
    await until(() => form.querySelectorAll("[data-locale-switch]").length === 1 && form.querySelector('[data-chrome-part="image"]') !== null);
    expect(form.querySelectorAll("[data-locale-switch]")).toHaveLength(1);
    // It stays in the author's group, beside the logo.
    expect(form.querySelector('[data-chrome-part="image"]')!.parentElement!.contains(form.querySelector("[data-locale-switch]"))).toBe(true);
  });

  it("accepts any locale string when the form declares none", async () => {
    const element = mount((el) => {
      {
        const { localization: _none, ...rest } = sampleDefinition();
        el.definition = rest;
      }
    });
    await paintedForm(element);
    element.locale = "de-DE";
    await until(() => element.runtime!.state().locale === "de-DE");
  });

  describe("locale negotiation (attribute path)", () => {
    const localized = () => ({
      ...sampleDefinition(),
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr-CA" }] }
    });

    it("canonicalises case and region to the declared code, else the default; setLocale stays strict", async () => {
      const element = mount((el) => {
        el.definition = localized();
      });
      await paintedForm(element);
      element.locale = "FR";
      await until(() => element.runtime!.state().locale === "fr-CA");
      element.locale = "de-DE";
      await until(() => element.runtime!.state().locale === "en");
      expect(() => element.setLocale("fr")).toThrow(/not supported/);
    });

    it("reports the negotiated locale as activeLocale and dispatches datum-locale-applied for the attribute path", async () => {
      const element = mount((el) => {
        el.definition = localized();
      });
      await paintedForm(element);
      const applied: string[] = [];
      element.addEventListener("datum-locale-applied", (event) => applied.push((event as CustomEvent<{ locale: string }>).detail.locale));
      element.locale = "FR";
      await until(() => element.activeLocale === "fr-CA");
      expect(element.locale).toBe("FR");
      expect(applied).toEqual(["fr-CA"]);
    });

    it("falls back to the first declared locale when nothing matches and there is no default", async () => {
      const element = mount((el) => {
        el.definition = { ...sampleDefinition(), localization: { supportedLocales: [{ code: "en" }, { code: "fr" }] } };
      });
      await paintedForm(element);
      element.locale = "fr";
      await until(() => element.runtime!.state().locale === "fr");
      element.locale = "xx";
      await until(() => element.runtime!.state().locale === "en");
    });

    it('negotiates navigator.languages for locale="auto", and takes the first one when nothing is declared', async () => {
      vi.stubGlobal("navigator", { languages: ["de-DE", "fr-CA", "en"], language: "de-DE" });
      const element = mount((el) => {
        el.setAttribute("locale", "auto");
        el.definition = localized();
      });
      await paintedForm(element);
      await until(() => element.runtime!.state().locale === "fr-CA");
      const open = mount((el) => {
        el.setAttribute("locale", "auto");
        {
        const { localization: _none, ...rest } = sampleDefinition();
        el.definition = rest;
      }
      });
      await paintedForm(open);
      await until(() => open.runtime!.state().locale === "de-DE");
    });
  });

  it("prefills values without reporting them as changes", async () => {
    const element = mount((el) => {
      el.values = { fullName: "Grace Hopper" };
      el.definition = sampleDefinition();
    });
    const changes = listen<DatumFormChangeDetail>(element, "datum-change");
    const form = await paintedForm(element);
    await until(() => control(form, "fullName").value === "Grace Hopper");
    expect(changes).toEqual([]);
  });

  it("switches binding and mode without rebuilding the runtime, so typed values survive", async () => {
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const runtime = element.runtime!;
    type(control(form, "fullName"), "Ada");
    await until(() => element.values.fullName === "Ada");

    const own = { id: "wc-switch", label: "Switch", components: {} } as LiveBinding;
    element.binding = own;
    element.setAttribute("mode", "readonly");
    await until(() => element.renderer!.drawnBinding === own && box(form, "fullName")?.hasAttribute("data-readonly"));
    expect(element.renderer!.mode).toBe("readonly");
    expect(element.runtime).toBe(runtime);
    expect(element.values.fullName).toBe("Ada");
    expect(control(form, "fullName").value).toBe("Ada");
  });

  it("applies pdf-theme to the renderer, and reports an unknown id while keeping the default", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const element = mount((el) => {
      el.definition = sampleDefinition();
    });
    await paintedForm(element);
    // Unset: the engine default, found by id for a layout that names it.
    expect(element.renderer!.pdfTheme).toBeUndefined();
    expect((element.renderer!.pdfThemes as (id: string) => unknown)(ACME_PDF_THEME.id)).toBe(ACME_PDF_THEME);

    element.setAttribute("pdf-theme", ACME_PDF_THEME.id);
    await until(() => element.renderer!.pdfTheme === ACME_PDF_THEME);

    const errors = listen<DatumErrorDetail>(element, "datum-error");
    element.setAttribute("pdf-theme", "nope");
    await until(() => errors.length > 0);
    expect(errors[0]!.message).toContain('Unknown PDF theme "nope"');
    expect(element.renderer!.pdfTheme).toBeUndefined();
    consoleError.mockRestore();
  });

  it("autosaves to a draft key and restores from it", async () => {
    const element = mount((el) => {
      el.setAttribute("draft", "sample-draft");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    type(control(form, "fullName")!, "Ada");
    await until(() => element.values.fullName === "Ada");
    // Autosave is debounced; wait for the draft to land. (Under Node 22 jsdom's localStorage
    // is shadowed by Node's own, so the element's in-memory fallback is what holds it here.)
    let stored = false;
    for (let attempt = 0; attempt < 40 && !stored; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      stored = await element.hasDraft();
    }
    expect(stored).toBe(true);

    // A fresh element over the same definition restores what was typed.
    element.remove();
    const again = mount((el) => {
      el.setAttribute("draft", "sample-draft");
      el.definition = sampleDefinition();
    });
    await paintedForm(again);
    await again.restoreDraft();
    await until(() => again.values.fullName === "Ada");
    await again.clearDraft();
    expect(await again.hasDraft()).toBe(false);
  });

  it("keeps the draft in the page's own store when one is given", async () => {
    const saved = new Map<string, FormDraft>();
    const calls: string[] = [];
    const store: DraftStore = {
      save: async (draft) => {
        calls.push(`save:${draft.id}`);
        saved.set(draft.id, structuredClone(draft));
      },
      load: async (id) => {
        calls.push(`load:${id}`);
        const draft = saved.get(id);
        if (!draft) {
          throw new Error(`Draft not found: ${id}`);
        }
        return structuredClone(draft);
      },
      list: async () => [],
      delete: async (id) => {
        calls.push(`delete:${id}`);
        saved.delete(id);
      }
    };
    const element = mount((el) => {
      el.setAttribute("draft", "server-draft");
      el.draftStore = store;
      el.definition = sampleDefinition();
    });
    expect(element.draftStore).toBe(store);
    const form = await paintedForm(element);
    expect(await element.hasDraft()).toBe(false);
    type(control(form, "fullName")!, "Grace");
    // Autosave goes to the page's store, under the draft key.
    await until(() => saved.has("server-draft"));
    expect(saved.get("server-draft")!.values.fullName).toBe("Grace");
    expect(calls).toContain("save:server-draft");

    // A fresh element given the same store restores from it, and clears through it.
    element.remove();
    const again = mount((el) => {
      el.setAttribute("draft", "server-draft");
      el.draftStore = store;
      el.definition = sampleDefinition();
    });
    await paintedForm(again);
    const kept = structuredClone(saved.get("server-draft")!);
    await again.restoreDraft();
    await until(() => again.values.fullName === "Grace");
    await again.clearDraft();
    expect(calls).toContain("delete:server-draft");
    expect(await again.hasDraft()).toBe(false);

    // Without the store the key is looked up in browser storage again, where it holds nothing,
    // whatever the page's store still has.
    saved.set("server-draft", kept);
    expect(await again.hasDraft()).toBe(true);
    again.draftStore = undefined;
    expect(again.draftStore).toBeUndefined();
    let found = true;
    for (let attempt = 0; attempt < 40 && found; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      found = await again.hasDraft();
    }
    expect(found).toBe(false);
  });
});

describe("<datum-form> PDFs", () => {
  function fakeSupport(seen: unknown[]) {
    return {
      provider: {
        id: "fake",
        abiVersion: "1.0.0",
        render: async (request: unknown) => {
          seen.push(request);
          return { bytes: new TextEncoder().encode("%PDF-fake"), pageCount: 1, pages: [], warnings: [], providerId: "fake" };
        }
      }
    } as unknown as import("../src/pdf.js").DatumPdfSupport;
  }

  it("renders and downloads through the support a page assigns, and serves a button's pdf action", async () => {
    const seen: unknown[] = [];
    const element = mount((el) => {
      el.definition = {
        ...sampleDefinition(),
        root: {
          ...sampleDefinition().root,
          children: {
            content: [
              ...(sampleDefinition().root.children?.content ?? []),
              { id: "print", type: "button", configuration: { label: "PDF", action: "pdf" } }
            ]
          }
        }
      };
      el.values = { fullName: "Ada Lovelace" };
      el.pdfSupport = fakeSupport(seen);
    });
    const shadow = await paintedForm(element);

    const result = await element.renderPdf();
    expect(new TextDecoder().decode(result.bytes)).toBe("%PDF-fake");
    expect(result.layoutKind).toBe("derived");
    expect(result.themeId).toBe("datum-pdf");
    expect(JSON.stringify(seen[0])).toContain("Ada Lovelace");

    // The pdf-theme attribute reaches the document the kernel is handed: the acme heading colour.
    element.setAttribute("pdf-theme", ACME_PDF_THEME.id);
    await until(() => element.renderer!.pdfTheme === ACME_PDF_THEME);
    const themed = await element.renderPdf();
    expect(themed.themeId).toBe(ACME_PDF_THEME.id);
    expect(JSON.stringify(seen[1])).toContain(ACME_PDF_HEADING_COLOR);
    // A per-call id wins over the attribute.
    expect((await element.renderPdf({ themeId: "datum-pdf" })).themeId).toBe("datum-pdf");
    element.removeAttribute("pdf-theme");
    await until(() => element.renderer!.pdfTheme === undefined);

    // downloadPdf() dispatches the cancelable datum-pdf first; cancelling keeps the bytes on the page.
    const pdfs = listen<{ fileName: string; pageCount: number }>(element, "datum-pdf");
    element.addEventListener("datum-pdf", (event) => event.preventDefault());
    const download = await element.downloadPdf();
    expect(download.downloaded).toBe(false);
    expect(pdfs[0]?.pageCount).toBe(1);
    expect(pdfs[0]?.fileName).toMatch(/\.pdf$/);

    // A button with action "pdf" goes the same way, and is not reported as unhandled.
    const actions = listen<{ action: string }>(element, "datum-form-action");
    shadow.querySelector<HTMLButtonElement>('[data-button-action="pdf"]')!.click();
    await until(() => pdfs.length === 2);
    expect(actions.filter((detail) => detail.action === "pdf")).toEqual([]);
  });

  it("prints the layout the answers choose from a pdf button: datum-pdf's layoutId follows setValue", async () => {
    const seen: unknown[] = [];
    const layout = (id: string, when?: string) => ({
      id,
      kind: "generated" as const,
      ...(when ? { when } : {}),
      root: { id: "document", type: "pdf-document", configuration: {}, children: { body: [{ id: "t", type: "pdf-text", configuration: { text: id } }] } }
    });
    const element = mount((el) => {
      el.definition = {
        ...sampleDefinition(),
        root: {
          ...sampleDefinition().root,
          children: {
            content: [
              ...(sampleDefinition().root.children?.content ?? []),
              { id: "print", type: "button", configuration: { label: "PDF", action: "pdf" } }
            ]
          }
        },
        pdf: {
          layouts: [
            layout("standard"),
            layout("alternate", 'fullName = "Other"')
          ],
          defaultLayoutId: "standard"
        }
      };
      el.pdfSupport = fakeSupport(seen);
      // The PDF button checks the answers first, so the required name is given.
      el.values = { fullName: "Ada" };
    });
    const shadow = await paintedForm(element);
    const pdfs = listen<{ layoutId: string; layoutChoice?: string; fileName: string }>(element, "datum-pdf");
    element.addEventListener("datum-pdf", (event) => event.preventDefault());
    // A listener takes each file over, so nothing should reach the browser; the stubs keep jsdom honest if one did.
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:pdf" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: () => {} });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    try {
      // Looked up at each press: a repaint after setValue may draw the button anew.
      const button = { click: () => shadow.querySelector<HTMLButtonElement>('[data-button-action="pdf"]')!.click() };
      button.click();
      await until(() => pdfs.length === 1);
      expect(pdfs[0]).toMatchObject({ layoutId: "standard", layoutChoice: "default" });

      element.runtime!.setValue("fullName", "Other");
      button.click();
      await until(() => pdfs.length === 2);
      expect(pdfs[1]).toMatchObject({ layoutId: "alternate", layoutChoice: "condition" });
      expect(pdfs[1]!.fileName).toMatch(/^sample-form-alternate-/);

      element.runtime!.setValue("fullName", "Ada");
      button.click();
      await until(() => pdfs.length === 3);
      expect(pdfs[2]).toMatchObject({ layoutId: "standard", layoutChoice: "default" });
      expect(click).not.toHaveBeenCalled();
    } finally {
      click.mockRestore();
      delete (URL as { createObjectURL?: unknown }).createObjectURL;
      // The no-op revokeObjectURL stays (see the download test above).
    }
  });

  it("signs through pdfSigner: the handoff reaches the signer, the completed bytes download, datum-pdf carries the signature", async () => {
    const HANDOFF = { field: "Signature1", byteRange: [0, 10, 20, 5], digest: "ZGlnZXN0", toBeSigned: "dG8tYmUtc2lnbmVk", toBeSignedDigest: "dGJzLWRpZ2VzdA==", signatureAlgorithm: "RSASSA-PKCS1-v1_5-SHA256", subFilter: "ETSI.CAdES.detached" };
    const seen: Array<{ op?: string; signature?: unknown; signing?: { value?: string; certificates?: string[] } }> = [];
    const support = {
      provider: {
        id: "fake",
        abiVersion: "1.0.0",
        render: async (request: { signature?: unknown }) => {
          seen.push({ op: "render", signature: request.signature });
          return { bytes: new TextEncoder().encode("%PDF-prepared"), pageCount: 1, pages: [], warnings: [], providerId: "fake", ...(request.signature ? { signing: HANDOFF } : {}) };
        },
        complete: async (request: { signing: { value?: string; certificates?: string[] } }) => {
          seen.push({ op: "complete", signing: request.signing });
          return { bytes: new TextEncoder().encode("%PDF-signed"), field: "Signature1", cms: "Y21z", timestamped: false, providerId: "fake" };
        }
      }
    } as unknown as import("../src/pdf.js").DatumPdfSupport;
    const calls: Array<[string, string]> = [];
    const signer = {
      certificates: ["Y2VydA=="],
      sign: async (toBeSigned: Uint8Array, algorithm: string) => {
        calls.push([new TextDecoder().decode(toBeSigned), algorithm]);
        return new Uint8Array([7, 7, 7]);
      }
    };
    const element = mount((el) => {
      el.definition = sampleDefinition();
      el.values = { fullName: "Ada Lovelace" };
      el.pdfSupport = support;
      el.pdfSigner = signer;
      el.pdfSignature = { settings: { reason: "Approved" } };
    });
    await paintedForm(element);
    expect(element.pdfSigner).toBe(signer);
    expect(element.renderer!.pdfSigner).toBe(signer);

    const pdfs = listen<{ signature?: { field: string; algorithm: string } }>(element, "datum-pdf");
    element.addEventListener("datum-pdf", (event) => event.preventDefault());
    const download = await element.downloadPdf();
    expect(new TextDecoder().decode(download.bytes)).toBe("%PDF-signed");
    expect(download.signature).toEqual({ field: "Signature1", algorithm: "RSASSA-PKCS1-v1_5-SHA256", subFilter: "ETSI.CAdES.detached", certificates: ["Y2VydA=="], timestamped: false });
    expect(pdfs[0]?.signature?.field).toBe("Signature1");
    expect(calls).toEqual([["to-be-signed", "RSASSA-PKCS1-v1_5-SHA256"]]);
    expect(seen[0]?.signature).toEqual({ reason: "Approved", certificates: ["Y2VydA=="] });
    expect(seen[1]?.signing?.value).toBe(Buffer.from([7, 7, 7]).toString("base64"));

    // A per-call signature wins over the property; without either the PDF is plain.
    const other = { certificates: ["b3RoZXI="], sign: async () => new Uint8Array([1]) };
    const perCall = await element.renderPdf({ signature: { signer: other } });
    expect(perCall.signature?.certificates).toEqual(["b3RoZXI="]);
    element.pdfSigner = undefined;
    element.pdfSignature = undefined;
    await until(() => element.renderer!.pdfSigner === undefined);
    const plain = await element.renderPdf();
    expect(plain.signature).toBeUndefined();
    expect(new TextDecoder().decode(plain.bytes)).toBe("%PDF-prepared");
  });

  it("applies pdf-unknown-components to every PDF, a per-call policy winning, and refuses a bad value", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const seen: unknown[] = [];
    const element = mount((el) => {
      el.definition = {
        ...sampleDefinition(),
        root: {
          ...sampleDefinition().root,
          children: { content: [...(sampleDefinition().root.children?.content ?? []), { id: "stars", type: "rating", configuration: { label: "Stars" } }] }
        }
      };
      el.values = { fullName: "Ada Lovelace", stars: 4 };
      el.pdfSupport = fakeSupport(seen);
    });
    await paintedForm(element);

    // Unset: the type the page never defined a rendition for is drawn generically, with a warning.
    const warned = await element.renderPdf();
    expect(warned.warnings).toContainEqual(expect.objectContaining({ code: "component.unknown", componentId: "stars" }));
    expect(JSON.stringify(seen[0])).toContain("Stars");

    element.setAttribute("pdf-unknown-components", "fail");
    await until(() => element.renderer!.pdfUnknownComponents === "fail");
    await expect(element.renderPdf()).rejects.toMatchObject({ code: "unknown_component" });
    expect(seen).toHaveLength(1);
    // A per-call policy wins over the attribute.
    expect((await element.renderPdf({ unknownComponents: "ignore" })).warnings.some((warning) => warning.code === "component.unknown")).toBe(false);

    const errors = listen<DatumErrorDetail>(element, "datum-error");
    element.setAttribute("pdf-unknown-components", "shrug");
    await until(() => errors.length > 0);
    expect(errors[0]!.message).toContain("pdf-unknown-components must be one of ignore, warn, fail");
    element.removeAttribute("pdf-unknown-components");
    await until(() => element.renderer!.pdfUnknownComponents === undefined);
    consoleError.mockRestore();
  });

  // risky-patterns reaches the PDF path the way formula-errors does.
  it("forwards risky-patterns to the renderer element, the default of its PDF path", async () => {
    const seen: unknown[] = [];
    const element = mount((el) => {
      el.definition = sampleDefinition();
      el.values = { fullName: "Ada Lovelace" };
      el.pdfSupport = fakeSupport(seen);
    });
    await paintedForm(element);
    expect(element.renderer?.riskyPatterns).toBeUndefined();
    element.setAttribute("risky-patterns", "allow");
    await until(() => element.renderer?.riskyPatterns === "allow");
    await expect(element.renderPdf()).resolves.toBeDefined();
    element.riskyPatterns = "refuse";
    await until(() => element.renderer?.riskyPatterns === "refuse");
    element.removeAttribute("risky-patterns");
    await until(() => element.renderer?.riskyPatterns === undefined);
  });

  it("prints a custom type through the rendition its definition declares, with nothing unknown", async () => {
    const seen: unknown[] = [];
    const rating: ComponentDefinition = {
      type: "rating",
      version: "1.0.0",
      createDefault: () => ({ id: "rating", type: "rating", configuration: {} }),
      capabilities: [],
      pdf: {
        defaultRendition: "stars",
        renditions: [
          {
            id: "stars",
            render: (_node, context) => {
              const ctx = context as { nextId(): string; value: { text: string } };
              return [{ id: ctx.nextId(), kind: "paragraph", runs: [{ text: `${"*".repeat(Number(ctx.value.text))} (${ctx.value.text})` }] }];
            }
          }
        ]
      }
    };
    const element = mount((el) => {
      el.componentDefinitions = [rating];
      el.definition = {
        ...sampleDefinition(),
        root: {
          ...sampleDefinition().root,
          children: { content: [...(sampleDefinition().root.children?.content ?? []), { id: "stars", type: "rating", configuration: { label: "Stars" } }] }
        }
      };
      el.values = { fullName: "Ada Lovelace", stars: 4 };
      el.pdfSupport = fakeSupport(seen);
    });
    await paintedForm(element);

    const result = await element.renderPdf({ unknownComponents: "fail" });
    expect(result.warnings.some((warning) => warning.code === "component.unknown")).toBe(false);
    expect(JSON.stringify(seen[0])).toContain("**** (4)");
  });

  it("rejects a PDF when neither the pdf attribute nor pdfSupport is set, and passes the button action through", async () => {
    const element = mount((el) => {
      el.definition = {
        ...sampleDefinition(),
        root: {
          ...sampleDefinition().root,
          children: { content: [{ id: "print", type: "button", configuration: { label: "PDF", action: "pdf" } }] }
        }
      };
    });
    const shadow = await paintedForm(element);
    await expect(element.renderPdf()).rejects.toThrow(/No PDF support/);
    const actions = listen<{ action: string }>(element, "datum-form-action");
    shadow.querySelector<HTMLButtonElement>('[data-button-action="pdf"]')!.click();
    expect(actions.map((detail) => detail.action)).toEqual(["pdf"]);
  });

  it("resolves the pdf attribute to the module beside the bundle, or to a page URL", async () => {
    const { resolvePdfModuleUrl } = await import("../src/pdf-loader.js");
    expect(resolvePdfModuleUrl("auto")).toMatch(/\/datum-pdf\.js$/);
    expect(resolvePdfModuleUrl("/assets/datum-pdf.js")).toBe(new URL("/assets/datum-pdf.js", document.baseURI).href);
  });
});

describe("<datum-form> sandboxed validation", () => {
  /** A page's rules as the sandbox takes them: one over a field, one over two fields and what the page injected. */
  const RULES: WasmPluginSource = {
    id: "sample-rules",
    version: "1.0.0",
    source: `({
      validators: [
        (context) => {
          const errors = [];
          const name = context.values.fullName;
          if (typeof name === "string" && name.trim().length > 0 && !name.trim().includes(" ")) {
            errors.push({ code: "custom.fullNameIncomplete", componentId: "fullName", path: "fullName", stage: "sample-rules", source: "custom" });
          }
          const allowed = context.externalData && context.externalData.allowedCountries;
          if (Array.isArray(allowed) && typeof context.values.country === "string" && context.values.country !== "" && !allowed.includes(context.values.country)) {
            errors.push({ code: "custom.countryNotAllowed", componentId: "country", path: "country", stage: "sample-rules", source: "custom" });
          }
          return { errors };
        }
      ]
    })`
  };

  /** A fake sandbox module as a data: URL, the way a page's `wasm` URL would serve the real one. */
  function fakeModuleUrl(code: string): string {
    return `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;
  }

  async function submitted(element: DatumFormElement): Promise<DatumFormSubmitDetail> {
    return element.submit();
  }

  it("re-validates and sanitizes at submit in a sandbox the page built, over the external data the page injects", async () => {
    const { createWasmValidationHost } = await import("../src/wasm.js");
    const host = await createWasmValidationHost([RULES]);
    // The runtime hands the sandbox the options its data sources hold (optionSnapshot): the
    // page injects nothing for them.
    const injected: unknown[] = [];
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.messages = { "custom.fullNameIncomplete": { default: "Enter your first and last name." } };
      el.wasmExternalData = (context) => {
        injected.push(context);
        return { allowedCountries: ["CA"] };
      };
      el.wasmValidationHost = host;
      el.definition = sampleDefinition();
    });
    const ready = listen<DatumFormWasmReadyDetail>(element, "datum-wasm-ready");
    const form = await paintedForm(element);
    await until(() => ready.length === 1);
    expect(ready[0]!.host).toBe(host);
    expect(element.wasmValidationHost).toBe(host);
    const runtime = element.runtime!;

    // A first name alone passes the field constraints and fails the page's rule: the sandbox's
    // verdict shows on the field, worded by the page's messages, like any other error.
    type(control(form, "fullName")!, "Ada");
    await until(() => element.values.fullName === "Ada");
    const rejected = await submitted(element);
    expect(rejected.accepted).toBe(false);
    expect(rejected.errors).toMatchObject([{ code: "custom.fullNameIncomplete", componentId: "fullName", source: "custom" }]);
    await until(() => describedBy(control(form, "fullName")) === "Enter your first and last name.");
    expect(injected).toMatchObject([{ formId: "sample-form", values: { fullName: "Ada" }, locale: "en" }]);

    // The external data is what the rule over two fields reads: the page allowed Canada alone.
    type(control(form, "fullName")!, "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    runtime.setValue("country", "US");
    expect((await submitted(element)).errors).toMatchObject([{ code: "custom.countryNotAllowed", componentId: "country" }]);

    // Accepted: the submission holds the sanitized values, keys the form does not define gone.
    runtime.setValue("country", "CA");
    runtime.setValue("notInTheForm", "vanishes");
    const accepted = await submitted(element);
    expect(accepted.accepted).toBe(true);
    const values = accepted.submission!.submission.values as Record<string, unknown>;
    expect(values).toMatchObject({ fullName: "Ada Lovelace", country: "CA" });
    expect("notInTheForm" in values).toBe(false);
    // The sandbox arriving never rebuilt the runtime: what was typed stayed.
    expect(element.runtime).toBe(runtime);
    host.dispose();
  });

  it("refuses an answer to a source-backed choice when the source fails at submit: the snapshot omits it (fail closed)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { createWasmValidationHost } = await import("../src/wasm.js");
    const host = await createWasmValidationHost([RULES]);
    let loads = 0;
    const element = mount((el) => {
      // Answers while the form paints, then goes down before the submit.
      el.dataSources = {
        countries: () => {
          loads += 1;
          if (loads > 1) {
            throw new Error("source down");
          }
          return COUNTRIES;
        }
      };
      el.wasmValidationHost = host;
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    await until(() => form.querySelector("select option[value='CA']"));
    type(control(form, "fullName")!, "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    element.runtime!.setValue("country", "CA");
    const refused = await submitted(element);
    expect(refused.accepted).toBe(false);
    expect(refused.errors).toMatchObject([{ code: "option.sourceUnavailable", componentId: "country" }]);
    host.dispose();
  });

  it("loads the module wasm names once the form is ready, wired with the page's plugins", async () => {
    // The fake module records what it was wired with and answers with a verdict of its own.
    const url = fakeModuleUrl(`
      export const WASM_ABI_VERSION = ${JSON.stringify(WASM_ABI_VERSION)};
      export function createWasmValidationHost(plugins) {
        return Promise.resolve({
          plugins,
          run: async ({ context }) => ({
            errors: context.values.fullName === "Ada" ? [{ code: "custom.fromModule", componentId: "fullName", path: "fullName", stage: "module", source: "custom" }] : [],
            values: context.values
          }),
          dispose() {}
        });
      }`);
    const { resolveWasmModuleUrl } = await import("../src/wasm-loader.js");
    expect(resolveWasmModuleUrl("auto")).toMatch(/\/datum-wasm\.js$/);
    expect(resolveWasmModuleUrl("/assets/datum-wasm.js")).toBe(new URL("/assets/datum-wasm.js", document.baseURI).href);

    const element = mount((el) => {
      // A data: module has no origin, so only the property may name it.
      el.wasm = url;
      el.wasmPlugins = [RULES];
      el.definition = sampleDefinition();
    });
    const ready = listen<DatumFormWasmReadyDetail>(element, "datum-wasm-ready");
    const form = await paintedForm(element);
    const runtime = element.runtime!;
    // Fetched as soon as the form was ready, not at the first submit.
    await until(() => ready.length === 1);
    expect((ready[0]!.host as unknown as { plugins: unknown }).plugins).toEqual([RULES]);
    expect(element.wasmValidationHost).toBe(ready[0]!.host);

    type(control(form, "fullName")!, "Ada");
    await until(() => element.values.fullName === "Ada");
    expect((await submitted(element)).errors).toMatchObject([{ code: "custom.fromModule", componentId: "fullName" }]);

    // A new plugin list takes effect on the next submit, which waits for a sandbox wired with it.
    const other: WasmPluginSource = { ...RULES, id: "other-rules" };
    element.wasmPlugins = [other];
    await until(() => ready.length === 2);
    expect((ready[1]!.host as unknown as { plugins: unknown }).plugins).toEqual([other]);
    expect(element.runtime).toBe(runtime);
  });

  it("waits for a sandbox still arriving, and fails closed when it never does", async () => {
    // A promise of a host is enough to build the form with a sandbox stage: the submit waits.
    let arrive!: (host: Awaited<ReturnType<typeof import("../src/wasm.js")["createWasmValidationHost"]>>) => void;
    const arriving = new Promise<Awaited<ReturnType<typeof import("../src/wasm.js")["createWasmValidationHost"]>>>((resolve) => {
      arrive = resolve;
    });
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.wasmValidationHost = arriving;
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    expect(element.wasmValidationHost).toBeUndefined();
    type(control(form, "fullName")!, "Ada");
    await until(() => element.values.fullName === "Ada");
    let outcome: DatumFormSubmitDetail | undefined;
    const pending = submitted(element).then((detail) => {
      outcome = detail;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(outcome).toBeUndefined();
    const { createWasmValidationHost } = await import("../src/wasm.js");
    const host = await createWasmValidationHost([RULES]);
    arrive(host);
    await pending;
    expect(outcome!.errors).toMatchObject([{ code: "custom.fullNameIncomplete" }]);
    expect(element.wasmValidationHost).toBe(host);
    host.dispose();

    // A module that cannot be loaded blocks the submission rather than skipping the sandbox,
    // and is reported so the page author sees why.
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = mount((el) => {
      el.setAttribute("wasm", "/nowhere/datum-wasm.js");
      // Wired, since an unwired source is a datum-error of its own and this
      // test waits for the one error the missing module makes.
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const errors = listen<DatumErrorDetail>(broken, "datum-error");
    const brokenForm = await paintedForm(broken);
    await until(() => errors.length === 1);
    expect(errors[0]!.message).toContain(`wasm="${new URL("/nowhere/datum-wasm.js", document.baseURI).href}"`);
    type(control(brokenForm, "fullName")!, "Ada Lovelace");
    await until(() => broken.values.fullName === "Ada Lovelace");
    const blocked = await submitted(broken);
    expect(blocked.accepted).toBe(false);
    expect(blocked.errors).toMatchObject([{ code: "wasm.execution_error", source: "wasm" }]);
    consoleError.mockRestore();
  });

  it("validates in-process alone without a way to a sandbox, as before", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    await paintedForm(element);
    expect(element.wasm).toBeUndefined();
    expect(element.wasmValidationHost).toBeUndefined();
    element.runtime!.setValue("fullName", "Ada");
    element.runtime!.setValue("notInTheForm", "survives");
    const accepted = await submitted(element);
    expect(accepted.accepted).toBe(true);
    expect((accepted.submission!.submission.values as Record<string, unknown>).notInTheForm).toBe("survives");
  });

  it("reports the sandbox's exchange and run log on datum-wasm-validated, at the level wasm-log-level asks for", async () => {
    const { createWasmValidationHost } = await import("../src/wasm.js");
    const host = await createWasmValidationHost([
      {
        id: "chatty-rules",
        version: "1.0.0",
        source: `({ validators: [(context) => {
          context.log.debug("looked at the name", { fullName: context.values.fullName });
          context.log.warn("still checking");
          return { errors: [] };
        }] })`
      }
    ]);
    const element = mount((el) => {
      el.setAttribute("wasm-log-level", "debug");
      el.wasmValidationHost = host;
      el.definition = sampleDefinition();
    });
    const validated = listen<DatumFormWasmValidatedDetail>(element, "datum-wasm-validated");
    await paintedForm(element);
    element.runtime!.setValue("fullName", "Ada Lovelace");
    element.runtime!.setValue("notInTheForm", "gone");

    expect((await element.submit()).accepted).toBe(true);
    await until(() => validated.length === 1);
    const debug = validated[0]!;
    expect(debug.blocked).toBe(false);
    expect(debug.logLevel).toBe("debug");
    expect(debug.values).toMatchObject({ fullName: "Ada Lovelace", notInTheForm: "gone" });
    expect(debug.outcome?.values).toEqual({ fullName: "Ada Lovelace" });
    // The kernel's steps around what the rule said, in order, its data intact. The choice-answer
    // check says which sources the option snapshot lacked, so those answers went unheld.
    expect(debug.logs.map((entry) => `${entry.level}: ${entry.message}`)).toEqual([
      "debug: run: schema root, unknown fields strip",
      "info: unknown fields stripped",
      "info: choice answers not held to their options: the option snapshot lacks their sources",
      "debug: field constraints: 0 error(s)",
      "debug: looked at the name",
      "warn: still checking",
      "debug: validator 1: 0 error(s)",
      "info: accepted: 0 error(s), 1 value(s)"
    ]);
    expect(debug.logs[4]?.data).toEqual({ fullName: "Ada Lovelace" });

    // The property is read at each submit: back to the kernel's default, only the warning is kept.
    element.wasmLogLevel = undefined;
    expect((await element.submit()).accepted).toBe(true);
    await until(() => validated.length === 2);
    expect(validated[1]!.logLevel).toBeUndefined();
    expect(validated[1]!.logs).toEqual([{ level: "warn", message: "still checking" }]);
    expect(validated[1]!.outcome?.logs).toEqual(validated[1]!.logs);

    // Off keeps nothing, and a level the attribute does not know is reported, not applied.
    element.setAttribute("wasm-log-level", "off");
    expect((await element.submit()).accepted).toBe(true);
    await until(() => validated.length === 3);
    expect(validated[2]!.logs).toEqual([]);
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    element.setAttribute("wasm-log-level", "loud");
    expect(errors[0]!.message).toContain('not "loud"');
    expect(element.wasmLogLevel).toBe("off");
    consoleError.mockRestore();
    host.dispose();
  });
});

describe("<datum-form> a submission in flight", () => {
  function submitButton(form: ShadowRoot): HTMLButtonElement {
    return form.querySelector<HTMLButtonElement>('[data-button-action="submit"]')!;
  }

  function nameInput(form: ShadowRoot): HTMLInputElement {
    return control(form, "fullName")!;
  }

  const tick = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  it("locks the form from the click until the page's delivery settles, says so, and takes nothing meanwhile", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");

    // A rejected submit unlocks at once and takes the person to the error summary.
    submitButton(form).focus();
    submitButton(form).click();
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(false);
    await until(() => inSummary(form));
    expect(element.submitting).toBe(false);
    expect(form.querySelector("form[aria-busy]")).toBeNull();

    type(nameInput(form), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    let release!: () => void;
    const delivery = new Promise<void>((resolve) => {
      release = resolve;
    });
    element.addEventListener("datum-submit", (event) => {
      (event as CustomEvent<DatumFormSubmitDetail>).detail.waitUntil(delivery);
    });

    submitButton(form).focus();
    submitButton(form).click();
    // Locked at once, before the runtime has answered: the element says so, and so does the form.
    expect(element.submitting).toBe(true);
    expect(element.hasAttribute("submitting")).toBe(true);
    await until(() => form.querySelector('form[aria-busy="true"]'));
    expect(statusLinesSaying(form, "Submitting…")).toHaveLength(1);
    expect(box(form, "fullName").hasAttribute("inert")).toBe(true);
    await until(() => submits.length === 2);
    expect(submits[1]!.accepted).toBe(true);

    // Still locked: the page's delivery is pending. Typing and clicking change nothing.
    await tick();
    expect(element.submitting).toBe(true);
    expect(form.querySelector('form[aria-busy="true"]')).toBeTruthy();
    type(nameInput(form), "Grace Hopper");
    submitButton(form).click();
    await tick();
    expect(element.values.fullName).toBe("Ada Lovelace");
    expect(submits).toHaveLength(2);
    // A second submit() joins the one in flight rather than starting another.
    const joined = element.submit();
    // A browser with `inert` has blurred the button; the lock remembers where focus was.
    (form.activeElement as HTMLElement | null)?.blur();

    release();
    expect(await joined).toBe(submits[1]);
    expect(element.submitting).toBe(false);
    expect(element.hasAttribute("submitting")).toBe(false);
    expect(submits).toHaveLength(2);
    await until(() => !form.querySelector("form[aria-busy]"));
    expect(statusLinesSaying(form, "Submitting…")).toEqual([]);
    expect(box(form, "fullName").hasAttribute("inert")).toBe(false);
    expect(form.activeElement).toBe(submitButton(form));
  });

  it("reports a delivery that failed, lifts the lock all the same, and refuses a waitUntil after the fact", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    type(nameInput(form), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    let captured: DatumFormSubmitDetail | undefined;
    element.addEventListener("datum-submit", (event) => {
      captured = (event as CustomEvent<DatumFormSubmitDetail>).detail;
      captured.waitUntil(Promise.reject(new Error("502 Bad Gateway")));
      // A second extension, added during the first: awaited too.
      captured.waitUntil(tick(20));
    });
    const detail = await element.submit();
    expect(detail.accepted).toBe(true);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.message).toContain("waitUntil");
    expect((errors[0]!.cause as Error).message).toBe("502 Bad Gateway");
    expect(element.submitting).toBe(false);
    expect(() => captured!.waitUntil(Promise.resolve())).toThrow(/waitUntil/);
    consoleError.mockRestore();
  });

  it("words the status line from texts, per locale, through the attribute or the property", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.setAttribute("texts", JSON.stringify({ submitting: { default: "Sending…", locales: { "fr-CA": "Envoi en cours…" } } }));
      el.setAttribute("locale", "fr-CA");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    expect(element.texts?.submitting).toEqual({ default: "Sending…", locales: { "fr-CA": "Envoi en cours…" } });
    type(nameInput(form), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    // The status line is up before the runtime has answered, so the listener (and its release)
    // arrives after it: wait for both.
    let release: (() => void) | undefined;
    element.addEventListener("datum-submit", (event) => {
      (event as CustomEvent<DatumFormSubmitDetail>).detail.waitUntil(
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
    });
    const first = element.submit();
    await until(() => statusLinesSaying(form, "Envoi en cours…").length === 1);
    await until(() => release);
    release!();
    await first;

    element.setLocale("en");
    element.texts = { submitting: "Hold on" };
    release = undefined;
    const second = element.submit();
    await until(() => statusLinesSaying(form, "Hold on").length === 1);
    await until(() => release);
    release!();
    await second;
    expect(statusLinesSaying(form, "Hold on")).toEqual([]);
  });

  it("puts the status line at the ends submitting-placement lists, the bottom copy an echo, through the attribute or the property", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.setAttribute("submitting-placement", "top bottom");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    expect(element.submittingPlacement).toEqual(["top", "bottom"]);
    type(nameInput(form), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    let release: (() => void) | undefined;
    element.addEventListener("datum-submit", (event) => {
      (event as CustomEvent<DatumFormSubmitDetail>).detail.waitUntil(
        new Promise<void>((resolve) => {
          release = resolve;
        })
      );
    });
    const first = element.submit();
    await until(() => statusLinesSaying(form, "Submitting…").length === 2);
    const [top, bottom] = statusLinesSaying(form, "Submitting…");
    expect(top!.getAttribute("role")).toBe("status");
    expect(bottom!.getAttribute("aria-hidden")).toBe("true");
    expect(standsBefore(top!, box(form, "fullName"))).toBe(true);
    expect(standsBefore(box(form, "fullName"), bottom!)).toBe(true);
    await until(() => release);
    release!();
    await first;
    expect(statusLinesSaying(form, "Submitting…")).toEqual([]);

    // The bottom alone: one live region, after the fields.
    element.submittingPlacement = ["bottom"];
    release = undefined;
    const second = element.submit();
    await until(() => statusLinesSaying(form, "Submitting…").length === 1);
    expect(statusLinesSaying(form, "Submitting…")[0]!.getAttribute("role")).toBe("status");
    expect(standsBefore(box(form, "fullName"), statusLinesSaying(form, "Submitting…")[0]!)).toBe(true);
    await until(() => release);
    release!();
    await second;

    // An end that is not one: reported, the placement left as it was.
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    element.setAttribute("submitting-placement", "middle");
    expect(errors[0]).toContain('not "middle"');
    expect(element.submittingPlacement).toEqual(["bottom"]);
  });

  it("puts the error summary at the ends error-summary lists, or nowhere, through the attribute or the property", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.setAttribute("error-summary", "none");
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    expect(element.errorSummaryPlacement).toEqual([]);
    await element.validate();
    await until(() => form.querySelector('[aria-invalid="true"]'));
    // No summary, the inline errors alone.
    expect(summaryOf(form)).toBeNull();
    expect(summaryCopies(form)).toEqual([]);
    expect(invalidIds(form)).toEqual(["fullName"]);

    // Both ends: the top copy is the alert, the bottom one repeats it after the fields.
    element.errorSummaryPlacement = ["top", "bottom"];
    await until(() => summaryCopies(form).length === 2);
    const [top, bottom] = summaryCopies(form);
    expect(top!.querySelector("[role='alert']")).not.toBeNull();
    expect(bottom!.querySelector("[role]")).toBeNull();
    expect(top).toBe(summaryOf(form));
    expect(standsBefore(top!, box(form, "fullName"))).toBe(true);
    expect(standsBefore(box(form, "fullName"), bottom!)).toBe(true);

    // The attribute again, the bottom alone; and an end that is not one is reported.
    element.setAttribute("error-summary", "bottom");
    await until(() => summaryCopies(form).length === 1);
    expect(standsBefore(box(form, "fullName"), summaryCopies(form)[0]!)).toBe(true);
    const errors: string[] = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent<{ message: string }>).detail.message));
    element.setAttribute("error-summary", "sideways");
    await until(() => errors.length === 1);
    expect(errors[0]).toContain('error-summary lists "top" and/or "bottom", or "none"');
    expect(element.errorSummaryPlacement).toEqual(["bottom"]);
  });

  it("shows the receipt through setNotice, takes focus to it, keeps it across a locale switch, and clears it on the next submit", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = withEngineWords(sampleDefinition(), "fr", { texts: { noticeSuccess: "Succès : " } });
    });
    const form = await paintedForm(element);
    type(nameInput(form), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    expect((await element.submit()).accepted).toBe(true);

    element.setNotice({
      title: { default: "Application received", locales: { "fr-CA": "Demande reçue" } },
      message: "Keep this number for your records.",
      details: [{ label: { default: "Confirmation number", locales: { "fr-CA": "Numéro de confirmation" } }, value: "GC-48213" }]
    });
    expect(element.notice?.details?.[0]?.value).toBe("GC-48213");
    await until(() => noticeOf(form));
    // The default notice names its kind for assistive technology ahead of its title.
    expect(headingText(noticeOf(form))).toBe("Success: Application received");
    expect(noticeOf(form)!.querySelector("dd")?.textContent).toBe("GC-48213");
    await until(() => form.activeElement === noticeOf(form));

    // The receipt follows the language switcher, and keeps its focus through the repaint.
    element.setLocale("fr-CA");
    await until(() => headingText(noticeOf(form)) === "Succès : Demande reçue");
    expect(noticeOf(form)!.querySelector("dt")?.textContent).toBe("Numéro de confirmation");
    expect(form.activeElement).toBe(noticeOf(form));

    // Keeping the answers as sent is the page's call, through mode; the receipt stays.
    element.mode = "readonly";
    await until(() => submitButton(form).hasAttribute("disabled"));
    expect(noticeOf(form)).toBeTruthy();
    element.mode = "interactive";
    await until(() => !submitButton(form).hasAttribute("disabled"));

    // The next submit is a new outcome: the receipt goes with it.
    await element.submit();
    expect(element.notice).toBeUndefined();
    expect(noticeOf(form)).toBeNull();

    // And a page clears one itself.
    element.setNotice({ kind: "info", message: "Saved for later." });
    await until(() => noticeOf(form)?.textContent?.includes("Saved for later."));
    element.setNotice(undefined);
    expect(noticeOf(form)).toBeNull();
  });

  it("draws a warning as a polite status and an error as an alert, each focused, the error's echo silent", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);

    element.setNotice({ kind: "warning", title: "Check the date", message: "It is in the past." });
    await until(() => noticeOf(form));
    const warning = noticeOf(form)!;
    expect(warning.getAttribute("role")).toBe("status");
    await until(() => form.activeElement === warning);

    element.setNotice({ kind: "error", title: "Not delivered", message: "Try again.", placement: ["top", "bottom"] });
    await until(() => receiptsTitled(form, "Not delivered").length === 2);
    const [top, echo] = receiptsTitled(form, "Not delivered");
    expect(top!.getAttribute("role")).toBe("alert");
    expect(top!.getAttribute("tabindex")).toBe("-1");
    expect(echo!.hasAttribute("role")).toBe(false);
    expect(echo!.getAttribute("aria-hidden")).toBe("true");
    await until(() => form.activeElement === top);
    // A repaint puts focus back on the notice, never on the echo; the rebuilt node is a status, so it is not announced again.
    element.setLocale("fr-CA");
    await until(() => form.querySelector("form")?.getAttribute("lang") === "fr-CA");
    expect(form.activeElement).toBe(noticeOf(form));
    expect(form.activeElement?.getAttribute("role")).toBe("status");
  });

  it("announces an error notice once: later repaints draw it as a status, a new notice is an alert again", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const notice = (): HTMLElement => noticeOf(form)!;

    element.setNotice({ kind: "error", title: "Not delivered", message: "Try again." });
    await until(() => noticeOf(form));
    expect(notice().getAttribute("role")).toBe("alert");

    // A keystroke repaints the form; the notice is the same sentence, so it is not an alert node inserted afresh.
    type(nameInput(form), "Ada Lovelace");
    await until(() => element.values.fullName === "Ada Lovelace");
    await until(() => notice().getAttribute("role") === "status");
    expect(notice().getAttribute("tabindex")).toBe("-1");
    type(nameInput(form), "Ada Lovelace King");
    await until(() => element.values.fullName === "Ada Lovelace King");
    expect(notice().getAttribute("role")).toBe("status");

    // Setting a notice again (a second failed submit) is a new event: assertive on its first paint.
    element.setNotice({ kind: "error", title: "Not delivered", message: "Try again." });
    await until(() => notice().getAttribute("role") === "alert");
  });

  it("puts the receipt where the page says, with focus on the copy that is the status region", async () => {
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
    });
    const form = await paintedForm(element);
    const fields = (): Element => box(form, "fullName");

    element.setNotice({ title: "Received", placement: ["bottom"] });
    await until(() => noticeOf(form));
    const bottom = noticeOf(form)!;
    expect(standsBefore(fields(), bottom)).toBe(true);
    expect(bottom.getAttribute("role")).toBe("status");
    await until(() => form.activeElement === bottom);

    element.setNotice({ title: "Received", placement: ["top", "bottom"] });
    await until(() => receiptsTitled(form, "Received").length === 2);
    const [top, echo] = receiptsTitled(form, "Received");
    expect(standsBefore(top!, fields())).toBe(true);
    expect(top!.getAttribute("role")).toBe("status");
    expect(echo!.getAttribute("aria-hidden")).toBe("true");
    expect(echo!.hasAttribute("tabindex")).toBe(false);
    await until(() => form.activeElement === top);
    // A repaint puts focus back on the region, never on the echo.
    element.setLocale("fr-CA");
    await until(() => form.querySelector("form")?.getAttribute("lang") === "fr-CA");
    expect(form.activeElement).toBe(noticeOf(form));
    expect(form.activeElement?.getAttribute("role")).toBe("status");
  });
});

describe("<datum-form> signing", () => {
  function passkeyDefinition() {
    const definition = sampleDefinition();
    definition.root.children = {
      content: [
        ...(definition.root.children?.content ?? []),
        { id: "sign", type: "button", configuration: { label: "Submit with passkey", action: "submit", signature: "webauthn" } }
      ]
    };
    return definition;
  }

  it("a button's signature option signs through the provider of that id, and the format the page set shapes the result", async () => {
    const requests: Array<{ canonical: string; signWith?: string; trigger?: { componentId?: string }; format: { scope: string; placement: string } }> = [];
    const passkey = {
      id: "webauthn",
      sign: async (request: (typeof requests)[number]) => {
        requests.push(request);
        return [{ signature: "sig", algorithm: "webauthn-es256", signedAt: 1, participantId: "submitter" }];
      }
    };
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = passkeyDefinition();
      el.values = { fullName: "Ada Lovelace" };
      el.signingProviders = [passkey];
      el.setAttribute("signing-scope", "values");
    });
    const form = await paintedForm(element);
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");
    expect(element.signing).toEqual({ scope: "values" });
    expect(box(form, "sign").querySelector("[data-button-signature]")?.getAttribute("data-button-signature")).toBe("webauthn");

    // The plain submit button signs nothing: the embed's mode does not force it.
    form.querySelector<HTMLElement>('[data-button-action="submit"]:not([data-button-signature])')!.click();
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(true);
    expect(submits[0]!.submission?.signatures).toBeUndefined();
    expect(requests).toEqual([]);

    // The passkey button names the provider; the request carries the scoped canonical and the trigger.
    form.querySelector<HTMLElement>('[data-button-signature="webauthn"]')!.click();
    await until(() => submits.length === 2);
    expect(submits[1]!.accepted).toBe(true);
    expect(submits[1]!.submission?.signatures).toEqual([{ signature: "sig", algorithm: "webauthn-es256", signedAt: 1, participantId: "submitter", format: { scope: "values", placement: "embedded", digest: "sha-256", canonicalization: "jcs" } }]);
    expect(submits[1]!.signed).toBeUndefined();
    expect(requests[0]).toMatchObject({ signWith: "webauthn", trigger: { componentId: "sign" }, format: { scope: "values", placement: "embedded" } });
    expect(JSON.parse(requests[0]!.canonical)).toMatchObject({ fullName: "Ada Lovelace" });

    // The wrapper placement leaves the envelope untouched and hands the signed document over.
    element.setAttribute("signing-placement", "wrapper");
    await until(() => element.signing?.placement === "wrapper");
    await paintedForm(element);
    const shadow = element.renderer!.shadowRoot!;
    await until(() => shadow.querySelector('[data-button-signature="webauthn"]'));
    shadow.querySelector<HTMLElement>('[data-button-signature="webauthn"]')!.click();
    await until(() => submits.length === 3);
    expect(submits[2]!.submission?.signatures).toBeUndefined();
    expect(submits[2]!.signed).toMatchObject({ format: { scope: "values", placement: "wrapper" }, payload: { submission: { values: { fullName: "Ada Lovelace" } } } });
    expect(submits[2]!.signed?.signatures).toHaveLength(1);

    // No provider of that id: refused as a missing provider, never silently unsigned.
    element.signingProviders = undefined;
    await paintedForm(element);
    element.renderer!.shadowRoot!.querySelector<HTMLElement>('[data-button-signature="webauthn"]')!.click();
    await until(() => submits.length === 4);
    expect(submits[3]!.accepted).toBe(false);
    expect(submits[3]!.errors.map((error) => error.code)).toContain("signing.providerMissing");
  });

  it("submit({ signWith }) from script does the same, and a bad signing attribute is reported", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = sampleDefinition();
      el.values = { fullName: "Ada Lovelace" };
      el.signingProvider = { id: "stamp", sign: async () => [{ signature: "s", algorithm: "stamp", signedAt: 2, participantId: "p" }] };
    });
    await paintedForm(element);
    const detail = await element.submit({ signWith: "stamp" });
    expect(detail.accepted).toBe(true);
    expect(detail.submission?.signatures?.[0]?.algorithm).toBe("stamp");
    element.setAttribute("signing-scope", "everything");
    await until(() => consoleError.mock.calls.length > 0);
    expect(String(consoleError.mock.calls[0]?.[1] ?? consoleError.mock.calls[0]?.[0])).toMatch(/signing-scope/);
    consoleError.mockRestore();
  });
  it("sign-with makes every submit sign with that provider; a button's own signature still wins; a missing one refuses", async () => {
    const requests: Array<{ canonical: string; signWith?: string; statement?: string }> = [];
    const provider = (id: string) => ({
      id,
      sign: async (request: (typeof requests)[number]) => {
        requests.push(request);
        return [{ signature: id, algorithm: `${id}-alg`, signedAt: 1, participantId: "submitter" }];
      }
    });
    const element = mount((el) => {
      el.dataSources = { countries: COUNTRIES };
      el.definition = passkeyDefinition();
      el.values = { fullName: "Ada Lovelace" };
      el.signingProviders = [provider("webauthn"), provider("site")];
      el.signing = { scope: "values", statement: "I agree." };
      el.setAttribute("sign-with", "site");
    });
    const form = await paintedForm(element);
    expect(element.signWith).toBe("site");
    const submits = listen<DatumFormSubmitDetail>(element, "datum-submit");

    // The plain submit button signs, with the required provider and the statement.
    form.querySelector<HTMLElement>('[data-button-action="submit"]:not([data-button-signature])')!.click();
    await until(() => submits.length === 1);
    expect(submits[0]!.accepted).toBe(true);
    expect(submits[0]!.submission?.signatures?.[0]).toMatchObject({ algorithm: "site-alg", statement: "I agree." });
    expect(requests[0]).toMatchObject({ signWith: "site", statement: "I agree." });
    expect(JSON.parse(requests[0]!.canonical)).toEqual({ document: { fullName: "Ada Lovelace" }, statement: "I agree." });

    // A button's own signature option wins for its submit.
    form.querySelector<HTMLElement>('[data-button-signature="webauthn"]')!.click();
    await until(() => submits.length === 2);
    expect(submits[1]!.submission?.signatures?.[0]?.algorithm).toBe("webauthn-alg");

    // submit() from script signs too; its own signWith wins.
    expect((await element.submit()).submission?.signatures?.[0]?.algorithm).toBe("site-alg");
    expect((await element.submit({ signWith: "webauthn" })).submission?.signatures?.[0]?.algorithm).toBe("webauthn-alg");

    // A provider no one registered: refused, never delivered unsigned.
    element.signWith = "missing";
    const refused = await element.submit();
    expect(refused.accepted).toBe(false);
    expect(refused.errors.map((error) => error.code)).toContain("signing.providerMissing");

    // Removing the attribute requires nothing again.
    element.signWith = "site";
    element.removeAttribute("sign-with");
    expect(element.signWith).toBeNull();
    expect((await element.submit()).submission?.signatures).toBeUndefined();
  });
});

describe("<datum-form heading-level>", () => {
  it("renders the title at the level the page says, the form's own headings one under it", async () => {
    const definition = sampleDefinition();
    definition.root.children!.content!.push({
      id: "about",
      type: "panel",
      configuration: { label: "About you" },
      children: { content: [{ id: "age", type: "number", configuration: { label: "Age" } }] }
    });
    const element = mount((el) => {
      el.setAttribute("heading-level", "2");
      el.definition = definition;
    });
    const form = await paintedForm(element);
    const levelOf = (text: string): string | undefined =>
      [...form.querySelectorAll("h1, h2, h3, h4, h5, h6")].find((heading) => heading.textContent?.trim() === text)?.tagName;
    // The form's title sits at the level the page says. (A panel's title stays at the renderer's
    // default level for now: nested group levels do not follow heading-level yet.)
    expect(levelOf("Sample")).toBe("H2");
    expect(element.headingLevel).toBe(2);
    // Off the scale, or removed: back to the engine's default, an h1 title.
    element.setAttribute("heading-level", "9");
    await until(() => levelOf("Sample") === "H1");
    expect(element.headingLevel).toBeUndefined();
  });
});

describe("<datum-form> tabs", () => {
  function tabsDefinition() {
    const definition = sampleDefinition();
    definition.root.children!.content = [
      {
        id: "period",
        type: "tabs",
        configuration: { tabs: [{ id: "day", label: "Past day" }, { id: "week", label: "Past week" }] },
        children: {
          day: [{ id: "dayNote", type: "text", configuration: { label: "Day note" } }],
          week: [{ id: "weekNote", type: "text", configuration: { label: "Week note" } }]
        }
      }
    ];
    return definition;
  }

  // The narrow "Contents" view follows the form's width (a ResizeObserver jsdom does not have): the
  // engine's live-tabs.test.ts and live-datum-containers.test.ts cover it.
  it("draws an ARIA tab strip over every panel, the chosen tab shown, and keeps the tab chosen across a repaint", async () => {
    const element = mount((el) => {
      el.definition = tabsDefinition();
    });
    const form = await paintedForm(element);
    await until(() => form.querySelector('[role="tablist"]'));
    const tab = (slot: string) => form.querySelector<HTMLElement>(`[data-tab-select="${slot}"]`)!;
    const panel = (slot: string) => form.querySelector<HTMLElement>(`[data-tab-panel="${slot}"]`)!;
    expect(form.querySelector('[data-tabs-view="contents"]')).toBeNull();
    expect(tab("day").getAttribute("role")).toBe("tab");
    expect(tab("day").getAttribute("aria-selected")).toBe("true");
    expect(tab("day").getAttribute("tabindex")).toBe("0");
    expect(tab("week").getAttribute("aria-selected")).toBe("false");
    expect(tab("week").getAttribute("tabindex")).toBe("-1");
    expect(tab("week").getAttribute("aria-controls")).toBe(panel("week").id);
    expect(panel("week").getAttribute("role")).toBe("tabpanel");
    expect(panel("week").getAttribute("aria-labelledby")).toBe(tab("week").id);
    // Every panel is drawn, so a field keeps its node and its answer while its tab is shut.
    expect(panel("day").hidden).toBe(false);
    expect(panel("week").hidden).toBe(true);
    expect(control(form, "weekNote")).toBeTruthy();

    tab("week").click();
    await until(() => tab("week").getAttribute("aria-selected") === "true");
    expect(panel("week").hidden).toBe(false);
    expect(panel("day").hidden).toBe(true);

    type(control(form, "weekNote")!, "Quiet");
    await until(() => element.values.weekNote === "Quiet");
    await element.renderer!.painted();
    expect(tab("week").getAttribute("aria-selected")).toBe("true");
    expect(panel("day").hidden).toBe(true);
  });
});

describe("<datum-form> a theme or html block loaded from data", () => {
  /** Elements and attributes that should never appear in the renderer's shadow root. */
  function danger(root: ParentNode): string[] {
    const bad: string[] = [];
    for (const element of Array.from(root.querySelectorAll("*"))) {
      if (["script", "iframe", "object", "embed", "base", "meta", "svg", "link"].includes(element.localName)) {
        bad.push(`<${element.localName}>`);
      }
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.startsWith("on")) {
          bad.push(`${element.localName}[${attribute.name}]`);
        }
        if (["href", "src"].includes(attribute.name)) {
          // The DOM has decoded the attribute's character references already, as a click would.
          const scheme = (/^([a-z][a-z0-9+.-]*):/i.exec(attribute.value.replace(/[\u0000- ]/g, ""))?.[1] ?? "").toLowerCase();
          if (scheme === "javascript" || scheme === "vbscript") {
            bad.push(`${element.localName}[${attribute.name}=${attribute.value.slice(0, 40)}]`);
          }
        }
      }
    }
    return bad;
  }

  function withHtml(html: string): FormDefinition {
    const definition = sampleDefinition();
    const root = definition.root as unknown as { configuration: Record<string, unknown>; children?: { content: unknown[] } };
    root.configuration.chrome = { footer: [{ id: "legal", type: "html", html }] };
    root.children!.content.push({ id: "blurb", type: "html", configuration: { content: html } });
    return definition;
  }

  it("an entity-spelt javascript: href in an html component or chrome part draws no link target", async () => {
    for (const html of [
      '<a href="javascript&#58;window.AUDIT_XSS=1">x</a>',
      '<a href="javascript&colon;window.AUDIT_XSS=1">x</a>',
      '<a href="java&Tab;script:window.AUDIT_XSS=1">x</a>',
      '<a href="JAVASCRIPT&#x3a;window.AUDIT_XSS=1">x</a>'
    ]) {
      const element = mount((el) => {
        el.definition = withHtml(html);
      });
      const form = await paintedForm(element);
      await until(() => form.querySelectorAll("a").length >= 2);
      expect(danger(form), html).toEqual([]);
      for (const anchor of Array.from(form.querySelectorAll("a"))) {
        expect(anchor.hasAttribute("href"), html).toBe(false);
      }
      element.remove();
    }
    // Not vacuous: an ordinary link keeps its target, references included.
    const element = mount((el) => {
      el.definition = withHtml('<a href="/terms?a=1&amp;b=2">terms</a>');
    });
    const form = await paintedForm(element);
    await until(() => form.querySelectorAll("a[href]").length >= 2);
    expect(form.querySelector("a")?.getAttribute("href")).toBe("/terms?a=1&b=2");
  });

  it("a binding's css, tokens or responsive tokens, and the host's extra styles, that try to end a <style> add no element to the shadow root", async () => {
    // Roots that take no constructed sheets: the css is read back as <style> text.
    onTestFinished(hideConstructedSheets());
    const binding = createDatumBinding({
      tokens: { "color-primary": 'red"><img src=x onerror=window.AUDIT_XSS=1>', "x}</style><script>": "y" },
      css: [
        "form { color: red } </style><img src=x onerror=window.AUDIT_XSS=1><style>",
        'form::after { content: "</style><script>window.AUDIT_XSS=1</script>" }',
        '@import url("https://evil.example/x.css");',
        "form { background: url(javascript:window.AUDIT_XSS=1) }"
      ],
      responsiveTokens: [
        { media: "(min-width: 1px)</style><img src=x onerror=window.AUDIT_XSS=1>", tokens: { a: "red" } },
        { media: "(min-width: 1px)", tokens: { a: "red</style><img src=x onerror=window.AUDIT_XSS=1>", b: "blue" } }
      ]
    } as never);
    const element = mount((el) => {
      el.definition = sampleDefinition();
      el.binding = binding;
    });
    const form = await paintedForm(element);
    // The host's extras (the builder canvas's chrome styles) are the renderer's own property.
    element.renderer!.extraStyles = ".x { color: red } </style><img src=x onerror=window.AUDIT_XSS=1>";
    await until(() => Array.from(form.querySelectorAll("style")).some((style) => style.textContent?.includes(".x { color: red }")));
    expect(danger(form)).toEqual([]);
    expect(form.querySelectorAll("img, script")).toHaveLength(0);
    expect((window as unknown as Record<string, unknown>).AUDIT_XSS).toBeUndefined();
    // The sheets are text in a sheet (set as text, never parsed as markup), so a closing tag cannot end one.
    const sheets = Array.from(form.querySelectorAll("style")).map((style) => style.textContent ?? "");
    expect(sheets.some((text) => text.includes(".x { color: red }"))).toBe(true);
    // A token with markup in it never reached the root's style attribute.
    expect(form.querySelector("form")!.getAttribute("style") ?? "").not.toContain("onerror");
  });
});

/**
 * Data sources paint first: the form is drawn without waiting for them, a
 * field whose choices are coming says so, a source that fails or runs out of time is reported
 * and shown under its field, and the host can ask to wait (`data-source-wait`).
 */
describe("<datum-form> data sources: paint first, time out, surface", () => {
  const tick = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));

  function countryForm(inline = false): unknown {
    return {
      id: "ds", version: "1", schemaVersion: "1",
      root: { id: "root", type: "form", configuration: {}, children: { content: [
        {
          id: "country", type: "select",
          configuration: { label: "Country", data: { sourceId: "src" }, ...(inline ? { options: [{ value: "inline", label: "Inline author list" }] } : {}) }
        },
        { id: "name", type: "text", configuration: { label: "Name" } }
      ] } }
    };
  }

  function mountSource(source: unknown, options: { inline?: boolean; attributes?: Record<string, string> } = {}) {
    const element = document.createElement("datum-form") as DatumFormElement;
    const errors: Array<{ message: string; sourceId?: string; componentId?: string }> = [];
    element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
    for (const [name, value] of Object.entries(options.attributes ?? {})) element.setAttribute(name, value);
    element.dataSources = { src: source } as never;
    element.definition = countryForm(options.inline) as never;
    document.body.append(element);
    return { element, errors, shadow: () => element.renderer!.shadowRoot! };
  }

  const optionLabels = (shadow: ShadowRoot) => Array.from(shadow.querySelectorAll("select option")).map((option) => option.textContent);

  afterEach(() => vi.restoreAllMocks());

  it("draws the rest of the form while a source is pending, the field loading, and fills it when the source answers", async () => {
    let answer: (items: unknown[]) => void = () => undefined;
    const { shadow } = mountSource(() => new Promise<unknown[]>((resolve) => (answer = resolve)));
    await until(() => control(shadow(), "name"));
    const field = box(shadow(), "country");
    expect(field.getAttribute("data-source")).toBe("loading");
    expect(field.getAttribute("aria-busy")).toBe("true");
    expect(field.querySelector('[data-source-note][role="status"]')?.textContent).toBe("Loading the choices…");
    expect(optionLabels(shadow())).toEqual(["Select…"]);
    answer([{ value: "CA", label: "Canada" }]);
    await until(() => optionLabels(shadow()).includes("Canada"));
    expect(box(shadow(), "country").hasAttribute("aria-busy")).toBe(false);
    expect(box(shadow(), "country").hasAttribute("data-source")).toBe(false);
    expect(box(shadow(), "country").querySelector("[data-source-note]")).toBeNull();
  });

  it("a fast source never shows the loading state", async () => {
    const { shadow } = mountSource(() => Promise.resolve([{ value: "CA", label: "Canada" }]));
    await until(() => optionLabels(shadow()).includes("Canada"));
    expect(shadow().querySelector("[aria-busy]")).toBeNull();
    expect(shadow().querySelector("[data-source-note-for]")).toBeNull();
  });

  it("data-source-wait=all keeps the form back until the sources have answered", async () => {
    let answer: (items: unknown[]) => void = () => undefined;
    const { element, shadow } = mountSource(() => new Promise<unknown[]>((resolve) => (answer = resolve)), { attributes: { "data-source-wait": "all" } });
    expect(element.dataSourceWait).toBe("all");
    await tick(150);
    expect(shadow().querySelector("form")).toBeNull();
    expect(shadow().textContent).toContain("Loading form");
    answer([{ value: "CA", label: "Canada" }]);
    await until(() => shadow().querySelector("form"));
    expect(optionLabels(shadow())).toContain("Canada");
    expect(shadow().querySelector("[aria-busy]")).toBeNull();
  });

  it("data-source-wait=all is bounded by the timeout: the form paints with the failed source shown", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { shadow, errors } = mountSource(() => new Promise(() => undefined), { attributes: { "data-source-wait": "all", "data-source-timeout": "80" } });
    await until(() => shadow().querySelector("form"));
    expect(errors.map((e) => e.sourceId)).toContain("src");
    expect(control(shadow(), "name")).not.toBeNull();
  });

  it("a source that never answers fails after data-source-timeout: datum-error, a notice under the field, no options", async () => {
    const { element, shadow, errors } = mountSource(() => new Promise(() => undefined), { attributes: { "data-source-timeout": "80" } });
    expect(element.dataSourceTimeout).toBe(80);
    await until(() => shadow().querySelector("[data-source-error]"));
    expect(errors).toEqual([expect.objectContaining({ sourceId: "src", componentId: "country", message: expect.stringContaining("did not answer within 80 ms") })]);
    expect(box(shadow(), "country").getAttribute("data-source")).toBe("error");
    const note = box(shadow(), "country").querySelector("[data-source-note]")!;
    expect(note.textContent).toContain("The choices could not be loaded");
    expect(control(shadow(), "country")?.getAttribute("aria-describedby")).toContain(note.id);
    expect(shadow().querySelector("[aria-busy]")).toBeNull();
    expect(optionLabels(shadow())).toEqual(["Select…"]);
    expect(control(shadow(), "name")).not.toBeNull();
  });

  it.each<[string, () => unknown]>([
    ["throws", () => () => { throw new Error("boom"); }],
    ["rejects", () => async () => { throw new Error("rejected"); }],
    ["answers null", () => () => null],
    ["answers undefined", () => () => undefined]
  ])("a loader that %s is reported and shown, and the author's inline list is not offered", async (_name, make) => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { shadow, errors } = mountSource(make(), { inline: true });
    await until(() => shadow().querySelector("[data-source-error]"));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ sourceId: "src", componentId: "country" });
    expect(optionLabels(shadow())).not.toContain("Inline author list");
    expect(control(shadow(), "name")).not.toBeNull();
  });

  it("a remote source that answers something other than JSON is reported and shown", async () => {
    const provider = new RemoteDataSourceProvider("remote", "https://example.test/options", async () => new Response("<html>not json</html>", { status: 200 }));
    const { shadow, errors } = mountSource(provider);
    await until(() => shadow().querySelector("[data-source-error]"));
    expect(errors[0]).toMatchObject({ sourceId: "src" });
  });

  it("a list longer than the cap is cut, warned about, and said so under the field", async () => {
    const { MAX_DATA_SOURCE_ITEMS } = await import("@argusvane/datum-engine");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const total = MAX_DATA_SOURCE_ITEMS + 25;
    const { shadow } = mountSource(Array.from({ length: total }, (_, i) => ({ value: `v${i}`, label: `Label ${i}` })));
    await until(() => box(shadow(), "country")?.getAttribute("data-source") === "truncated");
    expect(shadow().querySelectorAll("select option").length).toBe(MAX_DATA_SOURCE_ITEMS + 1);
    expect(box(shadow(), "country").querySelector("[data-source-note]")?.textContent).toBe(`Showing the first ${MAX_DATA_SOURCE_ITEMS} of ${total} choices.`);
    expect(warn.mock.calls.some((call) => String(call[0]).includes(String(total)))).toBe(true);
  });

  it("the attributes are checked: a bad data-source-wait or timeout is a datum-error, the defaults stay", async () => {
    const element = document.createElement("datum-form") as DatumFormElement;
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    element.setAttribute("data-source-wait", "sometimes");
    element.setAttribute("data-source-timeout", "-1");
    element.setAttribute("wasm-timeout", "soon");
    expect(errors.map((e) => e.message)).toEqual([
      expect.stringContaining('data-source-wait must be "none" or "all"'),
      expect.stringContaining("data-source-timeout must be a whole number of milliseconds"),
      expect.stringContaining("wasm-timeout must be a whole number of milliseconds")
    ]);
    expect(element.dataSourceWait).toBe("none");
    expect(element.dataSourceTimeout).toBeUndefined();
    expect(element.wasmTimeout).toBeUndefined();
    element.setAttribute("data-source-wait", "all");
    element.removeAttribute("data-source-wait");
    expect(element.dataSourceWait).toBe("none");
  });
});

describe("<datum-form> sandbox module: bounded wait and the ABI check", () => {
  const moduleUrl = (code: string) => `data:text/javascript;charset=utf-8,${encodeURIComponent(code)}`;

  async function submitWith(url: string, attributes: Record<string, string> = {}) {
    const element = mount((el) => {
      // A data: module has no origin, so only the property may name it.
      el.wasm = url;
      for (const [name, value] of Object.entries(attributes)) el.setAttribute(name, value);
      el.definition = sampleDefinition();
    });
    const errors = listen<DatumErrorDetail>(element, "datum-error");
    await paintedForm(element);
    element.runtime!.setValue("fullName", "Ada Lovelace");
    return { element, errors, submit: element.submit() };
  }

  it("a sandbox module that never arrives ends the wait at wasm-timeout: the submit is refused, the host told", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { element, errors, submit } = await submitWith(
      moduleUrl(`export const WASM_ABI_VERSION = ${JSON.stringify(WASM_ABI_VERSION)}; await new Promise(() => {}); export function createWasmValidationHost() {}`),
      { "wasm-timeout": "150" }
    );
    expect(element.wasmTimeout).toBe(150);
    const detail = await submit;
    expect(detail.accepted).toBe(false);
    expect(element.hasAttribute("submitting")).toBe(false);
    expect(errors.some((e) => /did not load within 150 ms/.test(e.message) || /sandbox could not be loaded/.test(e.message))).toBe(true);
  });

  it("a module speaking another ABI is refused before its host is built, and the submit fails closed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const built = vi.fn();
    (globalThis as unknown as { __abiBuilt: () => void }).__abiBuilt = built;
    const { errors, submit } = await submitWith(
      moduleUrl(`export const WASM_ABI_VERSION = "0.8.0"; export function createWasmValidationHost() { globalThis.__abiBuilt(); return Promise.resolve({ run: async () => ({ errors: [], values: {} }), dispose() {} }); }`)
    );
    expect((await submit).accepted).toBe(false);
    expect(built).not.toHaveBeenCalled();
    expect(errors.some((e) => e.cause instanceof Error && /speaks ABI 0\.8\.0/.test(e.cause.message))).toBe(true);
    delete (globalThis as unknown as Record<string, unknown>).__abiBuilt;
  });

  it("a module that names no ABI at all is as stale as one naming another", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const built = vi.fn();
    (globalThis as unknown as { __abiBuilt: () => void }).__abiBuilt = built;
    const { submit } = await submitWith(
      moduleUrl(`export function createWasmValidationHost() { globalThis.__abiBuilt(); return Promise.resolve({ run: async () => ({ errors: [], values: {} }), dispose() {} }); }`)
    );
    expect((await submit).accepted).toBe(false);
    expect(built).not.toHaveBeenCalled();
    delete (globalThis as unknown as Record<string, unknown>).__abiBuilt;
  });

  it("the real sandbox module exports the engine's ABI, so a current module is accepted", async () => {
    const module = await import("../src/wasm.js");
    expect(module.WASM_ABI_VERSION).toBe(WASM_ABI_VERSION);
  });
});
