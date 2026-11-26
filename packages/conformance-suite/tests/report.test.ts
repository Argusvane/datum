import { Ajv } from "ajv";
import { describe, expect, it } from "vitest";

import { REPORT_SCHEMA } from "../src/report/schema.js";
import { renderJson, redactArgv } from "../src/report/json.js";
import { cell, renderMarkdown } from "../src/report/markdown.js";
import { decideVerdict, summarize, type Report, type ResultStatus, type VectorResult } from "../src/report/model.js";
import { runSuite } from "../src/run.js";
import { programFromText } from "../src/runners/program/load-program.js";
import { VECTORS } from "../src/vectors/index.js";
import type { Vector } from "../src/vectors/schema.js";
import { builtProgram, yesManProgramText } from "./helpers/programs.js";

const validate = new Ajv({ strict: false, allErrors: true, validateFormats: false }).compile(REPORT_SCHEMA);

function expectValid(report: unknown): void {
  const ok = validate(report);
  expect(ok ? [] : validate.errors?.map((error) => `${error.instancePath} ${error.message}`)).toEqual([]);
}

const result = (id: string, status: ResultStatus, gate: VectorResult["gate"] = "enforced"): VectorResult => ({
  id,
  title: id,
  class: "control",
  severity: "S3",
  attacker: "filler",
  runner: "program",
  status,
  gate,
  blockedBy: gate === "pending" ? "a kernel fix" : null,
  expected: "accepted",
  observed: null,
  durationMs: 1,
  limitMs: null
});

describe("report schema", () => {
  it("accepts the report of a clean run, a failing run and a run of a program that will not start", async () => {
    expectValid(await runSuite({ program: builtProgram(), gate: "full", argv: ["--program", "x.js"] }));
    expectValid(await runSuite({ program: programFromText(yesManProgramText(), "yes-man.js", "file"), only: ["CTL", "ISO-01"] }));
    expectValid(await runSuite({ program: programFromText("syntax (", "broken.js", "file"), only: ["CTL-01", "ABI-01"] }));
    // Three whole-suite runs, one against the real program; a shared CI runner needs more than the 60 s default.
  }, 180_000);

  it("survives a JSON round trip unchanged", async () => {
    const report = await runSuite({ program: builtProgram(), only: ["CTL-02"] });
    expect(JSON.parse(renderJson(report))).toEqual(JSON.parse(JSON.stringify(report)));
    expect(renderJson(report).endsWith("\n")).toBe(true);
  });

  it("rejects a report with an unknown status, a missing verdict or a malformed id", async () => {
    const report = JSON.parse(renderJson(await runSuite({ program: builtProgram(), only: ["CTL-02"] }))) as Report;
    expect(validate({ ...report, verdict: "MAYBE" })).toBe(false);
    const { verdict: _verdict, ...withoutVerdict } = report;
    expect(validate(withoutVerdict)).toBe(false);
    expect(validate({ ...report, results: [{ ...report.results[0], status: "GREEN" }] })).toBe(false);
    expect(validate({ ...report, results: [{ ...report.results[0], id: "ctl2" }] })).toBe(false);
    expect(validate({ ...report, schemaVersion: 2 })).toBe(false);
  });
});

describe("verdict", () => {
  it("is FAIL for an enforced FAIL, and an advisory or pending miss does not fail the run", () => {
    expect(decideVerdict([result("CTL-01", "PASS"), result("CTL-02", "FAIL")], { failOn: "fail" }).verdict).toBe("FAIL");
    expect(decideVerdict([result("CTL-01", "PASS"), result("CTL-02", "WARN", "advisory"), result("ISO-04", "XFAIL", "pending")], { failOn: "fail" }).verdict).toBe("PASS");
  });

  it("is INCONCLUSIVE for an enforced ERROR or a preflight reason, and FAIL outranks it", () => {
    expect(decideVerdict([result("CTL-01", "ERROR")], { failOn: "fail" }).verdict).toBe("INCONCLUSIVE");
    expect(decideVerdict([result("CTL-01", "PASS")], { failOn: "fail", inconclusive: ["preflight failed"] })).toEqual({ verdict: "INCONCLUSIVE", reasons: ["preflight failed"] });
    expect(decideVerdict([result("CTL-01", "ERROR"), result("CTL-02", "FAIL")], { failOn: "fail" }).verdict).toBe("FAIL");
    expect(decideVerdict([result("CTL-01", "ERROR", "advisory")], { failOn: "fail" }).verdict).toBe("PASS");
  });

  it("makes WARN and XPASS fail only under --fail-on warn", () => {
    const results = [result("CTL-01", "WARN", "advisory"), result("CTL-02", "XPASS", "pending")];
    expect(decideVerdict(results, { failOn: "fail" }).verdict).toBe("PASS");
    const strict = decideVerdict(results, { failOn: "warn" });
    expect(strict.verdict).toBe("FAIL");
    expect(strict.reasons).toEqual(["CTL-01 WARN (--fail-on warn)", "CTL-02 XPASS (--fail-on warn)"]);
  });

  it("counts every status", () => {
    expect(summarize([result("A", "PASS"), result("B", "PASS"), result("C", "FAIL"), result("D", "XFAIL", "pending")])).toEqual({ pass: 2, fail: 1, warn: 0, skip: 0, xfail: 1, xpass: 0, error: 0 });
  });
});

describe("Markdown", () => {
  it("follows the report template: headline, program line, counts, sections, one table per class with variant sub-rows", async () => {
    // ISO-04 is enforced since the freeze; a host without it FAILs the vector, so a pending copy of it is XFAIL and shows in the pending section.
    const pendingIso = { ...(VECTORS.find((vector) => vector.id === "ISO-04") as Vector), gate: { status: "pending" as const, blockedBy: "a kernel fix" } };
    const catalogue = [...VECTORS.filter((vector) => vector.id !== "ISO-04"), pendingIso];
    const report = await runSuite({ program: builtProgram(), gate: "full", only: ["CTL-06", "ABI-03", "ISO-04"], argv: [], vectors: catalogue, freezeIntrinsics: false });
    const text = renderMarkdown(report);
    expect(text).toMatch(/^# Datum security check: PASS\n/);
    expect(text).toContain(`Suite ${report.suite.version} (vector set ${report.suite.vectorSet})`);
    expect(text).toMatch(/Program: \(built from source\) \(\d+ B, sha256 [0-9a-f]{8}\) ABI detected 4\.1\.0 \/ floor 4\.0\.0 -> OK/);
    expect(text).toContain("| Status | Count |");
    for (const heading of ["## Failures (enforced)", "## Warnings and promotions (WARN, XPASS)", "## Pending (XFAIL, blocked by open items)", "## All results by class", "### control (1)", "### abi (1)", "### isolation (1)", "## Environment"]) {
      expect(text).toContain(heading);
    }
    expect(text).toContain("| ↳ 10k-unknown-keys |");
    expect(text).toContain("- ISO-04 is blocked by a kernel fix.");
  });

  it("lists failures with what was expected and what was seen, and says why the program is stale", async () => {
    const report = await runSuite({ program: programFromText(yesManProgramText(), "yes-man.js", "file"), only: ["CTL-02"] });
    const text = renderMarkdown(report);
    expect(text).toMatch(/^# Datum security check: FAIL\n/);
    const failures = text.split("## Failures (enforced)")[1]?.split("## Warnings")[0] ?? "";
    expect(failures).toContain("| CTL-02 | S3 | filler | program | FAIL |");
    expect(failures).toContain("errors exactly [required@name]");
    expect(failures).toContain("accepted []");
  });

  it("truncates a cell at 200 characters and escapes pipes and newlines", () => {
    expect(cell("a".repeat(500)).length).toBe(200);
    expect(cell("a|b\nc")).toBe("a\\|b c");
  });
});

describe("argv redaction", () => {
  it("keeps a header's name and drops its value, in both spellings, and drops a cookie entirely", () => {
    expect(redactArgv(["--program", "p.js", "--auth-header", "Authorization: Bearer abc123", "--cookie", "sid=1"])).toEqual(["--program", "p.js", "--auth-header", "Authorization: <redacted>", "--cookie", "<redacted>"]);
    expect(redactArgv(["--auth-header=X-Token: secret"])).toEqual(["--auth-header=X-Token: <redacted>"]);
    expect(redactArgv(["--header", "oddly-no-colon"])).toEqual(["--header", "<redacted>"]);
  });

  it("never lets a secret reach a report", async () => {
    const report = await runSuite({ program: builtProgram(), only: ["CTL-02"], argv: ["--auth-header", "Authorization: Bearer TOPSECRET"] });
    expect(renderJson(report)).not.toContain("TOPSECRET");
    expect(renderMarkdown(report)).not.toContain("TOPSECRET");
  });
});
