import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error The bundle settings are plain ESM shared with scripts/build-cli.mjs (no types).
import { CLI_ENTRY, INDEX_BUDGET_BYTES, VITEST_BUDGET_BYTES, indexBuildOptions, vitestBuildOptions } from "../scripts/bundle-options.mjs";
import type { Report } from "../src/report/model.js";
import { fixture, PACKAGE_ROOT } from "./helpers/paths.js";

const run = promisify(execFile);

/** The names a bundle imports from ./index.mjs (`import { a, b as c } from "./index.mjs"`). */
function namesImportedFromIndex(text: string): string[] {
  const names = new Set<string>();
  for (const match of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']\.\/index\.mjs["']/g)) {
    for (const part of (match[1] as string).split(",")) {
      const name = part.trim().split(/\s+as\s+/)[0]?.trim();
      if (name !== undefined && name !== "") {
        names.add(name);
      }
    }
  }
  return [...names].sort();
}

// The command as it ships: the bundles built with the package build's own settings into a folder of
// their own (never dist/, which `npm run build` and a pack may be using), run by plain node from a
// folder that is not the repository, so nothing resolves through node_modules.
describe("the bundled datum-form-test", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-form-test-bundle-"));
  const index = join(work, "index.mjs");
  const helper = join(work, "vitest.mjs");
  const cli = join(work, "cli.mjs");

  beforeAll(async () => {
    await build(indexBuildOptions(PACKAGE_ROOT, index) as Parameters<typeof build>[0]);
    await build(vitestBuildOptions(PACKAGE_ROOT, helper) as Parameters<typeof build>[0]);
    writeFileSync(cli, CLI_ENTRY);
  }, 240_000);

  afterAll(() => {
    rmSync(work, { recursive: true, force: true });
  });

  it("stays within its budgets and carries no __name helper", () => {
    const indexBytes = statSync(index).size;
    const helperBytes = statSync(helper).size;
    expect(indexBytes, `index.mjs is ${indexBytes} bytes`).toBeLessThanOrEqual(INDEX_BUDGET_BYTES);
    expect(helperBytes, `vitest.mjs is ${helperBytes} bytes`).toBeLessThanOrEqual(VITEST_BUDGET_BYTES);
    for (const path of [index, helper, cli]) {
      expect(/\b__name\(/.test(readFileSync(path, "utf8")), path).toBe(false);
    }
  });

  it("runs the fixture form and prints a report that parses, exit 0", async () => {
    const result = await run(process.execPath, [cli, fixture("main.json"), "--report", "json"], { cwd: work, maxBuffer: 64 * 1024 * 1024 });
    const report = JSON.parse(result.stdout) as Report;
    expect(report.verdict).toBe("passed");
    expect(report.forms[0]?.scenarios.length).toBeGreaterThan(10);
    expect(result.stderr).toBe("");
  }, 180_000);

  it("exits 1 on the failing file and 2 on a usage error", async () => {
    await expect(run(process.execPath, [cli, fixture("main.json"), "--tests", fixture("failing.datum-test")], { cwd: work, maxBuffer: 64 * 1024 * 1024 })).rejects.toMatchObject({ code: 1 });
    const usage = await run(process.execPath, [cli, "--nope"], { cwd: work }).catch((error: { code: number; stderr: string }) => error);
    expect(usage).toMatchObject({ code: 2 });
    expect((usage as { stderr: string }).stderr).toMatch(/^datum-form-test: unknown option --nope/);
  }, 180_000);

  it("leaves vitest and the engine out of the helper: every name it takes from ./index.mjs is exported there", async () => {
    const text = readFileSync(helper, "utf8");
    expect(text).toMatch(/from\s*["']vitest["']/);
    expect(text).not.toMatch(/kernelParseFormula\b/);
    const imported = namesImportedFromIndex(text);
    expect(imported.length).toBeGreaterThan(0);
    const listed = await run(process.execPath, ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(index).href)}); console.log(JSON.stringify(Object.keys(m)));`], { cwd: work });
    const exported = new Set(JSON.parse(listed.stdout) as string[]);
    expect(imported.filter((name) => !exported.has(name))).toEqual([]);
  }, 120_000);
});
