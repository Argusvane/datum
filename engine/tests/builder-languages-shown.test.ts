// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { DatumBuilderLanguagesElement } from "../form-engine/builder/languages/languages-surface.js";
import type { DatumBuilderCanvasElement } from "../form-engine/builder/web-component/builder-panels.js";
import { defineDatumBuilderElement, type DatumBuilderElement } from "../form-engine/builder/web-component/default-builder-element.js";
import { LANGUAGES, languagesRoot, languagesTranslations } from "./fixtures/builder-languages.js";

/*
 * The shell shows and hides the Languages surface with its workspace (`shown`, as Print's): once
 * the author has left Languages, an edit in Form costs the surface nothing, and the surface draws
 * the edit once when the author comes back.
 */

defineDatumBuilderElement();

afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

async function until(check: () => unknown, timeoutMs = 4000): Promise<void> {
  const started = Date.now();
  for (;;) {
    if (check()) {
      return;
    }
    if (Date.now() - started > timeoutMs) {
      throw new Error("until(): condition not met in time");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const canvasOf = (element: DatumBuilderElement): DatumBuilderCanvasElement => element.shadowRoot!.querySelector(".canvas") as DatumBuilderCanvasElement;

async function mount(): Promise<DatumBuilderElement> {
  const element = document.createElement("datum-builder") as DatumBuilderElement;
  element.options = { initialRoot: languagesRoot(), localization: LANGUAGES, translations: languagesTranslations(), componentTypes: [{ type: "text", label: "Text" }, { type: "radio", label: "Choice" }] };
  document.body.append(element);
  await until(() => canvasOf(element)?.previewRoot()?.querySelector(".db-node[data-component-id]"));
  return element;
}

describe("the Languages surface beside its workspace", () => {
  it("is hidden while another workspace is on, computes nothing for an edit there, and draws it on return", async () => {
    const element = await mount();
    element.setWorkspace("languages");
    await until(() => element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")?.locale);
    const surface = element.shadowRoot!.querySelector<DatumBuilderLanguagesElement>("datum-builder-languages")!;
    expect(surface.shown).toBe(true);
    element.setWorkspace("form");
    expect(surface.shown).toBe(false);
    const compute = vi.spyOn(surface as unknown as { computeTexts: () => unknown }, "computeTexts");
    element.controller.setProperty("name", "label", "Your name");
    expect(compute).not.toHaveBeenCalled();
    element.setWorkspace("languages");
    expect(surface.shown).toBe(true);
    const nameCell = surface.shadowRoot!.querySelector<HTMLInputElement>('[data-languages-cell="components/name/label"][data-languages-locale="fr"]')!;
    expect(nameCell.closest("td")!.classList.contains("stale")).toBe(true);
  });
});
