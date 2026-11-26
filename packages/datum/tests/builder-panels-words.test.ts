import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { BuilderController } from "@argusvane/datum-engine";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The builder panels: the panels' last English constants
 * read from the core table, the inspector parts the builder's features own, the
 * "Source changed" marker, now the Languages workspace's and kept in the translations map
 * a choice
 * field with no options saying so on the canvas, and the canvas naming its preview
 * Preview where Try it is left out.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

function definition(): FormDefinition {
  const base = sampleDefinition();
  base.root.children!.content!.push(
    { id: "empty", type: "select", configuration: { label: "Empty choice", options: [] } },
    { id: "colours", type: "radio", configuration: { label: "Colours", options: [{ value: "red", label: "Red" }] } },
    { id: "go", type: "button", configuration: { label: "Go", action: "submit" } }
  );
  return base;
}

async function mount(form: FormDefinition = definition(), setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = form;
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  await until(() => sheet(element).querySelector("[data-db-handle=fullName]"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
type PropertiesPanel = HTMLElement & {
  inspectorFeatures: Record<string, boolean | undefined>;
  textLocale: string | undefined;
  textCatalog: Record<string, Record<string, string>> | undefined;
};
const properties = (element: DatumFormBuilderElement): PropertiesPanel => shell(element).querySelector("datum-builder-properties") as PropertiesPanel;
const inspector = (element: DatumFormBuilderElement): ShadowRoot => properties(element).shadowRoot!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
const sheet = (element: DatumFormBuilderElement): ShadowRoot => canvas(element).querySelector("datum-form-renderer")!.shadowRoot!;

async function select(element: DatumFormBuilderElement, id: string): Promise<void> {
  element.builder!.controller.select(id);
  await until(() => inspector(element).querySelector<HTMLInputElement>('input[data-prop="id"]')?.value === id);
}

function type(input: HTMLInputElement, text: string): void {
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

describe("the panels' words come from the core table", () => {
  it("words Skip to canvas and Move to... by key, a host catalog included, English unchanged", async () => {
    const element = await mount();
    const palette = shell(element).querySelector("datum-builder-toolbar") as PropertiesPanel;
    // A hidden panel is stale until opened: open the Components palette first.
    (element.builder as unknown as { panel: string | undefined }).panel = "components";
    await until(() => !palette.hidden && palette.shadowRoot?.querySelector("[data-palette-skip]"));
    expect(palette.shadowRoot!.querySelector("[data-palette-skip]")!.textContent).toBe("Skip to canvas");
    palette.textLocale = "fr";
    palette.textCatalog = { fr: { "components.skip": "Aller au canevas" } };
    await until(() => palette.shadowRoot!.querySelector("[data-palette-skip]")!.textContent === "Aller au canevas");

    element.builder!.controller.select("fullName");
    const move = (): HTMLElement => canvas(element).querySelector<HTMLElement>('[data-selection-action="move"]')!;
    await until(() => move());
    expect(move().getAttribute("aria-label")).toBe("Move to…");
    expect(move().getAttribute("data-tip")).toBe("Move to… (M)");
    const canvasEl = shell(element).querySelector("datum-builder-canvas") as PropertiesPanel;
    canvasEl.textLocale = "fr";
    canvasEl.textCatalog = { fr: { "canvas.action.move": "Déplacer…", "canvas.action.moveTip": "Déplacer… (M)" } };
    await until(() => move().getAttribute("aria-label") === "Déplacer…");
    expect(move().getAttribute("data-tip")).toBe("Déplacer… (M)");
  });
});

describe("inspector parts follow the builder's features", () => {
  async function formPanel(element: DatumFormBuilderElement): Promise<PropertiesPanel & { controller: BuilderController }> {
    const panel = document.createElement("datum-builder-form-panel") as PropertiesPanel & { controller: BuilderController };
    document.body.append(panel);
    panel.controller = element.builder!.controller;
    await until(() => panel.shadowRoot?.querySelector('[data-inspector-section="formulas"]'));
    return panel;
  }
  const sections = (root: ShadowRoot): string[] => [...root.querySelectorAll<HTMLElement>("[data-inspector-section]")].map((section) => section.dataset.inspectorSection!);

  it("leaves the Form panel's markup as it was with every feature on, and drops Formulas with logic (the form's print settings are the Print workspace's)", async () => {
    const element = await mount();
    const panel = await formPanel(element);
    const root = panel.shadowRoot!;
    const all = sections(root);
    expect(all).toEqual(expect.arrayContaining(["formulas"]));
    expect(all).not.toContain("print");
    // The Localization section is gone: languages are the Languages workspace's.
    expect(all).not.toContain("localization");
    const before = root.innerHTML;
    // Every feature named on is what no features at all draws: not a byte moves.
    panel.inspectorFeatures = { json: true, translations: true, advancedFields: true, headerFooter: true, pdf: true, logic: true };
    expect(root.innerHTML).toBe(before);

    panel.inspectorFeatures = { pdf: false };
    expect(sections(root)).toEqual(all);
    panel.inspectorFeatures = { logic: false };
    expect(sections(root)).not.toContain("formulas");
    panel.inspectorFeatures = {};
    expect(sections(root)).toEqual(all);
  });

  it("offers the Button's Download as PDF only with pdf, and keeps the passkey signature either way", async () => {
    const element = await mount();
    await select(element, "go");
    const actions = (): string[] =>
      [...inspector(element).querySelectorAll<HTMLOptionElement>('select[data-prop="action"] option')].map((option) => option.value);
    const signatures = (): string[] =>
      [...inspector(element).querySelectorAll<HTMLOptionElement>('select[data-prop="signature"] option')].map((option) => option.value);
    expect(actions()).toContain("pdf");
    const passkey = signatures().includes("webauthn");
    properties(element).inspectorFeatures = { pdf: false };
    expect(actions()).not.toContain("pdf");
    expect(actions()).toContain("submit");
    expect(signatures().includes("webauthn")).toBe(passkey);
    properties(element).inspectorFeatures = {};
    expect(actions()).toContain("pdf");
  });
});

describe("the Languages workspace marks a translation whose source changed", () => {
  /** The Languages surface's shadow root, once the workspace is open and drawn. */
  async function languages(element: DatumFormBuilderElement): Promise<ShadowRoot> {
    element.builder!.setWorkspace("languages");
    const surface = (): ShadowRoot | null => shell(element).querySelector("datum-builder-languages")?.shadowRoot ?? null;
    await until(() => surface()?.querySelector('[data-languages-row="components/fullName/label"]'));
    return surface()!;
  }
  const cell = (root: ShadowRoot): HTMLInputElement =>
    root.querySelector<HTMLInputElement>('input[data-languages-cell="components/fullName/label"][data-languages-locale="fr-CA"]')!;

  it("flags the language translated before the source changed, clears it on Confirm, and has no flag for a definition put in place", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    // Nothing has changed yet: the French translation answers the default as it stands.
    let root = await languages(element);
    expect(root.querySelector('[data-languages-lang="fr-CA"] [data-languages-stale-count]')).toBeNull();
    expect(root.querySelector('[data-languages-reconcile="components/fullName/label"]')).toBeNull();

    // The source changes after fr-CA was translated: the card counts it and the cell offers Confirm.
    controller.setProperty("fullName", "label", "Your full name");
    await until(() => shell(element).querySelector("datum-builder-languages")?.shadowRoot?.querySelector('[data-languages-lang="fr-CA"] [data-languages-stale-count]'));
    root = shell(element).querySelector("datum-builder-languages")!.shadowRoot!;
    expect(root.querySelector('[data-languages-lang="fr-CA"] [data-languages-stale-count]')!.textContent).toBe("1 source changed");
    expect(cell(root).value).toBe("Nom complet");

    // Confirming says the translation still reads right: the flag goes, the text stays, one undo step.
    root.querySelector<HTMLButtonElement>('[data-languages-reconcile="components/fullName/label"]')!.click();
    await until(() => !root.querySelector('[data-languages-lang="fr-CA"] [data-languages-stale-count]'));
    expect(cell(root).value).toBe("Nom complet");

    // Changed again, and the flag is back; an ordinary edit of another component does not clear it.
    controller.setProperty("fullName", "label", "Name");
    controller.setProperty("subscribe", "label", "Sign me up");
    await until(() => root.querySelector('[data-languages-lang="fr-CA"] [data-languages-stale-count]'));

    // A definition put in place (File > Open, a host's new definition): no flag carries over.
    element.definition = sampleDefinition();
    await until(() => sheet(element).querySelector("[data-db-handle=fullName]"));
    root = await languages(element);
    expect(root.querySelector('[data-languages-lang="fr-CA"] [data-languages-stale-count]')).toBeNull();
  });
});

describe("a choice field with no options says so on the canvas", () => {
  const hint = (element: DatumFormBuilderElement, id: string): HTMLButtonElement | null =>
    sheet(element).querySelector<HTMLButtonElement>(`[data-component-id="${id}"] [data-no-options]`);

  it("draws the hint under a choice field with no options and none under one with options or a data source", async () => {
    const element = await mount();
    await until(() => hint(element, "empty"));
    expect(hint(element, "empty")!.textContent).toBe("No options yet - edit options");
    expect(hint(element, "empty")!.dataset.noOptions).toBe("empty");
    expect(hint(element, "colours")).toBeNull();
    // A data source answers for the options: no hint.
    expect(hint(element, "country")).toBeNull();
    expect(hint(element, "fullName")).toBeNull();
  });

  it("opens the options editor on the field from the hint, and the hint goes once an option is applied", async () => {
    const element = await mount();
    await until(() => hint(element, "empty"));
    hint(element, "empty")!.click();
    const controller = element.builder!.controller;
    expect(controller.selectedComponentId()).toBe("empty");
    const dialog = (): HTMLDialogElement | null => inspector(element).querySelector<HTMLDialogElement>("dialog[data-options-dialog]");
    await until(() => dialog());
    type(dialog()!.querySelector<HTMLInputElement>("[data-options-new='value']")!, "a");
    type(dialog()!.querySelector<HTMLInputElement>("[data-options-new='label']")!, "A");
    dialog()!.querySelector<HTMLButtonElement>("[data-options-apply]")!.click();
    await until(() => !hint(element, "empty"));
    expect((controller.snapshot().children!.content!.find((node) => node.id === "empty")!.configuration as Record<string, unknown>).options).toEqual([{ value: "a", label: "A" }]);
  });

  it("asks about unapplied edits before it moves the selection, and opens nothing while that is asked", async () => {
    const element = await mount();
    await select(element, "fullName");
    const box = inspector(element).querySelector<HTMLInputElement>('[data-prop="label"]')!;
    type(box, "Changed");
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => hint(element, "empty"));
    hint(element, "empty")!.click();
    const controller = element.builder!.controller;
    await until(() => inspector(element).querySelector("dialog[data-unsaved-prompt]"));
    expect(controller.selectedComponentId()).toBe("fullName");
    expect(inspector(element).querySelector("dialog[data-options-dialog]")).toBeNull();
  });
});

describe("the hint clicked under the unsaved prompt", () => {
  it("opens the options editor once Apply lets the selection reach the field", async () => {
    const element = await mount();
    await select(element, "fullName");
    const box = inspector(element).querySelector<HTMLInputElement>('[data-prop="label"]')!;
    type(box, "Changed");
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const hint = (): HTMLButtonElement | null => sheet(element).querySelector<HTMLButtonElement>('[data-component-id="empty"] [data-no-options]');
    await until(() => hint());
    hint()!.click();
    await until(() => inspector(element).querySelector("dialog[data-unsaved-prompt]"));
    inspector(element).querySelector<HTMLButtonElement>("dialog[data-unsaved-prompt] [data-unsaved-save]")!.click();
    await until(() => inspector(element).querySelector("dialog[data-options-dialog]:not([data-translations-dialog])"));
    expect(element.builder!.controller.selectedComponentId()).toBe("empty");
  });

  it("forgets the hint after Keep editing, so a later plain selection of the field opens no options editor", async () => {
    const element = await mount();
    await select(element, "fullName");
    const box = inspector(element).querySelector<HTMLInputElement>('[data-prop="label"]')!;
    type(box, "Changed");
    box.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    const hint = (): HTMLButtonElement | null => sheet(element).querySelector<HTMLButtonElement>('[data-component-id="empty"] [data-no-options]');
    await until(() => hint());
    hint()!.click();
    await until(() => inspector(element).querySelector("dialog[data-unsaved-prompt]"));
    const controller = element.builder!.controller;
    controller.answerUnsavedChangesPrompt("stay");
    await until(() => !inspector(element).querySelector("dialog[data-unsaved-prompt]"));
    expect(controller.commitDraft("fullName")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(controller.requestSelect("empty")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(controller.selectedComponentId()).toBe("empty");
    expect(inspector(element).querySelector("dialog[data-options-dialog]:not([data-translations-dialog])")).toBeNull();
  });
});

describe("the canvas's preview toggle without Try it", () => {
  it("is named Preview, with no aria-label saying Try it", async () => {
    const element = await mount(definition(), (el) => el.setAttribute("features", "logic"));
    const toggle = (): HTMLElement => canvas(element).querySelector<HTMLElement>("[data-try-it]")!;
    await until(() => toggle()?.textContent === "Preview");
    expect(toggle().hasAttribute("aria-label")).toBe(false);
    expect(canvas(element).querySelector("[data-try-panel]")!.hasAttribute("hidden")).toBe(true);
  });
});
