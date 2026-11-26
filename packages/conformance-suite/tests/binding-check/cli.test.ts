import { execFile } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PACKAGE_ROOT } from "../helpers/paths.js";
import { runCommand } from "./helpers.js";

const exec = promisify(execFile);

// The command line of datum-binding-check without a browser: usage, the case list, the exit codes of bad
// arguments, and the preflight (exit 3) when Playwright, esbuild or the host module is not there.
describe("datum-binding-check: arguments", () => {
  it("prints the usage and exits 0 for --help", async () => {
    const result = await runCommand(["--help"]);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("datum-binding-check");
    expect(result.stdout).toContain("--binding");
    expect(result.stdout).toContain("Exit: 0 pass, 1 a case failed, 2 usage error or nothing asserted, 3 preflight, 4 internal.");
  });

  it("lists the cases with their groups (none pending: CNV, PRT and PDF all assert)", async () => {
    const result = await runCommand(["--list"]);
    expect(result.code).toBe(0);
    for (const id of ["MNT-01", "VAL-01", "ERR-01", "SUM-01", "JNY-05", "I18N-01", "HK-04", "KIND-01"]) expect(result.stdout, id).toContain(id);
    expect(result.stdout).toMatch(/CNV-01\s+builder canvas mode/);
    expect(result.stdout).not.toContain("(pending)");
    expect(result.stdout).toMatch(/Groups:/);
  });

  it.each([
    [["--nope"], "unknown option --nope"],
    [["--binding"], "--binding needs a value"],
    [["--browser", "netscape"], "--browser: one of chromium, firefox, webkit"],
    [["--port", "x"], "--port needs a port number"],
    [["--only", "ZZ-99"], "selects no case"],
    [["--binding", "no-such-binding"], 'no binding "no-such-binding"'],
    [["--assets", "/no/such/assets.json"], "assets file not found"],
    [["--binding", "/no/such/module.ts"], "binding module not found"]
  ])("exits 2 for %j", async (args, message) => {
    const result = await runCommand(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain(message);
  });

  it("exits 2 for a binding package that has no module yet", async () => {
    // A package shell found from the working directory (bindings/<id>/package.json) with no src/binding.ts
    // or src/index.ts and no "binding" in its binding-check.json.
    const work = mkdtempSync(join(tmpdir(), "datum-binding-check-shell-"));
    const shell = join(work, "bindings", "shell-only");
    mkdirSync(shell, { recursive: true });
    writeFileSync(join(shell, "package.json"), JSON.stringify({ name: "@argusvane/datum-binding-shell-only", private: true }));
    writeFileSync(join(shell, "binding-check.json"), "{}");
    const result = await runCommand(["--binding", "shell-only"], { cwd: work });
    rmSync(work, { recursive: true, force: true });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("has no binding module yet");
  });
});

describe("datum-binding-check: preflight in a copy of what the package ships, without the optional peers", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-binding-check-preflight-"));
  const suite = join(work, "conformance-suite");
  const bin = join(suite, "bin", "datum-binding-check.mjs");
  const brokenBinding = join(PACKAGE_ROOT, "tests", "binding-check", "broken-binding.mjs");

  beforeAll(async () => {
    // The package's files (package.json "files": binding-check without host/ and tsconfig.json) outside every
    // node_modules tree: neither Playwright nor esbuild resolves from here, and there is no engine source.
    await exec(process.execPath, [join(PACKAGE_ROOT, "scripts", "build-binding-check.mjs")], { cwd: PACKAGE_ROOT });
    mkdirSync(join(suite, "bin"), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "bin", "datum-binding-check.mjs"), bin);
    cpSync(join(PACKAGE_ROOT, "binding-check"), join(suite, "binding-check"), { recursive: true, filter: (source) => !/[\\/]binding-check[\\/](host|tsconfig\.json|dist)$/.test(source) });
  }, 120_000);
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("carries no host source: the copy is what an install holds", () => {
    expect(existsSync(join(suite, "binding-check", "host"))).toBe(false);
    expect(existsSync(join(suite, "binding-check", "datum", "binding.mjs"))).toBe(true);
  });

  it("still prints --help and --list: they need neither tool", async () => {
    expect((await runCommand(["--help"], { bin, cwd: work })).code).toBe(0);
    const list = await runCommand(["--list"], { bin, cwd: work });
    expect(list.code).toBe(0);
    expect(list.stdout).toContain("MNT-01");
  });

  it("exits 3 and names Playwright when it is not installed", async () => {
    const result = await runCommand(["--only", "MNT"], { bin, cwd: work });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("needs Playwright");
    expect(result.stderr).toContain("optional peer dependency");
    expect(result.stderr).toContain("npx playwright install");
  });

  it("exits 3 and says the host module is missing when the copy has no dist/host.js", async () => {
    // A Playwright whose browser is not there: the run gets past the import and stops at the host module.
    const stub = join(suite, "node_modules", "playwright");
    mkdirSync(stub, { recursive: true });
    writeFileSync(join(stub, "package.json"), JSON.stringify({ name: "playwright", version: "0.0.0", main: "index.js" }));
    writeFileSync(join(stub, "index.js"), 'const launch = async () => { throw new Error("browserType.launch: Executable doesn\'t exist at /nowhere/chrome"); };\nmodule.exports = { chromium: { launch }, firefox: { launch }, webkit: { launch } };\n');
    const result = await runCommand(["--only", "MNT"], { bin, cwd: work });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("has no host module");
    expect(result.stderr).toContain(join(suite, "binding-check", "dist", "host.js"));
  });

  it("runs Datum's binding on the prebuilt host module without esbuild, as far as the browser", async () => {
    mkdirSync(join(suite, "binding-check", "dist"), { recursive: true });
    cpSync(join(PACKAGE_ROOT, "binding-check", "dist", "host.js"), join(suite, "binding-check", "dist", "host.js"));
    const result = await runCommand(["--only", "MNT"], { bin, cwd: work });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("could not start chromium");
    expect(result.stderr).toContain("npx playwright install chromium");
  });

  it("exits 3 and names esbuild for a binding module when esbuild is not installed", async () => {
    const result = await runCommand(["--binding", brokenBinding, "--only", "MNT"], { bin, cwd: work });
    expect(result.code).toBe(3);
    expect(result.stderr).toContain("needs esbuild");
    expect(result.stderr).toContain("optional peer dependency");
  });
});
