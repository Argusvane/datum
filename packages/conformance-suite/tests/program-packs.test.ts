import { describe, expect, it } from "vitest";

import { runSuite } from "../src/run.js";
import { VECTORS } from "../src/vectors/index.js";
import { builtProgram } from "./helpers/programs.js";

/**
 * The vector packs against the program built from this checkout: every enforced vector passes,
 * every pending one is XFAIL or XPASS (never FAIL), every heavy one passes when asked for.
 */
// The DEF class has its own test (definition-vectors.test.ts).
const programVectors = VECTORS.filter((vector) => vector.applies.program !== false && vector.class !== "definition");
const ids = (filter: (vector: (typeof programVectors)[number]) => boolean): string[] => programVectors.filter(filter).map((vector) => vector.id);

describe("the program packs (RES, OPT, FIL, CTX, CAN, SEC)", () => {
  it("passes every enforced, non-heavy vector; an advisory vector may only warn, and the known gaps are the ones pinned here", async () => {
    const wanted = ids((vector) => vector.gate.status !== "pending" && (vector.applies.program as { heavy?: boolean }).heavy !== true && /^(RES|OPT|FIL|CTX|CAN|SEC)-/.test(vector.id));
    const report = await runSuite({ program: builtProgram(), only: wanted });
    expect(report.results).toHaveLength(wanted.length);
    const advisory = new Set(ids((vector) => vector.gate.status === "advisory"));
    const odd = report.results.filter((result) => result.status !== "PASS" && !(advisory.has(result.id) && result.status === "WARN"));
    expect(odd.map((result) => `${result.id} ${result.status}: ${result.notes ?? ""}`)).toEqual([]);
    // A known gap (S4, author-side): `inspect` lists the function names of secret rules.
    expect(report.results.filter((result) => result.status === "WARN").map((result) => result.id)).toEqual(["SEC-04"]);
  });

  it("holds the decided vectors as enforced; only PAR-06 stays pending", () => {
    for (const id of ["ISO-04", "RES-02", "RES-19", "RES-20", "OPT-11", "OPT-12", "OPT-13", "REC-12", "JRN-07"]) {
      expect(VECTORS.find((vector) => vector.id === id)?.gate.status, id).toBe("enforced");
    }
    const blocked = Object.fromEntries(VECTORS.filter((vector) => vector.gate.status === "pending").map((vector) => [vector.id, vector.gate.status === "pending" ? vector.gate.blockedBy : ""]));
    expect(Object.keys(blocked)).toEqual(["PAR-06"]);
  });

  it("runs the data grid's row count and the definition rows as enforced on the program built from source, and they PASS", async () => {
    expect(programVectors.filter((vector) => vector.gate.status === "pending").map((vector) => vector.id)).toEqual([]);
    const grid = await runSuite({ program: builtProgram(), only: ["OPT-14"] });
    expect(grid.results.map((result) => `${result.id} ${result.status} ${result.gate}`)).toEqual(["OPT-14 PASS enforced"]);
    expect(grid.results[0]?.variants?.map((variant) => `${variant.id} ${variant.status}`)).toEqual([
      "empty-rows-count PASS",
      "one-empty-row PASS",
      "too-many PASS",
      "formula-minimum PASS",
      "formula-not-a-whole-number PASS",
      "no-maximum-held-to-the-row-cap PASS",
      "no-maximum-500-rows-pass PASS",
      "hidden-grid-held-to-the-row-cap PASS",
      "hidden-grid-own-maximum-not-checked PASS"
    ]);
    // DEF-13 (9,000 duplicate ids, a 1 s bound) is left to definition-vectors.test.ts: a loaded machine interrupts it (a known flake of that bound, not of the gate).
    const definition = VECTORS.filter((vector) => vector.class === "definition" && vector.applies.program !== false && vector.id !== "DEF-13").map((vector) => vector.id);
    expect(definition.length).toBeGreaterThan(0);
    const report = await runSuite({ program: builtProgram(), only: definition });
    expect(report.results.map((result) => `${result.id} ${result.status}`)).toEqual(definition.map((id) => `${id} PASS`));
    expect(report.results.every((result) => result.gate === "enforced")).toBe(true);
  }, 120_000);

  it("scales its time bounds with the budget profile: node 3 x 250 ms for a runaway plugin", async () => {
    const node = await runSuite({ program: builtProgram(), only: ["RES-01"] });
    expect(node.results[0]).toMatchObject({ status: "PASS", limitMs: 750 });
    expect(node.program?.budgetProfile).toBe("node");
    const browser = await runSuite({ program: builtProgram(), only: ["RES-01"], budgetProfile: "browser" });
    expect(browser.results[0]).toMatchObject({ status: "PASS", limitMs: 750 });
    expect(browser.program?.budgetProfile).toBe("browser");
  }, 30_000);

  it("pins every golden document as a CAN-02 row", async () => {
    const { BUNDLED_GOLDEN } = await import("../src/fixtures/golden.js");
    const names = BUNDLED_GOLDEN.documents.map((entry) => entry.name.replace(/[^a-z0-9]+/gi, "-").toLowerCase());
    const can02 = VECTORS.find((vector) => vector.id === "CAN-02");
    expect(names).toHaveLength(20);
    expect(["numbers", ...(can02?.variants ?? []).map((variant) => variant.id)]).toEqual(names);
  });
});
