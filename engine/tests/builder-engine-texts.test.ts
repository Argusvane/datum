// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { enginePluralTexts, engineTexts } from "../form-engine/builder/languages/engine-texts.js";
import { languageCoverage, languagesTexts, promotedTextCount, rowKey } from "../form-engine/builder/languages/languages-model.js";
import { DEFAULT_FORM_TEXTS, createFormTextResolver } from "../form-engine/core/localization/form-texts.js";
import { addressOf, isStale, readTranslation, TEXTS_FORM_OWNER, TEXTS_MESSAGES_OWNER } from "../form-engine/core/localization/translations.js";
import { DEFAULT_VALIDATION_MESSAGES, resolveValidationMessage } from "../form-engine/core/localization/validation-messages.js";
import type { ComponentNode, LocalizationConfiguration } from "../form-engine/core/schema/types.js";
import type { FormError } from "../form-engine/core/errors/form-error.js";
import { FormStateStore } from "../form-engine/core/state/form-state.js";
import { buildRenderOutput } from "../form-engine/render/core/render-orchestrator.js";
import {
  DATUM_BUILDER_LANGUAGES_TAG,
  languagesController,
  languagesRoot,
  loadLanguagesSurface,
  type DatumBuilderLanguagesElement
} from "./fixtures/builder-languages.js";

/**
 * The engine's own words in the Languages workspace: every form text key and validation
 * code is a row of group `texts` with English as its source, its translations under the
 * definition's `texts` kind, read by the renderer before the English.
 */

const FR_DEFAULT: LocalizationConfiguration = { defaultLocale: "fr", supportedLocales: [{ code: "fr" }, { code: "en" }, { code: "es" }] };

describe("the engine's own words as texts", () => {
  it("lists every form text key with English to translate, then every validation code, at its `texts` address", () => {
    const texts = engineTexts();
    // `definitionUnavailable` is drawn when no definition arrived, so no definition can word it: the page's `texts` do.
    const formKeys = Object.entries(DEFAULT_FORM_TEXTS).filter(([key, text]) => text.trim() !== "" && key !== "definitionUnavailable").map(([key]) => key);
    expect(DEFAULT_FORM_TEXTS.definitionUnavailable).toBe("This form could not be loaded.");
    expect(texts.filter((text) => text.table === "form").map((text) => text.key)).toEqual(formKeys);
    expect(texts.filter((text) => text.table === "messages").map((text) => text.key)).toEqual(Object.keys(DEFAULT_VALIDATION_MESSAGES));
    expect(texts.find((text) => text.key === "selectEmpty")).toEqual({ address: { kind: "texts", owner: TEXTS_FORM_OWNER, path: ["selectEmpty"] }, key: "selectEmpty", table: "form", default: "Select…" });
    expect(texts.find((text) => text.key === "date.min")?.address).toEqual({ kind: "texts", owner: TEXTS_MESSAGES_OWNER, path: ["date.min"] });
    // A marker the English draws as nothing has nothing to translate.
    expect(texts.some((text) => text.key === "optional" || text.key === "requiredNote")).toBe(false);
  });

  it("is a grid group after the form's texts, with a cell for every language not written in English", () => {
    const ctrl = languagesController();
    const input = { texts: ctrl.translatableTexts(), translations: ctrl.translations(), localization: ctrl.localization(), engineTexts: engineTexts() };
    const { rows } = languagesTexts(input);
    const engineRows = rows.filter((row) => row.groupId === "texts");
    expect(engineRows).toHaveLength(engineTexts().length);
    expect(rows.indexOf(engineRows[0]!)).toBeGreaterThan(rows.findIndex((row) => row.groupId === "chrome"));
    const select = engineRows.find((row) => rowKey(row.address) === "texts/form/selectEmpty")!;
    expect(select).toMatchObject({ default: "Select…", label: "selectEmpty", inForm: false, componentLabel: "Form text" });
    expect(Object.keys(select.cells)).toEqual(Object.keys(rows[0]!.cells));
    // The coverage and Make default count the form's own texts only.
    expect(languageCoverage(rows, "fr")).toEqual(languageCoverage(languagesTexts({ ...input, engineTexts: [] }).rows, "fr"));
    expect(promotedTextCount(rows, "fr")).toBe(promotedTextCount(languagesTexts({ ...input, engineTexts: [] }).rows, "fr"));
  });

  it("gives a default language that is not English a cell, and an English-only form no rows", () => {
    const base = { texts: [], translations: undefined, engineTexts: engineTexts() };
    const french = languagesTexts({ ...base, localization: FR_DEFAULT }).rows.filter((row) => row.groupId === "texts");
    expect(Object.keys(french[0]!.cells)).toEqual(["fr", "es"]);
    const english = languagesTexts({ ...base, localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "en-GB" }] } }).rows;
    expect(english).toEqual([]);
  });

  it("writes a translation of an engine word against its English, in the default language too, as one undo step", () => {
    const ctrl = new BuilderController({ initialRoot: languagesRoot(), localization: FR_DEFAULT });
    const written = ctrl.setTranslations([
      { locale: "fr", address: addressOf.formText("selectEmpty"), text: "Sélectionner…" },
      { locale: "es", address: addressOf.engineMessage("required"), text: "Este campo es obligatorio" },
      // Not an engine word: passed over.
      { locale: "fr", address: addressOf.formText("noSuchKey"), text: "x" }
    ]);
    expect(written).toBe(2);
    const entry = readTranslation(ctrl.translations(), "fr", addressOf.formText("selectEmpty"))!;
    expect(entry.text).toBe("Sélectionner…");
    expect(isStale(entry, "Select…")).toBe(false);
    expect(readTranslation(ctrl.translations(), "es", addressOf.engineMessage("required"))?.text).toBe("Este campo es obligatorio");
    expect(readTranslation(ctrl.translations(), "fr", addressOf.formText("noSuchKey"))).toBeUndefined();
    // The renderer reads them before the English.
    const words = { translations: ctrl.translations() };
    expect(createFormTextResolver("fr", undefined, undefined, words)("selectEmpty")).toBe("Sélectionner…");
    expect(resolveValidationMessage({ code: "required" }, undefined, "es", words)).toBe("Este campo es obligatorio");
    ctrl.undo();
    expect(readTranslation(ctrl.translations(), "fr", addressOf.formText("selectEmpty"))).toBeUndefined();
  });
});

describe("the engine's counted texts in a language with more plural forms", () => {
  const POLISH: LocalizationConfiguration = { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "pl" }, { code: "fr" }] };

  it("lists the categories a language uses for whole counts, for that language only", () => {
    expect(enginePluralTexts("en")).toEqual([]);
    expect(enginePluralTexts("fr")).toEqual([]);
    expect(enginePluralTexts("pl").map((text) => text.key)).toEqual(expect.arrayContaining(["countLeft.few", "countLeft.many", "summaryHeading.few", "agentUndone.many"]));
    expect(enginePluralTexts("pl").some((text) => text.key.endsWith(".zero") || text.key.endsWith(".two"))).toBe(false);
    expect(enginePluralTexts("ar").map((text) => text.key)).toEqual(expect.arrayContaining(["countLeft.zero", "countLeft.two", "countLeft.few", "countLeft.many"]));
    expect(enginePluralTexts("pl")[0]!.default).not.toBe("");
  });

  it("draws a row per extra category with a cell for the languages that use it, and the renderer reads what is written", () => {
    const ctrl = new BuilderController({ initialRoot: languagesRoot(), localization: POLISH });
    const input = { texts: ctrl.translatableTexts(), translations: ctrl.translations(), localization: ctrl.localization(), engineTexts: engineTexts(), enginePluralTexts };
    const few = languagesTexts(input).rows.find((row) => rowKey(row.address) === "texts/form/countLeft.few")!;
    expect(few).toMatchObject({ groupId: "texts", label: "countLeft.few", default: "{{n}} characters left" });
    expect(Object.keys(few.cells)).toEqual(["pl"]);
    // Without the language's rows given, the grid lists none of them.
    expect(languagesTexts({ ...input, enginePluralTexts: undefined }).rows.some((row) => rowKey(row.address) === "texts/form/countLeft.few")).toBe(false);

    const written = ctrl.setTranslations([{ locale: "pl", address: addressOf.formText("countLeft.few"), text: "Zostały {{n}} znaki" }]);
    expect(written).toBe(1);
    const words = { translations: ctrl.translations() };
    expect(createFormTextResolver("pl", undefined, undefined, words).plural("countLeft", 3, { n: 3 })).toBe("Zostały 3 znaki");
  });
});

describe("the engine's own words on the render model", () => {
  it("words the errors and the summary from the form's `texts` translations, else the English", async () => {
    const root: ComponentNode = { id: "root", type: "form", configuration: {}, children: { content: [{ id: "name", type: "text", configuration: { label: "Nom", required: true } }] } };
    const errors = [{ code: "required", componentId: "name", stage: "field-constraints", source: "client" } as unknown as FormError];
    const translations = {
      fr: {
        texts: {
          form: { summaryEntry: { text: "{{label}} : {{message}}", source: "x" }, "summaryHeading.one": { text: "{{count}} erreur", source: "x" } },
          messages: { required: { text: "Ce champ est obligatoire", source: "x" } }
        }
      }
    };
    const draw = (locale: string, withTranslations: boolean) =>
      buildRenderOutput({ mode: "interactive", root, state: new FormStateStore(locale).snapshot(), resolver: { resolveDataSource: async () => undefined }, errors, ...(withTranslations ? { translations } : {}) });
    const french = await draw("fr-CA", true);
    expect(french.components.find((model) => model.id === "name")?.errorMessages).toEqual(["Ce champ est obligatoire"]);
    expect(french.meta.errorSummary.entries.map((entry) => entry.text)).toEqual(["Nom : Ce champ est obligatoire"]);
    expect(french.meta.errorSummary.heading).toBe("1 erreur");
    const untranslated = await draw("fr-CA", false);
    expect(untranslated.components.find((model) => model.id === "name")?.errorMessages).toEqual([DEFAULT_VALIDATION_MESSAGES.required]);
  });
});

describe("the engine's own words in the Languages surface", () => {
  it("draws the built-in rows under their group, the default language's box under the English", async () => {
    await loadLanguagesSurface();
    const controller = new BuilderController({ initialRoot: languagesRoot(), localization: FR_DEFAULT });
    const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
    surface.controller = controller;
    document.body.append(surface);
    try {
      const root = surface.shadowRoot!;
      const rail = [...root.querySelectorAll("[data-languages-group]")].map((button) => button.getAttribute("data-languages-group"));
      expect(rail).toContain("texts");
      const row = root.querySelector<HTMLElement>('tr[data-languages-row="texts/form/selectEmpty"]')!;
      expect(row).not.toBeNull();
      expect(row.querySelector(".where")?.textContent).toContain("Form text");
      const defaultBox = row.querySelector<HTMLInputElement>('td.default input[data-languages-locale="fr"]')!;
      expect(defaultBox).not.toBeNull();
      expect(row.querySelector("td.default")?.textContent).toContain("Select…");
      expect(row.querySelector('input[data-languages-locale="es"]')).not.toBeNull();
    } finally {
      surface.remove();
    }
  });
});
