import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { describe, expect, it } from "vitest";

import { programFromText } from "../src/runners/program/load-program.js";
import type { Report, VectorResult } from "../src/report/model.js";
import { runSuite } from "../src/run.js";
import { VECTOR_SET_ID } from "../src/version.js";
import { VECTORS } from "../src/vectors/index.js";
import { builtProgramText, mutantProgramText, wrapEntryPoint } from "./helpers/programs.js";

/**
 * TST: the `test` op of `__datum_inspect`. The doubles below are made from
 * the program built from this checkout.
 */
const TST = VECTORS.filter((vector) => vector.class === "test");
const IDS = TST.map((vector) => vector.id);

/** A program whose `__datum_inspect` does not know the op. */
const REFUSES_TEST = `function (original) {
  return function (text) {
    var request;
    try { request = JSON.parse(text); } catch (error) { return original(text); }
    if (request && request.op === "test") {
      return JSON.stringify({ ok: false, error: { code: "invalid_request", message: 'The op is "public", "check" or "inspect"; the request names "test"' } });
    }
    return original(text);
  };
}`;

const withoutTheOp = (): string => wrapEntryPoint(builtProgramText(), "__datum_inspect", REFUSES_TEST);

async function run(text: string, options: { only?: string[]; gate?: "release" | "full" } = {}): Promise<Report> {
  return runSuite({ program: programFromText(text, "double.js", "file"), only: options.only ?? ["TST"], gate: options.gate ?? "release", heavy: true });
}

const resultOf = (report: Report, id: string): VectorResult => report.results.find((entry) => entry.id === id) as VectorResult;
const variantStatuses = (result: VectorResult): Record<string, string> => Object.fromEntries((result.variants ?? []).map((variant) => [variant.id, variant.status]));

describe("the TST catalogue", () => {
  it("is the test op's vector set: six vectors, enforced, program mode only", () => {
    expect(IDS).toEqual(["TST-01", "TST-02", "TST-03", "TST-04", "TST-05", "TST-06"]);
    for (const vector of TST) {
      expect(vector.gate, vector.id).toEqual({ status: "enforced" });
      expect(vector.applies.endpoint, vector.id).toBe(false);
      expect(vector.applies.parity, vector.id).toBe(false);
      expect(vector.provenance.tests.map((test) => test.path), vector.id).toContain("engine/tests/form-tests/kernel-test-op.test.ts");
    }
    expect(VECTOR_SET_ID).toBe("2026.11.15-2");
  });

  it("builds its big inputs when a run needs them: no request in the catalogue is over a few KiB", () => {
    for (const vector of TST) {
      for (const input of [vector.input, ...(vector.variants ?? []).flatMap((variant) => (variant.input !== undefined ? [variant.input] : []))]) {
        expect(JSON.stringify(input).length, vector.id).toBeLessThan(8 * 1024);
      }
    }
  });
});

describe("the TST vectors on the program built from this checkout", () => {
  it("are enforced and every vector and variant PASSes", async () => {
    const report = await run(builtProgramText());
    expect(report.program?.detectedAbi).toBe(WASM_ABI_VERSION);
    expect(report.results.map((entry) => `${entry.id} ${entry.status} ${entry.gate}`)).toEqual(IDS.map((id) => `${id} PASS enforced`));
    expect(variantStatuses(resultOf(report, "TST-01"))).toEqual({ "empty-sidecar": "PASS", "parse-problem-is-listed": "PASS", "list-set-on-a-text-field-is-refused": "PASS", "list-in-an-added-row-cell-is-refused": "PASS", "list-in-an-added-checkbox-cell-is-stored-as-the-group": "PASS", "scenario-that-cannot-start-is-an-error": "PASS" });
    expect(variantStatuses(resultOf(report, "TST-02"))).toEqual({ "sidecar-replaces-entries": "PASS", "no-tests-block-is-an-empty-report": "PASS" });
    expect(variantStatuses(resultOf(report, "TST-03"))).toEqual({ "201-scenarios": "PASS", "1001-statements": "PASS", "entries-together-over-256-KiB": "PASS", "definition-over-a-size-cap": "PASS" });
    expect(variantStatuses(resultOf(report, "TST-04"))).toEqual({ "major-next": "PASS", "no-abi": "PASS", "tests-is-a-number": "PASS", "tests-is-a-list": "PASS" });
    expect(variantStatuses(resultOf(report, "TST-06"))).toEqual({ "1000-statements": "PASS" });
  }, 120_000);

  it("skips the heavy at-the-cap row unless asked for", async () => {
    const report = await runSuite({ program: programFromText(builtProgramText(), "built.js", "file"), only: ["TST-06"], gate: "release" });
    expect(report.results.map((entry) => `${entry.id} ${entry.status}`)).toEqual(["TST-06 SKIP"]);
  }, 60_000);
});

describe("the TST vectors catch a program that does less", () => {
  it("a program without the op fails the rows that run it", async () => {
    const report = await run(withoutTheOp());
    expect(report.program?.detectedAbi).toBe(WASM_ABI_VERSION);
    for (const id of ["TST-01", "TST-02", "TST-03", "TST-06"]) {
      const entry = resultOf(report, id);
      expect(entry.status, id).toBe("FAIL");
      expect(entry.gate, id).toBe("enforced");
    }
    expect(report.verdict).toBe("FAIL");
  }, 120_000);

  it("a program with no scenario cap fails the 201-scenario row and nothing else of TST-03", async () => {
    const lax = mutantProgramText({ kernelFormTestOpMaxScenarios: "function () { return 100000; }" });
    const report = await run(lax, { only: ["TST-03"] });
    expect(variantStatuses(resultOf(report, "TST-03"))).toEqual({ "201-scenarios": "FAIL", "1001-statements": "PASS", "entries-together-over-256-KiB": "PASS", "definition-over-a-size-cap": "PASS" });
  }, 120_000);

  it("a program with no statement cap fails the 1,001-statement row", async () => {
    const lax = mutantProgramText({ kernelFormTestOpMaxSteps: "function () { return 100000; }" });
    const report = await run(lax, { only: ["TST-03"] });
    expect(variantStatuses(resultOf(report, "TST-03"))["1001-statements"]).toBe("FAIL");
  }, 120_000);

  it("a program with no size cap fails the oversize-text row and the entries row", async () => {
    const lax = mutantProgramText({ kernelFormTestOpMaxBytes: "function () { return 1e9; }" });
    const report = await run(lax, { only: ["TST-03"] });
    const result = resultOf(report, "TST-03");
    expect(result.status).toBe("FAIL");
    expect(variantStatuses(result)["entries-together-over-256-KiB"]).toBe("FAIL");
  }, 120_000);
});
