import { afterEach, describe, expect, it } from "vitest";

import type { ComponentDefinition } from "@argusvane/datum-engine";

import { until } from "./helpers.js";
import { formOf, idsOf, keystroke, mountBuilder, pick, previewOf, propsOf, textNode, toolbarOf } from "./builder-ported-fixture.js";

/*
 * What the inspector composes and writes for the standard components: ported from the retired
 * demo app's builder and canvas tests so the builder's own suites keep them.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const tab = (element: Awaited<ReturnType<typeof mountBuilder>>, id: "properties" | "style" | "rules"): void =>
  propsOf(element).querySelector<HTMLButtonElement>(`[data-inspector-tab="${id}"]`)!.click();

/** The distinct `data-prop` paths on the tab the inspector shows, in order. */
const pathsOf = (element: Awaited<ReturnType<typeof mountBuilder>>): Array<string | undefined> =>
  [...propsOf(element).querySelectorAll<HTMLElement>("[data-prop]")]
    .map((node) => node.dataset.prop)
    .filter((value, index, all) => all.indexOf(value) === index);

const save = (element: Awaited<ReturnType<typeof mountBuilder>>): void => {
  propsOf(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
};

async function selected(element: Awaited<ReturnType<typeof mountBuilder>>, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => propsOf(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

describe("the inspector composed from what each standard type declares", () => {
  it("lists a text field's paths in order, its Style tab apart, and a checkbox without the placeholder and pattern it has no room for", async () => {
    const element = await mountBuilder(
      formOf([textNode("name", "Name"), { id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } }])
    );
    await selected(element, "name");
    // Grouped by the inspector's sections: content, then data, validation, behavior, then how it prints.
    expect(pathsOf(element)).toEqual([
      "id",
      "label",
      "description",
      "placeholder",
      // What flanks the box, beside the placeholder.
      "prefix",
      "suffix",
      "tooltip",
      // Where the answer is stored.
      "dataKey",
      // What the submitted data holds for the answer while a rule hides it.
      "hiddenValueBehavior",
      "required",
      "minLength",
      "maxLength",
      // The count against the maximum.
      "characterCount",
      // The Format box: the explicit Email preset writes the pattern, never the keyboard hint.
      "patternPreset",
      "pattern",
      "patternMessage",
      "disabled",
      // The browser hints a text box takes: what to fill it with, which keyboard, spell-check.
      "autocomplete",
      "inputmode",
      "spellcheck",
      // How it prints from the live form closes the Field tab.
      "print.on",
      "print.breakBefore",
      "print.show",
      "print.note"
    ]);
    // How it looks is on the Style tab: presentation, then its PDF appearance.
    tab(element, "style");
    expect(pathsOf(element)).toEqual(["hideLabel", "cssClass", "pdf.rendition", "pdf.exclude"]);

    // A checkbox has nowhere to put ghost text, and nothing for a regular expression to match.
    tab(element, "properties");
    await selected(element, "subscribe");
    expect(pathsOf(element)).toContain("label");
    expect(pathsOf(element)).not.toContain("placeholder");
    expect(pathsOf(element)).not.toContain("pattern");
    // The escape hatch is on every field, though: a class is useful wherever an element is.
    tab(element, "style");
    expect(pathsOf(element)).toContain("hideLabel");
    expect(pathsOf(element)).toContain("cssClass");
  });

  it("offers a file upload its storage, limits and multiplicity, and its PDF attachment switch on the Style tab", async () => {
    const element = await mountBuilder(formOf([]));
    // Filed with the typed fields, under the engine's file glyph.
    const item = toolbarOf(element).querySelector<HTMLButtonElement>('[data-add-type="file"]')!;
    expect(item.closest(".palette-group")?.getAttribute("data-palette-group")).toBe("Fields");
    expect(item.querySelector("svg.palette-icon")).toBeTruthy();
    item.click();
    await until(() => propsOf(element).querySelector('select[data-prop="storage"]'));

    // The canvas previews the real control, so the author sees the picker they are configuring.
    await until(() => previewOf(element)!.querySelector('input[type="file"]'));

    const props = propsOf(element);
    const storage = props.querySelector<HTMLSelectElement>('select[data-prop="storage"]')!;
    expect([...storage.options].map((option) => option.value)).toEqual(["base64"]);
    expect(storage.value).toBe("base64");
    expect(props.querySelector('input[data-prop="multiple"]')).toBeTruthy();
    expect(props.querySelector('input[data-prop="accept"]')).toBeTruthy();
    expect(props.querySelector('input[data-prop="maxFileSizeMb"]')).toBeTruthy();
    // Nothing a file has no use for: no placeholder, no pattern, no length.
    expect(props.querySelector('input[data-prop="placeholder"]')).toBeNull();
    expect(props.querySelector('input[data-prop="pattern"]')).toBeNull();
    expect(props.querySelector('input[data-prop="maxLength"]')).toBeNull();

    // The one switch only a file has: its uploads as PDF attachments, filed under PDF, on the Style tab.
    tab(element, "style");
    const attach = propsOf(element).querySelector<HTMLInputElement>('input[data-prop="pdf.attach"]')!;
    expect(attach.type).toBe("checkbox");
    expect(attach.closest("[data-inspector-section]")?.getAttribute("data-inspector-section")).toBe("pdf");
    tab(element, "properties");

    keystroke(propsOf(element).querySelector<HTMLInputElement>('input[data-prop="accept"]')!, ".pdf, image/*");
    // The panel repaints on every draft edit: the box is found again, on Style, before it is ticked.
    tab(element, "style");
    const again = propsOf(element).querySelector<HTMLInputElement>('input[data-prop="pdf.attach"]')!;
    again.checked = true;
    again.dispatchEvent(new Event("input", { bubbles: true }));
    save(element);
    expect(element.builder!.controller.selectedNode()!.configuration).toMatchObject({ storage: "base64", accept: ".pdf, image/*", pdf: { attach: true } });
    // The picker's hint follows the saved limit, normalized the way the check reads it.
    await until(() => previewOf(element)!.querySelector('input[type="file"]')?.getAttribute("accept") === ".pdf,image/*");
  });

  it("marks a fieldset's legend required or optional from its inspector, and clears the mark again", async () => {
    const element = await mountBuilder(
      formOf([{ id: "newsletter", type: "fieldset", configuration: { label: "Newsletter" }, children: { content: [{ id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } }] } }])
    );
    const legend = (): HTMLElement | null => previewOf(element)!.querySelector<HTMLElement>("#newsletter__group-label");
    const plain = legend()?.textContent;
    expect(plain).toBe("Newsletter");

    await selected(element, "newsletter");
    const select = (): HTMLSelectElement | null => propsOf(element).querySelector<HTMLSelectElement>('select[data-prop="legendMark"]');
    expect(select()).toBeTruthy();
    expect([...select()!.options].map((option) => option.value)).toEqual(["", "required", "optional"]);

    pick(select()!, "required");
    save(element);
    await until(() => legend()?.textContent !== plain);
    // Presentational only: the group is still named by its legend, and nothing inside became required.
    expect(legend()?.textContent).toContain("Newsletter");
    expect(element.builder!.controller.selectedNode()!.configuration).toMatchObject({ legendMark: "required" });
    const inner = element.builder!.controller.snapshot().children!.content![0]!.children!.content![0]!;
    expect((inner.configuration as { required?: unknown }).required).toBeUndefined();

    pick(select()!, "optional");
    save(element);
    await until(() => legend()?.textContent !== plain && !/required/i.test(legend()?.textContent ?? ""));
    expect(element.builder!.controller.selectedNode()!.configuration).toMatchObject({ legendMark: "optional" });

    pick(select()!, "");
    save(element);
    await until(() => legend()?.textContent === plain);
    // The mark is written as empty, not left as "required" or "optional".
    expect([undefined, ""]).toContain((element.builder!.controller.selectedNode()!.configuration as { legendMark?: unknown }).legendMark);
  });

  it("hides a fieldset's label from sight on request, keeping it as the group's accessible name", async () => {
    const element = await mountBuilder(
      formOf([{ id: "newsletter", type: "fieldset", configuration: { label: "Newsletter" }, children: { content: [{ id: "subscribe", type: "checkbox", configuration: { label: "Subscribe" } }] } }])
    );
    const heading = (): HTMLElement | null => previewOf(element)!.querySelector<HTMLElement>("#newsletter__group-label");
    expect(heading()?.textContent).toBe("Newsletter");
    expect(heading()!.classList.contains("datum-form__visually-hidden")).toBe(false);

    // Select it and tick "Hide label", on the Style tab.
    await selected(element, "newsletter");
    tab(element, "style");
    const hide = propsOf(element).querySelector<HTMLInputElement>('input[data-prop="hideLabel"]')!;
    expect(hide).toBeTruthy();
    hide.click();

    await until(() => heading()?.classList.contains("datum-form__visually-hidden"));
    // Hidden from sight, still the group's accessible name.
    expect(heading()!.textContent).toBe("Newsletter");
    expect(previewOf(element)!.querySelector('[aria-labelledby="newsletter__group-label"]')).toBeTruthy();
  });
});

describe("what a keystroke in the inspector does to the canvas", () => {
  it("keeps a value typed on the canvas across a property edit", async () => {
    const element = await mountBuilder(formOf([textNode("name", "Full name")]));
    const control = (): HTMLInputElement => previewOf(element)!.querySelector<HTMLInputElement>('[data-component-id="name"] input')!;
    keystroke(control(), "Ada Lovelace");

    // Retitling a field is the kind of edit that fires on every keystroke; rebuilding the preview
    // from scratch each time would discard what the author had typed into it.
    await selected(element, "name");
    const label = propsOf(element).querySelector<HTMLInputElement>('input[data-prop="label"]')!;
    keystroke(label, "Legal name");
    // Typing streams to the draft without drawing; leaving the box lets the canvas catch up.
    label.dispatchEvent(new FocusEvent("focusout", { bubbles: true, composed: true }));

    await until(() => previewOf(element)!.textContent!.includes("Legal name"));
    expect(control().value).toBe("Ada Lovelace");
  });

  it("previews a button added from the palette as a real button reading Submit", async () => {
    const element = await mountBuilder(formOf([]));
    toolbarOf(element).querySelector<HTMLButtonElement>('[data-add-type="button"]')!.click();
    const id = element.builder!.controller.selectedComponentId()!;
    await until(() => previewOf(element)!.querySelector(`.db-node[data-component-id="${id}"]`));

    // The type's own default gives "Submit": not a generic placeholder the builder invents for a
    // type with no registered default. The canvas previews the real button the live form renders.
    const control = previewOf(element)!.querySelector<HTMLElement>(`[data-component-id="${id}"] button, button[data-component-id="${id}"]`)!;
    expect(control.tagName).toBe("BUTTON");
    expect(control.textContent!.trim()).toBe("Submit");
    expect(previewOf(element)!.textContent).not.toContain("BUTTON field");
  });

  it("writes only the On paper key the author changes, and leaves the form's print block alone", async () => {
    const element = await mountBuilder(formOf([textNode("name", "Name")], { print: { scale: 0.8, header: { end: "{{date}}" } } }));
    await selected(element, "name");
    const section = propsOf(element).querySelector('[data-inspector-section="print"]')!;
    expect(section.querySelector("summary")?.textContent).toBe("On paper");
    expect([...section.querySelectorAll("[data-prop]")].map((box) => box.getAttribute("data-prop"))).toEqual(["print.on", "print.breakBefore", "print.show", "print.note"]);
    // A field holds an answer: paper only is drawn, disabled.
    const shown = section.querySelector<HTMLSelectElement>('select[data-prop="print.on"]')!;
    expect([...shown.options].map((option) => [option.value, option.disabled])).toEqual([["", false], ["screen", false], ["paper", true]]);

    const breakBefore = section.querySelector<HTMLInputElement>('input[data-prop="print.breakBefore"]')!;
    expect(breakBefore.type).toBe("checkbox");
    breakBefore.checked = true;
    breakBefore.dispatchEvent(new Event("input", { bubbles: true }));
    save(element);

    const written = (element.builder!.controller.selectedNode()!.configuration as { print?: Record<string, unknown> }).print;
    // Only the edited key is written; everything untouched keeps relying on the reader's defaults.
    expect(written).toEqual({ breakBefore: true });
    expect((element.builder!.controller.snapshot().configuration as { print?: unknown }).print).toEqual({ scale: 0.8, header: { end: "{{date}}" } });
  });
});

describe("an expression-typed property", () => {
  it("is edited as JSON, keeping the last good value while it does not parse", async () => {
    const withExpression = {
      type: "text",
      version: "1.0.0",
      propertyEditor: { mode: "extend", fields: [{ id: "expression", type: "expression", propertyPath: "expression", label: "Expression" }] }
    } as unknown as ComponentDefinition;
    const element = document.createElement("datum-form-builder");
    element.componentDefinitions = [withExpression];
    element.definition = formOf([textNode("calc", "Calc")]);
    document.body.append(element);
    await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
    const controller = element.builder!.controller;
    await selected(element, "calc");

    const box = (): HTMLTextAreaElement => propsOf(element).querySelector<HTMLTextAreaElement>('textarea[data-prop="expression"]')!;
    const type = (text: string): void => keystroke(box(), text);
    // An expression is an AST, so the control is a JSON box, never a plain text input.
    expect(box()).toBeTruthy();
    expect(propsOf(element).querySelector('input[data-prop="expression"]')).toBeNull();

    type('{ "kind": "path", "path": "firstName" }');
    expect(controller.draftProperty("calc", "expression")).toEqual({ kind: "path", path: "firstName" });

    // Mid-keystroke JSON does not parse: the draft keeps the last good expression, the box keeps
    // the text as typed, and the failure shows under it.
    type('{ "kind": "path", "pa');
    expect(controller.draftProperty("calc", "expression")).toEqual({ kind: "path", path: "firstName" });
    expect(box().value).toBe('{ "kind": "path", "pa');
    const error = propsOf(element).querySelector(".field-error");
    expect(error?.textContent).toBeTruthy();
    expect(box().getAttribute("aria-invalid")).toBe("true");
    expect(box().getAttribute("aria-describedby")).toBe(error!.id);

    // Blank clears the property, and the error with it.
    type("");
    expect(controller.draftProperty("calc", "expression")).toBeUndefined();
    expect(propsOf(element).querySelector(".field-error")).toBeNull();
    expect(box().hasAttribute("aria-invalid")).toBe(false);

    type('{ "kind": "literal", "value": 7 }');
    save(element);
    expect(controller.selectedNode()!.configuration).toMatchObject({ expression: { kind: "literal", value: 7 } });
  });
});

describe("a rule switched off", () => {
  it("drops only that key from the draft, the component's other rules untouched", async () => {
    const element = await mountBuilder(
      formOf([
        { id: "optIn", type: "checkbox", configuration: { label: "Subscribe" } },
        {
          id: "email",
          type: "text",
          configuration: { label: "Email" },
          rules: { visibleWhen: "optIn", requiredWhen: "optIn" }
        }
      ])
    );
    await selected(element, "email");
    tab(element, "rules");
    propsOf(element).querySelector<HTMLButtonElement>('[data-rule="visibleWhen"][data-rule-mode="off"]')!.click();
    expect(element.builder!.controller.draftRules("email")).toEqual({ requiredWhen: "optIn" });
    expect(idsOf(element)).toEqual(["optIn", "email"]);
  });
});
