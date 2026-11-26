import { describe, expect, it } from "vitest";

import {
  isRtlLocale,
  normalizeLocaleTag,
  primaryLocaleSubtag,
  resolveLocalizedText
} from "../form-engine/core/localization/localized-text.js";

// Host data only: a form's own texts resolve through translations.ts.
describe("resolveLocalizedText (host data)", () => {
  it("returns undefined for undefined input", () => {
    expect(resolveLocalizedText(undefined, "en")).toBeUndefined();
  });

  it("returns a bare string unchanged regardless of locale", () => {
    expect(resolveLocalizedText("Full name", "fr")).toBe("Full name");
  });

  it("resolves an exact locale match first", () => {
    const text = { default: "Name", locales: { "en-CA": "Full name (CA)", en: "Full name" } };
    expect(resolveLocalizedText(text, "en-CA")).toBe("Full name (CA)");
  });

  it("falls back to the primary subtag when the exact locale is missing", () => {
    const text = { default: "Name", locales: { en: "Full name" } };
    expect(resolveLocalizedText(text, "en-CA")).toBe("Full name");
  });

  it("falls back to default when neither the exact locale nor the subtag match", () => {
    const text = { default: "Name", locales: { fr: "Nom" } };
    expect(resolveLocalizedText(text, "de-DE")).toBe("Name");
    expect(resolveLocalizedText({ default: "Name" }, "fr")).toBe("Name");
  });
});

describe("resolveLocalizedText locale matching", () => {
  const text = { default: "EN", locales: { fr: "FR", "fr-CA": "FRCA", en: "EN-inline" } };

  it("matches tags ignoring case and reading an underscore as a hyphen, exact before primary", () => {
    expect(resolveLocalizedText(text, "fr-ca")).toBe("FRCA");
    expect(resolveLocalizedText(text, "fr_CA")).toBe("FRCA");
    expect(resolveLocalizedText(text, "FR")).toBe("FR");
    expect(resolveLocalizedText(text, "fr_BE")).toBe("FR");
  });

  it("falls through an empty translation to the next candidate; an empty default stays", () => {
    expect(resolveLocalizedText({ default: "EN", locales: { fr: "" } }, "fr")).toBe("EN");
    expect(resolveLocalizedText({ default: "EN", locales: { "fr-CA": "", fr: "FR" } }, "fr-CA")).toBe("FR");
    expect(resolveLocalizedText({ default: "", locales: { fr: "" } }, "fr")).toBe("");
  });
});

describe("locale tag helpers", () => {
  it("normalizes a tag for comparison", () => {
    expect(normalizeLocaleTag("fr_CA")).toBe("fr-ca");
    expect(normalizeLocaleTag("EN-gb")).toBe("en-gb");
  });

  it("reads the primary subtag across both separators", () => {
    expect(primaryLocaleSubtag("en-CA")).toBe("en");
    expect(primaryLocaleSubtag("zh_Hant_TW")).toBe("zh");
    expect(primaryLocaleSubtag("fr")).toBe("fr");
  });
});

describe("isRtlLocale", () => {
  it("detects right-to-left locales by primary subtag", () => {
    expect(isRtlLocale("ar")).toBe(true);
    expect(isRtlLocale("ar-EG")).toBe(true);
    expect(isRtlLocale("he-IL")).toBe(true);
    expect(isRtlLocale("fa")).toBe(true);
  });

  it("treats other locales as left-to-right", () => {
    expect(isRtlLocale("en")).toBe(false);
    expect(isRtlLocale("en-CA")).toBe(false);
    expect(isRtlLocale("fr-FR")).toBe(false);
  });

  it("reads an underscored tag by its primary subtag", () => {
    expect(isRtlLocale("ar_EG")).toBe(true);
  });
});
