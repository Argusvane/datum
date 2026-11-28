#!/usr/bin/env node
// Signs the Central bundle that `release.mjs --stage` staged and uploads it to the Central Portal: the publish job of the
// Release Maven workflow (.github/workflows/release-maven.yml), the one place the GPG key and the portal token are in reach.
// The build job that staged the bundle held neither; this script builds nothing, so what is signed is what was tested.
//
//   1. the release directory (integrations/jvm/dist/datum-jvm-<v>, as the build job uploaded it): release.json is a staged
//      run of this version, and central-bundle.zip is the file whose SHA-256 it records;
//   2. the bundle's entries: every file is under com/argusvane/<artifactId>/<version>/, nothing is signed yet, and no tests jar
//      or test-support artifact is in it (release.mjs's own bundle check, again);
//   3. Central does not already hold the version (a Central version is permanent; a rerun after a publish stops here);
//   4. every artifact (each jar and pom, not the checksum files) is signed with the key in gpg's keyring
//      (`gpg --armor --detach-sign`, the passphrase from MAVEN_GPG_PASSPHRASE on stdin) and each signature is verified;
//   5. the signed bundle is zipped and uploaded (POST /api/v1/publisher/upload). Without --auto-publish the deployment
//      waits in the portal once validated (USER_MANAGED) and the maintainer publishes it there; with it, Central publishes
//      it once validated (AUTOMATIC). The script waits for VALIDATED, or for PUBLISHED with --auto-publish, and fails on
//      FAILED with Central's errors;
//   6. <out>/SHA256SUMS-maven: the SHA-256 of every jar, pom and signature uploaded, by its path in the repository
//      (https://repo1.maven.org/maven2/<path>), for the GitHub Release.
//
//   node integrations/jvm/scripts/central-publish.mjs --release <dir> --version <x.y.z> --out <dir> [--auto-publish]
//
// Environment: MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD (a portal user token, not the account's login) and
// MAVEN_GPG_PASSPHRASE (empty for a key without one). None of them is printed.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { checkBundleEntries, listEntries } from "./release.mjs";

// CENTRAL_PORTAL_URL points the script at another portal (a test server); the workflow never sets it.
export const CENTRAL = process.env.CENTRAL_PORTAL_URL ?? "https://central.sonatype.com";
const GROUP_PATH = "com/argusvane";

const CHECKSUM = /\.(md5|sha1|sha256|sha512)$/;

/** The entries that need a signature: every file but the checksums (and the signatures, which a staged bundle has none of). */
export const artifactEntries = (entries) => entries.filter((entry) => !entry.endsWith("/") && !CHECKSUM.test(entry) && !entry.endsWith(".asc"));

/** What is wrong with an unsigned bundle of `version`: its layout, a signature already in it, a tests jar or test-support artifact. */
export const bundleProblems = (entries, version) => {
  const files = entries.filter((entry) => !entry.endsWith("/"));
  if (files.length === 0) {
    return ["the bundle is empty"];
  }
  const problems = [];
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const layout = new RegExp(`^${GROUP_PATH}/[^/]+/${escaped}/[^/]+$`);
  for (const entry of files) {
    if (!layout.test(entry)) {
      problems.push(`${entry} is not under ${GROUP_PATH}/<artifactId>/${version}/`);
    } else if (entry.endsWith(".asc")) {
      problems.push(`${entry} is a signature; the staged bundle must be unsigned`);
    }
  }
  if (artifactEntries(files).length === 0) {
    problems.push("the bundle holds no artifact, only checksums");
  }
  return [...problems, ...checkBundleEntries(files)];
};

/** The release.json of a staged run of `version`, and the bundle beside it with the sum it records. */
export const releaseProblems = (release, version, bundleSha256) => {
  const problems = [];
  if (release.version !== version) {
    problems.push(`release.json is of version ${release.version}, not ${version}`);
  }
  if (release.tag !== `v${version}`) {
    problems.push(`release.json names the tag ${release.tag}, not v${version}`);
  }
  if (release.staged !== true || release.dryRun !== false) {
    problems.push("release.json is not of a staged run (release.mjs --stage)");
  }
  if (release.bundle?.sha256 === undefined) {
    problems.push("release.json records no bundle");
  } else if (release.bundle.sha256 !== bundleSha256) {
    problems.push(`the bundle's SHA-256 is ${bundleSha256}, not the ${release.bundle.sha256} release.json records`);
  }
  return problems;
};

/** The portal's bearer token: base64 of "<username>:<password>" of a user token. */
export const authorization = (username, password) => `Bearer ${Buffer.from(`${username}:${password}`).toString("base64")}`;

export const uploadUrl = ({ name, automatic }) =>
  `${CENTRAL}/api/v1/publisher/upload?${new URLSearchParams({ name, publishingType: automatic ? "AUTOMATIC" : "USER_MANAGED" })}`;

/**
 * What a deployment state means for the wait: "done" once it is where the run stops (VALIDATED waiting in the portal, or
 * PUBLISHED when Central publishes it), "failed" on FAILED, otherwise "wait" (PENDING, VALIDATING, and PUBLISHING; VALIDATED too
 * while an automatic deployment goes on to be published).
 */
export const deploymentStep = (state, automatic) => {
  if (state === "FAILED") {
    return "failed";
  }
  if (state === "PUBLISHED" || (!automatic && state === "VALIDATED")) {
    return "done";
  }
  return "wait";
};

/** SHA256SUMS lines (`<sum>  <path>`), sorted by path, for the given files under `root`. */
export const sumsText = (root, files) =>
  [...files].sort().map((file) => `${createHash("sha256").update(readFileSync(join(root, file))).digest("hex")}  ${file}\n`).join("");

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

const run = (command, args, options = {}) => spawnSync(command, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Asks Central for the deployment's state until deploymentStep says "done" or "failed", or `timeoutMs` passes. A state that
 * cannot be read (an HTTP error, a dropped connection, a body that is not JSON or names no state) is reported and asked
 * again: the deployment exists by now, so one bad answer must not end the run while Central goes on with it.
 * Resolves to { step: "done" | "failed" | "timeout", state, body }. `fetchImpl`, `wait` and `now` are injected for the tests.
 */
export const waitForDeployment = async ({
  deploymentId, automatic, auth, timeoutMs = 50 * 60 * 1000, intervalMs = 15000,
  fetchImpl = fetch, wait = sleep, now = Date.now, log = console.log, warn = console.warn
}) => {
  const deadline = now() + timeoutMs;
  let last;
  while (now() < deadline) {
    let body;
    try {
      // The portal's status endpoint is a POST, though it changes nothing.
      const response = await fetchImpl(`${CENTRAL}/api/v1/publisher/status?${new URLSearchParams({ id: deploymentId })}`, { method: "POST", headers: { Authorization: auth } });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      body = await response.json();
      if (typeof body?.deploymentState !== "string") {
        throw new Error("the answer names no deploymentState");
      }
    } catch (error) {
      warn(`central-publish: the status of ${deploymentId} could not be read (${error.message}); asking again.`);
      body = undefined;
    }
    if (body !== undefined) {
      if (body.deploymentState !== last) {
        last = body.deploymentState;
        log(`central-publish: deployment ${deploymentId} is ${last}.`);
      }
      const step = deploymentStep(last, automatic);
      if (step !== "wait") {
        return { step, state: last, body };
      }
    }
    await wait(intervalMs);
  }
  return { step: "timeout", state: last };
};

/** A refusal: thrown by main's fail() and reported without a stack. Thrown, not exited, so every `finally` runs. */
class Refusal extends Error {}

const main = async () => {
  const argv = process.argv.slice(2);
  const option = (name) => {
    const index = argv.indexOf(name);
    return index === -1 || index + 1 >= argv.length ? undefined : argv[index + 1];
  };
  // Throws rather than calling process.exit, which would skip the `finally` that removes the unpacked bundle and its
  // signatures from the temporary directory.
  const fail = (message) => {
    throw new Refusal(message);
  };
  const releaseDir = option("--release");
  const version = option("--version");
  const out = option("--out");
  const automatic = argv.includes("--auto-publish");
  if (releaseDir === undefined || version === undefined || out === undefined) {
    fail("--release <dir>, --version <x.y.z> and --out <dir> are required.");
  }
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    fail(`a release is a plain x.y.z version (got ${version}).`);
  }
  const username = process.env.MAVEN_CENTRAL_USERNAME ?? "";
  const password = process.env.MAVEN_CENTRAL_PASSWORD ?? "";
  if (username === "" || password === "") {
    fail("MAVEN_CENTRAL_USERNAME and MAVEN_CENTRAL_PASSWORD (a Central Portal user token) must be set.");
  }
  const passphrase = process.env.MAVEN_GPG_PASSPHRASE ?? "";
  const auth = authorization(username, password);

  // 1. The release directory.
  const releaseJson = join(releaseDir, "release.json");
  const bundle = join(releaseDir, "central-bundle.zip");
  if (!existsSync(releaseJson) || !existsSync(bundle)) {
    fail(`${releaseDir} holds no release.json and central-bundle.zip; it must be the directory release.mjs --stage wrote.`);
  }
  const release = JSON.parse(readFileSync(releaseJson, "utf8"));
  const refused = releaseProblems(release, version, sha256(bundle));
  if (refused.length > 0) {
    fail(`not uploading:\n  - ${refused.join("\n  - ")}`);
  }

  // 2. The bundle's entries.
  const entries = listEntries(bundle);
  const wrong = bundleProblems(entries, version);
  if (wrong.length > 0) {
    fail(`the bundle is wrong; not uploading:\n  - ${wrong.join("\n  - ")}`);
  }
  const artifacts = artifactEntries(entries);
  // The layout check above holds every entry to com/argusvane/<artifactId>/<version>/<file>, so segment 2 is the artifactId.
  const artifactIds = [...new Set(artifacts.map((entry) => entry.split("/")[2]))].sort();
  console.log(`central-publish: ${artifacts.length} artifacts of ${artifactIds.length} components (${artifactIds.join(", ")}).`);

  // 3. Central must not hold the version already: a published component cannot be replaced, and a second upload of one
  // fails validation after the signing. Every component is asked, so a half-published version is caught too.
  for (const name of artifactIds) {
    const query = new URLSearchParams({ namespace: "com.argusvane", name, version });
    const response = await fetch(`${CENTRAL}/api/v1/publisher/published?${query}`, { headers: { Authorization: auth } });
    if (!response.ok) {
      fail(`could not ask Central whether com.argusvane:${name}:${version} is published (HTTP ${response.status}: ${(await response.text()).slice(0, 300)}).`);
    }
    // The portal answers {"published": true|false}; anything but true is taken as not published.
    if ((await response.json()).published === true) {
      fail(`com.argusvane:${name}:${version} is already on Central; a Central version is permanent, so release a new patch version.`);
    }
  }

  // 4. The signatures.
  const work = mkdtempSync(join(tmpdir(), "central-publish-"));
  try {
    const tree = join(work, "bundle");
    mkdirSync(tree);
    const unzipped = run("unzip", ["-q", bundle, "-d", tree]);
    if (unzipped.status !== 0) {
      fail(`cannot unpack the bundle: ${unzipped.stderr}`);
    }
    const keys = run("gpg", ["--batch", "--list-secret-keys", "--with-colons"]);
    if (keys.status !== 0 || !/^sec:/m.test(keys.stdout)) {
      fail("gpg's keyring holds no secret key; import MAVEN_GPG_PRIVATE_KEY first.");
    }
    for (const entry of artifacts) {
      const file = join(tree, entry);
      // Loopback pinentry: a runner has no pinentry program, so gpg takes the passphrase from fd 0 (stdin) instead. The
      // default secret key signs; the publish job's keyring holds only the imported release key.
      const signed = run("gpg", ["--batch", "--yes", "--pinentry-mode", "loopback", "--passphrase-fd", "0", "--armor", "--detach-sign", "--output", `${file}.asc`, file], { input: passphrase });
      if (signed.status !== 0) {
        fail(`gpg could not sign ${entry}: ${signed.stderr.trim()}`);
      }
      const verified = run("gpg", ["--batch", "--verify", `${file}.asc`, file]);
      if (verified.status !== 0) {
        fail(`the signature of ${entry} does not verify: ${verified.stderr.trim()}`);
      }
    }
    console.log(`central-publish: signed and verified ${artifacts.length} artifacts.`);

    // 5. The upload.
    // Zipped from inside the tree so the entry paths are the repository paths Central expects (com/argusvane/...); -X leaves
    // out the extra file attributes (uid/gid, timestamps), which Central has no use for.
    const signedBundle = join(work, `datum-jvm-${version}-signed.zip`);
    const zipped = run("zip", ["-q", "-r", "-X", signedBundle, "."], { cwd: tree });
    if (zipped.status !== 0) {
      fail(`cannot zip the signed bundle: ${zipped.stderr}`);
    }
    mkdirSync(out, { recursive: true });
    const uploaded = [...artifacts, ...artifacts.map((entry) => `${entry}.asc`)];
    writeFileSync(join(out, "SHA256SUMS-maven"), sumsText(tree, uploaded));

    const form = new FormData();
    form.append("bundle", new Blob([readFileSync(signedBundle)], { type: "application/octet-stream" }), `datum-jvm-${version}.zip`);
    const response = await fetch(uploadUrl({ name: `datum-jvm-${version}`, automatic }), { method: "POST", headers: { Authorization: auth }, body: form });
    const answer = (await response.text()).trim();
    if (!response.ok) {
      fail(`Central refused the upload (HTTP ${response.status}): ${answer.slice(0, 1000)}`);
    }
    // A successful upload answers with the deployment's id as plain text, not JSON.
    const deploymentId = answer;
    console.log(`central-publish: uploaded as deployment ${deploymentId} (${automatic ? "AUTOMATIC: Central publishes it once validated" : "USER_MANAGED: publish it in the portal once validated"}).`);

    // The wait. Validation takes minutes; an automatic publish can take half an hour more. 50 minutes stays inside the publish
    // job's timeout-minutes (75), so the run ends with the message below rather than being cancelled mid-wait.
    const { step, state, body } = await waitForDeployment({ deploymentId, automatic, auth });
    if (step === "failed") {
      fail(`Central failed the deployment:\n${JSON.stringify(body.errors ?? body, null, 2)}`);
    }
    if (step === "timeout") {
      fail(`deployment ${deploymentId} was still ${state ?? "unread"} after 50 minutes; look at it in the portal (${CENTRAL}/publishing/deployments).`);
    }
    console.log(state === "PUBLISHED"
      ? `central-publish: com.argusvane ${version} is published (it reaches repo1.maven.org within the hour).`
      : `central-publish: validated; publish deployment ${deploymentId} in the portal (${CENTRAL}/publishing/deployments) after looking at it, or drop it.`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    // A refusal is the message alone; anything else (a bug, an unreachable portal before the upload) keeps its stack.
    console.error(error instanceof Refusal ? `central-publish: ${error.message}` : error);
    process.exitCode = 1;
  }
}
