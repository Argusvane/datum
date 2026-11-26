/** `<datum-form-builder>` in a box the page sizes, saving to the page's server by its `save` attribute. */
import { BUILDER_HEIGHT, SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

/** Where the page keeps the form; the stand-in server answers the PUT. */
const SAVE_ADDRESS = "/api/forms/customer-intake";

const FILE_ACTIONS: Record<string, string | undefined> = { all: undefined, "open-download": "open download", off: "off" };

export const builderExample: ExampleSpec = {
  title: "A page with the builder",
  options: [
    {
      key: "fileActions",
      label: "File actions",
      default: "all",
      choices: [
        { value: "all", label: "New, Open and Download" },
        { value: "open-download", label: "Open and Download" },
        { value: "off", label: "None" }
      ]
    },
    { key: "save", label: "Server reply to Save", default: "saved", choices: [{ value: "saved", label: "Saved (204)" }, { value: "refused", label: "Refused (500)" }, { value: "unreachable", label: "Unreachable" }] }
  ],
  page(options) {
    // save="/url" puts Save in the builder's menu and on Ctrl/Cmd+S, and has the builder send the
    // form there itself as JSON, by PUT: no script. Any 2xx answer is a saved form.
    const attributes = [`id="builder"`, `layout="contained"`, `style="height: ${BUILDER_HEIGHT}px"`, `src="${SAMPLE_DEFINITION_URL}"`, `save="${SAVE_ADDRESS}"`];
    const fileActions = FILE_ACTIONS[String(options.fileActions)];
    if (fileActions !== undefined) attributes.push(`file-actions="${fileActions}"`);
    const element = [openTag("datum-form-builder", attributes), `    </datum-form-builder>`].join("\n");
    const script = [
      `const builder = document.getElementById("builder");`,
      ``,
      `// The data sources the rendering page will supply: the canvas previews their options and`,
      `// the inspector's Data source picker lists their ids.`,
      `builder.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
      ``,
      `// Every edit reports the whole form as authored so far.`,
      `builder.addEventListener("datum-builder-change", ({ detail }) => {`,
      `  console.log(detail.reason, detail.definition.id);`,
      `});`,
      ``,
      `// New, Open, Download and Save are reported once they are done.`,
      `builder.addEventListener("datum-builder-file-action", ({ detail }) => {`,
      `  console.log(detail.action, detail.name);`,
      `});`
    ];
    return htmlDocument("Form builder", bundleTags("builder"), [element, ``, moduleScript(script)]);
  },
  serve(request, options) {
    if (request.method !== "PUT" || request.path !== SAVE_ADDRESS) return undefined;
    if (options.save === "unreachable") return { fail: true };
    return { status: options.save === "refused" ? 500 : 204 };
  }
};
