import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/** The command palette: Ctrl+K, filter, Enter, through the controls' own paths. */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const palette = (element: DatumFormBuilderElement): ShadowRoot | undefined => shell(element).querySelector("datum-builder-palette")?.shadowRoot ?? undefined;
const dialog = (element: DatumFormBuilderElement): HTMLDialogElement | null | undefined => palette(element)?.querySelector("dialog");
const input = (element: DatumFormBuilderElement): HTMLInputElement => palette(element)!.querySelector<HTMLInputElement>("[data-palette-input]")!;
const labels = (element: DatumFormBuilderElement): string[] =>
  [...palette(element)!.querySelectorAll<HTMLElement>("[data-palette-option] .palette-label")].map((label) => label.textContent!);

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

async function open(element: DatumFormBuilderElement): Promise<void> {
  element.builder!.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true, composed: true, cancelable: true }));
  await until(() => dialog(element)?.open);
}

function type(element: DatumFormBuilderElement, text: string): void {
  input(element).value = text;
  input(element).dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function press(element: DatumFormBuilderElement, key: string): void {
  input(element).dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, composed: true, cancelable: true }));
}

describe("the command palette", () => {
  it("opens on Ctrl+K as a combobox over a listbox of every command, the box focused", async () => {
    const element = await mount();
    await open(element);
    expect(palette(element)!.activeElement).toBe(input(element));
    expect(input(element).getAttribute("role")).toBe("combobox");
    // The highlight starts on the first command that can run ("Go to the Form workspace" cannot, from Form).
    const active = palette(element)!.querySelector<HTMLElement>(`#${input(element).getAttribute("aria-activedescendant")}`)!;
    expect(active.getAttribute("aria-disabled")).toBeNull();
    expect(active.getAttribute("aria-selected")).toBe("true");
    expect(palette(element)!.querySelector('[role="listbox"]')).not.toBeNull();
    const all = labels(element);
    expect(all).toContain("Go to the Logic workspace");
    expect(all).toContain("Add Date");
    // The data grid is offered like any other container.
    expect(all).toContain("Add Data grid");
    expect(all).toContain("Go to Full name");
    expect(all).toContain("Undo");
    // Nothing to undo yet: listed, but not offered.
    const undo = [...palette(element)!.querySelectorAll<HTMLElement>("[data-palette-option]")].find((option) => option.textContent!.includes("Undo"))!;
    expect(undo.getAttribute("aria-disabled")).toBe("true");
  });

  it("filters as you type and runs the highlighted command on Enter, through the control's own path", async () => {
    const element = await mount();
    await open(element);
    type(element, "logic work");
    expect(labels(element)[0]).toBe("Go to the Logic workspace");
    press(element, "Enter");
    expect(element.builder!.workspace).toBe("logic");
    expect(dialog(element)!.open).toBe(false);
  });

  it("adds a component after the selection", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    await open(element);
    type(element, "add date");
    press(element, "Enter");
    const ids = controller.treeView().slots[0]!.children.map((child) => child.id);
    expect(controller.selectedComponentId()).toBe(ids[1]);
    expect(controller.treeView().slots[0]!.children[1]!.type).toBe("date");
  });

  it("moves the highlight with the arrows, and lists the last commands run first", async () => {
    const element = await mount();
    await open(element);
    type(element, "go to");
    const second = labels(element)[1]!;
    press(element, "ArrowDown");
    expect(input(element).getAttribute("aria-activedescendant")).toBe("palette-option-1");
    press(element, "Enter");
    await open(element);
    expect(labels(element)[0]).toBe(second);
    expect(palette(element)!.querySelector('[data-palette-option="0"] .palette-group')!.textContent).toBe("Recent");
  });

  it("offers the page's own commands, and opens from the bar's button", async () => {
    const element = await mount();
    let saved = 0;
    element.registerCommands({ commands: () => [{ id: "host:save", label: "Save the form", group: "host", run: () => void saved++ }] });
    shell(element).querySelector<HTMLButtonElement>("[data-palette-open]")!.click();
    await until(() => dialog(element)?.open);
    type(element, "save");
    expect(labels(element)[0]).toBe("Save the form");
    press(element, "Enter");
    expect(saved).toBe(1);
  });

  it("closes on Escape, giving focus back", async () => {
    const element = await mount();
    const button = shell(element).querySelector<HTMLButtonElement>("[data-palette-open]")!;
    button.focus();
    await element.openPalette();
    expect(dialog(element)!.open).toBe(true);
    dialog(element)!.dispatchEvent(new Event("cancel", { cancelable: true }));
    expect(dialog(element)!.open).toBe(false);
    expect(shell(element).activeElement).toBe(button);
  });
});
