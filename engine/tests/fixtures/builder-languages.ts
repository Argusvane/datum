import { BuilderController } from "../../form-engine/builder/controller/builder-controller.js";
import { standardFieldCapabilities } from "../../form-engine/registry/capabilities/field-capabilities.js";
import { createInlineOptionsCapability } from "../../form-engine/core/schema/inline-options.js";
import type { ComponentDefinition } from "../../form-engine/core/schema/contracts.js";
import type { ComponentNode, LocalizationConfiguration } from "../../form-engine/core/schema/types.js";
import { addressOf, writeTranslation, type FormTranslations } from "../../form-engine/core/localization/translations.js";

/**
 * The surface and its loader, for the web components package's suite, which imports this file
 * as `@argusvane/datum-engine/tests/fixtures/builder-languages`: the engine's barrel exports neither.
 */
export { loadLanguagesSurface } from "../../form-engine/builder/languages/languages-loader.js";
export { DATUM_BUILDER_LANGUAGES_TAG, type DatumBuilderLanguagesElement } from "../../form-engine/builder/languages/languages-surface.js";

/**
 * The form both Languages suites work on: a title, a text field translated into
 * French, a choice whose options are half translated, a field's own message and the form's,
 * and a header with a heading and the language switcher (strings, with the French in
 * {@link languagesTranslations}).
 */
const DEFINITIONS: ComponentDefinition[] = [
  { type: "form", version: "1.0.0", createDefault: () => ({ id: "form", type: "form", configuration: {} }), capabilities: [], children: { slots: [{ id: "content", multiple: true }] } },
  { type: "text", version: "1.0.0", createDefault: () => ({ id: "text", type: "text", configuration: { label: "Text" } }), capabilities: standardFieldCapabilities() },
  {
    type: "radio",
    version: "1.0.0",
    createDefault: () => ({ id: "radio", type: "radio", configuration: { label: "Choice", options: [] } }),
    capabilities: [...standardFieldCapabilities(), createInlineOptionsCapability()]
  }
];

export function languagesRoot(): ComponentNode {
  return {
    id: "root",
    type: "form",
    configuration: {
      title: "Permit",
      messages: { required: "Answer this", "journey.exit": "You cannot send this form." },
      chrome: {
        header: [
          { id: "welcome", type: "heading", text: "Apply for a permit" },
          { id: "switcher", type: "language-switcher" }
        ]
      }
    },
    children: {
      content: [
        { id: "name", type: "text", configuration: { label: "Full name", description: "As on your ID", messages: { required: "Enter your name" } } },
        {
          id: "kind",
          type: "radio",
          configuration: {
            label: "Kind",
            options: [
              { value: "yes", label: "Yes" },
              { value: "no", label: "No", description: "Not now" }
            ]
          }
        }
      ]
    }
  };
}

/**
 * The French the form carries: the title, a field's label, one option and the form's
 * message for `required`; everything else is untranslated. Written with the module's own writer
 * so each entry's `source` is the fingerprint of the string it answers.
 */
export function languagesTranslations(): FormTranslations {
  const root = languagesRoot();
  const configuration = root.configuration as { title: string; messages: Record<string, string> };
  let map: FormTranslations = {};
  map = writeTranslation(map, "fr", addressOf.form("title"), "Permis", configuration.title);
  map = writeTranslation(map, "fr", addressOf.component("name", "label"), "Nom complet", "Full name");
  map = writeTranslation(map, "fr", addressOf.option("kind", "yes", "label"), "Oui", "Yes");
  map = writeTranslation(map, "fr", addressOf.formMessage("required"), "Répondez", configuration.messages.required!);
  return map;
}

export const LANGUAGES: LocalizationConfiguration = { supportedLocales: [{ code: "en" }, { code: "fr", label: "Français" }], defaultLocale: "en" };

/** The form's controller; `null` for a form that declares no languages. */
export function languagesController(localization: LocalizationConfiguration | null = LANGUAGES): BuilderController {
  return new BuilderController({ initialRoot: languagesRoot(), componentDefinitions: DEFINITIONS, translations: languagesTranslations(), ...(localization ? { localization } : {}) });
}
