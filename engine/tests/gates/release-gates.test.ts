import { describe, expect, it } from "vitest";

import { collectReleaseGateInputs } from "../../form-engine/verification/gate-inputs.js";
import { evaluateReleaseGates } from "../../form-engine/verification/release-gates.js";

const reportNames = (report: ReturnType<typeof evaluateReleaseGates>): string[] => report.checks.map((check) => check.name);

describe("release gates (real inputs)", () => {
  it("passes with the collected inputs from real parity / security / perf checks", async () => {
    const input = await collectReleaseGateInputs({ renderBudgetMs: 250, perfIterations: 5 });

    expect(input.deterministicVectorParityPassed).toBe(true);
    expect(input.security).toEqual({
      wasmSandboxIsolation: true,
      pluginFailureIsolation: true
    });
    // No CSS isolation gate: a form draws in its own shadow root, so there is no scoping pass to check.
    expect(reportNames(evaluateReleaseGates(input))).not.toContain("security:css-isolation-boundary");

    const report = evaluateReleaseGates(input);
    expect(report.passed).toBe(true);
    expect(report.checks.every((check) => check.passed)).toBe(true);
  });

  it("fails when a perf budget is exceeded", async () => {
    const input = await collectReleaseGateInputs({ perfIterations: 5 });
    input.performanceBudgets = [
      { name: "render-model-build-50-fields", observedMs: 999, budgetMs: 1 }
    ];
    const report = evaluateReleaseGates(input);
    expect(report.passed).toBe(false);
    expect(report.checks.find((c) => c.name.startsWith("performance:"))?.passed).toBe(false);
  });

  it("fails when a security check is tripped", async () => {
    const input = await collectReleaseGateInputs({ perfIterations: 5 });
    input.security.pluginFailureIsolation = false;
    const report = evaluateReleaseGates(input);
    expect(report.passed).toBe(false);
    expect(
      report.checks.find((c) => c.name === "security:plugin-failure-isolation")?.reason
    ).toMatch(/plugin failure isolation/i);
  });
});
