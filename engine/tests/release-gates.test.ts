import { describe, expect, it } from "vitest";

import { evaluateReleaseGates } from "../form-engine/verification/release-gates.js";

describe("release gates", () => {
  it("passes when all checks satisfy configured gates", () => {
    const report = evaluateReleaseGates({
      deterministicVectorParityPassed: true,
      performanceBudgets: [
        { name: "builder-large-form", observedMs: 180, budgetMs: 250 },
        { name: "runtime-large-form", observedMs: 90, budgetMs: 120 }
      ],
      security: {
        wasmSandboxIsolation: true,
        pluginFailureIsolation: true
      }
    });

    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails when any gate fails", () => {
    const report = evaluateReleaseGates({
      deterministicVectorParityPassed: false,
      performanceBudgets: [{ name: "runtime-large-form", observedMs: 400, budgetMs: 120 }],
      security: {
        wasmSandboxIsolation: true,
        pluginFailureIsolation: false
      }
    });

    expect(report.passed).toBe(false);
    expect(report.checks.some((check) => check.name === "deterministic-vector-parity" && !check.passed)).toBe(true);
    expect(
      report.checks.some((check) => check.name === "performance:runtime-large-form" && !check.passed)
    ).toBe(true);
    expect(
      report.checks.some((check) => check.name === "security:plugin-failure-isolation" && !check.passed)
    ).toBe(true);
  });
});
