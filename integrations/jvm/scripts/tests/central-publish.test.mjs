// The publish job's signing and upload script: what it signs, what it refuses, and when it stops waiting.
// Run: node --test integrations/jvm/scripts/tests
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactEntries, authorization, bundleProblems, deploymentStep, releaseProblems, sumsText, uploadUrl, waitForDeployment
} from "../central-publish.mjs";

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "central-publish.mjs");

const V = "1.2.3";
const dir = `com/argusvane/datum-core/${V}`;
const bundle = [
  "com/", "com/argusvane/", `${dir}/`,
  `${dir}/datum-core-${V}.jar`, `${dir}/datum-core-${V}.jar.md5`, `${dir}/datum-core-${V}.jar.sha1`,
  `${dir}/datum-core-${V}.jar.sha256`, `${dir}/datum-core-${V}.jar.sha512`,
  `${dir}/datum-core-${V}.pom`, `${dir}/datum-core-${V}.pom.sha1`,
  `${dir}/datum-core-${V}-sources.jar`, `${dir}/datum-core-${V}-javadoc.jar`
];

test("every jar and pom is signed, and no checksum file or directory", () => {
  assert.deepEqual(artifactEntries(bundle), [
    `${dir}/datum-core-${V}.jar`, `${dir}/datum-core-${V}.pom`, `${dir}/datum-core-${V}-sources.jar`, `${dir}/datum-core-${V}-javadoc.jar`
  ]);
});

test("a staged bundle of the version passes", () => {
  assert.deepEqual(bundleProblems(bundle, V), []);
});

test("a bundle of another version, another group, or already signed is refused", () => {
  assert.match(bundleProblems([`com/argusvane/datum-core/1.2.4/datum-core-1.2.4.jar`], V).join("\n"), /not under com\/argusvane\/<artifactId>\/1\.2\.3\//);
  assert.match(bundleProblems([`org/example/x/${V}/x-${V}.jar`], V).join("\n"), /not under/);
  assert.match(bundleProblems([...bundle, `${dir}/datum-core-${V}.jar.asc`], V).join("\n"), /is a signature; the staged bundle must be unsigned/);
  assert.match(bundleProblems([`${dir}/datum-core-${V}.jar.sha1`], V).join("\n"), /no artifact, only checksums/);
  assert.match(bundleProblems([], V).join("\n"), /empty/);
});

test("a tests jar or a test-support artifact in the bundle is refused", () => {
  assert.match(bundleProblems([...bundle, `${dir}/datum-core-${V}-tests.jar`], V).join("\n"), /tests jar/);
  const support = `com/argusvane/datum-core-test-support/${V}/datum-core-test-support-${V}.jar`;
  assert.match(bundleProblems([...bundle, support], V).join("\n"), /test-support artifact/);
});

test("release.json must be a staged run of the version whose bundle sum matches", () => {
  const release = { version: V, tag: `v${V}`, staged: true, dryRun: false, bundle: { file: "central-bundle.zip", sha256: "ab" } };
  assert.deepEqual(releaseProblems(release, V, "ab"), []);
  assert.match(releaseProblems(release, V, "cd").join("\n"), /SHA-256 is cd, not the ab/);
  assert.match(releaseProblems({ ...release, version: "1.2.4" }, V, "ab").join("\n"), /version 1\.2\.4/);
  assert.match(releaseProblems({ ...release, tag: "v1.2.4" }, V, "ab").join("\n"), /tag v1\.2\.4/);
  assert.match(releaseProblems({ ...release, staged: false }, V, "ab").join("\n"), /not of a staged run/);
  assert.match(releaseProblems({ ...release, dryRun: true }, V, "ab").join("\n"), /not of a staged run/);
  assert.match(releaseProblems({ ...release, bundle: undefined }, V, "ab").join("\n"), /records no bundle/);
});

test("the portal token is a bearer of base64 user:password", () => {
  assert.equal(authorization("user", "pass"), `Bearer ${Buffer.from("user:pass").toString("base64")}`);
});

test("the upload waits in the portal unless it is automatic", () => {
  assert.match(uploadUrl({ name: "datum-jvm-1.2.3", automatic: false }), /\/api\/v1\/publisher\/upload\?name=datum-jvm-1\.2\.3&publishingType=USER_MANAGED$/);
  assert.match(uploadUrl({ name: "datum-jvm-1.2.3", automatic: true }), /publishingType=AUTOMATIC$/);
});

test("the wait ends at VALIDATED for the portal, at PUBLISHED when automatic, and fails on FAILED", () => {
  for (const state of ["PENDING", "VALIDATING"]) {
    assert.equal(deploymentStep(state, false), "wait");
    assert.equal(deploymentStep(state, true), "wait");
  }
  assert.equal(deploymentStep("VALIDATED", false), "done");
  assert.equal(deploymentStep("VALIDATED", true), "wait");
  assert.equal(deploymentStep("PUBLISHING", true), "wait");
  assert.equal(deploymentStep("PUBLISHED", true), "done");
  assert.equal(deploymentStep("FAILED", false), "failed");
  assert.equal(deploymentStep("FAILED", true), "failed");
});

test("the checksum list names each file by its repository path, sorted", () => {
  const root = mkdtempSync(join(tmpdir(), "central-sums-"));
  try {
    mkdirSync(join(root, dir), { recursive: true });
    writeFileSync(join(root, dir, "b.jar"), "b");
    writeFileSync(join(root, dir, "a.pom"), "a");
    const text = sumsText(root, [`${dir}/b.jar`, `${dir}/a.pom`]);
    assert.equal(text, [
      `ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb  ${dir}/a.pom`,
      `3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d  ${dir}/b.jar`,
      ""
    ].join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// A scripted portal for waitForDeployment: each call takes the next answer; an Error is thrown as fetch would on a dropped
// connection, a number is that HTTP status, anything else is the JSON body of a 200. The clock moves a minute per wait.
const scripted = (answers) => {
  let clock = 0;
  const calls = [];
  return {
    calls,
    options: {
      deploymentId: "dep-1", auth: "Bearer x", timeoutMs: 10 * 60 * 1000, intervalMs: 60 * 1000,
      wait: async (ms) => { clock += ms; }, now: () => clock, log: () => {}, warn: (line) => calls.push(line),
      fetchImpl: async () => {
        const answer = answers.shift();
        if (answer instanceof Error) {
          throw answer;
        }
        if (typeof answer === "number") {
          return { ok: false, status: answer, json: async () => ({}) };
        }
        return { ok: true, status: 200, json: async () => (typeof answer === "function" ? answer() : answer) };
      }
    }
  };
};

test("the wait asks again after a dropped connection, an HTTP error or an unreadable answer", async () => {
  const portal = scripted([
    new TypeError("fetch failed"),
    502,
    () => { throw new SyntaxError("Unexpected token < in JSON"); },
    { unexpected: true },
    { deploymentState: "VALIDATING" },
    { deploymentState: "VALIDATED" }
  ]);
  const result = await waitForDeployment({ ...portal.options, automatic: false });
  assert.equal(result.step, "done");
  assert.equal(result.state, "VALIDATED");
  assert.equal(portal.calls.length, 4);
  assert.match(portal.calls[0], /dep-1 could not be read \(fetch failed\); asking again/);
  assert.match(portal.calls[1], /HTTP 502/);
  assert.match(portal.calls[2], /Unexpected token/);
  assert.match(portal.calls[3], /names no deploymentState/);
});

test("the wait returns FAILED with Central's answer, and times out with the last state read", async () => {
  const failed = await waitForDeployment({ ...scripted([{ deploymentState: "FAILED", errors: { x: ["bad"] } }]).options, automatic: true });
  assert.deepEqual(failed, { step: "failed", state: "FAILED", body: { deploymentState: "FAILED", errors: { x: ["bad"] } } });
  const stuck = scripted([{ deploymentState: "VALIDATING" }, ...Array(20).fill(new TypeError("fetch failed"))]);
  assert.deepEqual(await waitForDeployment({ ...stuck.options, automatic: false }), { step: "timeout", state: "VALIDATING" });
  assert.deepEqual(await waitForDeployment({ ...scripted(Array(20).fill(503)).options, automatic: false }), { step: "timeout", state: undefined });
});

test("a refusal after the bundle is unpacked still removes the temporary directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "central-cleanup-"));
  // A portal that holds nothing, so the run gets past step 3 and is refused at the keyring check of step 4.
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ published: false }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const tree = join(root, "tree");
    mkdirSync(join(tree, dir), { recursive: true });
    writeFileSync(join(tree, dir, `datum-core-${V}.jar`), "jar");
    writeFileSync(join(tree, dir, `datum-core-${V}.pom`), "<project/>");
    const release = join(root, "release");
    mkdirSync(release);
    const zipped = spawnSync("zip", ["-q", "-r", join(release, "central-bundle.zip"), "com"], { cwd: tree });
    assert.equal(zipped.status, 0, "zip is installed");
    const bundleSha256 = createHash("sha256").update(readFileSync(join(release, "central-bundle.zip"))).digest("hex");
    writeFileSync(join(release, "release.json"), JSON.stringify({ version: V, tag: `v${V}`, staged: true, dryRun: false, bundle: { file: "central-bundle.zip", sha256: bundleSha256 } }));
    const temp = join(root, "tmp");
    const gnupg = join(root, "gnupg");
    mkdirSync(temp);
    mkdirSync(gnupg, { mode: 0o700 });

    const child = spawn(process.execPath, [script, "--release", release, "--version", V, "--out", join(root, "out")], {
      env: {
        ...process.env, TMPDIR: temp, GNUPGHOME: gnupg,
        CENTRAL_PORTAL_URL: `http://127.0.0.1:${server.address().port}`,
        MAVEN_CENTRAL_USERNAME: "user", MAVEN_CENTRAL_PASSWORD: "pass", MAVEN_GPG_PASSPHRASE: ""
      }
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve) => child.on("close", resolve));

    assert.equal(code, 1);
    assert.match(stderr, /central-publish: gpg's keyring holds no secret key/);
    assert.doesNotMatch(stderr, /\n\s+at /, "a refusal is reported without a stack");
    assert.deepEqual(readdirSync(temp).filter((name) => name.startsWith("central-publish-")), [], "the work directory is removed");
  } finally {
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
});
