/** The builder and a form on one page: what the builder emits goes straight into the form. */
import { BUILDER_HEIGHT, SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

export const togetherExample: ExampleSpec = {
  title: "The builder and the form it feeds",
  options: [],
  page() {
    const builder = openTag("datum-form-builder", [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="${SAMPLE_DEFINITION_URL}"`]) + `\n    </datum-form-builder>`;
    return htmlDocument(
      "Form builder with a live preview",
      // The builder bundle defines both elements.
      bundleTags("builder"),
      [
        builder,
        `    <datum-form id="preview"></datum-form>`,
        ``,
        moduleScript([
          `const builder = document.getElementById("builder");`,
          `const preview = document.getElementById("preview");`,
          ``,
          `// The same data sources on both: the canvas previews them, and the form renders them.`,
          `const dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
          `builder.dataSources = dataSources;`,
          `preview.dataSources = dataSources;`,
          ``,
          `// What the builder emits is what the form takes: no conversion in between.`,
          `builder.addEventListener("datum-builder-change", ({ detail }) => {`,
          `  preview.definition = detail.definition;`,
          `});`
        ])
      ]
    );
  }
};
