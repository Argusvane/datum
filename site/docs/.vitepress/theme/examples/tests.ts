/** The builder opened on a form that carries its scenarios, with the Tests panel running them. */
import { BUILDER_HEIGHT, bundleTags, htmlDocument, moduleScript, openTag } from "./page";
import sidecar from "../../../public/forms/intake-with-tests.datum-test?raw";
import type { ExampleSpec } from "./types";

const PASSING = "/forms/intake-with-tests.json";
const FAILING = "/forms/intake-with-tests-failing.json";

export const testsExample: ExampleSpec = {
  title: "The builder running a form's tests",
  options: [
    {
      key: "scenarios",
      label: "Scenarios",
      default: "passing",
      choices: [
        { value: "passing", label: "Three that pass" },
        { value: "failing", label: "A fourth that fails" }
      ]
    }
  ],
  page(options) {
    const src = options.scenarios === "failing" ? FAILING : PASSING;
    return htmlDocument("Form builder, tests", bundleTags("builder"), [
      openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="${src}"`]) + "</datum-form-builder>",
      ``,
      moduleScript([
        `const builder = document.getElementById("builder");`,
        ``,
        `// The scenarios are the definition's own: its "tests" block holds one entry per scenario.`,
        `// The Tests panel on the strip runs them on the browser's runtime when it opens, and`,
        `// again after every edit to the form or to a scenario.`,
        ``,
        `// Every edit, to the form or to its scenarios, reports the whole definition, tests included.`,
        `builder.addEventListener("datum-builder-change", ({ detail }) => {`,
        `  console.log(detail.reason, (detail.definition.tests?.scenarios.length ?? 0) + " scenarios");`,
        `});`
      ])
    ]);
  },
  files() {
    return [{ title: "intake-with-tests.datum-test", lang: "text", code: sidecar.trimEnd() }];
  }
};
