import { afterEach, describe, expect, it, vi } from "vitest";

import "../src/form.js";
import type { DatumFormElement } from "../src/form.js";

import { until } from "./helpers.js";
import { box } from "./live-dom.js";

/**
 * Data-source option labels are translatable text: a static source carries
 * LocalizedText items, a remote one answers per `locale`, the label is read in the filler's
 * language, a switch never shows the previous language's labels, and a failed source shows the
 * translated sentence alone while the raw reason goes to `datum-error`.
 */

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

function definition(): unknown {
  return {
    id: "ds-i18n", version: "1", schemaVersion: "1",
    localization: {
      defaultLocale: "en",
      supportedLocales: [{ code: "en", label: "English" }, { code: "fr", label: "Français" }]
    },
    root: { id: "root", type: "form", configuration: {}, children: { content: [
      { id: "country", type: "select", configuration: { label: "Country", data: { sourceId: "src" } } }
    ] } },
    // The select's empty option in French is the form's `texts` translation (the engine words only English).
    translations: { fr: { texts: { form: { selectEmpty: { text: "Sélectionner…", source: "x" } } } } }
  };
}

function mountSource(source: unknown, locale = "en") {
  const element = document.createElement("datum-form") as DatumFormElement;
  const errors: Array<{ message: string; sourceId?: string; componentId?: string }> = [];
  element.addEventListener("datum-error", (event) => errors.push((event as CustomEvent).detail));
  element.setAttribute("locale", locale);
  element.dataSources = { src: source } as never;
  element.definition = definition() as never;
  document.body.append(element);
  return { element, errors, shadow: () => element.renderer!.shadowRoot! };
}

const optionLabels = (shadow: ShadowRoot) => Array.from(shadow.querySelectorAll("select option")).map((option) => option.textContent);

describe("<datum-form> translatable data-source labels", () => {
  const ITEMS = [
    { value: "CA", label: { default: "Canada", locales: { fr: "Canada (fr)" } } },
    { value: "US", label: { default: "United States", locales: { fr: "États-Unis" } } },
    { value: "MX", label: "Mexico" }
  ];

  it("reads a static source's localized labels in the filler's locale, and a plain string as given", async () => {
    const { shadow } = mountSource(ITEMS, "fr");
    await until(() => optionLabels(shadow()).includes("États-Unis"));
    expect(optionLabels(shadow())).toEqual(["Sélectionner…", "Canada (fr)", "États-Unis", "Mexico"]);
  });

  it("falls back to the default text for a locale the label does not carry", async () => {
    const { shadow } = mountSource(ITEMS, "en");
    await until(() => optionLabels(shadow()).includes("United States"));
    expect(optionLabels(shadow())).toEqual(["Select…", "Canada", "United States", "Mexico"]);
  });

  it("a locale switch never shows the previous language's remote labels", async () => {
    const asked: string[] = [];
    const loader = (_request: unknown, context: { locale: string }) => {
      asked.push(context.locale);
      return [{ value: "CA", label: context.locale === "fr" ? "Canada FR" : "Canada EN" }];
    };
    const { element, shadow } = mountSource(loader, "en");
    await until(() => optionLabels(shadow()).includes("Canada EN"));
    element.locale = "fr";
    await until(() => optionLabels(shadow()).includes("Canada FR"));
    expect(optionLabels(shadow())).not.toContain("Canada EN");
    expect(asked).toContain("fr");
  });

  it("a failed source shows the translated sentence alone and the raw reason goes to datum-error", async () => {
    const { shadow, errors } = mountSource(() => {
      throw new Error("secret-host-detail 503");
    });
    await until(() => box(shadow(), "country")?.getAttribute("data-source") === "error");
    const note = box(shadow(), "country").querySelector("[data-source-note]")!;
    expect(note.textContent).toBe("The choices could not be loaded.");
    expect(note.textContent).not.toContain("secret-host-detail");
    expect(errors[0]).toMatchObject({ sourceId: "src", message: expect.stringContaining("secret-host-detail") });
  });
});
