import { describe, expect, it } from "vitest";

import { runSuite } from "../src/run.js";
import { VECTORS } from "../src/vectors/index.js";
import { builtProgram } from "./helpers/programs.js";

describe("the heavy vectors (--heavy)", () => {
  const heavy = VECTORS.filter((vector) => vector.applies.program !== false && (vector.applies.program as { heavy?: boolean }).heavy === true).map((vector) => vector.id);

  it("are the 20,000 and 70,000-row runs, the 400-definition series and the test op run at its caps (TST-06, 200 scenarios)", () => {
    expect(heavy).toEqual(["RES-10", "RES-16", "RES-17", "TST-06"]);
  });

  it("are skipped by default and pass when asked for", async () => {
    const skipped = await runSuite({ program: builtProgram(), only: heavy });
    expect(skipped.results.map((result) => result.status)).toEqual(["SKIP", "SKIP", "SKIP", "SKIP"]);
    const report = await runSuite({ program: builtProgram(), only: heavy, heavy: true });
    expect(report.results.map((result) => `${result.id} ${result.status}: ${result.notes ?? ""}`)).toEqual(heavy.map((id) => `${id} PASS: `));
    // The report keeps a bounded view of the verdict; under the 10,000-error cap a 70,000-row run reports 10,000 errors and the errors.truncated marker.
    const big = report.results.find((result) => result.id === "RES-17");
    expect(JSON.stringify(big).length).toBeLessThan(200_000);
    expect(big?.observed).toMatchObject({ kind: "verdict", meta: { errorCount: 10001 } });
  }, 120_000);
});
