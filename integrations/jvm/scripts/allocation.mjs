// Which jar ships which file of packages/datum/dist. Pure, so a test can hold it: every dist file is claimed by
// exactly one module or by the explicit skip list, and a file nobody claims is reported (build-assets.mjs fails on it), so a
// new bundle cannot silently go missing from the jars.
import { isSkippedFileName } from "../../shared/assets-lib.mjs";

const DEJAVU_PREFIX = "fonts/DejaVu";
const SKIPPED_FILES = new Set([
  "feature-files.json", // build metadata about dist/, read here, not served
  "datum-engine.js", // the runtime with no element, for a worker, a test or Node; a host serves the form
  "datum-webauthn.js" // the WebAuthn functions with no element, for a host's own code; a page fetches the lazy chunk instead
]);
// Directories of dist/ that are never served by a host: the typings. Themes and plugins are packages of their own with their
// own dist/; packages/datum's dist/ holds none, so a stray one is reported as unclaimed.
const SKIPPED_DIRS = new Set(["types"]);

export const isBuilderFile = (file) => file === "datum-builder.js" || file === "datum-builder.css" || file.startsWith("datum-builder-") || file.startsWith("builder-fonts/");

/**
 * @param {{distFiles: string[], pdfFeatureFiles: Set<string>, omittedFiles?: Set<string>}} input
 *   forward-slash paths relative to dist/; the pdf and pdf-pages feature lists; what
 *   --omit-features leaves out.
 * @returns {{buckets: Record<string, string[]>, unclaimed: string[]}}
 */
export const allocateDistFiles = ({ distFiles, pdfFeatureFiles, omittedFiles = new Set() }) => {
  const buckets = { "datum-programs": [], "datum-ui": [], "datum-pdf": [], skip: [], omitted: [] };
  const unclaimed = [];
  /** The module that ships `file`, "skip" for the explicit skip list, or null when nobody claims it. */
  const owner = (file) => {
    const top = file.split("/")[0];
    if (file === "datum-sandbox-program.js" || file === "datum-pdf-program.js") {
      return "datum-programs";
    }
    if (file.startsWith(DEJAVU_PREFIX) && file.endsWith(".ttf")) {
      return "datum-programs";
    }
    if (isSkippedFileName(file) || (file.includes("/") && SKIPPED_DIRS.has(top)) || SKIPPED_FILES.has(file)) {
      return "skip";
    }
    if (pdfFeatureFiles.has(file)) {
      return "datum-pdf";
    }
    if (file === "datum-wasm.js" || file === "datum-form.css" || file === "datum-form.js" || file.startsWith("datum-form-") || file === "datum-builder.css" || file === "datum-builder.js" || file.startsWith("datum-builder-") || top === "builder-fonts") {
      return "datum-ui";
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
