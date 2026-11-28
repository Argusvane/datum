/**
 * The forms the feature-coverage harness (engine/feature-coverage) mounts beyond the agent
 * fixtures: each is the smallest form that has the shape one group of features needs, so a
 * scenario reads its answers off a definition nothing else touches. The harness gives some of
 * them behaviour a definition cannot hold (a slow data source, an async check, a warning), by
 * recipe (`feature-coverage/host/extras.ts`); the definitions here only name the fields.
 */

import type { ComponentNode, FormDefinition } from "../../form-engine/core/schema/types.js";

function form(id: string, children: ComponentNode[], extra: Partial<FormDefinition> = {}): FormDefinition {
  return {
    id,
    version: "1.0.0",
    schemaVersion: "1.0.0",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en" }, { code: "fr" }] },
    root: { id: "form", type: "form", configuration: { label: `Coverage ${id}` }, children: { content: children } },
    ...extra
  } as FormDefinition;
}

/** Two text boxes and a textarea with a length limit and a visible count each. */
export const COVERAGE_COUNTS_FORM: FormDefinition = form("counts", [
  { id: "bio", type: "text", configuration: { label: "Bio", maxLength: 10, characterCount: true } },
  { id: "other", type: "text", configuration: { label: "Other", maxLength: 10, characterCount: true } },
  { id: "notes", type: "textarea", configuration: { label: "Notes", maxLength: 20, characterCount: true } }
]);

/**
 * A required name, an email an async check may judge, a nickname a warning may be raised on, a
 * tip an info message may be raised on, and a submit button. The recipes `async-email` and
 * `advice` give it the check and the messages.
 */
export const COVERAGE_CHECKS_FORM: FormDefinition = form("checks", [
  { id: "name", type: "text", configuration: { label: "Full name", required: true } },
  { id: "email", type: "text", configuration: { label: "Email", description: "We write here" } },
  { id: "nick", type: "text", configuration: { label: "Nickname", description: "What friends call you" } },
  { id: "tip", type: "text", configuration: { label: "Tip" } },
  { id: "send", type: "button", configuration: { label: "Submit", action: "submit" } }
]);

/** The `checks` form with the form's `validateOn` set to `"submit"`: no field is checked when it is left. */
export const COVERAGE_CHECKS_SUBMIT_FORM: FormDefinition = {
  ...COVERAGE_CHECKS_FORM,
  id: "checks-submit",
  root: { ...COVERAGE_CHECKS_FORM.root, configuration: { ...(COVERAGE_CHECKS_FORM.root.configuration ?? {}), validateOn: "submit" } }
};

/** Two choice fields fed by data sources (`cities`, `towns`) and a plain text. The `sources` recipe supplies the sources. */
export const COVERAGE_SOURCES_FORM: FormDefinition = form("sources", [
  { id: "name", type: "text", configuration: { label: "Name" } },
  { id: "city", type: "select", configuration: { label: "City", data: { sourceId: "cities" } } },
  { id: "town", type: "select", configuration: { label: "Town", data: { sourceId: "towns" } } }
]);

/** Fields that are read-only or disabled by their own configuration, beside one that is not. */
export const COVERAGE_LOCKS_FORM: FormDefinition = form("locks", [
  { id: "free", type: "text", configuration: { label: "Free" } },
  { id: "locked", type: "text", configuration: { label: "Locked", readOnly: true } },
  { id: "off", type: "text", configuration: { label: "Off", disabled: true } },
  { id: "memo", type: "textarea", configuration: { label: "Memo", readOnly: true, rows: 2 } },
  { id: "notes", type: "textarea", configuration: { label: "Notes", rows: 2 } },
  { id: "ticked", type: "checkbox", configuration: { label: "Ticked", readOnly: true } },
  { id: "picked", type: "select", configuration: { label: "Picked", readOnly: true, options: [{ value: "a", label: "Alpha" }, { value: "b", label: "Beta" }] } }
]);

/**
 * A French form: the form's own words (labels, a hint, options, a validation message) and the
 * engine's words (the `texts` kind: the summary heading, the count, the notice words, the file
 * words) are translated; English stays the default.
 */
export const COVERAGE_TRANSLATED_FORM: FormDefinition = form(
  "translated",
  [
    { id: "name", type: "text", configuration: { label: "Name", description: "As on your card", required: true, maxLength: 20, characterCount: true, messages: { required: "Enter your name." } } },
    { id: "nick", type: "text", configuration: { label: "Nickname" } },
    {
      id: "colour",
      type: "select",
      configuration: { label: "Colour", required: true, options: [{ value: "red", label: "Red" }, { value: "blue", label: "Blue" }] }
    },
    { id: "receipt", type: "file", configuration: { label: "Receipt" } }
  ],
  {
    translations: {
      fr: {
        components: {
          name: {
            label: { text: "Nom", source: "x" },
            description: { text: "Comme sur votre carte", source: "x" },
            messages: { required: { text: "Entrez votre nom.", source: "x" } }
          },
          nick: { label: { text: "Surnom", source: "x" } },
          colour: {
            label: { text: "Couleur", source: "x" },
            options: { red: { label: { text: "Rouge", source: "x" } }, blue: { label: { text: "Bleu", source: "x" } } }
          },
          receipt: { label: { text: "Reçu", source: "x" } }
        },
        texts: {
          messages: { required: { text: "Ce champ est obligatoire.", source: "x" } },
          form: {
            countUpTo: { text: "Vous pouvez saisir jusqu'à {{max}} caractères", source: "x" },
            "summaryHeading.other": { text: "Il y a {{count}} problèmes", source: "x" },
            "summaryHeading.one": { text: "Il y a un problème", source: "x" },
            "countLeft.other": { text: "{{n}} caractères restants", source: "x" },
            "countLeft.one": { text: "{{n}} caractère restant", source: "x" },
            noticeWarning: { text: "Attention : ", source: "x" },
            noticeInfo: { text: "Information : ", source: "x" },
            fileRemove: { text: "Retirer", source: "x" },
            fileRemoved: { text: "{{name}} retiré", source: "x" },
            optionsLoading: { text: "Chargement des choix", source: "x" }
          }
        }
      }
    }
  }
);
