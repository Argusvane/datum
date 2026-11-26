#!/usr/bin/env node
// The local release script of the Python host. It never uploads: the tag workflow
// (.github/workflows/release-fastapi.yml) is the only thing that publishes.
//
//   npm run fastapi:release -- --version x.y.z [--dry-run] [--check-only] [--check-pins] [--allow-stale] [--skip-security-suite]
//
// Steps: (1) set every member's version with `uv version --package` and rewrite every sibling "==" pin; (2) the pin check;
// (3) rebuild the assets (not in a dry run) and run the security suite's program mode with `--gate release` over the
// sandbox program; (4) `uv build --all-packages`, `twine check --strict`, the post-checks;
// (5) release.json, SHA256SUMS and README.md in integrations/fastapi/dist/datum-fastapi-<version>/; (6) print the tag command.
// A dry run does steps 1 to 5 in a staging copy under integrations/fastapi/build/release-stage/ built from the assets already in
// the tree, so no pyproject.toml or generated file of the tree changes; the script checks that and says so.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { FASTAPI_ROOT, VERSION_PATTERN, pinProblems, readMembers, rewritePins } from "./release-lib.mjs";

const LABEL = "fastapi:release";
const here = dirname(fileURLToPath(import.meta.url));
const REPO = join(FASTAPI_ROOT, "..", "..");
const argv = process.argv.slice(2);

const fail = (message) => {
  console.error(`${LABEL}: ${message}`);
  process.exit(1);
};
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`Usage: npm run fastapi:release -- --version <x.y.z> [options]

Options:
  --version <v>          the release version (PEP 440: 0.1.0, 0.1.0rc1, 0.0.1.dev0)
  --dry-run              do the whole build in a staging copy; the tree's versions and generated files stay as they are
  --check-only           post-checks and twine over the existing dist/datum-fastapi-<v>/ files (no build)
  --check-pins           only assert that every member is at --version (when given) and every sibling pin equals its member
  --allow-stale          let a stale packages/datum dist through when the assets are rebuilt
  --skip-security-suite  skip the security suite's program mode (--gate release), which otherwise fails the release
  --help, -h             this text

Nothing is uploaded, ever. Python for the build: UV_PYTHON, else 3.14.6.`);
  process.exit(0);
}
const valueOf = (name) => {
  const at = argv.findIndex((arg) => arg === name || arg.startsWith(`${name}=`));
  if (at < 0) {
    return undefined;
  }
  const value = argv[at].includes("=") ? argv[at].slice(name.length + 1) : argv[at + 1];
  return value && !value.startsWith("--") ? value : fail(`${name} takes a value.`);
};
const known = new Set(["--version", "--dry-run", "--check-only", "--check-pins", "--allow-stale", "--skip-security-suite", "--help", "-h"]);
for (const [index, arg] of argv.entries()) {
  const flag = arg.split("=")[0];
  if (arg.startsWith("-") && !known.has(flag)) {
    fail(`unknown option ${arg} (--help lists them).`);
  }
  if (!arg.startsWith("-") && argv[index - 1] !== "--version") {
    fail(`unexpected argument ${arg}.`);
  }
}
const dryRun = argv.includes("--dry-run");
const checkOnly = argv.includes("--check-only");
const checkPins = argv.includes("--check-pins");
const allowStale = argv.includes("--allow-stale");
const skipSecurity = argv.includes("--skip-security-suite");
const requested = valueOf("--version");
if (requested !== undefined && !VERSION_PATTERN.test(requested)) {
  fail(`--version ${requested} is not a publishable PEP 440 version.`);
}

const env = { ...process.env, UV_PYTHON: process.env.UV_PYTHON ?? "3.14.6" };
const run = (command, args, { cwd = FASTAPI_ROOT, capture = false } = {}) => {
  console.log(`$ ${[command, ...args].join(" ")}`);
  const result = spawnSync(command, args, { cwd, env, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit" });
  if (result.error) {
    fail(`could not run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} ${args.slice(0, 3).join(" ")} failed (exit ${result.status}).`);
  }
  return result.stdout;
};
const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");
const treeDigest = () => createHash("sha256").update(readMembers().map((member) => `${member.name}\n${member.text}`).join("\0")).digest("hex");

// --check-pins: the tag workflow's version assertion (the tag names the version; the tree must already carry it).
if (checkPins) {
  const problems = pinProblems(readMembers(), requested);
  if (problems.length > 0) {
    fail(`version and pin check failed:\n  ${problems.join("\n  ")}`);
  }
  console.log(`${LABEL}: every member${requested ? ` is at ${requested} and every` : " agrees and every"} sibling pin equals the member it names.`);
  process.exit(0);
}

const inferred = [...new Set(readMembers().map((member) => member.version))];
const version = requested ?? (checkOnly && inferred.length === 1 ? inferred[0] : fail("--version is required."));
const outDir = join(FASTAPI_ROOT, "dist", `datum-fastapi-${version}`);
const twineCheck = (files) => run("uv", ["tool", "run", "twine", "check", "--strict", ...files]);
const postCheck = () => run("uv", ["run", "--frozen", "--no-sync", "python", "-I", join(here, "postcheck.py"), outDir, version]);
const distFiles = () => readdirSync(outDir).filter((file) => file.endsWith(".whl") || file.endsWith(".tar.gz")).sort();

if (checkOnly) {
  if (!existsSync(outDir)) {
    fail(`${relative(REPO, outDir)} does not exist; build it first.`);
  }
  twineCheck(distFiles().map((file) => join(outDir, file)));
  postCheck();
  process.exit(0);
}

// Step 1 and 2: versions and pins, in the tree (a real release) or in a staging copy (a dry run).
let root = FASTAPI_ROOT;
const before = treeDigest();
if (dryRun) {
  root = join(FASTAPI_ROOT, "build", "release-stage");
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  const skip = new Set([".venv", "__pycache__", ".mypy_cache", ".ruff_cache", ".pytest_cache", ".hypothesis", "build", "dist", "node_modules"]);
  for (const entry of ["pyproject.toml", "uv.lock", "packages"]) {
    cpSync(join(FASTAPI_ROOT, entry), join(root, entry), { recursive: true, filter: (source) => !skip.has(basename(source)) });
  }
  console.log(`${LABEL}: dry run in ${relative(REPO, root)}; the assets are taken as they are in the tree.`);
}
const members = readMembers(join(root, "packages"));
const names = members.map((member) => member.name);
for (const member of members) {
  run("uv", ["version", "--package", member.name, version, "--frozen"], { cwd: root });
  const rewritten = rewritePins(readFileSync(member.pyproject, "utf8"), names, version);
  writeFileSync(member.pyproject, rewritten);
}
const problems = pinProblems(readMembers(join(root, "packages")), version);
if (problems.length > 0) {
  fail(`pin rewrite left inconsistencies:\n  ${problems.join("\n  ")}`);
}
console.log(`${LABEL}: ${names.length} members at ${version}, every sibling pin rewritten and checked.`);

// uv.lock records each member's version: re-lock so that `uv lock --check` and `--frozen` builds agree with the bump. The script
// owns this step; a real release says that uv.lock changed.
if (dryRun) {
  run("uv", ["lock", "--offline"], { cwd: root });
} else {
  const lockPath = join(root, "uv.lock");
  const lockBefore = sha256(lockPath);
  run("uv", ["lock"], { cwd: root });
  if (sha256(lockPath) !== lockBefore) {
    console.log(`${LABEL}: uv.lock changed (member versions); commit it with the version bump.`);
  }
}

// Step 3: the assets. A real release rebuilds them (datum-build.json then records the new version); a dry run rewrites that one
// field in its staging copy and builds from the generated files already present.
if (dryRun) {
  for (const { name } of members.map((member) => ({ name: member.name }))) {
    const pkg = name.replace(/^argusvane-/, "").replaceAll("-", "_");
    const recordPath = join(root, "packages", name, "src", pkg, "datum-build.json");
    if (!existsSync(recordPath)) {
      fail(`${name}: ${relative(FASTAPI_ROOT, recordPath)} is missing; run \`npm run fastapi:assets\` once, then repeat the dry run.`);
    }
    writeFileSync(recordPath, `${JSON.stringify({ ...JSON.parse(readFileSync(recordPath, "utf8")), version }, null, 2)}\n`);
  }
} else {
  run("npm", ["run", "fastapi:assets", ...(allowStale ? ["--", "--allow-stale"] : [])], { cwd: REPO });
}
if (skipSecurity) {
  console.warn(`${LABEL}: --skip-security-suite given; the sandbox program was NOT checked by the security suite.`);
} else {
  // The sandbox program this release ships (the asset build copies it from packages/datum/dist).
  const suite = join(REPO, "packages", "conformance-suite");
  if (!existsSync(join(suite, "dist", "cli.mjs"))) {
    run("node", [join(suite, "scripts", "build-cli.mjs")], { cwd: suite });
  }
  run("node", [join(suite, "dist", "cli.mjs"), "--program", join(REPO, "packages", "datum", "dist", "datum-sandbox-program.js"), "--all", "--gate", "release"], { cwd: REPO });
}

// Step 4: build, twine, post-checks.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
run("uv", ["build", "--all-packages", "--out-dir", outDir], { cwd: root });
const files = distFiles();
twineCheck(files.map((file) => join(outDir, file)));
postCheck();

// Step 5: release.json, SHA256SUMS, README.md.
const buildRecord = JSON.parse(readFileSync(join(root, "packages", "argusvane-datum-core", "src", "datum_core", "datum-build.json"), "utf8"));
const order = ["argusvane-datum-qjs-wasm", "argusvane-datum-programs", "argusvane-datum-assets-ui", "argusvane-datum-assets-pdf", "argusvane-datum-sandbox", "argusvane-datum-core", "argusvane-datum-sandbox-wasmtime", "argusvane-datum-fastapi"];
const entry = (file) => ({ file, size: statSync(join(outDir, file)).size, sha256: sha256(join(outDir, file)) });
const git = spawnSync("git", ["rev-parse", "HEAD"], { cwd: REPO, encoding: "utf8" }).stdout?.trim() || null;
const release = {
  version,
  tag: `v${version}`,
  dryRun,
  buildId: buildRecord.buildId,
  sandboxAbi: buildRecord.sandboxAbi,
  pdfAbi: buildRecord.pdfAbi,
  commit: git,
  distributions: order.map((name) => ({ name, files: files.filter((file) => file.startsWith(`${name.replaceAll("-", "_")}-`)).map(entry) })),
  uploaded: false
};
writeFileSync(join(outDir, "release.json"), `${JSON.stringify(release, null, 2)}\n`);
writeFileSync(join(outDir, "SHA256SUMS"), `${files.map((file) => `${sha256(join(outDir, file))}  ${file}`).join("\n")}\n`);
writeFileSync(
  join(outDir, "README.md"),
  `# Datum for FastAPI ${version}\n\nBuild ${buildRecord.buildId}; sandbox ABI ${buildRecord.sandboxAbi}, PDF ABI ${buildRecord.pdfAbi}. Verify with \`shasum -a 256 -c SHA256SUMS\`.\n\n` +
    `Install from these files:\n\n\`\`\`\npip install --find-links . "argusvane-datum-fastapi[all]==${version}"\n\`\`\`\n\nOr, once published:\n\n\`\`\`\npip install "argusvane-datum-fastapi[all]==${version}"\n\`\`\`\n`
);
console.log(`${LABEL}: wrote ${relative(REPO, outDir)}/{release.json,SHA256SUMS,README.md} and ${files.length} distribution files; nothing uploaded.`);

if (dryRun) {
  rmSync(root, { recursive: true, force: true });
  if (treeDigest() !== before) {
    fail("the dry run changed a member's pyproject.toml; this is a defect in the script.");
  }
  console.log(`${LABEL}: dry run complete; the members' pyproject.toml files are unchanged.`);
} else {
  run("node", ["--test", join(here, "tests", "pins.test.mjs")], { cwd: REPO });
  console.log(`${LABEL}: review the diff and commit it. Do not push the tag yet: the Maven release comes first and the tag is pushed after it (docs/releasing.md).`);
}
