import { describe, expect, it } from "vitest";

import { compactObservation } from "../src/compact.js";
import type { Observation } from "../src/observation.js";

describe("compactObservation (the report keeps a bounded view)", () => {
  const verdict = (extra: Partial<Extract<Observation, { kind: "verdict" }>>): Observation => ({ kind: "verdict", accepted: false, errors: [], ...extra });

  it("leaves a small observation, a refusal and nothing alone", () => {
    const small = verdict({ errors: [{ code: "required", field: "a" }], values: { a: 1 }, raw: { errors: [] } });
    expect(compactObservation(small)).toBe(small);
    const refusal: Observation = { kind: "refusal", refusal: "budget", detail: "x" };
    expect(compactObservation(refusal)).toBe(refusal);
    expect(compactObservation(null)).toBeNull();
  });

  it("cuts a 70,000-entry error list and an outcome of megabytes, and says how much", () => {
    const big = verdict({
      errors: Array.from({ length: 70_000 }, (_, at) => ({ code: "required", field: `rows[${at}].sku` })),
      raw: { errors: Array.from({ length: 70_000 }, () => ({ code: "required" })) },
      values: { text: "x".repeat(50_000) },
      canonical: "y".repeat(10_000),
      logs: [{ level: "error", message: "z".repeat(5000) }]
    });
    const cut = compactObservation(big);
    expect(cut?.kind).toBe("verdict");
    if (cut?.kind !== "verdict") {
      return;
    }
    expect(cut.errors).toHaveLength(40);
    expect(cut.meta).toMatchObject({ errorCount: 70_000, outcomeCut: true, valuesCut: true });
    expect(cut.canonical?.length).toBeLessThan(2100);
    expect(cut.logs?.[0]?.message.length).toBeLessThan(2100);
    expect(JSON.stringify(cut).length).toBeLessThan(10_000);
    // The original is untouched: judgement ran on the whole observation.
    expect(big.kind === "verdict" && big.errors.length).toBe(70_000);
  });
});
