import { describe, expect, it } from "vitest";
import { BuilderController, normalizeLocalizationConfiguration } from "../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentDefinition } from "../form-engine/core/schema/contracts.js";
import { addressOf, readTranslation, sourceHash, writeTranslation } from "../form-engine/core/localization/translations.js";

const DEFS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() }
];
const make = (localization: unknown) =>
  new BuilderController({
    initialRoot: { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Full name" } }] } },
    componentDefinitions: DEFS,
    localization: localization as never
  });

describe("a default language that is not text", () => {
  it("reads as absent instead of throwing", () => {
    expect(() => normalizeLocalizationConfiguration({ supportedLocales: [{ code: "en" }], defaultLocale: 5 } as never)).not.toThrow();
    expect(normalizeLocalizationConfiguration({ supportedLocales: [{ code: "en" }], defaultLocale: 5 } as never)?.defaultLocale).toBeUndefined();
    expect(normalizeLocalizationConfiguration({ supportedLocales: [{ code: "en" }], defaultLocale: " fr " } as never)?.defaultLocale).toBe("fr");
  });
});

describe("make default when the written default is not a declared language", () => {
  it("moves the strings to the new default and keeps the old ones as the old language's translation", () => {
    const c = make({ supportedLocales: [{ code: "fr" }, { code: "de" }] });
    c.replaceTranslations(writeTranslation(c.translations() ?? {}, "fr", addressOf.component("name", "label"), "Nom complet", "Full name"));
    expect(c.localizationActions.makeDefaultLocale("fr")).toBe(true);
    expect(c.getProperty("name", "label")).toBe("Nom complet");
    expect(readTranslation(c.translations()!, "en", addressOf.component("name", "label"))).toEqual({ text: "Full name", source: sourceHash("Nom complet") });
    c.undo();
    expect(c.getProperty("name", "label")).toBe("Full name");
  });
});

describe("make default compares language codes as the form reads them", () => {
  it("takes a code in another case or with an underscore for the declared language, and writes it as declared", () => {
    const c = make({ supportedLocales: [{ code: "en" }, { code: "fr-CA" }], defaultLocale: "en" });
    c.replaceTranslations(writeTranslation(c.translations() ?? {}, "fr-CA", addressOf.component("name", "label"), "Nom complet", "Full name"));
    expect(c.localizationActions.makeDefaultLocale("FR_ca")).toBe(true);
    expect(c.localization()?.defaultLocale).toBe("fr-CA");
    expect(c.getProperty("name", "label")).toBe("Nom complet");
  });
  it("is no change when the language is already the default under another spelling", () => {
    const c = make({ supportedLocales: [{ code: "en" }, { code: "fr" }], defaultLocale: "EN" });
    expect(c.localizationActions.makeDefaultLocale("en")).toBe(false);
    expect(c.getProperty("name", "label")).toBe("Full name");
  });
});
