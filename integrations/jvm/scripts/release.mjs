#!/usr/bin/env node
// Assembles and (with a maintainer's key and token) publishes a Datum for the JVM release. Every module of integrations/jvm is one
// reactor with one version; this script is the only place that version is chosen:
//
//   0. the commit: the working tree is clean, origin is argusvane/datum, HEAD is on origin/main (there is no fallback to a
//      local main), a ci.yml run on HEAD passed its ci-ok job (read with the gh CLI, which must be installed and signed in),
//      the tag v<v> already exists and points at HEAD, and CHANGELOG.md has its `## [<v>]` section. A Central release cannot
//      be deleted, so what it holds must be the commit the tag names and the commit CI approved; nothing is built or uploaded
//      until all of them hold. A dry run reports what is wrong and goes on; --check-only does not look;
//   1. the assets, fresh: `npm run datum:build`, then `npm run jvm:assets` WITHOUT --allow-stale (a dist
//      older than the sources is refused), unless --allow-stale says the dist is already right. The files land in
//      integrations/jvm/target/datum-assets; the Maven build below generates them again from the same dist
//      (its root project runs the same script), with -Ddatum.assets.allowStale=true when --allow-stale was given;
//   2. the security suite's program mode over the sandbox program this release ships, `--gate release`, on quickjs-emscripten
//      (the page's engine); after 3a it runs again on the qjs-wasi.wasm the build compiled, held to the pom's qjs.sha256
//      (the engine of the jars), and either failure stops the release before anything is uploaded;
//   3. Maven from integrations/jvm, in two runs so that the checks of step 4 GATE the upload (Central releases cannot
//      be deleted, so nothing may be uploaded before the checks pass):
//        a. `./mvnw -B -ntp -Prelease -Drevision=<v> clean verify`: builds and, in verify, signs (the GPG key is in
//           the maintainer's keyring, never read or printed here);
//        b. step 4 over the result;
//        c. only then `./mvnw -B -ntp -Prelease -Drevision=<v> -DskipTests -DskipITs deploy` (no clean, so the checked
//           jars are the ones uploaded; their sums are compared again after the deploy). Central's publishing plugin
//           uploads and waits for validation; the deployment is published by the maintainer in the Central portal
//           unless --publish adds -DautoPublish=true. The Central token lives in ~/.m2/settings.xml under the server
//           id `central`.
//      --dry-run runs only a, with -Dgpg.skip=true: sources and javadoc jars are built, nothing is signed or uploaded;
//   4. post-checks over every published module (see checkModule): the flattened pom that is deployed, then
//      target/*.jar: META-INF/LICENSE and
//      META-INF/NOTICE and the Datum-* manifest entries in every jar, the version in the manifest and no SNAPSHOT in a
//      jar's manifest or embedded pom nor in the flattened pom that is deployed. No `-tests.jar` may exist in any module
//      (test helpers live in the unpublished *-test-support modules), every *-test-support module must skip the deploy
//      and be named in the central-publishing excludeArtifacts, and a staged Central bundle holds no tests jar and no
//      test-support artifact. The examples and the test-support modules are never published and are skipped;
//   5. integrations/jvm/dist/datum-jvm-<v>/{release.json, SHA256SUMS, README.md}, and the tag to cut.
//
// A release is cut by the Release Maven workflow (.github/workflows/release-maven.yml), which runs this script with --stage:
// every refusal of a real run, the build and tests UNSIGNED, the post-checks, then the deploy with -DskipUpload=true, which
// stages the Central bundle without uploading it. The bundle is checked and copied into the dist directory as
// central-bundle.zip, with its SHA-256 in release.json. The workflow's build job holds no secret; its publish job, behind the
// maven-central environment's approval, signs that bundle and uploads it (central-publish.mjs). --stage needs no GPG key and
// no Central token.
//
// Run by hand without --stage (the way a release was cut before the workflow, kept for a maintainer's machine), nothing is
// committed, pushed or tagged: the maintainer creates the tag locally BEFORE the run (step 0 needs it) and pushes it AFTER the
// deployment is published, because the push starts the release workflows (docs/releasing.md has the whole order). The script
// prints the push command and the two commands that attach SHA256SUMS to the GitHub Release.
//
//   npm run jvm:release -- --version <x.y.z> [--dry-run | --stage | --publish] [--allow-stale] [--skip-security-suite]
//                          [--maven-args "<extra Maven options>"] [--check-only]
//
// --maven-args takes -D / -X style options only (no goals, no -P, no value-taking flags such as -pl): a goal there
// could deploy during a dry run, and -DautoPublish / -Dgpg.skip / -Drevision belong to this script's own flags.
//
// --check-only skips steps 0 to 3 (so it needs no tag, no clean tree and no CHANGELOG section) and runs the post-checks and the dist over the jars already under target/ (the
// version is then whatever those jars were built with). With a -SNAPSHOT version the SNAPSHOT-mention checks and the
// sources / javadoc jar requirement (only -Prelease builds them) are skipped, so the other checks can be tried
// without a 20-minute six-target build. It never deploys and writes nothing under dist/: it prints what the post-checks
// found and stops before step 5.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { readJvmPin } from "../../shared/scripts/pin-runtime.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// DATUM_RELEASE_REPO names the checkout to build and check when the script runs from another one: the Release Maven workflow
// runs its own commit's scripts over the tag's checkout, so a tag made before a fix to these scripts is still released by
// the fixed ones. Unset, the checkout is the one this script is in.
const repo = process.env.DATUM_RELEASE_REPO ? resolve(process.env.DATUM_RELEASE_REPO) : join(here, "..", "..", "..");
const jvm = join(repo, "integrations", "jvm");
const GROUP_ID = "com.argusvane";
// Where central-publishing-maven-plugin stages the reactor's one bundle: under the target/ of the project whose plugin
// assembles it (the BOM is the first module and carries its own plugin configuration), so both places are looked at.
const centralBundles = [join(jvm, "target", "central-publishing", "central-bundle.zip"), join(jvm, "datum-bom", "target", "central-publishing", "central-bundle.zip")];
const existingBundles = () => centralBundles.filter((bundle) => existsSync(bundle));
// The release runs no clean, so a stale bundle may sit beside the one just staged: the newest by mtime is the one the
// deploy wrote, and the others are still checked so a stale one holding a tests jar is not overlooked.
export const newestBundle = (bundles = existingBundles()) =>
  [...bundles].sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
/** Checks every existing bundle (or the given list); a missing bundle is reported when none exists. */
export const checkBundles = (bundles = existingBundles()) =>
  bundles.length === 0 ? [`${centralBundles[0]} is missing`] : bundles.flatMap((bundle) => checkBundle(bundle));
const REPOSITORY = "https://github.com/argusvane/datum";

// Modules that never reach Central: the examples are applications, and the *-test-support modules hold the test helpers
// that modules share (no library publishes a tests jar).
const UNPUBLISHED_MODULES = new Set(["examples"]);
const isTestSupport = (path) => /(^|\/)[^/]+-test-support$/.test(path);
const isUnpublished = (path) => UNPUBLISHED_MODULES.has(path) || isTestSupport(path);
// The manifest entries every published jar carries, written by the parent pom from assets.properties.
const DATUM_MANIFEST_KEYS = ["Datum-Engine-Version", "Datum-Sandbox-Abi", "Datum-Pdf-Abi", "Datum-Build-Id", "Datum-Source"];

// ---- reading a jar (the unzip on every runner and developer machine; no dependency) ----

export const listEntries = (jar) => {
  const result = spawnSync("unzip", ["-Z1", jar], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`cannot list ${jar}: ${result.stderr || result.error}`);
  }
  return result.stdout.split("\n").filter((line) => line !== "");
};

export const readEntry = (jar, name) => {
  const result = spawnSync("unzip", ["-p", jar, name], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return result.status === 0 ? result.stdout : undefined;
};

export const parseManifest = (text) => {
  // RFC 822 style with continuation lines (a leading space continues the previous value).
  const entries = new Map();
  let last;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith(" ") && last !== undefined) {
      entries.set(last, entries.get(last) + line.slice(1));
      continue;
    }
    const split = line.indexOf(":");
    if (split > 0) {
      last = line.slice(0, split);
      entries.set(last, line.slice(split + 1).trim());
    }
  }
  return entries;
};

// ---- the post-checks ----

/**
 * What is wrong with one published jar. `kind` is "main" (full checks) or "sources" / "javadoc" (a jar
 * that is only checked for being a readable, non-empty archive; Central wants them and they carry no manifest).
 */
export const checkJar = (jar, version, kind, { allowSnapshot = false } = {}) => {
  const problems = [];
  let entries;
  try {
    entries = listEntries(jar);
  } catch (error) {
    return [String(error.message)];
  }
  if (entries.length === 0) {
    problems.push("the jar is empty");
  }
  if (kind !== "main") {
    return problems;
  }
  for (const required of ["META-INF/LICENSE", "META-INF/NOTICE"]) {
    const text = entries.includes(required) ? readEntry(jar, required) : undefined;
    if (text === undefined || text.trim() === "") {
      problems.push(`${required} is missing or empty`);
    }
  }
  const manifestText = readEntry(jar, "META-INF/MANIFEST.MF");
  if (manifestText === undefined) {
    problems.push("META-INF/MANIFEST.MF is missing");
  } else {
    const manifest = parseManifest(manifestText);
    for (const key of DATUM_MANIFEST_KEYS) {
      const value = manifest.get(key);
      if (!value) {
        problems.push(`manifest entry ${key} is missing`);
      } else if (value.includes("${")) {
        problems.push(`manifest entry ${key} is the unresolved placeholder ${value} (target/datum-assets/assets.properties was absent at build time)`);
      }
    }
    if (manifest.get("Implementation-Version") !== version) {
      problems.push(`manifest Implementation-Version is ${manifest.get("Implementation-Version") ?? "absent"}, not ${version}`);
    }
    if (!allowSnapshot && /SNAPSHOT/.test(manifestText)) {
      problems.push("META-INF/MANIFEST.MF mentions SNAPSHOT");
    }
  }
  for (const name of entries.filter((entry) => /^META-INF\/maven\/.+\/(pom\.xml|pom\.properties)$/.test(entry))) {
    if (!allowSnapshot && /SNAPSHOT/.test(readEntry(jar, name) ?? "")) {
      problems.push(`${name} mentions SNAPSHOT`);
    }
  }
  return problems;
};

/** The flattened pom that Maven deploys in place of the source pom: the version, no SNAPSHOT, no unresolved ${revision}. */
export const checkFlattenedPom = (pomPath, version, { allowSnapshot = false } = {}) => {
  if (!existsSync(pomPath)) {
    return [`${pomPath} is missing (the flatten plugin did not run)`];
  }
  const text = readFileSync(pomPath, "utf8");
  const problems = [];
  if (!allowSnapshot && /SNAPSHOT/.test(text)) {
    problems.push("the flattened pom mentions SNAPSHOT");
  }
  if (text.includes("${revision}")) {
    problems.push("the flattened pom still holds ${revision}");
  }
  const own = /<version>([^<]+)<\/version>/.exec(text.replace(/<parent>[\s\S]*?<\/parent>/, ""));
  if (own !== null && own[1] !== version) {
    problems.push(`the flattened pom's version is ${own[1]}, not ${version}`);
  }
  return problems;
};

// ---- the commit being released ----

const git = (args, cwd) => spawnSync("git", args, { cwd, encoding: "utf8" });

/**
 * What is wrong with the commit a release would be built from: the tree must be clean (untracked files count, ignored
 * ones do not), HEAD must be on origin/main (a clone without origin/main is refused: a local main proves nothing about
 * what the remote holds), and the tag must exist and point at HEAD. The refs are the clone's own: `git fetch origin` first
 * so that origin/main is current.
 */
export const releaseCommitProblems = (tag, cwd = repo) => {
  const problems = [];
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd);
  if (head.status !== 0) {
    return [`${cwd} is not a git working tree with a commit`];
  }
  const headSha = head.stdout.trim();
  const status = git(["status", "--porcelain"], cwd);
  const changed = status.stdout.split("\n").filter((line) => line !== "");
  if (status.status !== 0) {
    problems.push(`git status failed: ${status.stderr.trim()}`);
  } else if (changed.length > 0) {
    problems.push(`the working tree is not clean (${changed.length} path${changed.length === 1 ? "" : "s"} changed, for example ${changed[0].slice(3)}); commit or remove them`);
  }
  if (git(["rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"], cwd).status !== 0) {
    problems.push("there is no origin/main to hold HEAD against; run git fetch origin (a local main is not looked at)");
  } else if (git(["merge-base", "--is-ancestor", headSha, "origin/main"], cwd).status !== 0) {
    problems.push(`HEAD ${headSha.slice(0, 12)} is not on origin/main; merge it to main and git fetch origin before releasing`);
  }
  const tagged = git(["rev-parse", "--verify", "--quiet", `refs/tags/${tag}^{commit}`], cwd);
  if (tagged.status !== 0) {
    problems.push(`the tag ${tag} does not exist; create it on the commit being released (git tag ${tag}) before the run, and push it only after the deployment is published`);
  } else if (tagged.stdout.trim() !== headSha) {
    problems.push(`the tag ${tag} points at ${tagged.stdout.trim().slice(0, 12)}, not at HEAD ${headSha.slice(0, 12)}`);
  }
  return problems;
};

/** True for the https and ssh forms of the repository's remote URL (with or without `.git`, a trailing slash or a user). */
export const isDatumRemote = (url) => /^(https:\/\/([^@/]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com(:22)?\/)argusvane\/datum(\.git)?\/?$/.test(url.trim());

/** The release is of argusvane/datum: the origin remote must name it, so a fork's clone cannot reach Central. */
export const originRemoteProblems = (cwd = repo) => {
  const origin = git(["remote", "get-url", "origin"], cwd);
  if (origin.status !== 0) {
    return ["the clone has no origin remote; it must be argusvane/datum"];
  }
  return isDatumRemote(origin.stdout) ? [] : [`the origin remote is ${origin.stdout.trim()}, not github.com/argusvane/datum`];
};

const ghRun = (args) => spawnSync("gh", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });

/**
 * What is wrong with the CI evidence for a commit: a ci.yml run on it must have concluded success with its ci-ok job (the gate
 * that waits for every other job) passed, the lookup the release workflows make on the tagged commit. `gh` is injected for the
 * tests; the default is the gh CLI, which must be installed and signed in.
 */
export const ciProblems = (sha, gh = ghRun, slug = "argusvane/datum", env = process.env) => {
  // Only github.com's active account: another host's expired login must not refuse a maintainer signed in here. On a
  // workflow runner GH_TOKEN is the job's token, which `gh auth status` may not be able to describe (it is no user's), so
  // the status is not asked; a token that cannot read the runs fails the lookup below, which says so.
  const auth = env.GH_TOKEN ? { status: 0 } : gh(["auth", "status", "--active", "--hostname", "github.com"]);
  if (auth.error !== undefined && auth.error.code === "ENOENT") {
    return ["the gh CLI is not installed, so CI on HEAD cannot be checked; install it (https://cli.github.com) and run gh auth login"];
  }
  if (auth.status !== 0) {
    return ["the gh CLI is not signed in, so CI on HEAD cannot be checked; run gh auth login"];
  }
  const runs = gh(["api", `repos/${slug}/actions/workflows/ci.yml/runs?head_sha=${sha}&status=success&per_page=100`, "--jq", ".workflow_runs[].id"]);
  if (runs.status !== 0) {
    return [`the ci.yml runs of ${sha.slice(0, 12)} could not be read: ${String(runs.stderr ?? "").trim() || "gh api failed"}`];
  }
  const unread = [];
  for (const id of String(runs.stdout).split("\n").filter((line) => line.trim() !== "")) {
    const jobs = gh(["api", `repos/${slug}/actions/runs/${id.trim()}/jobs?per_page=100`, "--jq", '[.jobs[] | select(.name == "ci-ok") | .conclusion] | first // ""']);
    if (jobs.status !== 0) {
      unread.push(`the jobs of ci.yml run ${id.trim()} could not be read: ${String(jobs.stderr ?? "").trim() || "gh api failed"}`);
      continue;
    }
    if (String(jobs.stdout).trim() === "success") {
      return [];
    }
  }
  if (unread.length > 0) {
    return unread;
  }
  return [`no ci.yml run on ${sha.slice(0, 12)} concluded success with ci-ok passing; push the commit to main, wait for CI, then tag it`];
};

/**
 * The options a real deploy refuses: Central keeps whatever it receives, so a real run takes a plain x.y.z (a prerelease
 * cannot be named alike on npm and PyPI), builds its own assets and runs the security suite.
 */
export const realRunProblems = ({ version, allowStale = false, skipSecuritySuite = false }) => [
  ...(/^\d+\.\d+\.\d+$/.test(version) ? [] : [`a release is a plain x.y.z version (got ${version}); prereleases are not released`]),
  ...(allowStale ? ["--allow-stale ships a dist this run did not build; a release builds its own"] : []),
  ...(skipSecuritySuite ? ["--skip-security-suite ships a program the suite did not check; a release runs it"] : [])
];

/**
 * The security suite's command line over the sandbox program, `--gate release`: on quickjs-emscripten (the page's engine),
 * or, given `wasm` and `sha256`, on that qjs-wasi.wasm (the engine of the jars), which the suite refuses unless it has the
 * sha256.
 */
export const securitySuiteArgs = ({ cli, program, manifest, wasm, sha256 }) => [
  cli,
  "--program", program,
  "--manifest", manifest,
  "--gate", "release",
  ...(wasm !== undefined ? ["--qjs-wasm", wasm, "--qjs-sha256", sha256] : [])
];

/**
 * The qjs-wasi.wasm the Maven build compiled: the pom's default under datum-sandbox-endive's target/, or the file a
 * `-Dqjs.wasm.file=` option names (an air-gapped build), resolved as Maven does, against that module's folder.
 */
export const qjsWasmFile = (mavenArgs, root = jvm) => {
  const module = join(root, "libs", "datum-sandbox-endive");
  const named = mavenArgs.map((arg) => /^-Dqjs\.wasm\.file=(.+)$/.exec(arg)?.[1]).filter((path) => path !== undefined).at(-1);
  return named !== undefined ? resolve(module, named) : join(module, "target", "qjs", "qjs-wasi.wasm");
};

/** Every refusal of step 0: the tree and tag, the origin, the CI run of HEAD and the changelog. */
export const releaseGuardProblems = (tag, version, { cwd = repo, gh = ghRun, changelog } = {}) => {
  const commit = releaseCommitProblems(tag, cwd);
  const head = git(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], cwd);
  return [
    ...commit,
    ...originRemoteProblems(cwd),
    ...(head.status === 0 ? ciProblems(head.stdout.trim(), gh) : []),
    ...(changelog === undefined ? changelogProblems(version) : changelogProblems(version, changelog))
  ];
};

/** The changelog must name the version: `## [<version>]`, which scripts/changelog-promote.mjs writes. */
export const changelogProblems = (version, changelog = join(repo, "CHANGELOG.md")) => {
  if (!existsSync(changelog)) {
    return [`${changelog} is missing`];
  }
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${escaped}\\]( - \\d{4}-\\d{2}-\\d{2})?\\s*$`, "m").test(readFileSync(changelog, "utf8"))
    ? []
    : [`CHANGELOG.md has no "## [${version}] - <date>" section; run node scripts/changelog-promote.mjs --version ${version} and commit it`];
};

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

// ---- the module list ----

export const publishedModules = (root = jvm) => {
  const parent = readFileSync(join(root, "pom.xml"), "utf8");
  const listed = [...parent.matchAll(/<module>([^<]+)<\/module>/g)].map((match) => match[1]);
  const modules = [{ path: ".", artifactId: "datum-parent", packaging: "pom" }];
  for (const path of listed) {
    if (isUnpublished(path)) {
      continue;
    }
    const pom = readFileSync(join(root, path, "pom.xml"), "utf8").replace(/<parent>[\s\S]*?<\/parent>/, "");
    const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(pom)?.[1];
    const packaging = /<packaging>([^<]+)<\/packaging>/.exec(pom)?.[1] ?? "jar";
    modules.push({ path, artifactId, packaging });
  }
  return modules;
};

/** Runs every check over one module; returns { jars: [{file, kind, bytes, sha256}], problems: [string] }. */
export const checkModule = (module, version, { signed = false, root = jvm, allowSnapshot = false } = {}) => {
  const dir = join(root, module.path);
  const problems = [];
  const jars = [];
  const flattened = join(dir, ".flattened-pom.xml");
  for (const problem of checkFlattenedPom(flattened, version, { allowSnapshot })) {
    problems.push(`${module.artifactId}: ${problem}`);
  }
  // The flattened pom is what Maven deploys as <artifactId>-<version>.pom (the BOM is nothing but this file), so it
  // is summed like a jar; its signature too when there is one.
  if (existsSync(flattened)) {
    jars.push({ file: relative(root, flattened), kind: "pom", deployedAs: `${module.artifactId}-${version}.pom`, bytes: statSync(flattened).size, sha256: sha256(flattened) });
    const pomSignature = `${flattened}.asc`;
    if (existsSync(pomSignature)) {
      jars.push({ file: relative(root, pomSignature), kind: "signature", bytes: statSync(pomSignature).size, sha256: sha256(pomSignature) });
    }
  }
  if (module.packaging === "pom") {
    return { jars, problems };
  }
  const target = join(dir, "target");
  const expected = [
    { kind: "main", file: `${module.artifactId}-${version}.jar` },
    { kind: "sources", file: `${module.artifactId}-${version}-sources.jar` },
    { kind: "javadoc", file: `${module.artifactId}-${version}-javadoc.jar` }
  ];
  for (const { kind, file } of expected) {
    const path = join(target, file);
    if (!existsSync(path)) {
      // Sources and javadoc jars exist only under -Prelease; a -SNAPSHOT check-only run is on a plain build.
      if (!(allowSnapshot && (kind === "sources" || kind === "javadoc"))) {
        problems.push(`${module.artifactId}: ${file} was not built`);
      }
      continue;
    }
    for (const problem of checkJar(path, version, kind, { allowSnapshot })) {
      problems.push(`${module.artifactId}: ${file}: ${problem}`);
    }
    jars.push({ file: relative(root, path), kind, bytes: statSync(path).size, sha256: sha256(path) });
    if (signed) {
      if (existsSync(`${path}.asc`)) {
        jars.push({ file: relative(root, `${path}.asc`), kind: "signature", bytes: statSync(`${path}.asc`).size, sha256: sha256(`${path}.asc`) });
      } else {
        problems.push(`${module.artifactId}: ${file}.asc (the signature) is missing`);
      }
    }
  }
  // No module publishes a tests jar: a module that attaches one (a test-jar goal) has grown test helpers that belong in a
  // *-test-support module, and would publish them by accident.
  for (const problem of checkNoTestsJar(target, module.artifactId)) {
    problems.push(problem);
  }
  return { jars, problems };
};

/** A `-tests.jar` (or its signature) in a module's target directory: test helpers do not ship, so any is a problem. */
export const checkNoTestsJar = (target, artifactId) => {
  if (!existsSync(target)) {
    return [];
  }
  return readdirSync(target)
    .filter((name) => /-tests\.jar(\.asc)?$/.test(name))
    .map((name) => `${artifactId}: ${name} is a tests jar; test helpers live in a *-test-support module and are never published`);
};

/**
 * The names a Central bundle must not hold: a `-tests.jar`, or any file of a *-test-support artifact. `entries` are the
 * bundle's file names (the bundle is the zip central-publishing-maven-plugin stages, laid out as a Maven repository).
 */
export const checkBundleEntries = (entries) => {
  const problems = [];
  for (const entry of entries) {
    if (/-tests\.jar(\.asc|\.md5|\.sha1|\.sha256|\.sha512)?$/.test(entry)) {
      problems.push(`the bundle holds a tests jar: ${entry}`);
    } else if (/\/[^/]*-test-support\//.test(entry)) {
      problems.push(`the bundle holds a test-support artifact: ${entry}`);
    }
  }
  return problems;
};

/** The staged bundle of a -Prelease deploy (see centralBundles for where central-publishing-maven-plugin writes it). */
export const checkBundle = (bundle) => {
  if (!existsSync(bundle)) {
    return [`${bundle} is missing`];
  }
  let entries;
  try {
    entries = listEntries(bundle);
  } catch (error) {
    return [String(error.message)];
  }
  return entries.length === 0 ? [`${bundle} is empty`] : checkBundleEntries(entries);
};

/**
 * The *-test-support modules of the reactor, each of which must skip the deploy plugin (maven.deploy.skip) and be named in
 * the central-publishing excludeArtifacts of the root pom and of datum-bom (whose plugin may be the one that assembles the
 * bundle): together they keep a test helper out of the bundle however the build is run, and a module added without them
 * would be published.
 */
export const checkTestSupportModules = (root = jvm) => {
  const parent = readFileSync(join(root, "pom.xml"), "utf8");
  const excludedBy = (pomPath) => {
    if (!existsSync(pomPath)) {
      return undefined;
    }
    const pom = readFileSync(pomPath, "utf8");
    return new Set([...(/<excludeArtifacts>([\s\S]*?)<\/excludeArtifacts>/.exec(pom)?.[1] ?? "").matchAll(/<excludeArtifact>([^<]+)<\/excludeArtifact>/g)].map((match) => match[1].trim()));
  };
  const excluded = excludedBy(join(root, "pom.xml"));
  const bomExcluded = excludedBy(join(root, "datum-bom", "pom.xml"));
  const problems = [];
  for (const path of [...parent.matchAll(/<module>([^<]+)<\/module>/g)].map((match) => match[1]).filter(isTestSupport)) {
    const pom = readFileSync(join(root, path, "pom.xml"), "utf8").replace(/<parent>[\s\S]*?<\/parent>/, "");
    const artifactId = /<artifactId>([^<]+)<\/artifactId>/.exec(pom)?.[1];
    if (!/<maven\.deploy\.skip>\s*true\s*<\/maven\.deploy\.skip>/.test(pom)) {
      problems.push(`${artifactId}: maven.deploy.skip is not true in ${path}/pom.xml`);
    }
    if (!excluded.has(artifactId)) {
      problems.push(`${artifactId}: not named in the root pom's central-publishing excludeArtifacts`);
    }
    if (bomExcluded !== undefined && !bomExcluded.has(artifactId)) {
      problems.push(`${artifactId}: not named in datum-bom's central-publishing excludeArtifacts`);
    }
  }
  return problems;
};

// ---- the README of the release directory ----

export const readmeText = ({ version, tag, builtAt, assets, dryRun, staged = false }) => [
  `# Datum for the JVM ${version}`,
  "",
  `Built ${builtAt.slice(0, 10)} from commit \`${assets.source ?? "unknown"}\` of <${REPOSITORY}>: engine ${assets.engineVersion}, sandbox ABI ${assets.sandboxAbi}, PDF ABI ${assets.pdfAbi}, assets build \`${assets.buildId}\`. MIT licence. Java 17 or later; the Spring Boot bindings are for Spring Boot 4.`,
  ...(dryRun ? ["", "**This directory is from a dry run: nothing was signed or uploaded.**"] : []),
  "",
  "## Use it",
  "",
  `Import the bill of materials, then add a starter (group id \`${GROUP_ID}\`):`,
  "",
  "```xml",
  "<dependencyManagement>",
  "  <dependencies>",
  "    <dependency>",
  `      <groupId>${GROUP_ID}</groupId>`,
  "      <artifactId>datum-bom</artifactId>",
  `      <version>${version}</version>`,
  "      <type>pom</type>",
  "      <scope>import</scope>",
  "    </dependency>",
  "  </dependencies>",
  "</dependencyManagement>",
  "",
  "<dependencies>",
  "  <dependency>",
  `    <groupId>${GROUP_ID}</groupId>`,
  "    <artifactId>datum-spring-boot-starter-ui</artifactId>",
  "  </dependency>",
  "</dependencies>",
  "```",
  "",
  "`datum-spring-boot-starter-submissions` is the receiving half alone; `-pdf`, `-timestamp` and `-webauthn` add the other capabilities, `-test` is a test-scope starter.",
  "",
  "## What is in this directory",
  "",
  "- `release.json`: the version, the sources it was built from and every published artifact (jars, the flattened poms as deployed, signatures) with its size and SHA-256.",
  "- `SHA256SUMS`: the same sums, paths relative to `integrations/jvm`; `shasum -a 256 -c SHA256SUMS` from there.",
  ...(staged ? ["- `central-bundle.zip`: the bundle staged for Central, unsigned; its SHA-256 is in `release.json`."] : []),
  "",
  "## Tag",
  "",
  ...(staged
    ? [`The jars were built from the commit the tag ${tag} names, by the Release Maven workflow. Nothing here is signed: the workflow's publish job signs \`central-bundle.zip\` and uploads it to Central.`]
    : [
      dryRun
        ? `A real release is built from the commit the tag ${tag} names, created before the run.`
        : `The jars were built from the commit the tag ${tag} names, created before the run. Pushing the tag starts the npm and PyPI workflows:`,
      ...(dryRun ? [] : ["", "```sh", `git push origin ${tag}`, "```"])
    ]),
  ""
].join("\n");

// ---- the run ----

const run = (command, args, options = {}) => spawnSync(command, args, { stdio: "inherit", cwd: repo, ...options });

const main = () => {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
  };
  const fail = (message) => {
    console.error(message);
    process.exit(1);
  };
  const dryRun = argv.includes("--dry-run");
  const stage = argv.includes("--stage");
  const publish = argv.includes("--publish");
  const allowStale = argv.includes("--allow-stale");
  const checkOnly = argv.includes("--check-only");
  const version = option("--version");
  if (version === undefined) {
    fail("release: --version <x.y.z> is required (the reactor's one version; there is no default).");
  }
  if (!checkOnly && !/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(version)) {
    fail(`release: --version must be x.y.z (got ${version}).`);
  }
  if (!checkOnly && /SNAPSHOT/.test(version)) {
    fail("release: a SNAPSHOT version cannot be released.");
  }
  if ([dryRun, stage, publish, checkOnly].filter(Boolean).length > 1) {
    fail("release: --dry-run, --stage, --publish and --check-only exclude each other.");
  }
  if (!dryRun && !checkOnly) {
    const refused = realRunProblems({ version, allowStale, skipSecuritySuite: argv.includes("--skip-security-suite") });
    if (refused.length > 0) {
      fail(`release: not releasing; nothing built or uploaded:\n  - ${refused.join("\n  - ")}`);
    }
  }
  const mavenArgs = (option("--maven-args") ?? "").split(/\s+/).filter((part) => part !== "");
  const badArg = mavenArgs.find((part) => !/^-[DX]/.test(part) || /autoPublish|gpg\.skip|revision|skipTests|skipITs/.test(part));
  if (badArg !== undefined) {
    fail(`release: --maven-args may carry only -D / -X options that are not -DautoPublish, -Dgpg.skip, -Drevision, -DskipTests or -DskipITs (got ${badArg}); goals and profiles are this script's.`);
  }
  const tag = `v${version}`;
  const suite = join(repo, "packages", "conformance-suite");
  const programs = join(jvm, "target", "datum-assets", "datum-programs");
  const suiteProgram = {
    cli: join(suite, "dist", "cli.mjs"),
    program: join(programs, "programs", "datum-sandbox-program.js"),
    manifest: join(programs, "manifest.json")
  };
  const mavenRun = (goals) => run(join(jvm, "mvnw"), ["-B", "-ntp", "-Prelease", ...(allowStale ? ["-Ddatum.assets.allowStale=true"] : []), ...goals, ...mavenArgs], { cwd: jvm });

  // 0. The commit. A real release refuses; a dry run says what a real one would refuse and goes on.
  if (!checkOnly) {
    const commitProblems = releaseGuardProblems(tag, version);
    if (commitProblems.length > 0 && !dryRun) {
      fail(`release: not releasing from this tree; nothing built or uploaded:\n  - ${commitProblems.join("\n  - ")}`);
    }
    for (const problem of commitProblems) {
      console.warn(`release: dry run; a real release would refuse: ${problem}`);
    }
  }

  if (!checkOnly) {
    // 1. The assets, fresh. --allow-stale is the escape for a dist that is known to be right (and for a machine
    // where another vite build is running: never two at once).
    if (!allowStale) {
      const built = run("npm", ["run", "datum:build"]);
      if (built.status !== 0) {
        fail("release: the web components build failed; nothing released.");
      }
    }
    const assets = run("npm", ["run", "jvm:assets", ...(allowStale ? ["--", "--allow-stale"] : [])]);
    if (assets.status !== 0) {
      fail("release: the asset build failed; nothing released.");
    }

    // 2. The security suite over the program this release ships, on quickjs-emscripten: the engine of the page the
    // assets serve. The run on the server's engine follows the Maven build (3a), which fetches and compiles that module.
    if (argv.includes("--skip-security-suite")) {
      console.warn("release: --skip-security-suite given; the sandbox program was NOT checked by the security suite.");
    } else {
      if (!existsSync(join(suite, "dist", "cli.mjs"))) {
        const builtSuite = run(process.execPath, [join(suite, "scripts", "build-cli.mjs")], { cwd: suite });
        if (builtSuite.status !== 0) {
          fail("release: the security suite could not be built (npm install in packages/conformance-suite, or --skip-security-suite); nothing released.");
        }
      }
      const checked = run(process.execPath, securitySuiteArgs(suiteProgram));
      if (checked.status !== 0) {
        fail(`release: the security suite did not pass the sandbox program (exit ${checked.status}); nothing released.`);
      }
    }

    // 3. Maven. A real deploy needs the maintainer's GPG key and Central token; refuse early, without reading
    // either, when the settings file does not even name the server. A staged run needs neither.
    if (!dryRun && !stage) {
      const settings = join(process.env.HOME ?? "", ".m2", "settings.xml");
      if (!existsSync(settings) || !/<id>\s*central\s*<\/id>/.test(readFileSync(settings, "utf8"))) {
        fail("release: ~/.m2/settings.xml has no <server> with <id>central</id> (the Central Portal token); use --dry-run to build without publishing.");
      }
    }
    // Build (and, in verify, sign) first; the upload is a separate run after the post-checks.
    const built = mavenRun([`-Drevision=${version}`, ...(dryRun || stage ? ["-Dgpg.skip=true"] : []), "clean", "verify"]);
    if (built.status !== 0) {
      fail(`release: Maven verify failed (exit ${built.status}); nothing uploaded.`);
    }

    // 3b. The security suite again, on the engine the jars run: the qjs-wasi.wasm this build compiled, which the suite refuses
    // unless it has the pom's qjs.sha256, run as the server runs it (a fresh instance per call, the same run script).
    if (!argv.includes("--skip-security-suite")) {
      const pin = readJvmPin(join(jvm, "libs", "datum-sandbox-endive", "pom.xml"));
      const checked = run(process.execPath, securitySuiteArgs({ ...suiteProgram, wasm: qjsWasmFile(mavenArgs), sha256: pin.sha256 }));
      if (checked.status !== 0) {
        // Exit 2 is a usage or configuration error: a module that is not the pinned one, or a tree whose suite predates --qjs-wasm.
        fail(`release: the security suite did not pass the sandbox program on qjs-wasi.wasm (exit ${checked.status}${checked.status === 2 ? ": the module is not the pinned one, or this tree's suite cannot run it" : ""}); nothing uploaded.`);
      }
    }
  }

  // 4. The post-checks.
  const modules = publishedModules();
  const problems = [];
  const artifacts = [];
  for (const module of modules) {
    const result = checkModule(module, version, { signed: !dryRun && !checkOnly && !stage, allowSnapshot: checkOnly && /-SNAPSHOT$/.test(version) });
    problems.push(...result.problems);
    artifacts.push({ artifactId: module.artifactId, path: module.path, packaging: module.packaging, files: result.jars });
  }
  problems.push(...checkTestSupportModules());
  // A bundle left by an earlier -DskipUpload run is checked too; the one this run uploads is checked after the deploy.
  const staged = existingBundles();
  if (staged.length > 0) {
    problems.push(...checkBundles(staged));
  }
  if (problems.length > 0) {
    console.error(`release: the post-checks found ${problems.length} problem${problems.length === 1 ? "" : "s"}; nothing uploaded:`);
    for (const problem of problems) {
      console.error(`  - ${problem}`);
    }
    process.exit(1);
  }
  const allFiles = artifacts.flatMap((artifact) => artifact.files);
  const jarCount = allFiles.filter((file) => file.file.endsWith(".jar")).length;
  console.log(`release: post-checks passed: ${jarCount} jars and ${allFiles.length - jarCount} poms or signatures over ${modules.length} modules, no tests jar.`);

  // 3c. The upload (or, staged, the bundle), only now. No clean: the jars that passed are the jars that go; the sums prove it
  // afterwards.
  let stagedBundle;
  if (!checkOnly && !dryRun) {
    // The build must not have moved the tree or the checkout off the tag since step 0: the jars are of the tagged commit only
    // while that still holds.
    const moved = releaseCommitProblems(tag);
    if (moved.length > 0) {
      fail(`release: the tree changed while it was built, so the jars are not of the tagged commit; nothing uploaded:\n  - ${moved.join("\n  - ")}`);
    }
    // -Ddatum.assets.skip=true: the checked jars were built from the assets of the first run; generating them again would
    // rewrite the resources, repackage the jars and change the sums the checks above were taken over.
    // A staged run deploys with -DskipUpload=true: the plugin assembles the bundle and stops, and nothing is signed.
    const deployStarted = Date.now();
    const stagingFlags = stage ? ["-Dgpg.skip=true", "-DskipUpload=true"] : [];
    const deployed = mavenRun([`-Drevision=${version}`, "-DskipTests", "-DskipITs", "-Ddatum.assets.skip=true", ...stagingFlags, ...(publish ? ["-DautoPublish=true"] : []), "deploy"]);
    if (deployed.status !== 0) {
      fail(stage
        ? `release: staging the bundle failed (exit ${deployed.status}); nothing was uploaded.`
        : `release: Maven deploy failed (exit ${deployed.status}); check the Central portal before running again.`);
    }
    // The signing step ran again in the deploy run: its .asc files are new, so their sums are taken again.
    for (const file of allFiles.filter((entry) => entry.kind === "signature")) {
      file.sha256 = sha256(join(jvm, file.file));
    }
    const changed = allFiles.filter((file) => file.kind !== "signature" && sha256(join(jvm, file.file)) !== file.sha256);
    if (changed.length > 0) {
      fail(`release: files changed during the deploy, so what was uploaded is not what was checked: ${changed.map((file) => file.file).join(", ")}. Look at the Central portal before publishing.`);
    }
    // The bundle that was uploaded: nothing but the published modules. Without -DautoPublish it still waits in the portal,
    // where the maintainer drops it on a finding.
    // Every bundle on disk is checked (a stale one beside it may not hold a tests jar either), and the newest must be one
    // this deploy wrote, so the bundle read is the uploaded one.
    const bundleProblems = checkBundles();
    const uploaded = newestBundle();
    if (uploaded !== undefined && statSync(uploaded).mtimeMs < deployStarted - 1000) {
      bundleProblems.push(`${uploaded} predates the deploy, so no bundle from this run was found`);
    }
    if (bundleProblems.length > 0) {
      fail(stage
        ? `release: the staged bundle is wrong; nothing was uploaded:\n  - ${bundleProblems.join("\n  - ")}`
        : `release: the uploaded bundle is wrong; drop the deployment in the Central portal instead of publishing it:\n  - ${bundleProblems.join("\n  - ")}`);
    }
    stagedBundle = uploaded;
  }

  // --check-only is a read-only look at the jars already built: no dist/ directory, SHA256SUMS or release.json is
  // written, so a trial run cannot leave something that looks like a release behind.
  if (checkOnly) {
    console.log("release: --check-only: nothing written under dist/.");
    return;
  }

  // 5. The directory.
  const properties = Object.fromEntries(
    readFileSync(join(jvm, "target", "datum-assets", "assets.properties"), "utf8").split("\n").filter((line) => line.includes("=")).map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)])
  );
  const assets = {
    source: properties["datum.source"],
    engineVersion: properties["datum.engineVersion"],
    sandboxAbi: properties["datum.sandboxAbi"],
    pdfAbi: properties["datum.pdfAbi"],
    buildId: properties["datum.buildId"]
  };
  const builtAt = new Date().toISOString();
  const distRoot = join(jvm, "dist");
  const out = join(distRoot, `datum-jvm-${version}`);
  const staging = join(distRoot, `.datum-jvm-${version}.new`);
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  const allJars = allFiles;
  writeFileSync(join(staging, "SHA256SUMS"), allJars.map((jar) => `${jar.sha256}  ${jar.file}\n`).join(""));
  // Staged: the bundle the publish job signs travels in this directory, named by its sum.
  const bundle = stage ? { file: "central-bundle.zip", sha256: sha256(stagedBundle) } : undefined;
  if (bundle !== undefined) {
    writeFileSync(join(staging, bundle.file), readFileSync(stagedBundle));
  }
  writeFileSync(join(staging, "release.json"), `${JSON.stringify({
    "//": "Written by integrations/jvm/scripts/release.mjs.",
    version,
    tag,
    groupId: GROUP_ID,
    dryRun,
    staged: stage,
    ...(bundle !== undefined ? { bundle } : {}),
    builtAt,
    source: assets.source,
    engineVersion: assets.engineVersion,
    sandboxAbi: assets.sandboxAbi,
    pdfAbi: assets.pdfAbi,
    assetsBuildId: assets.buildId,
    artifacts
  }, null, 2)}\n`);
  writeFileSync(join(staging, "README.md"), readmeText({ version, tag, builtAt, assets, dryRun, staged: stage }));
  rmSync(out, { recursive: true, force: true });
  renameSync(staging, out);
  console.log(`release: ${relative(repo, out)} written (${allJars.length} files${dryRun ? ", dry run: nothing signed or uploaded" : ""}${stage ? ", staged: nothing signed or uploaded" : ""}).`);
  if (dryRun) {
    return;
  }
  if (stage) {
    console.log(`release: staged ${relative(repo, join(out, bundle.file))} (sha256 ${bundle.sha256}); central-publish.mjs signs and uploads it.`);
    return;
  }
  console.log([
    `release: when the deployment is published in the Central portal (or --publish did it), start the other two hosts by pushing the tag:`,
    `  git push origin ${tag}`,
    `then, once the npm workflow has created the draft Release of ${tag}, attach the Maven checksums to it:`,
    `  cp ${relative(repo, join(out, "SHA256SUMS"))} ${relative(repo, join(distRoot, "SHA256SUMS-maven"))}`,
    `  gh release upload ${tag} ${relative(repo, join(distRoot, "SHA256SUMS-maven"))} --repo argusvane/datum`
  ].join("\n"));
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
