import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { programFromText } from "../src/runners/program/load-program.js";
import type { Report, VectorResult } from "../src/report/model.js";
import { runSuite } from "../src/run.js";
import { REPO_ROOT } from "./helpers/paths.js";
import { baseRoot } from "../src/fixtures/base-form.js";
import { ProgramSession } from "../src/runners/program/session.js";
import { builtProgramText } from "./helpers/programs.js";

/**
 * JRN in program mode: the exit page, skipped-page values, hostile journey ids, smuggled request
 * members, and a calculation over the settled view (JRN-05), each judged against a program file.
 */
async function run(text: string, only: string[] = ["JRN"]): Promise<Report> {
  return runSuite({ program: programFromText(text, "journeys.js", "file"), only, gate: "full", heavy: true });
}

const resultOf = (report: Report, id: string): VectorResult => report.results.find((entry) => entry.id === id) as VectorResult;
const variantStatuses = (result: VectorResult): Record<string, string> => Object.fromEntries((result.variants ?? []).map((variant) => [variant.id, variant.status]));

/** The program the tests run against: the one built from source. */
async function programText(): Promise<string> {
  return builtProgramText();
}

describe("the program-mode JRN vectors against the program built from source", () => {
  it("passes the enforced rows, JRN-05 included", async () => {
    const report = await run(await programText());
    // The endpoint-only vectors (JRN-07) do not apply to a program file and are not in its report.
    expect(report.results.map((entry) => entry.id)).toEqual(["JRN-01", "JRN-02", "JRN-03", "JRN-04", "JRN-05"]);
    for (const id of ["JRN-01", "JRN-02", "JRN-03", "JRN-04"]) {
      expect(resultOf(report, id).status, `${id}: ${resultOf(report, id).notes ?? ""}`).toBe("PASS");
    }
    expect(resultOf(report, "JRN-05").status, resultOf(report, "JRN-05").notes ?? "").toBe("PASS");
    expect(report.verdict).toBe("PASS");
  }, 120_000);

  it("reads the row by row outcomes: the exit page by every route, the skipped page's values dropped, the hostile ids refused", async () => {
    const report = await run(await programText(), ["JRN-01", "JRN-02", "JRN-03", "JRN-04"]);
    expect(variantStatuses(resultOf(report, "JRN-01"))).toEqual({ "two-hops-to-the-exit": "PASS", "an-unconditional-route-to-the-exit": "PASS", "control-an-honest-path-is-accepted": "PASS" });
    expect(resultOf(report, "JRN-01").observed).toMatchObject({ kind: "verdict", accepted: false, errors: [{ code: "journey.exit" }] });
    expect(variantStatuses(resultOf(report, "JRN-02"))).toEqual({ "a-required-field-on-a-skipped-page-is-not-asked": "PASS", "control-the-page-on-the-path-keeps-its-values": "PASS" });
    expect(Object.values(variantStatuses(resultOf(report, "JRN-03"))).every((status) => status === "PASS")).toBe(true);
    expect(Object.keys(variantStatuses(resultOf(report, "JRN-03")))).toContain("a-proto-named-journey-is-only-a-label");
    expect(Object.values(variantStatuses(resultOf(report, "JRN-04"))).every((status) => status === "PASS")).toBe(true);
  }, 120_000);
});

describe("mutation tests: a program that does not end a path at the exit page", () => {
  /** The real program with the exit check turned off: `fold.trace.end === "exit"` becomes `false`. The test fails loudly when the pattern is gone. */
  async function noExitProgram(): Promise<string> {
    const pattern = 'fold.trace.end === "exit"';
    const text = await programText();
    if (!text.includes(pattern)) {
      throw new Error("mutant program: the built program no longer contains the exit check; update the pattern");
    }
    return text.replace(pattern, "false");
  }

  it("FAILs JRN-01 on the named journey, the two-hop and the unconditional routes, and JRN-04's smuggling row; the controls keep passing", async () => {
    const report = await run(await noExitProgram(), ["JRN-01", "JRN-02", "JRN-03", "JRN-04"]);
    const jrn01 = resultOf(report, "JRN-01");
    expect(jrn01.status).toBe("FAIL");
    expect(variantStatuses(jrn01)).toEqual({ "two-hops-to-the-exit": "FAIL", "an-unconditional-route-to-the-exit": "FAIL", "control-an-honest-path-is-accepted": "PASS" });
    expect(jrn01.notes).toMatch(/\(base\): wanted rejected, got accepted/);
    expect(resultOf(report, "JRN-04").status).toBe("FAIL");
    expect(variantStatuses(resultOf(report, "JRN-04"))["members-that-name-no-exit-or-skip"]).toBe("FAIL");
    // The other journey rules are separate code: they still hold.
    expect(resultOf(report, "JRN-02").status).toBe("PASS");
    expect(resultOf(report, "JRN-03").status).toBe("PASS");
    expect(report.verdict).toBe("FAIL");
  }, 120_000);

  it("a program that answers the raw values instead of the judged view fails JRN-02 and not JRN-01", async () => {
    // The fold's `submittable` is the judged view the outcome's values come from; this mutant answers what was sent.
    const pattern = "values = { ...fold.submittable };";
    const text = await programText();
    if (!text.includes(pattern)) {
      throw new Error("mutant program: the built program no longer builds its values from the fold; update the pattern");
    }
    const report = await run(text.replace(pattern, "values = { ...values };"), ["JRN-01", "JRN-02"]);
    expect(resultOf(report, "JRN-02").status).toBe("FAIL");
    expect(resultOf(report, "JRN-02").notes).toMatch(/SKIPPEDZZ/);
    expect(resultOf(report, "JRN-01").status).toBe("PASS");
  }, 120_000);
});
