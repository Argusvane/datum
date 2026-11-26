/** A form in two languages: the locale the page asks for, the form's own switcher, and the page switching it. */
import definition from "../../../public/forms/visit-request.json?raw";
import { bundleTags, htmlDocument, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

const DEFINITION_URL = "/forms/visit-request.json";

export const languagesFormExample: ExampleSpec = {
  title: "A form in more than one language",
  options: [
    {
      key: "locale",
      label: "locale",
      default: "fr-CA",
      choices: [
        { value: "en", label: "en (declared)" },
        { value: "fr", label: "fr (declared)" },
        { value: "fr-CA", label: "fr-CA (meets the declared fr)" },
        { value: "FR_ca", label: "FR_ca (case ignored, _ reads as -)" },
        { value: "de", label: "de (nothing matches: the default)" },
        { value: "auto", label: "auto (the visitor's languages)" }
      ]
    },
    { key: "switcher", label: "language-switcher", default: true }
  ],
  page(options) {
    const attributes = [`id="visit"`, `locale="${options.locale}"`];
    if (options.switcher) attributes.push("language-switcher");
    attributes.push(`src="${DEFINITION_URL}"`);
    return htmlDocument("Visit request", bundleTags("form"), [
      `    <!-- The form declares its languages (en, fr) and starts in its default (en). The locale`,
      `         attribute is negotiated, not demanded: case is ignored, a regional tag meets its`,
      `         language, and a tag nothing matches leaves the default. "auto" negotiates the`,
      `         visitor's browser languages. -->`,
      `${openTag("datum-form", attributes)}</datum-form>`,
      ``,
      `    <!-- The page can switch the language itself. -->`,
      `    <p>`,
      `      <button type="button" id="to-en">English</button>`,
      `      <button type="button" id="to-fr">Français</button>`,
      `    </p>`,
      ``,
      moduleScript([
        `const form = document.getElementById("visit");`,
        ``,
        `// setLocale refuses a code the form does not declare, and does not fire`,
        `// datum-locale-applied: the page that called it knows. activeLocale is the code the form`,
        `// settled on.`,
        `for (const code of ["en", "fr"]) {`,
        `  document.getElementById("to-" + code).addEventListener("click", () => {`,
        `    form.setLocale(code);`,
        `    console.log("setLocale", code, "active", form.activeLocale);`,
        `  });`,
        `}`,
        ``,
        `// Fires when the locale attribute or the form's own switcher puts a locale in effect, with`,
        `// the code the form negotiated to. Here the page's own language follows it.`,
        `form.addEventListener("datum-locale-applied", ({ detail }) => {`,
        `  document.documentElement.lang = detail.locale;`,
        `  console.log("locale applied:", detail.locale);`,
        `});`
      ])
    ]);
  },
  files() {
    return [{ title: "visit-request.json", lang: "json", code: definition }];
  }
};
