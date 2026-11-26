// What the kit knows about a binding package: bindings/<id>/package.json's `datumBinding`
// ({ id, designSystem, release, bundle, global, budgetKb }), the host's asset list
// (binding-check.json, the file `datum-binding-check` reads too), and the folders the checks use
// (reference/, tests/). `datum` is the one binding that is not a package: it lives in the engine and
// has no design system, so it has no reference and no bundle.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const KIT_ROOT = resolve(here, "..");
export const REPO_ROOT = resolve(KIT_ROOT, "..", "..", "..");
export const BINDINGS_ROOT = join(REPO_ROOT, "bindings");
export const SUITE_ROOT = join(REPO_ROOT, "packages", "conformance-suite");

export const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const GLOBAL_PATTERN = /^[A-Za-z_$][\w$]*$/;

/** The problems with a `datumBinding` block (an empty list when it is complete). */
export function configProblems(config) {
  const problems = [];
  if (!config || typeof config !== "object") return ["package.json has no datumBinding block"];
  const text = (key) => typeof config[key] === "string" && config[key].trim() !== "";
  if (!text("id") || !ID_PATTERN.test(config.id)) problems.push('datumBinding.id must be a lower-case id such as "govuk"');
  if (!text("designSystem")) problems.push("datumBinding.designSystem must name the design system");
  if (!text("release")) problems.push("datumBinding.release must name the pinned release (informational: the pinned devDependency)");
  if (!text("bundle") || !/\.js$/.test(config.bundle)) problems.push('datumBinding.bundle must be the ES module the build writes, such as "dist/govuk.js"');
  if (!text("global") || !GLOBAL_PATTERN.test(config.global)) problems.push('datumBinding.global must be the IIFE global name, such as "DatumBindingGovuk"');
  if (typeof config.budgetKb !== "number" || !(config.budgetKb > 0)) problems.push("datumBinding.budgetKb must be the gzip budget of the bundle in KB (a positive number)");
  return problems;
}

/** `bindings/<id>` (or a package folder given as a path, for a binding kept outside this repository) as a package description, or throws a message that says what is missing. */
export function loadBindingPackage(idOrDir) {
  const byPath = /[\\/]/.test(idOrDir) || idOrDir.startsWith(".");
  const dir = byPath ? resolve(idOrDir) : join(BINDINGS_ROOT, idOrDir);
  const id = byPath ? basename(dir) : idOrDir;
  const file = join(dir, "package.json");
  if (!existsSync(file)) throw new Error(`no binding "${id}": ${file} does not exist (bindings: ${listBindings().join(", ") || "none"})`);
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  const config = manifest.datumBinding;
  const assetsFile = join(dir, "binding-check.json");
  const assets = existsSync(assetsFile) ? JSON.parse(readFileSync(assetsFile, "utf8")) : {};
  const entry = [assets.binding && resolve(dir, assets.binding), config?.entry && resolve(dir, config.entry), join(dir, "src", "index.ts"), join(dir, "src", "binding.ts")].find((p) => p && existsSync(p));
  return {
    id,
    isDatum: false,
    dir,
    manifest,
    config,
    problems: configProblems(config),
    assets,
    assetsFile,
    entry,
    referenceDir: join(dir, "reference"),
    testsDir: join(dir, "tests"),
    bundleFile: config?.bundle ? join(dir, config.bundle) : undefined
  };
}

/** Datum's own binding: no package, no design system, nothing to compare with. */
export function datumPackage() {
  return {
    id: "datum",
    isDatum: true,
    dir: undefined,
    manifest: undefined,
    config: { id: "datum", designSystem: "Datum" },
    problems: [],
    assets: {},
    assetsFile: undefined,
    entry: join(SUITE_ROOT, "binding-check", "datum", "binding.mjs"),
    referenceDir: undefined,
    testsDir: undefined,
    bundleFile: undefined
  };
}

export function listBindings() {
  if (!existsSync(BINDINGS_ROOT)) return [];
  return readdirSync(BINDINGS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(BINDINGS_ROOT, entry.name, "package.json")))
    .map((entry) => entry.name)
    .sort();
}

/** `datum`, `bindings/<id>`, or the path of a binding package. */
export function resolveBinding(id) {
  return id === "datum" ? datumPackage() : loadBindingPackage(id);
}

/** The host's asset config in the renderer's shape: `{ url }` entries (a string is a url). */
export function renderAssets(doc) {
  const source = (item) => (typeof item === "string" ? { url: item } : item);
  return {
    ...(doc.stylesheets ? { stylesheets: doc.stylesheets.map(source) } : {}),
    ...(doc.fonts ? { fonts: doc.fonts.map(source) } : {}),
    ...(doc.scripts ? { scripts: doc.scripts.map(source) } : {}),
    ...(doc.rootFontSize ? { rootFontSize: doc.rootFontSize } : {})
  };
}
