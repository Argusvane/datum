// What the third-party notices are made of, read from the build and the installed packages: which
// npm packages a bundle carries (from its source maps, or from an esbuild metafile), what each
// one declares (version, licence, licence files), whether the lockfile that installed it agrees,
// and the text of a bundle's `<bundle>.LICENSE.txt` in a form a reader and the generator
// (scripts/notices.mjs) both take. Nothing here runs a build; node's own modules only, so the
// kernel's build (packages/pdf-kernel) and the plugin build (scripts/plugin-build.mjs) import it too.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { computeFeatureFiles } from "./feature-files.mjs";
import { licenceProblem } from "./licence-policy.mjs";

/**
 * Licence texts for the packages that ship none (`notices/texts/<name>.txt`, `@scope/name` as
 * `scope__name`): the text a package's own repository publishes, or the licence its package.json
 * declares with the copyright holder it names, each file saying which. A package with no licence
 * file and no text here fails the bundle's notice step.
 */
export const EXTRA_TEXTS_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "notices", "texts");

/** The scope of this repository's own packages: their code is Datum's, under the repository's licence. */
export const FIRST_PARTY_SCOPE = "@argusvane/";

/**
 * The scopes a package can be carried in. The files a host ships in its PDF module (the PDF
 * feature's lists of dist/feature-files.json: `pdf` and `pdf-pages`) are the `pdf` scope; the
 * rest of a module build ships with the UI module and is `core`; the classic script (`*.iife.js`)
 * holds everything of its bundle in one file and no host serves it, so it has a scope of its own.
 */
export const SCOPES = ["core", "pdf", "iife"];

/** The names of the bundles (one `<bundle>.LICENSE.txt` each) a build of packages/datum writes. */
export const BUNDLES = ["datum-form", "datum-builder", "datum-pdf", "datum-pdf-pages", "datum-wasm", "datum-engine", "datum-webauthn"];

/** A hashed lazy chunk of a bundle: `datum-<bundle>-<name>-<hash>.js`. */
const CHUNK = /^datum-(form|builder|pdf)-(.+)-[A-Za-z0-9_-]{8}\.js$/;

/**
 * The files of the PDF module of a host: the `pdf` and `pdf-pages` feature lists of a feature-files
 * manifest (scripts/feature-files.mjs), the same lists the hosts allocate by.
 */
export function pdfFilesOf(manifest) {
  return new Set(["pdf", "pdf-pages"].flatMap((token) => manifest?.features?.[token]?.files ?? []));
}

/**
 * The bundle a built file of packages/datum/dist belongs to and its scope, or null for a file
 * that is no bundle (the sandbox and PDF programs, copied or written by other steps). With
 * `pdfFiles` (pdfFilesOf) a file is in the `pdf` scope exactly when the hosts ship it in their PDF
 * module; without it the scope is read from the file's name (the PDF bundles and `pdf-*` chunks),
 * which is only a guess where a chunk's name and its importers disagree.
 */
export function bundleOfFile(name, pdfFiles) {
  const entry = /^(datum-[a-z-]+?)(\.iife)?\.js$/.exec(name);
  if (entry && BUNDLES.includes(entry[1])) {
    if (entry[2]) {
      return { bundle: entry[1], scope: "iife" };
    }
    const byName = entry[1] === "datum-pdf" || entry[1] === "datum-pdf-pages";
    return { bundle: entry[1], scope: (pdfFiles ? pdfFiles.has(name) : byName) ? "pdf" : "core" };
  }
  const chunk = CHUNK.exec(name);
  if (chunk) {
    const bundle = `datum-${chunk[1]}`;
    const byName = bundle === "datum-pdf" || /^pdf(-|$)/.test(chunk[2]);
    return { bundle, scope: (pdfFiles ? pdfFiles.has(name) : byName) ? "pdf" : "core" };
  }
  return null;
}

/**
 * The bundle and scope of each built file of `dist`, by file name, with the scope the hosts ship it in: the `pdf`
 * and `pdf-pages` lists of the feature manifest, computed from the built files with the function feature-files.mjs
 * writes dist/feature-files.json with (that file is written later in the build, so it is not read here).
 */
export function bundleScopesOfDist(dist) {
  const pdfFiles = pdfFilesOf(computeFeatureFiles(dist));
  return (name) => bundleOfFile(name, pdfFiles);
}

/**
 * The third-party package a source file belongs to: the nearest `node_modules/<name>` above it,
 * as an absolute folder. Null for this repository's own sources, for the `@argusvane/` packages
 * (the repository's own, linked in), and for anything that is not a file path (the bundler's
 * virtual modules).
 */
export function packageDirOf(file) {
  const marker = `${sep}node_modules${sep}`;
  const at = file.lastIndexOf(marker);
  if (at === -1 || !file.startsWith(sep)) {
    return null;
  }
  const parts = file.slice(at + marker.length).split(sep);
  const length = parts[0].startsWith("@") ? 2 : 1;
  if (parts.length <= length) {
    return null;
  }
  const name = parts.slice(0, length).join("/");
  if (name.startsWith(FIRST_PARTY_SCOPE)) {
    return null;
  }
  return file.slice(0, at + marker.length) + parts.slice(0, length).join(sep);
}

/** The licence of a package.json as one SPDX-style string. */
function licenceOf(meta) {
  if (typeof meta.license === "string") {
    return meta.license;
  }
  if (meta.license && typeof meta.license.type === "string") {
    return meta.license.type;
  }
  if (Array.isArray(meta.licenses) && meta.licenses.length > 0) {
    return meta.licenses.map((entry) => (typeof entry === "string" ? entry : entry.type)).join(" OR ");
  }
  return "UNKNOWN";
}

const LICENCE_FILE = /^(licen[cs]e|copying|notice|patents)([-._].*)?$/i;

/**
 * What the installed package at `dir` declares and ships: name, version, licence, homepage and the
 * licence files in it (LICENSE, LICENCE, COPYING, NOTICE and the like, a `LICENSE-MIT` beside a
 * `LICENSE-APACHE` both), each with its text.
 */
export function readPackage(dir) {
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && LICENCE_FILE.test(entry.name))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    const extra = join(EXTRA_TEXTS_DIR, `${meta.name.replace(/^@/, "").replace("/", "__")}.txt`);
    if (existsSync(extra)) {
      return { ...basics(meta, dir), texts: [{ file: "(supplied by Datum)", text: readFileSync(extra, "utf8").replace(/\r\n/g, "\n").trimEnd() }] };
    }
  }
  return { ...basics(meta, dir), texts: files.map((file) => ({ file, text: readFileSync(join(dir, file), "utf8").replace(/\r\n/g, "\n").trimEnd() })) };
}

function basics(meta, dir) {
  const repository = typeof meta.repository === "string" ? meta.repository : meta.repository?.url;
  const author = typeof meta.author === "string" ? meta.author : meta.author?.name;
  return {
    name: meta.name,
    version: meta.version,
    license: licenceOf(meta),
    homepage: meta.homepage ?? repository ?? "",
    author: author ?? "",
    dir
  };
}

/**
 * The problems between the installed package and the lockfile of the project that installed it
 * (the folder above the first `node_modules`): a package the lockfile does not know, or one at
 * another version. An empty list when they agree.
 */
export function lockfileProblems(pkg) {
  const marker = `${sep}node_modules${sep}`;
  const at = pkg.dir.indexOf(marker);
  const project = pkg.dir.slice(0, at);
  const lockfile = join(project, "package-lock.json");
  if (!existsSync(lockfile)) {
    return [`${pkg.name} ${pkg.version}: ${project} has no package-lock.json`];
  }
  const key = pkg.dir.slice(project.length + 1).split(sep).join("/");
  const entry = JSON.parse(readFileSync(lockfile, "utf8")).packages?.[key];
  if (!entry) {
    return [`${pkg.name} ${pkg.version}: ${lockfile} has no entry ${key}`];
  }
  return entry.version === pkg.version ? [] : [`${pkg.name}: ${lockfile} pins ${entry.version}, node_modules holds ${pkg.version} (run npm ci)`];
}

/**
 * The packages behind a list of source files: `Map<"name@version", { ...package, scopes }>`.
 * `sources` is `[{ file (absolute), scope }]`; a package seen in both scopes carries both.
 */
export function collectPackages(sources) {
  const found = new Map();
  const readOnce = new Map();
  for (const { file, scope } of sources) {
    const dir = packageDirOf(file);
    if (dir === null) {
      continue;
    }
    if (!readOnce.has(dir)) {
      readOnce.set(dir, readPackage(dir));
    }
    const pkg = readOnce.get(dir);
    const key = `${pkg.name}@${pkg.version}`;
    if (!found.has(key)) {
      found.set(key, { ...pkg, scopes: new Set() });
    }
    found.get(key).scopes.add(scope);
  }
  return found;
}

/** The absolute source files a source map names (the bundler's virtual modules and data URLs left out). */
export function sourcesOfMap(mapFile) {
  const map = JSON.parse(readFileSync(mapFile, "utf8"));
  const base = resolve(mapFile, "..");
  return (map.sources ?? []).filter((source) => !/^[\0\w+.-]+:/.test(source) || source.startsWith("file:")).map((source) => resolve(base, source));
}

/** The text of a package's licence files, or the sentence that says it ships none. */
export function licenceTextOf(pkg) {
  if (pkg.texts.length === 0) {
    const where = [pkg.author === "" ? "" : ` Author: ${pkg.author}.`, pkg.homepage === "" ? "" : ` Source: ${pkg.homepage}.`].join("");
    return `The package ships no licence file; its package.json declares the licence "${pkg.license}".${where}`;
  }
  return pkg.texts.length === 1 ? pkg.texts[0].text : pkg.texts.map(({ file, text }) => `--- ${file} ---\n${text}`).join("\n\n");
}

const RULE = "=".repeat(72);

/**
 * The text of `<bundle>.LICENSE.txt`: what the file covers, the list of packages (one line each,
 * `name@version | licence | scopes`, the form `parseLicenceFile` reads back), every package's
 * licence text, then the legal comments the bundler found in the bundled sources.
 * `covers` is the sentence naming the files; `packages` is a Map from collectPackages.
 */
export function renderLicenceFile({ bundle, covers, packages, legalComments = "" }) {
  const sorted = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const lines = [
    `Third-party code in ${bundle}`,
    "",
    `${covers}`,
    "Datum's own code is under the MIT licence (the LICENSE file of the distribution this file ships in).",
    "The packages below are not Datum's: each keeps the licence its authors gave it, reproduced here.",
    "",
    sorted.length === 0 ? "Packages: none." : "Packages:",
    ...sorted.map((pkg) => `  ${pkg.name}@${pkg.version} | ${pkg.license} | ${[...pkg.scopes].sort().join(",")}`),
    ""
  ];
  for (const pkg of sorted) {
    lines.push(RULE, `${pkg.name}@${pkg.version} (${pkg.license})`, pkg.homepage === "" ? "" : pkg.homepage, RULE, "", licenceTextOf(pkg), "");
  }
  if (legalComments.trim() !== "") {
    lines.push(RULE, "Legal comments found in the bundled sources", RULE, "", legalComments.trim(), "");
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}\n`;
}

/**
 * The package list and licence texts of a `<bundle>.LICENSE.txt` as renderLicenceFile wrote it:
 * `[{ name, version, license, scopes: string[], text }]`, in file order.
 */
export function parseLicenceFile(text) {
  const listed = [];
  const lines = text.split("\n");
  const start = lines.indexOf("Packages:");
  if (start !== -1) {
    for (let at = start + 1; at < lines.length && lines[at].startsWith("  "); at += 1) {
      const row = /^ {2}(.+)@([^@\s|]+) \| (.+) \| ([a-z,]+)$/.exec(lines[at]);
      if (!row) {
        throw new Error(`notices: cannot read the package line "${lines[at]}"`);
      }
      listed.push({ name: row[1], version: row[2], license: row[3], scopes: row[4].split(","), text: "" });
    }
  }
  for (const entry of listed) {
    const header = `${entry.name}@${entry.version} (${entry.license})`;
    const at = lines.findIndex((line, index) => line === header && lines[index - 1] === RULE);
    if (at === -1) {
      throw new Error(`notices: no licence text for ${header}`);
    }
    // After the header: an optional homepage line, the closing rule, a blank line, then the text up to the next rule.
    let from = at + 1;
    while (lines[from] !== RULE) {
      from += 1;
    }
    from += 2;
    let to = from;
    while (to < lines.length && lines[to] !== RULE) {
      to += 1;
    }
    entry.text = lines.slice(from, to).join("\n").trim();
  }
  return listed;
}

/** True when the text is the sentence licenceTextOf writes for a package with no licence file. */
export const isMissingLicenceText = (text) => text.startsWith("The package ships no licence file;");

/**
 * The problems that stop a bundle from shipping with a notice: a package whose installed version is
 * not the lockfile's, one whose licence is missing or not on the allow-list (licence-policy.mjs), one
 * that ships no licence text and has none in notices/texts/.
 */
export function packageProblems(packages) {
  const problems = [];
  for (const pkg of packages.values()) {
    problems.push(...lockfileProblems(pkg));
    const licence = licenceProblem(pkg.name, pkg.license, pkg.version);
    if (licence !== null) {
      problems.push(licence);
    }
    if (isMissingLicenceText(licenceTextOf(pkg))) {
      problems.push(`${pkg.name} ${pkg.version} (${pkg.license}) ships no licence file: add its text as notices/texts/${pkg.name.replace(/^@/, "").replace("/", "__")}.txt`);
    }
  }
  return problems;
}

/**
 * The legal comments the bundler's sidecar plugin (vite-bundle.ts) wrote for `bundle` in `dist`, one
 * file per format: `{ comments: string[] (each once), files: string[] (the sidecars' names) }`.
 */
export function readLegalComments(dist, bundle) {
  const files = readdirSync(dist).filter((name) => name.startsWith(`${bundle}.legal-comments.`) && name.endsWith(".txt"));
  const comments = new Set();
  for (const name of files) {
    for (const block of readFileSync(join(dist, name), "utf8").split("\n\n")) {
      if (block.trim() !== "") {
        comments.add(block.trim());
      }
    }
  }
  return { comments: [...comments], files };
}

/**
 * Copies the licence files of every package in `packages` into `dist`, unchanged, as
 * `LICENSE.<package>.txt` (`@scope/name` as `scope__name`; several files of one package get their own
 * file name after it): for a bundle whose licence asks that its file travel with the code.
 */
export function copyLicenceFiles(packages, dist) {
  mkdirSync(dist, { recursive: true });
  const written = [];
  for (const pkg of packages.values()) {
    const base = pkg.name.replace(/^@/, "").replace("/", "__");
    const names = readdirSync(pkg.dir).filter((name) => LICENCE_FILE.test(name));
    for (const name of names) {
      const target = names.length === 1 ? `LICENSE.${base}.txt` : `LICENSE.${base}.${name}.txt`;
      copyFileSync(join(pkg.dir, name), join(dist, target));
      written.push(target);
    }
  }
  return written;
}

/** True for a bundle's licence file in dist: `datum-form.LICENSE.txt`, `datum-pdf-program.LICENSE.txt`. */
export const isBundleLicenceFile = (name) => /^datum-[a-z-]+\.LICENSE\.txt$/.test(name);

/**
 * The licence files a host module copies beside the bundles it ships: one `<bundle>.LICENSE.txt` for each
 * bundle whose main file (`<bundle>.js`) `shipped` (the module's files of dist/) holds. A bundle's licence
 * file belongs to the one module that ships its main file, so no two modules list the same file; a module
 * that holds only lazy chunks of a bundle (the PDF chunks of the form and the builder) names their packages
 * in its own notice rows instead. `files` are the names `available` has, sorted; `missing` are the licence
 * files a shipped main file needs that `available` lacks, which a build treats as a failure.
 */
export function licenceFilesFor(shipped, available) {
  const bundles = new Set();
  for (const file of shipped) {
    if (file === "datum-pdf-program.js") {
      bundles.add("datum-pdf-program");
    }
    const kind = bundleOfFile(file);
    if (kind !== null && file === `${kind.bundle}.js`) {
      bundles.add(kind.bundle);
    }
  }
  const wanted = [...bundles].map((bundle) => `${bundle}.LICENSE.txt`).sort();
  return { files: wanted.filter((file) => available.includes(file)), missing: wanted.filter((file) => !available.includes(file)) };
}

/**
 * Whether a version a document names agrees with the version a lockfile, pom or runtime pin holds (or
 * the other way round for a row that names more than the pin): the same version, or one that continues
 * with a separator and not with another digit or letter, so "Bouncy Castle 1.78" agrees with a pin of
 * 1.78.1, a pin of 1.2.1.RELEASE with 1.2.1, and a row "1.3.2 / 33.7.1-jre" with a pin of 1.3.2. A bare
 * string prefix is no agreement: 1.2.1 does not match a pin of 1.2.10.
 */
export const versionMatchesPin = (found, pin) => found === pin || (pin.startsWith(found) && !/[0-9A-Za-z]/.test(pin.charAt(found.length)));
