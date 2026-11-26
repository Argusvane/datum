/** The wording the page keeps outside the form: translations, texts and messages, and which one wins. */
import definition from "../../../public/forms/visit-request-catalog.json?raw";
import { bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

const DEFINITION_URL = "/forms/visit-request-catalog.json";

// Language, then kind, then the id of the thing that holds the text, then the property.
const CATALOG = {
  fr: {
    form: { title: "Demande de visite" },
    components: {
      fullName: { label: "Nom complet" },
      email: { label: "Courriel" },
      reason: { label: "Motif de la visite" },
      submit: { label: "Envoyer" }
    }
  }
};

const TEXTS = {
  "countLeft.one": { default: "{{n}} character to go", locales: { fr: "Encore {{n}} caractère" } },
  "countLeft.other": { default: "{{n}} characters to go", locales: { fr: "Encore {{n}} caractères" } },
  "summaryHeading.one": { default: "Fix {{count}} problem before sending", locales: { fr: "Corrigez {{count}} problème avant l'envoi" } },
  "summaryHeading.other": { default: "Fix {{count}} problems before sending", locales: { fr: "Corrigez {{count}} problèmes avant l'envoi" } }
};

const MESSAGES = { required: { default: "This field is required.", locales: { fr: "Ce champ est requis." } } };

export const languagesCatalogExample: ExampleSpec = {
  title: "A form worded by the page's own catalog",
  options: [
    { key: "locale", label: "locale", default: "fr", choices: [{ value: "en", label: "en" }, { value: "fr", label: "fr" }] },
    { key: "catalog", label: "translations", default: true },
    { key: "texts", label: "texts", default: true },
    { key: "messages", label: "messages", default: true }
  ],
  page(options) {
    const attributes = [`id="visit"`, `locale="${options.locale}"`, "language-switcher"];
    attributes.push(`src="${DEFINITION_URL}"`);
    const script = [`const form = document.getElementById("visit");`];
    if (options.catalog) {
      script.push(
        ``,
        `// translations: the page's wording by address. An entry here beats the form's own`,
        `// translation of the same address: the form's own French for the email label is`,
        `// "Adresse courriel", and this catalog says "Courriel". An address the catalog lacks`,
        `// falls back to the form's translation, then to the form's own text.`,
        `form.translations = ${jsLiteral(CATALOG)};`
      );
    }
    if (options.texts) {
      script.push(
        ``,
        `// texts: the form's own sentences, per locale. {{name}} is a slot. A counted text has one`,
        `// key per plural category, picked by the locale's plural rules.`,
        `form.texts = ${jsLiteral(TEXTS)};`
      );
    }
    if (options.messages) {
      script.push(
        ``,
        `// messages: one wording per validation code. An entry here beats the form's own message`,
        `// for that code, as translations beat the form's translations: the name field's own`,
        `// "required" ("Enter your full name.") gives way to this one. Codes left out keep the form's words.`,
        `form.messages = ${jsLiteral(MESSAGES)};`
      );
    }
    if (script.length === 1) script.push(``, `// Nothing handed over: the form shows its own translations, and its own sentences are English.`);
    return htmlDocument("Visit request", bundleTags("form"), [`${openTag("datum-form", attributes)}</datum-form>`, ``, moduleScript(script)]);
  },
  files() {
    return [{ title: "visit-request-catalog.json", lang: "json", code: definition }];
  }
};
