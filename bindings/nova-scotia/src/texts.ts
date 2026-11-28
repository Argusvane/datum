/**
 * The words the binding draws itself: its language pack (contract `LiveBinding.texts`), read after
 * the form's translations and before the engine's English.
 *
 * The pattern library is silent on the words of a form (its snippets carry placeholder text), so
 * the English column sets only what the binding draws and the engine leaves empty: the required
 * mark's title and the sentence that explains it. Nova Scotia publishes in English and French, so
 * French is for a form in French. A locale with no column falls through to the engine's English.
 */
import type { LiveBinding } from "../../../engine/form-engine/render/live/contract.js";

export const NOVA_SCOTIA_TEXTS: NonNullable<LiveBinding["texts"]> = {
  en: {
    required: "*",
    requiredTitle: "required",
    requiredNote: "Fields marked with * are required."
  },
  fr: {
    required: "*",
    requiredTitle: "obligatoire",
    requiredNote: "Les champs marqués d’un * sont obligatoires.",
    "summaryHeading.other": "{{count}} erreurs",
    "summaryHeading.one": "{{count}} erreur",
    selectEmpty: "Sélectionner…",
    dateDay: "Jour",
    dateMonth: "Mois",
    dateYear: "Année",
    languageSwitcher: "Langue",
    noticeSuccess: "Succès : ",
    noticeInfo: "Information : ",
    noticeWarning: "Avertissement : ",
    noticeError: "Erreur : ",
    fieldPending: "Vérification de la réponse…",
    back: "Retour",
    continue: "Continuer",
    submit: "Soumettre",
    stepOf: "Étape {{n}} de {{total}}",
    countUpTo: "Vous pouvez saisir jusqu’à {{max}} caractères",
    "countLeft.other": "{{n}} caractères restants",
    "countLeft.one": "{{n}} caractère restant",
    "countOver.other": "{{n}} caractères en trop",
    "countOver.one": "{{n}} caractère en trop",
    dataGridAdd: "Ajouter une ligne",
    dataGridRemove: "Supprimer",
    dataGridMoveUp: "Monter",
    dataGridMoveDown: "Descendre",
    dataGridRow: "Ligne {{n}}",
    dataGridActions: "Actions",
    dataGridEmpty: "Aucune ligne pour le moment.",
    change: "Modifier",
    changeHidden: "Modifier {{label}}",
    notProvided: "Non fourni",
    enterAnswer: "Saisir {{label}}"
  }
};
