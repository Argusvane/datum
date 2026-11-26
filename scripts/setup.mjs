#!/usr/bin/env node
// Installs the JavaScript units of the repository, in dependency order, so a fresh clone can build and
// test. There is no root install: every unit has its own package.json and lockfile, and the units that
// import another one (`file:` dependencies) are symlinks to it, which do not install the dependency's
// own dependencies. Each unit therefore needs its own `npm ci`, and the order below is the order in
// which one unit is a dependency of the next.
//
//   node scripts/setup.mjs [--force] [<unit> ...]
//
// With no unit, every unit is installed: the engine, the packages, the plugins, the reference bindings
// and the site. With units (folders as listed below, for example `engine packages/datum`) only those
// are, still in dependency order; `plugins` and `bindings` stand for every folder under them. A unit whose node_modules is already newer than its lockfile is
// skipped, so a second run, and the root `npm run ci`, costs seconds; --force runs `npm ci` again.
//
// pdf-kernel also builds its bundled program after its install: the datum bundles copy it, and no
// other step makes it.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const subfolders = (parent) =>
  existsSync(join(repo, parent))
    ? readdirSync(join(repo, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && existsSync(join(repo, parent, entry.name, "package.json")))
        .map((entry) => `${parent}/${entry.name}`)
        .sort()
    : [];

/**
 * The units in dependency order: everything imports the engine; the PDF kernel, the submissions package and
 * the conformance suite import the ones before them; the web components import all of those; the plugins
 * build from the web components; the bindings and the site import the engine and nothing built.
 */
export const units = () => [
  "engine",
  "packages/quickjs-wasm-host",
  "packages/pdf-kernel",
  "packages/submissions",
  "packages/conformance-suite",
  "packages/form-test",
  "packages/datum",
  ...subfolders("plugins"),
  ...subfolders("bindings"),
  "site"
];

/** Commands run after a unit's install. */
const AFTER_INSTALL = { "packages/pdf-kernel": ["run", "build:program"] };

/** True when the unit's node_modules was written after its lockfile last changed. */
export const isInstalled = (unit) => {
  const lock = join(repo, unit, "package-lock.json");
  const installed = join(repo, unit, "node_modules", ".package-lock.json");
  return existsSync(installed) && existsSync(lock) && statSync(installed).mtimeMs >= statSync(lock).mtimeMs;
};

const npm = (unit, args) => {
  const result = spawnSync("npm", args, { cwd: join(repo, unit), stdio: "inherit" });
  if (result.error || result.status !== 0) {
    console.error(`setup: \`npm ${args.join(" ")}\` failed in ${unit}${result.error ? `: ${result.error.message}` : ` (exit ${result.status})`}.`);
    process.exit(result.status ?? 1);
  }
};

export const main = (argv) => {
  const force = argv.includes("--force");
  const all = units();
  const asked = argv
    .filter((arg) => !arg.startsWith("--"))
    .map((arg) => arg.replace(/\/+$/, ""))
    .flatMap((arg) => (arg === "plugins" || arg === "bindings" ? all.filter((unit) => unit.startsWith(`${arg}/`)) : [arg]));
  const unknown = asked.filter((unit) => !all.includes(unit));
  if (unknown.length > 0) {
    console.error(`setup: unknown unit ${unknown.join(", ")}; the units are ${all.join(", ")}.`);
    return 2;
  }
  const chosen = asked.length === 0 ? all : all.filter((unit) => asked.includes(unit));
  for (const unit of chosen) {
    const folder = relative(process.cwd(), join(repo, unit)) || ".";
    if (!force && isInstalled(unit)) {
      console.log(`setup: ${unit} is installed (node_modules is newer than package-lock.json).`);
    } else {
      console.log(`setup: npm ci in ${unit} (${folder})`);
      npm(unit, ["ci"]);
    }
    if (AFTER_INSTALL[unit]) {
      npm(unit, AFTER_INSTALL[unit]);
    }
  }
  console.log(`setup: ${chosen.length} unit(s) ready.`);
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
