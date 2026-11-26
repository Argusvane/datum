import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { EMAIL_PRESET_MESSAGE, EMAIL_PRESET_PATTERN, type ComponentNode, type FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The Email validation preset in the inspector. The Email
 * keyboard is a device hint and stores nothing else; the Format box under Validation writes the
 * pattern and a default message into the draft, Apply lands both as one undo step, and the
 * keyboard only makes the inspector suggest it (a button, so the keyboard reaches it too).
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(configuration: Record<string, unknown> = {}): FormDefinition {
  const base = sampleDefinition();
  const email = base.root.children!.content!.find((node: ComponentNode) => node.id === "email")!;
  email.configuration = { ...(email.configuration as Record<string, unknown>), ...configuration };
  return base;
}

async function mount(form: FormDefinition = definition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = form;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => (shell(element).querySelector("datum-builder-properties") as HTMLElement).shadowRoot!;
const controllerOf = (element: DatumFormBuilderElement) => element.builder!.controller;
const configOf = (element: DatumFormBuilderElement, id: string): Record<string, unknown> =>
  (controllerOf(element).snapshot().children!.content!.find((node: ComponentNode) => node.id === id)!.configuration ?? {}) as Record<string, unknown>;
const formatBox = (element: DatumFormBuilderElement): HTMLSelectElement | null => inspector(element).querySelector<HTMLSelectElement>('select[data-prop="patternPreset"]');
const suggestion = (element: DatumFormBuilderElement): HTMLButtonElement | null => inspector(element).querySelector<HTMLButtonElement>("button[data-preset-apply]");
const apply = (element: DatumFormBuilderElement): HTMLButtonElement => inspector(element).querySelector<HTMLButtonElement>("[data-inspector-save]")!;

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  controllerOf(element).select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

function choose(box: HTMLSelectElement, value: string): void {
  box.value = value;
  box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
}

describe("the Format box", () => {
  it("is drawn under Validation just before Pattern, on Any text for a component with no pattern", async () => {
    const element = await mount();
    await select(element, "email");
    const box = formatBox(element)!;
    expect(box).not.toBeNull();
    expect(box.value).toBe("");
    expect([...box.options].map((option) => option.textContent)).toEqual(["Any text", "Email address"]);
    const rows = [...inspector(element).querySelectorAll<HTMLElement>("[data-prop]")].map((control) => control.dataset.prop);
    expect(rows.indexOf("patternPreset") + 1).toBe(rows.indexOf("pattern"));
  });

  it("writes the pattern and the default message into the draft, and Apply lands them as one undo step", async () => {
    const element = await mount();
    await select(element, "email");
    const before = controllerOf(element).canUndo();
    choose(formatBox(element)!, "email");
    expect(controllerOf(element).hasPendingChanges("email")).toBe(true);
    // The draft holds both; the committed tree holds neither until Apply.
    expect(controllerOf(element).draftProperty("email", "pattern")).toBe(EMAIL_PRESET_PATTERN);
    expect(controllerOf(element).draftProperty("email", "patternMessage")).toEqual(EMAIL_PRESET_MESSAGE);
    expect(configOf(element, "email").pattern).toBeUndefined();
    apply(element).click();
    expect(configOf(element, "email").pattern).toBe(EMAIL_PRESET_PATTERN);
    expect(configOf(element, "email").patternMessage).toEqual(EMAIL_PRESET_MESSAGE);
    // One Undo takes back both.
    controllerOf(element).undo();
    expect(configOf(element, "email").pattern).toBeUndefined();
    expect(configOf(element, "email").patternMessage).toBeUndefined();
    expect(before).toBe(false);
  });

  it("reads Email back from the stored pattern, and Any text takes the pair away", async () => {
    const element = await mount(definition({ pattern: EMAIL_PRESET_PATTERN, patternMessage: EMAIL_PRESET_MESSAGE }));
    await select(element, "email");
    expect(formatBox(element)!.value).toBe("email");
    choose(formatBox(element)!, "");
    apply(element).click();
    expect(configOf(element, "email").pattern).toBeUndefined();
    expect(configOf(element, "email").patternMessage).toBeUndefined();
  });

  it("keeps a message the author wrote and shows Custom pattern for a pattern of their own", async () => {
    const element = await mount(definition({ pattern: "[a-z]+", patternMessage: "Letters only" }));
    await select(element, "email");
    const box = formatBox(element)!;
    expect(box.value).toBe("custom");
    expect([...box.options].map((option) => option.value)).toEqual(["", "email", "custom"]);
    choose(box, "email");
    apply(element).click();
    expect(configOf(element, "email").pattern).toBe(EMAIL_PRESET_PATTERN);
    expect(configOf(element, "email").patternMessage).toBe("Letters only");
  });
});

describe("the Email keyboard's suggestion", () => {
  it("shows Suggest: validate as email as a button, not a warning, and applies the preset to the draft on click", async () => {
    const element = await mount(definition({ inputmode: "email" }));
    await select(element, "email");
    const button = suggestion(element)!;
    expect(button).not.toBeNull();
    expect(button.textContent).toBe("Suggest: validate as email");
    expect(button.closest("[data-inspector-hint]")!.getAttribute("data-severity")).toBe("info");
    expect(inspector(element).querySelector('[data-note][data-severity="warning"]')).toBeNull();
    button.click();
    expect(controllerOf(element).draftProperty("email", "pattern")).toBe(EMAIL_PRESET_PATTERN);
    expect(controllerOf(element).draftProperty("email", "patternMessage")).toEqual(EMAIL_PRESET_MESSAGE);
    await until(() => suggestion(element) === null);
    expect(formatBox(element)!.value).toBe("email");
    apply(element).click();
    expect(configOf(element, "email").pattern).toBe(EMAIL_PRESET_PATTERN);
  });

  it("appears when the Email keyboard is chosen, and applies nothing by itself", async () => {
    const element = await mount();
    await select(element, "email");
    expect(suggestion(element)).toBeNull();
    const keyboard = inspector(element).querySelector<HTMLSelectElement>('select[data-prop="inputmode"]')!;
    choose(keyboard, "email");
    await until(() => suggestion(element));
    expect(controllerOf(element).draftProperty("email", "inputmode")).toBe("email");
    expect(controllerOf(element).draftProperty("email", "pattern")).toBeUndefined();
    apply(element).click();
    expect(configOf(element, "email").inputmode).toBe("email");
    expect(configOf(element, "email").pattern).toBeUndefined();
    expect(configOf(element, "email").patternMessage).toBeUndefined();
  });

  it("is not drawn once a pattern is stored", async () => {
    const element = await mount(definition({ inputmode: "email", pattern: "[a-z]+" }));
    await select(element, "email");
    expect(suggestion(element)).toBeNull();
  });
});
