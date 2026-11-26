/**
 * USWDS's own words for what the binding draws itself: the binding's language pack (contract
 * `LiveBinding.texts`), read after the form's translations and before the engine's English.
 *
 * English is USWDS's wording (its character count's script, its memorable date, its address form's
 * required note); Spanish is the language USWDS publishes in beside English (its character count
 * and memorable date are translated in its own documentation); French is for a form in French. A
 * locale with no column falls through to the engine's English.
 *
 * The count words are the figures the renderer's announcer speaks (it counts and announces; the
 * binding only draws them), in USWDS's phrasing: "25 characters allowed", "20 characters left",
 * "3 characters over limit".
 */
import type { LiveBinding } from "../../../engine/form-engine/render/live/contract.js";

export const USWDS_TEXTS: NonNullable<LiveBinding["texts"]> = {
  en: {
    required: "*",
    requiredTitle: "required",
    requiredNote: "Required fields are marked with an asterisk (*).",
    selectEmpty: "- Select -",
    dateSelectMonth: "- Select -",
    dateMonth: "Month",
    dateDay: "Day",
    dateYear: "Year",
    dateHint: "Select a month. Enter 1 or 2 digits for the day and 4 digits for the year.",
    dateMonthHint: "Select a month from the dropdown.",
    dateDayHint: "Enter 1 or 2 digits for the day.",
    dateYearHint: "Enter 4 digits for the year.",
    countUpTo: "You can enter up to {{max}} characters",
    countEmpty: "{{max}} characters allowed",
    countLeft: "{{n}} characters left",
    countLeftOne: "{{n}} character left",
    countOver: "{{n}} characters over limit",
    countOverOne: "{{n}} character over limit"
  },
  es: {
    required: "*",
    requiredTitle: "obligatorio",
    requiredNote: "Los campos obligatorios están marcados con un asterisco (*).",
    selectEmpty: "- Seleccione -",
    dateSelectMonth: "- Seleccione -",
    dateMonth: "Mes",
    dateDay: "Día",
    dateYear: "Año",
    dateHint: "Seleccione un mes. Ingrese 1 o 2 dígitos para el día y 4 dígitos para el año.",
    dateMonthHint: "Seleccione un mes de la lista.",
    dateDayHint: "Ingrese 1 o 2 dígitos para el día.",
    dateYearHint: "Ingrese 4 dígitos para el año.",
    countUpTo: "Puede ingresar hasta {{max}} caracteres",
    countEmpty: "{{max}} caracteres permitidos",
    countLeft: "{{n}} caracteres restantes",
    countLeftOne: "{{n}} carácter restante",
    countOver: "{{n}} caracteres por encima del límite",
    countOverOne: "{{n}} carácter por encima del límite",
    summaryHeading: "{{count}} errores",
    summaryHeadingOne: "{{count}} error",
    dataGridAdd: "Añadir fila",
    dataGridRemove: "Quitar",
    dataGridMoveUp: "Subir",
    dataGridMoveDown: "Bajar",
    dataGridRow: "Fila {{n}}"
  },
  fr: {
    required: "*",
    requiredTitle: "obligatoire",
    requiredNote: "Les champs obligatoires sont marqués d’un astérisque (*).",
    selectEmpty: "- Sélectionner -",
    dateSelectMonth: "- Sélectionner -",
    dateMonth: "Mois",
    dateDay: "Jour",
    dateYear: "Année",
    dateHint: "Sélectionnez un mois. Saisissez 1 ou 2 chiffres pour le jour et 4 chiffres pour l’année.",
    dateMonthHint: "Sélectionnez un mois dans la liste.",
    dateDayHint: "Saisissez 1 ou 2 chiffres pour le jour.",
    dateYearHint: "Saisissez 4 chiffres pour l’année.",
    summaryHeading: "{{count}} erreurs",
    summaryHeadingOne: "{{count}} erreur",
    change: "Modifier",
    changeHidden: "Modifier {{label}}",
    notProvided: "Non fourni",
    enterAnswer: "Saisir {{label}}"
  }
};
