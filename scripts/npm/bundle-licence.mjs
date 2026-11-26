// Writes the licence file of a package that bundles its dependencies with esbuild: the third-party
// packages inside its built files, each with its version, licence and licence text, in
// `dist/<name>.LICENSE.txt` (the form packages/datum's own `dist/<bundle>.LICENSE.txt` files have, so
// scripts/npm/prepack.mjs reads all of them the same way). esbuild's unminified output names the
// source file of every module in a `// <path>` comment, relative to the folder it built from; the
// ones under a `node_modules` folder say which packages the file carries, and the installed
// packages and their lockfiles say the rest (packages/datum/scripts/notices-lib.mjs).
//
//   node ../../scripts/npm/bundle-licence.mjs <name> <built file>...     from the package folder, after the build
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { collectPackages, packageProblems, renderLicenceFile } from "../../packages/datum/scripts/notices-lib.mjs";

/** The absolute source files under a node_modules folder that esbuild's path comments name in `text`. */
export function sourcesOfEsbuildOutput(text, root) {
  const files = new Set();
  for (const line of text.split("\n")) {
    const match = /^\/\/ (\S*node_modules\/\S+)$/.exec(line);
    if (match) {
      files.add(resolve(root, match[1]));
    }
  }
  return [...files];
}

/** Writes `<dist>/<name>.LICENSE.txt` for the built `files` (paths relative to `root`); returns the package count. */
export function writeThirdPartyLicence({ root, name, files }) {
  const sources = files.flatMap((file) => sourcesOfEsbuildOutput(readFileSync(join(root, file), "utf8"), root).map((path) => ({ file: path, scope: "core" })));
  const packages = collectPackages(sources);
  const problems = packageProblems(packages);
  if (problems.length > 0) {
    throw new Error(`${name}: ${problems.join("; ")}`);
  }
  if (packages.size === 0) {
    throw new Error(`${name}: found no third-party package in ${files.join(", ")}: is the output minified, or built without path comments?`);
  }
  const dist = join(root, "dist");
  mkdirSync(dist, { recursive: true });
  const covers = `This file covers the third-party code bundled into ${files.join(", ")}.`;
  writeFileSync(join(dist, `${name}.LICENSE.txt`), renderLicenceFile({ bundle: name, covers, packages }));
  return packages.size;
}

function main() {
  const [name, ...files] = process.argv.slice(2);
  if (!name || files.length === 0) {
    console.error("usage: node bundle-licence.mjs <name> <built file>...");
    process.exit(2);
  }
  const count = writeThirdPartyLicence({ root: process.cwd(), name, files });
  console.log(`bundle-licence: dist/${name}.LICENSE.txt: ${count} packages`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
