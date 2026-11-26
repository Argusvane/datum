// @vitest-environment node
// The kit run for real: Chromium through Playwright, the reference and the binding on the pinned
// GOV.UK release. Skipped where Playwright has no Chromium (the usual CI case).
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, REPO, load } from "./load.js";

const chromium = ((): string | undefined => {
  try {
    const path = (createRequire(import.meta.url)("playwright") as { chromium: { executablePath(): string } }).chromium.executablePath();
    return existsSync(path) ? path : undefined;
  } catch {
    return undefined;
  }
})();

const quiet = (): { lines: string[]; log: (line: string) => void } => {
  const lines: string[] = [];
  return { lines, log: (line) => { lines.push(line); } };
};

describe.skipIf(chromium === undefined)("kit run (Chromium)", () => {
  it("equality: a GOV.UK reference case equals what the binding draws (a case marked known is reported, never failed)", async () => {
    const { runEquality } = await load(join(KIT, "equality.mjs"));
    const out = quiet();
    const result = await runEquality("govuk", { only: ["input-hint", "input-disabled"], log: out.log });
    expect(result.exit, out.lines.join("\n")).toBe(0);
    const byId = Object.fromEntries(result.cases.map((c: { id: string; status: string }) => [c.id, c.status]));
    // input-disabled was a documented difference while the binding differed; it passes once the binding closes it, and is never a failure either way.
    expect(byId["input-hint"]).toBe("pass");
    expect(["pass", "known"]).toContain(byId["input-disabled"]);
  }, 90_000);

  it("equality: Datum has no reference and says so; nothing to assert is exit 2", async () => {
    const { runEquality } = await load(join(KIT, "equality.mjs"));
    const out = quiet();
    expect((await runEquality("datum", { log: out.log })).exit).toBe(0);
    expect(out.lines.join()).toMatch(/Datum is the reference/);
    const none = await runEquality("govuk", { only: ["no-such-case"], log: out.log });
    expect(none.exit).toBe(2);
  }, 60_000);

  it("behaviour: the autocomplete token and an autofilled select reach the answer, under Datum's own binding", async () => {
    const { runBehaviour } = await load(join(KIT, "behaviour.mjs"));
    const out = quiet();
    const result = await runBehaviour("datum", { only: ["AF-02", "AF-03", "MV-01"], log: out.log });
    expect(result.exit, out.lines.join("\n")).toBe(0);
    expect(result.summary).toMatchObject({ pass: 3, fail: 0 });
  }, 90_000);

  it("binding lint: a fallbackTokens name without its dashes, an unknown token and an adapter with no template are reported", async () => {
    const root = mkdtempSync(join(tmpdir(), "kit-lint-"));
    try {
      const dir = join(root, "lint-ds");
      const made = spawnSync(process.execPath, [join(REPO, "scripts", "new-binding.mjs"), "lint-ds", "--design-system", "Lint", "--release", "1.0.0", "--dir", dir], { encoding: "utf8" });
      expect(made.status, made.stderr).toBe(0);
      const index = join(dir, "src", "index.ts");
      writeFileSync(index, readFileSync(index, "utf8").replace("fallbackTokens: {},", `fallbackTokens: { "color-text": "red", "--no-such-token": "blue", "--color-muted": "gray" }, components: { text: { kind: "field" } as never },`).replace("  components: {},\n", ""));
      const { openSession } = await load(join(KIT, "lib", "session.mjs"));
      const { resolveBinding } = await load(join(KIT, "lib", "binding-package.mjs"));
      const session = await openSession(resolveBinding(dir));
      try {
        const problems: string[] = await session.lint();
        expect(problems.join("\n")).toMatch(/"color-text": a token name starts with two dashes/);
        expect(problems.join("\n")).toMatch(/"--no-such-token": not a Datum token/);
        expect(problems.join("\n")).toMatch(/components "text": the field adapter has no template function/);
        expect(problems.join("\n")).not.toMatch(/--color-muted/);
      } finally {
        await session.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 90_000);
});
