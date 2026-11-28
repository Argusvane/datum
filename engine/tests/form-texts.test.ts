// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import { markupOf, unmountAll } from "./live-datum-parts-kit.js";
import { sourceHash, type FormTranslations, type TranslationCatalog } from "../form-engine/core/localization/translations.js";
import {
  DEFAULT_FORM_TEXTS,
  createFormTextResolver,
  defaultFormText,
  fillFormText,
  resolveFormTextPlural,
  resolveFormText,
} from "../form-engine/core/localization/form-texts.js";

/** A definition's `texts` translations for `locale`: each key's entry made against the engine's English. */
function textsIn(locale: string, words: Record<string, string>): FormTranslations {
  const form = Object.fromEntries(
    Object.entries(words).map(([key, text]) => [key, { text, source: sourceHash((DEFAULT_FORM_TEXTS as Record<string, string>)[key] ?? "") }])
  );
  return { [locale]: { texts: { form } } };
}

describe("form texts (the form's own wording)", () => {
  it("words a key from the page first, then the theme, then the engine's English", () => {
    const theme = { required: { default: "(required)", locales: { fr: "(obligatoire)" } } };
    const page = { required: "★" };
    expect(resolveFormText(page, "required", "en", theme)).toBe("★");
    expect(resolveFormText(undefined, "required", "fr", theme)).toBe("(obligatoire)");
    expect(resolveFormText(undefined, "required", "en", theme)).toBe("(required)");
    expect(resolveFormText(undefined, "required", "en")).toBe("*");
    expect(resolveFormText(undefined, "submitting", "en")).toBe(DEFAULT_FORM_TEXTS.submitting);
  });

  it("lets a theme word a marker away: an empty text is a text, not an absence", () => {
    // GOV.UK marks optional fields, never required ones.
    const theme = { required: "", optional: "(optional)" };
    expect(resolveFormText(undefined, "required", "en", theme)).toBe("");
    expect(resolveFormText(undefined, "optional", "en", theme)).toBe("(optional)");
  });

  it("words a text from the entry's own languages; a catalog words it only at its `texts` address", () => {
    const theme = { stepOf: { default: "Page {{n}}", locales: { fr: "Étape {{n}}" } } };
    const catalog = { fr: { components: { stepOf: { label: "Ignoré" } } } } as unknown as TranslationCatalog;
    expect(resolveFormText(undefined, "stepOf", "fr", theme, { n: 1 }, { catalog })).toBe("Étape 1");
    expect(resolveFormText(undefined, "stepOf", "en", theme, { n: 1 }, { catalog })).toBe("Page 1");
    const worded: TranslationCatalog = { fr: { texts: { form: { stepOf: "Écran {{n}}" } } } };
    expect(resolveFormText(undefined, "stepOf", "fr", theme, { n: 2 }, { catalog: worded })).toBe("Écran 2");
  });

  it("gives a theme renderer's own key back as the key when nobody worded it", () => {
    expect(resolveFormText(undefined, "datePeriod", "en")).toBe("datePeriod");
    expect(resolveFormText(undefined, "datePeriod", "en", { datePeriod: "Period" })).toBe("Period");
  });

  it("fills placeholders from the params, leaving one nobody supplied alone", () => {
    expect(fillFormText("{{count}} error(s)", { count: 3 })).toBe("3 error(s)");
    expect(fillFormText("Remove {{name}}", { name: "scan.pdf" })).toBe("Remove scan.pdf");
    expect(fillFormText("{{label}}: {{message}}", { label: "Email" })).toBe("Email: {{message}}");
    expect(resolveFormText(undefined, "summaryEntry", "en", undefined, { label: "Email", message: "Required" })).toBe(
      "Email: Required"
    );
  });

  it("binds the layers into one resolver", () => {
    const text = createFormTextResolver("en", { fileRemove: "Delete" }, { fileNone: "Nothing attached" });
    expect(text("fileRemove")).toBe("Delete");
    expect(text("fileNone")).toBe("Nothing attached");
    expect(text("fileDownload", { name: "a.pdf" })).toBe("Download a.pdf");
  });

  it("picks a counted text by the locale's plural category, a category nobody worded reading .other", () => {
    const pl = { "countLeft.one": "{{n}} znak", "countLeft.few": "{{n}} znaki", "countLeft.many": "{{n}} znaków", "countLeft.other": "{{n}} znaku" };
    const text = (n: number) => createFormTextResolver("pl", pl).plural("countLeft", n, { n });
    expect([text(1), text(3), text(5), text(1.5)]).toEqual(["1 znak", "3 znaki", "5 znaków", "1.5 znaku"]);
    // English, nothing worded: the engine's one/other pair.
    const en = createFormTextResolver("en");
    expect(en.plural("countLeft", 1, { n: 1 })).toBe("1 character left");
    expect(en.plural("countLeft", 2, { n: 2 })).toBe("2 characters left");
    expect(createFormTextResolver("ru", { "countLeft.other": "ост. {{n}}" }).plural("countLeft", 3, { n: 3 })).toBe("ост. 3");
    // A layer's .other words every count it has no category for, before a later layer's category.
    expect(createFormTextResolver("en", { "countLeft.other": "page" }, { "countLeft.one": "theme" }).plural("countLeft", 1)).toBe("page");
    expect(createFormTextResolver("en", undefined, { "summaryHeading.one": "One problem" }).plural("summaryHeading", 1, { count: 1 })).toBe("One problem");
    expect(en.plural("fileAnnounced", 1, { count: 1, names: "a" })).toBe("You have selected the file: a");
    expect(en.plural("fileAnnounced", 2, { count: 2, names: "a, b" })).toBe("You have selected 2 files: a, b");
  });

  it("carries the host toolbar's, the loading line's and the locale select's wording", () => {
    for (const [key, value] of [["validateLabel", "Validate"], ["printLabel", "Print"], ["pdfLabel", "PDF"], ["downloadPdfLabel", "Download PDF"], ["pdfLayoutLabel", "PDF layout"], ["loading", "Loading form…"], ["localeLabel", "Form locale"]] as const) {
      expect(resolveFormText(undefined, key, "en")).toBe(value);
      expect(resolveFormText({ [key]: { default: value, locales: { fr: `${value} fr` } } }, key, "fr")).toBe(`${value} fr`);
    }
  });

  it("lets the page's heading for every count beat a theme's singular, and reads underscored tags as BCP-47", () => {
    const page = { "summaryHeading.other": "Please fix these ({{count}})" };
    const theme = { "summaryHeading.other": "{{count}} errors", "summaryHeading.one": "1 error" };
    expect(resolveFormTextPlural(page, "summaryHeading", 1, "en", theme, { count: 1 })).toBe("Please fix these (1)");
    expect(resolveFormTextPlural(page, "summaryHeading", 3, "en", theme, { count: 3 })).toBe("Please fix these (3)");
    // A theme alone still words the singular.
    expect(resolveFormTextPlural(undefined, "summaryHeading", 1, "en", theme, { count: 1 })).toBe("1 error");
    // pl_PL reads Polish rules (few for 2), not the English fallback.
    const counted = { "n.few": "few", "n.other": "other" };
    expect(resolveFormTextPlural(counted, "n", 2, "pl_PL")).toBe("few");
  });

  it("words only English itself: a French locale reads the English until the form's texts translate it", () => {
    expect(resolveFormText(undefined, "selectEmpty", "fr")).toBe("Select…");
    expect(resolveFormText(undefined, "selectEmpty", "fr-CA")).toBe("Select…");
    expect(defaultFormText("agentDraftSaved", "fr-CA")).toBe(DEFAULT_FORM_TEXTS.agentDraftSaved);
    expect(defaultFormText("datePeriod", "fr")).toBeUndefined();
  });

  it("reads the form's `texts` translations for any tag of the language, under the page's own words and over the theme's", () => {
    const translations = textsIn("fr", { selectEmpty: "Sélectionner…", "countLeft.other": "{{n}} caractères restants", "countLeft.one": "{{n}} caractère restant", "summaryHeading.other": "{{count}} erreurs", stepOf: "Étape {{n}} de {{total}}" });
    const words = { translations };
    expect(resolveFormText(undefined, "selectEmpty", "fr", undefined, undefined, words)).toBe("Sélectionner…");
    expect(resolveFormText(undefined, "selectEmpty", "fr-CA", undefined, undefined, words)).toBe("Sélectionner…");
    expect(resolveFormText(undefined, "selectEmpty", "fr_FR", undefined, undefined, words)).toBe("Sélectionner…");
    expect(resolveFormText(undefined, "selectEmpty", "en", undefined, undefined, words)).toBe("Select…");
    expect(resolveFormText(undefined, "selectEmpty", "frisian", undefined, undefined, words)).toBe("Select…");
    expect(resolveFormText({ selectEmpty: "Choisir" }, "selectEmpty", "fr", undefined, undefined, words)).toBe("Choisir");
    expect(resolveFormText(undefined, "selectEmpty", "fr", { selectEmpty: "Faites un choix" }, undefined, words)).toBe("Sélectionner…");
    expect(defaultFormText("selectEmpty", "fr-CA", words)).toBe("Sélectionner…");
    // A key the form leaves untranslated reads the English.
    expect(resolveFormText(undefined, "dataGridAdd", "fr", undefined, undefined, words)).toBe("Add row");
    // The counted texts follow the locale's plural rules over the translations.
    const fr = createFormTextResolver("fr", undefined, undefined, words);
    expect(fr.plural("countLeft", 1, { n: 1 })).toBe("1 caractère restant");
    expect(fr.plural("countLeft", 5, { n: 5 })).toBe("5 caractères restants");
    expect(fr.plural("summaryHeading", 2, { count: 2 })).toBe("2 erreurs");
    // The singular nobody translated reads the translated .other.
    expect(fr.plural("summaryHeading", 1, { count: 1 })).toBe("1 erreurs");
    expect(fr("stepOf", { n: 2, total: 3 })).toBe("Étape 2 de 3");
    expect(fr.words.translations).toBe(translations);
  });

  it("reads a binding's language pack after the form's translations and the theme, before the English", () => {
    const pack = { texts: { fr: { selectEmpty: "Choisissez", dataGridAdd: "Ajouter" } } };
    const translations = textsIn("fr-CA", { selectEmpty: "Sélectionner…" });
    expect(resolveFormText(undefined, "dataGridAdd", "fr-CA", undefined, undefined, { pack })).toBe("Ajouter");
    expect(resolveFormText(undefined, "selectEmpty", "fr-CA", undefined, undefined, { translations, pack })).toBe("Sélectionner…");
    expect(resolveFormText(undefined, "selectEmpty", "fr-CA", { selectEmpty: "Thème" }, undefined, { pack })).toBe("Thème");
    expect(resolveFormText(undefined, "selectEmpty", "en", undefined, undefined, { pack })).toBe("Select…");
    expect(defaultFormText("dataGridAdd", "fr", { pack })).toBe("Ajouter");
  });

  it("lets a host catalog's `texts` entry beat the definition's for the same key", () => {
    const translations = textsIn("fr", { selectEmpty: "Sélectionner…" });
    const catalog: TranslationCatalog = { fr: { texts: { form: { selectEmpty: "Choisir (hôte)" } } } };
    expect(createFormTextResolver("fr", undefined, undefined, { translations, catalog })("selectEmpty")).toBe("Choisir (hôte)");
  });

  it("draws a select's empty option in French on a French form whose `texts` translations word it", async () => {
    const root = {
      id: "root",
      type: "form",
      configuration: {},
      children: { content: [{ id: "province", type: "select", configuration: { label: "Province", options: [{ value: "AB", label: "Alberta" }] } }] }
    };
    const draw = async (locale: string): Promise<string> => {
      unmountAll();
      return (await markupOf(root as never, { locale, translations: textsIn("fr", { selectEmpty: "Sélectionner…" }) })).html.replace(/\s+/g, " ");
    };
    expect(await draw("fr")).toContain(">Sélectionner…</option>");
    expect(await draw("fr")).not.toContain("Select…");
    expect(await draw("en")).toContain(">Select…</option>");
  });
});
