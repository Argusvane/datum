import { afterEach, describe, expect, it } from "vitest";
import { kernelStructureNameMax, kernelStructureVersionMax } from "@argusvane/datum-engine";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The Form panel's Identity section says what is wrong with the id or the version under its own
 * box, the way every other box does, and Save leads to it instead of doing nothing.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;
const formPanelRoot = (element: DatumFormBuilderElement): ShadowRoot => {
  const form = shell(element).querySelector("datum-builder-form-panel") as HTMLElement;
  if (form.hidden) {
    shell(element).querySelector<HTMLButtonElement>('[data-strip] [data-panel="form"]')!.click();
  }
  return form.shadowRoot!;
};

function type(input: HTMLInputElement, value: string): void {
  input.focus();
  input.value = value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("the Identity section's problems", () => {
  it("shows a too-long id and version under their boxes, names them for assistive technology, and clears them when fixed", async () => {
    const element = await mount();
    const root = formPanelRoot(element);
    await until(() => root.querySelector('input[data-identity-field="id"]'));
    const idBox = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[data-identity-field="id"]')!;
    const versionBox = (): HTMLInputElement => root.querySelector<HTMLInputElement>('input[data-identity-field="version"]')!;
    expect(root.querySelector('[data-problem="identity.id"]')).toBeNull();

    type(idBox(), "x".repeat(kernelStructureNameMax() + 1));
    const idNote = root.querySelector<HTMLElement>('[data-problem="identity.id"]');
    expect(idNote?.textContent).toBe(`The id can be at most ${kernelStructureNameMax()} characters.`);
    expect(idBox().getAttribute("aria-invalid")).toBe("true");
    expect(idBox().getAttribute("aria-describedby")).toContain(idNote!.id);
    expect(root.querySelector('[data-problem="identity.version"]')).toBeNull();

    type(versionBox(), "1".repeat(kernelStructureVersionMax() + 1));
    expect(root.querySelector('[data-problem="identity.version"]')?.textContent).toBe(`The version can be at most ${kernelStructureVersionMax()} characters.`);

    // Save leads to the first box rather than doing nothing, and the draft is still held.
    root.querySelector<HTMLButtonElement>("[data-inspector-save]")!.click();
    expect(element.definition.id).not.toBe("x".repeat(kernelStructureNameMax() + 1));
    await until(() => root.activeElement === idBox());

    type(idBox(), "intake");
    type(versionBox(), "2.0.0");
    expect(root.querySelector('[data-problem="identity.id"]')).toBeNull();
    expect(root.querySelector('[data-problem="identity.version"]')).toBeNull();
    expect(idBox().hasAttribute("aria-invalid")).toBe(false);
  });
});
