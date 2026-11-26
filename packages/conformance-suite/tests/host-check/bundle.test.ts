import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// @ts-expect-error The bundle settings are plain ESM shared with scripts/build-cli.mjs (no types).
import { hostCheckBuildOptions } from "../../scripts/host-check-bundle.mjs";
import { PACKAGE_ROOT } from "../helpers/paths.js";
import { startMockHost, type MockHost } from "./helpers/mock-host.js";

const run = promisify(execFile);

// The command as it ships: the bundle built with the package build's own settings, into a folder of its
// own (so this file never races `npm run build` or the pack test over dist/), run by plain node from a
// folder that is not the repository.
describe("the bundled datum-host-check", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-host-check-bundle-"));
  const bundle = join(work, "host-check.mjs");
  let good: MockHost;

  beforeAll(async () => {
    await build(hostCheckBuildOptions(PACKAGE_ROOT, bundle) as Parameters<typeof build>[0]);
    good = await startMockHost();
  }, 120_000);

  afterAll(async () => {
    await good.close();
    rmSync(work, { recursive: true, force: true });
  });

  it("runs the five capabilities against a good host: 21 passed, exit 0", async () => {
    const result = await run(process.execPath, [bundle, "--endpoint", good.url, "--capabilities", "submissions,submissions-test,forms,assets,flood", "--out", join(work, "report")], { cwd: work });
    expect(result.stdout).toContain("== PASS: 21 passed, 0 failed, 0 skipped");
    expect(result.stderr).toBe("");
  }, 120_000);

  it("exits 3 against nothing and 2 on a usage error, with messages and no stack", async () => {
    await expect(run(process.execPath, [bundle, "--endpoint", "http://127.0.0.1:9", "--capabilities", "forms"], { cwd: work })).rejects.toMatchObject({ code: 3 });
    const usage = await run(process.execPath, [bundle, "--capabilities", "forms"], { cwd: work }).catch((error: { code: number; stderr: string }) => error);
    expect(usage).toMatchObject({ code: 2 });
    expect((usage as { stderr: string }).stderr).toContain("--endpoint");
  }, 60_000);

  it("writes the fixtures it carries", async () => {
    const result = await run(process.execPath, [bundle, "fixtures", "--out", join(work, "fixtures")], { cwd: work });
    expect(result.stdout).toContain("hardening-rules.js");
  }, 60_000);
});
