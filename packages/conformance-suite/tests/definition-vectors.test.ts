import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { evaluate } from "../src/predicates.js";
import { programFromText } from "../src/runners/program/load-program.js";
import type { Report, VectorResult } from "../src/report/model.js";
import { runSuite } from "../src/run.js";
import { VECTORS } from "../src/vectors/index.js";
import { WASM_ABI_VERSION } from "@argusvane/datum-engine";
import { builtProgramText } from "./helpers/programs.js";
import { publicServesSecrets, throwsOnProto, unboundedProblems, withoutStructure } from "./helpers/definition-programs.js";
import { REPO_ROOT } from "./helpers/paths.js";

const DEF_IDS = VECTORS.filter((vector) => vector.class === "definition").map((vector) => vector.id);

async function run(text: string, options: { only?: string[]; gate?: "release" | "full" } = {}): Promise<Report> {
  return runSuite({ program: programFromText(text, "double.js", "file"), only: options.only ?? ["DEF"], gate: options.gate ?? "full", heavy: true });
}

const resultOf = (report: Report, id: string): VectorResult => report.results.find((entry) => entry.id === id) as VectorResult;
const variantStatuses = (result: VectorResult): Record<string, string> => Object.fromEntries((result.variants ?? []).map((variant) => [variant.id, variant.status]));

describe("a program without the structure pass", () => {
  it("FAILS every row that needs the pass, under the release gate, and still passes the rows the problems decide", async () => {
    const report = await run(withoutStructure(), { gate: "release" });
    expect(report.program?.detectedAbi).toBe(WASM_ABI_VERSION);
    expect(report.verdict).toBe("FAIL");
    for (const id of ["DEF-03", "DEF-04", "DEF-05", "DEF-07", "DEF-08", "DEF-13", "DEF-14", "DEF-16"]) {
      const entry = resultOf(report, id);
      expect(entry.gate, id).toBe("enforced");
      expect(entry.status, id).toBe("FAIL");
    }
    expect(variantStatuses(resultOf(report, "DEF-02"))).toMatchObject({ string: "PASS", "root-type-is-group": "FAIL" });
    expect(variantStatuses(resultOf(report, "DEF-09"))).toMatchObject({ "secret-rule-at-depth-31": "PASS", "object-form-with-extra-keys": "PASS", "a-secret-rule-in-a-slot-that-is-not-a-list-is-a-structure-problem": "FAIL" });
  }, 120_000);

  it("holds every DEF vector to an enforced gate", () => {
    for (const vector of VECTORS.filter((entry) => entry.class === "definition")) {
      expect(vector.gate.status, vector.id).toBe("enforced");
    }
  });
});

/**
 * The DEF catalogue against the real program built from
 * source, under the release gate (nothing pending is left).
 */
describe("the DEF catalogue on the real program", () => {
  it("passes every row under the release gate: nothing pending is left", async () => {
    const report = await run(builtProgramText(), { gate: "release" });
    expect(report.program?.detectedAbi).toBe(WASM_ABI_VERSION);
    expect(report.results.filter((entry) => entry.status !== "PASS").map((entry) => `${entry.id} ${entry.status}: ${entry.notes ?? ""}`)).toEqual([]);
  }, 120_000);
});

describe("mutation tests", () => {
  it("a program that serves the secret rules in public fails DEF-09 and nothing else of the controls", async () => {
    const report = await run(publicServesSecrets(), { only: ["DEF-09", "DEF-01", "DEF-02"] });
    expect(resultOf(report, "DEF-09").status).toBe("FAIL");
    expect(resultOf(report, "DEF-09").notes).toMatch(/ZZSECRETZZ/);
    expect(resultOf(report, "DEF-01").status).toBe("PASS");
    expect(resultOf(report, "DEF-02").status).toBe("PASS");
  }, 60_000);

  it("a program that throws on an own __proto__ key fails DEF-07 by its public-op row", async () => {
    const report = await run(throwsOnProto(), { only: ["DEF-07"] });
    expect(resultOf(report, "DEF-07").status).toBe("FAIL");
    expect(variantStatuses(resultOf(report, "DEF-07"))).toMatchObject({ "public-op-does-not-pollute": "FAIL" });
  }, 60_000);

  it("a program that returns 10,000 problems fails DEF-13", async () => {
    const report = await run(unboundedProblems(), { only: ["DEF-13"] });
    const entry = resultOf(report, "DEF-13");
    expect(entry.status).toBe("FAIL");
    expect(entry.notes).toMatch(/10000 entries|holds 10000|over 201|201/);
  }, 60_000);

  it("a program without the depth cap fails DEF-06 (depth 33 is no longer refused)", async () => {
    const { MUTANTS } = await import("./helpers/programs.js");
    const report = await run(MUTANTS.noDepthCap(), { only: ["DEF-06"] });
    expect(resultOf(report, "DEF-06").status).toBe("FAIL");
  }, 60_000);
});

describe("the DEF predicates", () => {
  const answer = (json: unknown) => ({ kind: "answer" as const, json: json as never });

  it("reads problem lists as code@where tokens, exact or by prefix", () => {
    const checked = answer({ structure: [{ code: "journey.route.backward", where: "journey:main:page:b:route:0" }, { code: "definition.problemsTruncated", where: "" }] });
    expect(evaluate({ op: "answerProblems", list: "structure", includes: ["journey.route.backward@journey:main:page:b:route:*"] }, checked).pass).toBe(true);
    expect(evaluate({ op: "answerProblems", list: "structure", includes: ["journey.route.backward@journey:main:page:c"] }, checked).pass).toBe(false);
    expect(evaluate({ op: "answerProblems", list: "structure", includes: ["journey.route.backward"] }, checked).pass).toBe(true);
    expect(evaluate({ op: "answerProblems", list: "structure", exactly: ["journey.route.backward", "definition.problemsTruncated"] }, checked).pass).toBe(true);
    expect(evaluate({ op: "answerProblems", list: "structure", exactly: ["journey.route.backward"] }, checked).pass).toBe(false);
    expect(evaluate({ op: "answerProblems", list: "structure", max: 1 }, checked).pass).toBe(false);
    expect(evaluate({ op: "answerProblems", list: "structure", last: "definition.problemsTruncated" }, checked).pass).toBe(true);
    expect(evaluate({ op: "answerProblems", list: "structure", excludes: ["component.id.duplicate"] }, checked).pass).toBe(true);
  });

  it("fails includes, exactly and last on a list the answer does not have, and passes excludes and max", () => {
    const bare = answer({ ok: true, op: "check", problems: [] });
    expect(evaluate({ op: "answerProblems", list: "structure", includes: ["x"] }, bare).pass).toBe(false);
    expect(evaluate({ op: "answerProblems", list: "structure", exactly: [] }, bare).pass).toBe(false);
    expect(evaluate({ op: "answerProblems", list: "structure", last: "x" }, bare).pass).toBe(false);
    expect(evaluate({ op: "answerProblems", list: "structure", excludes: ["x"] }, bare).pass).toBe(true);
    expect(evaluate({ op: "answerProblems", list: "structure", max: 0 }, bare).pass).toBe(true);
    expect(evaluate({ op: "answerProblems", list: "problems", exactly: [] }, bare).pass).toBe(true);
  });

  it("answerSize counts UTF-8 bytes of the whole answer", () => {
    expect(evaluate({ op: "answerSize", maxBytes: 10 }, answer({ a: "é".repeat(10) })).pass).toBe(false);
    expect(evaluate({ op: "answerSize", maxBytes: 100 }, answer({ a: 1 })).pass).toBe(true);
  });

  it("textIncludes is the inverse of textExcludes", () => {
    expect(evaluate({ op: "textIncludes", markers: ["ZZ"] }, answer({ a: "xZZy" })).pass).toBe(true);
    expect(evaluate({ op: "textIncludes", markers: ["ZZ", "QQ"] }, answer({ a: "xZZy" })).pass).toBe(false);
  });

  it("the refusal predicate can require every listed code", () => {
    const refused = { kind: "refusal" as const, refusal: "definition_refused" as const, code: "a", codes: ["a", "b@x"], http: 422, detail: "" };
    expect(evaluate({ op: "refusal", anyOf: ["definition_refused"], includesCodes: ["a", "b"] }, refused).pass).toBe(true);
    expect(evaluate({ op: "refusal", anyOf: ["definition_refused"], includesCodes: ["c"] }, refused).pass).toBe(false);
  });
});

describe("the catalogue rules for the DEF class", () => {
  it("carries DEF-01..16 with the prefix DEF and the class definition", () => {
    expect(DEF_IDS).toEqual(Array.from({ length: 16 }, (_, at) => `DEF-${String(at + 1).padStart(2, "0")}`));
  });

  it("builds every definition text as JSON (or deliberately not, for the shapes that are not a definition)", () => {
    for (const vector of VECTORS.filter((entry) => entry.class === "definition")) {
      for (const fixture of [vector.fixture, ...(vector.variants ?? []).map((variant) => variant.fixture)]) {
        const source = fixture?.definitionText;
        if (source === undefined) {
          continue;
        }
        const text = typeof source === "string" ? source : source({ id: "x" });
        expect(() => JSON.parse(text), `${vector.id}`).not.toThrow();
      }
    }
  });

  it("keeps the secret decoys and the lone-surrogate escape as text", () => {
    const source = readFileSync(join(REPO_ROOT, "packages", "conformance-suite", "src", "fixtures", "definitions.ts"), "utf8");
    expect(source).toContain("lone\\\\ud800id");
  });
});
