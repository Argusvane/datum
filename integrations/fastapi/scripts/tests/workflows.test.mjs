// The two workflows that test the Python host (ci.yml's fastapi job, release-fastapi.yml): the settings schema is written once the
// workspace is synced (argusvane-datum-core's tests read it, and the asset build before the sync skips it), and CI tests every member,
// argusvane-datum-sandbox-wasmtime among them. Run: node --test integrations/fastapi/scripts/tests
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { readMemberNames } from "../test-members.mjs";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
const read = (path) => readFileSync(join(REPO, path), "utf8");

/** The named steps of one job, in order: `{ name, run }` (`run` empty for a `uses` step). */
function stepsOf(workflow, job) {
  const lines = workflow.split("\n");
  const start = lines.findIndex((line) => line === `  ${job}:`);
  assert.notEqual(start, -1, `job ${job}`);
  let end = lines.findIndex((line, index) => index > start && /^ {2}\S/.test(line));
  if (end === -1) end = lines.length;
  const steps = [];
  for (let index = start + 1; index < end; index += 1) {
    const named = /^ {6}- name: (.+)$/.exec(lines[index]);
    if (named) {
      steps.push({ name: named[1].trim(), run: "" });
      continue;
    }
    const step = steps.at(-1);
    const run = /^ {8}run: (.*)$/.exec(lines[index]);
    if (step && run) {
      if (run[1].trim() === "|") {
        const body = [];
        while (index + 1 < end && (/^ {10}/.test(lines[index + 1]) || lines[index + 1].trim() === "")) body.push(lines[++index].trim());
        step.run = body.join("\n").trim();
      } else {
        step.run = run[1].trim();
      }
    }
  }
  return steps;
}

const WORKFLOWS = [
  { path: ".github/workflows/ci.yml", job: "fastapi" },
  { path: ".github/workflows/release-fastapi.yml", job: "build" }
];

for (const { path, job } of WORKFLOWS) {
  test(`${path}: the settings schema is written after the workspace sync and before any member suite`, () => {
    const steps = stepsOf(read(path), job);
    const names = steps.map((step) => step.name);
    const assets = steps.findIndex((step) => step.run.includes("fastapi:assets"));
    const sync = steps.findIndex((step) => /\buv sync\b/.test(step.run));
    const schema = steps.findIndex((step) => step.run === "node integrations/fastapi/scripts/settings-schema.mjs");
    const suites = steps.findIndex((step) => /test-members\.mjs|npm run fastapi:test$/.test(step.run));
    assert.ok(assets !== -1 && sync !== -1 && suites !== -1, names.join(", "));
    assert.ok(schema !== -1, `no step runs settings-schema.mjs: ${names.join(", ")}`);
    assert.ok(schema > sync && schema > assets, `the schema step must follow the sync and the asset build: ${names.join(", ")}`);
    assert.ok(schema < suites, `the schema step must come before the member suites: ${names.join(", ")}`);
  });
}

test("ci.yml: the fastapi job tests every member, argusvane-datum-sandbox-wasmtime among them", () => {
  const steps = stepsOf(read(".github/workflows/ci.yml"), "fastapi");
  const runs = steps.filter((step) => step.run.includes("test-members.mjs"));
  assert.equal(runs.length, 1, steps.map((step) => step.name).join(", "));
  const words = runs[0].run.split(/\s+/);
  const named = words.slice(words.findIndex((word) => word.endsWith("test-members.mjs")) + 1).filter((word) => !word.startsWith("--"));
  const members = readMemberNames();
  assert.ok(members.includes("argusvane-datum-sandbox-wasmtime"));
  // No member named runs them all; a list must name every one.
  if (named.length > 0) {
    for (const member of members) assert.ok(named.includes(member), `${member} is not tested: ${runs[0].run}`);
  }
});

test("release-fastapi.yml: a tag whose commit is not on main is refused before anything is built", () => {
  const steps = stepsOf(read(".github/workflows/release-fastapi.yml"), "build");
  const guard = steps.findIndex((step) => step.run.includes("merge-base --is-ancestor") && step.run.includes("origin/main"));
  assert.notEqual(guard, -1, steps.map((step) => step.name).join(", "));
  assert.equal(guard, 1, "the guard follows the checkout and precedes every other step");
  assert.match(read(".github/workflows/release-fastapi.yml"), /fetch-depth: 0/);
});

test("release-fastapi.yml: the CI check follows the main guard and precedes every build step", () => {
  const steps = stepsOf(read(".github/workflows/release-fastapi.yml"), "build");
  const check = steps.findIndex((step) => step.run.includes("actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA") && step.run.includes('"ci-ok"'));
  assert.equal(check, 2, steps.map((step) => step.name).join(", "));
  assert.match(steps[check].run, /exit 1/);
});

test("release-fastapi.yml: only argusvane/datum publishes, and the Release gets the checksums last", () => {
  const workflow = read(".github/workflows/release-fastapi.yml");
  for (const job of ["testpypi", "pypi", "release-assets"]) {
    const start = workflow.indexOf(`\n  ${job}:\n`);
    assert.notEqual(start, -1, job);
    assert.match(workflow.slice(start, start + 400), /if: github\.repository == 'argusvane\/datum'/, job);
  }
  assert.ok(workflow.indexOf("\n  release-assets:\n") > workflow.indexOf("\n  pypi:\n"));
});

test("release-fastapi.yml: its release-assets job shares the tag's concurrency group with the npm workflow's", () => {
  const group = "group: release-assets-${{ github.ref_name }}";
  for (const file of ["release-fastapi.yml", "release-npm.yml"]) {
    const workflow = read(`.github/workflows/${file}`);
    const start = workflow.indexOf("\n  release-assets:\n");
    assert.notEqual(start, -1, file);
    const job = workflow.slice(start, start + 1400);
    assert.ok(job.includes(group), file);
    assert.match(job, /cancel-in-progress: false/, file);
  }
});

test("release-fastapi.yml: the security suite's program mode runs with --gate release before the distributions are built", () => {
  const steps = stepsOf(read(".github/workflows/release-fastapi.yml"), "build");
  const suite = steps.findIndex((step) => step.run.includes("conformance-suite/dist/cli.mjs") && /--gate release\b/.test(step.run));
  const build = steps.findIndex((step) => step.run.includes("uv build"));
  assert.ok(suite !== -1 && build !== -1, steps.map((step) => step.name).join(", "));
  assert.ok(suite < build, "the suite runs before uv build");
});

test("release-fastapi.yml: the one umbrella tag v<version> triggers it and names the version", () => {
  const workflow = read(".github/workflows/release-fastapi.yml");
  assert.match(workflow, /tags: \["v\*"\]/);
  assert.doesNotMatch(workflow, /tags: \["fastapi-/);
  const stripped = workflow.match(/\$\{TAG#[^}]*\}/g) ?? [];
  assert.ok(stripped.length >= 3, "every use of the tag strips the leading v");
  for (const use of stripped) assert.equal(use, "${TAG#v}");
});

test("ci.yml: the fastapi job runs the import contracts and every member's deptry before the member suites", () => {
  const steps = stepsOf(read(".github/workflows/ci.yml"), "fastapi");
  const contracts = steps.findIndex((step) => /lint-imports/.test(step.run) && /deptry \./.test(step.run));
  const suites = steps.findIndex((step) => step.run.includes("test-members.mjs"));
  assert.ok(contracts !== -1, steps.map((step) => step.name).join(", "));
  assert.ok(contracts < suites, "the boundaries are checked before the suites");
  assert.match(steps[contracts].run, /packages\/\*\//, "deptry runs inside every member");
});
