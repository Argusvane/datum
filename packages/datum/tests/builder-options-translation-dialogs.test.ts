import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { ComponentNode, FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The options dialog: Escape asks before it throws typed
 * rows away, a pasted list is one option per line, a half-typed add row is not dropped without
 * a word, and its Apply commits to the form as one undo step with the inspector's draft
 * kept in step. A language's wording is typed in the Languages workspace, not here: the dialog
 * edits default strings.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

const CONTACT_OPTIONS = [
  { value: "email", label: "Email" },
  { value: "phone", label: "Phone" }
];

function definition(): FormDefinition {
  const base = sampleDefinition();
  base.root.children!.content!.splice(1, 0, {
    id: "contact",
    type: "select",
    configuration: { label: "Contact", options: structuredClone(CONTACT_OPTIONS) }
  });
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
const inspector = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-properties")!.shadowRoot!;
const configOf = (element: DatumFormBuilderElement, id: string): Record<string, unknown> =>
  (element.builder!.controller.snapshot().children!.content!.find((node: ComponentNode) => node.id === id)!.configuration ?? {}) as Record<string, unknown>;
const optionsDialog = (element: DatumFormBuilderElement): HTMLDialogElement | null =>
  inspector(element).querySelector<HTMLDialogElement>("dialog[data-options-dialog]");
const discardPrompt = (element: DatumFormBuilderElement): HTMLDialogElement | null =>
  inspector(element).querySelector<HTMLDialogElement>("dialog[data-options-discard-prompt]");
const notApplied = (element: DatumFormBuilderElement): Element | null => inspector(element).querySelector("[data-not-applied]");

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

async function openOptions(element: DatumFormBuilderElement): Promise<HTMLDialogElement> {
  await select(element, "contact");
  inspector(element).querySelector<HTMLButtonElement>('[data-options-edit="options"]')!.click();
  await until(() => optionsDialog(element));
  return optionsDialog(element)!;
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function press(target: HTMLElement, key: string): void {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
}

/** A paste as the browser reports it (jsdom has no ClipboardEvent with data). */
function paste(target: HTMLElement, text: string): Event {
  const event = new Event("paste", { bubbles: true, composed: true, cancelable: true });
  Object.defineProperty(event, "clipboardData", { value: { getData: (format: string) => (format === "text/plain" ? text : "") } });
  target.dispatchEvent(event);
  return event;
}

const cell = (dialog: ParentNode, row: number, part: string): HTMLInputElement =>
  dialog.querySelector<HTMLInputElement>(`[data-option-row="${row}"][data-option-part="${part}"]`)!;

describe("the options dialog's Escape", () => {
  it("closes at once when nothing was changed", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    press(dialog.querySelector<HTMLElement>("[data-options-new='value']")!, "Escape");
    expect(discardPrompt(element)).toBeNull();
    expect(optionsDialog(element)).toBeNull();
    expect(configOf(element, "contact").options).toEqual(CONTACT_OPTIONS);
  });

  it("asks before discarding edited rows: Keep editing keeps them and the caret's box, Discard drops them", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    const label = cell(dialog, 1, "label");
    label.focus();
    type(label, "Telephone");
    press(label, "Escape");
    const prompt = discardPrompt(element)!;
    expect(prompt).not.toBeNull();
    expect(prompt.querySelector("h4")!.textContent).toBe("Discard 1 change?");
    expect(prompt.getAttribute("role")).toBe("alertdialog");
    expect(inspector(element).activeElement).toBe(prompt.querySelector("[data-options-discard-keep]"));
    // Keep editing: the question goes, the typed text stays, focus is back on the box.
    prompt.querySelector<HTMLButtonElement>("[data-options-discard-keep]")!.click();
    expect(discardPrompt(element)).toBeNull();
    expect(cell(optionsDialog(element)!, 1, "label").value).toBe("Telephone");
    expect(inspector(element).activeElement).toBe(cell(optionsDialog(element)!, 1, "label"));
    // Escape over the question is Keep editing, never Discard.
    press(cell(optionsDialog(element)!, 1, "label"), "Escape");
    press(discardPrompt(element)!.querySelector<HTMLElement>("[data-options-discard-keep]")!, "Escape");
    expect(discardPrompt(element)).toBeNull();
    expect(optionsDialog(element)).not.toBeNull();
    // A removed row and a half-typed add row count too.
    optionsDialog(element)!.querySelector<HTMLButtonElement>('[data-options-remove="0"]')!.click();
    type(optionsDialog(element)!.querySelector<HTMLInputElement>("[data-options-new='label']")!, "Post");
    press(optionsDialog(element)!.querySelector<HTMLElement>("[data-options-new='label']")!, "Escape");
    expect(discardPrompt(element)!.querySelector("h4")!.textContent).toBe("Discard 3 changes?");
    discardPrompt(element)!.querySelector<HTMLButtonElement>("[data-options-discard-confirm]")!.click();
    expect(discardPrompt(element)).toBeNull();
    expect(optionsDialog(element)).toBeNull();
    expect(configOf(element, "contact").options).toEqual(CONTACT_OPTIONS);
    expect(element.builder!.controller.hasPendingChanges("contact")).toBe(false);
  });

  it("leaves Cancel a plain close: the deliberate discard asks nothing", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    type(cell(dialog, 0, "label"), "E-mail");
    dialog.querySelector<HTMLButtonElement>("[data-options-cancel]")!.click();
    expect(discardPrompt(element)).toBeNull();
    expect(optionsDialog(element)).toBeNull();
    expect(configOf(element, "contact").options).toEqual(CONTACT_OPTIONS);
  });

  it("asks over the messages editor too, the same dialog", async () => {
    const element = await mount();
    await select(element, "contact");
    inspector(element).querySelector<HTMLButtonElement>("[data-messages-edit]")!.click();
    await until(() => optionsDialog(element));
    const dialog = optionsDialog(element)!;
    expect(dialog.dataset.optionsKind).toBe("messages");
    press(dialog.querySelector<HTMLElement>("[data-options-new='value']")!, "Escape");
    expect(optionsDialog(element)).toBeNull();
    inspector(element).querySelector<HTMLButtonElement>("[data-messages-edit]")!.click();
    await until(() => optionsDialog(element));
    type(optionsDialog(element)!.querySelector<HTMLInputElement>("[data-options-new='label']")!, "Pick one");
    press(optionsDialog(element)!.querySelector<HTMLElement>("[data-options-new='label']")!, "Escape");
    expect(discardPrompt(element)!.querySelector("h4")!.textContent).toBe("Discard 1 change?");
  });
});

describe("pasting a list into the options dialog", () => {
  it("makes one option per non-empty line, keys from the labels, unique against the list", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    const event = paste(dialog.querySelector<HTMLElement>("[data-options-new='label']")!, "  Mail \r\n\nEmail\nÉté du Midi\n");
    expect(event.defaultPrevented).toBe(true);
    const shown = optionsDialog(element)!;
    expect([0, 1, 2, 3, 4].map((row) => [cell(shown, row, "value").value, cell(shown, row, "label").value])).toEqual([
      ["email", "Email"],
      ["phone", "Phone"],
      ["mail", "Mail"],
      ["email_2", "Email"],
      ["ete_du_midi", "Été du Midi"]
    ]);
    expect(inspector(element).activeElement).toBe(cell(shown, 4, "label"));
    shown.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect((configOf(element, "contact").options as Array<{ value: string }>).map((option) => option.value)).toEqual([
      "email",
      "phone",
      "mail",
      "email_2",
      "ete_du_midi"
    ]);
  });

  it("puts a list pasted into a row's label after that row, and leaves a one-line paste to the box", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    expect(paste(cell(dialog, 0, "label"), "Just one").defaultPrevented).toBe(false);
    expect(paste(cell(dialog, 0, "label"), "Fax\nPigeon").defaultPrevented).toBe(true);
    const shown = optionsDialog(element)!;
    expect([0, 1, 2, 3].map((row) => cell(shown, row, "value").value)).toEqual(["email", "fax", "pigeon", "phone"]);
  });
});

describe("the options dialog's add row at Apply", () => {
  it("applies a row with a label and no key under a key made from the label", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='label']")!, "Text message");
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect(optionsDialog(element)).toBeNull();
    expect(configOf(element, "contact").options).toEqual([...CONTACT_OPTIONS, { value: "text_message", label: "Text message" }]);
  });

  it("applies a row with both, and drops an empty one without a word", async () => {
    const element = await mount();
    let dialog = await openOptions(element);
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='value']")!, "sms");
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='label']")!, "SMS");
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect(configOf(element, "contact").options).toEqual([...CONTACT_OPTIONS, { value: "sms", label: "SMS" }]);
    inspector(element).querySelector<HTMLButtonElement>('[data-options-edit="options"]')!.click();
    dialog = optionsDialog(element)!;
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='value']")!, "   ");
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect(optionsDialog(element)).toBeNull();
    expect(configOf(element, "contact").options).toEqual([...CONTACT_OPTIONS, { value: "sms", label: "SMS" }]);
  });

  it("holds Apply on a row with a key and no label, saying which row, with the dialog left open", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='value']")!, "fax");
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    const shown = optionsDialog(element)!;
    expect(shown).not.toBeNull();
    expect(shown.querySelector(".db-options-error")!.textContent).toBe("Row 3 is not finished: it has a key but no label. Add a label, or clear the key.");
    expect(shown.querySelector<HTMLInputElement>("[data-options-new='value']")!.value).toBe("fax");
    expect(inspector(element).activeElement).toBe(shown.querySelector("[data-options-new='label']"));
    expect(configOf(element, "contact").options).toEqual(CONTACT_OPTIONS);
  });

  it("holds Apply on a clashing key and puts focus in the key box, where the problem is", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='value']")!, "phone");
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='label']")!, "Again");
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    const shown = optionsDialog(element)!;
    expect(shown.querySelector(".db-options-error")!.textContent).toContain('Key "phone" already exists');
    expect(inspector(element).activeElement).toBe(shown.querySelector("[data-options-new='value']"));
  });

  it("empties the add row when a list is pasted into it, so a typed key is not left without a label", async () => {
    const element = await mount();
    const dialog = await openOptions(element);
    type(dialog.querySelector<HTMLInputElement>("[data-options-new='value']")!, "mail");
    paste(dialog.querySelector<HTMLElement>("[data-options-new='label']")!, "Mail\nFax");
    const shown = optionsDialog(element)!;
    expect(shown.querySelector<HTMLInputElement>("[data-options-new='value']")!.value).toBe("");
    expect(shown.querySelector<HTMLInputElement>("[data-options-new='label']")!.value).toBe("");
    shown.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect(optionsDialog(element)).toBeNull();
    expect((configOf(element, "contact").options as Array<{ value: string }>).map((option) => option.value)).toEqual([
      "email",
      "phone",
      "mail",
      "fax"
    ]);
  });
});

describe("the dialog's Apply commits", () => {
  it("writes the options dialog straight to the form as one undo step, nothing left to apply", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    const dialog = await openOptions(element);
    type(cell(dialog, 1, "label"), "Telephone");
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect(configOf(element, "contact").options).toEqual([CONTACT_OPTIONS[0], { value: "phone", label: "Telephone" }]);
    expect(controller.hasPendingChanges("contact")).toBe(false);
    expect(notApplied(element)).toBeNull();
    controller.undo();
    expect(configOf(element, "contact").options).toEqual(CONTACT_OPTIONS);
  });

  it("applied unchanged, writes nothing and leaves no undo step", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    const before = controller.canUndo();
    const dialog = await openOptions(element);
    dialog.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    expect(controller.canUndo()).toBe(before);
    expect(controller.hasPendingChanges("contact")).toBe(false);
  });
});
