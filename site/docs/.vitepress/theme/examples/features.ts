/** A form or a builder with parts left out: only what `features` lists exists. */
import { BUILDER_HEIGHT, SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript } from "./page";
import type { ExampleSpec } from "./types";

const BUILDER_FEATURES: Record<string, string> = {
  minimal: "minimal",
  "minimal-logic": "minimal logic",
  "minimal-logic-languages": "minimal logic languages"
};

export const featuresExample: ExampleSpec = {
  title: "A page with parts left out",
  options: [
    { key: "element", label: "Element", default: "form", choices: [{ value: "form", label: "The form" }, { value: "builder", label: "The builder" }] },
    {
      key: "builderFeatures",
      label: "Builder features",
      default: "minimal-logic",
      when: (options) => options.element === "builder",
      choices: [
        { value: "minimal", label: "minimal" },
        { value: "minimal-logic", label: "minimal logic" },
        { value: "minimal-logic-languages", label: "minimal logic languages" }
      ]
    }
  ],
  page(options) {
    if (options.element === "builder") {
      const features = BUILDER_FEATURES[String(options.builderFeatures)];
      return htmlDocument("Form builder, parts left out", bundleTags("builder"), [
        `    <!-- Only the listed parts exist. The rest is never loaded: no PDF or Journeys side,`,
        `         no Variables or Header & footer panel. -->`,
        `    <datum-form-builder id="builder" layout="contained" style="height: ${BUILDER_HEIGHT}px"`,
        `      features="${features}" src="${SAMPLE_DEFINITION_URL}"></datum-form-builder>`,
        ``,
        moduleScript([
          `const builder = document.getElementById("builder");`,
          ``,
          `// A listed part whose file the site did not deploy is reported here. The part shows`,
          `// an error with Retry and the rest of the builder keeps working.`,
          `builder.addEventListener("datum-error", ({ detail }) => console.warn(detail.message));`
        ])
      ]);
    }
    return htmlDocument("Customer intake, parts left out", bundleTags("form"), [
      `    <!-- minimal is a single-page form that renders, validates and submits. No journeys, PDF,`,
      `         sandbox or passkey file is fetched. Each name after it adds one part back: here,`,
      `         the data sources the Country select reads. -->`,
      `    <datum-form id="intake" features="minimal data-sources" src="${SAMPLE_DEFINITION_URL}"></datum-form>`,
      ``,
      moduleScript([
        `const form = document.getElementById("intake");`,
        `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
        `form.addEventListener("datum-submit", ({ detail }) => console.log("accepted:", detail.accepted));`,
        ``,
        `// A listed part whose file the site did not deploy is reported here, with a Retry on the form.`,
        `form.addEventListener("datum-error", ({ detail }) => console.warn(detail.message));`
      ])
    ]);
  }
};
