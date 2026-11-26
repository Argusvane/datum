import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { runCli } from "../src/cli.js";
import { BUNDLED_GOLDEN } from "../src/fixtures/golden.js";
import type { Report } from "../src/report/model.js";
import { programFromText } from "../src/runners/program/load-program.js";
import { compareBytes } from "../src/runners/parity/compare.js";
import { digestParity, submissionDigestOf } from "../src/runners/parity/digest.js";
import { DIVERGENCES, settleAgainstLedger, type Divergence } from "../src/runners/parity/divergences.js";
import { FUNCTION_CASES } from "../src/runners/parity/functions.js";
import { corpusRows, runParityVectors } from "../src/runners/parity/parity-runner.js";
import { pluginFunctionParity } from "../src/runners/parity/plugin-functions.js";
import { ProgramSession } from "../src/runners/program/session.js";
import { runSuite } from "../src/run.js";
import { VECTORS } from "../src/vectors/index.js";
import { builtProgram, builtProgramText } from "./helpers/programs.js";
import { REPO_ROOT } from "./helpers/paths.js";

const golden = BUNDLED_GOLDEN;

/** The real program with one thing changed; throws when the text to change is no longer in the program. */
function patched(pattern: RegExp | string, replacement: string, what: string): string {
  const text = builtProgramText();
  const out = text.replace(pattern, replacement);
  if (out === text) {
    throw new Error(`patched program "${what}": the built program does not contain the text to change`);
  }
  return out;
}

/** A blank required field is reported under another code: the outcome bytes differ for every run that has it. */
const renamedRequiredProgram = (): string => patched(/code: "required",(\s+componentId,\s+path,\s+stage: "field-constraints")/, 'code: "requiredX",$1', "required renamed");
/** The digest of every document differs by a leading character. */
const wrongDigestProgram = (): string => patched(/digest: kernelSha256Hex\(kernelUtf8Binary\(canonical\)\)/, 'digest: "0" + kernelSha256Hex(kernelUtf8Binary(canonical))', "digest prefixed");

const run = (program: string, extra: Partial<Parameters<typeof runParityVectors>[0]> = {}) =>
  runParityVectors({ program: programFromText(program, "p.js", "file"), golden, vectors: VECTORS, gate: "full", ...extra });

describe("the byte comparator", () => {
  it("says equal for equal text, and where and how two texts part otherwise", () => {
    expect(compareBytes("abc", "abc")).toEqual({ equal: true, lengths: [3, 3] });
    const differing = compareBytes('{"a":1,"b":2}', '{"a":1,"b":3}');
    expect(differing.equal).toBe(false);
    expect(differing.firstDifference).toBe(11);
    expect(differing.excerpts).toEqual(['{"a":1,"b":2}', '{"a":1,"b":3}']);
    expect(compareBytes("ab", "abc").firstDifference).toBe(2);
  });
});

describe("the divergence ledger", () => {
  const entry = (extra: Partial<Divergence> = {}): Divergence => ({ vector: "PAR-03/CTL-01", reason: "r", between: "kernel-program", ...extra });

  it("fails what no entry declares and excuses what one does", () => {
    const outcome = settleAgainstLedger("PAR-03", "kernel-program", ["CTL-01", "CTL-02"], ["CTL-01", "CTL-02"], [entry()]);
    expect(outcome.undeclared).toEqual(["CTL-02"]);
    expect(outcome.declared.map((row) => row.key)).toEqual(["CTL-01"]);
    expect(outcome.stale).toEqual([]);
  });

  it("calls an entry stale when the run compared its vector and found it agreeing, and ignores one it never compared", () => {
    expect(settleAgainstLedger("PAR-03", "kernel-program", ["CTL-01"], [], [entry()]).stale.map((row) => row.why)).toEqual(["no longer diverges"]);
    expect(settleAgainstLedger("PAR-03", "kernel-program", ["CTL-02"], [], [entry()]).stale).toEqual([]);
  });

  it("lets an expired entry excuse nothing", () => {
    const outcome = settleAgainstLedger("PAR-03", "kernel-program", ["CTL-01"], ["CTL-01"], [entry({ expires: "2020-01-01" })], new Date("2026-10-14"));
    expect(outcome.undeclared).toEqual(["CTL-01"]);
    expect(outcome.stale.map((row) => row.why)).toEqual(["expired 2020-01-01"]);
  });

  it("holds the two known entries, neither exercised by the kernel-versus-program comparison", () => {
    expect(DIVERGENCES.map((row) => row.vector)).toEqual(["PAR-06/risky-pattern-composed", "PAR-06/CAN-07"]);
    expect(DIVERGENCES.some((row) => row.between === "kernel-program")).toBe(false);
  });
});

describe("parity over the built program", () => {
  it("passes PAR-01 to PAR-05, leaves PAR-06 pending on the endpoint runner, and reports the corpus", async () => {
    const output = await run(builtProgramText());
    const statuses = Object.fromEntries(output.results.map((result) => [result.id, result.status]));
    expect(statuses).toEqual({ "PAR-01": "PASS", "PAR-02": "PASS", "PAR-03": "PASS", "PAR-04": "PASS", "PAR-05": "PASS", "PAR-06": "XFAIL" });
    expect(output.report.adapters).toEqual(["kernel", "program"]);
    expect(output.report.corpus.core).toBe(7);
    expect(output.report.corpus.adversarial).toBe(36);
    expect(output.report.corpus.suite).toBeGreaterThanOrEqual(6);
    expect(output.report.divergences).toEqual([]);
  });

  it("registers PAR-06 as pending: SKIP under the release gate, XFAIL under full", async () => {
    const release = await run(builtProgramText(), { gate: "release", only: ["PAR-06"] });
    expect(release.results.map((result) => result.status)).toEqual(["SKIP"]);
    expect(release.results[0]?.blockedBy).toBe("the endpoint parity runner");
    const full = await run(builtProgramText(), { only: ["PAR-06"] });
    expect(full.results.map((result) => result.status)).toEqual(["XFAIL"]);
  });

  it("takes every vector that opted into parity as a PAR-03 row, and says what it left out", () => {
    const { rows, skipped } = corpusRows(VECTORS, false);
    expect(rows.map((row) => row.key)).toEqual(expect.arrayContaining(["CTL-01", "CTL-02", "CTL-03", "CTL-04", "CTL-05", "CTL-06"]));
    expect(skipped.some((line) => line.startsWith("CTL-06#"))).toBe(true);
    expect(rows.some((row) => row.key.startsWith("PAR-"))).toBe(false);
  });

  it("pins the curated function calls: around 30, each with an expected value", () => {
    expect(FUNCTION_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(FUNCTION_CASES.map((row) => row.id)).size).toBe(FUNCTION_CASES.length);
  });
});

describe("a program with an injected divergence", () => {
  it("fails PAR-03 (and only what the change reaches) when the outcome bytes differ", async () => {
    const output = await run(renamedRequiredProgram());
    const status = (id: string) => output.results.find((result) => result.id === id)?.status;
    expect(status("PAR-03")).toBe("FAIL");
    const note = output.results.find((result) => result.id === "PAR-03")?.notes ?? "";
    expect(note).toMatch(/undeclared: CTL-02/);
    expect(note).toMatch(/first difference at \d+/);
    expect(note).toContain("requiredX");
    expect(status("PAR-05")).toBe("PASS");
  });

  it("fails PAR-05 when the program's digest is not the others'", async () => {
    const output = await run(wrongDigestProgram());
    expect(output.results.find((result) => result.id === "PAR-05")?.status).toBe("FAIL");
    expect(output.results.find((result) => result.id === "PAR-05")?.notes).toMatch(/program disagree with the golden file/);
    // The digest rides in the outcome bytes of the vectors that send a document (CAN-01, CAN-02), so PAR-03 sees the lie too, and only there.
    const par03 = output.results.find((result) => result.id === "PAR-03");
    expect(par03?.status).toBe("FAIL");
    const undeclared = /undeclared: ([^|]*)/.exec(par03?.notes ?? "")?.[1] ?? "";
    expect(undeclared.split(", ").every((key) => key.startsWith("CAN-0"))).toBe(true);
  });

  it("fails the whole run through runSuite, with the parity section in the report", async () => {
    const report: Report = await runSuite({ program: programFromText(renamedRequiredProgram(), "p.js", "file"), modes: ["parity"], gate: "release" });
    expect(report.verdict).toBe("FAIL");
    expect(report.run.modes).toEqual(["parity"]);
    expect(report.parity?.corpus.core).toBe(7);
    expect(report.results.every((result) => result.runner === "parity")).toBe(true);
    expect(report.reasons).toContain("PAR-03 FAILED");
  });

  it("passes when every difference is declared in the ledger, and says so", async () => {
    const broken = renamedRequiredProgram();
    const first = await run(broken, { only: ["PAR-03"] });
    const keys = /undeclared: ([^|]+)/.exec(first.results[0]?.notes ?? "")?.[1]?.split(", ").map((key) => key.trim()) ?? [];
    expect(keys.length).toBeGreaterThan(0);
    const ledger: Divergence[] = keys.map((key) => ({ vector: `PAR-03/${key}`, reason: "renamed on purpose", between: "kernel-program" }));
    const second = await run(broken, { only: ["PAR-03"], ledger });
    expect(second.results[0]?.status).toBe("PASS");
    expect(second.results[0]?.notes).toMatch(/declared: .*renamed on purpose/);
    expect(second.report.divergences.map((row) => row.vector)).toEqual(ledger.map((row) => row.vector));
  });
});

describe("a stale ledger entry", () => {
  it("warns (not fails) when the declared divergence is gone", async () => {
    const ledger: Divergence[] = [{ vector: "PAR-03/CTL-01", reason: "was a drift in 2.11", between: "kernel-program" }];
    const output = await run(builtProgramText(), { only: ["PAR-03"], ledger });
    expect(output.results[0]?.status).toBe("WARN");
    expect(output.results[0]?.notes).toMatch(/stale ledger: PAR-03\/CTL-01 no longer diverges/);
    expect(output.report.divergences).toEqual([{ vector: "PAR-03/CTL-01", reason: "was a drift in 2.11", stale: true }]);
  });

  it("does not fail the run unless --fail-on warn", async () => {
    const ledger: Divergence[] = [{ vector: "PAR-03/CTL-01", reason: "r", between: "kernel-program" }];
    const lenient = await runSuite({ program: builtProgram(), modes: ["parity"], only: ["PAR-03"], ledger });
    expect(lenient.results.map((result) => result.status)).toEqual(["WARN"]);
    expect(lenient.verdict).toBe("PASS");
    const strict = await runSuite({ program: builtProgram(), modes: ["parity"], only: ["PAR-03"], ledger, failOn: "warn" });
    expect(strict.verdict).toBe("FAIL");
    expect(strict.parity?.divergences).toEqual([{ vector: "PAR-03/CTL-01", reason: "r", stale: true }]);
  });
});

describe("digest parity over the CAN-02 corpus", () => {
  it("agrees on every golden document: golden, reference, kernel, submissions and program", async () => {
    const session = await ProgramSession.open({ program: builtProgramText() });
    try {
      const rows = await digestParity(golden, session);
      expect(rows.map((row) => row.name)).toEqual(golden.documents.map((document) => document.name));
      expect(rows.length).toBeGreaterThanOrEqual(20);
      for (const row of rows) {
        expect(row.disagree, row.name).toEqual([]);
        expect(Object.keys(row.digest).sort(), row.name).toEqual(["golden", "kernel", "program", "reference", "submissions"]);
        expect(new Set(Object.values(row.digest)).size, row.name).toBe(1);
        expect(new Set(Object.values(row.canonical)).size, row.name).toBe(1);
      }
    } finally {
      session.dispose();
    }
  });

  it("uses the same digest as the submissions package's submissionDigest", async () => {
    const path = join(REPO_ROOT, "packages", "submissions", "src", "digest.ts");
    const submissions = (await import(/* @vite-ignore */ path)) as { submissionDigest(document: unknown): string };
    for (const document of golden.documents) {
      const parsed = JSON.parse(document.input) as unknown;
      expect(submissionDigestOf(parsed).digest, document.name).toBe(submissions.submissionDigest(parsed));
    }
  });
});

describe("plugin function parity through the program", () => {
  const plugin = {
    id: "calc",
    version: "1.0.0",
    validators: [],
    functions: { triple: (args: unknown[]) => (typeof args[0] === "number" ? args[0] * 3 : undefined) }
  };

  it("reports no mismatch when the in-process function and the sandbox agree with the vectors", async () => {
    const report = await pluginFunctionParity({
      programText: builtProgramText(),
      plugin,
      contribution: { name: "triple", evaluate: plugin.functions.triple },
      vectors: [
        { args: [2], expected: 6 },
        { args: [0.5], expected: 1.5 }
      ]
    });
    expect(report).toEqual({ checked: 2, mismatches: [] });
  });

  it("lists a mismatch when the contribution's in-process answer differs from the sandbox's", async () => {
    const report = await pluginFunctionParity({
      programText: builtProgramText(),
      plugin,
      contribution: { name: "triple", evaluate: (args) => (args[0] as number) * 4 },
      vectors: [{ args: [2], expected: 6 }]
    });
    expect(report.mismatches).toHaveLength(1);
    expect(report.mismatches[0]).toMatchObject({ inProcess: 8, sandbox: 6 });
  });
});

describe("the command line", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-security-suite-parity-"));
  const out = { stdout: (_text: string) => undefined, stderr: (_text: string) => undefined };

  it("runs parity alone with --parity and program plus parity with --all", async () => {
    const path = join(work, "program.js");
    writeFileSync(path, builtProgramText());
    for (const [flag, modes] of [["--parity", ["parity"]], ["--all", ["program", "parity"]]] as const) {
      let text = "";
      const code = await runCli(["--program", path, flag, "--only", flag === "--all" ? "CTL-01,PAR-02" : "PAR-02", "--format", "json", "--out", "-"], { ...out, stdout: (chunk) => void (text += chunk) });
      expect(code, flag).toBe(0);
      const report = JSON.parse(text) as Report;
      expect(report.run.modes, flag).toEqual(modes);
      expect(report.results.map((result) => result.id), flag).toEqual(flag === "--all" ? ["CTL-01", "PAR-02"] : ["PAR-02"]);
    }
  });
});
