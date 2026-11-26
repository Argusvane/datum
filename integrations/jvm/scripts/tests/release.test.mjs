// The JVM release script's tag: one umbrella tag v<version>, shared with the other hosts. Run: node --test integrations/jvm/scripts/tests
import assert from "node:assert/strict";
import { utimesSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { changelogProblems, ciProblems, realRunProblems, isDatumRemote, originRemoteProblems, releaseGuardProblems, checkBundles, newestBundle, checkBundleEntries, checkNoTestsJar, checkTestSupportModules, publishedModules, readmeText, releaseCommitProblems } from "../release.mjs";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "release.mjs"), "utf8");

test("release.mjs names the release tag v<version>, not a jvm- family tag", () => {
  assert.match(source, /const tag = `v\$\{version\}`;/);
  assert.doesNotMatch(source, /`jvm-\$\{version\}`/);
});

test("the release README names the tag it was built from and the push that starts the other hosts", () => {
  const text = readmeText({
    version: "1.2.3", tag: "v1.2.3", builtAt: "2026-01-01T00:00:00Z",
    assets: { engineVersion: "1", sandboxAbi: "1", pdfAbi: "1", buildId: "x", source: "abc" }, dryRun: false
  });
  assert.ok(text.includes("git push origin v1.2.3"));
  assert.doesNotMatch(text, /git tag /);
});

test("the release README names no tests jar", () => {
  const text = readmeText({
    version: "1.2.3", tag: "v1.2.3", builtAt: "2026-01-01T00:00:00Z",
    assets: { engineVersion: "1", sandboxAbi: "1", pdfAbi: "1", buildId: "x", source: "abc" }, dryRun: false
  });
  assert.doesNotMatch(text, /tests/i);
});

test("a tests jar in a module's target directory is refused", () => {
  const target = mkdtempSync(join(tmpdir(), "release-target-"));
  try {
    writeFileSync(join(target, "datum-forms-1.0.0.jar"), "");
    assert.deepEqual(checkNoTestsJar(target, "datum-forms"), []);
    writeFileSync(join(target, "datum-forms-1.0.0-tests.jar"), "");
    writeFileSync(join(target, "datum-forms-1.0.0-tests.jar.asc"), "");
    const problems = checkNoTestsJar(target, "datum-forms");
    assert.equal(problems.length, 2);
    assert.match(problems[0], /datum-forms-1\.0\.0-tests\.jar is a tests jar/);
  } finally {
    rmSync(target, { recursive: true, force: true });
  }
  assert.deepEqual(checkNoTestsJar(join(tmpdir(), "release-no-such-target"), "datum-forms"), []);
});

test("a bundle with a tests jar or a test-support artifact is refused", () => {
  const clean = [
    "com/argusvane/datum-forms/1.0.0/datum-forms-1.0.0.jar",
    "com/argusvane/datum-forms/1.0.0/datum-forms-1.0.0-sources.jar.asc",
    "com/argusvane/datum-forms/1.0.0/datum-forms-1.0.0.pom"
  ];
  assert.deepEqual(checkBundleEntries(clean), []);
  const problems = checkBundleEntries([
    ...clean,
    "com/argusvane/datum-forms/1.0.0/datum-forms-1.0.0-tests.jar",
    "com/argusvane/datum-forms/1.0.0/datum-forms-1.0.0-tests.jar.sha1",
    "com/argusvane/datum-forms-test-support/1.0.0/datum-forms-test-support-1.0.0.jar"
  ]);
  assert.equal(problems.length, 3);
  assert.ok(problems.some((problem) => /test-support artifact/.test(problem)));
});

test("the reactor's test-support modules are unpublished, skip the deploy and are excluded from Central", () => {
  assert.deepEqual(checkTestSupportModules(), []);
  const published = publishedModules().map((module) => module.artifactId);
  assert.ok(published.includes("datum-forms"));
  assert.equal(published.filter((artifactId) => artifactId.endsWith("-test-support")).length, 0);
});

test("a test-support module that does not skip the deploy or is not excluded is reported", () => {
  const root = mkdtempSync(join(tmpdir(), "release-root-"));
  try {
    mkdirSync(join(root, "libs", "datum-x-test-support"), { recursive: true });
    writeFileSync(join(root, "pom.xml"), "<project><modules><module>libs/datum-x-test-support</module></modules></project>");
    writeFileSync(join(root, "libs", "datum-x-test-support", "pom.xml"), "<project><parent><artifactId>p</artifactId></parent><artifactId>datum-x-test-support</artifactId></project>");
    const problems = checkTestSupportModules(root);
    assert.equal(problems.length, 2);
    assert.match(problems[0], /maven\.deploy\.skip/);
    assert.match(problems[1], /excludeArtifacts/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("every bundle on disk is checked and the newest one is the uploaded one", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-bundles-"));
  try {
    const make = (name, entries) => {
      const src = join(dir, `${name}-src`);
      mkdirSync(src, { recursive: true });
      for (const entry of entries) {
        writeFileSync(join(src, entry), "x");
      }
      const zip = join(dir, `${name}.zip`);
      const result = spawnSync("zip", ["-q", "-j", zip, ...entries.map((entry) => join(src, entry))]);
      assert.equal(result.status, 0);
      return zip;
    };
    const stale = make("stale", ["datum-forms-1.0.0.jar", "datum-forms-1.0.0-tests.jar"]);
    const fresh = make("fresh", ["datum-forms-1.0.0.jar"]);
    utimesSync(stale, new Date(2020, 0, 1), new Date(2020, 0, 1));
    assert.equal(newestBundle([stale, fresh]), fresh);
    assert.equal(checkBundles([fresh]).length, 0);
    assert.ok(checkBundles([fresh, stale]).length > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- the commit a release is built from ----

const git = (cwd, ...args) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
};

/** A clone with one commit on main pushed to a bare origin: the state a release starts from, before the tag. */
const releaseClone = () => {
  const root = mkdtempSync(join(tmpdir(), "release-git-"));
  const origin = join(root, "origin.git");
  const work = join(root, "work");
  git(root, "init", "--bare", "--initial-branch=main", origin);
  git(root, "clone", origin, work);
  git(work, "checkout", "-b", "main");
  writeFileSync(join(work, "a.txt"), "a");
  git(work, "add", "a.txt");
  git(work, "commit", "-m", "first");
  git(work, "push", "-u", "origin", "main");
  return { root, work };
};

test("a clean tree on origin/main with the tag at HEAD has nothing to refuse", () => {
  const { root, work } = releaseClone();
  try {
    git(work, "tag", "v1.0.0");
    assert.deepEqual(releaseCommitProblems("v1.0.0", work), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing tag is refused, and the message says to create it before the run", () => {
  const { root, work } = releaseClone();
  try {
    const problems = releaseCommitProblems("v1.0.0", work);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /tag v1\.0\.0 does not exist/);
    assert.match(problems[0], /git tag v1\.0\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a tag that points at another commit than HEAD is refused", () => {
  const { root, work } = releaseClone();
  try {
    git(work, "tag", "v1.0.0");
    writeFileSync(join(work, "b.txt"), "b");
    git(work, "add", "b.txt");
    git(work, "commit", "-m", "second");
    git(work, "push", "origin", "main");
    const problems = releaseCommitProblems("v1.0.0", work);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /v1\.0\.0 points at .*, not at HEAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changed and untracked files make the tree unclean", () => {
  const { root, work } = releaseClone();
  try {
    git(work, "tag", "v1.0.0");
    writeFileSync(join(work, "a.txt"), "changed");
    assert.match(releaseCommitProblems("v1.0.0", work).join("\n"), /working tree is not clean \(1 path changed/);
    git(work, "checkout", "--", "a.txt");
    writeFileSync(join(work, "new.txt"), "untracked");
    assert.match(releaseCommitProblems("v1.0.0", work).join("\n"), /working tree is not clean/);
    rmSync(join(work, "new.txt"));
    assert.deepEqual(releaseCommitProblems("v1.0.0", work), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit that is not on origin/main is refused, even when it is tagged", () => {
  const { root, work } = releaseClone();
  try {
    writeFileSync(join(work, "b.txt"), "b");
    git(work, "add", "b.txt");
    git(work, "commit", "-m", "unpushed");
    git(work, "tag", "v1.0.0");
    const problems = releaseCommitProblems("v1.0.0", work);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /is not on origin\/main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a clone with no origin/main is refused; a local main is not a substitute", () => {
  const root = mkdtempSync(join(tmpdir(), "release-git-"));
  try {
    git(root, "init", "--initial-branch=main", ".");
    writeFileSync(join(root, "a.txt"), "a");
    git(root, "add", "a.txt");
    git(root, "commit", "-m", "first");
    git(root, "tag", "v1.0.0");
    const problems = releaseCommitProblems("v1.0.0", root);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /no origin\/main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a commit behind origin/main is on it; one beside it is not", () => {
  const { root, work } = releaseClone();
  try {
    const first = git(work, "rev-parse", "HEAD");
    writeFileSync(join(work, "b.txt"), "b");
    git(work, "add", "b.txt");
    git(work, "commit", "-m", "second");
    git(work, "push", "origin", "main");
    git(work, "checkout", "--detach", first);
    git(work, "tag", "v1.0.0");
    assert.deepEqual(releaseCommitProblems("v1.0.0", work), []);
    writeFileSync(join(work, "c.txt"), "c");
    git(work, "add", "c.txt");
    git(work, "commit", "-m", "squash-merge stand-in: a different sha");
    git(work, "tag", "v1.0.1");
    assert.match(releaseCommitProblems("v1.0.1", work).join("\n"), /is not on origin\/main/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the origin remote must name argusvane/datum, in its https and ssh forms", () => {
  for (const url of [
    "https://github.com/argusvane/datum", "https://github.com/argusvane/datum.git", "https://github.com/argusvane/datum/",
    "https://user@github.com/argusvane/datum.git", "git@github.com:argusvane/datum.git", "git@github.com:argusvane/datum",
    "ssh://git@github.com/argusvane/datum.git"
  ]) {
    assert.ok(isDatumRemote(url), url);
  }
  for (const url of [
    "https://github.com/someone/datum.git", "git@github.com:argusvane/datum-fork.git", "https://github.com/argusvane/datum.git.evil/x",
    "https://evil.example/github.com/argusvane/datum", "https://github.com.evil.example/argusvane/datum", "/tmp/origin.git"
  ]) {
    assert.ok(!isDatumRemote(url), url);
  }
  const { root, work } = releaseClone();
  try {
    assert.match(originRemoteProblems(work).join("\n"), /origin remote is .*origin\.git, not github\.com\/argusvane\/datum/);
    git(work, "remote", "set-url", "origin", "git@github.com:argusvane/datum.git");
    assert.deepEqual(originRemoteProblems(work), []);
    git(work, "remote", "remove", "origin");
    assert.match(originRemoteProblems(work).join("\n"), /no origin remote/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// gh is injected: a function over the argument list, answering as the CLI would.
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ghStub = ({ auth = 0, runs = "11\n12\n", gates = { 11: "failure", 12: "success" }, runsStatus = 0, jobsStatus = 0 } = {}) => (args) => {
  if (args[0] === "auth") {
    assert.deepEqual(args, ["auth", "status", "--active", "--hostname", "github.com"]);
    return { status: auth, stdout: "", stderr: "" };
  }
  const url = args[1];
  if (/\/workflows\/ci\.yml\/runs\?head_sha=/.test(url)) {
    assert.ok(url.includes(`head_sha=${SHA}&status=success`));
    return { status: runsStatus, stdout: runs, stderr: runsStatus === 0 ? "" : "HTTP 404" };
  }
  const id = /\/runs\/(\d+)\/jobs/.exec(url)?.[1];
  if (jobsStatus !== 0) {
    return { status: jobsStatus, stdout: "", stderr: "HTTP 403: API rate limit exceeded" };
  }
  return { status: 0, stdout: `${gates[id] ?? ""}\n`, stderr: "" };
};

test("a jobs lookup that fails says so, rather than that no run passed", () => {
  assert.match(ciProblems(SHA, ghStub({ jobsStatus: 1 })).join("\n"), /jobs of ci\.yml run 11 could not be read: HTTP 403: API rate limit exceeded/);
});

test("a real run takes a plain x.y.z and refuses --allow-stale and --skip-security-suite", () => {
  assert.deepEqual(realRunProblems({ version: "0.1.0" }), []);
  assert.match(realRunProblems({ version: "0.2.0-rc.1" }).join("\n"), /plain x\.y\.z version \(got 0\.2\.0-rc\.1\)/);
  assert.match(realRunProblems({ version: "0.1.0", allowStale: true }).join("\n"), /--allow-stale/);
  assert.match(realRunProblems({ version: "0.1.0", skipSecuritySuite: true }).join("\n"), /--skip-security-suite/);
  const body = source.slice(source.indexOf("const main = () =>"));
  const gate = body.indexOf("realRunProblems({ version, allowStale");
  assert.ok(gate > -1 && body.lastIndexOf("if (!dryRun && !checkOnly) {", gate) > -1 && gate < body.indexOf('run("npm", ["run", "datum:build"])'));
});

test("the deploy re-checks the tree and the tag right before Maven deploys", () => {
  const body = source.slice(source.indexOf("const main = () =>"));
  const upload = body.indexOf("if (!checkOnly && !dryRun) {\n    // The build must not have moved");
  const recheck = body.indexOf("const moved = releaseCommitProblems(tag);");
  const deploy = body.indexOf('"deploy"]);');
  assert.ok(upload > -1 && upload < recheck && recheck < deploy, "the re-check sits inside the upload branch, before the deploy run");
  assert.match(body.slice(recheck, deploy), /if \(moved\.length > 0\) \{\n\s+fail\(/);
});

test("CI on HEAD must have passed ci-ok in some ci.yml run", () => {
  assert.deepEqual(ciProblems(SHA, ghStub()), []);
  assert.match(ciProblems(SHA, ghStub({ gates: { 11: "failure", 12: "skipped" } })).join("\n"), /no ci\.yml run on 0123456789ab concluded success with ci-ok passing/);
  assert.match(ciProblems(SHA, ghStub({ runs: "" })).join("\n"), /no ci\.yml run/);
  assert.match(ciProblems(SHA, ghStub({ runsStatus: 1 })).join("\n"), /could not be read: HTTP 404/);
});

test("a missing or signed-out gh CLI refuses with a message that says what to do", () => {
  const missing = () => ({ status: null, error: Object.assign(new Error("spawn gh ENOENT"), { code: "ENOENT" }), stdout: "", stderr: "" });
  assert.match(ciProblems(SHA, missing).join("\n"), /gh CLI is not installed.*gh auth login/);
  assert.match(ciProblems(SHA, ghStub({ auth: 1 })).join("\n"), /gh CLI is not signed in.*gh auth login/);
});

test("the step-0 guards report every refusal together", () => {
  const { root, work } = releaseClone();
  try {
    const changelog = join(root, "CHANGELOG.md");
    writeFileSync(changelog, "# Changelog\n\n## [Unreleased]\n");
    const sha = git(work, "rev-parse", "HEAD");
    const gh = (args) => ghStub({ auth: 1 })(args);
    const problems = releaseGuardProblems("v1.0.0", "1.0.0", { cwd: work, gh, changelog });
    assert.equal(problems.length, 4, problems.join("\n"));
    assert.match(problems[0], /tag v1\.0\.0 does not exist/);
    assert.match(problems[1], /origin remote is/);
    assert.match(problems[2], /not signed in/);
    assert.match(problems[3], /CHANGELOG\.md has no/);
    git(work, "tag", "v1.0.0");
    git(work, "remote", "set-url", "origin", "https://github.com/argusvane/datum.git");
    writeFileSync(changelog, "# Changelog\n\n## [1.0.0] - 2026-12-01\n");
    const ok = (args) => (args[0] === "auth" ? { status: 0, stdout: "", stderr: "" } : /ci\.yml/.test(args[1]) ? { status: 0, stdout: "7\n", stderr: "" } : { status: 0, stdout: "success\n", stderr: "" });
    assert.deepEqual(releaseGuardProblems("v1.0.0", "1.0.0", { cwd: work, gh: ok, changelog }), [], sha);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the changelog must hold the version's section", () => {
  const dir = mkdtempSync(join(tmpdir(), "release-changelog-"));
  try {
    const file = join(dir, "CHANGELOG.md");
    writeFileSync(file, "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-12-01\n\n- x\n");
    assert.deepEqual(changelogProblems("0.1.0", file), []);
    assert.equal(changelogProblems("0.1.1", file).length, 1);
    assert.equal(changelogProblems("0.1", file).length, 1);
    assert.equal(changelogProblems("0.1.0", join(dir, "missing.md")).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a real run checks the commit before it builds anything, and a dry run only warns", () => {
  const body = source.slice(source.indexOf("const main = () =>"));
  const guard = body.indexOf("releaseGuardProblems(tag, version)");
  assert.ok(guard > -1 && guard < body.indexOf('run("npm", ["run", "datum:build"])'));
  assert.match(body, /commitProblems\.length > 0 && !dryRun/);
  assert.match(body, /if \(!checkOnly\) \{\n    const commitProblems/);
  // --check-only builds nothing for Central, so it reaches neither git nor gh.
  assert.ok(body.lastIndexOf("if (!checkOnly) {\n    const commitProblems", guard) > -1);
});
