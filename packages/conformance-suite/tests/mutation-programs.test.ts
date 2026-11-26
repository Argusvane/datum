import { describe, expect, it } from "vitest";

import { programFromText } from "../src/runners/program/load-program.js";
import type { Report } from "../src/report/model.js";
import { runSuite } from "../src/run.js";
import { MUTANTS } from "./helpers/programs.js";

/**
 * A mutation test per severity-1 vector: a program with the guarded behaviour removed
 * must FAIL the vector, while the controls beside it still pass. Each mutant is the real program
 * with one kernel function replaced after the fact.
 */
const statusOf = (report: Report, id: string): string => report.results.find((result) => result.id === id)?.status ?? "missing";

async function run(text: string, only: string[]): Promise<Report> {
  return runSuite({ program: programFromText(text, "mutant.js", "file"), only, gate: "full", heavy: true });
}

describe("a program that never checks choice answers against their options", () => {
  it("fails every option vector that expects a refusal, and still passes the controls", async () => {
    const report = await run(MUTANTS.noOptionCheck(), ["CTL-01", "CTL-02", "OPT-01", "OPT-02", "OPT-03", "OPT-04", "OPT-05", "OPT-06", "OPT-08", "OPT-10"]);
    for (const id of ["OPT-01", "OPT-02", "OPT-03", "OPT-04", "OPT-05", "OPT-06", "OPT-08", "OPT-10"]) {
      expect(statusOf(report, id), id).toBe("FAIL");
    }
    expect(statusOf(report, "CTL-01")).toBe("PASS");
    expect(statusOf(report, "CTL-02")).toBe("PASS");
    expect(report.verdict).toBe("FAIL");
  });
});

describe("a program that keeps rows and container objects whole", () => {
  it("fails OPT-06, OPT-07 and OPT-08, and passes the flat spellings of the same attack", async () => {
    const report = await run(MUTANTS.storedWhole(), ["OPT-01", "OPT-06", "OPT-07", "OPT-08"]);
    for (const id of ["OPT-06", "OPT-07", "OPT-08"]) {
      expect(statusOf(report, id), id).toBe("FAIL");
    }
    // The flat key is still checked, so the spelling-only vector holds.
    expect(statusOf(report, "OPT-01")).toBe("PASS");
    const opt06 = report.results.find((result) => result.id === "OPT-06");
    expect(opt06?.variants?.find((variant) => variant.id === "flat-spelling")?.status).toBe("PASS");
    expect(opt06?.variants?.find((variant) => variant.id === "valid-nested-is-accepted-and-stored-flat")?.status).toBe("FAIL");
  });
});

describe("a program where any truthy answersFree frees a source", () => {
  it("fails OPT-10 on the words and numbers that must fail closed", async () => {
    const report = await run(MUTANTS.truthyAnswersFree(), ["OPT-10", "OPT-04"]);
    expect(statusOf(report, "OPT-10")).toBe("FAIL");
    const variants = report.results.find((result) => result.id === "OPT-10")?.variants ?? [];
    expect(variants.filter((variant) => variant.status === "FAIL").map((variant) => variant.id)).toEqual(["flag-is-text", "flag-is-one"]);
    expect(statusOf(report, "OPT-04")).toBe("PASS");
  });
});

describe("programs missing the other guards the packs pin", () => {
  it("a program without the component depth cap fails RES-07", async () => {
    const report = await run(MUTANTS.noDepthCap(), ["RES-07", "CTL-01"]);
    expect(statusOf(report, "RES-07")).toBe("FAIL");
    expect(statusOf(report, "CTL-01")).toBe("PASS");
  });

  it("a program that serves server-secret rules fails SEC-02", async () => {
    const report = await run(MUTANTS.secretsServed(), ["SEC-02", "CTL-01"]);
    expect(statusOf(report, "SEC-02")).toBe("FAIL");
    expect(statusOf(report, "CTL-01")).toBe("PASS");
  });

  it("a program that answers plain JSON instead of the canonical text fails CAN-01", async () => {
    const report = await run(MUTANTS.plainJson(), ["CAN-01", "CAN-02", "CAN-05"]);
    expect(statusOf(report, "CAN-01")).toBe("FAIL");
  });
});

// OUT-02: a PDF program whose documents carry a script action. The other OUT mutants are in pdf-runner.test.ts.
describe("a PDF program whose output opens with a script (OUT-02)", () => {
  it("fails OUT-02 while the untouched program passes it", async () => {
    const { runPdfVectors } = await import("../src/runners/pdf/index.js");
    const { VECTORS } = await import("../src/vectors/index.js");
    const { activeContentMutant, currentKernel, pdfProgramText, PDF_PROGRAM_PATH } = await import("./helpers/pdf-programs.js");
    const text = pdfProgramText();
    if (text === undefined) {
      return;
    }
    const program = { text, path: PDF_PROGRAM_PATH };
    const control = await runPdfVectors({ program, provider: currentKernel(), enforceAbi: false, catalogue: VECTORS, only: ["OUT-02"] });
    expect(control.results[0]?.status).toBe("PASS");
    const mutant = await activeContentMutant(text);
    try {
      const run = await runPdfVectors({ program, provider: mutant.provider, enforceAbi: false, catalogue: VECTORS, only: ["OUT-02"] });
      expect(run.results[0]?.status).toBe("FAIL");
      expect(run.results[0]?.notes).toMatch(/OpenAction|JavaScript|JS/);
    } finally {
      mutant.dispose();
    }
  }, 120_000);
});

// JRN-01 and JRN-07: the exit page. The program mutant turns the exit check off; the receiver mutant judges a journey-less request as the whole form.
describe("a program that does not end a path at an exit page (JRN-01)", () => {
  it("fails JRN-01 while the untouched program passes it", async () => {
    const { builtProgramText } = await import("./helpers/programs.js");
    const text = builtProgramText();
    const pattern = 'fold.trace.end === "exit"';
    if (!text.includes(pattern)) {
      throw new Error("mutant program: the program no longer contains the exit check; update the pattern");
    }
    const real = await run(text, ["JRN-01"]);
    expect(statusOf(real, "JRN-01")).toBe("PASS");
    const mutant = await run(text.replace(pattern, "false"), ["JRN-01"]);
    expect(statusOf(mutant, "JRN-01")).toBe("FAIL");
  }, 120_000);
});

describe("a receiver that judges a journey-less request as the whole form (JRN-07)", () => {
  it("fails JRN-07 while a receiver with the default-journey rule passes it", async () => {
    const { runEndpoint } = await import("../src/runners/endpoint/endpoint-runner.js");
    const { startReferenceServer } = await import("./helpers/reference-submissions-server.js");
    const { configFor } = await import("./helpers/endpoint.js");
    const { VECTORS } = await import("../src/vectors/index.js");
    const jrn = VECTORS.filter((vector) => vector.id === "JRN-07");
    const statuses: Record<string, string | undefined> = {};
    for (const rule of ["default", "whole"] as const) {
      const server = await startReferenceServer({
        // The mutant accepts what it is sent when the document names no journey (it judged the form as one flat page set).
        fault: (request) => {
          const submission = (request.json as { document?: { submission?: { journey?: unknown } } } | undefined)?.document?.submission;
          if (rule === "whole" && request.method === "POST" && submission !== undefined && submission.journey === undefined) {
            return request.path.endsWith("/validate")
              ? { status: 200, contentType: "application/json", body: JSON.stringify({ accepted: true, errors: [] }) }
              : { status: 201, contentType: "application/json", body: JSON.stringify({ id: "1", status: "accepted", digest: "d" }) };
          }
          return undefined;
        }
      });
      try {
        const result = await runEndpoint(configFor(server.url, { vectors: jrn, allowWrites: true, fixtureAcknowledged: true }));
        statuses[rule] = result.results.find((entry) => entry.id === "JRN-07")?.status;
      } finally {
        await server.close();
      }
    }
    expect(statuses).toEqual({ default: "PASS", whole: "FAIL" });
  }, 60_000);
});

// OPT-11: a program where any component sharing a storage key stands in for a sourced choice must fail.
describe("a program where any component sharing a storage key switches a sourced select's check off (OPT-11)", () => {
  it("fails OPT-11 on the number, date, checkbox and file sharers, keeps the plain-text row and the controls", async () => {
    const report = await run(MUTANTS.anySharerStandsAside(), ["OPT-11", "OPT-04", "CTL-01"]);
    expect(statusOf(report, "OPT-11")).toBe("FAIL");
    const variants = report.results.find((result) => result.id === "OPT-11")?.variants ?? [];
    expect(variants.filter((variant) => variant.status === "FAIL").map((variant) => variant.id)).toEqual(["date-sharer-keeps-the-check", "checkbox-sharer-keeps-the-check", "file-sharer-keeps-the-check"]);
    expect(variants.find((variant) => variant.id === "a-plain-text-sharer-still-stands-aside")?.status).toBe("PASS");
    expect(variants.find((variant) => variant.id === "select-alone-is-held")?.status).toBe("PASS");
    expect(statusOf(report, "OPT-04")).toBe("PASS");
    expect(statusOf(report, "CTL-01")).toBe("PASS");
  }, 120_000);
});

// RES-02: without the 10,000-character cap each of 30 rules runs a native pass over a million characters.
describe("a program without the text-function cap (RES-02)", () => {
  it("fails RES-02 on its time bound while the real program passes it, and the controls pass", async () => {
    const { builtProgramText } = await import("./helpers/programs.js");
    const real = await run(builtProgramText(), ["RES-02"]);
    expect(statusOf(real, "RES-02")).toBe("PASS");
    const report = await run(MUTANTS.noTextCap(), ["RES-02", "CTL-01"]);
    expect(statusOf(report, "RES-02")).toBe("FAIL");
    expect(report.results.find((result) => result.id === "RES-02")?.notes).toMatch(/took \d+ ms|over/);
    expect(statusOf(report, "CTL-01")).toBe("PASS");
  }, 120_000);
});

// ISO-04 and RES-19 are properties of the host the program runs on, so their negative controls change the host.
describe("a host that does not freeze the kernel and the intrinsics (ISO-04)", () => {
  it("fails ISO-04 where a plugin's patch of Array.prototype.push reaches the next run, and passes with the freeze", async () => {
    const { builtProgramText } = await import("./helpers/programs.js");
    const text = builtProgramText();
    const frozen = await run(text, ["ISO-04"]);
    expect(statusOf(frozen, "ISO-04")).toBe("PASS");
    const open = await runSuite({ program: programFromText(text, "unfrozen.js", "file"), only: ["ISO-04", "CTL-01"], gate: "full", freezeIntrinsics: false });
    expect(statusOf(open, "ISO-04")).toBe("FAIL");
    expect(statusOf(open, "CTL-01")).toBe("PASS");
  }, 120_000);
});

describe("a host with no worker clock (RES-19)", () => {
  it("fails RES-19 on the synchronous host, where the native loop runs to its end, and passes it on the worker host", async () => {
    const { builtProgramText } = await import("./helpers/programs.js");
    const { VECTORS } = await import("../src/vectors/index.js");
    const text = builtProgramText();
    const vector = VECTORS.find((entry) => entry.id === "RES-19");
    expect(vector).toBeDefined();
    const worker = await runSuite({ program: programFromText(text, "p.js", "file"), only: ["RES-19"], gate: "full" });
    expect(statusOf(worker, "RES-19")).toBe("PASS");
    const sync = { ...(vector as NonNullable<typeof vector>), fixture: { ...(vector as NonNullable<typeof vector>).fixture, host: "sync" as const }, variants: [] };
    const report = await runSuite({ program: programFromText(text, "p.js", "file"), only: ["RES-19"], gate: "full", vectors: [sync] });
    expect(statusOf(report, "RES-19")).toBe("FAIL");
  }, 180_000);
});

// JRN-07 and REC-12: a service that judges a journey-less request as the whole form; a receiver that stores a second record.
describe("the submissions service with its journey rule removed (JRN-07)", () => {
  it("FAILs JRN-07 on every omission row for a validator that judges the whole form, and PASSes it for the real one", async () => {
    const { runEndpoint } = await import("../src/runners/endpoint/endpoint-runner.js");
    const { startReferenceServer } = await import("./helpers/reference-submissions-server.js");
    const { createKernelValidator } = await import("@argusvane/datum-submissions");
    const { configFor } = await import("./helpers/endpoint.js");
    const { VECTORS } = await import("../src/vectors/index.js");
    const jrn = VECTORS.filter((vector) => vector.id === "JRN-07");
    const kernel = createKernelValidator();
    const wholeForm = { id: "kernel", validate: (context: Parameters<typeof kernel.validate>[0]) => kernel.validate({ ...context, journey: undefined } as never) };
    const statuses: Record<string, string | undefined> = {};
    for (const [label, validator] of [["real", undefined], ["whole", wholeForm]] as const) {
      const server = await startReferenceServer(validator !== undefined ? { validator } : {});
      try {
        const result = await runEndpoint(configFor(server.url, { vectors: jrn, allowWrites: true, fixtureAcknowledged: true }));
        statuses[label] = result.results.find((entry) => entry.id === "JRN-07")?.status;
      } finally {
        await server.close();
      }
    }
    expect(statuses).toEqual({ real: "PASS", whole: "FAIL" });
  }, 120_000);
});

describe("a receiver that stores a second record for a replayed delivery (REC-12)", () => {
  it("FAILs REC-12 when the second delivery gets another id, and PASSes the real service", async () => {
    const { runEndpoint } = await import("../src/runners/endpoint/endpoint-runner.js");
    const { startReferenceServer } = await import("./helpers/reference-submissions-server.js");
    const { configFor } = await import("./helpers/endpoint.js");
    const { VECTORS } = await import("../src/vectors/index.js");
    const rec = VECTORS.filter((vector) => vector.id === "REC-12");
    const statuses: Record<string, string | undefined> = {};
    let minted = 0;
    for (const label of ["real", "duplicating"] as const) {
      const server = await startReferenceServer(
        label === "duplicating"
          ? { fault: (request) => (request.method === "POST" && request.path === "/api/submissions" ? { status: 200, contentType: "application/json", body: JSON.stringify({ id: `r${(minted += 1)}`, status: "accepted", digest: "d", receipt: null }) } : undefined) }
          : {}
      );
      try {
        const result = await runEndpoint(configFor(server.url, { vectors: rec, allowWrites: true, fixtureAcknowledged: true }));
        statuses[label] = result.results.find((entry) => entry.id === "REC-12")?.status;
      } finally {
        await server.close();
      }
    }
    expect(statuses).toEqual({ real: "PASS", duplicating: "FAIL" });
  }, 120_000);
});

describe("a receiver that refuses every retry of a known key as a conflict (REC-12)", () => {
  it("FAILs REC-12 when a retry with the same document is answered 409, and PASSes the real service", async () => {
    const { runEndpoint } = await import("../src/runners/endpoint/endpoint-runner.js");
    const { startReferenceServer } = await import("./helpers/reference-submissions-server.js");
    const { configFor } = await import("./helpers/endpoint.js");
    const { VECTORS } = await import("../src/vectors/index.js");
    const rec = VECTORS.filter((vector) => vector.id === "REC-12");
    const statuses: Record<string, string | undefined> = {};
    const observed: Record<string, unknown> = {};
    for (const label of ["real", "always-conflict"] as const) {
      const seen = new Set<string>();
      const server = await startReferenceServer(
        label === "always-conflict"
          ? {
              fault: (request) => {
                const key = (request.json as { submissionKey?: unknown } | undefined)?.submissionKey;
                if (request.method !== "POST" || request.path !== "/api/submissions" || typeof key !== "string") {
                  return undefined;
                }
                if (!seen.has(key)) {
                  seen.add(key);
                  return undefined;
                }
                return { status: 409, contentType: "application/json", body: JSON.stringify({ errors: [{ field: null, code: "submission.keyConflict" }] }) };
              }
            }
          : {}
      );
      try {
        const result = await runEndpoint(configFor(server.url, { vectors: rec, allowWrites: true, fixtureAcknowledged: true }));
        const entry = result.results.find((candidate) => candidate.id === "REC-12");
        statuses[label] = entry?.status;
        observed[label] = entry?.variants?.find((variant) => variant.id === "same-attempt-twice")?.observed;
      } finally {
        await server.close();
      }
    }
    expect(statuses).toEqual({ real: "PASS", "always-conflict": "FAIL" });
    expect(observed["always-conflict"]).toMatchObject({ kind: "answer", json: { outcome: "conflict", handled: false } });
  }, 120_000);
});

describe("a program whose check drops the data-key structure problems (DEF-04)", () => {
  it("fails DEF-04 while the untouched program passes it", async () => {
    const { builtProgramText, wrapEntryPoint } = await import("./helpers/programs.js");
    const dropDataKeys = `function (original) {
  return function (text) {
    var out = original(text);
    var answer;
    try { answer = JSON.parse(out); } catch (error) { return out; }
    if (answer && answer.ok === true && answer.op === "check" && answer.structure) {
      answer.structure = answer.structure.filter(function (entry) { return String(entry.code).indexOf("component.dataPath.") !== 0; });
      if (answer.structure.length === 0 && answer.problems && answer.problems.length === 0) { answer.verdict = "ok"; }
    }
    return JSON.stringify(answer);
  };
}`;
    const real = await run(builtProgramText(), ["DEF-04"]);
    expect(statusOf(real, "DEF-04")).toBe("PASS");
    const mutant = await run(wrapEntryPoint(builtProgramText(), "__datum_inspect", dropDataKeys), ["DEF-04"]);
    expect(statusOf(mutant, "DEF-04")).toBe("FAIL");
  }, 120_000);
});
