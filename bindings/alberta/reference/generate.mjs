// Writes reference/*.html: one case per file, the markup the Alberta Design System documents for
// each component (design.alberta.ca component pages; properties per @abgov/web-components 3.2.0,
// the pinned release's own index.js element definitions, since the package ships no templates).
// Hand-written, so a case gates drawing losses (wrapper, margins, shadow transfer), not
// attribute correctness. Run: node reference/generate.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const RELEASE = "properties per @abgov/web-components 3.2.0 (the release's index.js element definitions)";
const page = (name) => `https://design.alberta.ca/components/${name} (Alberta Design System, component page), ${RELEASE}`;

const SUMMARY_UL = `<ul style="padding:0">`;
const SUMMARY_LI = (href, text) => `<li style="list-style-type:none"><a href="${href}" style="color:var(--goa-color-emergency-dark)">${text}</a></li>`;

const cases = [
  {
    file: "input-default",
    note: "a text field",
    components: [{ id: "full-name", type: "text", configuration: { label: "Full name" } }],
    source: page("input") + "; form item: " + page("form-item"),
    markup: `<goa-form-item label="Full name" helptext="" error="" requirement="" type="text-input"><goa-input id="full-name" name="full-name" type="text" placeholder="" autocomplete="" arialabel="" error="false" disabled="false" readonly="false"></goa-input></goa-form-item>`
  },
  {
    file: "input-hint-required",
    note: "a required text field with help text",
    components: [{ id: "full-name", type: "text", configuration: { label: "Full name", description: "As on your birth certificate.", required: true } }],
    source: page("form-item"),
    markup: `<goa-form-item label="Full name" helptext="As on your birth certificate." error="" requirement="required" type="text-input"><goa-input id="full-name" name="full-name" type="text" placeholder="" autocomplete="" arialabel="" error="false" disabled="false" readonly="false"></goa-input></goa-form-item>`
  },
  {
    file: "input-error",
    note: "a required text field left empty and validated: the error callout over a list of links, and the form item's error",
    components: [{ id: "full-name", type: "text", configuration: { label: "Full name", required: true } }],
    steps: [{ op: "validate" }],
    source: page("form-item") + "; the error list is what goa-fieldset draws over a form's errors (goa-callout type emergency, heading, a list of links; its list styles inline), stacked in a goa-block gap xl as the design system lays a form out",
    markup: `<goa-block direction="column" gap="xl" alignment="normal" width="100%"><goa-callout type="emergency" heading="There is a problem" arialive="off">${SUMMARY_UL}${SUMMARY_LI("#full-name", "Full name: This field is required")}</ul></goa-callout><goa-form-item label="Full name" helptext="" error="This field is required" requirement="required" type="text-input"><goa-input id="full-name" name="full-name" type="text" placeholder="" autocomplete="" arialabel="" error="true" disabled="false" readonly="false"></goa-input></goa-form-item></goa-block>`
  },
  {
    file: "input-disabled",
    note: "a disabled text field",
    components: [{ id: "full-name", type: "text", configuration: { label: "Full name", disabled: true } }],
    preset: { "full-name": "Ada Lovelace" },
    source: page("input"),
    markup: `<goa-form-item label="Full name" helptext="" error="" requirement="" type="text-input"><goa-input id="full-name" name="full-name" type="text" value="Ada Lovelace" placeholder="" autocomplete="" arialabel="" error="false" disabled="true" readonly="false"></goa-input></goa-form-item>`
  },
  {
    file: "input-prefix-suffix",
    note: "a text field with a prefix and a suffix: the input's leading and trailing content slots",
    components: [{ id: "amount", type: "text", configuration: { label: "Amount", prefix: "$", suffix: "CAD" } }],
    source: page("input") + " (leading and trailing content)",
    markup: `<goa-form-item label="Amount" helptext="" error="" requirement="" type="text-input"><goa-input id="amount" name="amount" type="text" placeholder="" autocomplete="" arialabel="" error="false" disabled="false" readonly="false"><div slot="leadingContent">$</div><div slot="trailingContent">CAD</div></goa-input></goa-form-item>`
  },
  {
    file: "number-default",
    note: "a number field",
    components: [{ id: "age", type: "number", configuration: { label: "Age", min: 0, max: 120 } }],
    source: page("input") + " (type number)",
    markup: `<goa-form-item label="Age" helptext="" error="" requirement="" type="text-input"><goa-input id="age" name="age" type="number" placeholder="" autocomplete="" min="0" max="120" step="" arialabel="" error="false" disabled="false" readonly="false"></goa-input></goa-form-item>`
  },
  {
    file: "textarea-hint",
    note: "a textarea with help text",
    components: [{ id: "about", type: "textarea", configuration: { label: "About you", description: "Tell us a little about yourself." } }],
    source: page("text-area"),
    markup: `<goa-form-item label="About you" helptext="Tell us a little about yourself." error="" requirement="" type="textarea"><goa-textarea name="about" rows="3" placeholder="" autocomplete="" arialabel="About you" error="false" disabled="false" readonly="false"></goa-textarea></goa-form-item>`
  },
  {
    file: "select-default",
    note: "a select: the dropdown drawn native, its empty first choice worded as the placeholder (a native dropdown draws no empty option of its own)",
    components: [{ id: "province", type: "select", configuration: { label: "Province", options: [{ value: "AB", label: "Alberta" }, { value: "BC", label: "British Columbia" }] } }],
    source: page("dropdown") + " (native)",
    markup: `<goa-form-item label="Province" helptext="" error="" requirement="" type=""><goa-dropdown name="province" native="true" placeholder="Select…" error="false" disabled="false" arialabel=""><goa-dropdown-item value="" label="Select…"></goa-dropdown-item><goa-dropdown-item value="AB" label="Alberta"></goa-dropdown-item><goa-dropdown-item value="BC" label="British Columbia"></goa-dropdown-item></goa-dropdown></goa-form-item>`
  },
  {
    file: "radios-hint",
    note: "radios with help text and an option description",
    components: [{ id: "contact", type: "radio", configuration: { label: "Preferred contact", description: "Choose one.", options: [{ value: "email", label: "Email", description: "Within a day" }, { value: "phone", label: "Phone" }] } }],
    source: page("radio"),
    markup: `<goa-form-item label="Preferred contact" helptext="Choose one." error="" requirement="" type="radio-group"><goa-radio-group name="contact" error="false" disabled="false" arialabel=""><goa-radio-item value="email" label="Email" description="Within a day"></goa-radio-item><goa-radio-item value="phone" label="Phone"></goa-radio-item></goa-radio-group></goa-form-item>`
  },
  {
    file: "checkboxes-hint",
    note: "checkboxes with help text and an option description",
    components: [{ id: "topics", type: "checkboxes", configuration: { label: "Topics", description: "Choose any.", options: [{ value: "news", label: "News", description: "Weekly" }, { value: "events", label: "Events" }] } }],
    source: page("checkbox"),
    markup: `<goa-form-item label="Topics" helptext="Choose any." error="" requirement="" type="checkbox-list"><goa-checkbox-list name="topics" error="false" disabled="false" arialabel=""><goa-checkbox name="news" text="News" value="news" description="Weekly"></goa-checkbox><goa-checkbox name="events" text="Events" value="events"></goa-checkbox></goa-checkbox-list></goa-form-item>`
  },
  {
    file: "button-submit",
    note: "the submit button",
    components: [{ id: "go", type: "button", configuration: { label: "Submit", action: "submit" } }],
    source: page("button"),
    markup: `<goa-button type="primary" variant="normal" size="normal" disabled="false">Submit</goa-button>`
  }
];

mkdirSync(here, { recursive: true });
for (const c of cases) {
  const header = { note: c.note, components: c.components, ...(c.preset ? { preset: c.preset } : {}), ...(c.steps ? { steps: c.steps } : {}), source: c.source, root: "form", width: 560 };
  writeFileSync(join(here, `${c.file}.html`), `<!-- datum-reference\n${JSON.stringify(header, null, 2)}\n-->\n<form novalidate>${c.markup}</form>\n`);
}
console.log(`wrote ${cases.length} reference cases`);
