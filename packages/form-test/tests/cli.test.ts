import { execFile } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import { USAGE } from "../src/args.js";
import { runCli } from "../src/cli.js";
import { EXIT } from "../src/exit-codes.js";
import type { Report } from "../src/report/model.js";
import { capture, workFolder } from "./helpers/io.js";
import { fixture, PACKAGE_ROOT } from "./helpers/paths.js";

const execute = promisify(execFile);
import { builtProgramText } from "./helpers/programs.js";

const work = workFolder("datum-form-test-cli-");

describe("the command line in process", () => {
  it("prints help and the version and exits 0", async () => {
    const help = capture();
    expect(await runCli(["--help"], help.io)).toBe(EXIT.passed);
    expect(help.out()).toBe(USAGE);
    expect(help.err()).toBe("");
    const version = capture();
    expect(await runCli(["--version"], version.io)).toBe(EXIT.passed);
    expect(version.out()).toBe("datum-form-test 0.1.0\n");
  });

  it.each<[string[], RegExp]>([
    [[], /^datum-form-test: give at least one definition file/],
    [["--nope"], /^datum-form-test: unknown option --nope/],
    [["a.json", "--runner", "server"], /^datum-form-test: --runner is runtime, kernel or both/],
    [["a.json", "b.json", "--tests", "t.datum-test"], /^datum-form-test: --tests needs exactly one definition/]
  ])("exits 2 on the usage error %j, with the message and the usage on stderr", async (argv, message) => {
    const io = capture();
    expect(await runCli(argv, io.io)).toBe(EXIT.usage);
    expect(io.err()).toMatch(message);
    expect(io.err()).toContain(USAGE);
    expect(io.out()).toBe("");
  });

  it("exits 2 on an input error, naming the file, with no usage and no stack", async () => {
    const missing = capture();
    expect(await runCli([join(work.dir, "missing.json")], missing.io)).toBe(EXIT.usage);
    expect(missing.err()).toMatch(/^datum-form-test: cannot read the definition .*missing\.json: no such file\n$/);
    const bad = capture();
    expect(await runCli([work.file("bad.json", "{")], bad.io)).toBe(EXIT.usage);
    expect(bad.err()).toMatch(/bad\.json is not JSON/);
    const tests = capture();
    expect(await runCli([fixture("clock.json"), "--tests", join(work.dir, "none.datum-test")], tests.io)).toBe(EXIT.usage);
    expect(tests.err()).toMatch(/cannot read the test file/);
    const program = capture();
    expect(await runCli([fixture("clock.json"), "--program", work.file("empty.js", "")], program.io)).toBe(EXIT.usage);
    expect(program.err()).toMatch(/the sandbox program .*empty\.js is empty/);
    expect(program.err()).not.toMatch(/\n\s+at /);
  });

  it("prints the chosen reports to stdout in the order given, without --out", async () => {
    const json = capture();
    expect(await runCli([fixture("clock.json"), "--report", "json"], json.io)).toBe(EXIT.passed);
    const report = JSON.parse(json.out()) as Report;
    expect(report).toMatchObject({ tool: { name: "datum-form-test" }, runner: "both", verdict: "passed" });
    expect(Date.parse(report.startedAt)).not.toBeNaN();
    const md = capture();
    expect(await runCli([fixture("clock.json")], md.io)).toBe(EXIT.passed);
    expect(md.out()).toMatch(/^# /);
    const both = capture();
    expect(await runCli([fixture("clock.json"), "--report", "junit,json"], both.io)).toBe(EXIT.passed);
    expect(both.out()).toMatch(/^<\?xml/);
    expect(both.out().indexOf("</testsuites>")).toBeLessThan(both.out().indexOf('"tool"'));
  });

  it("writes the three files with --out, and prints one line per scenario and the totals", async () => {
    const out = join(work.dir, "reports", "nested");
    const io = capture();
    const code = await runCli([fixture("main.json"), "--tests", fixture("failing.datum-test"), "--report", "json,junit,md", "--out", out], io.io);
    expect(code).toBe(EXIT.failed);
    for (const name of ["form-tests.json", "form-tests.xml", "form-tests.md"]) {
      expect(existsSync(join(out, name)), name).toBe(true);
    }
    const report = JSON.parse(readFileSync(join(out, "form-tests.json"), "utf8")) as Report;
    expect(report.verdict).toBe("failed");
    expect(readFileSync(join(out, "form-tests.xml"), "utf8")).toMatch(/^<\?xml[\s\S]*<testsuites name="datum-form-test"/);
    const lines = io.out().trimEnd().split("\n");
    const scenarios = report.forms[0]!.scenarios;
    const path = fixture("main.json");
    for (const scenario of scenarios) {
      const runtime = scenario.sides.runtime!;
      const kernel = scenario.sides.kernel!;
      const cell = (side: string, result: { status: string; reason?: string }): string => `${side}: ${result.status}${result.reason === undefined ? "" : ` ${result.reason}`}`;
      expect(lines).toContain(`${scenario.status === "passed" ? "PASS" : "FAIL"}  ${path} › ${scenario.name} (${cell("runtime", runtime)}, ${cell("kernel", kernel)})`);
    }
    expect(lines).toContain(`FAIL  ${path} › a deliberate failure: the name is not optional (runtime: failed, kernel: failed)`);
    // A `given host.` is the kernel's host context too, so both role-note scenarios are judged on both sides.
    expect(lines.some((line) => /^PASS  .* › an admin sees the role note \(runtime: passed, kernel: passed\)$/.test(line))).toBe(true);
    expect(lines.some((line) => /^PASS  .* › anyone else does not see the role note \(runtime: passed, kernel: passed\)$/.test(line))).toBe(true);
    expect(lines.at(-2)).toBe(`FAILED: ${scenarios.length} scenarios, ${scenarios.length - 1} passed, 1 failed, 0 parity, 0 error, 0 skipped; 0 sources with problems`);
    expect(lines.at(-1)).toBe(`reports: ${["form-tests.json", "form-tests.xml", "form-tests.md"].map((name) => join(out, name)).join(", ")}`);
    expect(io.err()).toBe("");
  });

  it("writes only the chosen report with --out, and runs one side with --runner", async () => {
    const out = join(work.dir, "only-junit");
    const io = capture();
    expect(await runCli([fixture("clock.json"), "--runner", "runtime", "--report", "junit", "--out", out], io.io)).toBe(EXIT.passed);
    expect(existsSync(join(out, "form-tests.xml"))).toBe(true);
    expect(existsSync(join(out, "form-tests.json"))).toBe(false);
    expect(io.out()).toContain(`PASS  ${fixture("clock.json")} › an event must not be in the past (runtime: passed)\n`);
  });

  it("exits 3 when no scenario comes to a verdict", async () => {
    const empty = work.file("empty-form.json", JSON.stringify({ id: "e", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content: [] } } }));
    const io = capture();
    expect(await runCli([empty, "--report", "json"], io.io)).toBe(EXIT.inconclusive);
    expect((JSON.parse(io.out()) as Report).verdict).toBe("inconclusive");
  });

  // main.json has no untested rule, so it pins the passing side; the helper project's uncovered.json has one, the failing side.
  it("passes --fail-on untested when every rule is tested, and fails it when one is not", async () => {
    const tested = capture();
    expect(await runCli([fixture("main.json"), "--fail-on", "untested", "--report", "json"], tested.io)).toBe(EXIT.passed);
    expect((JSON.parse(tested.out()) as Report).forms[0]?.coverage?.untested).toBe(0);
    const untested = capture();
    const uncovered = join(PACKAGE_ROOT, "tests", "vitest-helper-project", "fixtures", "uncovered.json");
    expect(await runCli([uncovered, "--fail-on", "untested", "--report", "json"], untested.io)).toBe(EXIT.failed);
    expect((JSON.parse(untested.out()) as Report).forms[0]?.coverage?.untested).toBeGreaterThan(0);
  });

  // The JUnit file and the totals line say why the job is red.
  it("says in the JUnit file and the totals line that untested rules failed the run", async () => {
    const out = join(work.dir, "untested-out");
    const uncovered = join(PACKAGE_ROOT, "tests", "vitest-helper-project", "fixtures", "uncovered.json");
    const io = capture();
    expect(await runCli([uncovered, "--fail-on", "untested", "--report", "junit", "--out", out], io.io)).toBe(EXIT.failed);
    expect(io.out()).toMatch(/FAILED: 1 scenario, 1 passed, 0 failed, 0 parity, 0 error, 0 skipped; 0 sources with problems; \d+ untested rules?\n/);
    const xml = readFileSync(join(out, "form-tests.xml"), "utf8");
    expect(xml).toContain('name="every rule is tested"');
    expect(xml).toMatch(/<testsuite [^>]*failures="1"/);
  });

  // A script that evaluates but has no sandbox entry point is the input's fault.
  it("exits 2, not 1, for a program that is not a validation program", async () => {
    const io = capture();
    expect(await runCli([fixture("main.json"), "--program", work.file("noop-program.js", "var x = 1;")], io.io)).toBe(EXIT.usage);
    expect(io.err()).toMatch(/^datum-form-test: the sandbox program .*noop-program\.js is not a validation program/);
    expect(io.out()).toBe("");
  }, 60_000);

  it("refuses --program with --runner runtime as a usage error", async () => {
    const io = capture();
    expect(await runCli([fixture("main.json"), "--runner", "runtime", "--program", work.file("any-program.js", "var x = 1;")], io.io)).toBe(EXIT.usage);
    expect(io.err()).toMatch(/--program is the kernel side's program/);
  });

  it("exits 2, not 4, for a definition the Logic model cannot read under --coverage", async () => {
    const weird = work.file(
      "weird.json",
      JSON.stringify({ id: "w", version: "1", schemaVersion: "1", root: { id: "form", type: "form", configuration: {}, children: { content: [null] } } })
    );
    const io = capture();
    expect(await runCli([weird, "--coverage"], io.io)).toBe(EXIT.usage);
    expect(io.err()).toMatch(/^datum-form-test: the definition .*weird\.json cannot be read for coverage/);
    expect(io.err()).not.toMatch(/\n\s+at /);
  });

  // Naming the sidecar again must not read it twice.
  it("reads the sidecar once when --tests names it too", async () => {
    const io = capture();
    expect(await runCli([fixture("main.json"), "--tests", fixture("main.datum-test"), "--report", "json"], io.io)).toBe(EXIT.passed);
    expect((JSON.parse(io.out()) as Report).summary.problems).toBe(0);
  });

  // The shim named dist/cli.mjs whatever module was missing.
  it("names the module that is missing in the bin shim, with exit 4", async () => {
    const folder = join(work.dir, "shim");
    mkdirSync(join(folder, "bin"), { recursive: true });
    mkdirSync(join(folder, "dist"), { recursive: true });
    copyFileSync(join(PACKAGE_ROOT, "bin", "datum-form-test.mjs"), join(folder, "bin", "datum-form-test.mjs"));
    writeFileSync(join(folder, "dist", "cli.mjs"), 'import "./index.mjs";\n');
    const failure = await execute(process.execPath, [join(folder, "bin", "datum-form-test.mjs")]).then(
      () => ({ code: 0, stderr: "" }),
      (error: { code?: number; stderr?: string }) => ({ code: error.code ?? -1, stderr: error.stderr ?? "" })
    );
    expect(failure.code).toBe(4);
    expect(failure.stderr).toMatch(/index\.mjs/);
    expect(failure.stderr).toMatch(/npm run build/);
  });

  // An unwritable --out is found before the run, not after it.
  it("exits 2 for an unwritable --out before running anything", async () => {
    const blocker = work.file("blocker", "a file");
    const io = capture();
    expect(await runCli([fixture("main.json"), "--out", join(blocker, "sub")], io.io)).toBe(EXIT.usage);
    expect(io.err()).toMatch(/^datum-form-test: cannot write the reports to .*sub/);
    expect(io.out()).toBe("");
  });

  it("runs the kernel side inside a sandbox program file with --program", async () => {
    const program = work.file("datum-sandbox-program.js", builtProgramText());
    const io = capture();
    const code = await runCli([fixture("main.json"), fixture("clock.json"), "--program", program, "--report", "json"], io.io);
    const report = JSON.parse(io.out()) as Report;
    expect(report.program).toMatchObject({ path: program, bytes: Buffer.byteLength(readFileSync(program, "utf8")) });
    expect(report.program?.sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const scenario of report.forms.flatMap((form) => form.scenarios)) {
      expect(scenario.status, `${scenario.name}: ${JSON.stringify(scenario.sides.kernel)}`).toBe("passed");
      expect(scenario.sides.kernel?.status).toMatch(/^(passed|skipped)$/);
    }
    expect(code).toBe(EXIT.passed);
  }, 180_000);

  it("exits 2 when the program file does not start", async () => {
    const io = capture();
    expect(await runCli([fixture("clock.json"), "--program", work.file("broken-program.js", "this is not javascript {")], io.io)).toBe(EXIT.usage);
    expect(io.err()).toMatch(/^datum-form-test: the sandbox program .*broken-program\.js did not start/);
  }, 60_000);
});
