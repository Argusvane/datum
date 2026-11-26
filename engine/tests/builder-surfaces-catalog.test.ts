import { describe, expect, it } from "vitest";

import { BuilderWords, type BuilderTextCatalog } from "../form-engine/builder/logic/builder-texts.js";
import { DataModelImporter, dataModelKindText, dataModelRowHtml } from "../form-engine/builder/data/data-model-import.js";
import { schemaTypeText } from "../form-engine/builder/data/schema-rows.js";
import { phoneMenuButtonName } from "../form-engine/builder/web-component/phone-menu.js";
import { tryPanelHtml } from "../form-engine/builder/web-component/try-it.js";
import type { TryPanelView } from "../form-engine/builder/web-component/try-it-types.js";
import { formulaSettingsSectionHtml } from "../form-engine/builder/web-component/formula-settings.js";
import { validateComponentCssClasses } from "../form-engine/builder/property-editor/css-classes.js";
import type { DataModelNode } from "../form-engine/builder/data-model/data-model.js";

/** The builder's surfaces read their words through the host's catalog: one overridden key shows. */

const FRENCH: BuilderTextCatalog = {
  fr: {
    "dataModel.kind.number": "nombre",
    "dataModel.required": "obligatoire",
    "data.import.open": "Ouvrir un fichier…",
    "schemaRows.type.text": "Texte libre",
    "phoneMenu.button": "Menu. {workspace}, {problems}",
    "problems.count.one": "{count} problème",
    "problems.count.other": "{count} problèmes",
    "themeClasses.invalid.one": "{list} n'est pas un nom de classe valide.",
    "themeClasses.invalid.other": "{list} ne sont pas des noms de classe valides.",
    "try.title": "Essayer",
    "settings.formulaErrors.title": "Formules"
  }
};

const frWords = (): BuilderWords => {
  const words = new BuilderWords();
  words.locale = "fr";
  words.catalog = FRENCH;
  return words;
};

const numberNode = (): DataModelNode => ({ key: "amount", path: "amount", kind: "number", required: true }) as DataModelNode;

describe("builder surfaces read their words from the catalog", () => {
  it("names a data model kind in the host's words, English without them", () => {
    expect(dataModelKindText(numberNode())).toBe("number");
    expect(dataModelKindText(numberNode(), frWords())).toBe("nombre");
  });

  it("draws a model row's required mark in the host's words", () => {
    expect(dataModelRowHtml(numberNode(), 0, false, undefined)).toContain(">required</span>");
    expect(dataModelRowHtml(numberNode(), 0, false, undefined, frWords())).toContain(">obligatoire</span>");
  });

  it("draws the Import tab's open button in the host's words", () => {
    const importer = new DataModelImporter({
      controller: () => undefined,
      words: () => frWords(),
      canBuild: () => true,
      selectsRows: () => false,
      scope: () => undefined,
      paint: () => undefined,
      announce: () => undefined,
      built: () => undefined
    });
    expect(importer.frameHtml("err")).toContain(">Ouvrir un fichier…</button>");
  });

  it("says a schema type in the host's words", () => {
    const text = { key: "name", path: "name", kind: "string" } as DataModelNode;
    expect(schemaTypeText(text, false)).toBe("Text");
    expect(schemaTypeText(text, false, frWords())).toBe("Texte libre");
  });

  it("names a phone menu button with its problem count in the host's words", () => {
    expect(phoneMenuButtonName("Form", 2)).toBe("Menu. Form workspace, 2 problems");
    expect(phoneMenuButtonName("Form", 2, frWords())).toBe("Menu. Form, 2 problèmes");
  });

  it("words a class-name error in the host's words, with the plural for the count", () => {
    expect(validateComponentCssClasses("bad!", [], frWords()).error).toBe("\"bad!\" n'est pas un nom de classe valide.");
    expect(validateComponentCssClasses("bad! worse!", [], frWords()).error).toBe("\"bad!\", \"worse!\" ne sont pas des noms de classe valides.");
  });

  it("titles the Try it panel in the host's words", () => {
    const view = {
      mode: "interactive",
      answers: "{}",
      live: false,
      server: { status: "none", label: "", on: false, busy: false },
      submit: { state: "none" },
      pdf: false,
      pdfBusy: false
    } as unknown as TryPanelView;
    expect(tryPanelHtml(view)).toContain(">Try it</h2>");
    expect(tryPanelHtml(view, frWords())).toContain(">Essayer</h2>");
  });

  it("titles the Formulas section in the host's words", () => {
    expect(formulaSettingsSectionHtml({ value: "fail", texts: { locale: "fr", catalog: FRENCH } }, false)).toContain(">Formules</summary>");
  });
});
