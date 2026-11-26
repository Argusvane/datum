import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The helper is exercised the way a user meets it: a child vitest runs
// the three files of `vitest-helper-project/` and this test reads its JSON report. Nothing here
// calls `formTests` directly, so a registration that works only inside the engine's own process
// would not pass.

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL("..", import.meta.url));
const projectDir = join(packageDir, "tests", "vitest-helper-project");

interface Assertion {
  title: string;
  fullName: string;
  status: string;
  failureMessages: string[];
}
interface FileResult {
  name: string;
  status: string;
  message?: string;
  assertionResults: Assertion[];
}

let files: FileResult[] = [];
let exitCode: number | null = null;
let scratch = "";

function fileOf(name: string): FileResult {
  const found = files.find((file) => file.name.endsWith(`/${name}`));
  if (found === undefined) throw new Error(`The child run has no result for ${name}: ${files.map((file) => file.name).join(", ")}`);
  return found;
}

function testOf(file: FileResult, title: string): Assertion {
  const found = file.assertionResults.find((assertion) => assertion.title === title);
  if (found === undefined) throw new Error(`No test "${title}" in ${file.name}: ${file.assertionResults.map((a) => a.title).join(" | ")}`);
  return found;
}

describe("the vitest helper", () => {
  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), "form-test-helper-"));
    const outputFile = join(scratch, "report.json");
    // The parent is itself a vitest worker; its VITEST* variables would tell the child it is
    // nested. `CI` and everything else pass through.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "TEST"));
    try {
      await run("npx", ["vitest", "run", "--root", projectDir, "--config", join(projectDir, "vitest.config.ts"), "--reporter=json", `--outputFile=${outputFile}`], {
        cwd: packageDir,
        env,
        maxBuffer: 32 * 1024 * 1024
      });
      exitCode = 0;
    } catch (failure) {
      // A failing project is the point: the exit code is 1, the report still lands.
      exitCode = (failure as { code?: number }).code ?? null;
    }
    files = (JSON.parse(readFileSync(outputFile, "utf8")) as { testResults: FileResult[] }).testResults;
  }, 240_000);

  afterAll(() => {
    if (scratch !== "") rmSync(scratch, { recursive: true, force: true });
  });

  it("exits non-zero because the failing project fails", () => {
    expect(exitCode).toBe(1);
  });

  it("registers one test per scenario, named by the scenario, in a describe named by the project", () => {
    const passing = fileOf("form.check.ts");
    expect(passing.assertionResults.map((assertion) => assertion.title)).toEqual([
      "the name is required",
      "the age has a floor",
      "the nickname follows the box",
      "a scenario kept for later",
      "the sidecar scenario"
    ]);
    for (const assertion of passing.assertionResults) {
      expect(assertion.fullName.startsWith("helper project: passing ")).toBe(true);
    }
  });

  it("passes the passing project's scenarios", () => {
    const passing = fileOf("form.check.ts");
    expect(passing.assertionResults.filter((assertion) => assertion.status === "passed").map((assertion) => assertion.title)).toEqual([
      "the name is required",
      "the age has a floor",
      "the nickname follows the box",
      "the sidecar scenario"
    ]);
    for (const assertion of passing.assertionResults.filter((a) => a.status === "failed")) {
      throw new Error(assertion.failureMessages.join("\n"));
    }
  });

  it("reports a skipped scenario as skipped, not passed", () => {
    const skipped = testOf(fileOf("form.check.ts"), "a scenario kept for later");
    expect(["pending", "skipped"]).toContain(skipped.status);
  });

  it("fails the deliberate failure with the step's message in the error", () => {
    const failing = fileOf("failing.check.ts");
    const failed = testOf(failing, "a deliberate failure: the name is not optional");
    expect(failed.status).toBe("failed");
    const message = failed.failureMessages.join("\n");
    // The step is on line 2 of its file; the message names the line and what was found.
    expect(message).toContain("line 2");
    expect(message).toContain("to be optional");
    // The same file's other scenarios still pass: one failure does not take the form down.
    expect(testOf(failing, "the name is required").status).toBe("passed");
  });

  it("reports a source that does not parse as its own failing test", () => {
    const parses = testOf(fileOf("failing.check.ts"), "sources[0] parses");
    expect(parses.status).toBe("failed");
    expect(parses.failureMessages.join("\n")).toContain("line 1");
  });

  it("runs none of the scenarios of a source with problems, as the command does", () => {
    const failing = fileOf("failing.check.ts");
    expect(testOf(failing, "sources[1] parses").status).toBe("failed");
    expect(failing.assertionResults.map((assertion) => assertion.title)).not.toContain("half read");
  });

  it("fails 'every rule is tested' with the untested rule's sentence, and passes the scenario", () => {
    const coverage = fileOf("coverage.check.ts");
    expect(testOf(coverage, "the nickname follows the box").status).toBe("passed");
    const test = testOf(coverage, "every rule is tested");
    expect(test.status).toBe("failed");
    const message = test.failureMessages.join("\n");
    expect(message).toContain("1 rule is not tested");
    expect(message).toMatch(/phone/i);
    // The tested rule is not listed.
    expect(message).not.toMatch(/nickname/i);
  });

  it("registers the coverage test after the scenarios, so it reads their results", () => {
    const titles = fileOf("coverage.check.ts").assertionResults.map((assertion) => assertion.title);
    expect(titles[titles.length - 1]).toBe("every rule is tested");
  });

  it("passes a form that calls today(), with no signatures given and with a plugin function", () => {
    const clock = fileOf("clock.check.ts");
    // clock.json holds one scenario, registered by each of the file's two calls.
    expect(clock.assertionResults).toHaveLength(2);
    for (const assertion of clock.assertionResults) {
      expect(assertion.status, `${assertion.fullName}: ${assertion.failureMessages.join("\n")}`).toBe("passed");
    }
    expect(clock.assertionResults.map((assertion) => assertion.fullName).filter((name) => name.includes("with a plugin function")).length).toBeGreaterThan(0);
  });

  it("passes 'every rule is tested' when the file runs its tests concurrently", () => {
    const concurrent = fileOf("concurrent.check.ts");
    expect(testOf(concurrent, "every rule is tested").status).toBe("passed");
    for (const assertion of concurrent.assertionResults) {
      expect(["passed", "pending", "skipped"], `${assertion.fullName}: ${assertion.failureMessages.join("\n")}`).toContain(assertion.status);
    }
  });

  it("fails a name repeated across sources as the command does, and still runs both scenarios", () => {
    const repeats = fileOf("repeats.check.ts");
    const parses = testOf(repeats, "sources[1] parses");
    expect(parses.status).toBe("failed");
    expect(parses.failureMessages.join("\n")).toContain("twice");
    expect(repeats.assertionResults.filter((assertion) => assertion.title === "twice")).toHaveLength(2);
    expect(repeats.assertionResults.filter((assertion) => assertion.title === "sources[0] parses")).toHaveLength(0);
  });

  // A program that is not a validation program is refused when the host binds (the ABI probe), and
  // every scenario of the file fails with that reason; vitest must not show them as skipped.
  it("fails every scenario with why when the program is not a validation program", () => {
    const file = fileOf("program.check.ts");
    expect(file.assertionResults.length).toBeGreaterThan(0);
    for (const assertion of file.assertionResults) {
      expect(assertion.status, assertion.fullName).toBe("failed");
      expect(assertion.failureMessages.join("\n"), assertion.fullName).toMatch(/noop-program\.js is not a validation program/);
    }
  });

  // A kernel that errors on a step is still a failed scenario with its reason (the bind probe
  // answers, the program has no entry point).
  it("fails a scenario with the kernel's step error when the sides disagree", () => {
    const file = fileOf("probe-only.check.ts");
    const assertion = testOf(file, "needs the kernel");
    expect(assertion.status).toBe("failed");
    const message = assertion.failureMessages.join("\n");
    expect(message).toContain("The runtime and the kernel disagree");
    expect(message).toContain("[kernel]");
    expect(message).toContain("__datum_run");
  });

  it("says the program is not a validation program in 'every rule is tested' too, not that rules are untested", () => {
    const file = fileOf("coverage-bind-fail.check.ts");
    const test = testOf(file, "every rule is tested");
    expect(test.status).toBe("failed");
    const message = test.failureMessages.join("\n");
    expect(message).toMatch(/noop-program\.js is not a validation program/);
    expect(message).not.toMatch(/not tested by the scenarios/);
    for (const assertion of file.assertionResults) {
      expect(assertion.status, assertion.fullName).toBe("failed");
    }
  });

  it("prints no untested-rule warning when the program was refused at bind", () => {
    const file = fileOf("coverage-bind-warn.check.ts");
    expect(file.assertionResults.length).toBeGreaterThan(0);
    for (const assertion of file.assertionResults) {
      expect(assertion.failureMessages.join("\n"), assertion.fullName).toMatch(/is not a validation program/);
    }
    // The file's own hook asserts no warning went out; a failed hook would put its message here.
    expect(file.message ?? "").not.toContain("no untested-rule warning");
  });

  it("registers no coverage test when coverage is off", () => {
    expect(fileOf("form.check.ts").assertionResults.map((assertion) => assertion.title)).not.toContain("every rule is tested");
  });
});
