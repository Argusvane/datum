// Builds a plugin package's bundle (plugins/<package>: a component library, an icon set), run from
// the package folder (or given --plugin-dir): src/bundle.ts to dist/<bundle>.js and
// dist/<bundle>.iife.js with the settings this package builds every bundle with
// (scripts/plugin-vite.config.ts, scripts/vite-bundle.ts), one Vite build per format; then the
// bundle checked: both files present, the package's own library (its sentinel) in each, no plugin
// or binding package it depends on inside either (each is a bundle of its own), and the module
// within its size budget. Vite and esbuild are this package's: a plugin package needs none of its own.
// The bundles carry no source maps unless the build is run with DATUM_SOURCE_MAPS=1.
//
// Third-party code in the bundle is accounted for beside it: `<bundle>.LICENSE.txt` names each package
// the bundle carries (read from its source maps) with its licence text, the packages' own licence files
// are copied unchanged as `LICENSE.<package>.txt`, and the legal comments of that code (an icon set's
// banner, say) stay in the bundle as well, which the checks below hold the build to.
//
// The package says what it builds in the "datumPlugin" block of its package.json:
//
//   "datumPlugin": {
//     "id": "icons-fontawesome",              the package's id
//     "bundle": "datum-icons-fontawesome",    dist/<bundle>.js and dist/<bundle>.iife.js
//     "global": "DatumIconsFontAwesome",      the classic script's window global
//     "sentinel": "font-awesome",             a literal string of the package's library, asserted in its bundle
//     "budgetKb": 44                          the module's size budget
//   }
//
// A field the build does not know is an error, so a misspelt "budgetKb" cannot switch a check off.
//
//   npm run build                          in a plugin package
//   node scripts/plugin-build.mjs --plugin-dir <package folder>
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectPackages, copyLicenceFiles, packageProblems, readLegalComments, renderLicenceFile, sourcesOfMap } from "./notices-lib.mjs";
import { stripUnlessKept } from "./strip-source-maps.mjs";

/** This package's root: where Vite and the shared bundle settings live. */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const FIELDS = ["id", "bundle", "global", "sentinel", "budgetKb"];
const isText = (value) => typeof value === "string" && value.trim() !== "";

/** The value of `--plugin-dir` in `args`, else the working directory, as an absolute path. */
export function pluginDirArg(args = process.argv.slice(2)) {
  const index = args.indexOf("--plugin-dir");
  return resolve(index !== -1 && args[index + 1] ? args[index + 1] : process.cwd());
}

/** Reads and checks a plugin package's "datumPlugin" block; throws naming the field that is wrong. */
export function readPluginPackage(dir = process.cwd()) {
  const root = resolve(dir);
  const file = join(root, "package.json");
  if (!existsSync(file)) throw new Error(`plugin-build: no package.json in ${root}`);
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  const meta = pkg.datumPlugin;
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) throw new Error(`plugin-build: ${file} has no "datumPlugin" block`);
  const where = `${file} "datumPlugin"`;
  const unknown = Object.keys(meta).filter((field) => !FIELDS.includes(field));
  if (unknown.length > 0) throw new Error(`plugin-build: ${where} has ${unknown.map((field) => `"${field}"`).join(", ")}, which the build does not know (the fields are ${FIELDS.join(", ")})`);
  for (const field of ["id", "bundle", "global", "sentinel"]) {
    if (!isText(meta[field])) throw new Error(`plugin-build: ${where}.${field} must be a non-empty string`);
  }
  if (!(Number.isFinite(meta.budgetKb) && meta.budgetKb > 0)) throw new Error(`plugin-build: ${where}.budgetKb must be a positive number (the bundle's size budget)`);
  return { dir: root, name: pkg.name, id: meta.id, bundle: meta.bundle, global: meta.global, sentinel: meta.sentinel, budgetKb: meta.budgetKb };
}

/**
 * The plugin and binding packages `dir`'s package depends on (dependencies and devDependencies whose
 * installed package.json carries "datumPlugin" or "datumBinding"), each with the string that marks
 * it in a bundle: what this package's bundle must not carry, since every such package is a bundle
 * of its own.
 */
export function linkedPackages(dir = process.cwd()) {
  const root = resolve(dir);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const linked = [];
  for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
    const file = join(root, "node_modules", name, "package.json");
    if (!existsSync(file)) continue;
    const meta = JSON.parse(readFileSync(file, "utf8"));
    const marker = meta.datumPlugin?.sentinel ?? meta.datumBinding?.global;
    if (isText(marker)) linked.push({ name, marker });
  }
  return linked;
}

/** The problems with the bundle `meta` names in `dist`, through `expect(condition, message)`. */
export function checkPluginBundle({ dist, bundle, sentinel, budgetKb, linked = [], expect }) {
  const files = [`${bundle}.js`, `${bundle}.iife.js`];
  const present = files.every((file) => existsSync(join(dist, file)));
  expect(present, `${files[0]} (and its .iife.js) is missing: every plugin package is a bundle of its own (src/bundle.ts)`);
  if (!present) return false;
  for (const file of files) {
    const text = readFileSync(join(dist, file), "utf8");
    expect(text.includes(sentinel), `${file} should carry ${sentinel}`);
    for (const { name, marker } of linked) {
      expect(!text.includes(marker), `${file} carries ${name} (${marker}): a package this one depends on belongs in its own bundle, never inside this one`);
    }
  }
  expect(statSync(join(dist, files[0])).size <= budgetKb * 1024, `${files[0]} is over the ${budgetKb} KB plugin-bundle budget`);
  return true;
}

/** The first line of a legal comment that says something: `Font Awesome Free 7.3.1 by ...`. */
function legalLine(comment) {
  for (const line of comment.split("\n")) {
    const text = line.replace(/^\s*(?:\/\*[!*]?|\*\/?|\/\/!?)/, "").replace(/\*\/\s*$/, "").trim();
    if (text !== "" && text !== "@license" && text !== "@preserve") {
      return text;
    }
  }
  return "";
}

/**
 * Writes `<bundle>.LICENSE.txt` and the carried packages' own licence files into `dist`, from the
 * bundle's source maps and the sidecar of legal comments (scripts/vite-bundle.ts), and removes the
 * sidecars. Returns the problems and the legal comments found.
 */
function writeLicenceFiles(dist, bundle) {
  const files = [`${bundle}.js`, `${bundle}.iife.js`];
  const sources = files.flatMap((file) => (existsSync(join(dist, `${file}.map`)) ? sourcesOfMap(join(dist, `${file}.map`)).map((source) => ({ file: source, scope: file.endsWith(".iife.js") ? "iife" : "core" })) : []));
  const packages = collectPackages(sources);
  const { comments, files: sidecars } = readLegalComments(dist, bundle);
  writeFileSync(join(dist, `${bundle}.LICENSE.txt`), renderLicenceFile({ bundle, covers: `It covers ${files.join(" and ")}.`, packages, legalComments: comments.join("\n\n") }));
  copyLicenceFiles(packages, dist);
  for (const name of sidecars) {
    rmSync(join(dist, name));
  }
  return { problems: packageProblems(packages), comments };
}

function main() {
  const meta = readPluginPackage(pluginDirArg());
  const dist = join(meta.dir, "dist");
  const entry = join(meta.dir, "src", "bundle.ts");
  if (!existsSync(entry)) {
    console.error(`plugin-build: ${entry} is missing (the bundle entry, which registers the package on load)`);
    process.exit(2);
  }
  const vite = join(ROOT, "node_modules", "vite", "bin", "vite.js");
  if (!existsSync(vite)) {
    console.error(`plugin-build: ${vite} is missing — run npm install in packages/datum`);
    process.exit(2);
  }

  rmSync(dist, { recursive: true, force: true });
  for (const format of ["es", "iife"]) {
    console.log(`plugin-build: ${meta.bundle} (${format})`);
    execFileSync(process.execPath, [vite, "build", "--config", join(ROOT, "scripts", "plugin-vite.config.ts"), "--logLevel", "warn"], {
      cwd: meta.dir,
      stdio: "inherit",
      env: { ...process.env, DATUM_BUNDLE_FORMAT: format, DATUM_PLUGIN_ENTRY: entry, DATUM_PLUGIN_GLOBAL: meta.global, DATUM_PLUGIN_BUNDLE: meta.bundle, DATUM_PLUGIN_OUT_DIR: dist }
    });
  }

  // The licence files come from the source maps, so they are written before the maps go.
  const problems = [];
  const licence = writeLicenceFiles(dist, meta.bundle);
  problems.push(...licence.problems);

  // The checks below read no source map; the bundles ship without them unless the build is asked
  // to keep them (DATUM_SOURCE_MAPS=1), as this package's own (scripts/strip-source-maps.mjs).
  // Stripped first, so the size budget is held against the file a page downloads.
  stripUnlessKept(dist, "plugin-build");

  const expect = (condition, message) => {
    if (!condition) problems.push(message);
  };
  checkPluginBundle({ dist, bundle: meta.bundle, sentinel: meta.sentinel, budgetKb: meta.budgetKb, linked: linkedPackages(meta.dir), expect });
  for (const file of [`${meta.bundle}.js`, `${meta.bundle}.iife.js`]) {
    const text = existsSync(join(dist, file)) ? readFileSync(join(dist, file), "utf8") : "";
    for (const comment of licence.comments) {
      const line = legalLine(comment);
      expect(line === "" || text.includes(line), `${file} should keep the legal comment "${line}" of the third-party code it carries`);
    }
  }
  for (const name of [`${meta.bundle}.js`, `${meta.bundle}.iife.js`]) {
    if (existsSync(join(dist, name))) console.log(`plugin-build: ${name.padEnd(36)} ${statSync(join(dist, name)).size} B`);
  }
  if (problems.length > 0) {
    console.error(`plugin-build: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
    process.exit(1);
  }
  console.log(`plugin-build: ${meta.bundle} ok`);
}

// Run as a script (a package's `npm run build` reaches it through node_modules, a link: compared as real paths).
if (process.argv[1] && existsSync(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main();
}
