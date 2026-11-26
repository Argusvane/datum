// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { DATUM_STYLES } from "../form-engine/render/live/datum/css.js";
import type { DatumBindingOptions } from "../form-engine/render/live/datum/options.js";
import { markupOf, unmountAll } from "./live-datum-parts-kit.js";
import { readControlHints } from "../form-engine/core/schema/control-hints.js";
import {
  BUTTON_SIZE_OPTIONS,
  BUTTON_VARIANT_OPTIONS,
  readButtonSize,
  readButtonVariant
} from "../form-engine/core/schema/button.js";
import { readComponentClassNames } from "../form-engine/core/schema/component-classes.js";
import { sourceHash, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentNode } from "../form-engine/core/schema/types.js";

afterEach(unmountAll);

/**
 * The presentation properties a component can carry: button emphasis and size, author CSS
 * classes, authored HTML, and the constraint attributes (`pattern`, `min`/`max`, `rows`).
 */

async function bodyFor(
  children: ComponentNode[],
  locale = "en",
  options: DatumBindingOptions = {},
  translations?: FormTranslations,
  values: Record<string, unknown> = {}
): Promise<string> {
  return (await markupOf(children, { locale, binding: options, values, ...(translations ? { translations } : {}) })).html;
}

/** The `<input>` or `<textarea>` tag rendered for `id`, attributes and all. */
function controlTag(html: string, id: string): string {
  const match = html.match(new RegExp(`<(?:input|textarea)[^>]* id="${id}"[^>]*>`));
  if (!match) {
    throw new Error(`no control for ${id}`);
  }
  return match[0];
}

describe("button emphasis and size", () => {
  it("turns a variant and a size into classes the theme colours", async () => {
    const html = await bodyFor([
      { id: "go", type: "button", configuration: { label: "Go", variant: "danger", size: "lg" } }
    ]);
    expect(html).toContain(
      'class="datum-form__button datum-form__button--danger datum-form__button--lg"'
    );
  });

  it("leaves a plain button exactly as it was", async () => {
    const html = await bodyFor([{ id: "go", type: "button", configuration: { label: "Go" } }]);
    expect(html).toContain('class="datum-form__button"');
    // Medium is the default look, so it earns no class of its own.
    const medium = await bodyFor([
      { id: "go", type: "button", configuration: { label: "Go", size: "md" } }
    ]);
    expect(medium).toContain('class="datum-form__button"');
  });

  it("falls back to the default look for a variant it does not know", async () => {
    // An unknown class name would be a button no stylesheet defines — an invisible failure.
    expect(readButtonVariant({ variant: "chartreuse" })).toBeUndefined();
    expect(readButtonSize({ size: "enormous" })).toBeUndefined();
    const html = await bodyFor([
      { id: "go", type: "button", configuration: { label: "Go", variant: "chartreuse" } }
    ]);
    expect(html).toContain('class="datum-form__button"');
  });

  it("styles every variant and size it offers", () => {
    for (const option of BUTTON_VARIANT_OPTIONS) {
      expect(DATUM_STYLES).toContain(`.datum-form__button--${option.value}`);
    }
    for (const option of BUTTON_SIZE_OPTIONS.filter((size) => size.value !== "md")) {
      expect(DATUM_STYLES).toContain(`.datum-form__button--${option.value}`);
    }
  });
});

describe("author CSS classes", () => {
  it("keeps identifiers and drops anything that would need escaping", () => {
    expect(readComponentClassNames({ cssClass: "is-compact  print_only col-6" })).toEqual([
      "is-compact",
      "print_only",
      "col-6"
    ]);
    expect(readComponentClassNames({ cssClass: ["a", "a", "b"] })).toEqual(["a", "b"]);
    expect(readComponentClassNames({ cssClass: 'x" onload="y' })).toEqual([]);
    expect(readComponentClassNames({})).toEqual([]);
  });

  it("adds them to a field, a button and a layout container", async () => {
    const html = await bodyFor([
      { id: "name", type: "text", configuration: { label: "Name", cssClass: "wide" } },
      { id: "go", type: "button", configuration: { label: "Go", cssClass: "cta" } },
      {
        id: "cols",
        type: "grid",
        configuration: { columns: 2, cssClass: "tight" },
        children: { column_1: [{ id: "a", type: "text", configuration: { label: "A" } }] }
      }
    ]);
    expect(html).toContain('class="datum-live-field wide"');
    expect(html).toContain('class="datum-live-field cta"');
    expect(html).toContain('datum-form__layout--grid tight"');
  });

  it("puts a stack container's classes on its layout, inside the element that carries its id", async () => {
    const classed = await bodyFor([
      {
        id: "group",
        type: "fieldset",
        configuration: { cssClass: "boxed" },
        children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] }
      }
    ]);
    expect(classed).toMatch(/data-container-id="group"[^>]*><div class="[^"]*\bboxed\b[^"]*"/);
  });

  it("adds them to a container that draws its own shell", async () => {
    const html = await bodyFor([
      {
        id: "card",
        type: "panel",
        configuration: { label: "Card", cssClass: "highlight" },
        children: { content: [{ id: "a", type: "text", configuration: { label: "A" } }] }
      }
    ]);
    expect(html).toContain('class="datum-form__panel highlight"');
  });
});

describe("the html component", () => {
  it("renders sanitized content inside the configured tag", async () => {
    const html = await bodyFor([
      {
        id: "notice",
        type: "html",
        configuration: {
          tag: "section",
          content: '<p>Read the <a href="/terms">terms</a>.</p><script>alert(1)</script>'
        }
      }
    ]);
    expect(html).toMatch(/<section class="datum-form__html">/);
    expect(html).toContain('<p>Read the <a href="/terms">terms</a>.</p>');
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(1)");
    // No field scaffolding: it holds no value, so it has no label, no input and no error slot.
    expect(html).not.toContain('class="datum-form__field"');
  });

  it("localizes its content like every other authored string", async () => {
    const node: ComponentNode = {
      id: "notice",
      type: "html",
      configuration: {
        content: "<p>Hello</p>"
      }
    };
    const translations: FormTranslations = {
      "fr-CA": { components: { notice: { content: { text: "<p>Bonjour</p>", source: sourceHash("<p>Hello</p>") } } } }
    };
    expect(await bodyFor([node], "fr-CA", {}, translations)).toContain("<p>Bonjour</p>");
    expect(await bodyFor([node])).toContain("<p>Hello</p>");
  });
});

describe("constraint attributes on the control", () => {
  it("hints a pattern to the browser when it compiles", async () => {
    const html = await bodyFor([
      { id: "code", type: "text", configuration: { label: "Code", pattern: "[A-Z]{3}" } }
    ]);
    expect(html).toContain('pattern="[A-Z]{3}"');
  });

  it("omits a pattern the browser could not use", async () => {
    // An uncompilable expression makes a browser treat the field as never valid, so the hint
    // is dropped; the validation stage skips it for the same reason.
    const html = await bodyFor([
      { id: "code", type: "text", configuration: { label: "Code", pattern: "[unclosed" } }
    ]);
    expect(html).not.toContain("pattern=");

    // And it is only offered where the browser honours it: a date box constrains its own
    // shape, and a stray pattern attribute there would do nothing.
    const date = await bodyFor([
      { id: "when", type: "date", configuration: { label: "When", pattern: "[A-Z]{3}" } }
    ]);
    expect(date).not.toContain("pattern=");
  });

  it("shows a read-only textarea in full rather than behind a scrollbar", async () => {
    const value = "line one\nline two\nline three\nline four\nline five\nline six";
    const html = await bodyFor([{ id: "notes", type: "textarea", configuration: { label: "Notes", rows: 2, readOnly: true } }], "en", {}, undefined, { notes: value });

    // The authored rows are a starting height for *entering* an answer. Displaying one, the
    // box is sized to the value instead — six lines, not the two it would be edited in.
    expect(html).toContain('rows="6"');
    expect(html).toContain("readonly");
    // And the styles let it grow: no scrollbar, no resize grip, no minimum height. Scoped
    // past `.datum-form__control--textarea`, which sets a 72px floor and vertical resizing.
    expect(DATUM_STYLES).toContain(".datum-form .datum-form__control--textarea[readonly]");
    expect(DATUM_STYLES).toMatch(/textarea\[readonly\]\s*\{[^}]*overflow:\s*hidden/);
    expect(DATUM_STYLES).toMatch(/textarea\[readonly\]\s*\{[^}]*min-height:\s*0/);
  });

  it("bounds a number, and gives a textarea its rows", async () => {
    const html = await bodyFor(
      [
        { id: "count", type: "number", configuration: { label: "Count", min: 1, max: 10 } },
        { id: "notes", type: "textarea", configuration: { label: "Notes", rows: 8 } },
        { id: "name", type: "text", configuration: { label: "Name" } }
      ],
      "en",
      { controls: { number: "number" } }
    );
    expect(html).toContain('min="1"');
    expect(html).toContain('max="10"');
    expect(html).toContain('rows="8"');
    // A text field has no range to bound, so it gets no stray attributes.
    expect((html.match(/min=/g) ?? []).length).toBe(1);
  });
});

describe("browser hints on the control", () => {
  it("writes autocomplete, inputmode and spellcheck out as authored, on the controls a person types into", async () => {
    const html = await bodyFor([
      {
        id: "email",
        type: "text",
        configuration: { label: "Email", autocomplete: "email", inputmode: "email", spellcheck: false }
      },
      { id: "notes", type: "textarea", configuration: { label: "Notes", spellcheck: "true" } },
      // The inspector's select stores the strings; a pick from the same vocabulary.
      { id: "ref", type: "text", configuration: { label: "Reference", inputmode: "numeric", spellcheck: "false" } },
      // Nowhere to type: no keyboard to choose, nothing to fill in.
      { id: "agree", type: "checkbox", configuration: { label: "Agree", autocomplete: "off", inputmode: "text" } },
      { id: "pick", type: "select", configuration: { label: "Pick", autocomplete: "off", options: [{ value: "a", label: "A" }] } }
    ]);
    expect(controlTag(html, "email")).toContain(' autocomplete="email" inputmode="email" spellcheck="false"');
    expect(controlTag(html, "notes")).toContain(' spellcheck="true"');
    expect(controlTag(html, "ref")).toContain(' inputmode="numeric" spellcheck="false"');
    expect(controlTag(html, "agree")).not.toMatch(/autocomplete|inputmode/);
    expect(html).not.toMatch(/<select[^>]*autocomplete/);
  });

  it("drops a hint the browser could not use", () => {
    expect(readControlHints({ autocomplete: "  section-blue   shipping postal-code " })).toEqual({
      autocomplete: "section-blue shipping postal-code"
    });
    // Not an attribute value: a quote, a keyword the spec does not have, a stray type.
    expect(readControlHints({ autocomplete: 'x" onfocus="alert(1)', inputmode: "keypad", spellcheck: "maybe" })).toEqual({});
    expect(readControlHints({ autocomplete: 42, inputmode: 7, spellcheck: 1 })).toEqual({});
    expect(readControlHints({ inputmode: " Decimal " })).toEqual({ inputMode: "decimal" });
    expect(readControlHints(undefined)).toEqual({});
    expect(readControlHints([])).toEqual({});
  });

  it("draws a number as a text box with a number keyboard when the binding asks (controls.number)", async () => {
    const fields: ComponentNode[] = [
      { id: "count", type: "number", configuration: { label: "Count", min: 1, max: 10 } },
      { id: "whole", type: "number", configuration: { label: "Whole", step: 1 } },
      { id: "typed", type: "number", configuration: { label: "Typed", inputmode: "tel" } }
    ];
    const asText = await bodyFor(fields, "en", { controls: { number: "text" } });
    const count = controlTag(asText, "count");
    // A text box: no spinner, no bounds attribute (a text input has none), a decimal keyboard.
    expect(count).toContain(' type="text"');
    expect(count).toContain(' inputmode="decimal"');
    expect(count).not.toMatch(/ min=| max=/);
    // The class still names what it holds, for the theme's rules and the element's parsing.
    expect(count).toContain('class="datum-form__control datum-form__control--number datum-form__control--box"');
    // A whole-number step asks for digits alone; an author's own keyboard wins over both.
    expect(controlTag(asText, "whole")).toContain(' inputmode="numeric"');
    expect(controlTag(asText, "typed")).toContain(' inputmode="tel"');
    expect(controlTag(asText, "typed")).not.toContain("decimal");

    // Digits are not words: a number drawn as text turns spellcheck off for every theme, and an
    // author's own value still wins.
    expect(count).toContain(' spellcheck="false"');
    expect(controlTag(asText, "whole")).toContain(' spellcheck="false"');
    const spelled = await bodyFor(
      [{ id: "odd", type: "number", configuration: { label: "Odd", spellcheck: true } }],
      "en",
      { controls: { number: "text" } }
    );
    expect(controlTag(spelled, "odd")).toContain(' spellcheck="true"');

    // Datum's default and an unknown choice are the text box as well; `number` is the browser's box, bounds and all, no keyboard hint.
    for (const controls of [undefined, {}, { number: "spinner" as unknown as "number" }]) {
      const byDefault = await bodyFor(fields, "en", controls === undefined ? {} : { controls });
      expect(controlTag(byDefault, "count")).toContain(' type="text"');
    }
    const asNumber = await bodyFor(fields, "en", { controls: { number: "number" } });
    expect(controlTag(asNumber, "count")).toContain(' type="number"');
    expect(controlTag(asNumber, "count")).toMatch(/ min="1"/);
    expect(controlTag(asNumber, "count")).toMatch(/ max="10"/);
    expect(controlTag(asNumber, "count")).not.toContain("inputmode");
    expect(controlTag(asNumber, "count")).not.toContain("spellcheck");
  });
});
