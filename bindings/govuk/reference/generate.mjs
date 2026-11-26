// Writes the reference cases next to this file from GOV.UK Frontend's own Nunjucks templates.
//
//   node reference/generate.mjs          (from bindings/govuk; `npm run reference`)
//
// Every component of the pinned release (the devDependency alias govuk-frontend-6.6.0) carries
// fixtures.json, a list of { name, options, html }: the markup its template renders for `options`.
// A case picks the options of a shipped fixture (or writes its own), renders them through the
// release's own macro with Nunjucks, and for a shipped fixture asserts that the render equals the
// fixture's html, so the renderer here is proven to be GOV.UK's before any markup is written. The
// form the binding is asked to draw is built from the same `options`: one source for both sides.
// A reference is the pinned release's by construction and moves only when the alias does.
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = join(here, "..", "node_modules", "govuk-frontend-6.6.0");
const dist = join(pkg, "dist");
const release = JSON.parse(readFileSync(join(pkg, "package.json"), "utf8")).version;
const nunjucks = createRequire(join(here, "..", "package.json"))("nunjucks");
const env = nunjucks.configure(dist, { autoescape: true });

const MACROS = { input: "govukInput", textarea: "govukTextarea", radios: "govukRadios", checkboxes: "govukCheckboxes", "date-input": "govukDateInput", "character-count": "govukCharacterCount", "error-summary": "govukErrorSummary", select: "govukSelect", "summary-list": "govukSummaryList" };
// The templates leave runs of blank lines and attribute padding; the release's fixtures are the same markup with them tidied. Whitespace between tags is not rendered, so both sides are tidied the same way.
const tidy = (html) =>
  html
    .split(/(<textarea[\s\S]*?<\/textarea>)/)
    // Preformatted content (a textarea's value) is left alone; markup around it is collapsed.
    .map((chunk, index) => (index % 2 === 1 ? chunk.replace(/>\s*\n/, ">\n").trim() : chunk.replace(/\s+/g, " ").replace(/ >/g, ">").replace(/> </g, ">\n<")))
    .join("")
    .trim();
const render = (component, options) => tidy(env.renderString(`{% from "govuk/components/${component}/macro.njk" import ${MACROS[component]} %}{{ ${MACROS[component]}(params) }}`, { params: options }));

const shipped = (component, name) => {
  const file = JSON.parse(readFileSync(join(dist, "govuk", "components", component, "fixtures.json"), "utf8"));
  const found = file.fixtures.find((entry) => entry.name === name);
  if (!found) throw new Error(`govuk-frontend ${release}: components/${component}/fixtures.json has no fixture "${name}"`);
  return found;
};

/** A part of a case: a component rendered from a shipped fixture's options (checked against its html) or from options of the case's own. */
function part(component, source, make) {
  if (typeof source === "string") {
    const fixture = shipped(component, source);
    const html = render(component, fixture.options);
    if (html !== tidy(fixture.html)) throw new Error(`rendering ${component} "${source}" with Nunjucks does not equal the release's own fixture html: the generator's environment is not GOV.UK's`);
    return { component, options: fixture.options, html, origin: `components/${component}/fixtures.json, fixture "${source}"`, make };
  }
  return { component, options: source, html: render(component, source), origin: `components/${component}/template.njk with options of this case`, make };
}

/** A part of a case that no macro of the release draws: the binding's own markup around a pattern (a journey page's heading and buttons), written out. */
function raw(html, origin) {
  return { component: undefined, options: undefined, html: tidy(html), origin };
}

// ── The form the binding is asked to draw, from a part's options ───────────────────────────

const text = (id, o) => ({ id, type: "text", configuration: { label: o.label.text, ...(o.hint ? { description: o.hint.text } : {}), required: true, ...(o.prefix ? { prefix: o.prefix.text } : {}), ...(o.suffix ? { suffix: o.suffix.text } : {}), ...(o.errorMessage ? { messages: { required: o.errorMessage.text } } : {}) } });
const textarea = (id, o) => ({ id, type: "textarea", configuration: { label: o.label.text, ...(o.hint ? { description: o.hint.text } : {}), required: true, rows: o.rows ?? 5, ...(o.errorMessage ? { messages: { required: o.errorMessage.text } } : {}) } });
const choice = (type) => (id, o) => ({
  id,
  type,
  configuration: {
    label: o.fieldset.legend.text,
    ...(o.hint ? { description: o.hint.text } : {}),
    required: true,
    options: o.items.map((item) => ({ value: item.value, label: item.text, ...(item.hint ? { description: item.hint.text } : {}) })),
    ...(o.errorMessage ? { messages: { required: o.errorMessage.text } } : {})
  }
});
const date = (id, o) => ({ id, type: "date", configuration: { label: o.fieldset.legend.text, ...(o.hint ? { description: o.hint.text } : {}), required: true, ...(o.errorMessage ? { messages: { required: o.errorMessage.text } } : {}) } });
// The empty first option is Datum's ("Select…"); the case lists it as the first item of the reference.
const select = (id, o) => ({
  id,
  type: "select",
  configuration: {
    label: o.label.text,
    ...(o.hint ? { description: o.hint.text } : {}),
    required: true,
    options: o.items.filter((item) => item.value !== "").map((item) => ({ value: String(item.value), label: item.text })),
    ...(o.errorMessage ? { messages: { required: o.errorMessage.text } } : {})
  }
});
const count = (id, o) => ({ id, type: "textarea", configuration: { label: o.label.text, ...(o.hint ? { description: o.hint.text } : {}), required: true, rows: o.rows ?? 5, maxLength: o.maxlength, characterCount: true } });

const ERROR = "Enter a National Insurance number in the correct format";
const OPTIONS = [{ value: "yes", text: "Yes" }, { value: "no", text: "No" }];
const summary = (text, href) => part("error-summary", { titleText: "There is a problem", errorList: [{ text, href }] });

// The check answers pattern (design-system.service.gov.uk/patterns/check-answers): a journey's Check answers page,
// reached by Continue from the one step before it. The step's answers are a summary list (a Change link per row,
// named in visually hidden text; a required answer not given an "Enter …" link in the value, its row with no actions),
// a data grid's row a summary card (the row heading as its title, one Change named by the title in brackets).
const CHANGE = "#about__page-heading";
const CHECK_ANSWERS = {
  id: "summary-list-check-answers",
  definition: {
    id: "kit-summary-list-check-answers",
    version: "1.0.0",
    schemaVersion: "1",
    localization: { defaultLocale: "en", supportedLocales: [{ code: "en", label: "English" }] },
    root: {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "fullName", type: "text", configuration: { label: "Full name", required: true } },
          { id: "town", type: "text", configuration: { label: "Town" } },
          { id: "landlord", type: "text", configuration: { label: "Landlord's name", required: true } },
          {
            id: "people",
            type: "dataGrid",
            configuration: { label: "People", initialRows: 0, rowLabel: "Person {{n}}" },
            collection: { collectionPath: "people" },
            children: { content: [{ id: "name", type: "text", configuration: { label: "Name" } }] }
          }
        ]
      }
    },
    journey: { journeys: [{ id: "apply", name: "Apply", pages: [
      { id: "about", title: "About you", components: ["fullName", "town", "landlord", "people"] },
      { id: "check", kind: "review", title: "Check your answers" }
    ] }] }
  },
  preset: { fullName: "Ana Silva", "people[0].name": "Leo Silva" },
  steps: [{ op: "click", selector: "[data-journey-continue]" }],
  parts: [
    raw(`<span class="govuk-caption-l">Step 2 of 2<span class="govuk-visually-hidden">: </span></span>`, "the binding's journey page caption: the step count a journey shows unless its progress is none (form.ts page.heading)"),
    raw(`<h1 class="govuk-heading-l" tabindex="-1">Check your answers</h1>`, "the binding's journey page heading (form.ts page.heading)"),
    raw(`<h2 class="govuk-heading-m">About you</h2>`, "patterns/check-answers: a heading per section"),
    part("summary-list", {
      rows: [
        { key: { text: "Full name" }, value: { text: "Ana Silva" }, actions: { items: [{ href: CHANGE, text: "Change", visuallyHiddenText: "Full name" }] } },
        { key: { text: "Town" }, value: { text: "Not provided" }, actions: { items: [{ href: CHANGE, text: "Change", visuallyHiddenText: "Town" }] } },
        { key: { text: "Landlord's name" }, value: { html: `<a class="govuk-link" href="${CHANGE}">Enter Landlord's name</a>` } }
      ]
    }),
    part("summary-list", {
      card: { title: { text: "Person 1", headingLevel: 3 }, actions: { items: [{ href: CHANGE, text: "Change" }] } },
      rows: [{ key: { text: "Name" }, value: { text: "Leo Silva" } }]
    }),
    raw(
      `<div class="govuk-button-group"><button type="button" class="govuk-button" data-module="govuk-button" aria-disabled="false">Submit</button><button type="button" class="govuk-button govuk-button--secondary" data-module="govuk-button" aria-disabled="false">Back</button></div>`,
      "the binding's journey page buttons (form.ts page.actions)"
    )
  ],
  note: "a journey's Check answers page: a summary list with Change links and a missing answer, a data grid's row as a summary card"
};

// A case: id, its parts in page order (a part with no `make` is markup only, such as the error summary), what is done to
// the drawn binding (the reference markup already shows the state), and a note.
const CASES = [
  { id: "input-default", parts: [part("input", "default", text)], note: "a required text field" },
  { id: "input-hint", parts: [part("input", "with hint text", text)], note: "a text field with a hint" },
  { id: "input-prefix-suffix", parts: [part("input", "with prefix and suffix", text)], note: "a text field with a prefix and a suffix" },
  { id: "textarea-hint", parts: [part("textarea", "with hint", textarea)], note: "a textarea with a hint" },
  { id: "radios-hint", parts: [part("radios", "with hint", choice("radio"))], note: "radios with a legend and a hint" },
  { id: "checkboxes-hint", parts: [part("checkboxes", "with hint", choice("checkboxes"))], note: "checkboxes with a legend and a hint" },
  { id: "date-input-hint", parts: [part("date-input", "default", date)], note: "a date input with a hint" },
  {
    id: "character-count-hint",
    parts: [part("character-count", "with hint", count)],
    note: "a character count with a hint",
    compareWith: "plain",
    // The script adds a visually hidden live status ("You have 10 characters remaining"). The count's live region is the renderer's announcer (Datum owns announcing; it speaks after typing), so that element is the one difference.
    ignoreText: [{ match: "^\\[live\\] \\[sr\\] You have", reason: "GOV.UK's script writes its own visually hidden status; the count's live region is the renderer's announcer" }],
    ignoreBoxes: [{ match: "^You have \\d+ characters? r", reason: "the script's visually hidden status element (see ignoreText)" }]
  },
  { id: "input-focus", parts: [part("input", "default", text)], focus: "input", steps: [{ op: "focus", id: "field1" }], note: "a text field with focus (GOV.UK's yellow focus ring)" },
  {
    id: "input-disabled",
    parts: [part("input", "disabled", text)],
    mode: "disabled",
    note: "a disabled text field"
  },
  {
    id: "character-count-value",
    parts: [part("character-count", "with default value", count)],
    value: { field1: "221B Baker Street\nLondon\nNW1 6XE\n" },
    note: "a character count holding an answer: the count the script leaves",
    compareWith: "plain",
    ignoreText: [{ match: "^\\[live\\] \\[sr\\] You have", reason: "GOV.UK's script writes its own visually hidden status; the count's live region is the renderer's announcer" }],
    ignoreBoxes: [{ match: "^You have \\d+ characters? r", reason: "the script's visually hidden status element (see ignoreText)" }]
  },
  {
    id: "select-hint",
    parts: [part("select", { id: "field1", name: "field1", label: { text: "Sort by" }, hint: { text: "Choose how the results are ordered." }, items: [{ value: "", text: "Select…" }, { value: "published", text: "Recently published" }, { value: "updated", text: "Recently updated" }, { value: "views", text: "Most views" }] }, select)],
    note: "a select with a hint"
  },
  {
    id: "textarea-error",
    parts: [
      summary("Enter details of your request", "#field1"),
      part("textarea", { id: "field1", name: "field1", rows: 5, label: { text: "Can you provide more detail?" }, hint: { text: "Do not include personal or financial information." }, errorMessage: { text: "Enter details of your request" } }, textarea)
    ],
    steps: [{ op: "validate" }],
    note: "a required textarea left empty and validated: the error summary and the field's error"
  },
  {
    id: "radios-error",
    parts: [
      summary("Select yes if you have changed your name", "#field1"),
      part("radios", { idPrefix: "field1", name: "field1", errorMessage: { text: "Select yes if you have changed your name" }, fieldset: { legend: { text: "Have you changed your name?" } }, hint: { text: "This includes changing your last name or spelling your name differently." }, items: OPTIONS }, choice("radio"))
    ],
    steps: [{ op: "validate" }],
    note: "radios left unanswered and validated: the error summary and the group's error"
  },
  {
    id: "checkboxes-error",
    parts: [
      summary("Select how you want to be contacted", "#field1"),
      part("checkboxes", { name: "field1", errorMessage: { text: "Select how you want to be contacted" }, fieldset: { legend: { text: "How do you want to be contacted?" } }, hint: { text: "Select all options that are relevant to you." }, items: [{ value: "email", text: "Email" }, { value: "phone", text: "Phone" }, { value: "text", text: "Text message" }] }, choice("checkboxes"))
    ],
    steps: [{ op: "validate" }],
    note: "checkboxes left unanswered and validated: the error summary and the group's error"
  },
  {
    id: "date-input-error",
    parts: [
      summary("Enter your date of birth", "#field1"),
      part("date-input", { id: "field1", namePrefix: "field1", fieldset: { legend: { text: "What is your date of birth?" } }, hint: { text: "For example, 27 3 2007" }, errorMessage: { text: "Enter your date of birth" }, items: [{ name: "day", classes: "govuk-input--width-2 govuk-input--error" }, { name: "month", classes: "govuk-input--width-2 govuk-input--error" }, { name: "year", classes: "govuk-input--width-4 govuk-input--error" }] }, date)
    ],
    steps: [{ op: "validate" }],
    note: "a date left empty and validated: the error summary, the date's error and every box marked"
  },
  CHECK_ANSWERS,
  {
    id: "input-error",
    parts: [
      part("error-summary", { titleText: "There is a problem", errorList: [{ text: ERROR, href: "#field1" }] }),
      part("input", { id: "field1", name: "field1", label: { text: "National insurance number" }, errorMessage: { text: ERROR }, hint: { text: "It’s on your National Insurance card, benefit letter, payslip or P60." } }, text)
    ],
    components: ["field1"],
    steps: [{ op: "validate" }],
    note: "a required text field left empty and validated: the error summary and the field's error"
  }
];

for (const entry of CASES) {
  const components = entry.parts.filter((p) => p.make).map((p, index) => p.make(`field${index + 1}`, p.options));
  const meta = {
    source: `govuk-frontend ${release}: ${entry.parts.map((p) => p.origin).join("; ")}`,
    note: entry.note,
    components,
    ...(entry.definition ? { definition: entry.definition } : {}),
    ...(entry.preset ? { preset: entry.preset } : {}),
    ...(entry.steps ? { steps: entry.steps } : {}),
    ...(entry.mode ? { mode: entry.mode } : {}),
    ...(entry.value ? { preset: entry.value } : {}),
    ...(entry.focus ? { focus: entry.focus } : {}),
    root: "form",
    width: 560,
    // GOV.UK's own page runs initAll() on the document. A shadow root cannot run it (its scripts look elements up through document), so the shadow picture is the no-JS baseline.
    init: "window.GOVUKFrontend.initAll();",
    ...(entry.known ? { known: entry.known } : {}),
    ...(entry.compareWith ? { compareWith: entry.compareWith } : {}),
    ...(entry.ignoreText ? { ignoreText: entry.ignoreText } : {}),
    ...(entry.ignoreBoxes ? { ignoreBoxes: entry.ignoreBoxes } : {})
  };
  const html = entry.parts.map((p) => p.html).join("\n");
  writeFileSync(join(here, `${entry.id}.html`), `<!-- datum-reference\n${JSON.stringify(meta, null, 2)}\n-->\n<form novalidate>\n${html}\n</form>\n`);
  console.log(`${entry.id}.html`);
}
