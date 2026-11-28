import { describe, expect, it } from "vitest";

import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import { optionsEditorHtml, type OptionsEditorView } from "../form-engine/builder/web-component/builder-shared.js";
import {
  labelCapability,
  lengthCapability,
  messagesCapability,
  requiredCapability
} from "../form-engine/registry/capabilities/field-capabilities.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

const email: ComponentNode = {
  id: "email",
  type: "text",
  configuration: {
    label: "Email",
    required: true,
    maxLength: 80,
    messages: {
      required: "Enter your email.",
      pattern: "That is not an email address."
    }
  }
};

const codesOf = (entries: ReadonlyArray<{ code: string }> | undefined) => entries?.map((entry) => entry.code);

describe("inspector model — validation messages row", () => {
  it("hands the row the authored entries and the codes in tiers", () => {
    const model = buildInspectorModel(
      email,
      [labelCapability, requiredCapability, lengthCapability, messagesCapability],
      undefined,
      "en",
      {
        validationCodes: [
          "taken",
          { code: "custom.fullNameIncomplete", label: "First and last name" },
          " ",
          { code: "required", message: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } } }
        ]
      }
    );
    const validation = model.sections.find((section) => section.id === "validation");
    expect(validation?.fields.map((field) => [field.propertyPath, field.control])).toEqual([
      ["required", "checkbox"],
      ["minLength", "number"],
      ["maxLength", "number"],
      ["characterCount", "checkbox"],
      ["messages", "messages"]
    ]);
    const row = validation?.fields.find((field) => field.control === "messages");
    expect(row?.messagesEditor?.entries).toEqual([
      { code: "required", text: "Enter your email." },
      { code: "pattern", text: "That is not an email address." }
    ]);
    expect(row?.messagesEditor?.scope).toBe("component");
    // What this field's own checks can raise, in front; the engine's other codes after.
    expect(codesOf(row?.messagesEditor?.usedCodes)).toEqual(["required", "maxLength"]);
    expect(codesOf(row?.messagesEditor?.engineCodes)).toEqual([
      "minLength",
      "pattern",
      "fileType",
      "maxFileSize",
      // Codes offered, never "used".
      "fileSize",
      "file.sizeMismatch",
      "file",
      "fileCount",
      "text",
      "number",
      "number.min",
      "number.max",
      "date",
      "date.min",
      "date.max",
      "dateIncomplete",
      "date.year",
      // A Validate rule's words; "used" only on a field with `rules.validWhen`.
      "rule",
      "rows.min",
      "rows.max"
    ]);
    // The host's codes, labelled or not, with blanks and the engine's own left out.
    expect(row?.messagesEditor?.hostCodes).toEqual([
      { code: "taken", label: "Named by the page", parameters: [] },
      { code: "custom.fullNameIncomplete", label: "First and last name", parameters: [] }
    ]);
    // Each engine code says which details a message may quote.
    expect(row?.messagesEditor?.engineCodes.find((entry) => entry.code === "minLength")?.parameters).toEqual([
      "minLength",
      "length"
    ]);
    // The page's wording is kept by code, the engine's own codes included, for the editor to fall back on.
    expect(row?.messagesEditor?.defaults).toEqual({
      required: { default: "This field is required.", locales: { "fr-CA": "Ce champ est requis." } }
    });
  });

  it("reads the whole form's codes on the root, and lists nothing where nothing is authored", () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          { id: "name", type: "text", configuration: { label: "Name", required: true } },
          {
            id: "address",
            type: "fieldset",
            configuration: {},
            children: {
              content: [
                { id: "code", type: "text", configuration: { label: "Code", pattern: "^[A-Z]{3}$" } },
                { id: "doc", type: "file", configuration: { label: "Document", accept: "application/pdf" } }
              ]
            }
          }
        ]
      }
    };
    const row = buildInspectorModel(root)
      .sections.flatMap((section) => section.fields)
      .find((field) => field.control === "messages");
    expect(row?.messagesEditor?.scope).toBe("form");
    expect(row?.messagesEditor?.entries).toEqual([]);
    expect(codesOf(row?.messagesEditor?.usedCodes)).toEqual(["required", "pattern", "fileType"]);
    expect(codesOf(row?.messagesEditor?.engineCodes)).toEqual([
      "minLength",
      "maxLength",
      "maxFileSize",
      "fileSize",
      "file.sizeMismatch",
      "file",
      "fileCount",
      "text",
      "number",
      "number.min",
      "number.max",
      "date",
      "date.min",
      "date.max",
      "dateIncomplete",
      "date.year",
      "rule",
      "rows.min",
      "rows.max"
    ]);
    expect(row?.messagesEditor?.hostCodes).toEqual([]);
    expect(row?.messagesEditor?.defaults).toEqual({});
    // A field with no checks of its own raises nothing itself.
    const bare = buildInspectorModel({ id: "note", type: "text", configuration: { label: "Note" } }, [messagesCapability]);
    const bareRow = bare.sections.flatMap((section) => section.fields).find((field) => field.control === "messages");
    expect(bareRow?.messagesEditor?.usedCodes).toEqual([]);
    // Every engine code, `rule` included.
    expect(codesOf(bareRow?.messagesEditor?.engineCodes)).toHaveLength(22);
  });
});

describe("messages editor markup", () => {
  const view: OptionsEditorView = {
    kind: "messages",
    path: "messages",
    title: "Validation messages — Email",
    rows: [
      // What the field's own checks raise, listed whether worded or not: seeded rows.
      { value: "required", label: "Enter your email.", meaning: "A required value is missing", seeded: true },
      {
        value: "maxLength",
        label: "",
        meaning: "Text is longer than the maximum",
        seeded: true,
        // The page words this code: its text is the fallback, and can be copied in.
        fallback: { default: "Use at most {maxLength} characters." }
      },
      // A code the author added beyond those.
      { value: "pattern", label: "", meaning: "Text does not match the pattern" }
    ],
    newValue: "",
    newLabel: "",
    error: undefined,
    sourceId: undefined,
    suggestions: [
      {
        title: "Other codes",
        suggestions: [
          { value: "pattern", label: "Text does not match the pattern", parameters: ["pattern"] },
          { value: "taken", label: "Named by the page", parameters: [] }
        ],
        collapsed: true
      }
    ],
    maximized: false
  };

  it("is the options dialog with a code column, its meaning, a message column and no reordering", () => {
    const html = optionsEditorHtml(view);
    expect(html).toContain(
      '<dialog class="db-confirm db-options-editor" role="dialog" aria-labelledby="options-editor-title" data-options-dialog data-options-kind="messages" data-options-path="messages">'
    );
    expect(html).toContain("Validation messages — Email");
    expect(html).toContain('<th scope="col">Code</th><th scope="col">Meaning</th><th scope="col">Message</th>');
    // A raised code is the row's identity: named, not retyped; its meaning read-only beside it.
    expect(html).toContain('<tr data-options-row="0" data-option-code="required">');
    expect(html).toContain('<th scope="row" data-option-row="0" data-option-part="value"><code>required</code></th><td class="db-options-meaning" title="A required value is missing">A required value is missing</td>');
    // The same cell protocol as the options, so the panel's handlers serve both.
    expect(html).toContain('data-option-row="0" data-option-part="label" aria-label="required message" value="Enter your email."');
    // No language columns: the translations are Languages'.
    expect(html).not.toContain("data-option-locale");
    // A worded raised code can be cleared, never removed; an unworded one with a page wording
    // shows that wording greyed in its cells and offers to copy it in.
    expect(html).toContain('data-options-clear="0" aria-label="Clear message 1"');
    expect(html).not.toContain('data-options-remove="0"');
    expect(html).not.toContain('data-options-clear="1"');
    expect(html).not.toContain('data-options-remove="1"');
    expect(html).toContain('data-option-row="1" data-option-part="label" aria-label="maxLength message" value="" placeholder="Use at most {maxLength} characters."');
    expect(html).toContain('data-options-default="1" aria-label="Use the page&#39;s wording for message 2"');
    // No page wording, no placeholder and nothing to copy.
    expect(html).toContain('data-option-row="2" data-option-part="label" aria-label="pattern message" value="" />');
    expect(html).not.toContain('data-options-default="2"');
    // A code the author added keeps an editable code box and a Remove.
    expect(html).toContain('data-option-row="2" data-option-part="value" aria-label="Code of message 3" value="pattern"');
    expect(html).toContain('data-options-remove="2" aria-label="Remove message 3"');
    // A code map has no order worth editing.
    expect(html).not.toContain("data-options-move");
    expect(html).toContain("Add message");
    expect(html).toContain("details in braces, such as {minLength}");
    expect(html).toContain("a blank row keeps the page&#39;s or engine&#39;s wording");
  });

  it("draws the other codes as chips under the table, the taken ones disabled", () => {
    const html = optionsEditorHtml(view);
    expect(html).toContain('<div class="db-options-suggest" data-options-suggestions>');
    // A chip already in the table is shown but cannot be clicked; its hover text says why.
    expect(html).toContain(
      '<button type="button" class="db-options-chip" data-options-suggest="pattern" title="Text does not match the pattern. Details a message may quote: {pattern}. Already has a row." disabled>pattern</button>'
    );
    // A free one says what it means and what a click does.
    expect(html).toContain(
      '<button type="button" class="db-options-chip" data-options-suggest="taken" title="Named by the page. Click to put it in the code box.">taken</button>'
    );
    // The collapsed group is a disclosure counting what it holds.
    expect(html).toContain('<details class="db-options-suggest__more"><summary>Other codes (2)</summary>');
    // The chips stand in for an autocomplete list on the code box.
    expect(html).not.toContain("<datalist");
    expect(html).not.toContain(' list="');
  });

  it("says when a group has nothing to offer, and skips a silent empty one", () => {
    const html = optionsEditorHtml({
      ...view,
      suggestions: [
        { title: "This field can raise", suggestions: [], emptyText: "none — this field has no check of its own" },
        { title: "Named by the page", suggestions: [] }
      ]
    });
    expect(html).toContain('<span class="db-options-suggest__none">none — this field has no check of its own</span>');
    expect(html).not.toContain("Named by the page");
    // No groups at all, no block at all.
    expect(optionsEditorHtml({ ...view, suggestions: undefined })).not.toContain("data-options-suggestions");
  });

  it("says when there are no messages yet, and reports a problem", () => {
    const html = optionsEditorHtml({ ...view, rows: [], error: 'The message for "required" is empty.' });
    expect(html).toContain("No messages yet — add one below, or import a list.");
    expect(html).toContain('<p role="alert" class="db-options-error">The message for &quot;required&quot; is empty.</p>');
  });

  it("leaves the options dialog as it was when no kind is named", () => {
    const html = optionsEditorHtml({ ...view, kind: undefined, suggestions: undefined, path: "options", title: "Options — Answer" });
    expect(html).toContain('data-options-kind="options"');
    expect(html).toContain('<th scope="col">Key</th><th scope="col">Label</th>');
    expect(html).not.toContain("Meaning");
    expect(html).toContain('aria-label="Key of option 1"');
    expect(html).toContain('data-options-move="0:-1"');
    expect(html).toContain("Add option");
    expect(html).not.toContain("data-options-suggestions");
  });
});
