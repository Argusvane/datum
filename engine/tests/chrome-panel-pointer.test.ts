// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { DATUM_BUILDER_CHROME_PANEL_TAG, chromeRegionEditorHtml, defineBuilderChromePanel, type DatumBuilderChromePanelElement } from "../form-engine/builder/web-component/builder-chrome-panel.js";
import { addressOf, writeTranslation } from "../form-engine/core/localization/translations.js";
import { languagesController } from "./fixtures/builder-languages.js";

/*
 * The Header & footer panel draws the pointer line per part: how far
 * each language has come on that part's texts (counted by the Languages model) and, when the
 * shell offers the workspace, an Open in Languages that raises `builder-languages-goto` for the
 * part. jsdom applies no shadow CSS: markup, attributes and events are what is asserted.
 */

defineBuilderChromePanel();

afterEach(() => {
  document.body.innerHTML = "";
});

function mount(controller: BuilderController, languagesWorkspace = true): DatumBuilderChromePanelElement {
  const panel = document.createElement(DATUM_BUILDER_CHROME_PANEL_TAG) as DatumBuilderChromePanelElement;
  panel.languagesWorkspace = languagesWorkspace;
  panel.controller = controller;
  document.body.append(panel);
  return panel;
}

const lineOf = (panel: DatumBuilderChromePanelElement, partId: string): string | undefined =>
  panel.shadowRoot!.querySelector(`[data-chrome-part-id="${partId}"] [data-translation-coverage]`)?.textContent ?? undefined;

describe("the pointer line under a header or footer part", () => {
  it("counts each part's own texts per language and leaves out a part with no text", () => {
    const panel = mount(languagesController());
    // `welcome` is a heading whose text has no French; the switcher carries no label, so it has no text to count.
    expect(lineOf(panel, "welcome")).toBe("Français 1 missing");
    expect(lineOf(panel, "switcher")).toBeUndefined();
  });

  it("calls a part translated once its texts have French", () => {
    const controller = languagesController();
    controller.setTranslations([{ locale: "fr", address: addressOf.chrome("welcome", "text"), text: "Faites une demande" }]);
    expect(lineOf(mount(controller), "welcome")).toBe("Translated in Français");
  });

  it("counts a text the page's catalog words as translated", () => {
    const controller = languagesController();
    controller.setTranslationCatalog({ fr: { chrome: { welcome: { text: "Demande (page)" } } } });
    expect(lineOf(mount(controller), "welcome")).toBe("Translated in Français");
  });

  it("asks the shell for Languages filtered to the part, through the event the workspace already uses", () => {
    const panel = mount(languagesController());
    const heard: Array<{ kind: "chrome"; partId: string }> = [];
    document.body.addEventListener("builder-languages-goto", (event) => heard.push((event as CustomEvent<{ kind: "chrome"; partId: string }>).detail));
    const button = panel.shadowRoot!.querySelector<HTMLButtonElement>('[data-chrome-part-id="welcome"] [data-open-in-languages]')!;
    expect(button.getAttribute("aria-label")).toBe("Open in Languages: welcome");
    // WCAG 2.5.3: the accessible name starts with the visible text.
    expect(button.getAttribute("aria-label")!.startsWith(button.textContent!.trim())).toBe(true);
    button.click();
    expect(heard).toEqual([{ kind: "chrome", partId: "welcome" }]);
  });

  it("says the coverage without the button when the shell offers no Languages workspace, and nothing for one language", () => {
    const panel = mount(languagesController(), false);
    expect(lineOf(panel, "welcome")).toBeDefined();
    expect(panel.shadowRoot!.querySelector("[data-open-in-languages]")).toBeNull();
    document.body.innerHTML = "";
    expect(lineOf(mount(languagesController(null)), "welcome")).toBeUndefined();
    document.body.innerHTML = "";
    const off = mount(languagesController());
    off.translationsEnabled = false;
    expect(lineOf(off, "welcome")).toBeUndefined();
  });

  it("follows the map: a translation written elsewhere changes the line", () => {
    const controller = languagesController();
    const panel = mount(controller);
    expect(lineOf(panel, "welcome")).toBe("Français 1 missing");
    controller.replaceTranslations(writeTranslation({}, "fr", addressOf.chrome("welcome", "text"), "Faites une demande", "Apply for a permit"));
    expect(lineOf(panel, "welcome")).toBe("Translated in Français");
  });
});

describe("chromeRegionEditorHtml's pointer hook", () => {
  it("draws what the hook returns under each part's boxes, and nothing without one", () => {
    const parts = [{ id: "a", type: "text" as const, text: "A" }];
    expect(chromeRegionEditorHtml("header", parts)).not.toContain("POINTER");
    expect(chromeRegionEditorHtml("header", parts, undefined, (part) => `<i>POINTER ${part.id}</i>`)).toContain("<i>POINTER a</i>");
  });
});
