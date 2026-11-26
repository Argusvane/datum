// Writes `<bundle>.LICENSE.txt` beside every bundle of dist/ (datum-form, datum-builder, datum-pdf,
// datum-pdf-pages, datum-wasm, datum-engine): the licence text of each third-party package the bundle
// carries and the legal comments the bundler found in those packages' sources. The bundles hold
// none of it (it would be bytes in files measured against a size budget, repeated in every lazy
// chunk); a host copies the `.LICENSE.txt` beside the bundle it serves.
//
// The packages come from the bundle's own source maps: a package is listed when one of its files is
// a source of a built chunk, so a dependency the bundler shook out of the output has no entry.
// Each package is read from node_modules (version, licence, licence files) and held to the lockfile
// of the project that installed it. A package without a licence text is reported and fails the build:
// something has to be shipped beside its code.
//
// A chunk's scope (core or pdf) is the one the hosts ship it in: the `pdf` and `pdf-pages` lists of the feature
// manifest, computed here from the built files with the function feature-files.mjs writes dist/feature-files.json
// with, so the notice rows follow the files a host's PDF module holds whatever a chunk is called.
//
// Run by `npm run build` after check-bundles and before strip-source-maps (both need the maps this
// one reads); the esbuild-built PDF program writes its own file (packages/pdf-kernel, copied by
// copy-assets.mjs), and the plugin build writes a plugin's (scripts/plugin-build.mjs).
import { existsSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { BUNDLES, bundleScopesOfDist, collectPackages, packageProblems, readLegalComments, renderLicenceFile, sourcesOfMap } from "./notices-lib.mjs";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");

/** The sentence that says which files a bundle's licence file covers. */
const COVERS = {
  "datum-form": "It covers datum-form.js, datum-form.iife.js and the lazy chunks datum-form-*.js.",
  "datum-builder": "It covers datum-builder.js, datum-builder.iife.js and the lazy chunks datum-builder-*.js.",
  "datum-pdf": "It covers datum-pdf.js and its chunks datum-pdf-*.js.",
  "datum-pdf-pages": "It covers datum-pdf-pages.js, the pdf.js page imagery module.",
  "datum-wasm": "It covers datum-wasm.js, the QuickJS sandbox module.",
  "datum-engine": "It covers datum-engine.js, the runtime with no element.",
  "datum-webauthn": "It covers datum-webauthn.js, the WebAuthn functions with no element."
};

if (!existsSync(dist)) {
  console.error(`bundle-notices: ${dist} is missing: run the bundle build first.`);
  process.exit(2);
}
const maps = readdirSync(dist).filter((name) => name.endsWith(".js.map"));
if (maps.length === 0) {
  console.error("bundle-notices: dist has no source maps, so it cannot say which packages a bundle carries. A default build runs this step before it removes the maps; to run it on its own, build with DATUM_SOURCE_MAPS=1.");
  process.exit(1);
}

const scopeOf = bundleScopesOfDist(dist);
const sourcesByBundle = new Map(BUNDLES.map((bundle) => [bundle, []]));
for (const map of maps) {
  const kind = scopeOf(map.slice(0, -".map".length));
  if (kind === null) {
    continue;
  }
  for (const file of sourcesOfMap(join(dist, map))) {
    sourcesByBundle.get(kind.bundle).push({ file, scope: kind.scope });
  }
}

const problems = [];
const consumed = [];
let written = 0;
for (const bundle of BUNDLES) {
  if (!existsSync(join(dist, `${bundle}.js`))) {
    continue;
  }
  const packages = collectPackages(sourcesByBundle.get(bundle));
  problems.push(...packageProblems(packages));
  // The sidecar the legal-comments plugin wrote for each format of the build (vite-bundle.ts).
  const { comments, files } = readLegalComments(dist, bundle);
  consumed.push(...files);
  writeFileSync(join(dist, `${bundle}.LICENSE.txt`), renderLicenceFile({ bundle, covers: COVERS[bundle], packages, legalComments: comments.join("\n\n") }));
  written += 1;
  console.log(`bundle-notices: ${bundle}.LICENSE.txt: ${packages.size} package${packages.size === 1 ? "" : "s"}, ${comments.length} legal comment${comments.length === 1 ? "" : "s"}`);
}
// A sidecar of a bundle that is not listed (a new entry) would sit in dist unclaimed.
for (const name of readdirSync(dist).filter((entry) => /\.legal-comments\.[a-z]+\.txt$/.test(entry) && !consumed.includes(entry))) {
  problems.push(`${name} belongs to no bundle of BUNDLES (scripts/notices-lib.mjs)`);
}
// The sidecars go once the files are written, so a run that fails can be run again.
if (problems.length === 0) {
  for (const name of consumed) {
    rmSync(join(dist, name));
  }
}
if (problems.length > 0) {
  console.error(`bundle-notices: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
console.log(`bundle-notices: ${written} licence file${written === 1 ? "" : "s"} written to dist/`);
