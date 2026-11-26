// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";

import { BuilderController } from "../form-engine/builder/controller/builder-controller.js";
import { buildInspectorModel } from "../form-engine/builder/property-editor/inspector-model.js";
import { DATUM_BUILDER_PROPERTIES_TAG, defineBuilderPanels, type DatumBuilderPropertiesElement } from "../form-engine/builder/web-component/builder-panels.js";
import { propertiesPanelHtml, translationPointerHtml } from "../form-engine/builder/web-component/builder-shared.js";
import { buildNestedTreeView } from "../form-engine/builder/tree-editor/nested-tree-view.js";
import { addressOf, writeTranslation, type FormTranslations } from "../form-engine/core/localization/translations.js";
import type { ComponentNode, LocalizationConfiguration } from "../form-engine/core/schema/types.js";
import { LANGUAGES, languagesController, languagesTranslations } from "./fixtures/builder-languages.js";

/*
 * The inspector does not edit translations. A `localized-text` field is a
 * plain box for the default-language string; under a component's texts, when the form declares
 * more than one language, one line says how far each language has come and leads to the Languages
 * workspace filtered to the component. jsdom applies no shadow CSS: the markup, attributes and
 * events are what is asserted.
 */

defineBuilderPanels();

afterEach(() => {
  document.body.innerHTML = "";
});

describe("the pointer line's markup", () => {
  it("lists the languages that have everything, then each that lacks some with how many, and offers Languages", () => {
    const html = translationPointerHtml([
      { code: "fr", label: "Français", missing: 0 },
      { code: "es", label: "Español", missing: 1 }
    ]);
    expect(html).toContain("data-translation-pointer");
    expect(html).toContain('<span class="translation-pointer-text" data-translation-coverage>Translated in Français · Español 1 missing</span>');
    expect(html).toContain('data-open-in-languages>Open in Languages</button>');
  });

  it("says only what is missing when no language is complete, and only what is done when none lacks", () => {
    expect(
      translationPointerHtml([
        { code: "fr", label: "Français", missing: 2 },
        { code: "es", label: "Español", missing: 3 }
      ])
    ).toContain(">Français 2 missing · Español 3 missing<");
    expect(
      translationPointerHtml([
        { code: "fr", label: "Français", missing: 0 },
        { code: "es", label: "Español", missing: 0 }
      ])
    ).toContain(">Translated in Français · Español<");
  });

  it("words every sentence through the builder's own texts, so a host's catalog translates them", () => {
    const html = translationPointerHtml(
      [
        { code: "fr", label: "Français", missing: 0 },
        { code: "es", label: "Español", missing: 2 }
      ],
      {
        locale: "fr",
        catalog: {
          fr: {
            "inspector.pointer.done": "Traduit en {languages}",
            "inspector.pointer.missing": "{language} : {count} manquant",
            "inspector.pointer.open": "Ouvrir dans Langues"
          }
        }
      }
    );
    expect(html).toContain(">Traduit en Français · Español : 2 manquant<");
    expect(html).toContain("data-open-in-languages>Ouvrir dans Langues</button>");
  });

  it("draws nothing for a component with no coverage to speak of, and escapes a language's name", () => {
    expect(translationPointerHtml([])).toBe("");
    expect(translationPointerHtml([{ code: "x", label: "<b>X</b>", missing: 1 }])).toContain("&lt;b&gt;X&lt;/b&gt; 1 missing");
  });
});

describe("the pointer line in the properties markup", () => {
  const node: ComponentNode = { id: "name", type: "text", configuration: { label: "Full name", description: "As on your ID" } };
  const options = (extra: object = {}) => ({
    tab: "properties" as const,
    treeView: buildNestedTreeView(node),
    hiddenIds: new Set<string>(),
    idError: undefined,
    idEditable: true,
    isRoot: false,
    ...extra
  });

  it("sits at the end of the section holding the texts, after the boxes, not in the ID card", () => {
    const model = buildInspectorModel(node);
    const html = propertiesPanelHtml(model, node, options({ translationCoverage: [{ code: "fr", label: "Français", missing: 1 }] }));
    const content = html.slice(html.indexOf('data-inspector-section="content"'));
    expect(content.indexOf("data-translation-pointer")).toBeGreaterThan(content.indexOf('data-prop="description"'));
    expect(html.indexOf("data-translation-pointer")).toBeGreaterThan(html.indexOf('data-inspector-about'));
    const about = html.slice(html.indexOf("data-inspector-about"), html.indexOf('data-inspector-section="content"'));
    expect(about).not.toContain("data-translation-pointer");
    // The old Translations row and its grid are gone with their protocol.
    expect(html).not.toContain("data-translations-edit");
    expect(html).not.toContain("data-translations-count");
  });

  it("draws a localized-text field as one plain box for the default-language text", () => {
    const html = propertiesPanelHtml(buildInspectorModel(node), node, options());
    expect(html).toMatch(/<input data-prop="label" data-control="localized-text"[^>]* type="text" value="Full name" \/>/);
    expect(html).not.toContain("data-localized-part");
    expect(html).not.toContain("data-translation-pointer");
  });
});

describe("the pointer line on the inspector panel", () => {
  const three: LocalizationConfiguration = { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }, { code: "es", label: "Español" }], defaultLocale: "en" };

  /** The fixture form in `localization`, carrying `map` as its translations. */
  function formWith(localization: LocalizationConfiguration, map: FormTranslations): BuilderController {
    const controller = languagesController(localization);
    controller.replaceTranslations(map, { silent: true });
    return controller;
  }

  function mount(controller: BuilderController, id: string, languagesWorkspace = true): DatumBuilderPropertiesElement {
    const panel = document.createElement(DATUM_BUILDER_PROPERTIES_TAG) as DatumBuilderPropertiesElement;
    panel.languagesWorkspace = languagesWorkspace;
    panel.controller = controller;
    document.body.append(panel);
    controller.select(id);
    return panel;
  }
  const coverageOf = (panel: DatumBuilderPropertiesElement): string | undefined =>
    panel.shadowRoot!.querySelector("[data-translation-coverage]")?.textContent ?? undefined;

  it("counts, per language, the texts of the component with no current translation", () => {
    // `name` has a French label; its description and its `required` message are untranslated, and Spanish has nothing.
    const panel = mount(formWith(three, languagesTranslations()), "name");
    expect(coverageOf(panel)).toBe("Français 2 missing · Español 3 missing");
  });

  it("lists a language as translated once it has every text, and counts a stale entry as missing", () => {
    let map: FormTranslations = {};
    for (const locale of ["fr", "es"]) {
      map = writeTranslation(map, locale, addressOf.component("name", "label"), "Nom", "Full name");
      map = writeTranslation(map, locale, addressOf.component("name", "description"), "Comme sur votre pièce", "As on your ID");
      map = writeTranslation(map, locale, addressOf.message("name", "required"), "Entrez votre nom", "Enter your name");
    }
    // Spanish answers an older wording of the label: its source no longer matches the default.
    map = writeTranslation(map, "es", addressOf.component("name", "label"), "Nombre", "Name");
    const panel = mount(formWith(three, map), "name");
    expect(coverageOf(panel)).toBe("Translated in Français · Español 1 missing");
  });

  it("counts a text the page's catalog words as translated, as the Languages grid does", () => {
    const controller = formWith(LANGUAGES, languagesTranslations());
    // `name` lacks a French description and `required` message in the map; the page words both.
    controller.setTranslationCatalog({ fr: { components: { name: { description: "Comme sur la pièce (page)", messages: { required: "Entrez votre nom (page)" } } } } });
    const panel = mount(controller, "name");
    expect(coverageOf(panel)).toBe("Translated in Français");
    // A catalog that words only one of them leaves the other counted as missing.
    document.body.innerHTML = "";
    const partly = formWith(LANGUAGES, languagesTranslations());
    partly.setTranslationCatalog({ fr: { components: { name: { description: "Comme sur la pièce (page)" } } } });
    expect(coverageOf(mount(partly, "name"))).toBe("Français 1 missing");
  });

  it("draws no line for a form in one language, and none for a component with no text", () => {
    const single = languagesController(null);
    expect(coverageOf(mount(single, "name"))).toBeUndefined();
    document.body.innerHTML = "";
    // Two languages (English, French): the field's line speaks of French alone.
    expect(coverageOf(mount(formWith(LANGUAGES, languagesTranslations()), "name"))).toBe("Français 2 missing");
  });

  it("leaves the line out when the translations feature is off", () => {
    const controller = languagesController();
    const panel = mount(controller, "name");
    expect(coverageOf(panel)).toBeDefined();
    panel.inspectorFeatures = { translations: false };
    expect(coverageOf(panel)).toBeUndefined();
  });

  it("asks the shell for Languages on this component, through the event the workspace already uses", () => {
    const controller = languagesController();
    const panel = mount(controller, "kind");
    const heard: Array<{ componentId: string }> = [];
    document.body.addEventListener("builder-languages-goto", (event) => heard.push((event as CustomEvent<{ componentId: string }>).detail));
    panel.shadowRoot!.querySelector<HTMLButtonElement>("[data-open-in-languages]")!.click();
    expect(heard).toEqual([{ componentId: "kind" }]);
  });

  it("says the coverage without the button when the shell offers no Languages workspace", () => {
    const panel = mount(languagesController(), "name", false);
    expect(coverageOf(panel)).toBeDefined();
    expect(panel.shadowRoot!.querySelector("[data-open-in-languages]")).toBeNull();
  });

  it("follows the map: a translation written elsewhere changes the line at the next change", () => {
    const controller = languagesController();
    const panel = mount(controller, "name");
    expect(coverageOf(panel)).toBe("Français 2 missing");
    controller.setTranslations([{ locale: "fr", address: addressOf.component("name", "description"), text: "Comme sur votre pièce" }]);
    expect(coverageOf(panel)).toBe("Français 1 missing");
  });
});
