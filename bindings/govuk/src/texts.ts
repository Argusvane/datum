/**
 * GOV.UK's own words for what the binding draws itself: the binding's language pack (contract
 * `LiveBinding.texts`), read after the form's translations and before the engine's English.
 *
 * English is GOV.UK Frontend's wording (its templates and its character count's script defaults;
 * a Check answers page's "Change", "Not provided" and "Enter …" are the engine's English, which is
 * GOV.UK's);
 * Welsh is GOV.UK's where it publishes one; French is for a form in French. A locale with no
 * column here falls through to the engine's English, which words nothing GOV.UK-specific: the
 * "(optional)" marker and the hidden "Error:" prefix are empty there, so a form in another
 * language draws them only when its own translations carry them.
 *
 * The count words are the figures the renderer's announcer speaks (it counts and announces; the
 * binding only draws them), in GOV.UK's phrasing.
 */
import type { LiveBinding } from "../../../engine/form-engine/render/live/contract.js";

export const GOVUK_TEXTS: NonNullable<LiveBinding["texts"]> = {
  en: {
    optional: "(optional)",
    errorPrefix: "Error:",
    "summaryHeading.other": "There is a problem",
    "summaryHeading.one": "There is a problem",
    countUpTo: "You can enter up to {{max}} characters",
    countEmpty: "You have {{max}} characters remaining",
    "countLeft.other": "You have {{n}} characters remaining",
    "countLeft.one": "You have {{n}} character remaining",
    "countOver.other": "You have {{n}} characters too many",
    "countOver.one": "You have {{n}} character too many",
    dataGridAdd: "Add another row"
  },
  cy: {
    optional: "(dewisol)",
    errorPrefix: "Gwall:",
    "summaryHeading.other": "Mae problem wedi codi",
    "summaryHeading.one": "Mae problem wedi codi",
    dateDay: "Diwrnod",
    dateMonth: "Mis",
    dateYear: "Blwyddyn",
    tabsContents: "Cynnwys",
    languageSwitcher: "Dewis iaith",
    dataGridAdd: "Ychwanegu rhes arall",
    dataGridRemove: "Tynnu",
    dataGridRow: "Rhes {{n}}",
    // A Check answers page's link, GOV.UK's Welsh "Newid".
    change: "Newid",
    changeHidden: "Newid {{label}}"
  },
  fr: {
    optional: "(facultatif)",
    errorPrefix: "Erreur :",
    "summaryHeading.other": "Il y a un problème",
    "summaryHeading.one": "Il y a un problème",
    dateDay: "Jour",
    dateMonth: "Mois",
    dateYear: "Année",
    tabsContents: "Contenu",
    languageSwitcher: "Langue",
    // A Check answers page: its Change link, a blank optional answer, a missing required one.
    change: "Modifier",
    changeHidden: "Modifier {{label}}",
    notProvided: "Non fourni",
    enterAnswer: "Saisir {{label}}"
  }
};
