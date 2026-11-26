/** The builder's own interface in another language, or one English word reworded. */
import { BUILDER_HEIGHT, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

// Each locale holds only the keys it words. A key missing from the exact locale falls back to
// its language, then to English.
const CATALOG = {
  fr: {
    "shell.workspace.languages": "Langues",
    "shell.workspace.logic": "Règles",
    "shell.bar.undo": "Annuler",
    "shell.bar.redo": "Rétablir",
    "shell.file.menu": "Menu",
    "problems.count.one": "{count} problème",
    "problems.count.other": "{count} problèmes"
  },
  "fr-CA": { "shell.bar.redo": "Refaire" },
  en: { "shell.workspace.languages": "Translations" }
};

export const languagesBuilderWordsExample: ExampleSpec = {
  title: "The builder in another language",
  options: [
    {
      key: "textLocale",
      label: "textLocale",
      default: "fr-CA",
      choices: [
        { value: "none", label: "Not set (English, so the en entry applies)" },
        { value: "fr", label: "fr" },
        { value: "fr-CA", label: "fr-CA (over fr, key by key)" },
        { value: "en", label: "en (one word reworded)" }
      ]
    }
  ],
  page(options) {
    const script = [
      `const builder = document.getElementById("builder");`,
      ``,
      `// The builder's own words, its buttons, panel titles and messages, are English unless the`,
      `// page says otherwise. This is the page's setting: it never touches the form being edited,`,
      `// whose languages are authored in the Languages workspace.`,
      `builder.textCatalog = ${jsLiteral(CATALOG)};`,
      ``
    ];
    if (options.textLocale === "none") {
      script.push(`// textLocale is left unset: English. The en entry above still words its one key.`);
    } else {
      script.push(
        `// Each key is looked up in the exact locale (fr-CA), then its language (fr), then English.`,
        `// So the fr-CA entry above words one key and leaves the rest to fr. With "en", only the`,
        `// reworded key changes.`,
        `builder.textLocale = "${options.textLocale}";`
      );
    }
    script.push(
      ``,
      `// Both can be set at any time: the builder reads them live. Values name their slots in single`,
      `// braces, and a counted text has one key per plural category (problems.count.one, .other).`
    );
    return htmlDocument("Form builder in another language", bundleTags("builder"), [
      openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="/forms/visit-request.json"`]) + "</datum-form-builder>",
      ``,
      moduleScript(script)
    ]);
  }
};
