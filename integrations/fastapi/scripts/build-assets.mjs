#!/usr/bin/env node
// Builds the Python host's generated resources from packages/datum/dist and the repository's
// golden files. The host-neutral half (catalog, --omit-features, staging, freshness, ABIs, build id, manifest) is
// integrations/shared/assets-lib.mjs, shared by every host's asset build.
//
// Everything is staged first, under integrations/fastapi/build/ (resources.new/ and fixtures.new/, swapped in at the end), then
// each distribution's generated files are written into its project directory, integrations/fastapi/packages/<distribution>/:
//   argusvane-datum-programs     src/datum_programs/resources/   the two programs, DejaVu fonts + licence, freeze-intrinsics.js, programs.json
//   argusvane-datum-assets-ui    src/datum_assets_ui/assets/     the form and builder bundles outside the PDF feature, the builder fonts,
//                                                      builder-files.json (the builder's files of this AND the PDF distribution),
//                                                      feature-files.json (the bundle's, so omit_features withholds each token's files)
//   argusvane-datum-assets-pdf   src/datum_assets_pdf/assets/    the pdf and pdf-pages feature files (datum-pdf*.js, pdfjs/, the PDF designer)
//   argusvane-datum-qjs-wasm     src/datum_qjs_wasm/qjs-wasi.wasm (runtime.json is the pin: pin-runtime.mjs writes it)
//   argusvane-datum-fastapi      src/datum_fastapi/web/resources/datum-host.js   the shared page glue
//   the four resource distributions: src/<pkg>/manifest.json (identical in all four);
//   all eight: src/<pkg>/datum-build.json and <project>/NOTICE (from notices.json).
// The test fixtures go to integrations/fastapi/build/fixtures/ and ship in no wheel. Every dist file is claimed by exactly one
// distribution or by the documented skips (themes, plugins, .iife.js, .map, .d.ts, types/); a file nobody claims fails the build.
//
//   npm run datum:build && npm run fastapi:assets [-- --allow-stale] [-- --omit-features=<tokens>] [-- --dry-run]
import { cpSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFreshDist, buildIdOf, createStaging, describeOmission, fail, gitSource, manifestFor, parseOmitFeatures, programAbis, readCatalog, repoRoot as repo, distDir as dist } from "../../shared/assets-lib.mjs";
import { isBundleLicenceFile, licenceFilesFor } from "../../../packages/datum/scripts/notices-lib.mjs";
import { DISTRIBUTIONS, allocateDistFiles, isBuilderFile } from "./allocation.mjs";
import { fetchRuntime, loadPin } from "./fetch-runtime.mjs";
import { SETTINGS_SCHEMA_DIR, SETTINGS_SCHEMA_FILE, writeSettingsSchema } from "./settings-schema.mjs";

const LABEL = "fastapi:assets";
const here = dirname(fileURLToPath(import.meta.url));
const fastapiRoot = join(here, "..");
const packagesRoot = join(fastapiRoot, "packages");
const buildRoot = join(fastapiRoot, "build");
const argv = process.argv;

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: node integrations/fastapi/scripts/build-assets.mjs [options]

Builds the resource distributions' files from packages/datum/dist (run \`npm run datum:build\` first) into
integrations/fastapi/packages/<distribution>/, with manifest.json, datum-build.json and NOTICE, and the test fixtures into
integrations/fastapi/build/fixtures/.

Options:
  --allow-stale             build from a dist/ older than the sources
  --omit-features=<tokens>  leave out the files of these features; recorded as omittedFeatures in the manifest.
                            The PDF fonts always ship. Setting DATUM_WEB__ASSETS__OMIT_FEATURES names the same tokens at run time.
  --qjs-wasm-file <path>    take qjs-wasi.wasm from this file (air-gapped build); held to the pin in runtime.json
  --version <x.y.z>         the version datum-build.json records when a member's pyproject.toml has none yet
  --dry-run                 print the allocation table and write nothing
  --help, -h                this text`);
  process.exit(0);
}
const valueOf = (name) => {
  const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at < 0) {
    return undefined;
  }
  const value = argv[at].includes("=") ? argv[at].slice(name.length + 1) : argv[at + 1];
  if (!value) {
    fail(`${LABEL}: ${name} takes a value.`);
  }
  return value;
};
const allowStale = argv.includes("--allow-stale");
const dryRun = argv.includes("--dry-run");
const qjsWasmFile = valueOf("--qjs-wasm-file");
const versionFlag = valueOf("--version");

const omission = parseOmitFeatures(argv, dist, { label: LABEL, settingsHint: "DATUM_WEB__ASSETS__OMIT_FEATURES" });
const { omittedFeatures, omittedFiles } = omission;

for (const file of ["datum-form.js", "datum-builder.js", "datum-wasm.js", "datum-sandbox-program.js", "datum-pdf-program.js", "feature-files.json"]) {
  if (!existsSync(join(dist, file))) {
    fail(`${LABEL}: ${file} missing from packages/datum/dist — run \`npm run datum:build\` first (on a fresh clone, \`npm run fastapi:prepare\` runs every step this build needs).`);
  }
}
const featureFiles = JSON.parse(readFileSync(join(dist, "feature-files.json"), "utf8"));
const featureList = (token) => featureFiles.features?.[token]?.files ?? fail(`${LABEL}: dist/feature-files.json has no feature ${token}.`);
// The PDF feature, whole: the renderer's and the builder's chunks, the page module and pdf.js's worker and cmaps.
const pdfFeatureFiles = new Set([...featureList("pdf"), ...featureList("pdf-pages")]);

const everyDistFile = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dist, join(entry.parentPath ?? entry.path, entry.name)).split("\\").join("/"))
  .sort();
// A bundle's licence file (`<bundle>.LICENSE.txt`) is no distribution's file of its own: it is copied beside the bundle's main file, in the one distribution that ships it (licenceFilesFor).
const licenceFiles = everyDistFile.filter(isBundleLicenceFile);
const distFiles = everyDistFile.filter((file) => !isBundleLicenceFile(file));
const { buckets, unclaimed } = allocateDistFiles({ distFiles, pdfFeatureFiles, omittedFiles });
if (unclaimed.length > 0) {
  fail(`${LABEL}: no distribution claims ${unclaimed.slice(0, 10).join(", ")}${unclaimed.length > 10 ? ` and ${unclaimed.length - 10} more` : ""} — add them to allocateDistFiles() or its skip list in integrations/fastapi/scripts/allocation.mjs.`);
}
const catalog = readCatalog(undefined, repo, LABEL);
// Each distribution's files with the licence files of the bundles whose main file it ships; one a shipped bundle lacks stops the build.
const withLicences = (owner) => {
  const { files, missing } = licenceFilesFor(buckets[owner], licenceFiles);
  if (missing.length > 0) {
    fail(`${LABEL}: ${owner} ships a bundle whose licence file is missing from packages/datum/dist: ${missing.join(", ")} — run \`npm run datum:build\` first.`);
  }
  return [...buckets[owner], ...files];
};

const sizeOf = (files) => files.reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
// The builder's files live in two distributions (the PDF designer's chunks ride with the PDF feature); one combined list, kept in
// argusvane-datum-assets-ui, lets the asset route withhold all of them when the builder is off.
const builderFiles = [...buckets["argusvane-datum-assets-ui"], ...buckets["argusvane-datum-assets-pdf"]].filter(isBuilderFile).sort();
console.log(`${LABEL}: allocation of ${distFiles.length} dist file(s)`);
for (const [owner, files] of Object.entries(buckets)) {
  console.log(`  ${owner.padEnd(17)} ${String(files.length).padStart(4)} file(s) ${kib(sizeOf(files)).padStart(12)}${owner === "argusvane-datum-assets-ui" ? `  (${builderFiles.length} builder-only, both distributions)` : ""}`);
}
if (dryRun) {
  console.log(describeOmission(omission, LABEL));
  console.log(`\nfiles.json (every shipped file with its sha256, written beside builder-files.json):\n  datum_assets_ui/assets/files.json\n  datum_assets_pdf/assets/files.json`);
  console.log(`\nfeature-files.json (the bundle's token-to-files list, read by the asset catalog):\n  datum_assets_ui/assets/feature-files.json`);
  console.log(`\ndatum-core (generated after the workspace sync, not from dist/):\n  ${join(SETTINGS_SCHEMA_DIR, SETTINGS_SCHEMA_FILE)}`);
  for (const [owner, files] of Object.entries(buckets)) {
    if (owner !== "argusvane-datum-assets-pdf" || files.length < 40) {
      console.log(`\n${owner}:\n${files.map((file) => `  ${file}`).join("\n")}`);
    }
  }
  console.log(`\n${LABEL} --dry-run: nothing written.`);
  process.exit(0);
}

// The fixtures step runs the conformance suite's own command, which is that package's build output.
const hostCheckCommand = join(repo, "packages", "conformance-suite", "dist", "host-check.mjs");
if (!existsSync(hostCheckCommand)) {
  fail(`${LABEL}: ${relative(repo, hostCheckCommand)} is missing — run \`npm ci\` in packages/submissions and in packages/conformance-suite, then \`node scripts/build-cli.mjs\` in packages/conformance-suite (on a fresh clone, \`npm run fastapi:prepare\` runs every step this build needs).`);
}

assertFreshDist({
  shippedBundles: [...buckets["argusvane-datum-programs"], ...buckets["argusvane-datum-assets-ui"], ...buckets["argusvane-datum-assets-pdf"]].filter((file) => file.endsWith(".js")),
  // integrations/shared/{glue,db} are copied inputs, not sources of dist/ (assertFreshDist leaves them out whatever is listed).
  sourceDirs: [join(repo, "engine", "form-engine"), join(repo, "packages", "datum", "src"), join(repo, "packages", "pdf-kernel", "src")],
  allowStale,
  label: LABEL
});

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const { stage, swap } = createStaging();
mkdirSync(buildRoot, { recursive: true });
const resources = stage(buildRoot, { stageName: "resources.new", finalName: "resources" });
const fixtures = stage(buildRoot, { stageName: "fixtures.new", finalName: "fixtures" });
const projectOf = (name) => join(resources, name);
const pkgOf = (name) => DISTRIBUTIONS.find((entry) => entry.name === name).pkg;
const srcOf = (name) => join(projectOf(name), "src", pkgOf(name));
const copyInto = (target, files) => {
  for (const file of files) {
    mkdirSync(dirname(join(target, file)), { recursive: true });
    copyFileSync(join(dist, file), join(target, file));
  }
};

// argusvane-datum-programs: the programs and fonts keep their dist names; the freeze snippet is generated from the sandbox program's
// source by the catalog (never pasted); the DejaVu licence ships beside the fonts.
const programsRoot = join(srcOf("argusvane-datum-programs"), "resources");
copyInto(programsRoot, withLicences("argusvane-datum-programs"));
writeFileSync(join(programsRoot, "freeze-intrinsics.js"), catalog.freezeIntrinsicsSnippet);
const dejavuLicence = join(repo, "packages", "datum", "node_modules", "dejavu-fonts-ttf", "LICENSE");
if (!existsSync(dejavuLicence)) {
  fail(`${LABEL}: ${relative(repo, dejavuLicence)} is missing (the DejaVu licence ships with the fonts) — run npm install in packages/datum.`);
}
mkdirSync(join(programsRoot, "fonts"), { recursive: true });
copyFileSync(dejavuLicence, join(programsRoot, "fonts", "LICENSE-DejaVu.txt"));
const { sandboxAbi, pdfAbi } = programAbis(readFileSync(join(programsRoot, "datum-sandbox-program.js"), "utf8"), readFileSync(join(programsRoot, "datum-pdf-program.js"), "utf8"), LABEL);
const programFiles = {};
const walk = (dir, base, into) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path, base, into);
    } else {
      into[relative(base, path).split("\\").join("/")] = sha256(path);
    }
  }
};
walk(programsRoot, programsRoot, programFiles);
const sortedFiles = Object.fromEntries(Object.entries(programFiles).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(programsRoot, "programs.json"), `${JSON.stringify({ sandboxAbi, pdfAbi, files: sortedFiles }, null, 2)}\n`);

// argusvane-datum-assets-ui and argusvane-datum-assets-pdf: the browser files under assets/.
copyInto(join(srcOf("argusvane-datum-assets-ui"), "assets"), withLicences("argusvane-datum-assets-ui"));
copyInto(join(srcOf("argusvane-datum-assets-pdf"), "assets"), withLicences("argusvane-datum-assets-pdf"));
writeFileSync(join(srcOf("argusvane-datum-assets-ui"), "assets", "builder-files.json"), `${JSON.stringify({ files: builderFiles }, null, 2)}\n`);
// feature-files.json: the bundle's own token-to-files list, byte for byte. The catalog reads it at start so every token a site can
// name in omit_features withholds its files at run time (an unknown token stops the start); files.json lists it below.
copyFileSync(join(dist, "feature-files.json"), join(srcOf("argusvane-datum-assets-ui"), "assets", "feature-files.json"));
// files.json: each shipped relative path with its sha256 (the digest form of programs.json), sorted, files.json itself left out.
for (const name of ["argusvane-datum-assets-ui", "argusvane-datum-assets-pdf"]) {
  const assetsRoot = join(srcOf(name), "assets");
  const listed = {};
  walk(assetsRoot, assetsRoot, listed);
  const sorted = Object.fromEntries(Object.entries(listed).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(assetsRoot, "files.json"), `${JSON.stringify({ files: sorted }, null, 2)}\n`);
}

// argusvane-datum-qjs-wasm: the verified runtime, fetched (or taken from --qjs-wasm-file) into build/cache/, which a swap never touches.
const pin = loadPin();
const cachedWasm = await fetchRuntime({ pin, out: join(buildRoot, "cache", pin.asset), file: qjsWasmFile }).catch((error) => fail(error instanceof Error ? error.message : String(error)));
mkdirSync(srcOf("argusvane-datum-qjs-wasm"), { recursive: true });
copyFileSync(cachedWasm, join(srcOf("argusvane-datum-qjs-wasm"), pin.asset));

// argusvane-datum-fastapi: the shared page glue.
const sharedRoot = join(repo, "integrations", "shared");
const glue = join(sharedRoot, "glue", "datum-host.js");
if (!existsSync(glue)) {
  fail(`${LABEL}: ${relative(repo, glue)} is missing.`);
}
mkdirSync(join(srcOf("argusvane-datum-fastapi"), "web", "resources"), { recursive: true });
copyFileSync(glue, join(srcOf("argusvane-datum-fastapi"), "web", "resources", "datum-host.js"));

// One build id over the four resource distributions' files; manifest.json (identical in all four) comes after it.
const resourceDists = DISTRIBUTIONS.filter((entry) => entry.resource).map((entry) => entry.name);
const buildId = createHash("sha256").update(resourceDists.map((name) => buildIdOf(srcOf(name))).join("|")).digest("hex").slice(0, 12);
const source = gitSource();
const manifest = manifestFor({ generatedBy: "integrations/fastapi/scripts/build-assets.mjs", buildId, source, catalog, sandboxAbi, pdfAbi, omittedFeatures, extensions: [] });
for (const name of resourceDists) {
  writeFileSync(join(srcOf(name), "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// datum-build.json (every package) and NOTICE (every project directory). The version is the member's own: its pyproject.toml, else --version.
const versionOf = (name) => {
  const toml = join(packagesRoot, name, "pyproject.toml");
  if (existsSync(toml)) {
    const project = /^\[project\]\s*$([\s\S]*?)(?=^\[|$(?![\s\S]))/m.exec(readFileSync(toml, "utf8"));
    const found = project && /^version\s*=\s*"([^"]+)"/m.exec(project[1]);
    if (found) {
      return found[1];
    }
  }
  if (versionFlag) {
    return versionFlag;
  }
  console.warn(`${LABEL}: ${name} has no static version in its pyproject.toml and no --version was given; datum-build.json records 0.0.0.dev0.`);
  return "0.0.0.dev0";
};
const notices = JSON.parse(readFileSync(join(here, "notices.json"), "utf8"));
for (const name of Object.keys(notices.modules)) {
  if (!DISTRIBUTIONS.some((entry) => entry.name === name)) {
    fail(`${LABEL}: notices.json has rows for ${name}, which is not one of the eight distributions.`);
  }
}
// The copyright line is the repository LICENSE's own, so the notice never drifts from it and never carries a build date.
const copyright = readFileSync(join(repo, "LICENSE"), "utf8").split(/\r?\n/).find((line) => line.startsWith("Copyright (c)")) ?? fail(`${LABEL}: LICENSE has no "Copyright (c)" line.`);
for (const { name } of DISTRIBUTIONS) {
  mkdirSync(srcOf(name), { recursive: true });
  writeFileSync(join(srcOf(name), "datum-build.json"), `${JSON.stringify({ version: versionOf(name), buildId, sandboxAbi, pdfAbi, source }, null, 2)}\n`);
  const rows = notices.modules[name] ?? [];
  const vendored = rows.filter((row) => row.kind === "vendored");
  const lines = [
    `Datum for FastAPI: ${name}`,
    `${copyright}. Licensed under the MIT License (see LICENSE).`,
    "",
    vendored.length > 0 ? "This distribution ships the third-party components marked (vendored) inside its files; the others are installed beside it, each under its own licence." : rows.length > 0 ? "This distribution ships no third-party files; the components below are installed beside it, each under its own licence." : "This distribution bundles no third-party components.",
    ""
  ];
  for (const row of rows) {
    const where = row.kind === "vendored" ? "vendored" : row.kind === "extra" ? `installed by the [${row.extra}] extra` : "dependency";
    lines.push(`== ${row.name} ${row.version} (${row.license}) — ${where} ==`, `Source: ${row.source}`, "");
    if (row.textFile) {
      const textPath = join(repo, row.textFile);
      if (!existsSync(textPath)) {
        fail(`${LABEL}: notices.json names ${row.textFile} for ${row.name}, which does not exist.`);
      }
      lines.push(readFileSync(textPath, "utf8").trimEnd(), "");
    }
  }
  writeFileSync(join(projectOf(name), "NOTICE"), `${lines.join("\n")}\n`);
}

// The test fixtures (build output, read by the tests through the datum_fixtures session fixture): the very bytes the TypeScript side checks.
const need = (path) => (existsSync(path) ? path : fail(`${LABEL}: fixture ${relative(repo, path)} is missing.`));
const conformance = join(repo, "packages", "conformance-suite");
const kernelFixtures = join(repo, "packages", "pdf-kernel", "tests", "fixtures");
copyFileSync(need(join(conformance, "golden", "abi-1.0.json")), join(fixtures, "abi-1.0.json"));
copyFileSync(need(join(conformance, "fixtures", "endpoint-fixture.definition.json")), join(fixtures, "endpoint-fixture.definition.json"));
cpSync(need(join(kernelFixtures, "documents")), join(fixtures, "documents"), { recursive: true });
cpSync(need(join(kernelFixtures, "signing")), join(fixtures, "signing"), { recursive: true });
mkdirSync(join(fixtures, "shared"), { recursive: true });
for (const name of readdirSync(need(join(sharedRoot, "fixtures"))).filter((entry) => entry.endsWith(".json"))) {
  copyFileSync(join(sharedRoot, "fixtures", name), join(fixtures, "shared", name));
}
copyFileSync(need(join(sharedRoot, "endpoint-catalog.json")), join(fixtures, "endpoint-catalog.json"));
// The conformance kit writes its own fixtures (fixture form, golden file, hostile rule module, stale program).
const kit = spawnSync(process.execPath, [need(join(conformance, "dist", "host-check.mjs")), "fixtures", "--out", join(fixtures, "host-check")], { encoding: "utf8" });
if (kit.status !== 0) {
  fail(`${LABEL}: the conformance kit's fixtures command failed:\n${kit.stderr || kit.stdout}`);
}

// Everything staged: swap build/resources and build/fixtures in, then lay each distribution's generated files into its project directory.
swap();
const GENERATED = {
  "argusvane-datum-qjs-wasm": [join("src", "datum_qjs_wasm", pin.asset)],
  "argusvane-datum-programs": [join("src", "datum_programs", "resources")],
  "argusvane-datum-assets-ui": [join("src", "datum_assets_ui", "assets")],
  "argusvane-datum-assets-pdf": [join("src", "datum_assets_pdf", "assets")],
  "argusvane-datum-sandbox": [],
  "argusvane-datum-core": [],
  "argusvane-datum-sandbox-wasmtime": [],
  "argusvane-datum-fastapi": [join("src", "datum_fastapi", "web", "resources")]
};
let written = 0;
for (const { name, pkg, resource } of DISTRIBUTIONS) {
  const project = join(packagesRoot, name);
  const staged = join(buildRoot, "resources", name);
  const owned = [...GENERATED[name], "NOTICE", join("src", pkg, "datum-build.json"), ...(resource ? [join("src", pkg, "manifest.json")] : [])];
  for (const path of owned) {
    rmSync(join(project, path), { recursive: true, force: true });
    mkdirSync(dirname(join(project, path)), { recursive: true });
    cpSync(join(staged, path), join(project, path), { recursive: true });
    written += 1;
  }
}
const countFiles = (dir) => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).length;
// argusvane-datum-core's settings schema: written by the argusvane-datum-core module after the workspace sync; a missing uv or module skips it.
writeSettingsSchema({ target: join(fastapiRoot, SETTINGS_SCHEMA_DIR, SETTINGS_SCHEMA_FILE), log: (line) => console.log(line) });
console.log(`${LABEL}: wrote ${written} generated path(s) into ${relative(process.cwd(), packagesRoot) || "."}; sandbox ABI ${sandboxAbi}, PDF ABI ${pdfAbi}, build ${buildId}; ${buckets["argusvane-datum-programs"].length + 3} programs files, ${buckets["argusvane-datum-assets-ui"].length + 1} ui files, ${buckets["argusvane-datum-assets-pdf"].length} pdf files, ${countFiles(join(buildRoot, "fixtures"))} fixtures`);
if (omittedFeatures.length > 0) {
  console.log(`${LABEL}: left out ${buckets.omitted.length} file(s) for ${omittedFeatures.join(", ")} (--omit-features).`);
}
