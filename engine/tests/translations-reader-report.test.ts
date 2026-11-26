import { describe, expect, it } from "vitest";

import { readFormTranslations, readFormTranslationsReport, resolveText, sourceHash } from "../form-engine/core/localization/translations.js";
import type { TextAddress } from "../form-engine/core/localization/translations.js";

/**
 * The tolerant reader of a loaded map: it keeps what it can use, says what it left
 * out, and reads each locale key as the form's language list spells it.
 */

const entry = (text: string, defaultText = "Name") => ({ text, source: sourceHash(defaultText) });
const LABEL: TextAddress = { kind: "components", owner: "a", path: ["label"] };

describe("what the reader dropped", () => {
  it("reports nothing for a clean map, an absent one and the empty texts that mean no translation", () => {
    expect(readFormTranslationsReport(undefined).dropped).toEqual({ count: 0, first: [] });
    expect(readFormTranslationsReport(null).dropped).toEqual({ count: 0, first: [] });
    expect(readFormTranslationsReport({ fr: { components: { a: { label: entry("Nom") } } } }).dropped).toEqual({ count: 0, first: [] });
    const blank = { fr: { components: { a: { label: { text: "", source: "x" }, hint: {} } }, form: {} } };
    expect(readFormTranslationsReport(blank).dropped.count).toBe(0);
  });

  it("counts a numeric text, an entry with no source, an unknown kind and an unsafe locale, naming where each sat", () => {
    const map = {
      fr: {
        form: { title: { text: 5, source: "x" } },
        components: { a: { label: entry("Nom"), hint: { text: "Aide" } } },
        widgets: { a: { label: entry("x") } }
      },
      constructor: { components: { a: { label: entry("y") } } }
    };
    const { translations, dropped } = readFormTranslationsReport(map);
    expect(translations).toEqual({ fr: { components: { a: { label: entry("Nom") } } } });
    expect(dropped.count).toBe(4);
    expect(dropped.first).toEqual([["fr", "form", "title"], ["fr", "components", "a", "hint"], ["fr", "widgets"], ["constructor"]]);
  });

  it("counts a locale, a kind and an owner that hold no record, and a map that is no record", () => {
    expect(readFormTranslationsReport({ fr: "Nom", de: { components: "x", pdf: { l: 3, ok: { title: entry("T") } } } }).dropped.first).toEqual([
      ["fr"],
      ["de", "components"],
      ["de", "pdf", "l"]
    ]);
    expect(readFormTranslationsReport("fr").dropped).toEqual({ count: 1, first: [[]] });
    expect(readFormTranslationsReport([entry("x")]).dropped).toEqual({ count: 1, first: [[]] });
  });

  it("lists the first few addresses and counts them all", () => {
    const owners: Record<string, unknown> = {};
    for (let i = 0; i < 40; i += 1) {
      owners[`c${i}`] = { label: { text: i } };
    }
    const { dropped } = readFormTranslationsReport({ fr: { components: owners } });
    expect(dropped.count).toBe(40);
    expect(dropped.first).toHaveLength(5);
    expect(dropped.first[0]).toEqual(["fr", "components", "c0", "label"]);
  });

  it("is the reader readFormTranslations uses", () => {
    const map = { fr: { components: { a: { label: entry("Nom"), junk: 1 } } } };
    expect(readFormTranslations(map)).toEqual(readFormTranslationsReport(map).translations);
  });
});

describe("locale keys read as the form declares them", () => {
  it("renames a key that differs only in case or in _ against - to the declared spelling", () => {
    const map = { fr_ca: { components: { a: { label: entry("Nom") } } }, ES: { components: { a: { label: entry("Nombre") } } }, de: { components: { a: { label: entry("Name") } } } };
    const read = readFormTranslations(map, ["fr-CA", "es", "en"]);
    expect(Object.keys(read ?? {})).toEqual(["fr-CA", "es", "de"]);
    expect(read?.["fr-CA"]).toEqual(map.fr_ca);
  });

  it("reads the same text through the renderer's lookup before and after", () => {
    const map = { fr_ca: { components: { a: { label: entry("Nom") } } } };
    const read = readFormTranslations(map, ["fr-CA"]);
    expect(resolveText("Name", LABEL, "fr-CA", { translations: map as never })).toBe("Nom");
    expect(resolveText("Name", LABEL, "fr-CA", { translations: read })).toBe("Nom");
    expect(Object.keys(read ?? {})).toEqual(["fr-CA"]);
  });

  it("merges two spellings of one language, the declared spelling winning where they disagree", () => {
    const map = {
      fr_CA: { components: { a: { label: entry("Nom (underscore)"), hint: entry("Aide") } } },
      "fr-CA": { components: { a: { label: entry("Nom") }, b: { label: entry("B") } } },
      "fr-ca": { components: { a: { label: entry("Nom (lower)") } } }
    };
    const { translations, dropped } = readFormTranslationsReport(map, ["fr-CA"]);
    expect(Object.keys(translations ?? {})).toEqual(["fr-CA"]);
    expect(translations?.["fr-CA"]).toEqual({ components: { a: { label: entry("Nom"), hint: entry("Aide") }, b: { label: entry("B") } } });
    // The two texts that lost their place are reported under the key each one sat in, since saving drops them.
    expect(dropped.count).toBe(2);
    expect(dropped.first).toEqual([["fr_CA", "components", "a", "label"], ["fr-ca", "components", "a", "label"]]);
  });

  it("names the key that lost, not the one that was kept", () => {
    const map = { "fr-CA": { components: { a: { label: entry("Nom") } } }, "fr-ca": { components: { a: { label: entry("Autre") } } } };
    const { translations, dropped } = readFormTranslationsReport(map, ["fr-CA"]);
    expect(translations?.["fr-CA"]).toEqual({ components: { a: { label: entry("Nom") } } });
    expect(dropped.first).toEqual([["fr-ca", "components", "a", "label"]]);
  });

  it("keeps a merged language's kinds in the order a form's map is written in", () => {
    const map = { fr: { components: { a: { label: entry("Nom") } } }, FR: { form: { title: entry("Titre", "Title") } } };
    const read = readFormTranslations(map, ["fr"]);
    expect(Object.keys(read?.fr ?? {})).toEqual(["form", "components"]);
  });

  it("keeps a spelling nothing declares, and every spelling when no language is declared", () => {
    const map = { fr_ca: { components: { a: { label: entry("Nom") } } } };
    expect(Object.keys(readFormTranslations(map, ["es"]) ?? {})).toEqual(["fr_ca"]);
    expect(Object.keys(readFormTranslations(map) ?? {})).toEqual(["fr_ca"]);
  });

  it("does not report a key it renamed", () => {
    expect(readFormTranslationsReport({ fr_ca: { components: { a: { label: entry("Nom") } } } }, ["fr-CA"]).dropped.count).toBe(0);
  });
});
