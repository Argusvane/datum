import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { Ajv } from "ajv";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { packProblems } from "../../../scripts/npm/pack-check.mjs";
import type { Report } from "../src/report/model.js";
import { REPORT_SCHEMA } from "../src/report/schema.js";
import { builtProgramText, yesManProgramText } from "./helpers/programs.js";
import { PACKAGE_ROOT } from "./helpers/paths.js";
import { hasChromium, TEST_PORT } from "./binding-check/helpers.js";

const run = promisify(execFile);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

// The tarball `npm pack` makes is what an operator or an auditor installs. Install it
// into an empty directory (no repository, no node_modules of ours) and run the installed command
// end to end against a program file.
describe("npm pack, install, run", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-security-suite-pack-"));
  const app = join(work, "app");
  let tarball = "";
  let listing: string[] = [];
  let problems: string[] = [];
  let bin = "";
  let program = "";

  beforeAll(async () => {
    // The bundles are build products (the atomic builds keep parallel test files safe).
    await run(process.execPath, [join(PACKAGE_ROOT, "scripts", "build-cli.mjs")], { cwd: PACKAGE_ROOT });
    await run(process.execPath, [join(PACKAGE_ROOT, "scripts", "build-binding-check.mjs")], { cwd: PACKAGE_ROOT });
    // The declarations (with the private packages' ones inlined), the licence file of the bundled packages, and the
    // LICENSE and NOTICE of the tarball: the build and prepack steps beside the two bundles above.
    const scripts = join(PACKAGE_ROOT, "..", "..", "scripts", "npm");
    await run(process.execPath, [join(scripts, "build-types.mjs")], { cwd: PACKAGE_ROOT, maxBuffer: 16 * 1024 * 1024 });
    await run(process.execPath, [join(scripts, "bundle-licence.mjs"), "datum-conformance-suite", "dist/index.mjs", "dist/host-check.mjs", "binding-check/dist/host.js"], { cwd: PACKAGE_ROOT });
    await run(process.execPath, [join(scripts, "prepack.mjs")], { cwd: PACKAGE_ROOT });
    mkdirSync(join(work, "pack"), { recursive: true });
    mkdirSync(app, { recursive: true });
    const packed = await run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", join(work, "pack")], { cwd: PACKAGE_ROOT, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string; size: number }> }>;
    tarball = join(work, "pack", info[0]!.filename);
    listing = info[0]!.files.map((file) => file.path);
    problems = packProblems(PACKAGE_ROOT, info[0]!.files) as string[];
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "suite-consumer", version: "1.0.0", private: true }));
    await run(npm, ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline"], { cwd: app, maxBuffer: 16 * 1024 * 1024 });
    bin = join(app, "node_modules", ".bin", "datum-security-check");
    program = join(work, "program.js");
    writeFileSync(program, builtProgramText());
  }, 240_000);

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("carries the bundles, the shims, the binding tester with its prebuilt host module, the golden files and the fixture, and no src, tests or scripts", () => {
    for (const path of ["package.json", "README.md", "LICENSE", "NOTICE", "dist/datum-conformance-suite.LICENSE.txt", "bin/datum-security-check.mjs", "bin/datum-binding-check.mjs", "binding-check/api.mjs", "binding-check/cli.mjs", "binding-check/page.js", "binding-check/host.html", "binding-check/dist/host.js", "binding-check/datum/binding.mjs", "binding-check/lib/cases.mjs", "binding-check/fixtures/index.mjs", "dist/cli.mjs", "dist/index.mjs", "golden/abi-4.1.json", "golden/agent-tools.json", "fixtures/endpoint-fixture.definition.json", "fixtures/README.md"]) {
      expect(listing, path).toContain(path);
    }
    expect(listing.filter((path) => /^(src|tests|scripts)\//.test(path))).toEqual([]);
    // The host module's source imports the engine's source, which the package does not carry.
    expect(listing.filter((path) => path.startsWith("binding-check/") && (path.startsWith("binding-check/host/") || path.endsWith(".ts")))).toEqual([]);
    expect(listing.filter((path) => path.endsWith(".map"))).toEqual([]);
  });

  // The checks every published package is held to (scripts/npm/pack-check.mjs): licence files, entry points present,
  // no TypeScript source, tests, maps or build-machine path, a manifest a consumer can install, no private import.
  it("passes the shared pack checks, and the host-check bundle names no build path", () => {
    expect(problems).toEqual([]);
    expect(readFileSync(join(PACKAGE_ROOT, "dist", "host-check.mjs"), "utf8")).toContain("// raw-text:golden/agent-tools.json");
  });

  it("installs with no dependencies of its own to fetch", () => {
    const manifest = JSON.parse(readFileSync(join(app, "node_modules", "@argusvane", "datum-conformance-suite", "package.json"), "utf8")) as { dependencies?: object; bin: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.bin["datum-security-check"]).toBe("./bin/datum-security-check.mjs");
    expect(existsSync(join(app, "node_modules", "@argusvane", "datum-quickjs-wasm-host"))).toBe(false);
    // Playwright and esbuild are optional peers: a plain install pulls neither.
    expect(existsSync(join(app, "node_modules", "playwright"))).toBe(false);
    expect(existsSync(join(app, "node_modules", "esbuild"))).toBe(false);
  });

  it("runs the installed datum-host-check with no peer installed: list --json exits 0", async () => {
    const hostCheck = join(app, "node_modules", ".bin", "datum-host-check");
    const result = await run(hostCheck, ["list", "--json"], { cwd: work, maxBuffer: 16 * 1024 * 1024 });
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toBeTypeOf("object");
  }, 60_000);

  it("the installed datum-binding-check answers --list, and a run without Playwright exits 3 and names it", async () => {
    const bindingCheck = join(app, "node_modules", ".bin", "datum-binding-check");
    expect((await run(bindingCheck, ["--list"], { cwd: work })).stdout).toContain("MNT-01");
    const failed = await run(bindingCheck, ["--only", "MNT"], { cwd: work }).then(() => undefined, (error: { code: number; stderr: string }) => error);
    expect(failed?.code).toBe(3);
    expect(failed?.stderr).toContain("needs Playwright");
  }, 60_000);

  // With the peers beside it (this checkout's Playwright and esbuild, linked into the consumer's node_modules),
  // the installed command runs on its prebuilt host module, with no engine source anywhere it looks.
  it.skipIf(!hasChromium())("the installed datum-binding-check passes Datum's binding and a binding module with the peers installed", async () => {
    for (const peer of ["playwright", "esbuild"]) symlinkSync(join(PACKAGE_ROOT, "node_modules", peer), join(app, "node_modules", peer), "dir");
    const bindingCheck = join(app, "node_modules", ".bin", "datum-binding-check");
    const datum = await run(bindingCheck, ["--only", "MNT", "--port", TEST_PORT], { cwd: work, maxBuffer: 16 * 1024 * 1024 });
    expect(datum.stdout).toMatch(/datum: \d+ pass, 0 fail/);
    const module = join(PACKAGE_ROOT, "tests", "binding-check", "ignores-pending-binding.mjs");
    const other = await run(bindingCheck, ["--binding", module, "--only", "MNT", "--port", TEST_PORT], { cwd: work, maxBuffer: 16 * 1024 * 1024 });
    expect(other.stdout).toMatch(/: \d+ pass, 0 fail/);
  }, 240_000);

  it("runs the installed command against a program file: exit 0 and a schema-valid report", async () => {
    const out = join(work, "report");
    // Not the repository as the working directory: the command may rely on nothing but its own files.
    const result = await run(bin, ["--program", program, "--only", "control,abi,isolation", "--format", "json,md", "--out", out], { cwd: work, maxBuffer: 64 * 1024 * 1024 });
    expect(result.stderr).toBe("");
    const report = JSON.parse(readFileSync(join(out, "report.json"), "utf8")) as Report;
    expect(new Ajv({ strict: false, validateFormats: false }).compile(REPORT_SCHEMA)(report)).toBe(true);
    expect(report.verdict).toBe("PASS");
    expect(report.summary.fail).toBe(0);
    expect(report.summary.pass).toBeGreaterThan(10);
    expect(readFileSync(join(out, "report.md"), "utf8")).toContain("# Datum security check: PASS");
  }, 120_000);

  it("exits 1 when the program is not a gate (a yes-man program)", async () => {
    const yesMan = join(work, "yes-man.js");
    writeFileSync(yesMan, yesManProgramText());
    await expect(run(bin, ["--program", yesMan, "--only", "control", "--quiet"], { cwd: work })).rejects.toMatchObject({ code: 1 });
  }, 120_000);

  it("answers --version, list and fixture, and exits 2 on a usage error", async () => {
    const version = await run(bin, ["--version"], { cwd: work });
    expect(version.stdout).toMatch(/\d+\.\d+\.\d+/);
    const list = JSON.parse((await run(bin, ["list", "--json"], { cwd: work, maxBuffer: 16 * 1024 * 1024 })).stdout) as { vectors: unknown[] };
    expect(list.vectors.length).toBeGreaterThan(50);
    const fixture = JSON.parse((await run(bin, ["fixture"], { cwd: work })).stdout) as { securitySuiteFixture?: unknown };
    expect(fixture).toBeTypeOf("object");
    await expect(run(bin, ["--program"], { cwd: work })).rejects.toMatchObject({ code: 2 });
  }, 60_000);
});
