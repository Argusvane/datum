#!/usr/bin/env node
// Generates the third-party notices that name the npm packages Datum's bundles carry, and checks
// that nothing has drifted from them.
//
// The record of what a bundle carries is the `<bundle>.LICENSE.txt` written beside it when it is
// built (scripts/bundle-notices.mjs for the bundles of packages/datum, packages/pdf-kernel's
// build-program for the PDF program): the packages read from the build's own source maps or
// metafile, with the version, licence and licence text installed. This script reads those files
// from packages/datum/dist and writes, from them:
//
//   THIRD_PARTY_NOTICES.md                      the three tables between the `notices:*` markers
//   integrations/jvm/scripts/notices.json       the rows marked "generated", per jar
//   integrations/fastapi/scripts/notices.json   the rows marked "generated", per distribution
//   packages/datum/notices/licenses/*.txt       the licence text each generated row points at
//
// Rows that are not marked "generated" (fonts, runtimes, the pdf.js data folders, the JVM and
// Python libraries) stay hand-written; this script holds the versions of the ones a lockfile or a
// pom already pins to those pins.
//
//   npm run notices         write them (after `npm run build`)
//   npm run notices:check   fail when a file differs from what the build says, or a pin has moved
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { licenceProblem } from "./licence-policy.mjs";
import { BUNDLES, isMissingLicenceText, parseLicenceFile, versionMatchesPin } from "./notices-lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, "..");
const repo = join(pkgRoot, "..", "..");
const dist = join(pkgRoot, "dist");
const licencesDir = join(pkgRoot, "notices", "licenses");
const mdFile = join(repo, "THIRD_PARTY_NOTICES.md");

const mode = process.argv.includes("--write") ? "write" : process.argv.includes("--check") ? "check" : null;
if (mode === null) {
  console.error("usage: node scripts/notices.mjs --write | --check");
  process.exit(2);
}

/** The bundles whose `<bundle>.LICENSE.txt` is read: the packages' bundles and the PDF program. */
const SOURCES = [...BUNDLES, "datum-pdf-program"];

/**
 * What each host module ships, as [bundle, scope] pairs: the files of a bundle in that scope are
 * the files the module copies (scripts/notices-lib.mjs, SCOPES; bundle-notices.mjs takes a file's
 * scope from the feature manifest's `pdf` and `pdf-pages` lists, the lists the hosts allocate by).
 * The UI module is the form, the builder and the sandbox module outside the PDF feature; the PDF module is the PDF feature's
 * chunks of the form and the builder, the PDF module and the page imagery module; the programs
 * module is the PDF program.
 */
const UI = [["datum-form", "core"], ["datum-builder", "core"], ["datum-wasm", "core"]];
const PDF = [["datum-form", "pdf"], ["datum-builder", "pdf"], ["datum-pdf", "pdf"], ["datum-pdf-pages", "pdf"]];
const PROGRAMS = [["datum-pdf-program", "core"]];

const HOSTS = {
  jvm: {
    file: join(repo, "integrations", "jvm", "scripts", "notices.json"),
    modules: { "datum-programs": PROGRAMS, "datum-ui": UI, "datum-pdf": PDF },
    extra: () => ({})
  },
  fastapi: {
    file: join(repo, "integrations", "fastapi", "scripts", "notices.json"),
    modules: { "argusvane-datum-programs": PROGRAMS, "argusvane-datum-assets-ui": UI, "argusvane-datum-assets-pdf": PDF },
    extra: () => ({ kind: "vendored" })
  }
};

/** The icon set's plugin bundle is built in its own package; its one package is read from that package's lockfile. */
const PLUGIN = { bundle: "datum-icons-fontawesome", name: "@fortawesome/free-solid-svg-icons", lockfile: join(repo, "plugins", "icons-fontawesome", "package-lock.json") };

const problems = [];
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const safeName = (name) => name.replace(/^@/, "").replace("/", "__");
const textPathOf = (pkg) => join("packages", "datum", "notices", "licenses", `${safeName(pkg.name)}-${pkg.version}.txt`);

// ---- what the builds say ------------------------------------------------------------------

const bundles = new Map();
for (const bundle of SOURCES) {
  const file = join(dist, `${bundle}.LICENSE.txt`);
  if (!existsSync(file)) {
    problems.push(`${relative(repo, file)} is missing: run npm run build in packages/datum`);
    continue;
  }
  const packages = parseLicenceFile(readFileSync(file, "utf8"));
  for (const pkg of packages) {
    if (isMissingLicenceText(pkg.text)) {
      problems.push(`${bundle}: ${pkg.name} ${pkg.version} has no licence text`);
    }
  }
  bundles.set(bundle, packages);
}
if (existsSync(PLUGIN.lockfile)) {
  const entry = readJson(PLUGIN.lockfile).packages?.[`node_modules/${PLUGIN.name}`];
  if (entry) {
    bundles.set(PLUGIN.bundle, [{ name: PLUGIN.name, version: entry.version, license: entry.license ?? "UNKNOWN", scopes: ["core"], text: "" }]);
  } else {
    problems.push(`${relative(repo, PLUGIN.lockfile)} has no entry for ${PLUGIN.name}`);
  }
}

/** Every package of every bundle, once per name and version, with the bundles that carry it. */
const catalogue = new Map();
for (const [bundle, packages] of bundles) {
  for (const pkg of packages) {
    const key = `${pkg.name}@${pkg.version}`;
    if (!catalogue.has(key)) {
      catalogue.set(key, { ...pkg, bundles: [] });
      // The licence allow-list (licence-policy.mjs): a package under a copyleft or unknown licence fails here, by name.
      const licence = licenceProblem(pkg.name, pkg.license, pkg.version);
      if (licence !== null) {
        problems.push(`${bundle}: ${licence}`);
      }
    }
    const known = catalogue.get(key);
    known.bundles.push(bundle);
    if (known.license !== pkg.license) {
      problems.push(`${key} is ${known.license} in one bundle and ${pkg.license} in ${bundle}`);
    }
    if (known.text === "" && pkg.text !== "") {
      known.text = pkg.text;
    } else if (pkg.text !== "" && known.text !== pkg.text) {
      problems.push(`${key} has a different licence text in ${bundle}`);
    }
  }
}
const byName = (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version, undefined, { numeric: true });

/** The packages a host module ships, once each. */
function packagesOf(spec) {
  const found = new Map();
  for (const [bundle, scope] of spec) {
    for (const pkg of bundles.get(bundle) ?? []) {
      if (pkg.scopes.includes(scope)) {
        found.set(`${pkg.name}@${pkg.version}`, catalogue.get(`${pkg.name}@${pkg.version}`));
      }
    }
  }
  return [...found.values()].sort(byName);
}

// ---- the files that follow --------------------------------------------------------------------

/** Every file this script owns: path (absolute) to its text. */
const expected = new Map();

const code = (text) => `\`${text}\``;
const bundledTable = () => {
  const rows = [...catalogue.values()].sort(byName).map((pkg) => `| ${code(pkg.name)} | ${pkg.version} | ${pkg.license} | ${pkg.bundles.map(code).join(", ")} |`);
  return ["| Package | Version | Licence | Carried by |", "|---|---|---|---|", ...rows].join("\n");
};
const moduleTable = (modules, label) => {
  const rows = [];
  for (const [module, spec] of Object.entries(modules)) {
    for (const pkg of packagesOf(spec)) {
      rows.push({ pkg, module });
    }
  }
  rows.sort((a, b) => byName(a.pkg, b.pkg) || a.module.localeCompare(b.module));
  const lines = rows.map(({ pkg, module }) => `| ${code(pkg.name)} ${pkg.version} | ${code(module)} | ${pkg.license} |`);
  return [`| Package | ${label} | Licence |`, "|---|---|---|", ...lines].join("\n");
};

let md = readFileSync(mdFile, "utf8");
const BLOCKS = {
  bundled: bundledTable(),
  jvm: moduleTable(HOSTS.jvm.modules, "Module"),
  fastapi: moduleTable(HOSTS.fastapi.modules, "Distribution")
};
for (const [id, body] of Object.entries(BLOCKS)) {
  const begin = `<!-- notices:${id}:begin`;
  const end = `<!-- notices:${id}:end -->`;
  const from = md.indexOf(begin);
  const to = md.indexOf(end);
  if (from === -1 || to === -1 || to < from) {
    problems.push(`THIRD_PARTY_NOTICES.md has no ${begin} ... ${end} markers`);
    continue;
  }
  const open = md.slice(from, md.indexOf("\n", from) + 1);
  md = `${md.slice(0, from)}${open}${body}\n${md.slice(to)}`;
}
expected.set(mdFile, md);

for (const [host, { file, modules, extra }] of Object.entries(HOSTS)) {
  const notices = readJson(file);
  for (const [module, spec] of Object.entries(modules)) {
    const hand = (notices.modules[module] ?? []).filter((row) => row.generated !== true);
    const generated = packagesOf(spec).map((pkg) => {
      const textFile = textPathOf(pkg).split("\\").join("/");
      expected.set(join(repo, textFile), `${pkg.text}\n`);
      return { name: pkg.name, version: pkg.version, license: pkg.license, source: `https://www.npmjs.com/package/${pkg.name}/v/${pkg.version}`, ...extra(), textFile, generated: true };
    });
    notices.modules[module] = [...hand, ...generated];
  }
  expected.set(file, `${JSON.stringify(notices, null, 2)}\n`);
}

// ---- the pins -------------------------------------------------------------------------------

/** Versions the hand-written rows must keep: what a lockfile, a pom or a runtime pin says. */
function pins() {
  const pdfjs = readJson(join(pkgRoot, "package-lock.json")).packages?.["node_modules/pdfjs-dist"]?.version;
  const dejavu = readJson(join(pkgRoot, "package-lock.json")).packages?.["node_modules/dejavu-fonts-ttf"]?.version;
  const quickjs = readJson(join(repo, "integrations", "fastapi", "packages", "argusvane-datum-qjs-wasm", "src", "datum_qjs_wasm", "runtime.json")).qjsVersion;
  const bom = readFileSync(join(repo, "integrations", "jvm", "datum-bom", "pom.xml"), "utf8");
  const property = (name) => new RegExp(`<${name.replace(/\./g, "\\.")}>([^<]+)</${name.replace(/\./g, "\\.")}>`).exec(bom)?.[1];
  // [label, version, the pattern a sentence of the markdown gives it, the start of a row's name]
  return [
    ["pdf.js", pdfjs, /pdf\.js (\d+\.\d+\.\d+)/g, "pdf.js"],
    ["DejaVu fonts", dejavu, /DejaVu [Ff]onts (\d+\.\d+(?:\.\d+)?)/g, "DejaVu"],
    ["QuickJS-ng", quickjs, /QuickJS-ng (\d+\.\d+\.\d+)/g, "QuickJS-ng"],
    ["Endive", property("endive.version"), /Endive (\d+\.\d+\.\d+)/g, "Endive"],
    ["jffi", property("jffi.version"), /jffi (\d+\.\d+\.\d+)/g, "jffi"],
    ["Jimfs", property("jimfs.version"), /Jimfs (\d+\.\d+\.\d+)/g, "Jimfs"],
    ["Caffeine", property("caffeine.version"), /Caffeine (\d+\.\d+\.\d+)/g, "Caffeine"],
    ["Bouncy Castle", property("bouncycastle.version"), /Bouncy Castle (\d+\.\d+)/g, "Bouncy Castle"],
    ["webauthn4j", property("webauthn4j.version"), /webauthn4j-core (\d+\.\d+\.\d+)/g, "webauthn4j"]
  ];
}
for (const [label, version, pattern, rowPrefix] of pins()) {
  if (version === undefined) {
    problems.push(`no pinned version of ${label} found (its lockfile, pom or runtime pin changed shape?)`);
    continue;
  }
  // The markdown names a version in a sentence; a row of notices.json in its version field and,
  // for the pdf.js data folders, in its name too.
  const texts = [["THIRD_PARTY_NOTICES.md", expected.get(mdFile)], ...Object.values(HOSTS).map(({ file }) => [relative(repo, file), expected.get(file)])];
  for (const [where, text] of texts) {
    for (const match of text.matchAll(pattern)) {
      if (!versionMatchesPin(match[1], version)) {
        problems.push(`${where}: ${label} is ${match[1]} where the pin says ${version}`);
      }
    }
  }
  for (const { file } of Object.values(HOSTS)) {
    for (const [module, rows] of Object.entries(JSON.parse(expected.get(file)).modules)) {
      for (const row of rows.filter((entry) => entry.generated !== true && entry.name.startsWith(rowPrefix))) {
        // A row may carry a longer version than the pin (a suffix after a dot), never a different one.
        if (!versionMatchesPin(version, row.version)) {
          problems.push(`${relative(repo, file)}: ${module}: "${row.name}" is ${row.version} where the pin says ${version}`);
        }
      }
    }
  }
}

// ---- write or compare --------------------------------------------------------------------------

const onDisk = (dir) => (existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".txt")).map((name) => join(dir, name)) : []);
const wanted = new Set([...expected.keys()].filter((file) => file.startsWith(licencesDir)));
const stale = onDisk(licencesDir).filter((file) => !wanted.has(file));

if (mode === "write") {
  if (problems.length === 0) {
    mkdirSync(licencesDir, { recursive: true });
    for (const [file, text] of expected) {
      writeFileSync(file, text);
    }
    for (const file of stale) {
      rmSync(file);
    }
    console.log(`notices: wrote ${expected.size} file${expected.size === 1 ? "" : "s"}${stale.length > 0 ? `, removed ${stale.length} stale licence text${stale.length === 1 ? "" : "s"}` : ""}`);
  }
} else {
  for (const [file, text] of expected) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== text) {
      problems.push(`${relative(repo, file)} is out of date: run npm run notices in packages/datum (after npm run build)`);
    }
  }
  for (const file of stale) {
    problems.push(`${relative(repo, file)} is a licence text no row points at: run npm run notices in packages/datum`);
  }
  if (problems.length === 0) {
    console.log(`notices: ${expected.size} generated file${expected.size === 1 ? "" : "s"} match the build, ${catalogue.size} bundled package${catalogue.size === 1 ? "" : "s"}`);
  }
}
if (problems.length > 0) {
  console.error(`notices: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n${problems.map((line) => `  - ${line}`).join("\n")}`);
  process.exit(1);
}
