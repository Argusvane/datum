import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

import { parseArgs } from "../src/args.js";
import { runCli } from "../src/cli.js";
import { VECTORS } from "../src/vectors/index.js";
import { builtProgramText } from "./helpers/programs.js";
import { REPO_ROOT } from "./helpers/paths.js";

const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8");

/** Splits a shell line the way the docs write it: spaces, and double quotes around a value. */
function words(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((match) => match[1] ?? match[2] ?? "");
}

function commandsIn(markdown: string): string[][] {
  const out: string[][] = [];
  for (const block of markdown.matchAll(/```sh\n([\s\S]*?)```/g)) {
    for (const line of block[1]!.split("\n")) {
      if (line.startsWith("datum-security-check ")) out.push(words(line).slice(1));
    }
  }
  return out;
}

describe("docs/conformance-suite.md", () => {
  const doc = read("docs/conformance-suite.md");
  const commands = commandsIn(doc);
  const work = mkdtempSync(join(tmpdir(), "datum-security-suite-docs-"));
  let program = "";

  beforeAll(() => {
    program = join(work, "program.js");
    writeFileSync(program, builtProgramText());
  });

  it("shows command examples, and every one parses with the real argument parser", () => {
    expect(commands.length).toBeGreaterThanOrEqual(6);
    for (const argv of commands) {
      expect(() => parseArgs(argv), argv.join(" ")).not.toThrow();
    }
  });

  it("runs the examples that need no server (program, parity, list, fixture) and they behave as documented", async () => {
    const offline = commands.filter((argv) => !argv.includes("--endpoint"));
    expect(offline.length).toBeGreaterThanOrEqual(5);
    for (const argv of offline) {
      const args = argv.map((word, index) => {
        const previous = argv[index - 1];
        if (previous === "--program") return program;
        if (previous === "--out") return join(work, `out-${index}`);
        return word;
      });
      // The manifest in the docs belongs to the repository's own asset; a program built from source is not that asset.
      const manifestAt = args.indexOf("--manifest");
      if (manifestAt !== -1) args.splice(manifestAt, 2);
      // One cheap vector per example: this checks that the example works, not the whole suite (the other tests do).
      const runsVectors = args.includes("--program");
      if (runsVectors) args.push("--only", args.includes("--parity") || args.includes("--all") ? "CTL-01,PAR-04" : "CTL-01,ABI-01");
      let out = "";
      let err = "";
      const code = await runCli(args, { stdout: (text) => void (out += text), stderr: (text) => void (err += text) });
      expect(code, `${argv.join(" ")}\n${err}`).toBe(0);
      if (argv[0] === "fixture") expect(out.length).toBeGreaterThan(100);
    }
  }, 180_000);

  it("names the exit codes, statuses and host contract the code uses", () => {
    for (const word of ["PASS", "FAIL", "WARN", "SKIP", "XFAIL", "XPASS", "ERROR", "INCONCLUSIVE"]) expect(doc).toContain(word);
    for (const rule of ["Run `check` before persisting", "Serve only `public`", "Refuse on any problem", "Never 500"]) expect(doc).toContain(rule);
    expect(doc).toContain("ADR 0151");
  });

  it("explains every vector class and prefix in the catalogue", () => {
    const prefixes = new Set(VECTORS.map((vector) => vector.id.slice(0, 3)));
    for (const prefix of prefixes) expect(doc, `class prefix ${prefix}`).toMatch(new RegExp(`\\| ${prefix} \\|`));
  });

  it("is listed in docs/README.md and in an accepted ADR that exists", () => {
    expect(read("docs/README.md")).toContain("(conformance-suite.md)");
    const adr = read("docs/adr/0151-a-security-suite-for-the-validation-gate.md");
    expect(adr).toContain("# ADR 0151");
  });

  it("uses root scripts that exist", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    for (const name of ["conformance-suite:build", "conformance-suite:typecheck", "conformance-suite:test", "conformance-suite:check"]) {
      expect(scripts[name], name).toBeTypeOf("string");
      expect(doc).toContain(name);
    }
    expect(scripts["ci"]).toContain("npm run submissions:test && npm run conformance-suite:typecheck && npm run conformance-suite:test");
  });
});

describe(".github/workflows/ci.yml", () => {
  const text = read(".github/workflows/ci.yml");
  const workflow = parseYaml(text) as { jobs: Record<string, { steps: Array<Record<string, unknown>>; "runs-on": string; needs?: unknown }> };

  it("is valid YAML whose jobs each have a runner and named steps", () => {
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job["runs-on"], name).toBeTruthy();
      for (const step of job.steps) expect(step["uses"] ?? step["run"], `${name}: ${String(step["name"])}`).toBeTruthy();
    }
  });

  it("has the conformance-suite job, and its working directories exist", () => {
    const main = workflow.jobs["conformance-suite"]!;
    const runs = main.steps.map((step) => String(step["run"] ?? ""));
    expect(runs.some((run) => run.includes("npm run typecheck"))).toBe(true);
    expect(runs.some((run) => run.includes("npm test"))).toBe(true);
    expect(runs.some((run) => run.includes("check:source"))).toBe(true);
    for (const step of main.steps) {
      const dir = step["working-directory"];
      if (typeof dir === "string") expect(() => readFileSync(join(REPO_ROOT, dir, "package.json")), dir).not.toThrow();
    }
  });

  it("ends with ci-ok, which runs whatever happened and waits for every other job", () => {
    const gate = workflow.jobs["ci-ok"] as { needs?: unknown; if?: string } | undefined;
    expect(gate).toBeDefined();
    expect(gate!.if).toBe("always()");
    const others = Object.keys(workflow.jobs).filter((name) => name !== "ci-ok").sort();
    expect([...(gate!.needs as string[])].sort()).toEqual(others);
  });

  it("runs the tree-wide guards on every push: the secret scan and the process-references guard wait on nothing", () => {
    for (const name of ["secret-scan", "process-references"]) {
      expect(workflow.jobs[name], name).toBeDefined();
      expect(workflow.jobs[name]!.needs, name).toBeUndefined();
    }
  });
});

describe(".github/workflows/jvm.yml", () => {
  it("starts only by hand, and ci.yml holds no JVM job", () => {
    const jvm = parseYaml(read(".github/workflows/jvm.yml")) as { on: Record<string, unknown>; jobs: Record<string, unknown> };
    expect(Object.keys(jvm.on)).toEqual(["workflow_dispatch"]);
    expect(Object.keys(jvm.jobs).sort()).toEqual(["jvm", "jvm-runtime"]);
    const ci = parseYaml(read(".github/workflows/ci.yml")) as { jobs: Record<string, unknown> };
    expect(Object.keys(ci.jobs).filter((name) => name.startsWith("jvm"))).toEqual([]);
  });
});

type Job = { concurrency?: { group?: string; "cancel-in-progress"?: boolean }; if?: string; needs?: unknown; permissions?: Record<string, string>; steps?: Array<Record<string, unknown>>; "timeout-minutes"?: number };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const workflowFile = (file: string): Workflow => parseYaml(read(`.github/workflows/${file}`)) as Workflow;
const runsOf = (job: Job): string => (job.steps ?? []).map((step) => String(step["run"] ?? "")).join("\n");

describe("the workflows' limits", () => {
  it("give every job a timeout-minutes", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
      for (const [name, job] of Object.entries(workflowFile(file).jobs)) {
        expect(job["timeout-minutes"], `${file}: ${name}`).toBeGreaterThan(0);
      }
    }
  });
});

describe(".github/workflows/pages.yml", () => {
  it("starts only by hand, so a push never deploys the site", () => {
    expect(Object.keys(workflowFile("pages.yml").on)).toEqual(["workflow_dispatch"]);
  });
});

describe("the release workflows", () => {
  const publishing: Array<[string, string[]]> = [
    ["release-npm.yml", ["publish", "release-assets"]],
    ["release-fastapi.yml", ["testpypi", "pypi", "release-assets"]]
  ];

  it("publish only from the canonical repository", () => {
    for (const [file, jobs] of publishing) {
      const workflow = workflowFile(file);
      for (const name of jobs) {
        expect(workflow.jobs[name], `${file}: ${name}`).toBeDefined();
        expect(workflow.jobs[name]!.if, `${file}: ${name}`).toContain("github.repository == 'argusvane/datum'");
      }
      // The jobs that run before a publish job stay open to every repository: the build is the dry run.
      expect(workflow.jobs["build"]!.if, file).toBeUndefined();
    }
  });

  it("refuse a tagged commit without a green ci.yml run, holding actions: read in the build job only", () => {
    for (const [file] of publishing) {
      const workflow = workflowFile(file);
      const build = workflow.jobs["build"]!;
      const check = runsOf(build);
      expect(check, file).toContain("actions/workflows/ci.yml/runs?head_sha=$GITHUB_SHA");
      expect(check, file).toContain('select(.name == "ci-ok")');
      expect(build.permissions, file).toEqual({ contents: "read", actions: "read" });
      for (const [name, job] of Object.entries(workflow.jobs)) {
        if (name !== "build") expect(job.permissions?.["actions"], `${file}: ${name}`).toBeUndefined();
      }
    }
  });

  it("do not claim that a missing environment stops a tag, nor that the other releases add notes", () => {
    for (const file of ["release-npm.yml", "release-fastapi.yml"]) {
      const text = read(`.github/workflows/${file}`);
      expect(text, file).not.toMatch(/stops at the (first )?publish job/);
      expect(text, file).not.toMatch(/add their notes/);
      expect(text, file).toMatch(/with no protection rules/);
    }
  });

  it("attach the checksums of what they publish to the draft Release", () => {
    expect(runsOf(workflowFile("release-npm.yml").jobs["release-assets"]!)).toContain("assets/SHA256SUMS-npm");
    const fastapi = workflowFile("release-fastapi.yml").jobs["release-assets"]!;
    expect(runsOf(fastapi)).toContain("SHA256SUMS-pypi");
    expect(fastapi.permissions).toEqual({ contents: "write" });
    expect(fastapi.needs).toBe("pypi");
  });

  it("run the two release-assets jobs of a tag one after the other, in one group that is never cancelled", () => {
    const npm = workflowFile("release-npm.yml").jobs["release-assets"]!;
    const fastapi = workflowFile("release-fastapi.yml").jobs["release-assets"]!;
    expect(npm.concurrency).toEqual({ group: "release-assets-${{ github.ref_name }}", "cancel-in-progress": false });
    expect(fastapi.concurrency).toEqual(npm.concurrency);
    // A create that loses a race is no longer tolerated: the group makes it impossible.
    expect(runsOf(npm)).not.toMatch(/gh release create[^\n]*\\\n\s*\|\|/);
    expect(runsOf(fastapi)).not.toMatch(/gh release create[^\n]*\\\n\s*\|\|/);
  });
});

describe("the pinned downloads", () => {
  it("fetches a fixed veraPDF release in ci.yml, checks its sha256 and fails the job when that does not work", () => {
    const job = workflowFile("ci.yml").jobs["pdf-kernel"]!;
    const step = (job.steps ?? []).find((candidate) => candidate["name"] === "Install veraPDF")!;
    expect(step).toBeDefined();
    expect(step["continue-on-error"]).toBeUndefined();
    const env = step["env"] as Record<string, string>;
    expect(env["VERAPDF_VERSION"]).toMatch(/^\d+\.\d+\.\d+$/);
    expect(env["VERAPDF_SHA256"]).toMatch(/^[0-9a-f]{64}$/);
    const run = String(step["run"]);
    expect(run).toContain("set -euo pipefail");
    expect(run).toContain("curl --fail");
    expect(run).toContain("sha256sum --check");
    expect(run).not.toContain("verapdf-installer.zip https://software.verapdf.org/rel/");
  });

  it("names the Maven distribution's sha256 in the wrapper properties", () => {
    const properties = read("integrations/jvm/.mvn/wrapper/maven-wrapper.properties");
    expect(properties).toMatch(/^distributionUrl=.*apache-maven-[\d.]+-bin\.zip$/m);
    expect(properties).toMatch(/^distributionSha256Sum=[0-9a-f]{64}$/m);
  });
});

describe("the workflows' runners", () => {
  it("name a pinned image, never a moving -latest label", () => {
    const dir = join(REPO_ROOT, ".github/workflows");
    for (const file of readdirSync(dir).filter((name) => name.endsWith(".yml"))) {
      const workflow = parseYaml(read(`.github/workflows/${file}`)) as { jobs: Record<string, { "runs-on"?: unknown }> };
      for (const [name, job] of Object.entries(workflow.jobs)) {
        expect(String(job["runs-on"]), `${file}: ${name}`).not.toMatch(/-latest\b/);
      }
    }
  });
});
