/** Rules of the page's own, run at submit inside the sandbox the form loads beside the bundle. */
import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript, openTag } from "./page";
import type { ExampleSpec } from "./types";

/** The program the sandbox runs: a module object whose validators return codes, never text. */
const RULES_SOURCE = [
  `({`,
  `  validators: [`,
  `    (context) => {`,
  `      const errors = [];`,
  `      // A full name has a first and a last name in it.`,
  `      const name = context.values.fullName;`,
  `      context.log.debug("full name", { fullName: name });`,
  `      if (typeof name === "string" && name.trim() !== "" && !name.trim().includes(" ")) {`,
  `        errors.push({ code: "custom.fullNameIncomplete", componentId: "fullName", path: "fullName", stage: "intake-rules", source: "custom" });`,
  `      }`,
  `      // Phone contact is offered in some countries only: a rule over two fields and the list`,
  `      // the page handed in, since the sandbox cannot fetch one.`,
  `      const offered = (context.externalData || {}).phoneCountries || [];`,
  `      const country = context.values.country;`,
  `      context.log.debug("phone contact", { method: context.values.contactMethod, country, offered });`,
  `      if (context.values.contactMethod === "phone" && country && !offered.includes(country)) {`,
  `        errors.push({ code: "custom.phoneNotOffered", componentId: "contactMethod", path: "contactMethod", stage: "intake-rules", source: "custom" });`,
  `      }`,
  `      context.log.info("intake rules: " + errors.length + " error(s)");`,
  `      return { errors };`,
  `    }`,
  `  ]`,
  `})`
];

const MESSAGES = {
  required: "This field is required.",
  "custom.fullNameIncomplete": "Enter your first and last name.",
  "custom.phoneNotOffered": "Phone contact is not offered in that country yet.",
  "wasm.execution_error": "Validation could not run. Try again."
};

export const wasmExample: ExampleSpec = {
  title: "Rules of the page's own, run in the sandbox",
  options: [
    {
      key: "logLevel",
      label: "Run log level",
      default: "debug",
      choices: [
        { value: "debug", label: "Debug (every step)" },
        { value: "info", label: "Info" },
        { value: "warn", label: "Warnings (the default)" },
        { value: "off", label: "Off" }
      ]
    }
  ],
  page(options) {
    const attributes = [`id="intake"`, `src="${SAMPLE_DEFINITION_URL}"`, `wasm="auto"`];
    if (options.logLevel !== "warn") attributes.push(`wasm-log-level="${options.logLevel}"`);
    const script = [
      `const form = document.getElementById("intake");`,
      `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
      ``,
      `// Rules of the page's own, run at submit inside the sandbox after the field constraints.`,
      `// An ES2020 program whose value is { validators }: each takes the submission and returns`,
      `// errors as codes and the fields they belong to. The sandbox has no fetch, no clock and no`,
      `// randomness, so a server running the same program reaches the same verdict.`,
      `form.wasmPlugins = [{`,
      `  id: "intake-rules",`,
      `  version: "1.0.0",`,
      `  source: \``,
      ...RULES_SOURCE.map((line) => `    ${line}`),
      `  \``,
      `}];`,
      ``,
      `// What the rules read beside the answers, gathered by the page for each submit.`,
      `form.wasmExternalData = () => ({ phoneCountries: ["CA", "US"] });`,
      ``,
      `// The sandbox answers with codes; the words are the page's.`,
      `form.messages = ${jsLiteral(MESSAGES)};`,
      ``,
      `// The run log comes back with the verdict, at the level wasm-log-level asks for.`,
      `form.addEventListener("datum-wasm-validated", ({ detail }) => {`,
      `  console.log(detail.blocked ? "Blocked" : "Accepted", "in", detail.durationMs, "ms");`,
      `  for (const entry of detail.logs) console.log(\`[\${entry.level}] \${entry.message}\`, entry.data ?? "");`,
      `});`,
      ``,
      `form.addEventListener("datum-submit", ({ detail }) => {`,
      `  // Accepted: the values as the sandbox returned them, any key the form does not define removed.`,
      `  if (detail.accepted) console.log(detail.submission.submission.values);`,
      `});`
    ];
    return htmlDocument("Customer intake", bundleTags("form"), [
      `    <!-- wasm="auto": the element loads datum-wasm.js from beside the bundle and runs every submit in it. -->`,
      `${openTag("datum-form", attributes)}</datum-form>`,
      ``,
      moduleScript(script)
    ]);
  }
};
