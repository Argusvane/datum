import { spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { KIT, REPO, load } from "./load.js";

const made: string[] = [];
afterEach(() => { for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true }); });

// The kit's range is 5200-5219 unless BINDING_KIT_PORTS moves it (a second checkout or agent beside the first):
// the tests read the same variable, so they hold under either.
const rangeFromEnv = /^(\d+)-(\d+)$/.exec(process.env.BINDING_KIT_PORTS ?? "");
const EXPECTED_FIRST = rangeFromEnv ? Number(rangeFromEnv[1]) : 5200;
const EXPECTED_LAST = rangeFromEnv ? Number(rangeFromEnv[2]) : 5219;

describe("ports", () => {
  it("stays inside the kit's range and skips a port in use", async () => {
    const { pickPort, FIRST_PORT, LAST_PORT } = await load(join(KIT, "lib", "ports.mjs"));
    expect([FIRST_PORT, LAST_PORT]).toEqual([EXPECTED_FIRST, EXPECTED_LAST]);
    const first = await pickPort();
    expect(first).toBeGreaterThanOrEqual(EXPECTED_FIRST);
    expect(first).toBeLessThanOrEqual(EXPECTED_LAST);
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(first, "127.0.0.1", resolve));
    try {
      const second = await pickPort(first);
      expect(second).toBeGreaterThan(first);
      expect(second).toBeLessThanOrEqual(EXPECTED_LAST);
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });

  it("takes a port outside the range as given, and refuses it when it is in use", async () => {
    const { pickPort, LAST_PORT } = await load(join(KIT, "lib", "ports.mjs"));
    const outside = LAST_PORT + 392;
    expect(await pickPort(outside)).toBe(outside);
    const held = createServer();
    await new Promise<void>((resolve) => held.listen(outside, "127.0.0.1", resolve));
    try {
      await expect(pickPort(outside)).rejects.toThrow(new RegExp(`port ${outside} is in use`));
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()));
    }
  });
});

// The scaffold lives in the repository's scripts/, outside this package: it is run as the command it is.
const run = (...args: string[]): { status: number | null; stdout: string; stderr: string } => {
  const result = spawnSync(process.execPath, [join(REPO, "scripts", "new-binding.mjs"), ...args], { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

describe("scripts/new-binding.mjs", () => {
  it("writes a package the kit reads: block, entry, reference, tests and a side-effects page", async () => {
    const { configProblems } = await load(join(KIT, "lib", "binding-package.mjs"));
    const root = mkdtempSync(join(tmpdir(), "kit-scaffold-"));
    made.push(root);
    const dir = join(root, "demo-ds");
    const result = run("demo-ds", "--design-system", "Demo Design System", "--release", "2.1.0", "--package", "@demo/ds", "--dir", dir);
    expect(result.status, result.stderr).toBe(0);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    expect(configProblems(manifest.datumBinding)).toEqual([]);
    expect(manifest.datumBinding).toEqual({ id: "demo-ds", designSystem: "Demo Design System", release: "2.1.0", bundle: "dist/demo-ds.js", global: "DatumBindingDemoDs", budgetKb: 12 });
    expect(manifest.devDependencies["demo-ds-2.1.0"]).toBe("npm:@demo/ds@2.1.0");
    expect(Object.keys(manifest.scripts)).toEqual(expect.arrayContaining(["kit:check", "kit:build", "kit:equality", "kit:behaviour", "kit:conformance", "kit:serve"]));
    // A package kept outside bindings/ names itself to the kit by its folder (the scripts run in it), not by an id the kit cannot find.
    for (const script of ["kit:check", "kit:build", "kit:equality", "kit:behaviour", "kit:conformance", "kit:serve"]) expect(manifest.scripts[script], script).toMatch(/ --binding \.$/);
    for (const file of ["src/index.ts", "tests/tier2/.gitkeep", "reference/text-field.html", "binding-check.json", "tsconfig.json", "README.md", "docs/side-effects.md"]) expect(existsSync(join(dir, file)), file).toBe(true);
    const effects = readFileSync(join(dir, "docs", "side-effects.md"), "utf8");
    for (const heading of ["Document-level styles and fonts", "Listeners, timers and observers", "Markers on <body>", "Nodes added outside the form's root", "Globals", "What the host must provide"]) expect(effects).toContain(heading);
    expect(readFileSync(join(dir, "src", "index.ts"), "utf8")).toMatch(/createBinding: BindingFactory/);
    // The reference placeholder is a valid reference file that skips itself.
    const { parseReference } = await load(join(KIT, "lib", "reference.mjs"));
    const parsed = parseReference(readFileSync(join(dir, "reference", "text-field.html"), "utf8"), "text-field");
    expect(parsed.problems).toEqual([]);
    expect(parsed.meta.skip).toBeTruthy();
  });

  it("refuses a bad id, a missing design system and a package that exists", () => {
    expect(run("Bad Id", "--design-system", "X", "--release", "1")).toMatchObject({ status: 2, stderr: expect.stringMatching(/give the binding an id/) });
    expect(run("ok", "--release", "1").stderr).toMatch(/--design-system is required/);
    expect(run("ok", "--design-system", "X").stderr).toMatch(/--release is required/);
    const root = mkdtempSync(join(tmpdir(), "kit-scaffold-"));
    made.push(root);
    const dir = join(root, "again");
    expect(run("again", "--design-system", "X", "--release", "1", "--dir", dir).status).toBe(0);
    expect(run("again", "--design-system", "X", "--release", "1", "--dir", dir)).toMatchObject({ status: 2, stderr: expect.stringMatching(/already holds a package/) });
  });
});
