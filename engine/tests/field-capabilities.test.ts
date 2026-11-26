// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import {
  affixCapability,
  autocompleteCapability,
  cssClassCapability,
  disabledCapability,
  inputModeCapability,
  hideLabelCapability,
  lengthCapability,
  patternCapability,
  pdfAttachmentsCapability,
  pdfOptionsCapability,
  placeholderCapability,
  rowsCapability,
  standardFieldCapabilities,
  tooltipCapability,
  FIELD_CAPABILITIES
} from "../form-engine/registry/capabilities/field-capabilities.js";
import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";

afterEach(unmountAll);

function fieldPaths(node: ComponentNode, capabilities = standardFieldCapabilities()): string[] {
  const model = buildInspectorModel(node, capabilities);
  return model.sections.flatMap((section) => section.fields.map((field) => field.propertyPath));
}

describe("field capabilities", () => {
  const text: ComponentNode = { id: "name", type: "text", configuration: { label: "Name" } };

  it("composes the inspector from what the type declares", () => {
    // Grouped order: content (label…tooltip), then data, validation, behavior, presentation,
    // how it prints (On paper), PDF.
    expect(fieldPaths(text)).toEqual([
      "label",
      "description",
      "placeholder",
      "tooltip",
      "dataKey",
      "hiddenValueBehavior",
      "required",
      "messages",
      "disabled",
      "hideLabel",
      "cssClass",
      "print.on",
      "print.breakBefore",
      "print.show",
      "print.note",
      "pdf.rendition",
      "pdf.exclude"
    ]);
    expect(fieldPaths(text, standardFieldCapabilities({ pdf: false }))).not.toContain("pdf.rendition");
    expect(fieldPaths(text, standardFieldCapabilities({ print: false }))).not.toContain("print.show");
  });

  it("offers every value-bearing field its own validation messages, after its constraints", () => {
    const paths = fieldPaths(text, standardFieldCapabilities({ length: true, pattern: true }));
    // With the constraints, last: what they say when they fail.
    expect(paths.indexOf("pattern")).toBeLessThan(paths.indexOf("messages"));
    const model = buildInspectorModel(text, standardFieldCapabilities({ length: true }));
    const validation = model.sections.find((section) => section.id === "validation");
    expect(validation?.fields.map((f) => f.propertyPath)).toEqual(["required", "minLength", "maxLength", "characterCount", "messages"]);
    expect(validation?.fields.find((f) => f.propertyPath === "messages")?.control).toBe("messages");
    // A type with no value to check opts out.
    expect(fieldPaths(text, standardFieldCapabilities({ messages: false }))).not.toContain("messages");
    expect(FIELD_CAPABILITIES.get("messages")?.id).toBe("messages");
  });

  it("offers each type the PDF renditions of its kind, under a PDF section", () => {
    const choicesFor = (node: ComponentNode) =>
      buildInspectorModel(node, [pdfOptionsCapability])
        .sections.find((section) => section.id === "pdf")
        ?.fields.find((field) => field.propertyPath === "pdf.rendition")
        ?.choices.map((choice) => choice.value);
    expect(choicesFor(text)).toEqual(["", "text", "field", "ruled"]);
    expect(choicesFor({ id: "c", type: "checkbox", configuration: {} })).toEqual(["", "checkmark", "field", "text"]);
    // A type the engine does not know: a leaf prints like text, a container like a group.
    expect(choicesFor({ id: "r", type: "rating", configuration: {} })).toEqual(["", "text", "field", "ruled"]);
    expect(choicesFor({ id: "p", type: "custom-panel", configuration: {}, children: { content: [] } })).toEqual(["", "group", "section"]);
    // A collection prints as rows, whatever its type says.
    expect(
      choicesFor({ id: "items", type: "panel", configuration: {}, collection: { collectionPath: "items", itemFields: [] }, children: { content: [] } })
    ).toEqual(["", "table", "sections"]);
    const model = buildInspectorModel(text, [pdfOptionsCapability]);
    expect(model.sections.map((section) => section.title)).toEqual(["PDF"]);
    expect(model.sections[0]?.fields.map((field) => field.propertyPath)).toEqual(["pdf.rendition", "pdf.exclude"]);
  });

  it("offers the attach-uploads switch only where a type asks for it, under the PDF section", () => {
    expect(fieldPaths(text)).not.toContain("pdf.attach");
    const file: ComponentNode = { id: "doc", type: "file", configuration: {} };
    const model = buildInspectorModel(file, standardFieldCapabilities({ placeholder: false, attachFiles: true }));
    const pdf = model.sections.find((section) => section.id === "pdf");
    expect(pdf?.fields.map((field) => field.propertyPath)).toEqual(["pdf.rendition", "pdf.exclude", "pdf.attach"]);
    expect(pdf?.fields.find((field) => field.propertyPath === "pdf.attach")?.control).toBe("checkbox");
    expect(FIELD_CAPABILITIES.get("pdf-attach")).toBe(pdfAttachmentsCapability);
  });

  it("offers rows only to a control that has them", () => {
    // A single-line input has no rows; offering the editor there would author a property the
    // markup then ignores.
    expect(fieldPaths(text)).not.toContain("rows");
    const multiline = fieldPaths(text, standardFieldCapabilities({ rows: true }));
    expect(multiline).toContain("rows");
    // Placed with the other properties of the box itself, before how it behaves.
    expect(multiline.indexOf("rows")).toBeLessThan(multiline.indexOf("required"));
  });

  it("offers a pattern only where a type asks for one", () => {
    // Opt-in: a regular expression means nothing for a checkbox or a date picker, so the
    // standard set leaves it out until a type says it types free text.
    expect(fieldPaths(text)).not.toContain("pattern");
    const withPattern = fieldPaths(text, standardFieldCapabilities({ pattern: true }));
    expect(withPattern).toContain("pattern");
    // The message travels with it — "pattern" as the error text tells a filler nothing.
    expect(withPattern).toContain("patternMessage");
  });

  it("offers length limits only where a type asks for them, ahead of the pattern", () => {
    expect(fieldPaths(text)).not.toContain("minLength");
    const limited = fieldPaths(text, standardFieldCapabilities({ length: true, pattern: true }));
    expect(limited).toContain("minLength");
    expect(limited).toContain("maxLength");
    // Sectioned under Validation with required and pattern: the simple bound, then the expression.
    expect(limited.indexOf("required")).toBeLessThan(limited.indexOf("minLength"));
    expect(limited.indexOf("maxLength")).toBeLessThan(limited.indexOf("pattern"));
    const model = buildInspectorModel(text, standardFieldCapabilities({ length: true, messages: false }));
    expect(
      model.sections.find((section) => section.id === "validation")?.fields.map((f) => f.propertyPath)
    ).toEqual(["required", "minLength", "maxLength", "characterCount"]);
    expect(model.sections.find((section) => section.id === "validation")?.fields.find((f) => f.propertyPath === "characterCount")?.control).toBe("checkbox");
  });

  it("offers the prefix and suffix only where a type asks, under Content beside the placeholder", () => {
    expect(fieldPaths(text)).not.toContain("prefix");
    const flanked = fieldPaths(text, standardFieldCapabilities({ affix: true }));
    expect(flanked.indexOf("placeholder")).toBeLessThan(flanked.indexOf("prefix"));
    expect(flanked.indexOf("prefix")).toBeLessThan(flanked.indexOf("suffix"));
    expect(flanked.indexOf("suffix")).toBeLessThan(flanked.indexOf("tooltip"));
    const model = buildInspectorModel(text, standardFieldCapabilities({ affix: true }));
    const content = model.sections.find((section) => section.id === "content");
    expect(content?.fields.map((f) => f.propertyPath)).toContain("prefix");
    expect(content?.fields.map((f) => f.propertyPath)).toContain("suffix");
    expect(FIELD_CAPABILITIES.get("affix")).toBe(affixCapability);
  });

  it("offers the browser hints only where a type asks, under Behavior after disabled", () => {
    // Off by default: a select or a checkbox raises no keyboard and takes no autocomplete.
    expect(fieldPaths(text)).not.toContain("autocomplete");
    expect(fieldPaths(text)).not.toContain("inputmode");
    const hinted = buildInspectorModel(text, standardFieldCapabilities({ autocomplete: true, inputMode: true }));
    const behavior = hinted.sections.find((section) => section.id === "behavior");
    expect(behavior?.fields.map((field) => field.propertyPath)).toEqual([
      "disabled",
      "autocomplete",
      "inputmode",
      "spellcheck"
    ]);
    // The keyboard is a pick from the attribute's own values; blank leaves the browser's default.
    const keyboard = behavior?.fields.find((field) => field.propertyPath === "inputmode");
    expect(keyboard?.control).toBe("select");
    expect(keyboard?.choices.map((choice) => choice.value)).toEqual([
      "",
      "numeric",
      "decimal",
      "tel",
      "email",
      "url",
      "search",
      "text",
      "none"
    ]);
    expect(behavior?.fields.find((field) => field.propertyPath === "spellcheck")?.choices.map((c) => c.value)).toEqual([
      "",
      "false",
      "true"
    ]);
    // A date takes `bday` but has no keyboard to choose: the two are separate capabilities.
    const dated = fieldPaths(text, standardFieldCapabilities({ autocomplete: true }));
    expect(dated).toContain("autocomplete");
    expect(dated).not.toContain("inputmode");
    expect(FIELD_CAPABILITIES.get("autocomplete")).toBe(autocompleteCapability);
    expect(FIELD_CAPABILITIES.get("inputMode")).toBe(inputModeCapability);
  });

  it("leaves out what a type has no room for", () => {
    // A checkbox has nowhere to put ghost text; a button holds no value to require.
    expect(fieldPaths(text, standardFieldCapabilities({ placeholder: false }))).not.toContain(
      "placeholder"
    );
    expect(fieldPaths(text, standardFieldCapabilities({ required: false }))).not.toContain(
      "required"
    );
    // Nor a place in the data to name — unless the type says it has one.
    expect(fieldPaths(text, standardFieldCapabilities({ required: false }))).not.toContain("dataKey");
    expect(fieldPaths(text, standardFieldCapabilities({ required: false, dataKey: true }))).toContain("dataKey");
  });

  it("still falls back to the engine's defaults for a type declaring none", () => {
    // Every existing component definition passes `capabilities: []`, and must keep working.
    expect(fieldPaths(text, [])).toEqual(["label", "description", "dataKey", "hiddenValueBehavior", "required"]);
  });

  it("composes with a component's own editor in extend mode", () => {
    const model = buildInspectorModel(text, standardFieldCapabilities({ placeholder: false }), {
      mode: "extend",
      fields: [{ id: "max", type: "number", propertyPath: "max", label: "Stars" }]
    });
    const paths = model.sections.flatMap((section) =>
      section.fields.map((field) => field.propertyPath)
    );
    expect(paths).toContain("tooltip");
    // The component's own field lands in its Settings section, not lost among the defaults.
    expect(
      model.sections.find((section) => section.id === "settings")?.fields.map((f) => f.propertyPath)
    ).toEqual(["max"]);
  });

  it("writes its configuration onto a component without disturbing the rest", () => {
    const applied = tooltipCapability.apply(text, { tooltip: "Your legal name" });
    expect(applied.configuration).toEqual({ label: "Name", tooltip: "Your legal name" });
    // Nothing to merge leaves the node alone rather than clearing its configuration.
    expect(disabledCapability.apply(text, undefined).configuration).toEqual({ label: "Name" });
  });

  it("exposes each capability by id", () => {
    expect(FIELD_CAPABILITIES.get("placeholder")).toBe(placeholderCapability);
    expect(FIELD_CAPABILITIES.get("hideLabel")).toBe(hideLabelCapability);
    expect(FIELD_CAPABILITIES.get("pattern")).toBe(patternCapability);
    expect(FIELD_CAPABILITIES.get("length")).toBe(lengthCapability);
    expect(FIELD_CAPABILITIES.get("cssClass")).toBe(cssClassCapability);
    expect(FIELD_CAPABILITIES.get("rows")).toBe(rowsCapability);
    expect(FIELD_CAPABILITIES.get("pdf")).toBe(pdfOptionsCapability);
  });
});

describe("field capabilities in the rendered markup", () => {
  async function html(configuration: Record<string, unknown>, type = "text", value?: unknown): Promise<string> {
    const drawn = await markupOf([{ id: "name", type, configuration }], { ...(value !== undefined ? { values: { name: value } } : {}) });
    return drawn.html;
  }

  it("puts a placeholder in the box", async () => {
    expect(await html({ label: "Name", placeholder: "Jane Doe" })).toContain('placeholder="Jane Doe"');
  });

  it("uses a select's placeholder as its empty option", async () => {
    const markup = await html({ label: "Country", placeholder: "Pick one…" }, "select");
    expect(markup).toContain(">Pick one…</option>");
    expect(markup).not.toContain(">Select…</option>");
  });

  it("gives a checkbox no placeholder attribute, having nowhere to put it", async () => {
    expect(await html({ label: "Agree", placeholder: "ignored" }, "checkbox")).not.toContain(
      "placeholder="
    );
  });

  it("puts a tooltip on the control and marks it beside the label", async () => {
    const markup = await html({ label: "Name", tooltip: "As on your ID" });
    // The control is described by the bubble, not given a `title`.
    expect(markup).toContain('aria-describedby="name__tooltip"');
    expect(markup).not.toContain("title=");
    expect(markup).toContain('class="datum-form__tooltip"');
  });

  it("hides a label visually while keeping it as the accessible name", async () => {
    const markup = await html({ label: "Name", hideLabel: true });
    expect(markup).toContain('class="datum-form__label datum-form__visually-hidden"');
    // Still present, still the label the control is `for`.
    expect(markup).toContain(">Name<");
    expect(markup).toContain('<label class="datum-form__field datum-form__field--text" for="name">');
  });

  it("hints a minimum length to the browser on free-text controls only, and never writes maxlength", async () => {
    // The browser counts maxlength in UTF-16 code units and stops the typing there, so an answer
    // of emoji would be cut at half the limit the check (code points) allows: the check and the
    // count own the maximum.
    const name = await html({ label: "Name", minLength: 2, maxLength: 10 });
    expect(name).toContain('minlength="2"');
    expect(name).not.toContain("maxlength=");
    expect(await html({ label: "Bio", maxLength: 300 }, "textarea")).not.toContain("maxlength=");
    // A number input has no character count to bound, and limits no value could meet hint
    // nothing — the stage ignores them too, so the browser must not enforce what it will not.
    expect(await html({ label: "Age", maxLength: 3 }, "number")).not.toContain("maxlength=");
    expect(await html({ label: "Name", minLength: 9, maxLength: 2 })).not.toContain("length=");
  });

  it("counts an answer's characters in code points, as the check does, with no maxlength to cut it at code units", async () => {
    // Three emoji are six UTF-16 code units: within a limit of 4 for the check and the count.
    const counted = await html({ label: "Mood", maxLength: 4, characterCount: true }, "text", "\u{1F600}\u{1F600}\u{1F600}");
    expect(counted).toContain('<span class="datum-form__count-status" aria-hidden="true">1 character left</span>');
    expect(counted).not.toContain("maxlength=");
    expect(await html({ label: "Mood", maxLength: 4 }, "text", "\u{1F600}\u{1F600}\u{1F600}")).not.toContain("maxlength=");
  });

  it("counts the characters under a counted control, describing the limit to it, and leaves maxlength off", async () => {
    const markup = await html({ label: "Bio", description: "Briefly.", maxLength: 20, characterCount: true }, "textarea");
    expect(markup).not.toContain("maxlength=");
    expect(markup).toContain('aria-describedby="name__description name__count"');
    // Empty: the limit sentence hidden for the description, the whole limit left as the count.
    expect(markup).toContain(
      '</textarea><span class="datum-form__count" data-count-for="name"><span class="datum-form__visually-hidden" id="name__count">You can enter up to 20 characters</span><span class="datum-form__count-status" aria-hidden="true">20 characters left</span></span>'
    );
    expect(markup).not.toContain("datum-form__count--over");
    expect(markup).not.toContain("datum-form__field--over-limit");
    // No count without the flag, and none without a maximum; never on a number.
    expect(await html({ label: "Bio", maxLength: 20 }, "textarea")).not.toContain("datum-form__count");
    expect(await html({ label: "Bio", characterCount: true }, "textarea")).not.toContain("datum-form__count");
    expect(await html({ label: "Age", maxLength: 3, characterCount: true }, "number")).not.toContain("datum-form__count");
    expect(await html({ label: "Age", maxLength: 3, characterCount: true }, "number")).not.toContain("maxlength=");
  });

  it("flanks a single-line box with its prefix and suffix, decorative, and leaves every other control alone", async () => {
    const both = await html({ label: "Price", prefix: "£", suffix: "per item" });
    expect(both).toContain('<span class="datum-form__control-group"><span aria-hidden="true" class="datum-form__affix datum-form__affix--prefix">£</span><input type="text" id="name"');
    expect(both).toContain('><span aria-hidden="true" class="datum-form__affix datum-form__affix--suffix">per item</span></span>');
    const suffixOnly = await html({ label: "Weight", suffix: "kg" }, "number");
    expect(suffixOnly).not.toContain("datum-form__affix--prefix");
    expect(suffixOnly).toContain('inputmode="decimal"');
    expect(suffixOnly).toContain('datum-form__affix--suffix">kg</span></span>');
    // Escaped like everything.
    const localized = await html({ label: "Cost", prefix: "$", suffix: "<b>" });
    expect(localized).toContain('datum-form__affix--prefix">$</span>');
    expect(localized).toContain('datum-form__affix--suffix">&lt;b&gt;</span>');
    // The count still follows the group.
    const counted = await html({ label: "Code", prefix: "#", maxLength: 4, characterCount: true });
    expect(counted).toMatch(/><\/span><span class="datum-form__count" data-count-for="name">/);
    // No group without an affix, and none on the controls that have no box to flank.
    expect(await html({ label: "Name" })).not.toContain("datum-form__control-group");
    expect(await html({ label: "Bio", prefix: "x" }, "textarea")).not.toContain("datum-form__affix");
    expect(await html({ label: "When", suffix: "x" }, "date")).not.toContain("datum-form__affix");
    expect(await html({ label: "Pick", prefix: "x" }, "select")).not.toContain("datum-form__affix");
    expect(await html({ label: "Agree", prefix: "x" }, "checkbox")).not.toContain("datum-form__affix");
  });

  it("disables the control from configuration alone, no rule needed", async () => {
    const markup = await html({ label: "Name", disabled: true });
    expect(markup).toMatch(/<input[^>]*\sdisabled/);
  });

  it("resolves a localized tooltip and placeholder like every other string", async () => {
    const root: ComponentNode = {
      id: "root",
      type: "form",
      configuration: {},
      children: {
        content: [
          {
            id: "name",
            type: "text",
            configuration: {
              label: "Name",
              tooltip: "As on your ID",
              placeholder: "Jane Doe",
              prefix: "$",
              suffix: "each"
            }
          }
        ]
      }
    };
    // The French lives in the definition's map, by the component's id and the property.
    const translations: FormTranslations = {
      "fr-CA": {
        components: {
          name: {
            tooltip: { text: "Comme sur votre pièce", source: sourceHash("As on your ID") },
            placeholder: { text: "Jeanne Tremblay", source: sourceHash("Jane Doe") },
            prefix: { text: "€", source: sourceHash("$") },
            suffix: { text: "chacun", source: sourceHash("each") }
          }
        }
      }
    };
    const markup = (await markupOf(root, { locale: "fr-CA", translations })).html;
    expect(markup).toContain('placeholder="Jeanne Tremblay"');
    expect(markup).toContain("Comme sur votre pièce");
    expect(markup).toContain('datum-form__affix--prefix">€</span>');
    expect(markup).toContain('datum-form__affix--suffix">chacun</span>');
  });
});
