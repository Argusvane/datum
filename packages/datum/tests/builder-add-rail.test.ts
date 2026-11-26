import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { FormDefinition } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { BUILDER_DRAG_MIME_TYPE } from "@argusvane/datum-engine";

import { sampleDefinition, until } from "./helpers.js";

/** The component rail, the palette's insert-after, and the canvas bar's stepper. */

afterEach(() => {
  document.body.innerHTML = "";
});

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const rail = (element: DatumFormBuilderElement): HTMLElement => shell(element).querySelector<HTMLElement>("[data-add-rail]")!;
const canvas = (element: DatumFormBuilderElement): ShadowRoot => shell(element).querySelector("datum-builder-canvas")!.shadowRoot!;
const ids = (element: DatumFormBuilderElement): string[] => (element.builder!.controller.treeView().slots[0]?.children ?? []).map((child) => child.id);

async function mount(definition: FormDefinition = sampleDefinition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => rail(element)?.querySelector("[data-rail-add]"));
  return element;
}

function withSteps(): FormDefinition {
  const definition = sampleDefinition();
  definition.root.children!.content!.push({
    id: "wizard",
    type: "steps",
    configuration: {},
    children: {
      content: [
        { id: "about", type: "step", configuration: { label: "About you" }, children: { content: [{ id: "given", type: "text", configuration: { label: "Given name" } }] } },
        { id: "business", type: "step", configuration: { label: "Business details" }, children: { content: [{ id: "legal", type: "text", configuration: { label: "Legal name" } }] } }
      ]
    }
  });
  return definition;
}

describe("component rail", () => {
  it("offers the common types in order, then All components, as one Tab stop", async () => {
    const element = await mount();
    const buttons = [...rail(element).querySelectorAll<HTMLElement>("button")];
    expect(rail(element).getAttribute("role")).toBe("toolbar");
    expect(buttons.slice(0, 3).map((button) => button.dataset.railAdd)).toEqual(["text", "textarea", "number"]);
    expect(buttons.length).toBeLessThanOrEqual(10);
    expect(buttons.at(-1)!.getAttribute("aria-label")).toBe("All components");
    expect(buttons.filter((button) => button.tabIndex === 0)).toHaveLength(1);
    buttons[0]!.focus();
    buttons[0]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(shell(element).activeElement).toBe(buttons[1]);
    expect(buttons[1]!.tabIndex).toBe(0);
  });

  it("adds after the selection, or at the end with none", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("fullName");
    rail(element).querySelector<HTMLButtonElement>('[data-rail-add="number"]')!.click();
    const added = controller.selectedComponentId()!;
    expect(ids(element)[1]).toBe(added);
    controller.select(undefined);
    rail(element).querySelector<HTMLButtonElement>('[data-rail-add="text"]')!.click();
    expect(ids(element).at(-1)).toBe(controller.selectedComponentId());
  });

  it("opens the palette from All components, and shows only in Form", async () => {
    const element = await mount();
    const more = (): HTMLButtonElement => rail(element).querySelector<HTMLButtonElement>("[data-rail-more]")!;
    element.builder!.panel = undefined;
    more().click();
    expect(element.builder!.panel).toBe("components");
    expect(more().getAttribute("aria-pressed")).toBe("true");
    // A second press puts the palette away, as the strip's own items do.
    more().click();
    expect(element.builder!.panel).toBeUndefined();
    expect(more().getAttribute("aria-pressed")).toBe("false");
    more().click();
    element.builder!.setWorkspace("data");
    expect(rail(element).hidden).toBe(true);
    element.builder!.setWorkspace("form");
    expect(rail(element).hidden).toBe(false);
  });

  it("drags a type onto the canvas as the palette's rows do", async () => {
    const element = await mount();
    const button = rail(element).querySelector<HTMLButtonElement>('[data-rail-add="date"]')!;
    expect(button.getAttribute("draggable")).toBe("true");
    const written = new Map<string, string>();
    const dataTransfer = { effectAllowed: "none", dropEffect: "none", setData: (mime: string, data: string) => written.set(mime, data), getData: () => "" };
    const event = new Event("dragstart", { bubbles: true, composed: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    button.dispatchEvent(event);
    // The palette's copy drag: a new date component the canvas's drop zones take.
    expect(dataTransfer.effectAllowed).toBe("copy");
    const payload = JSON.parse(written.get(BUILDER_DRAG_MIME_TYPE)!) as { kind: string; component: { type: string } };
    expect(payload.kind).toBe("template-component");
    expect(payload.component.type).toBe("date");
    // All components is a button that opens the palette, never a drag.
    expect(rail(element).querySelector("[data-rail-more]")!.getAttribute("draggable")).toBeNull();
  });

  it("makes the palette's click add after the selection too", async () => {
    const element = await mount();
    const controller = element.builder!.controller;
    controller.select("country");
    element.builder!.panel = "components";
    const palette = shell(element).querySelector("datum-builder-toolbar")!.shadowRoot!;
    await until(() => palette.querySelector('[data-add-type="date"]'));
    palette.querySelector<HTMLButtonElement>('[data-add-type="date"]')!.click();
    expect(ids(element)[2]).toBe(controller.selectedComponentId());
  });
});

describe("canvas stepper", () => {
  it("is absent without steps", async () => {
    const element = await mount();
    expect(canvas(element).querySelector<HTMLElement>("[data-canvas-stepper]")!.hidden).toBe(true);
  });

  it("walks the steps of the form, saying which", async () => {
    const element = await mount(withSteps());
    const stepper = canvas(element).querySelector<HTMLElement>("[data-canvas-stepper]")!;
    await until(() => !stepper.hidden);
    const text = (): string => canvas(element).querySelector("[data-stepper-text]")!.textContent!;
    expect(text()).toBe("Step 1 of 2 · About you");
    const back = stepper.querySelector<HTMLButtonElement>('[data-stepper-go="-1"]')!;
    const next = stepper.querySelector<HTMLButtonElement>('[data-stepper-go="1"]')!;
    expect(back.disabled).toBe(true);
    next.click();
    expect(text()).toBe("Step 2 of 2 · Business details");
    expect(next.disabled).toBe(true);
    const form = canvas(element).querySelector("datum-form-renderer[data-preview]")!.shadowRoot!;
    await until(() => form.querySelector<HTMLElement>('[data-step-panel="business"]') && !form.querySelector<HTMLElement>('[data-step-panel="business"]')!.hidden);
    expect(element.builder!.controller.selectedComponentId()).toBeUndefined();
  });
});
