/**
 * The GC Design System binding's language pack: GC Design System is worded in English and
 * French, so the binding ships both. The pack sits under the form's own `texts` translations and
 * over the engine's English, so a form's own translation of a word wins. The wording is GC
 * Design System's own where it has one (`utils/i18n/validation-errors.js`, each component's i18n
 * table: the error summary heading, the required mark (GC Design System marks no optional field, so
 * the engine's empty optional mark stands), the stepper's "Step n of m",
 * "Choose an option to continue.") and in the same register where it has none (the form's
 * buttons, a data grid's captions, the receipt's kind words).
 *
 * English entries are only the ones GC Design System words differently from Datum's defaults; the
 * French table words every key the renderer draws.
 */
import type { LanguagePackTable } from "../../../engine/form-engine/core/localization/translations.js";

export const GCDS_TEXTS: LanguagePackTable = {
  en: {
    required: "(required)",
    // GC Design System's own summary line: the label, a spaced hyphen, the message (its handleValidationResult).
    summaryEntry: "{{label}} - {{message}}",
    "summaryHeading.other": "There was a problem",
    "summaryHeading.one": "There was a problem",
    "countLeft.other": "Characters left: {{n}}",
    "countLeft.one": "Characters left: {{n}}",
    "error.required.radio": "Choose an option to continue.",
    "error.required.select": "Choose an option to continue.",
    "error.required.checkboxes": "Choose an option to continue."
  },
  fr: {
    required: "(obligatoire)",
    summaryEntry: "{{label}} - {{message}}",
    "summaryHeading.other": "Un problème est survenu",
    "summaryHeading.one": "Un problème est survenu",
    submitting: "Envoi en cours…",
    selectEmpty: "Sélectionner…",
    countUpTo: "Vous pouvez saisir jusqu'à {{max}} caractères",
    "countLeft.other": "Caractères restants : {{n}}",
    "countLeft.one": "Caractères restants : {{n}}",
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
    optionsTruncated: "Affichage des {{shown}} premiers choix sur {{total}}.",
    "error.required.radio": "Choisissez une option pour continuer.",
    "error.required.select": "Choisissez une option pour continuer.",
    "error.required.checkboxes": "Choisissez une option pour continuer."
  }
};

export const GCDS_MESSAGES: LanguagePackTable = {
  en: { required: "Enter information to continue.", pattern: "Use the specified format to continue." },
  fr: { required: "Saisissez des renseignements pour continuer.", pattern: "Utilisez le format indiqué pour continuer." }
};
