/**
 * The Ontario Design System binding's language pack: Ontario's components are worded in English
 * and French, so the binding ships both. The pack sits under the form's own `texts` translations and over
 * the engine's English, so a form's own translation of a word wins. The wording is Ontario's own where
 * it has one (`translations/global.i18n.json`: the "(required)" and "(optional)" flags, "Step n of m",
 * "Back", "Select", "This is a required field.") and in the same register where it has none (the form's
 * buttons, a data grid's captions, the receipt's kind words, the summary's heading: Ontario's pattern
 * is a page alert of the error type, which asks for a heading but words none).
 *
 * English entries are only the ones Ontario words differently from Datum's defaults; the French table
 * words every key the renderer draws. The French is the author's, in Ontario's register: a native
 * reader should look it over before it is shown.
 */
import type { LanguagePackTable } from "../../../engine/form-engine/core/localization/translations.js";

export const ONTARIO_TEXTS: LanguagePackTable = {
  en: {
    required: "(required)",
    optional: "(optional)",
    summaryEntry: "{{label}}: {{message}}",
    "summaryHeading.other": "Errors were found on this page",
    "summaryHeading.one": "Errors were found on this page",
    selectEmpty: "Select",
    back: "Back"
  },
  fr: {
    required: "(obligatoire)",
    optional: "(facultative)",
    summaryEntry: "{{label}} : {{message}}",
    "summaryHeading.other": "Des erreurs ont été trouvées sur cette page",
    "summaryHeading.one": "Des erreurs ont été trouvées sur cette page",
    submitting: "Envoi en cours…",
    selectEmpty: "Sélectionner",
    countUpTo: "Vous pouvez saisir jusqu'à {{max}} caractères",
    "countLeft.other": "{{n}} caractères restants",
    "countLeft.one": "{{n}} caractère restant",
    "countOver.other": "{{n}} caractères de trop",
    "countOver.one": "{{n}} caractère de trop",
    dateDay: "Jour",
    dateMonth: "Mois",
    dateYear: "Année",
    dateSelectMonth: "Sélectionnez un mois",
    errorPrefix: "Erreur : ",
    back: "Retour",
    continue: "Continuer",
    submit: "Soumettre",
    stepOf: "Étape {{n}} sur {{total}}",
    stepTagSeparator: " : ",
    stepCompleted: "terminée",
    stepNotCompleted: "non terminée",
    stepFallback: "Étape {{n}}",
    pageOf: "Étape {{n}} de {{total}}",
    checking: "Vérification de vos réponses…",
    serverUnavailable: "Nous n'avons pas pu vérifier vos réponses. Réessayez.",
    pageRedirected: "La page demandée n'est pas encore disponible. Voici la page la plus proche que vous pouvez ouvrir.",
    change: "Modifier",
    changeHidden: "Modifier {{label}}",
    notProvided: "Non fourni",
    enterAnswer: "Saisir {{label}}",
    workedOut: "Calculé à partir de vos réponses",
    confirmationTitle: "Votre formulaire a été soumis",
    confirmationMessage: "Merci. Nous avons reçu vos réponses.",
    confirmationReference: "Référence",
    noticeSuccess: "Succès : ",
    noticeInfo: "Information : ",
    noticeWarning: "Avertissement : ",
    noticeError: "Erreur : ",
    tooltipHelp: "Aide",
    tabsContents: "Contenu",
    "tabHasErrors.other": "{{count}} erreurs",
    "tabHasErrors.one": "{{count}} erreur",
    tabFallback: "Onglet {{n}}",
    printOnlyIf: "À remplir seulement si cela s'applique à vous.",
    printEmpty: "Aucune réponse",
    printPageNumber: "Page {{page}} de {{pages}}",
    printChosen: "Choisi",
    printRowNumber: "N°",
    dataGridAdd: "Ajouter une ligne",
    dataGridRemove: "Supprimer",
    dataGridMoveUp: "Monter",
    dataGridMoveDown: "Descendre",
    dataGridEmpty: "Aucune ligne pour le moment.",
    dataGridRow: "Ligne {{n}}",
    dataGridActions: "Actions",
    fileRemove: "Supprimer",
    fileRemoveFile: "Supprimer {{name}}",
    fileDownload: "Télécharger {{name}}",
    fileNone: "Aucun fichier",
    fileRemoved: "Fichier supprimé : {{name}}",
    "fileAnnounced.one": "Vous avez sélectionné le fichier : {{names}}",
    "fileAnnounced.other": "Vous avez sélectionné {{count}} fichiers : {{names}}",
    languageSwitcher: "Langue",
    languageSelection: "Sélection de la langue",
    localeLabel: "Langue du formulaire",
    loading: "Chargement du formulaire…",
    retry: "Réessayer",
    unknownComponent: "Composant inconnu « {{type}} »",
    unknownComponentHint: "Cette partie du formulaire ne peut pas être affichée : aucun composant n'est enregistré pour ce type. Enregistrez le module qui le fournit.",
    formNotShown: "Ce formulaire n'a pas pu être affiché. Vérifiez la connexion et réessayez.",
    formPartlyShown: "Une partie de ce formulaire n'a pas fini de se charger. Il pourrait ne pas fonctionner comme prévu.",
    fieldPending: "Vérification de cette réponse…",
    imageEmpty: "Aucune adresse d'image",
    optionsLoading: "Chargement des choix…",
    optionsFailed: "Les choix n'ont pas pu être chargés.",
    optionsTruncated: "Affichage des {{shown}} premiers choix sur {{total}}."
  }
};

/** The one validation message Ontario's components carry (`input.requiredFieldError`). */
export const ONTARIO_MESSAGES: LanguagePackTable = {
  en: { required: "This is a required field." },
  fr: { required: "Ce champ est obligatoire." }
};
