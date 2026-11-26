#!/usr/bin/env node
// Takes a fresh clone to a synced Python workspace: everything the generated resources are built from,
// then the resources, then the sync. The resource distributions refuse to build, an editable install
// included, until their generated files exist, and `fastapi:assets` needs the datum bundles and the
// conformance suite's commands, which are build output too. The steps, in the order that holds:
//
//   1. npm ci in the units the bundles and the commands are built from (scripts/setup.mjs), and the
//      PDF kernel's bundled program
//   2. the datum bundles (packages/datum/dist)
//   3. the conformance suite's commands (packages/conformance-suite/dist/host-check.mjs), which the
//      asset build runs for the test fixtures
//   4. npm run fastapi:assets
//   5. uv sync --all-packages --all-extras --frozen (the interpreter in .python-version; uv fetches it)
//   6. the settings schema, which needs the synced workspace
//
//   npm run fastapi:prepare
//
// It needs Node 22, npm and uv on the PATH. The datum build takes a few minutes.
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..", "..", "..");
const fastapiRoot = join(here, "..");

/** The units npm ci installs: the datum bundles' file: dependencies, the package itself and the conformance suite's. */
export const UNITS = ["engine", "packages/quickjs-wasm-host", "packages/pdf-kernel", "packages/submissions", "packages/conformance-suite", "packages/datum"];

/** The steps as data: a label, a command, its arguments and its folder. */
export const steps = ({ node = process.execPath } = {}) => [
  { label: "install the JavaScript units", command: node, args: [join(repo, "scripts", "setup.mjs"), ...UNITS], cwd: repo },
  { label: "build the datum bundles", command: "npm", args: ["run", "datum:build"], cwd: repo },
  { label: "build the conformance suite commands", command: node, args: [join(repo, "packages", "conformance-suite", "scripts", "build-cli.mjs")], cwd: join(repo, "packages", "conformance-suite") },
  { label: "build the generated resources", command: "npm", args: ["run", "fastapi:assets"], cwd: repo },
  { label: "sync the Python workspace", command: "uv", args: ["sync", "--all-packages", "--all-extras", "--frozen"], cwd: fastapiRoot },
  { label: "write the settings schema", command: node, args: [join(here, "settings-schema.mjs")], cwd: repo }
];

export const main = ({ run = spawnSync, log = console.log, error = console.error } = {}) => {
  const probe = run("uv", ["--version"], { encoding: "utf8" });
  if (probe.error || probe.status !== 0) {
    error("fastapi:prepare: uv is not on the PATH; install it from https://docs.astral.sh/uv/ and run this again.");
    return 1;
  }
  const all = steps();
  for (const [index, step] of all.entries()) {
    log(`fastapi:prepare: ${index + 1}/${all.length} ${step.label}`);
    const result = run(step.command, step.args, { cwd: step.cwd, stdio: "inherit" });
    if (result.error || result.status !== 0) {
      error(`fastapi:prepare: failed to ${step.label} (${step.command} ${step.args.join(" ")}${result.error ? `: ${result.error.message}` : `, exit ${result.status}`}).`);
      return result.status || 1;
    }
  }
  log("fastapi:prepare: ready. Run the tests with `npm run fastapi:test`.");
  return 0;
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
