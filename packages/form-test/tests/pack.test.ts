import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { packProblems } from "../../../scripts/npm/pack-check.mjs";
import type { Report } from "../src/report/model.js";
import { PACKAGE_ROOT } from "./helpers/paths.js";

const run = promisify(execFile);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

/** A child process's exit code: 0 when it resolved, the code it rejected with otherwise. */
async function exitOf(promise: Promise<unknown>): Promise<number | null> {
  try {
    await promise;
    return 0;
  } catch (failure) {
    return (failure as { code?: number }).code ?? null;
  }
}

// The tarball `npm pack` makes is what a project installs (the conformance
// suite's pack test, same shape). Install it into an empty folder, outside the repository, and run
// the installed command and the installed vitest helper on the fixtures the tarball carries.
describe("npm pack, install, run", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-form-test-pack-"));
  const app = join(work, "app");
  const installed = join(app, "node_modules", "@argusvane", "datum-form-test");
  let listing: string[] = [];
  let problems: string[] = [];
  let bin = "";

  beforeAll(async () => {
    // The bundle is a build product; build-cli.mjs replaces dist/ files by rename, so a test file
    // running beside this one never finds them missing.
    await run(process.execPath, [join(PACKAGE_ROOT, "scripts", "build-cli.mjs")], { cwd: PACKAGE_ROOT });
    // The declarations (with the private packages' ones inlined), the licence file of the bundled packages, and the
    // LICENSE and NOTICE of the tarball: the build and prepack steps, run one by one so no test file's dist/ goes missing.
    // The CI job builds them only in its later Build step, so without this the tarball made here would carry none and
    // the consumer typecheck below would have nothing to read.
    const scripts = join(PACKAGE_ROOT, "..", "..", "scripts", "npm");
    await run(process.execPath, [join(scripts, "build-types.mjs")], { cwd: PACKAGE_ROOT, maxBuffer: 16 * 1024 * 1024 });
    await run(process.execPath, [join(scripts, "bundle-licence.mjs"), "datum-form-test", "dist/index.mjs", "dist/vitest.mjs"], { cwd: PACKAGE_ROOT });
    await run(process.execPath, [join(scripts, "prepack.mjs")], { cwd: PACKAGE_ROOT });
    mkdirSync(join(work, "pack"), { recursive: true });
    mkdirSync(app, { recursive: true });
    const packed = await run(npm, ["pack", "--json", "--ignore-scripts", "--pack-destination", join(work, "pack")], { cwd: PACKAGE_ROOT, maxBuffer: 16 * 1024 * 1024 });
    const info = JSON.parse(packed.stdout) as Array<{ filename: string; files: Array<{ path: string; size: number }> }>;
    const tarball = join(work, "pack", info[0]!.filename);
    listing = info[0]!.files.map((file) => file.path);
    problems = packProblems(PACKAGE_ROOT, info[0]!.files) as string[];
    writeFileSync(join(app, "package.json"), JSON.stringify({ name: "form-test-consumer", version: "1.0.0", private: true, type: "module" }));
    await run(npm, ["install", tarball, "--no-audit", "--no-fund", "--ignore-scripts", "--prefer-offline"], { cwd: app, maxBuffer: 16 * 1024 * 1024 });
    bin = join(app, "node_modules", ".bin", "datum-form-test");
  }, 240_000);

  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("carries the bundles, the shim and the fixtures, and no source or tests", () => {
    for (const path of [
      "package.json",
      "README.md",
      "LICENSE",
      "NOTICE",
      "dist/datum-form-test.LICENSE.txt",
      "bin/datum-form-test.mjs",
      "dist/cli.mjs",
      "dist/index.mjs",
      "dist/vitest.mjs",
      "fixtures/main.json",
      "fixtures/main.datum-test",
      "fixtures/clock.json",
      "fixtures/failing.datum-test"
    ]) {
      expect(listing, path).toContain(path);
    }
    expect(listing.filter((path) => /^(src|tests|scripts)\//.test(path))).toEqual([]);
    expect(listing.filter((path) => path.endsWith(".map"))).toEqual([]);
  });

  // The checks every published package is held to (scripts/npm/pack-check.mjs): licence files, entry points present,
  // no TypeScript source, tests, maps or build-machine path, a manifest a consumer can install, no private import.
  it("passes the shared pack checks", () => {
    expect(problems).toEqual([]);
  });

  it("installs with no dependencies of its own to fetch", () => {
    const manifest = JSON.parse(readFileSync(join(installed, "package.json"), "utf8")) as { dependencies?: object; bin: Record<string, string> };
    expect(manifest.dependencies ?? {}).toEqual({});
    expect(manifest.bin["datum-form-test"]).toBe("./bin/datum-form-test.mjs");
    expect(existsSync(join(app, "node_modules", "@argusvane", "datum-engine"))).toBe(false);
    expect(existsSync(join(app, "node_modules", "@argusvane", "datum-quickjs-wasm-host"))).toBe(false);
  });

  it("runs the installed command on the fixtures: exit 0 and a passed report, exit 1 with the failing file", async () => {
    const fixtures = join(installed, "fixtures");
    // Not the repository as the working directory: the command may rely on nothing but its own files.
    const result = await run(bin, [join(fixtures, "main.json"), join(fixtures, "clock.json"), "--report", "json"], { cwd: work, maxBuffer: 64 * 1024 * 1024 });
    expect(result.stderr).toBe("");
    const report = JSON.parse(result.stdout) as Report;
    expect(report.verdict).toBe("passed");
    expect(report.summary.failed).toBe(0);
    expect(report.summary.passed).toBeGreaterThan(10);

    expect(await exitOf(run(bin, [join(fixtures, "main.json"), "--tests", join(fixtures, "failing.datum-test")], { cwd: work, maxBuffer: 64 * 1024 * 1024 }))).toBe(1);
    expect((await run(bin, ["--version"], { cwd: work })).stdout).toMatch(/\d+\.\d+\.\d+/);
    expect(await exitOf(run(bin, ["--runner"], { cwd: work }))).toBe(2);
  }, 120_000);

  // The `./vitest` declarations must not import @argusvane/datum-engine, which the tarball neither
  // carries nor declares: a project that typechecks its tests would fail on TS2307 (or, with
  // skipLibCheck, get types quietly turned into any). This typechecks a
  // consumer file against the installed tarball with skipLibCheck off, as such a project would.
  it("typechecks a consumer of @argusvane/datum-form-test/vitest with no engine installed", async () => {
    const declaration = readFileSync(join(installed, "dist", "types", "packages", "form-test", "src", "vitest.d.ts"), "utf8");
    expect(declaration).not.toMatch(/from\s+["']/);
    writeFileSync(
      join(app, "consumer.ts"),
      [
        'import { formTests, type FormTestsOptions } from "@argusvane/datum-form-test/vitest";',
        "const options: FormTestsOptions = { runner: \"kernel\", coverage: \"warn\", signatures: [{ name: \"double\", min: 1, max: 1 }], functions: { double: (args) => Number(args[0]) * 2 } };",
        'formTests("forms/registration.json", options);',
        "formTests({ id: \"inline\", root: { id: \"form\", type: \"form\" } });",
        "interface Stored { id: string; version: string; root: { id: string } }",
        "declare const stored: Stored;",
        "formTests(stored);",
        "// @ts-expect-error a runner the command does not have",
        'formTests("forms/registration.json", { runner: "server" });',
        ""
      ].join("\n")
    );
    writeFileSync(
      join(app, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: false, noEmit: true, types: [] },
        include: ["consumer.ts"]
      })
    );
    // tsc prints its errors on stdout; a failure shows them instead of a bare exit code.
    let printed = "";
    try {
      await run(process.execPath, [join(PACKAGE_ROOT, "node_modules", "typescript", "bin", "tsc"), "-p", app], { cwd: app, maxBuffer: 16 * 1024 * 1024 });
    } catch (failure) {
      printed = (failure as { stdout?: string }).stdout ?? String(failure);
    }
    expect(printed).toBe("");
  }, 120_000);

  it("resolves @argusvane/datum-form-test/vitest beside vitest and registers the fixture's scenarios in a child vitest", async () => {
    // vitest is an optional peer: link the repository's copy in rather than fetching one, so the
    // test needs no network. Node follows the link to its real path, so the child's runner and
    // the helper's `import "vitest"` are the same module.
    symlinkSync(realpathSync(join(PACKAGE_ROOT, "node_modules", "vitest")), join(app, "node_modules", "vitest"), "dir");
    const mainPath = join(installed, "fixtures", "main.json");
    writeFileSync(
      join(app, "form.test.mjs"),
      ['import { formTests } from "@argusvane/datum-form-test/vitest";', `formTests(${JSON.stringify(mainPath)});`, ""].join("\n")
    );
    const expected = (JSON.parse((await run(bin, [mainPath, "--report", "json"], { cwd: work, maxBuffer: 64 * 1024 * 1024 })).stdout) as Report).summary;

    const outputFile = join(work, "vitest-report.json");
    // The parent is a vitest worker; its VITEST* variables would tell the child it is nested.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "TEST"));
    const code = await exitOf(
      run(process.execPath, [join(app, "node_modules", "vitest", "vitest.mjs"), "run", "--root", app, "--reporter=json", `--outputFile=${outputFile}`], {
        cwd: app,
        env,
        maxBuffer: 32 * 1024 * 1024
      })
    );
    const results = (JSON.parse(readFileSync(outputFile, "utf8")) as { testResults: Array<{ assertionResults: Array<{ status: string }> }> }).testResults;
    expect(code).toBe(0);
    expect(results).toHaveLength(1);
    const statuses = results[0]!.assertionResults.map((assertion) => assertion.status);
    expect(statuses).toHaveLength(expected.scenarios);
    expect(statuses.filter((status) => status === "passed")).toHaveLength(expected.passed);
  }, 180_000);
});
