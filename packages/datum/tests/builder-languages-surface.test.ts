import { afterEach, describe, expect, it } from "vitest";

import "../src/builder.js";
import { sourceHash } from "@argusvane/datum-engine";
import type { DatumFormBuilderElement } from "../src/builder.js";

import { sampleDefinition, until } from "./helpers.js";

/**
 * The Languages workspace through `<datum-form-builder>`: the wrapper opens the surface,
 * feeds it the host's catalog from its `translations` property, and reads the form's translations
 * back into `definition`. The surface itself (cards, switcher row, texts, pending bar, export and
 * import) is held to account in the engine's own suites (`builder-languages-surface`,
 * `languages-exchange-dialog`); this file is what only the wrapper can show.
 */

afterEach(() => {
  document.body.innerHTML = "";
});

async function mount(setup?: (element: DatumFormBuilderElement) => void): Promise<DatumFormBuilderElement> {
  const element = document.createElement("datum-form-builder");
  element.definition = sampleDefinition();
  setup?.(element);
  document.body.append(element);
  await until(() => element.builder?.shadowRoot?.querySelector("datum-builder-canvas"));
  return element;
}

const shell = (element: DatumFormBuilderElement): ShadowRoot => element.builder!.shadowRoot!;

/** Opens the workspace and returns the surface's shadow root, once its rows are drawn. */
async function languages(element: DatumFormBuilderElement): Promise<ShadowRoot> {
  element.builder!.setWorkspace("languages");
  const surface = (): ShadowRoot | null => shell(element).querySelector("datum-builder-languages")?.shadowRoot ?? null;
  await until(() => surface()?.querySelector("[data-languages-row]"));
  return surface()!;
}

const cell = (root: ShadowRoot, key: string, locale: string): HTMLInputElement =>
  root.querySelector<HTMLInputElement>(`input[data-languages-cell="${key}"][data-languages-locale="${locale}"]`)!;

function type(input: HTMLInputElement, text: string): void {
  input.focus();
  input.value = text;
  input.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
}

const codes = (element: DatumFormBuilderElement): string[] =>
  (element.definition.localization?.supportedLocales ?? []).map((entry) => (typeof entry === "string" ? entry : entry.code));

describe("the Languages workspace in <datum-form-builder>", () => {
  it("lists the form's languages and texts, and shows what the host's catalog words read-only (the `translations` property)", async () => {
    const element = await mount((el) => {
      el.translations = { "fr-CA": { components: { fullName: { label: "Nom (catalogue)" } } } };
    });
    const root = await languages(element);
    expect([...root.querySelectorAll<HTMLElement>("[data-languages-lang]")].map((card) => card.dataset.languagesLang)).toEqual(["en", "fr-CA"]);
    expect(root.querySelector('[data-languages-lang="en"] [data-languages-default-badge]')).toBeTruthy();
    // The form's own French for the label is overridden by the page's catalog: locked, and the catalog's text shows.
    expect(cell(root, "components/fullName/label", "fr-CA").readOnly).toBe(true);
    expect(cell(root, "components/fullName/label", "fr-CA").value).toBe("Nom (catalogue)");
    // A text only the form words is editable.
    expect(root.querySelector('[data-languages-row="components/country/label"]')).toBeTruthy();
    expect(cell(root, "components/country/label", "fr-CA").readOnly).toBe(false);
    expect(root.querySelector("[data-languages-catalog-note]")).toBeTruthy();

    // A page with no catalog locks nothing and says nothing about one.
    const bare = await mount();
    const bareRoot = await languages(bare);
    expect(cell(bareRoot, "components/fullName/label", "fr-CA").readOnly).toBe(false);
    expect(bareRoot.querySelector("[data-languages-catalog-note]")).toBeNull();
  });

  it("holds typed cells until Apply, then writes them as one undo step that `definition.translations` carries", async () => {
    const element = await mount();
    const root = await languages(element);
    const controller = element.controller!;
    const before = JSON.stringify(element.definition.translations);

    type(cell(root, "components/country/label", "fr-CA"), "Pays");
    type(cell(root, "components/subscribe/label", "fr-CA"), "S'abonner");
    // Typing writes nothing yet.
    expect(JSON.stringify(element.definition.translations)).toBe(before);
    expect(root.querySelector("[data-languages-pending-count]")!.textContent).toBe("2 changes");

    root.querySelector<HTMLButtonElement>("[data-languages-apply]")!.click();
    const translations = element.definition.translations!["fr-CA"]!.components!;
    expect(translations.country!.label).toEqual({ text: "Pays", source: sourceHash("Country") });
    expect(translations.subscribe!.label).toEqual({ text: "S'abonner", source: sourceHash("Subscribe") });
    // The label translated in the sample stays beside them.
    expect(translations.fullName!.label).toMatchObject({ text: "Nom complet" });

    controller.undo();
    expect(JSON.stringify(element.definition.translations)).toBe(before);
  });

  it("adds a language and removes one after asking, and the definition and the host's count follow", async () => {
    const element = await mount();
    const root = await languages(element);

    type(root.querySelector<HTMLInputElement>("[data-languages-add-code]")!, "es");
    root.querySelector<HTMLButtonElement>("[data-languages-add]")!.click();
    await until(() => root.querySelector('[data-languages-lang="es"]'));
    expect(codes(element)).toEqual(["en", "fr-CA", "es"]);

    // Removing French asks first, naming what goes with it; Keep it leaves everything as it was.
    root.querySelector<HTMLButtonElement>('[data-languages-remove="fr-CA"]')!.click();
    expect(root.querySelector("[data-languages-confirm]")!.textContent).toContain("1 translation");
    root.querySelector<HTMLButtonElement>("[data-languages-remove-keep]")!.click();
    expect(codes(element)).toEqual(["en", "fr-CA", "es"]);
    expect(element.definition.translations).toBeDefined();

    root.querySelector<HTMLButtonElement>('[data-languages-remove="fr-CA"]')!.click();
    root.querySelector<HTMLButtonElement>("[data-languages-remove-confirm]")!.click();
    expect(codes(element)).toEqual(["en", "es"]);
    // The form's own French is gone from the definition; nothing remains to carry, so the section goes.
    expect(element.definition.translations).toBeUndefined();
    // A host keeping a catalog of its own hears the net change at Save (the form's translations need no telling).
    expect(element.localeChangesSinceSave()).toEqual({ removed: ["fr-CA"], renamed: [] });

    element.controller!.undo();
    expect(codes(element)).toEqual(["en", "fr-CA", "es"]);
    expect(element.definition.translations!["fr-CA"]!.components!.fullName!.label).toMatchObject({ text: "Nom complet" });
    expect(element.localeChangesSinceSave()).toEqual({ removed: [], renamed: [] });
  });

  it("previews an imported file before it changes anything, then writes it as one undo step", async () => {
    const element = await mount();
    const root = await languages(element);
    const before = JSON.stringify(element.definition.translations);

    root.querySelector<HTMLButtonElement>("[data-languages-import]")!.click();
    await until(() => root.querySelector("[data-exchange-file]"));
    const file = new File(
      [
        JSON.stringify({
          defaultLocale: "en",
          locales: ["fr-CA"],
          texts: [
            { kind: "components", key: "fullName", path: "label", default: "Full name", "fr-CA": "Prénom et nom" },
            { kind: "components", key: "country", path: "label", default: "Country", "fr-CA": "Pays" },
            { kind: "components", key: "nothing", path: "label", default: "Nothing", "fr-CA": "Rien" }
          ]
        })
      ],
      "translations.json",
      { type: "application/json" }
    );
    const input = root.querySelector<HTMLInputElement>("[data-exchange-file]")!;
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
    await until(() => root.querySelector('[data-exchange-count="changed"]'));
    // One changed (the French label), one new (the country), one the form does not have: nothing written yet.
    expect(root.querySelector('[data-exchange-count="changed"]')!.textContent).toContain("1");
    expect(root.querySelector('[data-exchange-count="new"]')!.textContent).toContain("1");
    expect(root.querySelector('[data-exchange-count="unknown"]')!.textContent).toContain("1");
    expect(JSON.stringify(element.definition.translations)).toBe(before);

    root.querySelector<HTMLButtonElement>("[data-exchange-apply]")!.click();
    await until(() => element.definition.translations?.["fr-CA"]?.components?.country !== undefined);
    const components = element.definition.translations!["fr-CA"]!.components!;
    expect(components.fullName!.label).toMatchObject({ text: "Prénom et nom" });
    expect(components.country!.label).toMatchObject({ text: "Pays" });
    expect(components.nothing).toBeUndefined();

    element.controller!.undo();
    expect(JSON.stringify(element.definition.translations)).toBe(before);
  });

  it("takes the author from a text to its component with Show it in Form", async () => {
    const element = await mount();
    const root = await languages(element);
    const goto = root.querySelector<HTMLElement>('[data-languages-row="components/subscribe/label"] [data-languages-goto]')!;
    goto.click();
    await until(() => element.builder!.workspace === "form");
    expect(element.controller!.selectedComponentId()).toBe("subscribe");
  });

  it("keeps the form's translations across a definition handed to the wrapper, and reads none back for a form with none", async () => {
    const element = await mount();
    expect(element.definition.translations).toEqual(sampleDefinition().translations);
    const { translations: _gone, ...bare } = sampleDefinition();
    element.definition = bare;
    await until(() => element.controller?.translations() === undefined);
    expect(element.definition.translations).toBeUndefined();
  });
});

describe("the options dialog at short heights", () => {
  it("tightens the tools and keeps the grid a scrolling region of its own under 700px of height", async () => {
    const { OPTIONS_EDITOR_STYLES } = await import("../../../engine/form-engine/builder/web-component/builder-shared.js");
    expect(OPTIONS_EDITOR_STYLES).toMatch(/@media \(max-height: 700px\) \{[^@]*\.db-options-scroll \{ min-height: 180px; \}/);
    expect(OPTIONS_EDITOR_STYLES).toMatch(/@media \(max-height: 700px\) \{[^@]*\.db-options-tools \{ gap: var\(--db-space-1\); \}/);
    expect(OPTIONS_EDITOR_STYLES).toMatch(/\.db-options-scroll \{\s*flex: 1;[^}]*overflow: auto;/);
  });
});
