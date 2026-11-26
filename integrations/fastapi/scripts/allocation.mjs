// Which distribution ships which file of packages/datum/dist. Pure, so a test can hold it: every dist
// file is claimed by exactly one distribution or by the documented skips, and a file nobody claims is reported (a new bundle
// must be decided about, never silently dropped).
import { isSkippedFileName } from "../../shared/assets-lib.mjs";

/**
 * The eight distributions: directory under integrations/fastapi/packages, importable package, and whether they are resource
 * distributions (they carry manifest.json and the guard checks it).
 */
export const DISTRIBUTIONS = [
  { name: "argusvane-datum-qjs-wasm", pkg: "datum_qjs_wasm", resource: true },
  { name: "argusvane-datum-programs", pkg: "datum_programs", resource: true },
  { name: "argusvane-datum-assets-ui", pkg: "datum_assets_ui", resource: true },
  { name: "argusvane-datum-assets-pdf", pkg: "datum_assets_pdf", resource: true },
  { name: "argusvane-datum-sandbox", pkg: "datum_sandbox", resource: false },
  { name: "argusvane-datum-core", pkg: "datum_core", resource: false },
  { name: "argusvane-datum-sandbox-wasmtime", pkg: "datum_sandbox_wasmtime", resource: false },
  { name: "argusvane-datum-fastapi", pkg: "datum_fastapi", resource: false }
];

const DEJAVU_PREFIX = "fonts/DejaVu";
// Build metadata and the typings are not packaged (nor are the classic-script and map files, skipped by name). Themes and plugins
// are packages of their own with their own dist/; packages/datum's dist/ holds none, so a stray one is reported as unclaimed.
const SKIPPED_DIRS = new Set(["types"]);
const SKIPPED_FILES = new Set([
  "feature-files.json", // read at build time, not served
  "datum-engine.js", // the runtime with no element, for a worker, a test or Node; a host serves the form
  "datum-webauthn.js" // the WebAuthn functions with no element, for a host's own code; a page fetches the lazy chunk instead
]);

const isBuilderFile = (file) => file === "datum-builder.js" || file === "datum-builder.css" || file.startsWith("datum-builder-") || file.startsWith("builder-fonts/");
export { isBuilderFile };

/**
 * @param {{distFiles: string[], pdfFeatureFiles: Set<string>, omittedFiles?: Set<string>}} input
 *   forward-slash paths relative to dist/; the pdf and pdf-pages feature lists; what
 *   --omit-features leaves out.
 * @returns {{buckets: Record<string, string[]>, unclaimed: string[]}}
 */
export const allocateDistFiles = ({ distFiles, pdfFeatureFiles, omittedFiles = new Set() }) => {
  const buckets = { "argusvane-datum-programs": [], "argusvane-datum-assets-ui": [], "argusvane-datum-assets-pdf": [], skip: [], omitted: [] };
  const unclaimed = [];
  const owner = (file) => {
    const top = file.split("/")[0];
    if (file === "datum-sandbox-program.js" || file === "datum-pdf-program.js") {
      return "argusvane-datum-programs";
    }
    if (file.startsWith(DEJAVU_PREFIX) && file.endsWith(".ttf")) {
      return "argusvane-datum-programs";
    }
    if (isSkippedFileName(file) || SKIPPED_DIRS.has(top) || SKIPPED_FILES.has(file)) {
      return "skip";
    }
    if (pdfFeatureFiles.has(file)) {
      return "argusvane-datum-assets-pdf";
    }
    if (file === "datum-wasm.js" || file === "datum-form.css" || file === "datum-form.js" || file.startsWith("datum-form-") || file === "datum-builder.css" || file === "datum-builder.js" || file.startsWith("datum-builder-") || top === "builder-fonts") {
      return "argusvane-datum-assets-ui";
    }
    return null;
  };
  for (const file of distFiles) {
    const to = owner(file);
    if (to === null) {
      unclaimed.push(file);
    } else if (to !== "skip" && omittedFiles.has(file)) {
      buckets.omitted.push(file);
    } else {
      buckets[to].push(file);
    }
  }
  return { buckets, unclaimed };
};
