import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { cellLocales, languageEntries } from "../form-engine/builder/languages/languages-cells.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

/**
 * A translations map loaded into the builder (a host's options, `replaceTranslations`) is read
 * against the languages the form declares: a key spelled another way (`FR`, `fr_ca`) is filed
 * under the declared spelling once, at load, with no step of the history, and what the reader
 * left out is kept as the load's report.
 */

const root = (): ComponentNode => ({
  id: "root",
  type: "form",
  configuration: {},
  children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
});

const entry = (text: string) => ({ components: { name: { label: { text, source: "" } } } });

describe("a loaded translations map takes the declared spelling", () => {
  it("from the options: keys renamed to the declared codes, no undo step, the dropped entries reported", () => {
    const ctrl = new BuilderController({
      initialRoot: root(),
      localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }, { code: "fr-CA" }] },
      translations: { FR: entry("Nom"), fr_ca: entry("Nom (CA)"), de: { components: { name: { label: 42 } } } } as never
    });
    expect(Object.keys(ctrl.translations() ?? {}).sort()).toEqual(["fr", "fr-CA"]);
    expect(ctrl.translations()?.fr?.components?.name?.label?.text).toBe("Nom");
    expect(ctrl.canUndo()).toBe(false);
    expect(ctrl.translationsDropped()).toEqual({ count: 1, first: [["de", "components", "name", "label"]] });
  });

  it("through replaceTranslations, silent or as an edit", () => {
    const ctrl = new BuilderController({ initialRoot: root(), localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] } });
    ctrl.replaceTranslations({ FR: entry("Nom") } as never, { silent: true });
    expect(Object.keys(ctrl.translations() ?? {})).toEqual(["fr"]);
    expect(ctrl.translationsDropped()).toEqual({ count: 0, first: [] });
    ctrl.replaceTranslations({ Fr: entry("Prénom") } as never);
    expect(ctrl.translations()?.fr?.components?.name?.label?.text).toBe("Prénom");
    expect(ctrl.canUndo()).toBe(true);
  });
});

describe("a default language spelled another way than its list entry", () => {
  it("takes the list's spelling at load, so the default has no column of its own and wears the badge", () => {
    const ctrl = new BuilderController({
      initialRoot: root(),
      localization: { defaultLocale: "fr-CA", supportedLocales: [{ code: "fr-ca" }, { code: "en" }] }
    });
    expect(ctrl.localization()?.defaultLocale).toBe("fr-ca");
    expect(cellLocales(ctrl.localization())).toEqual(["en"]);
    expect(languageEntries(ctrl.localization()).map((entry) => [entry.code, entry.isDefault])).toEqual([
      ["fr-ca", true],
      ["en", false]
    ]);
    expect(ctrl.canUndo()).toBe(false);
  });

  it("keeps the entry spelled exactly as the default when the list holds the language in two spellings", () => {
    const ctrl = new BuilderController({
      initialRoot: root(),
      localization: { defaultLocale: "fr-CA", supportedLocales: [{ code: "fr-ca" }, { code: "fr-CA" }, { code: "en" }] }
    });
    expect(ctrl.localization()?.defaultLocale).toBe("fr-CA");
    expect(languageEntries(ctrl.localization()).find((entry) => entry.isDefault)?.code).toBe("fr-CA");
  });
});
