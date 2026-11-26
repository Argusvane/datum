/** Choices in more than one language: a source told the language, and a source that sends every language. */
import definition from "../../../public/forms/visit-sources.json?raw";
import { bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleReply, ExampleRequest, ExampleSpec } from "./types";

const DEFINITION_URL = "/forms/visit-sources.json";

const WORDING: Record<string, Record<string, string>> = {
  en: { tour: "Tour", meeting: "Meeting", other: "Something else" },
  fr: { tour: "Visite guidée", meeting: "Rencontre", other: "Autre chose" }
};

// One source answers every language at once: a label is plain text or { default, locales }.
const EVERY_LANGUAGE = [
  { value: "tour", label: { default: "Tour", locales: { fr: "Visite guidée" } } },
  {
    value: "meeting",
    label: { default: "Meeting", locales: { fr: "Rencontre" } },
    description: { default: "With a staff member", locales: { fr: "Avec un membre du personnel" } }
  },
  { value: "other", label: { default: "Something else", locales: { fr: "Autre chose" } } }
];

/** What the stand-in endpoint answers: the same kinds, worded in the locale on the URL. */
function answer(request: ExampleRequest): ExampleReply | undefined {
  const url = new URL(request.path, "http://example.invalid");
  if (url.pathname !== "/api/visit-types") return undefined;
  const locale = url.searchParams.get("locale") ?? "en";
  const words = WORDING[locale] ?? WORDING[locale.split("-")[0]!] ?? WORDING.en!;
  return { body: { items: Object.entries(words).map(([value, label]) => ({ value, label })) }, log: [`GET ${request.path}`] };
}

export const languagesDataSourcesExample: ExampleSpec = {
  title: "Choices in more than one language",
  options: [
    {
      key: "answeredBy",
      label: "The first source is answered by",
      default: "page",
      choices: [{ value: "page", label: "A function in the page" }, { value: "endpoint", label: "An endpoint, asked with ?locale=" }]
    }
  ],
  page(options) {
    const attributes = [`id="visit"`, `locale="fr-CA"`, "language-switcher", `src="${DEFINITION_URL}"`];
    const first =
      options.answeredBy === "endpoint"
        ? [
            `// (a) The source is asked in the language the form is showing. context.locale is that`,
            `// code ("fr-CA", say), and here the server reads it from the URL and answers in it.`,
            `const byLocale = async (request, context) => {`,
            `  const response = await fetch("/api/visit-types?locale=" + encodeURIComponent(context.locale));`,
            `  return response.json();`,
            `};`
          ]
        : [
            `// (a) The source is asked in the language the form is showing. context.locale is that`,
            `// code ("fr-CA", say), though only "fr" is kept here: the fallback is the source's own.`,
            `const wording = ${jsLiteral(WORDING)};`,
            `const byLocale = async (request, context) => {`,
            `  const locale = context.locale ?? "en";`,
            `  const words = wording[locale] ?? wording[locale.split("-")[0]] ?? wording.en;`,
            `  return { items: Object.entries(words).map(([value, label]) => ({ value, label })) };`,
            `};`
          ];
    return htmlDocument("Visit kind", bundleTags("form"), [
      `${openTag("datum-form", attributes)}</datum-form>`,
      ``,
      moduleScript([
        `const form = document.getElementById("visit");`,
        ``,
        ...first,
        ``,
        `// (b) The source sends every language at once. The form picks the wording for its locale`,
        `// (fr-CA meets fr) and falls back to the default.`,
        `const everyLanguage = async () => ({ items: ${jsLiteral(EVERY_LANGUAGE)} });`,
        ``,
        `// Switching the language asks both again. The value a person chose is the same in every`,
        `// language ("tour"), so it stays chosen: only its label changes.`,
        `form.dataSources = { visitTypesByLocale: byLocale, visitTypesLocalized: everyLanguage };`,
        ``,
        `form.addEventListener("datum-change", ({ detail }) => console.log(detail.path, "=", detail.value));`
      ])
    ]);
  },
  files() {
    return [{ title: "visit-sources.json", lang: "json", code: definition }];
  },
  serve: (request) => answer(request)
};
