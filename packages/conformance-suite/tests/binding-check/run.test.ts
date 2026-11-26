import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { PACKAGE_ROOT } from "../helpers/paths.js";
import { hasChromium, runCommand, TEST_PORT } from "./helpers.js";

interface CaseRow {
  id: string;
  status: string;
}
interface CheckReport {
  tool: string;
  binding: { name: string; id: string };
  summary: { total: { pass: number; fail: number; skip: number; pending: number; known: number } };
  cases: CaseRow[];
  baselineChanges?: Array<{ id: string; from: string; to: string }>;
}

const read = (path: string): CheckReport => JSON.parse(readFileSync(path, "utf8")) as CheckReport;

// Real runs in headless Chromium through Playwright. CI installs the suite's packages but no browser, so these
// are skipped there (the preflight and argument tests in cli.test.ts run everywhere).
describe.skipIf(!hasChromium())("datum-binding-check: runs in Chromium", () => {
  const work = mkdtempSync(join(tmpdir(), "datum-binding-check-run-"));
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("passes the datum binding (the default) on the mount, value and hook groups, and writes the reports", async () => {
    const out = join(work, "datum");
    const result = await runCommand(["--only", "MNT,VAL,HK", "--port", TEST_PORT, "--report", out]);
    expect(result.stderr).toBe("");
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toMatch(/datum: \d+ pass, 0 fail/);
    const report = read(join(out, "report.json"));
    expect(report.tool).toBe("datum-binding-check");
    expect(report.binding.id).toBe("datum");
    expect(report.summary.total.fail).toBe(0);
    expect(report.summary.total.pass).toBeGreaterThan(15);
    for (const file of ["junit.xml", "report.html"]) expect(existsSync(join(out, file)), file).toBe(true);
    expect(readFileSync(join(out, "junit.xml"), "utf8")).toContain('<testsuite name="datum-binding-check:datum"');
  }, 180_000);

  it("compares with a stored report: nothing changed against itself", async () => {
    const result = await runCommand(["--only", "MNT", "--port", TEST_PORT, "--baseline", join(work, "datum", "report.json")]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain("0 case(s) changed");
  }, 120_000);

  it("exits 1 for a binding that fails a case, with a screenshot and the regression against the baseline", async () => {
    const out = join(work, "broken");
    const binding = join(PACKAGE_ROOT, "tests", "binding-check", "broken-binding.mjs");
    const result = await runCommand(["--binding", binding, "--only", "VAL-01", "--continue", "--port", TEST_PORT, "--report", out, "--baseline", join(work, "datum", "report.json")]);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stdout).toContain("FAIL    VAL-01");
    expect(result.stdout).toContain("REGRESSION");
    const report = read(join(out, "report.json"));
    expect(report.cases.find((row) => row.id === "VAL-01")?.status).toBe("fail");
    expect(report.baselineChanges?.map((change) => `${change.id} ${change.from}->${change.to}`)).toContain("VAL-01 pass->fail");
    expect(existsSync(join(out, "shots", "VAL-01.png"))).toBe(true);
  }, 120_000);

  // `known` in the assets file: a case that fails because of the design system is reported as known (exit 0); one that passes is a problem (exit 1).
  it("reports a listed case that fails as known, and one that passes as a problem", async () => {
    const assets = join(work, "known-assets.json");
    writeFileSync(assets, JSON.stringify({ known: [{ case: "VAL-01", reason: "the design system draws no control", since: "2026-11-14" }] }));
    const binding = join(PACKAGE_ROOT, "tests", "binding-check", "broken-binding.mjs");
    const out = join(work, "known");
    const known = await runCommand(["--binding", binding, "--assets", assets, "--only", "VAL-01,RO-02,RO-03", "--continue", "--port", TEST_PORT, "--report", out]);
    expect(known.code, known.stdout).toBe(0);
    expect(known.stdout).toContain("KNOWN DEFECT  VAL-01: the design system draws no control (since 2026-11-14)");
    expect(known.stdout).toContain("KNOWN   VAL-01");
    expect(known.stdout).toContain("known-assets: 2 pass, 0 fail, 0 skip, 0 pending, 1 known");
    const report = read(join(out, "report.json"));
    expect(report.cases.find((row) => row.id === "VAL-01")?.status).toBe("known");
    expect(report.summary.total).toMatchObject({ fail: 0, known: 1 });

    const stale = await runCommand(["--assets", assets, "--only", "VAL-01", "--port", TEST_PORT]);
    expect(stale.code, stale.stdout).toBe(1);
    expect(stale.stdout).toContain("listed as known but passes: remove it");
    expect(stale.stdout).toContain("FAIL    VAL-01");
  }, 180_000);

  it("passes the notice and pending cases (the path-declared async check included) on the datum binding", async () => {
    const result = await runCommand(["--only", "NTC", "--port", TEST_PORT]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain("PASS    NTC-07");
    expect(result.stdout).toContain("PASS    NTC-09");
  }, 120_000);

  it("runs the builder canvas case (CNV-01) and the print theme case (PRT-01) on the datum binding", async () => {
    const out = join(work, "datum-canvas");
    const result = await runCommand(["--only", "CNV,PRT", "--port", TEST_PORT, "--report", out]);
    expect(result.code, result.stdout).toBe(0);
    expect(result.stdout).toContain("PASS    CNV-01");
    expect(result.stdout).toContain("PASS    PRT-01");
    const rows = Object.fromEntries(read(join(out, "report.json")).cases.map((row) => [row.id, row.status]));
    expect(rows).toEqual({ "CNV-01": "pass", "PRT-01": "pass" });
  }, 120_000);

  it("fails NTC-09 for a binding that answers pending drawn and draws nothing while a field's own check runs", async () => {
    const binding = join(PACKAGE_ROOT, "tests", "binding-check", "ignores-pending-binding.mjs");
    const result = await runCommand(["--binding", binding, "--only", "NTC-09", "--continue", "--port", TEST_PORT]);
    expect(result.code, result.stdout).toBe(1);
    expect(result.stdout).toContain("FAIL    NTC-09");
    expect(result.stdout).toMatch(/nothing new describes the control while its check runs/);
  }, 120_000);

  // The cases that read a field's controls, its descriptions and a journey page's buttons, on custom-element controls found
  // by role (custom-controls-binding.mjs: no native control inside, roles in ElementInternals, a combobox in its host's
  // shadow root described by element reflection, page buttons as [role=button], summary entries as custom-element links with an empty inert proxy anchor) and on Datum's native ones.
  const CONTROL_CASES = ["SUM-01", "SUM-02", "SUM-04", "VAL-05", "VAL-06", "VAL-07", "RO-02", "RO-05", "ERR-03", "ERR-04", "ERR-05", "NTC-03", "NTC-04", "NTC-08", "HK-03", "KIND-01", "JNY"];
  const JOURNEY = ["JNY-01", "JNY-02", "JNY-03", "JNY-04", "JNY-05", "JNY-06"];

  it("finds, operates and reads custom-element controls by role as it does native ones", async () => {
    const out = join(work, "custom-controls");
    const binding = join(PACKAGE_ROOT, "tests", "binding-check", "custom-controls-binding.mjs");
    const result = await runCommand(["--binding", binding, "--only", CONTROL_CASES.join(","), "--port", TEST_PORT, "--report", out]);
    expect(result.code, result.stdout).toBe(0);
    const rows = Object.fromEntries(read(join(out, "report.json")).cases.map((row) => [row.id, row.status]));
    // A select with no native <select> is not operated (VAL-05 skips); everything else passes.
    const expected = Object.fromEntries([...CONTROL_CASES.filter((id) => id !== "JNY"), ...JOURNEY].map((id) => [id, id === "VAL-05" ? "skip" : "pass"]));
    expect(rows).toEqual(expected);
  }, 240_000);

  it("passes the same control cases on the datum binding's native controls", async () => {
    const out = join(work, "native-controls");
    const result = await runCommand(["--only", CONTROL_CASES.join(","), "--port", TEST_PORT, "--report", out]);
    expect(result.code, result.stdout).toBe(0);
    const rows = Object.fromEntries(read(join(out, "report.json")).cases.map((row) => [row.id, row.status]));
    expect(rows).toEqual(Object.fromEntries([...CONTROL_CASES.filter((id) => id !== "JNY"), ...JOURNEY].map((id) => [id, "pass"])));
  }, 240_000);

  it("exits 3 when preflight finds the binding's markup broken, and runs no case", async () => {
    const binding = join(PACKAGE_ROOT, "tests", "binding-check", "broken-binding.mjs");
    const result = await runCommand(["--binding", binding, "--only", "VAL-01", "--port", TEST_PORT]);
    expect(result.code, result.stdout).toBe(3);
    expect(result.stdout).toContain("PREFLIGHT");
    expect(result.stdout).toContain("0 pass, 0 fail, 1 skip");
  }, 120_000);

  it("exits 3 with the install hint when the browser is not installed", async () => {
    const empty = mkdtempSync(join(tmpdir(), "datum-binding-check-nobrowser-"));
    try {
      const result = await runCommand(["--only", "MNT-01", "--port", TEST_PORT], { env: { PLAYWRIGHT_BROWSERS_PATH: empty } });
      expect(result.code).toBe(3);
      expect(result.stderr).toContain("could not start chromium");
      expect(result.stderr).toContain("npx playwright install chromium");
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  }, 120_000);
});
