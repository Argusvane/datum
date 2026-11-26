/**
 * The Alberta Design System binding's language pack. Alberta's components are worded in
 * English only, so the pack has English entries and nothing else: the ones Alberta words
 * differently from Datum's defaults (the requirement mark goa-form-item writes after a label, and
 * the heading goa-fieldset puts over its errors). The pack sits under the form's own `texts`
 * translations and over the engine's English, so a form's own translation of a word wins. A form in
 * another language takes its words from its translations; the words goa-form-item and the other
 * components write themselves ("(required)", a dropdown's chevron label) stay Alberta's.
 */
import type { LanguagePackTable } from "../../../engine/form-engine/core/localization/translations.js";

export const ALBERTA_TEXTS: LanguagePackTable = {
  en: {
    required: "(required)",
    optional: "(optional)",
    // goa-fieldset's own heading over its errors, whatever their number.
    summaryHeading: "There is a problem",
    summaryHeadingOne: "There is a problem"
  }
};
