/** Header and footer parts around a form: the page's own, the form author's, or both. */
import { SAMPLE_DATA_SOURCES, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

/** The definition with the author's header and footer, a file of this site's. */
const AUTHORED_URL = "/forms/customer-intake-header.json";
const PLAIN_URL = "/forms/customer-intake.json";
const LOGO = "/acme-logo.svg";

const SWITCHER = { type: "language-switcher", label: { default: "Language", locales: { "fr-CA": "Langue" } } };
const LOGO_PART = { type: "image", src: LOGO, alt: { default: "Acme Forms", locales: { "fr-CA": "Formulaires Acme" } }, height: 32 };

const INSTRUCTIONS = {
  default: '<p>Fill in every field marked <strong>required</strong>. See the <a href="#help">help page</a> if you get stuck.</p>',
  locales: { "fr-CA": '<p>Remplissez chaque champ marqué <strong>obligatoire</strong>. Consultez la <a href="#help">page d’aide</a> au besoin.</p>' }
};

const SCENARIOS = [
  { value: "host", label: "The page composes the header: logo, switcher, title, instructions" },
  { value: "footer", label: "The page puts a contact line and the switcher in the footer" },
  { value: "authored", label: "The form's author composed the header and footer" },
  { value: "both", label: "Both: the author's header, the page's switcher in the author's slot" },
  { value: "replace", label: "The page replaces the author's header with its own" }
];

/** The chrome the page sets in a scenario, or nothing. */
function hostChrome(scenario: string): Record<string, unknown> | undefined {
  switch (scenario) {
    case "host":
      return { header: [{ type: "group", parts: [LOGO_PART, SWITCHER] }, { type: "form-title" }, { type: "html", html: INSTRUCTIONS }] };
    case "footer":
      return {
        header: [{ type: "form-title" }],
        footer: [
          {
            type: "group",
            justify: "space-between",
            parts: [{ type: "text", text: { default: "Questions? Write to forms@acme.example.", locales: { "fr-CA": "Des questions? Écrivez à forms@acme.example." } } }, SWITCHER]
          }
        ]
      };
    case "replace":
      return {
        formChrome: "exclude",
        header: [{ type: "heading", text: { default: "Acme Forms: customer intake", locales: { "fr-CA": "Formulaires Acme : admission des clients" } } }, SWITCHER]
      };
    default:
      return undefined;
  }
}

export const chromeExample: ExampleSpec = {
  title: "A form with a header and footer",
  options: [
    { key: "scenario", label: "Who composes it", default: "host", choices: SCENARIOS },
    { key: "locale", label: "Locale", default: "en", choices: [{ value: "en", label: "English" }, { value: "fr-CA", label: "Français" }] },
    { key: "frame", label: "Frame", default: "none", choices: [{ value: "none", label: "The page sets none" }, { value: "seamless", label: "Seamless" }, { value: "outlined", label: "Outlined" }, { value: "paper", label: "Paper" }] },
    { key: "fixed", label: "Frame fixed (wins over the author's)", default: false, when: (options) => options.frame !== "none" }
  ],
  rewrites: { [LOGO]: "docs/acme-logo.svg" },
  page(options) {
    const scenario = String(options.scenario);
    const authored = ["authored", "both", "replace"].includes(scenario);
    const attributes = [`id="intake"`, `src="${authored ? AUTHORED_URL : PLAIN_URL}"`];
    if (options.locale !== "en") attributes.push(`locale="${options.locale}"`);
    if (options.frame !== "none") attributes.push(`frame="${options.frame}"`);
    if (options.frame !== "none" && options.fixed) attributes.push("frame-fixed");
    // The short form: the attribute adds a switcher to the header.
    if (scenario === "both") attributes.push("language-switcher");

    const script = [`const form = document.getElementById("intake");`, `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`];
    const chrome = hostChrome(scenario);
    if (chrome) {
      script.push(
        ``,
        scenario === "replace"
          ? `// The page's parts alone: formChrome "exclude" leaves out the ones the form carries.`
          : `// The page's parts. The form's own, if it has any, draw first.`,
        `form.chrome = ${jsLiteral(chrome)};`
      );
    }
    return htmlDocument("Customer intake", bundleTags("form"), [`${openTag("datum-form", attributes)}</datum-form>`, ``, moduleScript(script)]);
  }
};
