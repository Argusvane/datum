import { describe, expect, it } from "vitest";

import {
  localeDisplayName,
  negotiateLocale,
  normalizeSupportedLocale,
  supportedLocaleCodes,
  supportedLocaleEntries,
  supportedLocaleOptions
} from "../form-engine/core/localization/supported-locales.js";

describe("supported locales (FormDefinition.localization.supportedLocales)", () => {
  it("normalizes one entry: the code is trimmed, a blank label is dropped", () => {
    expect(normalizeSupportedLocale({ code: " fr-CA " })).toEqual({ code: "fr-CA" });
    expect(normalizeSupportedLocale({ code: "fr-CA", label: "Français (Canada)" })).toEqual({
      code: "fr-CA",
      label: "Français (Canada)"
    });
    expect(normalizeSupportedLocale({ code: "fr-CA", label: "   " })).toEqual({ code: "fr-CA" });
    expect(normalizeSupportedLocale({ code: "fr-CA" })).toEqual({ code: "fr-CA" });
    // A reader, not a canonicalizer: the builder repaints its label boxes from this on every
    // keystroke, so the space an author just typed must survive. Save trims.
    expect(normalizeSupportedLocale({ code: "fr-CA", label: "Français " })).toEqual({
      code: "fr-CA",
      label: "Français "
    });
  });

  it("reads the list as objects, dropping blank codes and entries that are not { code }", () => {
    expect(
      supportedLocaleEntries({
        supportedLocales: [{ code: "en" }, { code: "fr-CA", label: "Français (Canada)" }, { code: "  " }, { code: "" }]
      })
    ).toEqual([{ code: "en" }, { code: "fr-CA", label: "Français (Canada)" }]);
    // A plain string is no entry: it names no language.
    expect(supportedLocaleEntries({ supportedLocales: ["en"] as never })).toEqual([]);
    expect(supportedLocaleEntries(undefined)).toEqual([]);
    expect(supportedLocaleEntries({})).toEqual([]);
  });

  it("lists the codes alone for the runtime's allow-list check", () => {
    expect(supportedLocaleCodes({ supportedLocales: [{ code: "en" }, { code: "fr-CA", label: "Français" }] })).toEqual([
      "en",
      "fr-CA"
    ]);
    expect(supportedLocaleCodes(undefined)).toEqual([]);
  });

  it("offers each locale under its authored label, else its own-language name, else its code", () => {
    expect(
      supportedLocaleOptions({
        supportedLocales: [{ code: "en", label: "English (Canada)" }, { code: "fr-CA" }, { code: "zz-ZZ" }]
      })
    ).toEqual([
      { code: "en", label: "English (Canada)" },
      { code: "fr-CA", label: localeDisplayName("fr-CA") },
      { code: "zz-ZZ", label: "zz-ZZ" }
    ]);
  });

  it("names a language in itself, capitalised as a label, and falls back to the code", () => {
    expect(localeDisplayName("fr-CA")).toMatch(/^Français/);
    expect(localeDisplayName("en")).toBe("English");
    expect(localeDisplayName("zz-ZZ")).toBe("zz-ZZ");
  });

  describe("negotiateLocale", () => {
    const supported = ["en", "fr-CA", "es-MX"];

    it("matches case-insensitively, reads _ as -, and returns the declared code", () => {
      expect(negotiateLocale("FR-ca", supported)).toBe("fr-CA");
      expect(negotiateLocale("fr_CA", supported)).toBe("fr-CA");
      expect(negotiateLocale("EN", supported, "fr-CA")).toBe("en");
    });

    it("falls back from a region to the primary subtag", () => {
      expect(negotiateLocale("en-GB", supported)).toBe("en");
      expect(negotiateLocale("en-GB", ["fr-CA", "en"])).toBe("en");
    });

    it("lets a bare language meet a regional code only when no plain one is declared", () => {
      expect(negotiateLocale("fr", supported)).toBe("fr-CA");
      expect(negotiateLocale("fr", ["fr-FR", "fr", "fr-CA"])).toBe("fr");
      expect(negotiateLocale("fr-BE", ["fr-FR", "fr-CA"])).toBe("fr-FR");
    });

    it("tries each requested tag in order, then the default", () => {
      expect(negotiateLocale(["de-DE", "es", "en"], supported, "en")).toBe("es-MX");
      expect(negotiateLocale(["de-DE", "ja"], supported, "fr-CA")).toBe("fr-CA");
      expect(negotiateLocale(["de-DE"], supported)).toBeUndefined();
      expect(negotiateLocale([], supported, "en")).toBe("en");
    });

    it("does not cross scripts: zh-TW never meets zh-CN, sr-Latn never sr-Cyrl, but fr meets fr-CA", () => {
      expect(negotiateLocale("zh-TW", ["zh-CN", "en"], "en")).toBe("en");
      expect(negotiateLocale("sr-Latn", ["sr-Cyrl", "en"], "en")).toBe("en");
      expect(negotiateLocale("fr", ["fr-CA", "en"], "en")).toBe("fr-CA");
      expect(negotiateLocale("pt-BR", ["pt-PT", "en"], "en")).toBe("pt-PT");
    });
  });
});
