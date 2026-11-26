#!/usr/bin/env node
// Writes reference/*.html: the Québec design system's own markup for the cases the kit compares the
// binding with. qc-trousse-sdg ships no templates, only the documentation pages and baseline fixtures
// of its components (src/sdg/components/<Component>/_<component>.html and Test/*BaselineTest.html in
// the package), so each case is written from those examples; each file cites its source. A hand-written
// reference can agree with a wrong binding where the same attributes are passed on both sides: it gates
// drawing losses (wrapper, margins, shadow transfer, wording), not attribute correctness.
//   node reference/generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
mkdirSync(here, { recursive: true });
const PKG = "qc-trousse-sdg 1.6.1";
const TEXT = "src/sdg/components/TextField/_textField.html";
const CHOICE = "src/sdg/components/ChoiceGroup/_choiceGroup.html";
const CHECK = "src/sdg/components/Checkbox/_checkbox.html";
const BUTTON = "src/sdg/components/Button/_button.html";
const NOTICE = "src/sdg/components/Notice/_notice.html";

const form = (content, extra = {}) => ({ root: "form", width: 560, ...extra, components: content });
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;");

const summary = (items, heading = "There are errors in the form:") =>
  `<qc-notice type="error"><h2>${heading}</h2><ul>${items.map(([href, text]) => `<li><a href="#${href}">${esc(text)}</a></li>`).join("")}</ul></qc-notice>`;

const cases = {
  "input-default": {
    source: `${PKG}: ${TEXT}, "Exemples 1" (qc-textfield with a label and an input)`,
    note: "a text box with a label",
    components: [{ id: "field1", type: "text", configuration: { label: "City" } }],
    markup: `<qc-textfield label="City"><input id="field1" name="field1" type="text"></qc-textfield>`
  },
  "input-hint-required": {
    source: `${PKG}: ${TEXT}, "Exemples 1" (attributes description and required)`,
    note: "a required text box with a description",
    components: [{ id: "field1", type: "text", configuration: { label: "City", required: true, description: "Where you live" } }],
    markup: `<qc-textfield label="City" description="Where you live" required><input id="field1" name="field1" type="text"></qc-textfield>`
  },
  "input-disabled": {
    source: `${PKG}: ${TEXT}, "Exemples 1" (a disabled field)`,
    note: "a disabled text box",
    components: [{ id: "field1", type: "text", configuration: { label: "City", disabled: true } }],
    markup: `<qc-textfield label="City" disabled><input id="field1" name="field1" type="text" disabled></qc-textfield>`
  },
  "input-error": {
    source: `${PKG}: ${TEXT} ("Exemples 1", attribute invalid-text) under the error notice of ${NOTICE} ("Exemple d'avis d'erreur")`,
    note: "a required field left empty and validated: the error notice with its link, and the field's own error",
    components: [{ id: "field1", type: "text", configuration: { label: "City", required: true, messages: { required: "Enter your city." } } }],
    steps: [{ op: "validate" }],
    markup: `${summary([["field1", "City: Enter your city."]])}<qc-textfield label="City" required invalid invalid-text="Enter your city."><input id="field1" name="field1" type="text"></qc-textfield>`
  },
  "input-count-french": {
    source: `${PKG}: ${TEXT} (attribute max-length; the toolkit words the count in the page's language, French here)`,
    note: "a counted text box with an answer, in a French form on a French page: the count words are the toolkit's own",
    locale: "fr-CA",
    components: [{ id: "field1", type: "text", configuration: { label: "Ville", characterCount: true, maxLength: 20 } }],
    preset: { field1: "Québec" },
    ignoreText: [
      { match: "^\\[live\\] \\d+ caract", reason: "the toolkit's count is a polite live region that speaks on every keystroke; Datum's is hidden from assistive technology and announced once by the renderer after typing pauses (the same words are drawn)" },
      { match: "^\\[visual\\] \\d+ caract", reason: "the same count, seen by everyone and heard through the renderer's announcer (see the [live] line)" },
      { match: "^\\[sr\\] Vous pouvez saisir", reason: "the limit sentence Datum reads as the field's description; the toolkit has none" }
    ],
    ignoreBoxes: [{ match: "^Vous pouvez saisir", reason: "the limit sentence Datum reads as the field's description (visually hidden); the toolkit has none" }],
    markup: `<qc-textfield label="Ville" max-length="20"><input id="field1" name="field1" type="text" value="Québec"></qc-textfield>`
  },
  "textarea-hint": {
    source: `${PKG}: ${TEXT}, "Exemples 1" (a multiline field: a textarea in qc-textfield, size lg by default)`,
    note: "a textarea with a description",
    components: [{ id: "field1", type: "textarea", configuration: { label: "Comments", description: "Anything else we should know" } }],
    markup: `<qc-textfield label="Comments" description="Anything else we should know"><textarea id="field1" name="field1" rows="4"></textarea></qc-textfield>`
  },
  "number-default": {
    source: `${PKG}: ${TEXT} (the toolkit has no number field: a text box with a numeric keyboard)`,
    note: "a number drawn as a text box",
    components: [{ id: "field1", type: "number", configuration: { label: "Age" } }],
    markup: `<qc-textfield label="Age"><input id="field1" name="field1" type="text" inputmode="decimal"></qc-textfield>`
  },
  "radios-default": {
    source: `${PKG}: ${CHOICE}, "Exemple de groupes de boutons radio"`,
    note: "radios in a qc-choice-group",
    components: [{ id: "field1", type: "radio", configuration: { label: "Contact method", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } }],
    markup: `<qc-choice-group legend="Contact method" name="field1"><label><input id="field1-email" type="radio" name="field1" value="email"><span>Email</span></label><label><input id="field1-phone" type="radio" name="field1" value="phone"><span>Phone</span></label></qc-choice-group>`
  },
  "radios-error": {
    source: `${PKG}: ${CHOICE}, "Exemple de validation de formulaire avec des groupes de choix" (required, invalid-text) under the error notice of ${NOTICE}`,
    note: "required radios left empty and validated",
    components: [{ id: "field1", type: "radio", configuration: { label: "Contact method", required: true, messages: { required: "Choose a contact method." }, options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } }],
    steps: [{ op: "validate" }],
    markup: `${summary([["field1-email", "Contact method: Choose a contact method."]])}<qc-choice-group legend="Contact method" name="field1" required invalid invalid-text="Choose a contact method."><label><input id="field1-email" type="radio" name="field1" value="email"><span>Email</span></label><label><input id="field1-phone" type="radio" name="field1" value="phone"><span>Phone</span></label></qc-choice-group>`
  },
  "checkboxes-default": {
    source: `${PKG}: ${CHOICE}, "Exemple de groupes de boutons radio et de cases à cocher"`,
    note: "checkboxes in a qc-choice-group, one chosen",
    components: [{ id: "field1", type: "checkboxes", configuration: { label: "Channels", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }] } }],
    preset: { field1: { email: true } },
    markup: `<qc-choice-group legend="Channels" name="field1"><label><input id="field1-email" type="checkbox" name="field1" value="email" checked><span>Email</span></label><label><input id="field1-phone" type="checkbox" name="field1" value="phone"><span>Phone</span></label></qc-choice-group>`
  },
  "checkbox-single": {
    source: `${PKG}: ${CHECK}, "Exemple d'une case à cocher obligatoire"`,
    note: "a required single checkbox",
    components: [{ id: "field1", type: "checkbox", configuration: { label: "I accept the terms", required: true } }],
    markup: `<qc-checkbox required><label><input id="field1" type="checkbox" name="field1"><span>I accept the terms</span></label></qc-checkbox>`
  },
  "button-submit": {
    source: `${PKG}: ${BUTTON}, "Exemples des différentes variantes de boutons" (button.qc-button.qc-primary)`,
    note: "a primary button",
    components: [{ id: "go", type: "button", configuration: { label: "Send", action: "submit", variant: "primary" } }],
    markup: `<button type="button" class="qc-button qc-primary">Send</button>`
  }
};

for (const [name, c] of Object.entries(cases)) {
  const { markup, ...rest } = c;
  const meta = form(rest.components, Object.fromEntries(Object.entries(rest).filter(([k]) => k !== "components")));
  const ordered = { source: meta.source, note: meta.note, ...Object.fromEntries(Object.entries(meta).filter(([k]) => !["source", "note"].includes(k))) };
  writeFileSync(join(here, `${name}.html`), `<!-- datum-reference\n${JSON.stringify(ordered, null, 2)}\n-->\n<form novalidate${rest.locale ? ` lang="${rest.locale.slice(0, 2)}"` : ""}>\n${markup}\n</form>\n`);
}
console.log(`wrote ${Object.keys(cases).length} references`);
