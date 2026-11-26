/**
 * What every example's page is assembled from. The addresses are the ones a reader's own site
 * would have: the bundle folder at /datum, the definitions under /forms, the server under /api.
 * The frame points the first at this site's copy of the bundles and stands in for the other two.
 */

/** Where the examples' pages keep the bundle folder. */
export const BUNDLE_BASE = "/datum";
/** The form the examples load, served by this site from docs/public/forms. */
export const SAMPLE_DEFINITION_URL = "/forms/customer-intake.json";
/** The height the builder examples give the element; layout="contained" fills exactly that. */
export const BUILDER_HEIGHT = 640;

/** The data source the sample form's Country select names. */
export const SAMPLE_DATA_SOURCES = {
  countries: [
    { value: "CA", label: "Canada" },
    { value: "US", label: "United States" },
    { value: "MX", label: "Mexico" }
  ]
};

/** A value as a person would write it in a script: bare keys, short lists and objects on one line. */
export function jsLiteral(value: unknown, indent = ""): string {
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((entry) => jsLiteral(entry, inner));
    if (value.every((entry) => entry === null || typeof entry !== "object")) {
      const flat = `[${items.join(", ")}]`;
      if (flat.length <= 72) return flat;
    }
    return `[\n${items.map((item) => `${inner}${item}`).join(",\n")}\n${indent}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";
    const parts = entries.map(([key, entry]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${jsLiteral(entry, inner)}`);
    const flat = `{ ${parts.join(", ")} }`;
    if (flat.length <= 72 && !flat.includes("\n")) return flat;
    return `{\n${parts.map((part) => `${inner}${part}`).join(",\n")}\n${indent}}`;
  }
  return JSON.stringify(value);
}

/** The stylesheet and the module of one bundle, as the page's head loads them. */
export function bundleTags(bundle: "form" | "builder"): string[] {
  return [
    `<link rel="stylesheet" href="${BUNDLE_BASE}/datum-${bundle}.css">`,
    `<script type="module" src="${BUNDLE_BASE}/datum-${bundle}.js"></script>`
  ];
}

/** An element's opening tag with one attribute per line. */
export function openTag(name: string, attributes: string[], indent = "    "): string {
  return `${indent}<${name}\n${attributes.map((attribute) => `${indent}  ${attribute}`).join("\n")}\n${indent}>`;
}

/** The page's own script, indented to sit in the body. An entry may hold several lines (a literal). */
export function moduleScript(lines: string[]): string {
  const all = lines.flatMap((line) => line.split("\n"));
  return [`    <script type="module">`, ...all.map((line) => (line === "" ? "" : `      ${line}`)), `    </script>`].join("\n");
}

export function htmlDocument(title: string, head: string[], body: string[]): string {
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `  <head>`,
    `    <meta charset="utf-8">`,
    `    <title>${title}</title>`,
    ...head.map((line) => `    ${line}`),
    `  </head>`,
    `  <body>`,
    ...body,
    `  </body>`,
    `</html>`
  ].join("\n");
}
