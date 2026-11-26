// Writes the reference cases next to this file, or checks that they are what this file writes.
//
//   node reference/generate.mjs           (from bindings/nova-scotia; `npm run reference`)
//   node reference/generate.mjs --check   (exit 1 when a file differs from what is written here)
//
// The pattern library ships HTML snippets, not templates (nsgov/patternlibrary at the pinned
// commit 663c256: forms/*.html, feedback/*.html, buttons/*.html, navigation/progress-tracker.html),
// so the markup below is each snippet's own, written out by hand with the form the binding is asked
// to draw beside it, and every case cites the snippets it follows. Two things are not the
// library's, and each case that has them says so in its `note`:
//
//   - saltire.css is Bootstrap 3.3.5 trimmed, and leaves out the layout classes its own snippets
//     still write (.form-group, .help-block, .radio, ...). The kit draws a reference with the
//     design system's files only, so every case carries the binding's whole sheet (src/css.ts) as a
//     <style> of its own: what the library leaves out is then the same on both sides of the
//     comparison. The comparison therefore gates the markup, the renderer's wrapper and the shadow
//     transfer, not the restated rules, which are shared.
//   - a hand-written reference can agree with a wrong binding. The snippets are short and the
//     cases cite them, but they gate drawing losses, not whether an attribute is right.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CSS } from "../src/css.ts";

const here = dirname(fileURLToPath(import.meta.url));
const check = process.argv.includes("--check");
const PINNED = "nsgov/patternlibrary 663c256";

const style = `<style>\n${CSS.trim()}\n</style>`;

/** One case file: the JSON comment, then the form. */
function file(meta, markup) {
  const json = JSON.stringify({ ...meta, root: "form", width: 560 }, null, 2);
  return `<!-- datum-reference\n${json}\n-->\n<form novalidate>\n${style}\n${markup.trim()}\n</form>\n`;
}

const text = (id, configuration) => ({ id, type: "text", configuration });
const cases = {};

cases["input-default"] = file(
  {
    source: `${PINNED}: forms/form-group-has-error.html (the group, label and box without the state) and forms/form-input-text.html`,
    note: "a text field",
    components: [text("field1", { label: "Full name" })]
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Full name</label>
<input class="form-control" id="field1" name="field1" type="text">
</div>`
);

cases["input-hint"] = file(
  {
    source: `${PINNED}: forms/form-help-block.html (the hint is a help block after the box)`,
    note: "a text field with a hint",
    components: [text("field1", { label: "Master number", description: "Your master number can be found on the back of your drivers licence." })]
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Master number</label>
<input class="form-control" id="field1" name="field1" type="text" aria-describedby="field1__description">
<div class="help-block" id="field1__description">Your master number can be found on the back of your drivers licence.</div>
</div>`
);

cases["input-focus"] = file(
  {
    source: `${PINNED}: css/saltire.css, input:focus (a 0.25em #f8d44c outline)`,
    note: "a text field with focus",
    components: [text("field1", { label: "Full name" })],
    steps: [{ op: "focus", id: "field1" }],
    focus: "#field1"
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Full name</label>
<input class="form-control" id="field1" name="field1" type="text">
</div>`
);

cases["input-disabled"] = file(
  {
    source: `${PINNED}: forms/form-input-text.html, with the disabled attribute`,
    note: "a disabled text field (the form is disabled)",
    mode: "disabled",
    components: [text("field1", { label: "Full name" })]
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Full name</label>
<input class="form-control" id="field1" name="field1" type="text" disabled>
</div>`
);

cases["input-error"] = file(
  {
    source: `${PINNED}: forms/form-group-has-error.html (has-error on the group, the glyph beside the box, the message a help block) under feedback/feedback-error.html (the alert block: glyph, then .alert-message)`,
    note: "a text field too short, validated: the alert block lists the problem, the field shows it. The library's alert has a paragraph where the binding has a heading element (bold, at the form's heading level) and carries aria-label=alert beside role=alert, which the binding leaves out (the role names it).",
    components: [text("field1", { label: "Full name", minLength: 5, messages: { minLength: "Enter at least 5 characters." } })],
    steps: [{ op: "type", id: "field1", text: "ab" }, { op: "validate" }]
  },
  `
<div class="alert-block datum-ns-summary" role="alert" tabindex="-1">
<i class="fa fa-exclamation-circle" aria-hidden="true"></i>
<div class="alert-message">
<h2 class="datum-ns-alert-title" id="summary__heading"><strong>1 error</strong></h2>
<ul>
<li><a href="#field1">Full name: Enter at least 5 characters.</a></li>
</ul>
</div>
</div>
<div class="form-group has-error">
<label class="control-label" for="field1">Full name</label>
<input class="form-control" id="field1" name="field1" type="text" value="ab" aria-describedby="field1__error" aria-invalid="true"> <i class="fa fa-exclamation-circle" aria-hidden="true"></i>
<div class="help-block" id="field1__error">Enter at least 5 characters.</div>
</div>`
);

cases["input-required"] = file(
  {
    source: `${PINNED}: forms/form-group-has-error.html (label and box). The asterisk and the sentence are not the library's: it marks neither (its Drupal forms mark the required fields with an asterisk), so the binding writes abbr[title=required] and a paragraph above the fields`,
    note: "a required text field: the asterisk, aria-required and the note that explains it",
    components: [text("field1", { label: "Full name", required: true })]
  },
  `
<p class="datum-ns-required-note">Fields marked with <abbr title="required" class="datum-ns-required">*</abbr> are required.</p>
<div class="form-group">
<label class="control-label" for="field1">Full name <abbr title="required" class="datum-ns-required">*</abbr></label>
<input class="form-control" id="field1" name="field1" type="text" aria-required="true">
</div>`
);

cases["textarea-hint"] = file(
  {
    source: `${PINNED}: forms/form-textarea.html (rows 5, cols 60) with forms/form-help-block.html`,
    note: "a textarea with a hint",
    components: [{ id: "field1", type: "textarea", configuration: { label: "Notes", description: "Anything we should know.", rows: 5 } }]
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Notes</label>
<textarea class="form-control" id="field1" name="field1" rows="5" cols="60" aria-describedby="field1__description"></textarea>
<div class="help-block" id="field1__description">Anything we should know.</div>
</div>`
);

cases["number-default"] = file(
  {
    source: `${PINNED}: forms/form-input-number.html (type=number)`,
    note: "a number field",
    components: [{ id: "field1", type: "number", configuration: { label: "Choose a number" } }]
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Choose a number</label>
<input class="form-control" id="field1" name="field1" type="number">
</div>`
);

cases["select-default"] = file(
  {
    source: `${PINNED}: forms/form-select.html (the first option, the empty choice, is the renderer's)`,
    note: "a select",
    components: [{ id: "field1", type: "select", configuration: { label: "Select an option", options: [{ value: "one", label: "option one" }, { value: "two", label: "option two" }, { value: "three", label: "option three" }] } }]
  },
  `
<div class="form-group">
<label class="control-label" for="field1">Select an option</label>
<select class="form-control" id="field1" name="field1">
<option value="" selected>Select…</option>
<option value="one">option one</option>
<option value="two">option two</option>
<option value="three">option three</option>
</select>
</div>`
);

cases["radios-hint"] = file(
  {
    source: `${PINNED}: forms/form-fieldset.html (the fieldset and its legend), forms/form-checkbox.html (the label that holds the box), forms/form-help-block.html. The library's radio snippet (forms/form-radio.html) puts the label after the box on a line of its own; the binding uses the checkbox snippet's wrapping label, which is also what the sheet's .radio rules expect`,
    note: "a group of radios with a hint on the group and on one choice",
    components: [
      {
        id: "field1",
        type: "radio",
        configuration: {
          label: "Preferred contact method",
          description: "We use this for follow-up only.",
          options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone", description: "Weekdays, 9 to 5." }, { value: "mail", label: "Post" }]
        }
      }
    ]
  },
  `
<fieldset class="form-group" aria-describedby="field1__description">
<legend class="control-label" id="field1__label">Preferred contact method</legend>
<div class="help-block" id="field1__description">We use this for follow-up only.</div>
<div class="radio"><label for="field1-0"><input id="field1-0" name="field1" type="radio" value="email"> Email</label></div>
<div class="radio"><label for="field1-1"><input id="field1-1" name="field1" type="radio" value="phone" aria-describedby="field1-1__hint"> Phone</label>
<div class="help-block" id="field1-1__hint">Weekdays, 9 to 5.</div></div>
<div class="radio"><label for="field1-2"><input id="field1-2" name="field1" type="radio" value="mail"> Post</label></div>
</fieldset>`
);

cases["checkboxes-hint"] = file(
  {
    source: `${PINNED}: forms/form-checkbox.html (the label that holds the box), forms/form-fieldset.html, forms/form-help-block.html`,
    note: "a group of checkboxes with a hint on the group",
    components: [
      {
        id: "field1",
        type: "checkboxes",
        configuration: { label: "How can we reach you?", description: "Choose all that apply.", options: [{ value: "email", label: "Email" }, { value: "phone", label: "Phone" }, { value: "post", label: "Post" }] }
      }
    ]
  },
  `
<fieldset class="form-group" aria-describedby="field1__description">
<legend class="control-label" id="field1__label">How can we reach you?</legend>
<div class="help-block" id="field1__description">Choose all that apply.</div>
<div class="checkbox"><label for="field1-0"><input id="field1-0" name="field1" type="checkbox" value="email"> Email</label></div>
<div class="checkbox"><label for="field1-1"><input id="field1-1" name="field1" type="checkbox" value="phone"> Phone</label></div>
<div class="checkbox"><label for="field1-2"><input id="field1-2" name="field1" type="checkbox" value="post"> Post</label></div>
</fieldset>`
);

cases["checkbox-default"] = file(
  {
    source: `${PINNED}: forms/form-checkbox.html (the label that holds the box; the box's own words are the label)`,
    note: "a single checkbox",
    components: [{ id: "field1", type: "checkbox", configuration: { label: "I agree to the terms" } }]
  },
  `
<div class="form-group">
<div class="checkbox"><label for="field1"><input id="field1" name="field1" type="checkbox"> I agree to the terms</label></div>
</div>`
);

cases["fieldset-input"] = file(
  {
    source: `${PINNED}: forms/form-fieldset.html (the library's own legend: 1.5em with a rule) around forms/form-group-has-error.html's group`,
    note: "a fieldset around a text field",
    components: [{ id: "more", type: "fieldset", configuration: { label: "About your request" }, children: { content: [text("field1", { label: "Extra detail" })] } }]
  },
  `
<fieldset class="form-group">
<legend id="more__group-label">About your request</legend>
<div class="form-group">
<label class="control-label" for="field1">Extra detail</label>
<input class="form-control" id="field1" name="field1" type="text">
</div>
</fieldset>`
);

cases["button-submit"] = file(
  {
    source: `${PINNED}: buttons/btn-form-submit.html (btn-lg btn-success; the library's snippet has no .btn class, which the binding adds as Bootstrap 3 writes a button)`,
    note: "the submit button",
    components: [{ id: "submit", type: "button", configuration: { label: "Submit", variant: "success", size: "lg", action: "submit" } }]
  },
  `
<button type="button" class="btn btn-success btn-lg">Submit</button>`
);

const names = Object.keys(cases).sort();
let different = 0;
for (const name of names) {
  const path = join(here, `${name}.html`);
  if (check) {
    let current = "";
    try {
      current = readFileSync(path, "utf8");
    } catch {
      current = "";
    }
    if (current !== cases[name]) {
      different += 1;
      console.error(`reference/${name}.html differs from what generate.mjs writes (run: npm run reference)`);
    }
  } else {
    writeFileSync(path, cases[name]);
    console.log(`wrote reference/${name}.html`);
  }
}
if (check) {
  for (const stale of readdirSync(here).filter((entry) => entry.endsWith(".html") && !(entry.slice(0, -5) in cases))) {
    different += 1;
    console.error(`reference/${stale} is not written by generate.mjs`);
  }
  console.log(different === 0 ? `references: ${names.length} files match generate.mjs` : `references: ${different} of ${names.length} differ`);
  process.exit(different === 0 ? 0 : 1);
}
