#!/usr/bin/env node
// Assembles the offline bundle of a release: every file Datum publishes, in one folder and one archive,
// for a deployment that has no registry and no network to install from. It never uploads: there is no
// code here that could, and the manifest says `"uploaded": false`.
//
//   npm run offline:bundle -- --version x.y.z [--build] [--skip <sections>] [--out <dir>] [options]
//
//   dist/offline/datum-offline-<version>/
//     README.md, manifest.json, SHA256SUMS, LICENSE, THIRD_PARTY_NOTICES.md, AIR-GAPPED.md
//     browser/     packages/datum/dist and the plugins' bundles: what a page loads
//     bindings/    the offline pack of each design-system binding (lib/packs.mjs)
//     runtime/     quickjs-ng's qjs-wasi.wasm with the pin it is held to
//     python/      the FastAPI release's wheels and sdists, and the third-party requirements with hashes
//     maven/       the JVM release's poms and jars as a Maven repository
//     tools/       the conformance suite as an npm tarball
//   dist/offline/datum-offline-<version>.tar.gz and .tar.gz.sha256
//
// The server sections come from the release folders the hosts' own release scripts write
// (`npm run fastapi:release`, `npm run jvm:release`; --build runs both as dry runs first). Each file is
// held to the digest its release recorded, and a release built with another sandbox or PDF ABI than the
// browser bundles here is refused: the parts of a bundle are one build or they are not a bundle.
//
// Before anything is written in place, the staged bundle is drawn in a browser that can reach nothing but
// the bundle (check.mjs --bundle). A page that asks another host for something stops the bundle.
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { assertFreshDist, distDir, programAbis } from "../../integrations/shared/assets-lib.mjs";
import { SECTIONS, bindingsSection, browserSection, describeFiles, mavenSection, pythonSection, readmeText, runtimeSection, sha256Of, sumsText, toolsSection } from "./lib/bundle.mjs";
import { buildBindingPacks, REFERENCE_BINDINGS, REPO, remoteReferences } from "./lib/packs.mjs";
import { writeTarGz } from "./lib/tar.mjs";

const LABEL = "offline:bundle";
const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const fail = (message) => {
  console.error(`${LABEL}: ${message}`);
  process.exit(1);
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: npm run offline:bundle -- --version <x.y.z> [options]

Options:
  --version <v>          the release the bundle is of; the FastAPI and JVM release folders must be this version
  --build                first run the hosts' release scripts as dry runs (jvm:release, then fastapi:assets and
                         fastapi:release) for --version; the JVM run takes about twenty minutes
  --skip <a,b>           leave sections out: ${SECTIONS.join(", ")}
  --binding <id>         pack only this binding (repeatable); default: ${REFERENCE_BINDINGS.join(", ")}
  --out <dir>            where the bundle folder and the archive go; default: dist/offline
  --qjs-wasm-file <path> take qjs-wasi.wasm from this file; it is held to the pin either way
  --source-maps          keep the bundles' source maps (about 70 MB); packages/datum/dist has them only when it was
                         built with DATUM_SOURCE_MAPS=1 npm run datum:build
  --allow-stale          let a packages/datum/dist older than its sources through
  --skip-check           do not draw the bundle in a browser before writing it (needs Playwright's Chromium)
  --no-archive           write the folder only
  --help, -h             this text

Nothing is uploaded, ever.`);
  process.exit(0);
}
const options = { skip: new Set(), bindings: [], out: join(REPO, "dist", "offline") };
for (let at = 0; at < argv.length; at += 1) {
  const arg = argv[at];
  const value = () => (argv[at + 1] && !argv[at + 1].startsWith("--") ? argv[(at += 1)] : fail(`${arg} takes a value.`));
  if (arg === "--version") options.version = value();
  else if (arg === "--build") options.build = true;
  else if (arg === "--skip") for (const name of value().split(",").map((part) => part.trim()).filter(Boolean)) options.skip.add(name);
  else if (arg === "--binding") options.bindings.push(value());
  else if (arg === "--out") options.out = resolve(value());
  else if (arg === "--qjs-wasm-file") options.wasmFile = resolve(value());
  else if (arg === "--source-maps") options.sourceMaps = true;
  else if (arg === "--allow-stale") options.allowStale = true;
  else if (arg === "--skip-check") options.skipCheck = true;
  else if (arg === "--no-archive") options.noArchive = true;
  else fail(`unknown option ${arg} (--help lists them).`);
}
const { version } = options;
if (version === undefined) fail("--version is required.");
if (!/^\d+\.\d+\.\d+(?:[-.]?[0-9A-Za-z.]+)?$/.test(version) || /SNAPSHOT/i.test(version)) fail(`--version ${version} is not a release version (x.y.z).`);
for (const name of options.skip) if (!SECTIONS.includes(name)) fail(`--skip ${name}: the sections are ${SECTIONS.join(", ")}.`);
const wanted = (name) => !options.skip.has(name);
if (!wanted("browser") && !options.skipCheck && wanted("bindings")) fail("the browser check draws the packs with the bundle's own browser files: keep the browser section, or pass --skip-check.");

const run = (command, args, { cwd = REPO, capture = false } = {}) => {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.error) fail(`could not run ${command}: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args.slice(0, 3).join(" ")} failed (exit ${result.status}).`);
  return result.stdout;
};
const git = (...args) => spawnSync("git", args, { cwd: REPO, encoding: "utf8" }).stdout?.trim() ?? "";

// The hosts' own release scripts, as dry runs: they build and check, and upload nothing.
// The JVM release goes first: unless --allow-stale it rebuilds packages/datum/dist, which the FastAPI
// assets and the browser section are then taken from.
if (options.build) {
  if (wanted("maven")) run("npm", ["run", "jvm:release", "--", "--version", version, "--dry-run", ...(options.allowStale ? ["--allow-stale"] : [])]);
  if (wanted("python")) {
    run("npm", ["run", "fastapi:assets", ...(options.allowStale ? ["--", "--allow-stale"] : [])]);
    run("npm", ["run", "fastapi:release", "--", "--version", version, "--dry-run"]);
  }
}

const staging = join(options.out, `.datum-offline-${version}.new`);
const work = join(options.out, `.datum-offline-${version}.work`);
const target = join(options.out, `datum-offline-${version}`);
const archive = `${target}.tar.gz`;
rmSync(staging, { recursive: true, force: true });
rmSync(work, { recursive: true, force: true });
mkdirSync(staging, { recursive: true });
mkdirSync(work, { recursive: true });
const cleanUp = () => {
  rmSync(staging, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
};
const stop = (message) => {
  cleanUp();
  fail(message);
};

const sections = {};
const files = [];
const add = (name, section) => {
  sections[name] = { files: section.files.length, ...section.facts };
  files.push(...section.files);
  console.log(`${LABEL}: ${name}/  ${section.files.length} files`);
};

let abis;
try {
  // The ABIs of the build, read from the programs themselves: every server section is held to them.
  for (const name of ["datum-sandbox-program.js", "datum-pdf-program.js"]) {
    if (!existsSync(join(distDir, name))) throw new Error(`${name} is missing from packages/datum/dist: run \`npm run datum:build\``);
  }
  abis = programAbis(readFileSync(join(distDir, "datum-sandbox-program.js"), "utf8"), readFileSync(join(distDir, "datum-pdf-program.js"), "utf8"), LABEL);

  if (wanted("browser")) {
    assertFreshDist({
      shippedBundles: ["datum-form.js", "datum-builder.js", "datum-wasm.js", "datum-pdf.js", "datum-sandbox-program.js", "datum-pdf-program.js"],
      sourceDirs: [join(REPO, "engine", "form-engine"), join(REPO, "packages", "datum", "src"), join(REPO, "packages", "pdf-kernel", "src")],
      allowStale: options.allowStale === true,
      label: LABEL
    });
    add("browser", browserSection({ dist: distDir, pluginsDir: join(REPO, "plugins"), sourceMaps: options.sourceMaps === true }));
  }

  if (wanted("bindings")) {
    const packsDir = join(work, "bindings");
    const manifest = buildBindingPacks({ out: packsDir, ids: options.bindings.length > 0 ? options.bindings : REFERENCE_BINDINGS });
    const left = remoteReferences(packsDir, Object.keys(manifest));
    if (left.length > 0) throw new Error(`a packed stylesheet still names another host:\n  ${left.join("\n  ")}`);
    add("bindings", bindingsSection({ packsDir, manifest }));
  }

  if (wanted("runtime")) {
    const pinFile = join(REPO, "integrations", "fastapi", "packages", "argusvane-datum-qjs-wasm", "src", "datum_qjs_wasm", "runtime.json");
    const pin = JSON.parse(readFileSync(pinFile, "utf8"));
    const pom = readFileSync(join(REPO, "integrations", "jvm", "libs", "datum-sandbox-endive", "pom.xml"), "utf8");
    const property = (name) => new RegExp(`<${name.replace(".", "\\.")}>([^<]+)</`).exec(pom)?.[1] ?? "";
    add(
      "runtime",
      runtimeSection({
        wasmFile: options.wasmFile ?? join(dirname(pinFile), pin.asset),
        pinFile,
        pins: [
          { name: "integrations/fastapi runtime.json", version: pin.qjsVersion, sha256: pin.sha256 },
          { name: "integrations/jvm datum-sandbox-endive/pom.xml", version: property("qjs.version"), sha256: property("qjs.sha256") }
        ]
      })
    );
  }

  if (wanted("python")) {
    const fastapi = join(REPO, "integrations", "fastapi");
    // The third-party packages the install needs, with hashes, straight from the lock: no resolution, no network.
    const requirements = run("uv", ["export", "--frozen", "--no-emit-workspace", "--all-packages", "--all-extras", "--no-dev", "--no-header", "--format", "requirements-txt"], { cwd: fastapi, capture: true });
    const requirementsFile = join(work, "requirements-third-party.txt");
    writeFileSync(
      requirementsFile,
      `# The third-party packages "argusvane-datum-fastapi[all]==${version}" installs, pinned with hashes: integrations/fastapi/uv.lock, exported with\n# uv export --frozen --no-emit-workspace --all-packages --all-extras --no-dev. They are not in this bundle.\n${requirements}`
    );
    add("python", pythonSection({ releaseDir: join(fastapi, "dist", `datum-fastapi-${version}`), version, abis, requirementsFile }));
  }

  if (wanted("maven")) {
    const jvm = join(REPO, "integrations", "jvm");
    let sums = 0;
    const checksum = (_to, text) => {
      const file = join(work, "sha1", `${(sums += 1)}.sha1`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, text);
      return file;
    };
    add("maven", mavenSection({ jvmDir: jvm, releaseDir: join(jvm, "dist", `datum-jvm-${version}`), version, abis, checksum }));
  }

  if (wanted("tools")) {
    const suite = join(REPO, "packages", "conformance-suite");
    const packed = join(work, "tools");
    mkdirSync(packed, { recursive: true });
    // npm pack runs the package's own build first (prepack); the tarball is whatever lands in the folder.
    run("npm", ["pack", "--pack-destination", packed], { cwd: suite });
    const tarballs = readdirSync(packed).filter((name) => name.endsWith(".tgz"));
    if (tarballs.length !== 1) throw new Error(`npm pack in packages/conformance-suite wrote ${tarballs.length} tarballs, expected one`);
    const suitePackage = JSON.parse(readFileSync(join(suite, "package.json"), "utf8"));
    add("tools", toolsSection({ tarballs: [{ file: join(packed, tarballs[0]), name: `${suitePackage.name}@${suitePackage.version}` }] }));
  }
} catch (error) {
  stop(error.message);
}

// The folder: the sections' files, then the papers that describe them.
const commit = git("rev-parse", "HEAD") || null;
const dirty = git("status", "--porcelain") !== "";
const guide = join(REPO, "docs", "air-gapped.md");
const papers = [
  { to: "LICENSE", from: join(REPO, "LICENSE") },
  { to: "THIRD_PARTY_NOTICES.md", from: join(REPO, "THIRD_PARTY_NOTICES.md") },
  ...(existsSync(guide) ? [{ to: "AIR-GAPPED.md", from: guide }] : [])
];
const skipped = SECTIONS.filter((name) => !(name in sections));
const checked = !options.skipCheck && "browser" in sections && "bindings" in sections;
const readme = join(work, "README.md");
writeFileSync(readme, readmeText({ version, commit, dirty, abis, sections, skipped, hasGuide: existsSync(guide), checked }));
const body = [...files, ...papers, { to: "README.md", from: readme }];
const seen = new Set();
for (const file of body) {
  if (seen.has(file.to)) stop(`two files claim ${file.to} in the bundle.`);
  seen.add(file.to);
}
const described = describeFiles(body);
const manifestFile = join(work, "manifest.json");
writeFileSync(
  manifestFile,
  `${JSON.stringify(
    {
      "//": "Written by scripts/offline/bundle.mjs.",
      name: "datum-offline",
      version,
      commit,
      dirty,
      sandboxAbi: abis.sandboxAbi,
      pdfAbi: abis.pdfAbi,
      uploaded: false,
      offlineCheck: checked ? "passed" : "not run",
      sections,
      skipped,
      files: described
    },
    null,
    2
  )}\n`
);
const withManifest = [...described, ...describeFiles([{ to: "manifest.json", from: manifestFile }])].sort((a, b) => (a.path < b.path ? -1 : 1));
const sumsFile = join(work, "SHA256SUMS");
writeFileSync(sumsFile, sumsText(withManifest));
const all = [...body, { to: "manifest.json", from: manifestFile }, { to: "SHA256SUMS", from: sumsFile }].sort((a, b) => (a.to < b.to ? -1 : 1));
for (const file of all) {
  mkdirSync(dirname(join(staging, file.to)), { recursive: true });
  copyFileSync(file.from, join(staging, file.to));
}

// The staged bundle, drawn with nothing else in reach.
if (options.skipCheck) {
  console.warn(`${LABEL}: --skip-check given; the bundle was NOT drawn in a browser.`);
} else if (checked) {
  const checked = spawnSync(process.execPath, [join(here, "check.mjs"), "--bundle", staging], { cwd: REPO, stdio: "inherit" });
  if (checked.status !== 0) stop("the staged bundle did not pass the offline check; nothing written.");
} else {
  console.warn(`${LABEL}: the bundle has no ${"browser" in sections ? "bindings" : "browser"} section, so the browser check has nothing to draw; skipped.`);
}

rmSync(target, { recursive: true, force: true });
renameSync(staging, target);
let archived = "";
if (!options.noArchive) {
  // One time for every entry: the commit's, so the same commit gives the same archive on the same machine.
  const mtime = Number(git("log", "-1", "--format=%ct")) || 0;
  await writeTarGz(archive, all.map((file) => ({ path: `datum-offline-${version}/${file.to}`, from: join(target, file.to) })), { mtime });
  writeFileSync(`${archive}.sha256`, `${sha256Of(archive)}  datum-offline-${version}.tar.gz\n`);
  archived = ` and ${basename(archive)} beside it (with .sha256)`;
}
rmSync(work, { recursive: true, force: true });
const shown = (path) => (relative(REPO, path).startsWith("..") ? path : relative(REPO, path));
const bytes = withManifest.reduce((sum, file) => sum + file.bytes, 0);
console.log(`${LABEL}: wrote ${shown(target)}/${archived}: ${all.length} files, ${(bytes / 1048576).toFixed(1)} MiB${skipped.length > 0 ? `; without ${skipped.join(", ")}` : ""}. Nothing uploaded.`);
