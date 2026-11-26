// The npm side of a release, in three steps the release workflow runs in order (and a maintainer can run
// by hand, which publishes nothing):
//
//   node scripts/npm/release.mjs check --version 0.1.0   every published package carries exactly that
//                                                        version and the repository URL, and the private
//                                                        packages are still private
//   node scripts/npm/release.mjs pack --out release/npm  prepack and `npm pack` each package into the
//                                                        folder, check each tarball (scripts/npm/pack-check.mjs),
//                                                        write PUBLISH_ORDER, SHA256SUMS and INTEGRITY (the
//                                                        registry's own digest of each tarball) beside them
//   node scripts/npm/release.mjs smoke --dir release/npm install every tarball into an empty project and
//                                                        run each command and the engine entry
//
// The build is not part of it: the packages are built first (packages/datum with DATUM_SOURCE_MAPS=1, then
// packages/datum/scripts/release-assets.mjs; the other two with `npm run build`). Nothing here publishes: the
// workflow's publish job is the only place `npm publish` appears.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PUBLISHED, REPO, REPOSITORY_URL } from "./packages.mjs";
import { filesOf, packProblems, sizeReport, unpackTarball } from "./pack-check.mjs";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const manifestOf = (folder) => JSON.parse(readFileSync(join(REPO, folder, "package.json"), "utf8"));

/** The packages that must stay private: the code the published bundles carry, never published on its own. */
const STAY_PRIVATE = ["engine", "packages/pdf-kernel", "packages/quickjs-wasm-host", "packages/submissions"];

/** What is wrong with the versions, the repository and the privacy of the packages, for a release of `version`. */
export function checkVersions(version) {
  const problems = [];
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    problems.push(`"${version}" is not a version`);
  }
  for (const { folder, name } of PUBLISHED) {
    const manifest = manifestOf(folder);
    if (manifest.name !== name) problems.push(`${folder}/package.json is named ${manifest.name}, not ${name}`);
    if (manifest.version !== version) problems.push(`${name} is at ${manifest.version}, the release is ${version}`);
    if (manifest.private !== false) problems.push(`${name} is not marked "private": false`);
    if (manifest.repository?.url !== REPOSITORY_URL) {
      problems.push(`${name}'s repository.url is ${JSON.stringify(manifest.repository?.url)}, not ${REPOSITORY_URL}: provenance compares it with the repository case-sensitively`);
    }
  }
  for (const folder of STAY_PRIVATE) {
    if (manifestOf(folder).private !== true) problems.push(`${folder} is not private: it ships inside the bundles and is never published on its own`);
  }
  return problems;
}

/** The files `pack` writes beside the tarballs, besides the tarballs themselves. */
const PACK_FILES = ["PUBLISH_ORDER", "SHA256SUMS", "INTEGRITY"];

/** The tarball file name `npm pack` gives a package: `@scope/name` at `version` packs as `scope-name-version.tgz`. */
export function tarballName(name, version) {
  return `${name.replace(/^@/, "").replace("/", "-")}-${version}.tgz`;
}

/**
 * Empties `target` of what `pack` writes into it (the `expected` tarballs and the files beside them) and nothing else.
 * A folder holding any other entry is not a pack folder: it is refused and the problem is returned, so a folder named
 * by mistake keeps its contents. A folder a failed run left half written holds only expected names, so it is accepted.
 */
export function clearPackFolder(target, expected) {
  if (!existsSync(target)) {
    mkdirSync(target, { recursive: true });
    return [];
  }
  if (!statSync(target).isDirectory()) return [`${target} is not a folder`];
  const ours = new Set([...expected, ...PACK_FILES]);
  const foreign = readdirSync(target).filter((entry) => !ours.has(entry));
  if (foreign.length > 0) {
    return [`${target} holds files pack does not write (${foreign.slice(0, 5).join(", ")}): name an empty or new folder`];
  }
  for (const entry of readdirSync(target)) rmSync(join(target, entry), { force: true });
  return [];
}

/**
 * The INTEGRITY file: one `<integrity>  <tarball>` line per tarball, in publish order. The publish job reads the first
 * column for a tarball by matching the second (`awk '$2 == file {print $1}'`).
 */
export function integrityText(names, integrities) {
  return `${names.map((file, index) => `${integrities[index]}  ${file}`).join("\n")}\n`;
}

function pack(out) {
  const target = resolve(out);
  const expected = PUBLISHED.map(({ folder, name }) => tarballName(name, manifestOf(folder).version));
  const refused = clearPackFolder(target, expected);
  if (refused.length > 0) return refused;
  const problems = [];
  const names = [];
  const integrities = [];
  for (const { folder, name } of PUBLISHED) {
    const cwd = join(REPO, folder);
    execFileSync(process.execPath, [join(REPO, "scripts", "npm", "prepack.mjs")], { cwd, stdio: "inherit" });
    const json = JSON.parse(execFileSync(npm, ["pack", "--ignore-scripts", "--json", "--pack-destination", target], { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
    const tarball = join(target, json[0].filename);
    const { folder: unpacked, cleanup } = unpackTarball(tarball);
    try {
      const files = filesOf(unpacked);
      problems.push(...packProblems(unpacked, files));
      console.log(sizeReport(name, files, statSync(tarball).size));
    } finally {
      cleanup();
    }
    if (!expected.includes(json[0].filename)) problems.push(`${name}: npm pack wrote ${json[0].filename}, expected one of ${expected.join(", ")}`);
    names.push(json[0].filename);
    if (!json[0].integrity) problems.push(`${name}: npm pack reported no integrity for ${json[0].filename}`);
    integrities.push(json[0].integrity);
  }
  writeFileSync(join(target, "PUBLISH_ORDER"), `${names.join("\n")}\n`);
  // The registry reports the same digest for a published tarball (`npm view <name>@<version> dist.integrity`): the publish
  // job skips a version only when the registry holds this very tarball, not merely a package of that name and version.
  writeFileSync(join(target, "INTEGRITY"), integrityText(names, integrities));
  writeFileSync(join(target, "SHA256SUMS"), `${names.map((file) => `${createHash("sha256").update(readFileSync(join(target, file))).digest("hex")}  ${file}`).join("\n")}\n`);
  return problems;
}

/** Installs every tarball into an empty project and runs what a user runs first. Returns the problems. */
function smoke(dir) {
  const target = resolve(dir);
  const names = readFileSync(join(target, "PUBLISH_ORDER"), "utf8").split("\n").filter(Boolean);
  const app = mkdtempSync(join(tmpdir(), "datum-smoke-"));
  const problems = [];
  try {
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
    execFileSync(npm, ["install", ...names.map((file) => join(target, file)), "--no-audit", "--no-fund", "--ignore-scripts"], { cwd: app, stdio: "inherit" });
    const bin = (command) => join(app, "node_modules", ".bin", command);
    const attempt = (what, run, expected) => {
      try {
        const out = run();
        if (!expected.test(out)) problems.push(`${what}: unexpected output: ${out.slice(0, 200)}`);
      } catch (error) {
        problems.push(`${what}: ${error.message.split("\n")[0]}`);
      }
    };
    const exec = (file, args) => execFileSync(file, args, { cwd: app, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    // Each command runs through `.bin` and through the bin file of the one published package that declares it.
    const binFiles = (command) => {
      const files = [];
      for (const { name } of PUBLISHED) {
        const installed = join(app, "node_modules", name, "package.json");
        if (!existsSync(installed)) continue;
        const target = JSON.parse(readFileSync(installed, "utf8")).bin?.[command];
        if (target) files.push({ name, file: join(app, "node_modules", name, target) });
      }
      return files;
    };
    const commands = [
      ["datum-form-test", ["--version"], /\d+\.\d+\.\d+/],
      ["datum-security-check", ["--version"], /\d+\.\d+\.\d+/],
      ["datum-host-check", ["list", "--json"], /"cases"/],
      ["datum-binding-check", ["--list"], /MNT-01/]
    ];
    for (const [command, args, expected] of commands) {
      attempt(`${command} ${args.join(" ")} (.bin)`, () => exec(bin(command), args), expected);
      const files = binFiles(command);
      // Exactly one published package names the command: none means the install lost it, two would make `.bin` ambiguous.
      if (files.length !== 1) problems.push(`${command}: expected one published package to declare it, found ${files.map((entry) => entry.name).join(", ") || "none"}`);
      for (const { name, file } of files) {
        attempt(`${name} bin of ${command} ${args.join(" ")}`, () => exec(process.execPath, [file, ...args]), expected);
      }
    }
    attempt("@argusvane/datum/engine", () => exec(process.execPath, ["--input-type=module", "-e", 'const m = await import("@argusvane/datum/engine"); console.log(typeof m.createFormRuntime)']), /function/);
    attempt("@argusvane/datum/package.json", () => exec(process.execPath, ["--input-type=module", "-e", 'const m = await import("@argusvane/datum/package.json", { with: { type: "json" } }); console.log(m.default.name)']), /@argusvane\/datum/);
    for (const file of ["dist/datum-form.js", "dist/datum-builder.js", "dist/datum-form.LICENSE.txt", "dist/types/packages/datum/src/index.d.ts"]) {
      if (!existsSync(join(app, "node_modules", "@argusvane", "datum", file))) problems.push(`@argusvane/datum: ${file} is missing from the install`);
    }
    if (readdirSync(join(app, "node_modules", "@argusvane")).some((entry) => ["datum-engine", "datum-pdf-kernel", "datum-quickjs-wasm-host", "datum-submissions"].includes(entry))) {
      problems.push("a private package was installed beside the published ones");
    }
  } finally {
    rmSync(app, { recursive: true, force: true });
  }
  return problems;
}

function main() {
  const [command, ...rest] = process.argv.slice(2);
  const option = (flag) => (rest.includes(flag) ? rest[rest.indexOf(flag) + 1] : undefined);
  let problems;
  if (command === "check" && option("--version")) {
    problems = checkVersions(option("--version"));
  } else if (command === "pack" && option("--out")) {
    problems = pack(option("--out"));
  } else if (command === "smoke" && option("--dir")) {
    problems = smoke(option("--dir"));
  } else {
    console.error("usage: node scripts/npm/release.mjs check --version <x.y.z> | pack --out <dir> | smoke --dir <dir>");
    process.exit(2);
  }
  if (problems.length > 0) {
    console.error(`release ${command}: ${problems.length} problem${problems.length === 1 ? "" : "s"}:\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`release ${command}: ok`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
