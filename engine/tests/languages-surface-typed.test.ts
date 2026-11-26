// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import type { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { defineLanguagesSurface, DATUM_BUILDER_LANGUAGES_TAG, type DatumBuilderLanguagesElement } from "../form-engine/builder/languages/languages-surface.js";
import { languagesController } from "./fixtures/builder-languages.js";

defineLanguagesSurface();

afterEach(() => {
  document.body.innerHTML = "";
});

const THREE = { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }, { code: "de" }], defaultLocale: "en" };

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) {
    throw new Error(`nothing matches ${selector}`);
  }
  return found;
};

function type(box: HTMLInputElement, value: string): void {
  box.value = value;
  box.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

function mount(controller: BuilderController = languagesController(THREE)): { controller: BuilderController; root: ShadowRoot } {
  const surface = document.createElement(DATUM_BUILDER_LANGUAGES_TAG) as DatumBuilderLanguagesElement;
  surface.controller = controller;
  document.body.append(surface);
  return { controller, root: surface.shadowRoot! };
}

const DESCRIPTION = '[data-languages-cell="components/name/description"][data-languages-locale="fr"]';

describe("typed cells and a change of the default language", () => {
  it("Make default applies the cells typed for the promoted language, and says so first", () => {
    const { root, controller } = mount();
    type(q<HTMLInputElement>(root, DESCRIPTION), "Comme sur votre pièce d'identité");
    q(root, '[data-languages-menu="fr"]').click();
    q(root, '[data-languages-default="fr"]').click();
    expect(q(root, "[data-languages-default-typed]").textContent).toMatch(/applied first/);
    q(root, "[data-languages-default-confirm]").click();
    expect(controller.getProperty("name", "description")).toBe("Comme sur votre pièce d'identité");
    expect(controller.localization()?.defaultLocale).toBe("fr");
    // Nothing typed is left waiting for a language that has no column any more.
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
  });

  it("keeping the old default leaves the cells typed", () => {
    const { root, controller } = mount();
    type(q<HTMLInputElement>(root, DESCRIPTION), "Typed fr");
    q(root, '[data-languages-menu="fr"]').click();
    q(root, '[data-languages-default="fr"]').click();
    q(root, "[data-languages-default-keep]").click();
    expect(controller.localization()?.defaultLocale).toBe("en");
    expect(controller.getProperty("name", "description")).toBe("As on your ID");
    expect(q<HTMLInputElement>(root, DESCRIPTION).value).toBe("Typed fr");
  });

  it("removing the default language applies the cells typed for the one that takes its place", () => {
    const { root, controller } = mount();
    type(q<HTMLInputElement>(root, DESCRIPTION), "Typed fr");
    q(root, '[data-languages-menu="en"]').click();
    q(root, '[data-languages-remove="en"]').click();
    expect(q(root, "[data-languages-confirm]").textContent).toMatch(/applied first/);
    q(root, "[data-languages-remove-confirm]").click();
    expect(controller.localization()?.defaultLocale).toBe("fr");
    expect(controller.getProperty("name", "description")).toBe("Typed fr");
    expect(q(root, "[data-languages-pending]").hasAttribute("hidden")).toBe(true);
  });
});

describe("Enter while composing", () => {
  function enter(box: HTMLElement, init: KeyboardEventInit = {}): void {
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, composed: true, ...init }));
  }

  function oneLanguage(): { root: ShadowRoot; title: HTMLInputElement } {
    const { root } = mount(languagesController(THREE));
    q(root, '[data-languages-view="one"]').click();
    const title = q<HTMLInputElement>(root, '[data-languages-cell="form/title"][data-languages-locale="fr"]');
    title.focus();
    return { root, title };
  }

  it("does not move to the next cell while an input method is composing", () => {
    const { root, title } = oneLanguage();
    enter(title, { isComposing: true });
    expect(root.activeElement).toBe(title);
  });

  it("does not move on the keydown Safari sends after the composition ended (keyCode 229)", () => {
    const { root, title } = oneLanguage();
    enter(title, { keyCode: 229 });
    expect(root.activeElement).toBe(title);
  });

  it("still moves on a plain Enter", () => {
    const { root, title } = oneLanguage();
    enter(title);
    expect(root.activeElement).not.toBe(title);
  });
});
