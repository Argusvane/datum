// @vitest-environment node
// kit:check's `checks` step: a package's own scripts are Chromium scripts (they launch Chromium themselves and take only
// --port), so under --browser firefox or webkit the step runs none of them and says so. The CI rows for those browsers
// install only their own browser: a script that ran there would fail on a Chromium that is not installed.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KIT, load } from "./load.js";

const PORT = Number(process.env.BINDING_KIT_TEST_PORT ?? 6622);

describe("kit:check checks step", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "kit-checks-"));
    // The package's one check: it leaves a marker file, so the test sees whether it ran.
    writeFileSync(join(dir, "mark.mjs"), `import { writeFileSync } from "node:fs";\nwriteFileSync(new URL("./ran", import.meta.url), process.argv.slice(2).join(" "));\n`);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const pkg = () => ({ id: "demo", isDatum: false, dir, problems: [], config: { id: "demo", checks: ["mark.mjs"] } });

  it.each(["firefox", "webkit"])("runs no package script under --browser %s and records the step as not run there", async (browser) => {
    const { runCheck } = await load(join(KIT, "check.mjs"));
    const lines: string[] = [];
    const result = await runCheck(pkg(), { only: ["checks"], browser, port: PORT, log: (line: string) => lines.push(line) });
    expect(existsSync(join(dir, "ran"))).toBe(false);
    expect(result.exit).toBe(0);
    expect(result.steps).toEqual([{ step: "checks", exit: 0, note: `not run in ${browser}: the package's own checks run in Chromium (kit:check with no --browser)` }]);
  });

  it.each([undefined, "chromium"])("runs the package's scripts with --port under browser %s", async (browser) => {
    const { runCheck } = await load(join(KIT, "check.mjs"));
    const result = await runCheck(pkg(), { only: ["checks"], ...(browser ? { browser } : {}), port: PORT, log: () => {} });
    expect(existsSync(join(dir, "ran"))).toBe(true);
    expect(result.steps).toEqual([{ step: "checks", exit: 0, note: "1 script(s)" }]);
  });
});
