import { describe, expect, it } from "vitest";

import {
  collectReleaseGateInputs,
  coreDeterministicValidator,
  evaluateReleaseGates,
  WasmValidationHost
} from "@argusvane/datum-engine";

import { QuickJsWasmHostAdapter, toSourcePlugin } from "../src/index.js";

describe("release gates with a real QuickJS sandbox", () => {
  it("passes every gate when the wasm runtime is the QuickJS sandbox, not the in-process shim", async () => {
    const host = await WasmValidationHost.create(
      [
        toSourcePlugin({
          id: "core",
          version: "1.0.0",
          validators: [{ id: "core", version: "1.0.0", validate: coreDeterministicValidator }]
        })
      ],
      { adapter: new QuickJsWasmHostAdapter() }
    );

    const inputs = await collectReleaseGateInputs({ wasmValidationHost: host });
    const report = evaluateReleaseGates(inputs);

    const failed = report.checks.filter((check) => !check.passed).map((check) => check.name);
    expect(failed).toEqual([]);
    expect(report.passed).toBe(true);
    expect(report.checks.map((check) => check.name)).toContain("deterministic-vector-parity");
    expect(report.checks.map((check) => check.name)).toContain("security:wasm-sandbox-isolation");
    host.dispose();
  });
});
