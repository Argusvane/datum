/** The form drawn with the Bootstrap binding, over Bootstrap's stylesheet and a layer of the site's own. */
import { SAMPLE_DATA_SOURCES, SAMPLE_DEFINITION_URL, bundleTags, htmlDocument, jsLiteral, moduleScript } from "./page";
import type { ExampleSpec } from "./types";

const ACCENTS: Record<string, { name: string; base: string; dark: string; soft: string; rgb: string }> = {
  purple: { name: "Purple", base: "#6f42c1", dark: "#59359a", soft: "#b9a3e3", rgb: "111, 66, 193" },
  teal: { name: "Teal", base: "#0f766e", dark: "#0b5a54", soft: "#7cc5bf", rgb: "15, 118, 110" },
  crimson: { name: "Crimson", base: "#b0123b", dark: "#8c0e2f", soft: "#e39aae", rgb: "176, 18, 59" }
};

/** The site's own stylesheet: Bootstrap's variables set to the brand, loaded after Bootstrap's. */
function brandSheet(accent: string, square: boolean): string {
  const colour = ACCENTS[accent] ?? ACCENTS.purple!;
  return [
    `/* The site's own layer over Bootstrap. It is listed after bootstrap.min.css, so it wins. */`,
    `:root {`,
    `  --bs-primary: ${colour.base};`,
    `  --bs-primary-rgb: ${colour.rgb};`,
    `  --bs-link-color: ${colour.base};`,
    `  --bs-focus-ring-color: rgba(${colour.rgb}, 0.25);`,
    ...(square ? [`  --bs-border-radius: 0;`] : []),
    `}`,
    ``,
    `/* Bootstrap's buttons carry their own colours, so the brand is set on them as well. */`,
    `.btn-primary {`,
    `  --bs-btn-bg: ${colour.base};`,
    `  --bs-btn-border-color: ${colour.base};`,
    `  --bs-btn-hover-bg: ${colour.dark};`,
    `  --bs-btn-hover-border-color: ${colour.dark};`,
    `  --bs-btn-active-bg: ${colour.dark};`,
    `  --bs-btn-active-border-color: ${colour.dark};`,
    ...(square ? [`  --bs-btn-border-radius: 0;`] : []),
    `}`,
    ``,
    `.form-control:focus,`,
    `.form-select:focus,`,
    `.form-check-input:focus {`,
    `  border-color: ${colour.soft};`,
    `  box-shadow: 0 0 0 0.25rem rgba(${colour.rgb}, 0.25);`,
    `}`,
    ``,
    `.form-check-input:checked {`,
    `  background-color: ${colour.base};`,
    `  border-color: ${colour.base};`,
    `}`
  ].join("\n");
}

export const bootstrapExample: ExampleSpec = {
  title: "A form drawn with Bootstrap",
  options: [
    { key: "brand", label: "Add the site's own brand.css", default: true },
    { key: "accent", label: "Brand colour", default: "purple", when: (options) => options.brand === true, choices: Object.entries(ACCENTS).map(([value, accent]) => ({ value, label: accent.name })) },
    { key: "square", label: "Square corners", default: false, when: (options) => options.brand === true }
  ],
  rewrites: {
    "/bindings/bootstrap.iife.js": "demo/bindings/bootstrap/bootstrap.iife.js",
    "/css/bootstrap.min.css": "demo/bindings/bootstrap/files/bootstrap-5.3.8/dist/css/bootstrap.min.css"
  },
  page(options) {
    const sheets = [`{ url: "/css/bootstrap.min.css" }`, ...(options.brand ? [`{ url: "/css/brand.css" }`] : [])];
    return htmlDocument(
      "Customer intake",
      [
        ...bundleTags("form"),
        `<!-- The Bootstrap binding, built in bindings/bootstrap. As a classic script it defines DatumBindingBootstrap. -->`,
        `<script src="/bindings/bootstrap.iife.js"></script>`
      ],
      [
        `    <datum-form id="intake" src="${SAMPLE_DEFINITION_URL}" language-switcher></datum-form>`,
        ``,
        moduleScript([
          `import { bindings } from "/datum/datum-form.js";`,
          ``,
          `// The binding draws the form in Bootstrap's markup. The stylesheets are the site's to serve:`,
          `// Bootstrap's own, from the release the binding is pinned to${options.brand ? ", then the site's layer over it" : ""}.`,
          `bindings.register(bindings.fromFactory(DatumBindingBootstrap.createBinding), {`,
          `  assets: {`,
          `    stylesheets: [`,
          ...sheets.map((sheet, index) => `      ${sheet}${index < sheets.length - 1 ? "," : ""}`),
          `    ]`,
          `  }`,
          `});`,
          ``,
          `const form = document.getElementById("intake");`,
          `form.binding = "bootstrap"; // a property, not an attribute`,
          `form.dataSources = ${jsLiteral(SAMPLE_DATA_SOURCES)};`,
          ``,
          `// A stylesheet that cannot be fetched stops the form from drawing, and says so here.`,
          `form.addEventListener("datum-binding-error", ({ detail }) => console.error(detail.message));`
        ])
      ]
    );
  },
  files(options) {
    return options.brand ? [{ title: "brand.css", lang: "css", path: "/css/brand.css", code: brandSheet(String(options.accent), options.square === true) }] : [];
  }
};
