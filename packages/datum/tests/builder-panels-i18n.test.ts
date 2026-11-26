import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(definition = sampleDefinition()): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = definition;
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

describe("the panels' words", () => {
  it("relabels the canvas's controls in place when the builder's words change, and hands Try it the same words", async () => {
    const element = await mount();
    const canvas = shell(element).querySelector("datum-builder-canvas") as HTMLElement & {
      textLocale: string | undefined;
      textCatalog: Record<string, Record<string, string>> | undefined;
    };
    await until(() => canvas.shadowRoot?.querySelector("[data-try-it]"));
    const root = canvas.shadowRoot!;
    const tryIt = root.querySelector<HTMLElement>("[data-try-it]")!;
    expect(tryIt.textContent).toBe("Try it");
    const preview = root.querySelector("[data-preview]");
    canvas.textLocale = "fr";
    canvas.textCatalog = { fr: { "canvas.tryIt": "Essayer", "canvas.fit": "Ajuster", "canvas.zoomOut": "Réduire" } };
    expect(root.querySelector<HTMLElement>("[data-try-it]")!.textContent).toBe("Essayer");
    expect(root.querySelector('[data-canvas-zoom-go="fit"]')!.textContent).toBe("Ajuster");
    expect(root.querySelector('[data-canvas-zoom-go="out"]')!.getAttribute("aria-label")).toBe("Réduire");
    // Relabelled, not rebuilt: the renderer element (and the caret in it) is the same one.
    expect(root.querySelector("[data-preview]")).toBe(preview);
  });
});
