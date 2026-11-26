// @vitest-environment node
// `known` in binding-check.json: a behaviour case that fails because of a defect of the design system itself is reported as
// known with its reason (the step exits 0), a listed case that passes is a problem (exit 1), and an id that matches no case of
// the behaviour suite or the conformance suite is refused. The session is a stub: the page answers what AF-03 asks for, or nothing.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { KIT, load } from "./load.js";

const known = (...cases: string[]) => cases.map((id) => ({ case: id, reason: "the design system throws on its own", since: "2026-11-14" }));
const pkg = (list: unknown[]) => ({ id: "demo", isDatum: false, assets: { known: list }, assetsFile: "bindings/demo/binding-check.json" });

/** A session whose page answers AF-03's questions: `autocomplete` tokens when `drawn`, null (no control) when not. */
function session(drawn: boolean) {
  const page = {
    evaluate: async (expr: string) => {
      if (expr.startsWith("kit.events")) return [];
      if (expr.includes("controlAttributes")) return drawn ? { autocomplete: expr.includes('"name"') ? "name" : "email" } : null;
      return null;
    }
  };
  return {
    browser: { version: "stub" },
    takeOffline: () => ({ notes: [], problems: [] }),
    assets: {},
    newPage: async () => ({ page, bcInfo: { types: { text: [] } }, console: [], close: async () => undefined })
  };
}

describe("behaviour: known defects", () => {
  it("reports a listed failing case as known with its reason, counted apart from fail", async () => {
    const { runBehaviour } = await load(join(KIT, "behaviour.mjs"));
    const lines: string[] = [];
    const result = await runBehaviour(pkg(known("AF-03")), { session: session(false), only: ["AF-03"], log: (line: string) => lines.push(line) });
    expect(result.cases[0]).toMatchObject({ id: "AF-03", status: "known", known: "the design system throws on its own" });
    expect(result.summary).toEqual({ pass: 0, fail: 0, skip: 0, known: 1 });
    expect(lines.join("\n")).toContain("known defect AF-03: the design system throws on its own (since 2026-11-14)");
    expect(lines.join("\n")).toContain("still fails: a field drew no control");
    expect(lines.at(-1)).toBe("behaviour demo: 0 pass, 0 fail, 0 skip, 1 known");
    // Only known cases ran: nothing was asserted, which is exit 2 as for any run with no pass (a real run has passes beside them).
    expect(result.exit).toBe(2);
  });

  it("keeps the failure path for a case that is not listed", async () => {
    const { runBehaviour } = await load(join(KIT, "behaviour.mjs"));
    const result = await runBehaviour(pkg([]), { session: session(false), only: ["AF-03"], log: () => undefined });
    expect(result.cases[0]).toMatchObject({ status: "fail", reason: "a field drew no control" });
    expect(result.exit).toBe(1);
  });

  it("reports a listed case that passes as a problem, exit 1", async () => {
    const { runBehaviour } = await load(join(KIT, "behaviour.mjs"));
    const result = await runBehaviour(pkg(known("AF-03")), { session: session(true), only: ["AF-03"], log: () => undefined });
    expect(result.cases[0].status).toBe("fail");
    expect(result.cases[0].reason).toContain("listed as known but passes: remove it");
    expect(result.exit).toBe(1);
  });

  it("refuses an id that matches no case of either suite, and accepts a case of each", async () => {
    const { knownOf } = await load(join(KIT, "behaviour.mjs"));
    expect(() => knownOf(pkg(known("MV-99")))).toThrow(/known\[0\]: MV-99 matches no case of the behaviour suite or the conformance suite/);
    expect(knownOf(pkg(known("MV-01", "VAL-01"))).map((entry: { case: string }) => entry.case)).toEqual(["MV-01", "VAL-01"]);
  });
});
