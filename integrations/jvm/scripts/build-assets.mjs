#!/usr/bin/env node
// Builds the JVM hosts' generated assets (every JVM host binding reuses the same jars) from
// packages/datum/dist: the two server programs, the PDF fonts and the freeze snippet go
// to datum-programs; the PDF feature's browser files to datum-pdf; the form and builder bundles to
// datum-ui. The host-neutral half (catalog, --omit-features, staging, freshness, ABIs, manifest)
// is integrations/shared/assets-lib.mjs, shared by every host's asset build, so no two hosts can
// disagree about what a build id or a manifest is.
//
// Output: everything goes under one directory, integrations/jvm/target/datum-assets by default, which the
// reactor's root pom fills once per build at generate-resources (exec-maven-plugin runs this script) and every module's
// pom reads from (${maven.multiModuleProjectDirectory}/target/datum-assets/<artifactId>); `mvn clean` at the root removes
// it. Per module, <out>/<module>/ holds what the poms put under META-INF/datum/:
//   datum-programs/programs/  the two programs, DejaVu fonts + licence, freeze-intrinsics.js, programs.json
//   datum-ui/assets/          datum-form*, datum-wasm.js, the CSS, the builder, builder-files.json
//                             (lists the builder-only files of datum-ui AND datum-pdf)
//   datum-pdf/assets/         the pdf and pdf-pages feature files (datum-pdf*.js, pdfjs/)
//   <module>/manifest.json    identical in all three; <module>/NOTICE (from notices.json) in every published module
//   <module>/datum/...        the shared glue (datum-web-core) and SQL migrations (forms, submissions, timestamp,
//                             webauthn) copied from integrations/shared, laid into META-INF/datum/ by the parent pom
//   datum-host-tck/           the host test kit's fixture form and golden answers (META-INF/datum-tck/ in its jar)
//   datum-sandbox-tck/        the engine test kit's golden answers, fixture form and parity documents
//                             (META-INF/datum-sandbox-tck/ in its jar)
//   assets.properties         the Datum-* jar manifest entries, read by the parent pom's properties plugin
// Each module's directory is built beside it as <module>.new and swapped in at the end, so a failed or killed build never
// leaves a half-written one. The test fixtures are generated output too: <out>/<module>/test-fixtures/, which the
// parent pom maps as a test resource directory onto datum-fixtures/ on the test class path, so nothing generated sits beside src.
// Every dist file is claimed by exactly one module or by the explicit skip list (allocation.mjs); a file nobody
// claims fails the build, so a new bundle cannot silently go missing from the jars.
//
//   npm run datum:build && npm run jvm:assets [-- --allow-stale] [-- --omit-features=<tokens>] [-- --dry-run]
//   a Maven build runs it itself:
//   ./mvnw -N generate-resources (in integrations/jvm) writes the same directory.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { isBundleLicenceFile, licenceFilesFor } from "../../../packages/datum/scripts/notices-lib.mjs";
import { allocateDistFiles, isBuilderFile } from "./allocation.mjs";
import { assertFreshDist, buildIdOf, createStaging, describeOmission, fail, gitSource, manifestFor, parseOmitFeatures, programAbis, readCatalog, repoRoot as repo, distDir as dist } from "../../shared/assets-lib.mjs";

const LABEL = "jvm:assets";
const here = dirname(fileURLToPath(import.meta.url));
const jvmRoot = join(here, "..");
// The reactor's module groups: the framework-free libraries, the Spring Boot bindings and starters, the
// host test kit. A module is found by its artifact directory name in one of them.
const MODULE_GROUPS = ["libs", "spring", "tck"];
const moduleDir = (name) => {
  for (const group of MODULE_GROUPS) {
    const dir = join(jvmRoot, group, name);
    if (existsSync(join(dir, "pom.xml"))) {
      return dir;
    }
  }
  fail(`${LABEL}: no module ${name} under integrations/jvm/{${MODULE_GROUPS.join(",")}}.`);
};
// The checked-in files shared by every host (integrations/shared): the page glue and the SQL migration scripts.
const SQL_DIALECTS = ["h2", "postgresql", "mysql"];
const sharedGlue = join(repo, "integrations", "shared", "glue", "datum-host.js");
const sharedMigrations = join(repo, "integrations", "shared", "db", "migration");
const argv = process.argv;

if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: node integrations/jvm/scripts/build-assets.mjs [options]

Builds datum-programs, datum-ui and datum-pdf assets from packages/datum/dist (run
\`npm run datum:build\` first) into <out>/<module>/, with the notices, the kit's fixtures and assets.properties.

Options:
  --out <dir>               where the module directories go (default integrations/jvm/target/datum-assets); a relative
                            path is read from the current directory
  --allow-stale[=<bool>]    build from a dist/ older than the sources (--allow-stale=false is the default)
  --omit-features=<tokens>  leave out the files of these features; recorded as
                            omittedFeatures in the manifest. The PDF fonts always ship.
  --dry-run                 print the allocation table and write nothing
  --help, -h                this text`);
  process.exit(0);
}
// --allow-stale, or --allow-stale=true|false (the Maven build passes its datum.assets.allowStale property that way).
const staleArg = argv.find((arg) => arg === "--allow-stale" || arg.startsWith("--allow-stale="));
// Anything else (False, no, 0) is refused: a permissive reading would switch the freshness guard off by a typo.
if (staleArg !== undefined && !["--allow-stale", "--allow-stale=true", "--allow-stale=false"].includes(staleArg)) {
  fail(`${LABEL}: ${staleArg} is not valid; datum.assets.allowStale / --allow-stale takes true or false.`);
}
const allowStale = staleArg !== undefined && staleArg !== "--allow-stale=false";
const dryRun = argv.includes("--dry-run");
const outAt = argv.findIndex((arg) => arg === "--out" || arg.startsWith("--out="));
const outArg = outAt < 0 ? undefined : argv[outAt].startsWith("--out=") ? argv[outAt].slice("--out=".length) : argv[outAt + 1];
if (outAt >= 0 && !outArg) {
  fail(`${LABEL}: --out takes a directory.`);
}
const out = outArg ? resolve(outArg) : join(jvmRoot, "target", "datum-assets");
const moduleOut = (name) => join(out, name);

const omission = parseOmitFeatures(argv, dist, { label: LABEL });
const { omittedFeatures, omittedFiles } = omission;

for (const file of ["datum-form.js", "datum-builder.js", "datum-wasm.js", "datum-sandbox-program.js", "datum-pdf-program.js", "feature-files.json"]) {
  if (!existsSync(join(dist, file))) {
    fail(`${LABEL}: ${file} missing from packages/datum/dist — run \`npm run datum:build\` first.`);
  }
}

const featureFiles = JSON.parse(readFileSync(join(dist, "feature-files.json"), "utf8"));
const featureList = (token) => featureFiles.features?.[token]?.files ?? fail(`${LABEL}: dist/feature-files.json has no feature ${token}.`);
// The PDF feature, whole: the renderer's and the builder's chunks, the page module and
// pdf.js's worker and cmaps. The fonts in its list are the programs', claimed first below.
const pdfFeatureFiles = new Set([...featureList("pdf"), ...featureList("pdf-pages")]);


/** Every dist file, as a forward-slash path relative to dist/. */
const everyDistFile = readdirSync(dist, { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => relative(dist, join(entry.parentPath ?? entry.path, entry.name)).split("\\").join("/"))
  .sort();
// A bundle's licence file (`<bundle>.LICENSE.txt`) is no module's file of its own: it is copied beside the bundle's main file, in the one module that ships it (licenceFilesFor).
const licenceFiles = everyDistFile.filter(isBundleLicenceFile);
const distFiles = everyDistFile.filter((file) => !isBundleLicenceFile(file));

const { buckets: allocation, unclaimed } = allocateDistFiles({ distFiles, pdfFeatureFiles, omittedFiles });
if (unclaimed.length > 0) {
  fail(`${LABEL}: no module claims ${unclaimed.slice(0, 10).join(", ")}${unclaimed.length > 10 ? ` and ${unclaimed.length - 10} more` : ""} — add them to allocateDistFiles() or the skip lists in integrations/jvm/scripts/allocation.mjs.`);
}
const catalog = readCatalog(undefined, repo, LABEL);
// Each module's files with the licence files of the bundles whose main file it ships; one a shipped bundle lacks stops the build.
const withLicences = (module) => {
  const { files, missing } = licenceFilesFor(allocation[module], licenceFiles);
  if (missing.length > 0) {
    fail(`${LABEL}: ${module} ships a bundle whose licence file is missing from packages/datum/dist: ${missing.join(", ")} — run \`npm run datum:build\` first.`);
  }
  return [...allocation[module], ...files];
};

const sizeOf = (files) => files.reduce((sum, file) => sum + statSync(join(dist, file)).size, 0);
const kib = (bytes) => `${(bytes / 1024).toFixed(1)} KiB`;
// Builder-only chunks live in two jars: the PDF designer's chunks are allocated to datum-pdf with
// the rest of the PDF feature. One combined list (written into datum-ui's builder-files.json, the
// single copy on the classpath) lets the asset handler withhold all of them when the builder is off.
const builderFiles = [...allocation["datum-ui"], ...allocation["datum-pdf"]].filter(isBuilderFile).sort();
for (const owner of ["datum-programs", "datum-ui", "datum-pdf"]) {
  const missing = allocation[owner].filter((file) => isBuilderFile(file) && !builderFiles.includes(file));
  if (missing.length > 0) {
    fail(`${LABEL}: builder file(s) ${missing.join(", ")} in ${owner} are missing from builder-files.json.`);
  }
}
console.log(`${LABEL}: allocation of ${distFiles.length} dist file(s)`);
for (const [owner, files] of Object.entries(allocation)) {
  console.log(`  ${owner.padEnd(15)} ${String(files.length).padStart(4)} file(s) ${kib(sizeOf(files)).padStart(12)}${owner === "datum-ui" ? `  (${builderFiles.length} builder-only, both jars)` : ""}`);
}
if (dryRun) {
  console.log(describeOmission(omission, LABEL));
  for (const [owner, files] of Object.entries(allocation)) {
    if (owner !== "datum-pdf" || files.length < 40) {
      console.log(`\n${owner}:\n${files.map((file) => `  ${file}`).join("\n")}`);
    }
  }
  process.exit(0);
}

// A dist/ older than its sources is a forgotten rebuild (the oldest shipped bundle must be newer
// than the newest source). Only what this build ships counts.
assertFreshDist({
  shippedBundles: [...allocation["datum-programs"], ...allocation["datum-ui"], ...allocation["datum-pdf"]].filter((file) => file.endsWith(".js")),
  // integrations/shared/{glue,db} are copied inputs of this build, not sources of dist/ (assertFreshDist leaves them out
  // whatever a caller lists): an edit there needs this script to run again, never a packages/datum rebuild.
  sourceDirs: [join(repo, "engine", "form-engine"), join(repo, "packages", "datum", "src"), join(repo, "packages", "pdf-kernel", "src")],
  allowStale,
  label: LABEL
});

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const { stage, swap } = createStaging();
mkdirSync(out, { recursive: true });
const staged = Object.fromEntries(["datum-programs", "datum-ui", "datum-pdf"].map((name) => [name, stage(out, { stageName: `${name}.new`, finalName: name })]));

const copyInto = (stagedDir, sub, files) => {
  for (const file of files) {
    const target = join(stagedDir, sub, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(dist, file), target);
  }
};

// datum-programs: the programs and fonts keep their dist names (the fonts under fonts/), beside
// the generated freeze snippet and the DejaVu licence.
const programsRoot = join(staged["datum-programs"], "programs");
copyInto(staged["datum-programs"], "programs", withLicences("datum-programs"));
writeFileSync(join(programsRoot, "freeze-intrinsics.js"), catalog.freezeIntrinsicsSnippet);
const dejavuLicence = join(repo, "packages", "datum", "node_modules", "dejavu-fonts-ttf", "LICENSE");
if (!existsSync(dejavuLicence)) {
  fail(`${LABEL}: ${relative(repo, dejavuLicence)} is missing (the DejaVu licence ships with the fonts) — run npm install in packages/datum.`);
}
mkdirSync(join(programsRoot, "fonts"), { recursive: true });
copyFileSync(dejavuLicence, join(programsRoot, "fonts", "LICENSE-DejaVu.txt"));

const { sandboxAbi, pdfAbi } = programAbis(
  readFileSync(join(programsRoot, "datum-sandbox-program.js"), "utf8"),
  readFileSync(join(programsRoot, "datum-pdf-program.js"), "utf8"),
  LABEL
);
const programFiles = {};
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(path);
    } else {
      programFiles[relative(programsRoot, path).split("\\").join("/")] = sha256(path);
    }
  }
};
walk(programsRoot);
const sortedFiles = Object.fromEntries(Object.entries(programFiles).sort(([a], [b]) => a.localeCompare(b)));
writeFileSync(join(programsRoot, "programs.json"), `${JSON.stringify({ sandboxAbi, pdfAbi, files: sortedFiles }, null, 2)}\n`);

// datum-ui and datum-pdf: browser files under assets/assets/ (the jar's META-INF/datum/assets/).
copyInto(staged["datum-ui"], "assets", withLicences("datum-ui"));
copyInto(staged["datum-pdf"], "assets", withLicences("datum-pdf"));
// The builder-only files of datum-ui and datum-pdf, so the asset handler can withhold them when the builder is switched off.
writeFileSync(join(staged["datum-ui"], "assets", "builder-files.json"), `${JSON.stringify({ files: builderFiles }, null, 2)}\n`);

// One build id over the three modules' files; the manifest (inside assets/) comes after it.
const buildId = createHash("sha256").update(Object.values(staged).map((dir) => buildIdOf(dir)).join("|")).digest("hex").slice(0, 12);
const manifest = manifestFor({
  generatedBy: "integrations/jvm/scripts/build-assets.mjs",
  buildId,
  source: gitSource(),
  catalog,
  sandboxAbi,
  pdfAbi,
  omittedFeatures,
  // No extension registry yet: the plugins and their bundles are not packaged.
  extensions: []
});
for (const dir of Object.values(staged)) {
  writeFileSync(join(dir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

// META-INF/NOTICE per published module, from notices.json (every jar carries NOTICE and
// LICENSE; the parent pom's copy-legal execution moves <out>/<module>/NOTICE and the repository LICENSE
// into META-INF). The three asset modules stage theirs with the rest of their assets; every other jar
// gets its NOTICE written straight to its own <out>/<module>/ (header alone when it has no rows).
const notices = JSON.parse(readFileSync(join(here, "notices.json"), "utf8"));
const noticeDirs = { ...staged };
// The *-test-support modules hold test helpers and are never published, so they get no NOTICE.
const publishedModules = MODULE_GROUPS.filter((group) => existsSync(join(jvmRoot, group)))
  .flatMap((group) => readdirSync(join(jvmRoot, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("datum-") && !entry.name.endsWith("-test-support") && existsSync(join(jvmRoot, group, entry.name, "pom.xml")))
    .map((entry) => entry.name));
for (const name of publishedModules) {
  if (!(name in noticeDirs)) {
    noticeDirs[name] = moduleOut(name);
    mkdirSync(noticeDirs[name], { recursive: true });
  }
}
for (const name of Object.keys(notices.modules ?? {})) {
  if (!(name in noticeDirs)) {
    fail(`${LABEL}: notices.json has rows for ${name}, which is not a published module of integrations/jvm.`);
  }
}
// The copyright line is the repository LICENSE's own, so the notice never drifts from it and never carries a build date.
const copyright = readFileSync(join(repo, "LICENSE"), "utf8").split(/\r?\n/).find((line) => line.startsWith("Copyright (c)")) ?? fail(`${LABEL}: LICENSE has no "Copyright (c)" line.`);
for (const [name, dir] of Object.entries(noticeDirs)) {
  const rows = notices.modules?.[name] ?? [];
  // A row of kind "dependency" is a Maven dependency the jar declares and does not repackage; every other row is a file the jar carries.
  const bundled = rows.filter((entry) => entry.kind !== "dependency");
  const lines = [
    `Datum for the JVM: ${name}`,
    `${copyright}. Licensed under the MIT License (see LICENSE).`,
    "",
    rows.length === 0 ? "This artifact bundles no third-party components." : bundled.length === 0 ? "This artifact bundles no third-party files; the components below are Maven dependencies it declares, each under its own licence." : bundled.length === rows.length ? "This artifact bundles the third-party components below, each under its own licence." : "This artifact bundles the third-party components whose heading ends in \"— bundled\" inside its files; the others are Maven dependencies it declares and does not repackage, each under its own licence.",
    ""
  ];
  for (const entry of rows) {
    const where = entry.kind === "dependency" ? "dependency" : "bundled";
    lines.push(`== ${entry.name} ${entry.version} (${entry.license}) — ${where} ==`, `Source: ${entry.source}`, "");
    if (entry.textFile) {
      const textPath = join(repo, entry.textFile);
      if (!existsSync(textPath)) {
        fail(`${LABEL}: notices.json names ${entry.textFile} for ${entry.name}, which does not exist.`);
      }
      lines.push(readFileSync(textPath, "utf8").trimEnd(), "");
    }
  }
  writeFileSync(join(dir, "NOTICE"), `${lines.join("\n")}\n`);
}

// assets.properties (written to <out>, last): read by the reactor's properties-maven-plugin into the jar manifests.
const properties = [
  `datum.engineVersion=${catalog.engineVersion}`,
  `datum.sandboxAbi=${sandboxAbi}`,
  `datum.pdfAbi=${pdfAbi}`,
  `datum.buildId=${buildId}`,
  `datum.source=${manifest.source ?? ""}`
];

// Test fixtures (build output, <out>/<module>/test-fixtures/): copies of the repository's golden files, so a module's tests
// read the very bytes the TypeScript side checks (they appear on the test class path as datum-fixtures/).
// The host-neutral fixtures every host's tests read: integrations/shared/fixtures, written by
// integrations/shared/scripts/canonical-fixtures.ts (npm run shared:canonical-fixtures) beside the hand-written RFC 8785 vectors.
const sharedFixtures = join(repo, "integrations", "shared", "fixtures");
const engineJcsVectors = join(repo, "engine", "tests", "fixtures", "jcs-vectors.json");
const documents = join(repo, "packages", "pdf-kernel", "tests", "fixtures", "documents");
const fixturePlan = {
  "datum-core": [
    [join(repo, "packages", "conformance-suite", "golden", "abi-1.0.json"), "abi-1.0.json"],
    [join(repo, "packages", "conformance-suite", "fixtures", "endpoint-fixture.definition.json"), "endpoint-fixture.definition.json"],
    [join(sharedFixtures, "canonical.json"), "canonical.json"],
    [engineJcsVectors, "jcs-vectors-engine.json"],
    [join(sharedFixtures, "jcs-vectors.json"), "jcs-vectors-rfc8785.json"],
    [join(sharedFixtures, "webauthn-engine.json"), "webauthn-engine.json"]
  ],
  "datum-submissions": [
    [join(repo, "packages", "conformance-suite", "golden", "abi-1.0.json"), "abi-1.0.json"],
    [join(repo, "packages", "conformance-suite", "fixtures", "endpoint-fixture.definition.json"), "endpoint-fixture.definition.json"]
  ],
  "datum-pdf": [],
  "datum-webauthn": [
    [engineJcsVectors, "jcs-vectors.json"],
    // The shared RFC 8785 vectors (the RFC's examples plus the repository's tricky keys), the second corpus JcsTest holds the code to.
    [join(sharedFixtures, "jcs-vectors.json"), "jcs-vectors-rfc8785.json"],
    [join(sharedFixtures, "webauthn-engine.json"), "webauthn-engine.json"]
  ]
};
// datum-sandbox-endive has no rows: its golden, PDF and hardening ITs implement datum-sandbox-tck's contracts,
// which read the fixtures from the engine kit's own jar (below).
for (const name of readdirSync(documents).filter((entry) => entry.endsWith(".json"))) {
  fixturePlan["datum-pdf"].push([join(documents, name), join("documents", name)]);
}
// datum-pdf also reads the kernel's signing fixtures (keys and chains), beside the parity documents.
const signing = join(repo, "packages", "pdf-kernel", "tests", "fixtures", "signing");
for (const name of readdirSync(signing).filter((entry) => statSync(join(signing, entry)).isFile())) {
  fixturePlan["datum-pdf"].push([join(signing, name), join("signing", name)]);
}
let fixtureCount = 0;
// A staged module's directory is swapped in whole, so its fixtures go into the staged copy; the others are cleared first so a
// fixture the plan drops cannot linger in a test class path.
const fixtureRoot = (module) => join(staged[module] ?? moduleOut(module), "test-fixtures");
for (const module of Object.keys(fixturePlan)) {
  moduleDir(module);
  if (!staged[module]) {
    rmSync(fixtureRoot(module), { recursive: true, force: true });
  }
}
for (const [module, rows] of Object.entries(fixturePlan)) {
  for (const [from, name] of rows) {
    if (!existsSync(from)) {
      fail(`${LABEL}: fixture ${relative(repo, from)} is missing (the shared ones come from npm run shared:canonical-fixtures).`);
    }
    const target = join(fixtureRoot(module), name);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(from, target);
    fixtureCount += 1;
  }
}

// The host test kit's fixtures: the security suite's endpoint fixture form and its golden control
// answers travel in the kit's jar (META-INF/datum-tck/), so its contracts judge a host outside this checkout by the very
// bytes the TypeScript side checks.
const tckAssets = moduleOut("datum-host-tck");
mkdirSync(tckAssets, { recursive: true });
for (const [from, name] of [
  [join(repo, "packages", "conformance-suite", "golden", "abi-1.0.json"), "golden.json"],
  [join(repo, "packages", "conformance-suite", "fixtures", "endpoint-fixture.definition.json"), "fixture-form.json"]
]) {
  if (!existsSync(from)) {
    fail(`${LABEL}: the kit's fixture ${relative(repo, from)} is missing.`);
  }
  copyFileSync(from, join(tckAssets, name));
  fixtureCount += 1;
}
// The fixture form under a second key (datum-security-suite-b), for the per-route binding contract: two form routes on one host.
const fixtureForm = JSON.parse(readFileSync(join(repo, "packages", "conformance-suite", "fixtures", "endpoint-fixture.definition.json"), "utf8"));
writeFileSync(join(tckAssets, "fixture-form-b.json"), `${JSON.stringify({ ...fixtureForm, id: "datum-security-suite-b" }, null, 2)}\n`);
fixtureCount += 1;

// The engine test kit's fixtures: the security suite's golden answers and endpoint fixture form, and the PDF
// kernel's parity documents with their pinned hashes, travel in datum-sandbox-tck's jar (META-INF/datum-sandbox-tck/), so its
// contracts judge an engine outside this checkout by the very bytes the TypeScript side checks. Cleared first, so a document
// the kernel drops cannot linger in the kit.
const engineKitAssets = moduleOut("datum-sandbox-tck");
rmSync(join(engineKitAssets, "documents"), { recursive: true, force: true });
mkdirSync(join(engineKitAssets, "documents"), { recursive: true });
for (const [from, name] of [
  [join(repo, "packages", "conformance-suite", "golden", "abi-1.0.json"), "golden.json"],
  [join(repo, "packages", "conformance-suite", "fixtures", "endpoint-fixture.definition.json"), "fixture-form.json"],
  ...readdirSync(documents).filter((entry) => entry.endsWith(".json")).map((name) => [join(documents, name), join("documents", name)])
]) {
  if (!existsSync(from)) {
    fail(`${LABEL}: the engine kit's fixture ${relative(repo, from)} is missing.`);
  }
  copyFileSync(from, join(engineKitAssets, name));
  fixtureCount += 1;
}

// The shared page glue and SQL migrations (integrations/shared): checked in once for every host, copied into the owning
// library's <out>/<module>/datum/..., which the parent pom's copy-legal executions lay into META-INF/datum/... so the
// jars carry the classpath paths (META-INF/datum/web/datum-host.js, META-INF/datum/db/migration/
// <dialect>/V*.sql). A migration belongs to the module named by its file name (V100__datum_forms.sql -> datum-forms).
const sharedRoot = join(repo, "integrations", "shared");
const copyShared = (from, module, to) => {
  const target = join(moduleOut(module), "datum", to);
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(from, target);
  sharedCount += 1;
};
let sharedCount = 0;
// Clear what an earlier run laid down first, so a renamed or removed migration cannot leave a stale script in a jar.
for (const module of ["datum-web-core", "datum-forms", "datum-submissions", "datum-timestamp", "datum-webauthn"]) {
  for (const part of ["db", "web"]) {
    rmSync(join(moduleOut(module), "datum", part), { recursive: true, force: true });
  }
}
if (!existsSync(sharedGlue)) {
  fail(`${LABEL}: ${relative(repo, sharedGlue)} is missing.`);
}
copyShared(sharedGlue, "datum-web-core", join("web", "datum-host.js"));
for (const dialect of SQL_DIALECTS) {
  const dir = join(sharedMigrations, dialect);
  if (!existsSync(dir)) {
    fail(`${LABEL}: ${relative(repo, dir)} is missing.`);
  }
  for (const name of readdirSync(dir).filter((entry) => entry.endsWith(".sql")).sort()) {
    const owner = /^V\d+__(datum_[a-z]+)\.sql$/.exec(name)?.[1]?.replace("_", "-");
    if (!owner) {
      fail(`${LABEL}: ${relative(repo, join(dir, name))} is not named V<n>__datum_<module>.sql.`);
    }
    copyShared(join(dir, name), owner, join("db", "migration", dialect, name));
  }
}

// Everything built: swap each <module>.new in over its <module>/, then the properties file.
swap();
writeFileSync(join(out, "assets.properties"), `${properties.join("\n")}\n`);

console.log(`${LABEL}: wrote ${relative(process.cwd(), out) || "."}; sandbox ABI ${sandboxAbi}, PDF ABI ${pdfAbi}, build ${buildId}; ${allocation["datum-programs"].length + 2} programs files, ${allocation["datum-ui"].length + 1} ui files, ${allocation["datum-pdf"].length} pdf files, ${fixtureCount} fixtures, ${sharedCount} shared files`);
if (omittedFeatures.length > 0) {
  console.log(`${LABEL}: left out ${allocation.omitted.length} file(s) for ${omittedFeatures.join(", ")} (--omit-features).`);
}
