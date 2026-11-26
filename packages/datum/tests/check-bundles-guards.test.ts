import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

// @ts-expect-error plain .mjs script without typings
import { CORE_CHUNK, bundleReaders } from "../scripts/guards/lib/loader.mjs";
// @ts-expect-error plain .mjs script without typings
import printGuard, { CHUNK_BUDGETS_KB as PRINT_BUDGETS_KB } from "../scripts/guards/18-print-workspace.mjs";

/**
 * The guard plug-in contract of check-bundles.mjs, run against a fake dist in a
 * temp folder. The loader runs in a child node process: the test runner rewrites import(),
 * which cannot see a temp folder.
 */

const LOADER = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../scripts/guards/lib/loader.mjs")).href;

const DRIVER = `
import { effectiveBudgets, loadGuards, runGuards } from ${JSON.stringify(LOADER)};
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const [root, baseJson] = process.argv.slice(1);
const dist = join(root, "dist");
const problems = [];
const guards = await loadGuards(join(root, "scripts", "guards"));
const budgets = effectiveBudgets(JSON.parse(baseJson), guards, problems);
const files = readdirSync(dist).filter((name) => name.endsWith(".js"));
const ctx = {
  dist, files,
  read: (name) => readFileSync(join(dist, name), "utf8"),
  chunksOf: (base) => files.filter((name) => name.startsWith(base + "-")),
  expect: (ok, message) => { if (!ok) problems.push(message); },
  sizeKb: (name) => statSync(join(dist, name)).size / 1024
};
await runGuards(guards, ctx, problems);
console.log(JSON.stringify({ names: guards.map((guard) => guard.name), budgets, problems }));
`;

function run(guardFiles: Record<string, string>, base: Record<string, number> = {}) {
  const root = mkdtempSync(join(tmpdir(), "check-bundles-"));
  mkdirSync(join(root, "dist"), { recursive: true });
  if (Object.keys(guardFiles).length > 0) {
    mkdirSync(join(root, "scripts", "guards"), { recursive: true });
  }
  writeFileSync(join(root, "dist", "datum-form.js"), "x".repeat(2048));
  for (const [name, text] of Object.entries(guardFiles)) {
    writeFileSync(join(root, "scripts", "guards", name), text);
  }
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", DRIVER, root, JSON.stringify(base)], { encoding: "utf8" });
  return JSON.parse(out) as { names: string[]; budgets: Record<string, number>; problems: string[] };
}

describe("check-bundles guard plug-ins", () => {
  it("treats a missing guards folder as no guards", () => {
    const result = run({}, { "datum-form.js": 549 });
    expect(result.names).toEqual([]);
    expect(result.problems).toEqual([]);
    expect(result.budgets).toEqual({ "datum-form.js": 549 });
  });

  it("runs passing guards in name order with the context", () => {
    const result = run({
      "b.mjs": `export default (ctx) => ctx.expect(ctx.sizeKb("datum-form.js") === 2, "b size");`,
      "a.mjs": `export default (ctx) => ctx.expect(ctx.read("datum-form.js").length === 2048 && ctx.files.length === 1, "a read");`
    });
    expect(result.names).toEqual(["a.mjs", "b.mjs"]);
    expect(result.problems).toEqual([]);
  });

  it("reports a failing guard through expect", () => {
    expect(run({ "fail.mjs": `export default (ctx) => ctx.expect(false, "nope");` }).problems).toEqual(["nope"]);
  });

  it("reports a guard that throws or exports no function", () => {
    const result = run({ "boom.mjs": `export default () => { throw new Error("bad"); };`, "none.mjs": `export const budgets = {};` });
    expect(result.problems).toEqual(["guards/boom.mjs threw: bad", "guards/none.mjs has no default-exported function"]);
  });

  it("takes the minimum budget and rejects a raise", () => {
    const result = run(
      {
        "lower.mjs": `export default () => {}; export const budgets = { "datum-form.js": 500, "datum-new.js": 10 };`,
        "raise.mjs": `export default () => {}; export const budgets = { "datum-builder.js": 2000, "datum-form.js": 520 };`
      },
      { "datum-form.js": 549, "datum-builder.js": 1490 }
    );
    expect(result.budgets).toEqual({ "datum-form.js": 500, "datum-builder.js": 1490, "datum-new.js": 10 });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toContain("raises the datum-builder.js budget");
  });
});

describe("the entry and its core chunk", () => {
  it("names a core chunk by its entry and a hash, and no lazy chunk", () => {
    expect(CORE_CHUNK.test("datum-form-core-Dbmsrqj9.js")).toBe(true);
    expect(CORE_CHUNK.test("datum-builder-core-CuI8dQMn.js")).toBe(true);
    expect(CORE_CHUNK.test("datum-builder-core-CuI8dQMn.js.map")).toBe(false);
    expect(CORE_CHUNK.test("datum-builder-data-surface-BA6xMos9.js")).toBe(false);
    expect(CORE_CHUNK.test("datum-pdf-core-Dbmsrqj9.js")).toBe(false);
  });

  it("reads the pair for an entry (text, size, source maps) and the file alone for anything else", () => {
    const dist = mkdtempSync(join(tmpdir(), "check-bundles-core-"));
    const map = (sources: string[]) => JSON.stringify({ version: 3, sources, mappings: "" });
    writeFileSync(join(dist, "datum-form.js"), "a".repeat(1024));
    writeFileSync(join(dist, "datum-form.js.map"), map(["../../../engine/form-engine/a.ts"]));
    writeFileSync(join(dist, "datum-form-core-AAAAAAAA.js"), "b".repeat(2048));
    writeFileSync(join(dist, "datum-form-core-AAAAAAAA.js.map"), map(["../../../engine/form-engine/b.ts"]));
    writeFileSync(join(dist, "datum-form-pdf-service-BBBBBBBB.js"), "c".repeat(512));
    const files = ["datum-form.js", "datum-form-core-AAAAAAAA.js", "datum-form-pdf-service-BBBBBBBB.js"];
    const problems: string[] = [];
    const read = (name: string): string => readFileSync(join(dist, name), "utf8");
    const readers = bundleReaders({ dist, files, read, expect: (ok: boolean, message: string) => ok || problems.push(message) });
    expect(readers.coreOf("datum-form")).toEqual(["datum-form-core-AAAAAAAA.js"]);
    expect(readers.coreOf("datum-builder")).toEqual([]);
    expect(readers.entryText("datum-form.js")).toBe(`${"a".repeat(1024)}\n${"b".repeat(2048)}`);
    expect(readers.entryText("datum-form-pdf-service-BBBBBBBB.js")).toBe("c".repeat(512));
    expect(readers.entryKb("datum-form.js")).toBe(3);
    expect(readers.sourcesOf("datum-form.js")).toEqual(["engine/form-engine/a.ts", "engine/form-engine/b.ts"]);
    expect(problems).toEqual([]);
    readers.sourcesOf("datum-form-pdf-service-BBBBBBBB.js");
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/^datum-form-pdf-service-BBBBBBBB\.js\.map is missing; .*DATUM_SOURCE_MAPS=1/);
  });
});

describe("the Print workspace guard (18)", () => {
  // check-bundles.mjs's context over a fake dist.
  const run = (files: Record<string, string>): string[] => {
    const dist = mkdtempSync(join(tmpdir(), "check-bundles-print-"));
    for (const [name, text] of Object.entries(files)) {
      writeFileSync(join(dist, name), text);
    }
    const names = readdirSync(dist).filter((name) => name.endsWith(".js"));
    const problems: string[] = [];
    const read = (name: string): string => readFileSync(join(dist, name), "utf8");
    const expectFn = (ok: boolean, message: string): boolean | number => ok || problems.push(message);
    printGuard({
      dist,
      files: names,
      read,
      chunksOf: (base: string) => names.filter((name) => name.startsWith(`${base}-`) && !CORE_CHUNK.test(name)),
      expect: expectFn,
      sizeKb: (name: string) => statSync(join(dist, name)).size / 1024,
      ...bundleReaders({ dist, files: names, read, expect: expectFn })
    });
    return problems;
  };
  const SURFACE = 'export const s="<div data-print-sheet></div>";';
  const good = (): Record<string, string> => ({
    "datum-form.js": "export{};",
    "datum-builder.js": 'export{};go("./datum-builder-print-surface-AAAAAAAA.js");',
    "datum-builder-core-CCCCCCCC.js": "export const core=1;",
    "datum-builder-print-surface-AAAAAAAA.js": SURFACE
  });

  it("passes the surface in its own lazy chunk, under its budget", () => {
    expect(run(good())).toEqual([]);
    expect(PRINT_BUDGETS_KB.length).toBe(1);
  });

  it("fails the surface in the builder's entry or its core chunk, or in the renderer", () => {
    expect(run({ ...good(), "datum-builder-core-CCCCCCCC.js": SURFACE }).join("\n")).toMatch(/datum-builder\.js \(with its core chunk\) carries the Print workspace/);
    expect(run({ ...good(), "datum-form.js": SURFACE }).join("\n")).toMatch(/datum-form\.js \(with its core chunk\) carries the builder's Print workspace/);
  });

  it("fails a missing chunk and one over its budget", () => {
    const files = good();
    delete files["datum-builder-print-surface-AAAAAAAA.js"];
    expect(run(files).join("\n")).toMatch(/exactly one datum-builder-\*\.js chunk should carry the Print workspace/);
    const budget = PRINT_BUDGETS_KB[0]![1] as number;
    expect(run({ ...good(), "datum-builder-print-surface-AAAAAAAA.js": SURFACE + "x".repeat(Math.ceil((budget + 1) * 1024)) }).join("\n")).toMatch(/over its \d+ KB budget/);
  });
});
