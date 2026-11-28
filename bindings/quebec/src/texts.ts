/**
 * The Québec design system binding's language pack. The toolkit words its components in French
 * and English (it reads the page's `lang`), so the binding ships both. The pack sits under the form's
 * own `texts` translations and over the engine's English, so a form's own translation of a word wins.
 *
 * The wording is the toolkit's own where it has one: the count (`N caractère(s) restant(s)` / `en
 * trop`, with the plural from 2), the error notice's heading in its documentation ("Des erreurs sont
 * présentes dans le formulaire :"), the select's caption ("Faire une sélection"), the required star
 * (Québec marks a required field with a red asterisk and an optional one with nothing), and in the
 * same register ("vous", the Gouvernement du Québec's plain style) where it has none: the form's
 * buttons, a data grid's captions, the receipt's kind words, a date's parts.
 *
 * English entries are only the ones Québec words differently from Datum's defaults; the French table
 * words every key the renderer draws.
 */
import type { LanguagePackTable } from "../../../engine/form-engine/core/localization/translations.js";

export const QUEBEC_TEXTS: LanguagePackTable = {
  en: {
    required: "*",
    optional: "",
    summaryEntry: "{{label}}: {{message}}",
    "summaryHeading.other": "There are errors in the form:",
    "summaryHeading.one": "There are errors in the form:",
    selectEmpty: "Make a selection",
    "countLeft.other": "{{n}} characters remaining",
    "countLeft.one": "{{n}} character remaining",
    "countOver.other": "{{n}} characters over the limit",
    "countOver.one": "{{n}} character over the limit"
  },
  fr: {
    required: "*",
    optional: "",
    summaryEntry: "{{label}} : {{message}}",
    "summaryHeading.other": "Des erreurs sont présentes dans le formulaire :",
    "summaryHeading.one": "Des erreurs sont présentes dans le formulaire :",
    submitting: "Envoi en cours…",
    selectEmpty: "Faire une sélection",
    countUpTo: "Vous pouvez saisir jusqu'à {{max}} caractères",
    "countLeft.other": "{{n}} caractères restants",
    "countLeft.one": "{{n}} caractère restant",
    "countOver.other": "{{n}} caractères en trop",
    "countOver.one": "{{n}} caractère en trop",
    dateDay: "Jour",
    dateMonth: "Mois",
    dateYear: "Année",
    dateSelectMonth: "Sélectionnez un mois",
    errorPrefix: "Erreur : ",
    back: "Précédent",
    continue: "Continuer",
    submit: "Soumettre",
    stepOf: "Étape {{n}} sur {{total}}",
    stepTagSeparator: " : ",
    stepCompleted: "terminée",
    stepNotCompleted: "non terminée",
    stepFallback: "Étape {{n}}",
    pageOf: "Étape {{n}} de {{total}}",
    checking: "Vérification de vos réponses…",
    serverUnavailable: "Nous n'avons pas pu vérifier vos réponses. Veuillez réessayer.",
    pageRedirected: "La page demandée n'est pas encore accessible. Voici la page la plus proche que vous pouvez ouvrir.",
    change: "Modifier",
    changeHidden: "Modifier {{label}}",
    notProvided: "Non fourni",
    enterAnswer: "Saisir {{label}}",
    workedOut: "Calculé à partir de vos réponses",
    confirmationTitle: "Votre formulaire a été soumis",
    confirmationMessage: "Merci. Nous avons bien reçu vos réponses.",
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
    languageSelection: "Choix de la langue",
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
    optionsTruncated: "Affichage des {{shown}} premiers choix sur {{total}}.",
    "error.required.radio": "Veuillez sélectionner une option.",
    "error.required.select": "Veuillez sélectionner une option.",
    "error.required.checkboxes": "Veuillez sélectionner au moins une option."
  }
};

/**
 * Validation messages by code (the same layer for the errors). The toolkit's own default for an
 * empty required field is "Ce champ est obligatoire." / "This field is required."; the rest are
 * in the same register. English stands on the engine's wording, so only French is written.
 */
export const QUEBEC_MESSAGES: LanguagePackTable = {
  fr: {
    required: "Ce champ est obligatoire.",
    minLength: "Saisissez au moins {minLength} caractères.",
    maxLength: "Saisissez au plus {maxLength} caractères.",
    pattern: "Saisissez une valeur dans le format attendu.",
    fileType: "Le fichier {file} n'est pas d'un type accepté par ce champ.",
    maxFileSize: "Le fichier {file} dépasse la taille de {maxFileSizeLabel} acceptée par ce champ.",
    number: "Saisissez un nombre.",
    date: "Saisissez une date valide.",
    dateIncomplete: "Saisissez une date complète.",
    "number.min": "Saisissez un nombre égal ou supérieur à {min}.",
    "number.max": "Saisissez un nombre égal ou inférieur à {max}.",
    "date.min": "Saisissez une date égale ou postérieure au {min}.",
    "date.max": "Saisissez une date égale ou antérieure au {max}.",
    text: "Saisissez du texte.",
    file: "Joignez un fichier.",
    fileCount: "Trop de fichiers : le maximum est {maxFiles}.",
    "option.notAllowed": "Choisissez l'une des options proposées.",
    rule: "Vérifiez cette réponse.",
    "rows.min": "Il manque des lignes : ajoutez-en au moins {min}.",
    "rows.max": "Trop de lignes : le maximum est {max}."
  }
};
