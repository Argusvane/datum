import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { Ajv } from "ajv";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { OUTPUT_SAFETY_ABI, pendingReason, runPdfVectors } from "../src/runners/pdf/index.js";
import type { Report, VectorResult } from "../src/report/model.js";
import { REPORT_SCHEMA } from "../src/report/schema.js";
import { VECTORS, matchesSelector } from "../src/vectors/index.js";
import { bidiKeepingMutant, currentKernel, literalFilespecMutant, pdfProgramText, sizeTrustingMutant, PDF_PROGRAM_PATH } from "./helpers/pdf-programs.js";

const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(REPORT_SCHEMA);
const problems = (report: unknown): string[] => (validate(report) ? [] : (validate.errors ?? []).map((error) => `${error.instancePath} ${error.message}`));
const OUT = VECTORS.filter((vector) => vector.class === "output");
const statusOf = (results: VectorResult[], id: string): string => results.find((result) => result.id === id)?.status ?? "missing";
const text = pdfProgramText();
const program = { text: text ?? "", path: PDF_PROGRAM_PATH };

describe("the OUT catalogue", () => {
  it("declares OUT-01..OUT-15 with a predicate, a time bound and no other runner", () => {
    expect(OUT.map((vector) => vector.id)).toEqual(Array.from({ length: 15 }, (_, i) => `OUT-${String(i + 1).padStart(2, "0")}`));
    for (const vector of OUT) {
      expect(vector.predicate, vector.id).toMatch(/\S{10,}/);
      expect(vector.limits.programMs, vector.id).toBeGreaterThan(0);
      expect(vector.applies.program, vector.id).toBe(false);
      expect(vector.applies.endpoint, vector.id).toBe(false);
      expect(vector.attacker === "filler" || vector.attacker === "author", vector.id).toBe(true);
      expect(matchesSelector(vector, "OUT"), vector.id).toBe(true);
      expect(matchesSelector(vector, "output"), vector.id).toBe(true);
    }
  });

  it("reads the pending rule from the ABI", () => {
    expect(pendingReason("0.18.0")).toMatch(/needs 1\.0\.0/);
    expect(pendingReason("2.0.0")).toMatch(/needs 1\.0\.0 or a later version of its major/);
    expect(pendingReason("1.0.0")).toBeNull();
    expect(pendingReason("1.2.1")).toBeNull();
    expect(pendingReason(null)).toMatch(/did not answer/);
    expect(OUTPUT_SAFETY_ABI).toBe("1.0.0");
  });
});

describe("the current kernel source (positive control)", () => {
  it("passes every OUT vector (SKIP only for a missing veraPDF or openssl)", async () => {
    const run = await runPdfVectors({ program, provider: currentKernel(), enforceAbi: false, catalogue: VECTORS });
    expect(run.results).toHaveLength(15);
    for (const result of run.results) {
      expect(["PASS", "SKIP"], `${result.id}: ${result.notes}`).toContain(result.status);
      if (result.status === "SKIP") {
        expect(result.id === "OUT-11" || result.id === "OUT-12", `${result.id}: ${result.notes}`).toBe(true);
      }
    }
    expect(run.report.tools.pdfjs && run.report.tools.pdfLib).toBe(true);
  }, 300_000);
});

describe("a program of another major", () => {
  const otherMajor = { ...currentKernel(), capabilities: async () => ({ abi: "0.18.0", kernelVersion: "0.1.0" }) } as never;
  const stale = { text: "", path: "other.js" };

  it("leaves the whole class pending under the release gate, with the reason, and the verdict is PASS", async () => {
    const run = await runPdfVectors({ program: stale, provider: otherMajor, catalogue: VECTORS });
    expect(run.results).toHaveLength(15);
    for (const result of run.results) {
      expect(result.status).toBe("SKIP");
      expect(result.gate).toBe("pending");
      expect(result.blockedBy).toBe("PDF ABI 1.0.0");
      expect(result.notes).toMatch(/answers PDF ABI 0\.18\.0; the OUT class needs 1\.0\.0/);
    }
    expect(run.report.pending).toMatch(/0\.18\.0/);
  });

  it("runs them under the full gate as XFAIL or XPASS, never FAIL", async () => {
    const run = await runPdfVectors({ program: stale, provider: otherMajor, catalogue: VECTORS, gate: "full", only: ["OUT-06", "OUT-08"] });
    expect(run.results.map((result) => result.status).every((status) => status === "XPASS" || status === "XFAIL")).toBe(true);
  }, 120_000);
});

describe.skipIf(text === undefined)("the built program in packages/pdf-kernel/dist", () => {
  it("answers the current PDF ABI, and every OUT vector passes", async () => {
    const run = await runPdfVectors({ program, catalogue: VECTORS });
    expect(run.report.pending).toBeNull();
    for (const result of run.results) {
      expect(["PASS", "SKIP"], `${result.id}: ${result.notes}`).toContain(result.status);
    }
  }, 300_000);

  it("a program whose attachment budget trusts the declared size FAILs the size-honesty vector only", async () => {
    const mutant = sizeTrustingMutant(text as string);
    expect(mutant, "the size-charging code was not found in the built program; update sizeTrustingMutant").toBeDefined();
    const run = await runPdfVectors({ program: { text: mutant as string, path: "size-trusting-mutant.js" }, enforceAbi: false, catalogue: VECTORS, only: ["OUT-03", "OUT-05"] });
    expect(statusOf(run.results, "OUT-05")).toBe("FAIL");
    expect(run.results.find((r) => r.id === "OUT-05")?.notes).toMatch(/declared size/);
    expect(statusOf(run.results, "OUT-03")).toBe("PASS");
  }, 300_000);

  it("a program that writes the Filespec /F as a literal string again FAILs the Filespec vector", async () => {
    const mutant = literalFilespecMutant(text as string);
    expect(mutant, "the Filespec code was not found in the built program; update literalFilespecMutant").toBeDefined();
    const run = await runPdfVectors({ program: { text: mutant as string, path: "literal-filespec-mutant.js" }, enforceAbi: false, catalogue: VECTORS, only: ["OUT-03", "OUT-05"] });
    expect(statusOf(run.results, "OUT-03")).toBe("FAIL");
    expect(run.results.find((r) => r.id === "OUT-03")?.notes).toMatch(/pdf\.js/);
    expect(statusOf(run.results, "OUT-05")).toBe("PASS");
  }, 300_000);

  it("a program that keeps bidi override controls FAILs the bidi vector", async () => {
    const mutant = bidiKeepingMutant(text as string);
    expect(mutant, "the bidi stripping code was not found in the built program; update bidiKeepingMutant").toBeDefined();
    const run = await runPdfVectors({ program: { text: mutant as string, path: "bidi-mutant.js" }, enforceAbi: false, catalogue: VECTORS, only: ["OUT-06", "OUT-07"] });
    expect(statusOf(run.results, "OUT-06")).toBe("FAIL");
    expect(statusOf(run.results, "OUT-07")).toBe("PASS");
  }, 300_000);
});

describe("the command", () => {
  it("--pdf-program reports a schema-valid pdf section and exits 0 for the built program", async () => {
    if (text === undefined) {
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "datum-out-cli-"));
    const out: string[] = [];
    const code = await runCli(["--pdf-program", PDF_PROGRAM_PATH, "--only", "OUT-08,OUT-06", "--format", "json,md", "--out", dir, "--quiet"], { stdout: (t) => out.push(t), stderr: (t) => out.push(t) });
    const report = JSON.parse(readFileSync(join(dir, "report.json"), "utf8")) as Report;
    expect(problems(report)).toEqual([]);
    expect(report.run.modes).toEqual(["pdf"]);
    expect(report.results.map((result) => result.id)).toEqual(["OUT-06", "OUT-08"]);
    expect(report.pdf?.abi).toMatch(/^\d+\.\d+\.\d+$/);
    expect(report.pdf?.pending).toBeNull();
    expect(code).toBe(0);
    expect(report.verdict).toBe("PASS");
  }, 120_000);

  it("a path that is not a PDF program is a usage error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "datum-out-cli-"));
    const file = join(dir, "not-a-program.js");
    writeFileSync(file, "console.log(1)");
    const err: string[] = [];
    const code = await runCli(["--pdf-program", file], { stdout: () => undefined, stderr: (t) => err.push(t) });
    expect(code).toBe(2);
    expect(err.join("")).toMatch(/not a PDF program/);
  });

  it("explain shows the predicate and the pdf runner", async () => {
    const out: string[] = [];
    expect(await runCli(["explain", "OUT-05"], { stdout: (t) => out.push(t), stderr: () => undefined })).toBe(0);
    expect(out.join("")).toMatch(/runs on: pdf/);
    expect(out.join("")).toMatch(/declared as size 0/);
  });
});

