import { describe, expect, it } from "vitest";

import { declaredDefaultLocale, supportedLocaleCodes, supportedLocaleEntries, supportedLocaleOptions } from "../form-engine/core/localization/supported-locales.js";
import { defaultAfterRemoval, effectiveDefaultLocale, languageCodeProblem, withLanguageRemoved, withLanguageRenamed } from "../form-engine/builder/controller/language-edits.js";
import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { languagesController, languagesRoot } from "./fixtures/builder-languages.js";

describe("localization readers on a hostile block", () => {
  const hostile: Array<[string, unknown, string[]]> = [
    ["a null entry", [null], []],
    ["a numeric code", [{ code: 5 }], []],
    ["an array code", [{ code: ["fr"] }], []],
    ["an empty record", [{}], []],
    ["a nested array", [[]], []],
    ["a boolean", [true], []],
    ["a plain string beside a null", ["fr", null], []],
    ["an entry beside a null", [{ code: "fr" }, null], ["fr"]],
    ["a list that is not a list", "fr", []],
    ["a record in place of the list", { code: "fr" }, []],
    ["good entries around a bad one", [{ code: "en" }, { code: 7 }, "fr", { code: "de" }], ["en", "de"]]
  ];

  for (const [name, supportedLocales, codes] of hostile) {
    it(`reads ${name} without throwing`, () => {
      const localization = { supportedLocales } as never;
      expect(supportedLocaleEntries(localization).map((entry) => entry.code)).toEqual(codes);
      expect(supportedLocaleCodes(localization)).toEqual(codes);
      expect(supportedLocaleOptions(localization).map((option) => option.code)).toEqual(codes);
    });
  }

  it("drops a label that is not text and keeps one that is", () => {
    const entries = supportedLocaleEntries({ supportedLocales: [{ code: "fr", label: 5 }, { code: "de", label: "Deutsch" }] } as never);
    expect(entries).toEqual([{ code: "fr" }, { code: "de", label: "Deutsch" }]);
  });

  it("reads a default that is not text as absent", () => {
    expect(declaredDefaultLocale({ defaultLocale: 5 } as never)).toBeUndefined();
    expect(declaredDefaultLocale({ defaultLocale: "  " })).toBeUndefined();
    expect(declaredDefaultLocale({ defaultLocale: " fr " })).toBe("fr");
    expect(effectiveDefaultLocale({ defaultLocale: 5 } as never)).toBe("en");
  });

  it("opens a controller over such a block", () => {
    for (const supportedLocales of [[null], [{ code: 5 }], [{ code: ["fr"] }], ["fr", null]]) {
      expect(() => new BuilderController({ initialRoot: languagesRoot(), localization: { supportedLocales } as never })).not.toThrow();
    }
  });
});

describe("a language code the kernel would refuse", () => {
  it("is refused past the kernel's length", () => {
    const code = `fr-${"aaaaaaaa-".repeat(10)}bb`;
    expect(code.length).toBeGreaterThan(35);
    expect(languageCodeProblem(code, undefined)).toMatch(/longer than 35/);
  });

  it("accepts a code at the limit", () => {
    const code = `fr-${"a".repeat(8)}-${"b".repeat(8)}-${"c".repeat(8)}-ab`;
    expect(code.length).toBeLessThanOrEqual(35);
    expect(languageCodeProblem(code, undefined)).toBeUndefined();
  });
});

describe("renaming the implicit default language", () => {
  it("writes the new code as the default when none was written", () => {
    const next = withLanguageRenamed({ supportedLocales: [{ code: "en" }, { code: "fr" }] }, "en", "en-CA");
    expect(next.defaultLocale).toBe("en-CA");
    expect(supportedLocaleCodes(next)).toEqual(["en-CA", "fr"]);
  });

  it("leaves an absent default alone when the renamed language was not the default", () => {
    const next = withLanguageRenamed({ supportedLocales: [{ code: "en" }, { code: "fr" }] }, "fr", "fr-CA");
    expect(next.defaultLocale).toBeUndefined();
  });

  it("keeps the controller's default declared after the rename", () => {
    const controller = languagesController({ supportedLocales: [{ code: "en" }, { code: "fr" }] });
    expect(controller.localizationActions.renameLocale("en", "en-CA")).toBe(true);
    const localization = controller.localization()!;
    expect(localization.defaultLocale).toBe("en-CA");
  });
});

describe("a default written in another case", () => {
  const config = { supportedLocales: [{ code: "en-CA" }, { code: "fr" }], defaultLocale: "EN-ca" };

  it("renames with the language it names", () => {
    const next = withLanguageRenamed(config, "en-CA", "en-GB");
    expect(next.defaultLocale).toBe("en-GB");
    expect(supportedLocaleCodes(next)).toEqual(["en-GB", "fr"]);
  });

  it("is replaced when its language is removed", () => {
    expect(withLanguageRemoved(config, "en-CA").defaultLocale).toBe("fr");
    expect(defaultAfterRemoval(config, "en-CA")).toBe("fr");
  });

  it("an underscore spelling reads as the same code", () => {
    expect(withLanguageRenamed({ supportedLocales: [{ code: "en-CA" }, { code: "fr" }], defaultLocale: "en_CA" }, "en-CA", "en-US").defaultLocale).toBe("en-US");
  });
});
